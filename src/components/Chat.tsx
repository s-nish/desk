import { Markdown as SharedMarkdown } from "../markdown";
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { ArrowUp, GitBranch, Pencil, Trash2, FileText, Image as ImageIcon, Paperclip, Check, ChevronDown, ChevronRight, Ellipsis, Gauge, LoaderCircle, Plus, Server, Slash, Square, SquareTerminal, UserRound, X } from "lucide-react";
import { AGENTS, TOOL_LABEL, TOOL_SHORT, useDesk } from "../store";
import { closeTab, openTerminal } from "../actions";
import { TerminalPane, cleanTitle } from "./Workspace";
import { Home } from "./Home";
import { useTabReorder } from "./useTabReorder";
import { openBrowser } from "./Browser";
import { ipc } from "../ipc";
import { openMenu } from "./Menu";
import {
  CLAUDE_EFFORTS, CLAUDE_MODELS, CLAUDE_MODES, CODEX_MODES, LOCAL_COMMANDS, acpOptions, answer, releaseAcp, chatBusy, closeChat, codexModelList, commandList, loadClaudeCommands,
  attach, attachBlob, detach, closeStripTab, markUnread, setWorktree, moveStripTab, loadCodexModels, newChat, showStripTab, openSession, send, sendNext, enqueue, unqueue, setAccount, setEffort, setMode, setModel, setTool, stop, useChats, type Attachment, type Chat, type ChatItem, type SlashCommand,
} from "../chat";
import type { Agent, AgentSession, MenuItem, Project, TerminalTab } from "../types";
import { isAcpAgent } from "../acp";
import { ToolLogo } from "./ToolLogo";
import { Radial, useRadial, type RadialItem } from "./Radial";
import { deleteConversation, renameConversation } from "../sessionActions";
import { RunInChip, SandboxHint, SandboxStrip } from "./Sandboxes";

export function ToolGlyph({ tool, size = 13 }: { tool: Agent; size?: number }) {
  return <span className="tool-glyph" role="img" aria-label={TOOL_LABEL[tool]}><ToolLogo tool={tool} size={size} /></span>;
}


/** Claude Code and Codex, plus the other agents once they have an account. */
export function chatAgents(): Agent[] {
  const accounts = useDesk.getState().accounts;
  return AGENTS.filter((a) => a === "claude" || a === "codex" || accounts.some((x) => x.kind === a));
}

const OPEN_KEY = "desk-open-projects";
const openProjects = new Set<string>((() => { try { return JSON.parse(localStorage.getItem(OPEN_KEY) ?? "[]"); } catch { return []; } })());
const openListeners = new Set<() => void>();

/** Whether a project's conversation list is open. Closed until clicked, and remembered. */
export function useExpanded(projectId: string): [boolean, (open: boolean) => void] {
  const [, rerender] = useState(0);
  useEffect(() => {
    const listener = () => rerender((n) => n + 1);
    openListeners.add(listener);
    return () => { openListeners.delete(listener); };
  }, []);
  const set = (open: boolean) => {
    if (open) openProjects.add(projectId);
    else openProjects.delete(projectId);
    try { localStorage.setItem(OPEN_KEY, JSON.stringify([...openProjects])); } catch { /* Only a convenience. */ }
    openListeners.forEach((l) => l());
  };
  return [openProjects.has(projectId), set];
}

export function shortTime(ms: number) {
  const minutes = Math.round((Date.now() - ms) / 60000);
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h`;
  if (minutes < 60 * 24 * 7) return `${Math.round(minutes / 1440)}d`;
  return `${Math.round(minutes / 10080)}w`;
}

// Conversation

export function ChatView() {
  const termId = useChats((s) => s.termId);
  const chat = useChats((s) => (s.activeId ? s.chats[s.activeId] : undefined));
  const term = useDesk((s) => (termId ? s.tabs.find((t): t is TerminalTab => t.id === termId && t.type === "terminal") : undefined));
  const project = useDesk((s) => s.projects.find((p) => p.id === (chat?.projectId ?? s.activeProjectId)));

  // A terminal tab that went away is forgotten. With nothing open, Home shows —
  // closing the last tab no longer conjures a fresh blank chat.
  useEffect(() => {
    if (!term && termId) useChats.setState({ termId: null });
  }, [term, termId]);

  return (
    <main className="workspace chat-main">
      <ChatTabs />
      {term ? (
        <div className="chat-terminal"><TerminalPane tab={term} visible focused /></div>
      ) : chat && project ? (
        <Conversation key={chat.id} chat={chat} project={project} />
      ) : (
        <div className="stage"><Home mode="chat" /></div>
      )}
    </main>
  );
}

/** Right-click menu for a conversation in the sidebar or tab strip: an open chat, a past session, or both. */
function chatMenu(chat: Chat | undefined, at: { x: number; y: number } | Element, session?: AgentSession, project?: Project) {
  const tool = chat?.tool ?? session!.tool;
  const title = chat && (chat.items.length || chat.saved) ? chat.title : session?.title ?? "New chat";
  const target = { tool, title, chat, session };
  openMenu(at, [
    ...(chat
      ? [
          { label: chat.unread ? "Mark as read" : "Mark as unread", onSelect: () => markUnread(chat.id, !chat.unread) },
          { label: "Close", icon: <X size={14} />, onSelect: () => closeChat(chat.id) },
        ]
      : session && project ? [{ label: "Open", onSelect: () => openSession(session, project) }] : []),
    { separator: true },
    { label: "Rename…", icon: <Pencil size={14} />, disabled: !chat?.items.length && !session && !chat?.saved, onSelect: () => renameConversation(target) },
    { label: "Delete…", icon: <Trash2 size={14} />, danger: true, onSelect: () => deleteConversation(target) },
  ]);
}

/** Open chats and terminal tabs, side by side, like the terminal view's tabs. */
function ChatTabs() {
  const strip = useChats((s) => s.strip);
  const chats = useChats((s) => s.chats);
  const activeId = useChats((s) => s.activeId);
  const termId = useChats((s) => s.termId);
  const tabs = useDesk((s) => s.tabs);
  const connections = useDesk((s) => s.connections);
  const projectId = useDesk((s) => s.activeProjectId);
  const scroller = useRef<HTMLDivElement>(null);
  const current = termId ? `t:${termId}` : `c:${activeId}`;
  const reorder = useTabReorder(scroller, moveStripTab);

  useEffect(() => {
    scroller.current?.querySelector(".chat-tab.is-active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [current]);

  const items = strip.flatMap((key) => {
    if (key.startsWith("c:")) {
      const chat = chats[key.slice(2)];
      if (!chat) return [];
      return [{ key, title: chat.items.length || chat.saved ? chat.title : "New chat", icon: <ToolGlyph tool={chat.tool} size={12} />, busy: chatBusy(chat) ?? (chat.unread ? "unread" : null), close: () => closeChat(chat.id), menu: (at: { x: number; y: number }) => chatMenu(chat, at) }];
    }
    const tab = tabs.find((t): t is TerminalTab => t.id === key.slice(2) && t.type === "terminal");
    if (!tab) return [];
    const connection = tab.sshId ? connections.find((c) => c.id === tab.sshId) : undefined;
    return [{
      key,
      title: tab.sshId ? connection?.name ?? "SSH" : cleanTitle(tab.title) || TOOL_LABEL[tab.tool],
      icon: tab.sshId ? <Server size={12} /> : <SquareTerminal size={12} />,
      busy: tab.busy && tab.status === "running" ? "running" : tab.attention ? "waiting" : null,
      close: () => { closeStripTab(key); closeTab(tab.id); },
      menu: undefined as ((at: { x: number; y: number }) => void) | undefined,
    }];
  });

  return (
    <div className="chat-tabs" role="tablist" aria-label="Open chats">
      <div className={"chat-tabs-scroll" + (reorder.landing?.before === null ? " has-drop-at-end" : "")} ref={scroller} onClickCapture={(e) => { if (reorder.suppressClick.current) { e.preventDefault(); e.stopPropagation(); } }}>
        {items.map((t, i) => (
          <div
            key={t.key}
            data-tab-id={t.key}
            role="tab"
            tabIndex={0}
            aria-selected={t.key === current}
            className={"chat-tab" + (t.key === current ? " is-active" : "") + (reorder.draggingId === t.key ? " is-dragging-tab" : "") + (reorder.landing?.before === t.key ? " is-drop-before" : "")}
            title={t.title + "\nDrag to reorder"}
            onPointerDown={(e) => reorder.start(t.key, e)}
            onClick={() => showStripTab(t.key)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") showStripTab(t.key);
              else if (e.altKey && e.shiftKey && e.key === "ArrowLeft" && i > 0) moveStripTab(t.key, items[i - 1].key);
              else if (e.altKey && e.shiftKey && e.key === "ArrowRight" && i < items.length - 1) moveStripTab(t.key, items[i + 2]?.key ?? null);
            }}
            onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); t.close(); } }}
            onContextMenu={(e) => { if (!t.menu) return; e.preventDefault(); t.menu({ x: e.clientX, y: e.clientY }); }}
          >
            {t.busy ? <span className={"chat-dot is-" + t.busy} /> : t.icon}
            <span className="chat-tab-title">{t.title}</span>
            <button className="chat-tab-close" aria-label={`Close ${t.title}`} onClick={(e) => { e.stopPropagation(); t.close(); }}><X size={11} /></button>
          </div>
        ))}
      </div>
      <button className="icon-btn chat-tabs-new" aria-label="New chat" title="New chat (⌘N)" onClick={() => projectId && newChat(projectId)}><Plus size={14} /></button>
    </div>
  );
}

function Conversation({ chat, project }: { chat: Chat; project: Project }) {
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const account = useDesk((s) => s.accounts.find((a) => a.id === chat.accountId));

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [chat.items, chat.status, chat.loading]);

  const openInTerminal = () => continueInTerminal(chat);
  const menu = (at: Element) => openMenu(at, [
    { label: "Continue in a terminal tab", icon: <SquareTerminal size={14} />, disabled: !chat.saved || chat.status !== "idle", onSelect: openInTerminal },
    { label: "Copy conversation ID", disabled: !chat.sessionId, onSelect: () => void navigator.clipboard.writeText(chat.sessionId ?? "") },
    { separator: true },
    { label: "Rename…", icon: <Pencil size={14} />, disabled: !chat.items.length && !chat.saved, onSelect: () => renameConversation({ tool: chat.tool, title: chat.title, chat }) },
    { label: "Delete…", icon: <Trash2 size={14} />, danger: true, onSelect: () => deleteConversation({ tool: chat.tool, title: chat.title, chat }) },
    { separator: true },
    { label: "Close chat", icon: <X size={14} />, onSelect: () => closeChat(chat.id) },
  ]);
  const empty = !chat.items.length && !chat.loading;

  return (
    <div className="chat-body">
      <header className="chat-head">
        <div className="chat-head-title">
          <strong title={chat.title}>{empty ? "New chat" : chat.title}</strong>
          <span className="chat-head-meta"><ToolGlyph tool={chat.tool} size={12} />{TOOL_LABEL[chat.tool]}{account && <span>· {account.name}</span>}<span>· {project.name}</span></span>
        </div>
        <button className="icon-btn" aria-label="Chat actions" onClick={(e) => menu(e.currentTarget)}><Ellipsis size={15} /></button>
      </header>
      <div className="chat-scroll" ref={scroller} onScroll={(e) => { const el = e.currentTarget; pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
        <div className="chat-thread">
          {chat.truncated && <p className="chat-note">Earlier messages are in the full transcript. Continue in a terminal tab to see everything.</p>}
          {chat.loading && <p className="chat-note"><LoaderCircle size={13} className="is-spinning" />Loading conversation…</p>}
          {empty && <Intro chat={chat} project={project} />}
          {chat.items.map((item, i) => (item.kind === "approval" && item.state === "allowed" && item.tool !== "ExitPlanMode") ? null : <Fragment key={item.id}><Item item={item} chat={chat} />{showDuration(chat, i) && <p className="chat-worked">Worked for {duration(chat.lastTurnMs!)}</p>}</Fragment>)}
          {chat.status !== "idle" && <Working chat={chat} />}
        </div>
      </div>
      <Composer chat={chat} />
    </div>
  );
}

function showDuration(chat: Chat, index: number) {
  return chat.status === "idle" && chat.lastTurnMs != null && index === chat.items.length - 1 && chat.lastTurnMs > 2000;
}

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;

/** "42 seconds", "9 minutes 20 seconds", "1 hour 5 minutes". */
function duration(ms: number) {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  if (h) return [plural(h, "hour"), m ? plural(m, "minute") : ""].filter(Boolean).join(" ");
  if (m) return [plural(m, "minute"), s ? plural(s, "second") : ""].filter(Boolean).join(" ");
  return plural(s, "second");
}

/** A compact running clock: "42s", "9m 20s", "1h 05m". */
function clock(total: number) {
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  if (h) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

const COMMAND_NAME: Record<Agent, string> = { claude: "claude", codex: "codex", gemini: "gemini", cursor: "cursor-agent", grok: "grok", opencode: "opencode" };

function Intro({ chat, project }: { chat: Chat; project: Project }) {
  return (
    <div className="chat-intro">
      <h1>What should {TOOL_LABEL[chat.tool]} work on?</h1>
      <p>In <strong>{project.name}</strong>. It runs the <code>{COMMAND_NAME[chat.tool]}</code> command you already use, with its own sign-in and history, so you can pick this chat up in a terminal later.</p>
    </div>
  );
}

function Working({ chat }: { chat: Chat }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const waiting = chat.items.some((i) => i.kind === "approval" && i.state === "pending");
  const seconds = chat.startedAt ? Math.round((Date.now() - chat.startedAt) / 1000) : 0;
  return <p className="chat-working"><LoaderCircle size={13} className={waiting ? "" : "is-spinning"} />{waiting ? "Waiting for your answer" : chat.status === "starting" ? "Starting…" : `Working${seconds > 1 ? ` · ${clock(seconds)}` : "…"}`}</p>;
}

function Item({ item, chat }: { item: ChatItem; chat: Chat }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="chat-user">
          {item.attachments && <div className="chat-attachments is-sent">{item.attachments.map((a, i) => <AttachmentChip key={a.path || i} attachment={a} />)}</div>}
          {item.text && <div className="chat-bubble">{item.text}</div>}
        </div>
      );
    case "assistant":
      return <div className={"chat-assistant" + (item.streaming ? " is-streaming" : "")}><Markdown text={item.text} /></div>;
    case "tool":
      return <ToolRow item={item} />;
    case "approval": {
      const plan = item.tool === "ExitPlanMode" && typeof (item.input as { plan?: unknown })?.plan === "string" ? (item.input as { plan: string }).plan : null;
      if (plan) return (
        <div className={"chat-approval is-" + item.state}>
          <div className="chat-approval-head"><strong>Plan ready</strong>{item.state !== "pending" && <span>{item.state === "allowed" ? "Approved" : item.state === "denied" ? "Kept planning" : "No longer needed"}</span>}</div>
          <div className="chat-plan"><Markdown text={plan} /></div>
          {item.state === "pending" && (
            <div className="chat-approval-actions">
              <button className="btn" onClick={() => answer(chat.id, item.id, false)}>Keep planning</button>
              <button className="btn is-primary" onClick={() => answer(chat.id, item.id, true)}><Check size={14} />Approve plan</button>
            </div>
          )}
        </div>
      );
      return (
        <div className={"chat-approval is-" + item.state}>
          <div className="chat-approval-head"><strong>{TOOL_LABEL[chat.tool]} wants to {isAcpAgent(chat.tool) ? (APPROVAL_VERB[item.tool] ?? `use ${item.tool}`) : `use ${item.tool}`}</strong>{item.state !== "pending" && <span>{item.state === "allowed" ? "Allowed" : item.state === "denied" ? "Declined" : "No longer needed"}</span>}</div>
          {item.summary && <code className="chat-approval-input">{item.summary}</code>}
          {item.state === "pending" && (
            <div className="chat-approval-actions">
              <button className="btn" onClick={() => answer(chat.id, item.id, false)}>Decline</button>
              <button className="btn is-primary" onClick={() => answer(chat.id, item.id, true)}><Check size={14} />Allow</button>
            </div>
          )}
        </div>
      );
    }
    case "notice":
      return <p className={"chat-notice" + (item.tone === "error" ? " is-error" : "")}>{item.text}</p>;
  }
}

function ToolRow({ item }: { item: Extract<ChatItem, { kind: "tool" }> }) {
  const [open, setOpen] = useState(() => useDesk.getState().preferences.chatToolsOpen);
  const verb = item.name === "Bash" || item.name === "Shell" ? "Ran" : item.name === "Read" ? "Read" : item.name === "Edit" || item.name === "Write" || item.name === "MultiEdit" ? "Edited" : item.name === "Grep" || item.name === "Glob" ? "Searched" : item.name;
  return (
    <div className={"chat-tool is-" + item.state + (open ? " is-open" : "")}>
      <button className="chat-tool-head" onClick={() => setOpen(!open)} disabled={!item.output}>
        {item.state === "running" ? <LoaderCircle size={12} className="is-spinning" /> : <ChevronRight size={12} className="chat-tool-caret" />}
        <span className="chat-tool-verb">{verb}</span>
        {item.summary && <code>{item.summary}</code>}
        {item.state === "error" && <span className="chat-tool-failed">failed</span>}
      </button>
      {open && item.output && <pre className="chat-tool-output">{item.output}</pre>}
    </div>
  );
}

/** ACP tool kinds, as the thing being asked for. */
const APPROVAL_VERB: Record<string, string> = { Edit: "edit a file", Delete: "delete a file", Move: "move a file", Shell: "run a command", Read: "read a file", Fetch: "fetch a page", Search: "search" };

const EFFORT_LABEL: Record<string, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max", minimal: "Minimal", none: "None" };

/** Continues the chat's conversation in a terminal tab, which switches to the terminal view. */
function continueInTerminal(chat: Chat) {
  if (!chat.sessionId || !chat.saved) return useDesk.getState().toast("Send a message first; there is no conversation to continue yet.");
  // An ACP agent writes its conversation as it goes; stop it so the terminal can take over.
  if (isAcpAgent(chat.tool) && chat.status !== "idle") return useDesk.getState().toast(`Wait for ${TOOL_LABEL[chat.tool]} to finish this turn first.`);
  releaseAcp(chat.id);
  openTerminal(chat.projectId, chat.tool, { accountId: chat.accountId, cwd: chat.cwd, ...(chat.tool === "claude" ? { sessionId: chat.sessionId } : { resume: chat.sessionId }) });
}

function Composer({ chat }: { chat: Chat }) {
  const [text, setText] = useState("");
  const [pickIndex, setPickIndex] = useState(0);
  const [slashClosed, setSlashClosed] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const accounts = useDesk((s) => s.accounts);
  useChats((s) => s.codexModels);
  useChats((s) => s.commands);
  const account = accounts.find((a) => a.id === chat.accountId);
  const project = useDesk((s) => s.projects.find((p) => p.id === chat.projectId));
  const repo = useDesk((s) => (project ? !!s.branches[project.worktreeOf ?? project.id] : false));
  const fresh = !chat.saved && !chat.items.length;
  const busy = chat.status !== "idle";
  useChats((s) => s.acpOptions);
  const acp = isAcpAgent(chat.tool);
  const offered = acp ? acpOptions(chat) : [];
  const offer = (category: string) => offered.find((o) => o.category === category);
  const acpMode = offer("mode"), acpModel = offer("model"), acpEffort = offer("thought_level");
  // For ACP agents an empty choice means "whatever the agent is using", shown by name.
  const acpLabel = (o: typeof acpMode, value: string, fallback: string) => o?.choices.find((c) => c.value === (value || o.current))?.name ?? fallback;
  const modes = acp
    ? (acpMode?.choices ?? []).map((c) => ({ id: c.value, label: c.name, hint: c.description ?? "" }))
    : chat.tool === "claude" ? [...CLAUDE_MODES] : [...CODEX_MODES];
  const mode = acp ? { id: chat.mode, label: acpLabel(acpMode, chat.mode, "Mode"), hint: acpMode?.choices.find((c) => c.value === (chat.mode || acpMode.current))?.description ?? "What it may do without asking" } : modes.find((m) => m.id === chat.mode) ?? modes[0];
  const models: { id: string; label: string; description?: string }[] = acp
    ? [{ id: "", label: "Default model", description: `The model set in ${TOOL_LABEL[chat.tool]}` }, ...(acpModel?.choices ?? []).map((c) => ({ id: c.value, label: c.name, description: c.description }))]
    : chat.tool === "claude" ? CLAUDE_MODELS : [{ id: "", label: "Default model", description: "The model set in Codex" }, ...codexModelList(chat)];
  const model = acp ? { id: chat.model, label: chat.model ? acpLabel(acpModel, chat.model, chat.model) : acpModel ? acpLabel(acpModel, "", "Default model") : "Default model" } : models.find((m) => m.id === chat.model);
  const efforts = acp ? (acpEffort?.choices ?? []).map((c) => c.value) : chat.tool === "claude" ? CLAUDE_EFFORTS : (codexModelList(chat).find((m) => m.id === chat.model)?.efforts ?? ["low", "medium", "high", "xhigh"]);
  const effortName = (x: string) => acpEffort?.choices.find((c) => c.value === x)?.name ?? EFFORT_LABEL[x] ?? x;
  const showModes = !acp || modes.length > 0;
  const showEffort = !acp || efforts.length > 0;

  useEffect(() => { ref.current?.focus(); }, [chat.id]);
  useEffect(() => {
    if (!chat.draft) return;
    const draft = chat.draft;
    setText((t) => (t.trim() ? `${t}\n\n${draft}` : draft));
    useChats.getState().patch(chat.id, { draft: undefined });
    ref.current?.focus();
  }, [chat.draft, chat.id]);
  useEffect(() => { if (chat.tool === "codex") void loadCodexModels(chat); }, [chat.tool, chat.accountId]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 260) + "px";
  }, [text]);

  // The slash menu: while the first word is being typed after "/".
  const typed = /^\/(\S*)$/.exec(text)?.[1];
  const commands = useMemo(() => {
    if (typed === undefined) return [];
    const all = [...LOCAL_COMMANDS, ...commandList(chat).filter((c) => !LOCAL_COMMANDS.some((l) => l.name === c.name))];
    const q = typed.toLowerCase();
    return all.filter((c) => c.name.toLowerCase().includes(q)).sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q))).slice(0, 40);
  }, [typed, chat, useChats.getState().commands]); // eslint-disable-line react-hooks/exhaustive-deps
  const slashOpen = typed !== undefined && !slashClosed && commands.length > 0;
  useEffect(() => { if (typed !== undefined) void loadClaudeCommands(chat); }, [typed !== undefined]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setPickIndex(0); setSlashClosed(false); }, [typed]);

  const runLocal = (name: string, arg: string) => {
    const want = arg.trim().toLowerCase();
    switch (name) {
      case "new": newChat(chat.projectId, chat.tool); return true;
      case "terminal": continueInTerminal(chat); return true;
      case "model": {
        const found = models.find((m) => m.id.toLowerCase() === want || m.label.toLowerCase() === want);
        if (found || want === "default") setModel(chat.id, found?.id ?? "");
        else useDesk.getState().toast(`Models: ${models.map((m) => m.id || "default").join(", ")}`);
        return true;
      }
      case "effort": {
        if (efforts.includes(want) || want === "default") setEffort(chat.id, want === "default" ? "" : want);
        else useDesk.getState().toast(`Effort: ${efforts.join(", ")}, or default`);
        return true;
      }
      case "permissions": {
        const found = modes.find((m) => m.id.toLowerCase() === want || m.label.toLowerCase() === want);
        if (found) setMode(chat.id, found.id);
        else useDesk.getState().toast(`Modes: ${modes.map((m) => m.label).join(", ")}`);
        return true;
      }
    }
    return false;
  };

  const choose = (c: SlashCommand) => {
    if (c.local && !c.argumentHint && c.name !== "permissions") {
      runLocal(c.name, "");
      setText("");
      return;
    }
    setText(`/${c.name} `);
    ref.current?.focus();
  };

  const pending = chat.pending ?? [];
  const queue = chat.queue ?? [];
  const submit = () => {
    if (!text.trim() && !pending.length) return;
    const local = /^\/(\w+)(?:\s+([\s\S]*))?$/.exec(text.trim());
    if (local && LOCAL_COMMANDS.some((c) => c.name === local[1]) && runLocal(local[1], local[2] ?? "")) {
      setText("");
      return;
    }
    // While a turn runs (or others are already waiting), the message joins the queue.
    // A paused queue (after Stop) resumes in order when you send again.
    if (busy) enqueue(chat.id, text, pending);
    else if (queue.length) { enqueue(chat.id, text, pending); sendNext(chat.id); }
    else void send(chat.id, text, pending);
    useChats.getState().patch(chat.id, { pending: [] });
    setText("");
  };
  const paste = (e: React.ClipboardEvent) => {
    const images = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/"));
    if (!images.length) return;
    e.preventDefault();
    for (const f of images) {
      const ext = f.type.split("/")[1]?.replace("jpeg", "jpg") || "png";
      void attachBlob(chat.id, f, f.name && f.name !== "image.png" ? f.name : `pasted.${ext}`).catch((err) => useDesk.getState().toast(`Couldn't attach the image: ${String(err)}`, "error"));
    }
  };
  const browse = async () => {
    const picked = await openDialog({ multiple: true, defaultPath: chat.cwd });
    if (picked) attach(chat.id, Array.isArray(picked) ? picked : [picked]);
    ref.current?.focus();
  };
  const pick = (at: Element, items: MenuItem[]) => openMenu(at, items);

  return (
    <div className="chat-composer-wrap">
      {chat.where && <SandboxStrip chat={chat} />}
      <SandboxHint chat={chat} />
      <div
        className="chat-composer"
        onDragOver={(e) => { if (e.dataTransfer.types.includes("desk/path")) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } }}
        onDrop={(e) => {
          const path = e.dataTransfer.getData("desk/path");
          if (!path) return;
          e.preventDefault();
          attach(chat.id, [path]);
          ref.current?.focus();
        }}
      >
        {slashOpen && (
          <div className="chat-slash" role="listbox" aria-label="Slash commands">
            {commands.map((c, i) => (
              <button key={c.name} role="option" aria-selected={i === pickIndex} className={i === pickIndex ? "is-on" : ""} onMouseEnter={() => setPickIndex(i)} onMouseDown={(e) => { e.preventDefault(); choose(c); }}>
                <span className="chat-slash-name">/{c.name}</span>
                {c.argumentHint && <span className="chat-slash-hint">{c.argumentHint}</span>}
                <span className="chat-slash-desc">{c.description}</span>
              </button>
            ))}
            {chat.tool === "claude" && !commandList(chat).length && <p className="chat-slash-note"><LoaderCircle size={12} className="is-spinning" />Loading Claude Code's commands…</p>}
            {acp && !commandList(chat).length && <p className="chat-slash-note">{TOOL_LABEL[chat.tool]}'s own commands show here once it has started.</p>}
          </div>
        )}
        {queue.length > 0 && (
          <div className="chat-queue" aria-label="Queued messages">
            <div className="chat-queue-head">
              <span>{busy ? `Queued · sends after this turn` : "Queued · paused"}</span>
              {!busy && <button className="text-button" onClick={() => sendNext(chat.id)}>Send next</button>}
            </div>
            {queue.map((q, i) => (
              <div key={q.id} className="chat-queue-row">
                <span className="chat-queue-n">{i + 1}</span>
                <span className="chat-queue-text" title={q.text}>{q.text.trim().split(/\s+/).join(" ") || q.attachments.map((a) => a.name).join(", ")}</span>
                {q.attachments.length > 0 && <span className="chat-queue-files"><Paperclip size={11} />{q.attachments.length}</span>}
                <button className="icon-btn" aria-label="Remove from queue" title="Remove" onClick={() => unqueue(chat.id, q.id)}><X size={12} /></button>
              </div>
            ))}
          </div>
        )}
        {pending.length > 0 && (
          <div className="chat-attachments">
            {pending.map((a) => <AttachmentChip key={a.path} attachment={a} onRemove={() => detach(chat.id, a.path)} />)}
          </div>
        )}
        <textarea
          ref={ref}
          rows={1}
          onPaste={paste}
          value={text}
          placeholder={busy ? `Queue a message for when ${TOOL_LABEL[chat.tool]} finishes…` : `Ask ${TOOL_LABEL[chat.tool]}, or type / for commands`}
          aria-label="Message"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (slashOpen) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                setPickIndex((i) => (i + (e.key === "ArrowDown" ? 1 : -1) + commands.length) % commands.length);
                return;
              }
              if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey) {
                e.preventDefault();
                choose(commands[pickIndex]);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setSlashClosed(true);
                return;
              }
            }
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="chat-composer-row">
          {fresh
            ? <AgentPicker chat={chat} />
            : <span className="chat-chip is-static chat-agent-static" title={TOOL_LABEL[chat.tool]}><ToolGlyph tool={chat.tool} size={14} /><span className="chat-agent-name">{TOOL_SHORT[chat.tool]}</span></span>}
          <button className="chat-chip" disabled={!fresh} title={fresh ? "Account" : `Account: ${account?.name}. A conversation stays with the account it started on.`} onClick={(e) => pick(e.currentTarget, accounts.filter((a) => a.kind === chat.tool).map((a) => ({ label: a.name, checked: a.id === chat.accountId, onSelect: () => setAccount(chat.id, a.id) })))}>
            <UserRound size={12} /><span className="chip-label">{account?.name ?? "Default"}</span>{fresh && <ChevronDown size={11} />}
          </button>
          {showModes && <button className="chat-chip" title={mode.hint} disabled={acp && !modes.length} onClick={(e) => pick(e.currentTarget, modes.map((m) => ({ label: m.label, hint: m.hint, checked: acp ? m.id === (chat.mode || acpMode?.current) : m.id === chat.mode, onSelect: () => setMode(chat.id, m.id) })))}>
            {mode.label}<ChevronDown size={11} />
          </button>}
          <RunInChip chat={chat} fresh={fresh} repo={repo} />
          {fresh && repo && !project?.worktreeOf && !chat.where
            ? <button className="chat-chip" role="switch" aria-checked={!!chat.worktree} title={chat.worktree ? "Your first message creates a branch and worktree for this task, from the latest main. Click to work in the project folder instead." : "Click to give this task its own branch and worktree, so it doesn't touch your project folder."} onClick={() => setWorktree(chat.id, !chat.worktree)}>
                <GitBranch size={12} /><span className="chip-label">{chat.worktree ? "New worktree" : "Project folder"}</span>
              </button>
            : project?.worktreeOf && <span className="chat-chip is-static" title={`Worktree: ${project.path}`}><GitBranch size={12} /><span className="chip-label">{project.branch ?? project.name}</span></span>}
          <button className="chat-chip is-icon" aria-label="Attach files" title="Attach files or images (or paste, or drop them here)" onClick={() => void browse()}><Paperclip size={13} /></button>
          <span className="chat-composer-gap" />
          <button className="chat-chip" disabled={busy} title="Model" onClick={(e) => pick(e.currentTarget, models.map((m) => ({ label: m.label, hint: m.description, checked: m.id === chat.model, onSelect: () => setModel(chat.id, m.id) })))}>
            {model?.label ?? chat.model}<ChevronDown size={11} />
          </button>
          {showEffort && <button className="chat-chip" disabled={busy} title="Effort: how hard the model thinks" onClick={(e) => pick(e.currentTarget, [{ label: "Default effort", checked: !chat.effort, onSelect: () => setEffort(chat.id, "") }, ...efforts.map((x) => ({ label: effortName(x), checked: x === chat.effort, onSelect: () => setEffort(chat.id, x) }))])}>
            <Gauge size={12} /><span className="chip-label">{chat.effort ? effortName(chat.effort) : "Effort"}</span><ChevronDown size={11} />
          </button>}
          {busy && <button className="chat-send is-stop" aria-label="Stop" title="Stop this turn (queued messages wait)" onClick={() => stop(chat.id)}><Square size={11} fill="currentColor" /></button>}
          {(!busy || text.trim() || pending.length > 0) && <button className={"chat-send" + (busy ? " is-queue" : "")} aria-label={busy ? "Queue" : "Send"} title={busy ? "Queue (Enter): sends when this turn finishes" : "Send (Enter)"} disabled={!text.trim() && !pending.length} onClick={submit}><ArrowUp size={15} /></button>}
        </div>
      </div>
      <p className="chat-composer-hint"><Slash size={10} />commands · Enter to {busy ? "queue" : "send"} · Shift+Enter for a new line</p>
    </div>
  );
}

/**
 * Picks the agent for a new chat: a round button that fans the agents out in an arc.
 * Every agent chats here.
 */
function AgentPicker({ chat }: { chat: Chat }) {
  const radial = useRadial();
  const accounts = useDesk((s) => s.accounts);
  const items: RadialItem[] = AGENTS.map((agent) => {
    const set = agent === "claude" || agent === "codex" || accounts.some((a) => a.kind === agent);
    return { key: agent, icon: <ToolLogo tool={agent} size={20} />, label: TOOL_LABEL[agent], sub: set ? "Chat here" : "Not set up yet", on: agent === chat.tool, onSelect: () => setTool(chat.id, agent) };
  });
  return (
    <>
      <button
        className={"chat-agent" + (radial.opened ? " is-open" : "")}
        aria-haspopup="menu"
        aria-expanded={radial.opened}
        aria-label={`Agent: ${TOOL_LABEL[chat.tool]}. Choose another`}
        title={`${TOOL_LABEL[chat.tool]} · choose an agent`}
        onClick={(e) => (radial.opened ? radial.close() : radial.open(e.currentTarget))}
      >
        <span className="chat-agent-icon"><ToolLogo tool={chat.tool} size={15} /></span>
        <span className="chat-agent-plus" aria-hidden="true"><Plus size={10} strokeWidth={3} /></span>
      </button>
      <span className="chat-agent-name">{TOOL_LABEL[chat.tool]}</span>
      {radial.state && <Radial state={radial.state} items={items} label="Choose an agent" onClosed={radial.close} />}
    </>
  );
}

/** Image previews, read once per path. */
const thumbs = new Map<string, Promise<string>>();
function thumb(path: string) {
  if (!thumbs.has(path)) {
    // A few recent previews only: each holds a whole image in memory.
    if (thumbs.size >= 24) thumbs.delete(thumbs.keys().next().value!);
    thumbs.set(path, ipc.attachmentImage(path).then((r) => `data:${r.mediaType};base64,${r.data}`));
  }
  return thumbs.get(path)!;
}

function AttachmentChip({ attachment, onRemove }: { attachment: Attachment; onRemove?: () => void }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    if (!attachment.image || !attachment.path) return;
    let live = true;
    void thumb(attachment.path).then((s) => live && setSrc(s)).catch(() => {});
    return () => { live = false; };
  }, [attachment.path, attachment.image]);
  return (
    <span className={"chat-attachment" + (src ? " has-thumb" : "")} title={attachment.path || attachment.name}>
      {src ? <img src={src} alt="" /> : attachment.image ? <ImageIcon size={13} /> : <FileText size={13} />}
      <span className="chat-attachment-name">{attachment.name}</span>
      {onRemove && <button aria-label={`Remove ${attachment.name}`} onClick={onRemove}><X size={11} /></button>}
    </span>
  );
}

// Markdown lives in ../markdown (the phone page uses it too); links open Desk's way here.
function Markdown({ text }: { text: string }) {
  return <SharedMarkdown text={text} link={Link} />;
}

function Link({ href, children }: { href: string; children: React.ReactNode }) {
  const web = /^https?:\/\//.test(href);
  // Local servers open in Desk's browser (⌘-click for your own); everything else in your browser.
  const local = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?(\/|$)/.test(href);
  return <a href={web ? href : undefined} title={local ? `${href}\nOpens in Desk's browser. ⌘-click for your own.` : href} onClick={(e) => { e.preventDefault(); if (local && !e.metaKey) openBrowser(href); else if (web) void ipc.openExternal(href); }}>{children}</a>;
}
