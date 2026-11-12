// A chat that runs in a sandbox: getting the sandbox ready, sending the code
// there on the first message, and bringing the work back.

import { addWorktreeProject, branchSlug, rootProject } from "../actions";
import { reattachChat, restoreChat, updateItems, useChats, type Chat } from "../chat";
import { ipc } from "../ipc";
import { useDesk } from "../store";
import { TOKEN_VAR, ensureRunning, provider, tokenKey } from "./index";
import { pullOut, syncIn } from "./sync";
import { remoteRuns, sandboxExec, type RemoteTarget } from "./transport";
import { provider as providerOf } from "./providers";
import { q } from "./types";
import { run } from "./index";

const NOTICE = "sandbox";

function sandboxOf(chatId: string) {
  const chat = useChats.getState().chats[chatId];
  if (!chat?.where) return null;
  const sandbox = useDesk.getState().sandboxes.find((x) => x.id === chat.where);
  if (!sandbox) throw new Error("This chat's sandbox was removed. Start a new chat to pick another.");
  return { chat, sandbox };
}

function progress(chatId: string, text: string) {
  updateItems(chatId, (items) => [...items.filter((i) => i.id !== NOTICE), ...(text ? [{ kind: "notice" as const, id: NOTICE, text }] : [])]);
}

/** Wakes the sandbox and, on the first message, sends the code and makes a worktree there. */
export async function prepareRemote(chatId: string, text: string) {
  const found = sandboxOf(chatId);
  if (!found) return;
  const { chat } = found;
  const say = (t: string) => progress(chatId, t);
  try {
    say("Starting the sandbox…");
    const sandbox = await ensureRunning(found.sandbox, say);
    if (chat.remote) return;
    const project = useDesk.getState().projects.find((p) => p.id === chat.projectId);
    if (!project) throw new Error("This chat's project was removed.");
    const slug = chat.branchHint ? branchSlug(chat.branchHint) : branchSlug(text.split(/\s+/).slice(0, 6).join(" ").replace(/\//g, " ")).slice(0, 40).replace(/[-.]+$/, "") || "task";
    const work = await syncIn(sandbox, rootProject(project).path, `${slug}-${Date.now().toString(36).slice(-4)}`, say);
    useChats.getState().patch(chatId, { remote: work, cwd: work.cwd, worktree: false });
    const label = provider(sandbox.provider)?.label ?? sandbox.provider;
    say("");
    updateItems(chatId, (items) => [...items, { kind: "notice", id: `sb-${Date.now()}`, text: `Working in ${label} (${sandbox.name}) on ${work.branch}, from ${work.base}. Pull changes brings it home.` }]);
  } finally {
    say("");
  }
}

/** Where the chat's agent runs, for the transport. Null means this Mac. */
export async function remoteTarget(chatId: string): Promise<RemoteTarget | null> {
  const found = sandboxOf(chatId);
  if (!found?.chat.remote) return null;
  const { chat, sandbox } = found;
  const remote = chat.remote!;
  const name = TOKEN_VAR[chat.tool];
  const key = tokenKey(chat.accountId);
  const secrets = name && (await ipc.sandboxSecretHas(key).catch(() => false)) ? [{ name, key }] : [];
  return {
    sandbox,
    cwd: remote.cwd,
    secrets,
    onRun: (runId) => useChats.getState().patch(chatId, { runId }),
  };
}

/** Brings the sandbox's branch home as a local worktree, with its uncommitted changes. */
export async function pullChanges(chatId: string) {
  const found = sandboxOf(chatId);
  if (!found?.chat.remote) throw new Error("Nothing to pull yet: send a message first.");
  const { chat, sandbox } = found;
  const remote = found.chat.remote!;
  const desk = useDesk.getState();
  const project = desk.projects.find((p) => p.id === chat.projectId);
  if (!project) throw new Error("This chat's project was removed.");
  const parent = rootProject(project);
  const pulled = await pullOut(sandbox, parent.path, remote, (branch) => ipc.gitWorktreePath(parent.path, branch));
  if (!useDesk.getState().projects.some((p) => p.path === pulled.path)) {
    addWorktreeProject(parent, pulled.path, pulled.branch, remote.base);
  }
  return pulled;
}

// Sandbox chats outlive Desk: the agent keeps going there, so Desk remembers the
// chat (its messages and the last line it read) and follows it again on start.

const SAVED_KEY = "desk.sandboxChats";
const KEEP_ITEMS = 400;

interface SavedChat { chat: Chat; line: number }

function readSaved(): SavedChat[] {
  try { const list = JSON.parse(localStorage.getItem(SAVED_KEY) ?? "[]"); return Array.isArray(list) ? list : []; } catch { return []; }
}

function save() {
  const lines = new Map(remoteRuns().map((r) => [r.proc, r.line]));
  const list: SavedChat[] = Object.values(useChats.getState().chats)
    .filter((c) => c.where && c.remote)
    .map((c) => ({
      chat: { ...c, items: c.items.slice(-KEEP_ITEMS), proc: null, status: "idle", loading: false, startedAt: null, stopping: false, pending: undefined, queue: undefined, draft: undefined },
      line: c.proc != null ? lines.get(c.proc) ?? 0 : 0,
    }));
  try { localStorage.setItem(SAVED_KEY, JSON.stringify(list)); } catch { /* Too big: the agent still runs; only the replay is lost. */ }
}

async function restore(saved: SavedChat) {
  const { chat, line } = saved;
  const desk = useDesk.getState();
  const sandbox = desk.sandboxes.find((x) => x.id === chat.where);
  if (!sandbox || !desk.projects.some((p) => p.id === chat.projectId)) return;
  restoreChat({ ...chat, truncated: chat.items.length >= KEEP_ITEMS });
  if (!chat.runId) return;
  const p = providerOf(sandbox.provider);
  const up = p && (await p.status(run, sandbox.remoteId).catch(() => "missing")) === "running";
  const label = p?.label ?? sandbox.provider;
  const attached = up && (await reattachChat(chat.id, line).catch(() => false));
  if (!attached) {
    // An agent Desk can't follow again would run on unseen; end it.
    if (up) void sandboxExec(sandbox, `"$HOME/.desk/bin/desk-run" stop ${q(chat.runId)}`).catch(() => {});
    useChats.getState().patch(chat.id, { runId: null });
    const text = up
      ? `This agent was running in ${label} (${sandbox.name}) when Desk closed. Send a message to carry on.`
      : `${label} (${sandbox.name}) is stopped. Send a message to wake it and carry on.`;
    updateItems(chat.id, (items) => [...items, { kind: "notice", id: `sb-restore-${Date.now()}`, text }]);
  }
}

/** Restores sandbox chats once Desk has loaded, then keeps the saved copy current. */
export function watchSandboxChats() {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let unsub = () => {};
  const flush = () => { if (timer) { clearTimeout(timer); timer = null; } save(); };
  const begin = () => {
    for (const saved of readSaved()) void restore(saved);
    unsub = useChats.subscribe(() => { if (!timer) timer = setTimeout(() => { timer = null; save(); }, 1000); });
    window.addEventListener("beforeunload", flush);
  };
  let unloaded = () => {};
  if (useDesk.getState().loaded) begin();
  else unloaded = useDesk.subscribe((s) => { if (s.loaded) { unloaded(); begin(); } });
  return () => { unloaded(); unsub(); window.removeEventListener("beforeunload", flush); flush(); };
}
