// A chat that runs in a sandbox: getting the sandbox ready, sending the code
// there on the first message, and bringing the work back.

import { addWorktreeProject, branchSlug, rootProject } from "../actions";
import { updateItems, useChats } from "../chat";
import { ipc } from "../ipc";
import { useDesk } from "../store";
import { TOKEN_VAR, ensureRunning, provider, tokenKey } from "./index";
import { pullOut, syncIn } from "./sync";
import type { RemoteTarget } from "./transport";

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
