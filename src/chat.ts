// Chat mode. Claude Code and Codex run as their own CLIs, speaking JSON lines,
// and the conversation is drawn here instead of in a terminal. Nothing is proxied:
// the CLI uses the account folder's sign-in and writes its session files as usual,
// so a chat can be resumed in a terminal tab, and the other way round.
//
// Claude Code: one long-lived `claude -p --input-format stream-json` per chat.
// Messages go in on stdin, permission questions come out as control requests.
// Codex: one `codex exec --json` per turn, continued with `codex exec resume`.
// `exec` can't ask for approval, so the chat picks a sandbox instead.

import { create } from "zustand";
import { ipc } from "./ipc";
import { chatView, projectAccount, sessionEnv, uid, useDesk } from "./store";
import { addWorktreeProject, branchSlug, refreshLimits, rootProject, UNTRUSTED_CLAUDE_ARGS, untrustedPath } from "./actions";
import { notify } from "./notify";
import type { AgentSession, Project, Tool } from "./types";

/** A file sent with a message. Images go to the agent as images; other files as their paths. */
export interface Attachment { name: string; path: string; image: boolean }

export type ChatItem =
  | { kind: "user"; id: string; text: string; attachments?: Attachment[] }
  | { kind: "assistant"; id: string; text: string; streaming?: boolean }
  | { kind: "tool"; id: string; name: string; summary: string; output?: string; state: "running" | "done" | "error" }
  | { kind: "approval"; id: string; tool: string; summary: string; input: unknown; state: "pending" | "allowed" | "denied" | "expired" }
  | { kind: "notice"; id: string; text: string; tone?: "error" };

export const CLAUDE_MODES = [
  { id: "default", label: "Ask first", hint: "Asks before editing files or running commands" },
  { id: "acceptEdits", label: "Accept edits", hint: "Edits files without asking; asks before commands" },
  { id: "plan", label: "Plan only", hint: "Reads and plans; changes nothing" },
  { id: "bypassPermissions", label: "Full access", hint: "Never asks. Use with care" },
] as const;

export const CODEX_MODES = [
  { id: "workspace-write", label: "Workspace", hint: "Edits files in the project; no network" },
  { id: "read-only", label: "Read only", hint: "Reads files and answers; changes nothing" },
  { id: "danger-full-access", label: "Full access", hint: "No sandbox. Use with care" },
] as const;

export const CLAUDE_MODELS = [
  { id: "", label: "Default model", description: "The model set in Claude Code" },
  { id: "fable", label: "Fable", description: "Most capable" },
  { id: "opus", label: "Opus", description: "Complex, long tasks" },
  { id: "sonnet", label: "Sonnet", description: "Everyday coding" },
  { id: "haiku", label: "Haiku", description: "Fast and light" },
];

export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

export interface ModelChoice { id: string; label: string; description?: string; efforts?: string[]; defaultEffort?: string }
export interface SlashCommand { name: string; description: string; argumentHint?: string; local?: boolean }

/** Handled by Desk itself, since the CLIs only take these in their own interactive screen. */
export const LOCAL_COMMANDS: SlashCommand[] = [
  { name: "model", description: "Choose the model for this chat", argumentHint: "<model>", local: true },
  { name: "effort", description: "Set how hard the model thinks", argumentHint: "low | medium | high | xhigh | max", local: true },
  { name: "permissions", description: "Choose what it may do without asking", local: true },
  { name: "new", description: "Start a new chat in this project", local: true },
  { name: "terminal", description: "Continue this conversation in a terminal tab", local: true },
];

export interface Chat {
  id: string;
  projectId: string;
  tool: Tool;
  accountId: string;
  cwd: string;
  /** Claude Code's session id (chosen up front) or Codex's thread id (once it starts). */
  sessionId: string | null;
  /** Whether the CLI has saved the session, so the next start resumes it. */
  saved: boolean;
  title: string;
  items: ChatItem[];
  status: "idle" | "starting" | "running";
  /** Running process, if any. Claude keeps one per chat; Codex one per turn. */
  proc: number | null;
  mode: string;
  model: string;
  /** Only the end of a long conversation was loaded. */
  truncated: boolean;
  loading: boolean;
  startedAt: number | null;
  /** Ms the last turn took, shown above its answer. */
  lastTurnMs: number | null;
  /** Stop was pressed; the turn's end is reported as stopped, not failed. */
  stopping?: boolean;
  /** Reasoning effort; empty uses the CLI's own setting. */
  effort: string;
  /** Finished or asked something while you weren't looking at it. */
  unread?: boolean;
  /** Files waiting in the composer, sent with the next message. */
  pending?: Attachment[];
  /** Text to drop into the composer (review comments), taken once it's on screen. */
  draft?: string;
  /** The first message creates a worktree on a new branch and the chat moves there. */
  worktree?: boolean;
  /** Branch name to use for that worktree instead of one made from the message. */
  branchHint?: string;
}

interface ChatState {
  chats: Record<string, Chat>;
  activeId: string | null;
  /** Open tabs in the chat view, in order: `c:<chat id>` or `t:<terminal tab id>`. */
  strip: string[];
  /** Terminal tab on screen in the chat view, if one is picked over the chat. */
  termId: string | null;
  /** Past conversations per project path, for the sidebar. */
  sessions: Record<string, AgentSession[]>;
  /** Claude Code's slash commands per account folder and project, from its start-up answer. */
  commands: Record<string, SlashCommand[]>;
  /** Codex's model catalog per account folder. */
  codexModels: Record<string, ModelChoice[]>;
  query: string;
  setQuery(q: string): void;
  patch(id: string, patch: Partial<Chat> | ((c: Chat) => Partial<Chat>)): void;
  select(id: string | null): void;
}

export const useChats = create<ChatState>((set) => ({
  chats: {},
  activeId: null,
  strip: [],
  termId: null,
  sessions: {},
  commands: {},
  codexModels: {},
  query: "",
  setQuery: (query) => set({ query }),
  patch: (id, patch) =>
    set((s) => {
      const chat = s.chats[id];
      if (!chat) return s;
      return { chats: { ...s.chats, [id]: { ...chat, ...(typeof patch === "function" ? patch(chat) : patch) } } };
    }),
  select: (activeId) => set((s) => ({
    activeId,
    termId: null,
    strip: activeId ? withTab(s, `c:${activeId}`) : s.strip,
    chats: activeId && s.chats[activeId]?.unread ? { ...s.chats, [activeId]: { ...s.chats[activeId], unread: false } } : s.chats,
  })),
}));

/** The strip with `key` in it, placed after the tab on screen when it is new. */
function withTab(s: Pick<ChatState, "strip" | "activeId" | "termId">, key: string) {
  if (s.strip.includes(key)) return s.strip;
  const current = s.termId ? `t:${s.termId}` : s.activeId ? `c:${s.activeId}` : null;
  const at = current ? s.strip.indexOf(current) : -1;
  return at < 0 ? [...s.strip, key] : [...s.strip.slice(0, at + 1), key, ...s.strip.slice(at + 1)];
}

/** Adds a chat and shows it in its own tab. */
function addChat(chat: Chat) {
  useChats.setState((s) => ({ chats: { ...s.chats, [chat.id]: chat }, activeId: chat.id, termId: null, strip: withTab(s, `c:${chat.id}`) }));
}

chatView.showTerminal = (tabId) => useChats.setState((s) => ({ termId: tabId, strip: withTab(s, `t:${tabId}`) }));

/** Closes a tab in the chat view's strip and shows its neighbour. */
export function closeStripTab(key: string) {
  const s = useChats.getState();
  const at = s.strip.indexOf(key);
  const strip = s.strip.filter((k) => k !== key);
  const onScreen = key === (s.termId ? `t:${s.termId}` : `c:${s.activeId}`);
  const next = onScreen ? strip[Math.min(at, strip.length - 1)] : undefined;
  useChats.setState({ strip, ...(next ? (next.startsWith("t:") ? { termId: next.slice(2) } : { activeId: next.slice(2), termId: null }) : onScreen ? { termId: null, activeId: null } : {}) });
}

/** Moves strip tab `key` in front of `before`, or to the end when `before` is null. */
export function moveStripTab(key: string, before: string | null) {
  if (key === before) return;
  useChats.setState((s) => {
    const strip = s.strip.filter((k) => k !== key);
    const at = before ? strip.indexOf(before) : -1;
    return { strip: at < 0 ? [...strip, key] : [...strip.slice(0, at), key, ...strip.slice(at)] };
  });
}

/** Shows the strip tab `key`. */
export function showStripTab(key: string) {
  if (key.startsWith("t:")) {
    useChats.setState({ termId: key.slice(2) });
    const tab = useDesk.getState().tabs.find((t) => t.id === key.slice(2));
    if (tab) useDesk.setState({ activeTabId: tab.id, activeProjectId: tab.projectId });
  } else {
    const chat = useChats.getState().chats[key.slice(2)];
    useChats.getState().select(key.slice(2));
    if (chat) useDesk.getState().selectProject(chat.projectId);
  }
}

const chats = () => useChats.getState();
const desk = () => useDesk.getState();

function updateItems(chatId: string, fn: (items: ChatItem[]) => ChatItem[]) {
  chats().patch(chatId, (c) => ({ items: fn(c.items) }));
}

function upsert(items: ChatItem[], item: ChatItem) {
  const i = items.findIndex((x) => x.id === item.id);
  if (i < 0) return [...items, item];
  const next = items.slice();
  next[i] = { ...items[i], ...item } as ChatItem;
  return next;
}

// Sessions for the sidebar

export async function loadSessions(project: Project) {
  const accounts = desk().accounts;
  const dirs = (kind: Tool) => [...new Set(accounts.filter((a) => a.kind === kind).map((a) => a.dir))];
  try {
    const list = await ipc.sessionsList(project.path, dirs("claude"), dirs("codex"));
    useChats.setState((s) => ({ sessions: { ...s.sessions, [project.path]: list } }));
  } catch {
    /* Keeps what was there. */
  }
}

export function loadAllSessions() {
  for (const p of desk().projects) if (!p.worktreeOf) void loadSessions(p);
}

// Opening chats

/** A blank chat in a project, using the project's account for `tool`. */
export function newChat(projectId: string, tool: Tool = lastTool) {
  const s = desk();
  const project = s.projects.find((p) => p.id === projectId);
  if (!project) return;
  // Reuse an untouched blank chat rather than piling them up.
  const blank = Object.values(chats().chats).find((c) => c.projectId === projectId && !c.items.length && !c.saved && c.status === "idle");
  if (blank) {
    chats().patch(blank.id, { tool, accountId: projectAccount(s.accounts, project, tool).id, sessionId: tool === "claude" ? uid() : null, mode: defaultMode(tool, project), model: "", effort: "", worktree: s.preferences.chatWorktree && !project.worktreeOf });
    chats().select(blank.id);
    s.selectProject(projectId);
    return blank.id;
  }
  const chat: Chat = {
    id: uid(),
    projectId,
    tool,
    accountId: projectAccount(s.accounts, project, tool).id,
    cwd: project.path,
    sessionId: tool === "claude" ? uid() : null,
    saved: false,
    title: "New chat",
    items: [],
    status: "idle",
    proc: null,
    mode: defaultMode(tool, project),
    model: "",
    effort: "",
    truncated: false,
    loading: false,
    startedAt: null,
    lastTurnMs: null,
    worktree: s.preferences.chatWorktree && !project.worktreeOf,
  };
  addChat(chat);
  s.selectProject(projectId);
  return chat.id;
}

let lastTool: Tool = "claude";
/** Someone else's checkout starts read-only: plan mode for Claude, a read-only sandbox for Codex. */
const defaultMode = (tool: Tool, project?: Project, cwd?: string) =>
  project?.untrusted || (cwd && untrustedPath(cwd)) ? (tool === "claude" ? "plan" : "read-only") : tool === "claude" ? "default" : "workspace-write";
/** Trust follows the folder the agent runs in, as well as the project the chat is filed under. */
const untrusted = (chat: Chat) => untrustedPath(chat.cwd) || !!desk().projects.find((p) => p.id === chat.projectId)?.untrusted;

/** A folder was just marked untrusted: agents already running there were started with its
 *  own settings, so stop them. Chats restart restricted on the next message, in a read-only mode. */
export function distrustChats(path: string) {
  const inside = (cwd: string) => cwd === path || cwd.startsWith(path + "/");
  for (const chat of Object.values(chats().chats)) {
    if (!inside(chat.cwd)) continue;
    if (chat.proc != null) void ipc.chatKill(chat.proc);
    chats().patch(chat.id, { proc: null, status: "idle", mode: chat.tool === "claude" ? "plan" : "read-only" });
  }
}

/** Opens a past conversation as a chat, with its history, or shows the chat already open. */
export function openSession(session: AgentSession, project: Project) {
  const open = Object.values(chats().chats).find((c) => c.tool === session.tool && c.sessionId === session.id);
  desk().selectProject(project.id);
  if (open) {
    chats().select(open.id);
    return open.id;
  }
  const account = desk().accounts.find((a) => a.kind === session.tool && a.dir === session.dir) ?? projectAccount(desk().accounts, project, session.tool);
  const chat: Chat = {
    id: uid(),
    projectId: project.id,
    tool: session.tool,
    accountId: account.id,
    cwd: session.cwd,
    sessionId: session.id,
    saved: true,
    title: session.title,
    items: [],
    status: "idle",
    proc: null,
    mode: defaultMode(session.tool, project, session.cwd),
    model: "",
    effort: "",
    truncated: false,
    loading: true,
    startedAt: null,
    lastTurnMs: null,
  };
  addChat(chat);
  void ipc.chatHistory(session.tool, account.dir, session.cwd, session.id).then((h) => {
    const items = session.tool === "claude" ? claudeHistory(h.records) : codexHistory(h.records);
    chats().patch(chat.id, { items, truncated: h.truncated, loading: false });
  }).catch(() => chats().patch(chat.id, { loading: false }));
  return chat.id;
}

export function closeChat(id: string) {
  const chat = chats().chats[id];
  if (!chat) return;
  if (chat.proc != null) void ipc.chatKill(chat.proc);
  closeStripTab(`c:${id}`);
  useChats.setState((s) => {
    const rest = { ...s.chats };
    delete rest[id];
    return { chats: rest, activeId: s.activeId === id ? null : s.activeId };
  });
}

// Sending

function accountFor(chat: Chat) {
  const s = desk();
  const project = s.projects.find((p) => p.id === chat.projectId);
  const account = s.accounts.find((a) => a.id === chat.accountId) ?? projectAccount(s.accounts, project, chat.tool);
  const { env, unset } = sessionEnv(s.accounts, project, { [chat.tool]: account });
  return { account, env, unset };
}

export async function send(chatId: string, text: string, attachments: Attachment[] = []) {
  const chat = chats().chats[chatId];
  if (!chat || (!text.trim() && !attachments.length)) return;
  lastTool = chat.tool;
  const first = !chat.items.some((i) => i.kind === "user");
  chats().patch(chatId, (c) => ({
    items: [...c.items, { kind: "user", id: uid(), text, ...(attachments.length ? { attachments } : {}) }],
    title: first && c.title === "New chat" ? oneLine(text || attachments.map((a) => a.name).join(", ")) : c.title,
    status: c.proc != null ? "running" : "starting",
    startedAt: Date.now(),
  }));
  if (first && chat.worktree) {
    try {
      await moveToWorktree(chatId, text || attachments.map((a) => a.name).join(" "));
    } catch (e) {
      fail(chatId, `Couldn't create a worktree: ${String(e)}`);
      return;
    }
  }
  try {
    if (chat.tool === "claude") await sendClaude(chatId, text, attachments);
    else await runCodex(chatId, text, attachments);
  } catch (e) {
    fail(chatId, `Couldn't start ${chat.tool === "claude" ? "Claude Code" : "Codex"}: ${String(e)}`);
  }
}

function oneLine(text: string) {
  const line = text.trim().split(/\s+/).join(" ");
  return line.length > 80 ? line.slice(0, 79) + "…" : line;
}

function fail(chatId: string, text: string) {
  updateItems(chatId, (items) => [...items, { kind: "notice", id: uid(), text, tone: "error" }]);
  chats().patch(chatId, { status: "idle", proc: null });
}

/** Stops the turn in progress. Claude Code keeps the session open; Codex's process ends. */
export function stop(chatId: string) {
  const chat = chats().chats[chatId];
  if (!chat || chat.proc == null) return;
  chats().patch(chatId, { stopping: true });
  if (chat.tool === "claude") {
    void ipc.chatWrite(chat.proc, JSON.stringify({ type: "control_request", request_id: `stop-${uid()}`, request: { subtype: "interrupt" } })).catch(() => void ipc.chatKill(chat.proc!));
  } else {
    void ipc.chatKill(chat.proc);
  }
}

function finishTurn(chatId: string) {
  chats().patch(chatId, (c) => ({
    status: "idle",
    stopping: false,
    lastTurnMs: c.startedAt ? Date.now() - c.startedAt : null,
    startedAt: null,
    items: [
      ...c.items.map((i) => (i.kind === "assistant" && i.streaming ? { ...i, streaming: false } : i.kind === "tool" && i.state === "running" ? { ...i, state: "done" as const } : i.kind === "approval" && i.state === "pending" ? { ...i, state: "expired" as const } : i)),
      ...(c.stopping ? [{ kind: "notice" as const, id: uid(), text: "Stopped." }] : []),
    ],
  }));
  const chat = chats().chats[chatId];
  const project = desk().projects.find((p) => p.id === chat?.projectId);
  if (chat && !chat.stopping) alertChat(chat, "Finished");
  if (project) setTimeout(() => void loadSessions(project), 800);
  setTimeout(() => void refreshLimits(), 1500);
}

/** Whether the chat is what you're looking at right now. */
export function chatOnScreen(chatId: string) {
  const s = chats();
  return document.hasFocus() && desk().preferences.uiMode === "chat" && s.activeId === chatId && !s.termId;
}

/** Shows a chat: its project, its tab, and the chat view. */
export function showChat(chatId: string) {
  const chat = chats().chats[chatId];
  if (!chat) return;
  if (desk().preferences.uiMode !== "chat") desk().setPreferences({ uiMode: "chat" });
  chats().select(chatId);
  desk().selectProject(chat.projectId);
}

/** Marks a chat unread and notifies, unless you're looking at it. */
function alertChat(chat: Chat, reason: string) {
  if (chatOnScreen(chat.id)) return;
  chats().patch(chat.id, { unread: true });
  const project = desk().projects.find((p) => p.id === chat.projectId);
  notify(`${chat.title} · ${project?.name ?? "Desk"}`, reason, () => showChat(chat.id));
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;

/** Adds files (by path) to a chat's composer. */
export function attach(chatId: string, paths: string[]) {
  chats().patch(chatId, (c) => {
    const have = new Set((c.pending ?? []).map((a) => a.path));
    const added = paths.filter((p) => !have.has(p)).map((p) => ({ name: p.split("/").pop() || p, path: p, image: IMAGE_EXT.test(p) }));
    return { pending: [...(c.pending ?? []), ...added] };
  });
}

export function detach(chatId: string, path: string) {
  chats().patch(chatId, (c) => ({ pending: (c.pending ?? []).filter((a) => a.path !== path) }));
}

/** Saves a pasted image to Desk's attachment folder and adds it to the composer. */
export async function attachBlob(chatId: string, file: Blob, name: string) {
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  attach(chatId, [await ipc.attachmentSave(name, data)]);
}

/** Sets or clears the unread dot by hand. */
export function markUnread(chatId: string, unread = true) {
  chats().patch(chatId, { unread });
}

// Claude Code

/** Makes a worktree for the chat's task (branch named from the message) and moves the chat there. */
async function moveToWorktree(chatId: string, text: string) {
  const chat = chats().chats[chatId];
  const project = desk().projects.find((p) => p.id === chat?.projectId);
  if (!chat || !project) return;
  const parent = rootProject(project);
  const slug = chat.branchHint ? branchSlug(chat.branchHint) : branchSlug(text.split(/\s+/).slice(0, 6).join(" ").replace(/\//g, " ")).slice(0, 40).replace(/[-.]+$/, "");
  updateItems(chatId, (items) => [...items, { kind: "notice", id: "worktree", text: "Creating a worktree for this task…" }]);
  const made = await ipc.gitTaskWorktree(parent.path, slug).finally(() => updateItems(chatId, (items) => items.filter((i) => i.id !== "worktree")));
  const id = addWorktreeProject(parent, made.path, made.branch, made.base);
  chats().patch(chatId, { projectId: id, cwd: made.path, worktree: false });
  updateItems(chatId, (items) => [...items, { kind: "notice", id: uid(), text: `Working in a new worktree on ${made.branch}, from ${made.base}.` }]);
  if (chats().activeId === chatId) desk().selectProject(id);
}

/** Starts or stops the next message making a worktree (fresh chats only). */
export function setWorktree(chatId: string, on: boolean) {
  chats().patch(chatId, { worktree: on });
  if (desk().preferences.chatWorktree !== on) desk().setPreferences({ chatWorktree: on });
}

/** The message text with non-image attachments listed as paths the agent can open. */
function withFiles(text: string, attachments: Attachment[], images: boolean) {
  const files = attachments.filter((a) => images || !a.image);
  if (!files.length) return text;
  return `${text}${text ? "\n\n" : ""}Attached files:\n${files.map((a) => `- ${a.path}`).join("\n")}`;
}

async function sendClaude(chatId: string, text: string, attachments: Attachment[] = []) {
  let chat = chats().chats[chatId];
  if (chat.proc == null) {
    await startClaude(chatId);
    chat = chats().chats[chatId];
  }
  if (chat.proc == null) return;
  const images = await Promise.all(attachments.filter((a) => a.image).map(async (a) => {
    const { mediaType, data } = await ipc.attachmentImage(a.path);
    return { type: "image", source: { type: "base64", media_type: mediaType, data } };
  }));
  const body = withFiles(text, attachments, false);
  const content = [...images, ...(body ? [{ type: "text", text: body }] : [])];
  await ipc.chatWrite(chat.proc, JSON.stringify({ type: "user", message: { role: "user", content }, parent_tool_use_id: null }));
}

async function startClaude(chatId: string) {
  const chat = chats().chats[chatId];
  const { account, env, unset } = accountFor(chat);
  const id = chat.sessionId ?? uid();
  // A chat whose session Claude Code has saved is resumed; a new one is started under its id.
  const state = await ipc.claudeSessionState(account.dir, chat.cwd, id).catch(() => "missing" as const);
  const sessionId = state === "empty" ? uid() : id;
  const args = [
    "claude", "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-prompt-tool", "stdio",
    ...(untrusted(chat) ? UNTRUSTED_CLAUDE_ARGS : []),
    "--permission-mode", chat.mode,
    ...(chat.mode === "bypassPermissions" ? ["--allow-dangerously-skip-permissions"] : []),
    ...(chat.model ? ["--model", chat.model] : []),
    ...(chat.effort ? ["--effort", chat.effort] : []),
    // Questions come as plain text instead; the chat has no card for answering them.
    "--disallowedTools", "AskUserQuestion",
    ...(state === "resumable" ? ["--resume", sessionId] : ["--session-id", sessionId]),
  ];
  const parser = claudeParser(chatId);
  const proc = await ipc.chatSpawn({ cwd: chat.cwd, args, env, unset, stdin: true }, (line) => parser(line, proc));
  chats().patch(chatId, { proc, sessionId, accountId: account.id, saved: state === "resumable" || chat.saved });
  await ipc.chatWrite(proc, JSON.stringify({ type: "control_request", request_id: `init-${uid()}`, request: { subtype: "initialize" } })).catch(() => {});
}

/** Answers a permission question from Claude Code. */
export function answer(chatId: string, requestId: string, allow: boolean) {
  const chat = chats().chats[chatId];
  const item = chat?.items.find((i) => i.kind === "approval" && i.id === requestId);
  if (!chat || chat.proc == null || item?.kind !== "approval" || item.state !== "pending") return;
  const response = allow
    ? { behavior: "allow", updatedInput: item.input ?? {} }
    : { behavior: "deny", message: item.tool === "ExitPlanMode" ? "The user wants to keep planning. Ask what to change." : "The user declined this action.", interrupt: false };
  void ipc.chatWrite(chat.proc, JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: requestId, response } }));
  updateItems(chatId, (items) => upsert(items, { ...item, state: allow ? "allowed" : "denied" }));
}

/** Changes the permission mode, live when Claude Code is running. */
export function setMode(chatId: string, mode: string) {
  const chat = chats().chats[chatId];
  if (!chat) return;
  chats().patch(chatId, { mode });
  if (chat.tool === "claude" && chat.proc != null) {
    // Full access needs a flag at start-up, so that one restarts the process.
    if (mode === "bypassPermissions" || chat.mode === "bypassPermissions") restart(chatId);
    else void ipc.chatWrite(chat.proc, JSON.stringify({ type: "control_request", request_id: `mode-${uid()}`, request: { subtype: "set_permission_mode", mode } })).catch(() => {});
  }
}

export function setModel(chatId: string, model: string) {
  const chat = chats().chats[chatId];
  if (!chat) return;
  // A Codex model may not offer the effort chosen for the last one.
  const efforts = chat.tool === "codex" ? codexModelList(chat).find((m) => m.id === model)?.efforts : CLAUDE_EFFORTS;
  chats().patch(chatId, { model, ...(chat.effort && efforts && !efforts.includes(chat.effort) ? { effort: "" } : {}) });
  if (chat.tool === "claude" && chat.proc != null) restart(chatId);
}

export function setEffort(chatId: string, effort: string) {
  const chat = chats().chats[chatId];
  if (!chat) return;
  chats().patch(chatId, { effort });
  if (chat.tool === "claude" && chat.proc != null) restart(chatId);
}

// Pickers

const accountDir = (chat: Chat) => desk().accounts.find((a) => a.id === chat.accountId)?.dir ?? null;
const commandKey = (chat: Chat) => `${accountDir(chat) ?? ""}|${chat.cwd}`;

export function codexModelList(chat: Chat): ModelChoice[] {
  return chats().codexModels[accountDir(chat) ?? ""] ?? [];
}

export async function loadCodexModels(chat: Chat) {
  const dir = accountDir(chat);
  if (chats().codexModels[dir ?? ""]) return;
  const list = await ipc.codexModels(dir).catch(() => []);
  useChats.setState((s) => ({ codexModels: { ...s.codexModels, [dir ?? ""]: list } }));
}

export function commandList(chat: Chat): SlashCommand[] {
  return chat.tool === "claude" ? chats().commands[commandKey(chat)] ?? [] : [];
}

const probing = new Set<string>();

/** Asks Claude Code for its slash commands without starting a conversation: it is
 * started, asked to initialize, and stopped as soon as it answers. */
export async function loadClaudeCommands(chat: Chat) {
  const key = commandKey(chat);
  if (chat.tool !== "claude" || chats().commands[key] || probing.has(key)) return;
  probing.add(key);
  const { env, unset } = accountFor(chat);
  let proc: number | null = null;
  const done = () => { if (proc != null) void ipc.chatKill(proc); probing.delete(key); };
  const timer = setTimeout(done, 20_000);
  try {
    proc = await ipc.chatSpawn(
      { cwd: chat.cwd, args: ["claude", "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--no-session-persistence", ...(untrusted(chat) ? UNTRUSTED_CLAUDE_ARGS : [])], env, unset, stdin: true },
      (line) => {
        let record: Json;
        try { record = JSON.parse(line); } catch { return; }
        if (record.type === "control_response" && saveCommands(key, record)) { clearTimeout(timer); done(); }
        if (record.type === "desk_exit") { clearTimeout(timer); probing.delete(key); }
      },
    );
    await ipc.chatWrite(proc, JSON.stringify({ type: "control_request", request_id: `init-${uid()}`, request: { subtype: "initialize" } }));
  } catch {
    clearTimeout(timer);
    done();
  }
}

function saveCommands(key: string, record: Json) {
  const list = record.response?.response?.commands;
  if (!Array.isArray(list)) return false;
  const commands: SlashCommand[] = list
    .filter((c: Json) => typeof c?.name === "string")
    .map((c: Json) => ({ name: c.name.replace(/^\//, ""), description: c.description ?? "", argumentHint: c.argumentHint || undefined }));
  useChats.setState((s) => ({ commands: { ...s.commands, [key]: commands } }));
  return true;
}

/** Ends an idle Claude Code process so the next message starts it with new settings. */
function restart(chatId: string) {
  const chat = chats().chats[chatId];
  if (!chat || chat.proc == null || chat.status !== "idle") return;
  const proc = chat.proc;
  chats().patch(chatId, { proc: null });
  void ipc.chatKill(proc);
}

export function setAccount(chatId: string, accountId: string) {
  const chat = chats().chats[chatId];
  if (!chat || chat.saved || chat.items.length) return;
  chats().patch(chatId, { accountId });
}

export function setTool(chatId: string, tool: Tool) {
  const chat = chats().chats[chatId];
  if (!chat || chat.saved || chat.items.length || chat.tool === tool) return;
  const project = desk().projects.find((p) => p.id === chat.projectId);
  lastTool = tool;
  chats().patch(chatId, { tool, accountId: projectAccount(desk().accounts, project, tool).id, sessionId: tool === "claude" ? uid() : null, mode: defaultMode(tool, project), model: "", effort: "" });
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function toolSummary(name: string, input: Json | undefined): string {
  if (!input) return "";
  const pick = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.query ?? input.description ?? input.prompt ?? input.skill;
  if (typeof pick === "string") return oneLine(pick).slice(0, 200);
  if (name === "TodoWrite" && Array.isArray(input.todos)) return `${input.todos.length} to-dos`;
  return "";
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p: Json) => (p?.type === "text" ? p.text : p?.type === "image" ? "[image]" : "")).filter(Boolean).join("\n");
  return "";
}

/** Text the user typed, or null for records Claude Code keeps for itself. */
function claudeUserText(record: Json): string | null {
  if (record.isMeta) return null;
  const content = record.message?.content;
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.filter((p: Json) => p.type === "text").map((p: Json) => p.text).join("\n") : "";
  const t = text.trim();
  if (!t || t.startsWith("<local-command") || t.startsWith("Caveat:") || t.startsWith("<system-reminder>") || t.startsWith("[Request interrupted")) return null;
  const command = /^<command-name>([^<]*)<\/command-name>/.exec(t) ?? /<command-name>([^<]*)<\/command-name>/.exec(t);
  if (command) {
    const args = /<command-args>([^<]*)<\/command-args>/.exec(t)?.[1]?.trim();
    return `${command[1].trim()}${args ? " " + args : ""}`;
  }
  return t;
}

/** Applies one Claude Code record (live or from the transcript) to the items. */
function applyClaude(items: ChatItem[], record: Json, live: boolean): ChatItem[] {
  if (record.type === "assistant" && !record.parent_tool_use_id) {
    const msg = record.message ?? {};
    let next = items;
    const blocks: Json[] = Array.isArray(msg.content) ? msg.content : [];
    blocks.forEach((block, index) => {
      if (block.type === "text" && block.text?.trim()) {
        // The final text replaces what streamed in for it.
        next = next.filter((i) => !(i.kind === "assistant" && i.streaming && i.id.startsWith(`s:${msg.id}:`) && block.text.startsWith(i.text.slice(0, 40))));
        next = upsert(next, { kind: "assistant", id: `${msg.id}:${index}:${block.text.length > 40 ? block.text.slice(0, 40) : block.text}`, text: block.text });
      } else if (block.type === "tool_use") {
        next = upsert(next, { kind: "tool", id: block.id, name: block.name, summary: toolSummary(block.name, block.input), state: live ? "running" : "done" });
      }
    });
    return next;
  }
  if (record.type === "user" && !record.parent_tool_use_id) {
    const content = record.message?.content;
    if (Array.isArray(content) && content.some((p: Json) => p.type === "tool_result")) {
      let next = items;
      for (const part of content) {
        if (part.type !== "tool_result") continue;
        const existing = next.find((i) => i.id === part.tool_use_id);
        if (existing?.kind === "tool") next = upsert(next, { ...existing, output: resultText(part.content).slice(0, 6000), state: part.is_error ? "error" : "done" });
      }
      return next;
    }
    if (live) return items; // What the user sent is already shown.
    const text = claudeUserText(record);
    const images = record.isMeta || !Array.isArray(content) ? 0 : content.filter((p: Json) => p?.type === "image").length;
    const attachments = Array.from({ length: images }, (_, i) => ({ name: images > 1 ? `Image ${i + 1}` : "Image", path: "", image: true }));
    return text || images ? [...items, { kind: "user", id: record.uuid ?? uid(), text: text ?? "", ...(images ? { attachments } : {}) }] : items;
  }
  return items;
}

export function claudeHistory(records: Json[]): ChatItem[] {
  return records.reduce<ChatItem[]>((items, r) => applyClaude(items, r, false), []);
}

function claudeParser(chatId: string) {
  let messageId = "";
  return (line: string, proc: number) => {
    let record: Json;
    try { record = JSON.parse(line); } catch { return; }
    const chat = chats().chats[chatId];
    if (!chat || (chat.proc !== proc && record.type !== "desk_exit" && chat.proc != null)) return;
    switch (record.type) {
      case "stream_event": {
        if (record.parent_tool_use_id) return;
        const event = record.event ?? {};
        if (event.type === "message_start") messageId = event.message?.id ?? uid();
        else if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
          const id = `s:${messageId}:${event.index}`;
          updateItems(chatId, (items) => {
            const existing = items.find((i) => i.id === id);
            return upsert(items, { kind: "assistant", id, text: (existing?.kind === "assistant" ? existing.text : "") + event.delta.text, streaming: true });
          });
        }
        if (chat.status === "starting") chats().patch(chatId, { status: "running" });
        return;
      }
      case "assistant":
      case "user":
        updateItems(chatId, (items) => applyClaude(items, record, true));
        if (chat.status === "starting") chats().patch(chatId, { status: "running" });
        return;
      case "system":
        if (record.subtype === "init" && record.session_id) chats().patch(chatId, { sessionId: record.session_id, saved: true });
        return;
      case "control_request": {
        const request = record.request ?? {};
        if (request.subtype !== "can_use_tool") return;
        const name = request.tool_name ?? "a tool";
        updateItems(chatId, (items) => upsert(items, { kind: "approval", id: record.request_id, tool: name, summary: toolSummary(name, request.input) || describeInput(request.input), input: request.input, state: "pending" }));
        alertChat(chat, `Wants to use ${name}`);
        return;
      }
      case "control_response":
        saveCommands(commandKey(chat), record);
        return;
      case "control_cancel_request":
        updateItems(chatId, (items) => items.map((i) => (i.kind === "approval" && i.id === record.request_id && i.state === "pending" ? { ...i, state: "expired" } : i)));
        return;
      case "result":
        if (record.is_error && !chat.stopping) {
          // Lines in brackets are the CLI's own diagnostics, not something to show.
          const errors = (record.errors ?? []).filter((e: unknown) => typeof e === "string" && !e.startsWith("["));
          const text = typeof record.result === "string" && record.result ? record.result : errors.join("\n") || "The turn ended with an error.";
          updateItems(chatId, (items) => [...items, { kind: "notice", id: uid(), text, tone: "error" }]);
        }
        finishTurn(chatId);
        return;
      case "desk_exit": {
        if (chat.proc !== proc) return;
        const wasBusy = chat.status !== "idle";
        chats().patch(chatId, { proc: null });
        if (wasBusy) {
          const reason = (record.stderr as string)?.trim().split("\n").slice(-6).join("\n");
          if (record.code !== 0 && record.code != null) updateItems(chatId, (items) => [...items, { kind: "notice", id: uid(), text: reason || `Claude Code stopped (exit ${record.code}).`, tone: "error" }]);
          finishTurn(chatId);
        }
        return;
      }
    }
  };
}

function describeInput(input: unknown) {
  try {
    const text = JSON.stringify(input);
    return text.length > 200 ? text.slice(0, 199) + "…" : text;
  } catch {
    return "";
  }
}

// Codex

async function runCodex(chatId: string, text: string, attachments: Attachment[] = []) {
  const chat = chats().chats[chatId];
  const { account, env, unset } = accountFor(chat);
  const access = chat.mode === "danger-full-access" ? ["--dangerously-bypass-approvals-and-sandbox"] : ["-c", `sandbox_mode="${chat.mode === "read-only" ? "read-only" : "workspace-write"}"`];
  const images = attachments.filter((a) => a.image).map((a) => `--image=${a.path}`);
  const common = ["--json", "--skip-git-repo-check", ...access, ...(chat.model ? ["-m", chat.model] : []), ...(chat.effort ? ["-c", `model_reasoning_effort="${chat.effort}"`] : []), ...images];
  text = withFiles(text, attachments, false) || "See the attached image.";
  const args = chat.sessionId
    ? ["codex", "exec", "resume", ...common, "--", chat.sessionId, text]
    : ["codex", "exec", ...common, "--", text];
  const parser = codexParser(chatId);
  const proc = await ipc.chatSpawn({ cwd: chat.cwd, args, env, unset, stdin: false }, (line) => parser(line, proc));
  chats().patch(chatId, { proc, accountId: account.id, status: "running" });
}

function codexItem(item: Json, live: boolean): ChatItem | null {
  const id = item.id ?? uid();
  switch (item.type) {
    case "agent_message":
      return item.text?.trim() ? { kind: "assistant", id, text: item.text } : null;
    case "command_execution":
      return { kind: "tool", id, name: "Shell", summary: shellCommand(item.command), output: item.aggregated_output, state: item.status === "in_progress" && live ? "running" : item.exit_code && item.exit_code !== 0 ? "error" : "done" };
    case "file_change":
      return { kind: "tool", id, name: "Edit", summary: (item.changes ?? []).map((c: Json) => `${c.kind ?? "update"} ${c.path}`).join(", "), state: item.status === "failed" ? "error" : "done" };
    case "mcp_tool_call":
      return { kind: "tool", id, name: `${item.server ?? "mcp"}.${item.tool ?? ""}`, summary: "", state: item.status === "in_progress" && live ? "running" : item.status === "failed" ? "error" : "done" };
    case "web_search":
      return { kind: "tool", id, name: "Web search", summary: item.query ?? "", state: "done" };
    case "todo_list":
      return { kind: "tool", id, name: "Plan", summary: (item.items ?? []).map((t: Json) => `${t.completed ? "✓" : "·"} ${t.text}`).join("  "), state: "done" };
    case "error":
      return { kind: "notice", id, text: item.message ?? "Error", tone: "error" };
    default:
      return null;
  }
}

/** `/bin/zsh -lc 'echo hi'` reads as `echo hi`. */
function shellCommand(command: unknown) {
  const text = Array.isArray(command) ? command.join(" ") : String(command ?? "");
  const wrapped = /^\S*sh -l?c (['"])([\s\S]*)\1$/.exec(text) ?? (Array.isArray(command) && command.length === 3 && /sh$/.test(command[0]) ? [null, null, command[2]] : null);
  return oneLine(wrapped ? String(wrapped[2]) : text);
}

function codexParser(chatId: string) {
  return (line: string, proc: number) => {
    let record: Json;
    try { record = JSON.parse(line); } catch { return; }
    const chat = chats().chats[chatId];
    if (!chat) return;
    switch (record.type) {
      case "thread.started":
        chats().patch(chatId, { sessionId: record.thread_id, saved: true });
        return;
      case "item.started":
      case "item.updated":
      case "item.completed": {
        const item = codexItem(record.item ?? {}, true);
        if (item) updateItems(chatId, (items) => upsert(items, item));
        return;
      }
      case "turn.failed":
        updateItems(chatId, (items) => [...items, { kind: "notice", id: uid(), text: record.error?.message ?? "The turn failed.", tone: "error" }]);
        return;
      case "error":
        updateItems(chatId, (items) => [...items, { kind: "notice", id: uid(), text: record.message ?? "Error", tone: "error" }]);
        return;
      case "desk_exit": {
        if (chat.proc !== proc) return;
        const last = chat.items[chat.items.length - 1];
        if (record.code !== 0 && record.code != null && !(last?.kind === "notice" && last.tone === "error")) {
          const reason = (record.stderr as string)?.trim().split("\n").filter((l) => !l.startsWith("Reading additional input")).slice(-6).join("\n");
          if (reason) updateItems(chatId, (items) => [...items, { kind: "notice", id: uid(), text: reason, tone: "error" }]);
        }
        chats().patch(chatId, { proc: null });
        finishTurn(chatId);
        return;
      }
    }
  };
}

/** Codex session logs, read as the newer item events when present, else the older ones. */
export function codexHistory(records: Json[]): ChatItem[] {
  const payloads = records.map((r) => r.payload ?? {});
  const modern = payloads.some((p) => p.type === "item_completed");
  const out: ChatItem[] = [];
  for (const p of payloads) {
    if (modern) {
      if (p.type !== "item_completed") continue;
      const item = p.item ?? {};
      const text = (item.content ?? []).map((c: Json) => c.text ?? "").join("\n").trim();
      if (item.type === "UserMessage" && text) out.push({ kind: "user", id: item.id ?? uid(), text });
      else if (item.type === "AgentMessage" && text) out.push({ kind: "assistant", id: item.id ?? uid(), text });
      else if (item.type === "CommandExecution") out.push({ kind: "tool", id: item.id ?? uid(), name: "Shell", summary: shellCommand(item.command), output: item.aggregated_output ?? item.output, state: item.exit_code ? "error" : "done" });
      else if (item.type === "McpToolCall") out.push({ kind: "tool", id: item.id ?? uid(), name: `${item.server ?? "mcp"}.${item.tool ?? ""}`, summary: "", state: "done" });
      else if (item.type === "FileChange") out.push({ kind: "tool", id: item.id ?? uid(), name: "Edit", summary: Object.keys(item.changes ?? {}).join(", "), state: "done" });
    } else if (p.type === "user_message" && p.message?.trim()) out.push({ kind: "user", id: uid(), text: p.message.trim() });
    else if (p.type === "agent_message" && p.message?.trim()) out.push({ kind: "assistant", id: uid(), text: p.message.trim() });
    else if (p.type === "exec_command_end") out.push({ kind: "tool", id: p.call_id ?? uid(), name: "Shell", summary: shellCommand(p.command), output: p.aggregated_output ?? p.stdout, state: p.exit_code ? "error" : "done" });
  }
  return out;
}

/** Live chats that are working or waiting on an answer, for the sidebar dots. */
export function chatBusy(chat: Chat | undefined) {
  if (!chat) return null;
  if (chat.items.some((i) => i.kind === "approval" && i.state === "pending")) return "waiting";
  return chat.status === "idle" ? null : "running";
}
