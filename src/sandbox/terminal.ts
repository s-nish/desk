// An agent in a terminal tab, running in a sandbox. The code goes there the way
// it does for a chat (a git bundle, then a worktree on a new branch); the tab
// runs the agent inside tmux there, so closing Desk (or the lid, in a cloud
// sandbox) leaves it working, and reopening the tab picks the same session up.

import { openTerminal, rootProject } from "../actions";
import { ipc } from "../ipc";
import { TOOL_LABEL, projectAccount, useDesk } from "../store";
import type { SessionSpec } from "../terminals";
import type { Agent, TerminalTab } from "../types";
import { TOKEN_VAR, createSandbox, ensureRunning, provider, runStartScripts, tokenKey, useSandboxes } from "./index";
import { syncIn } from "./sync";
import { sandboxExec } from "./transport";
import { q, type ProviderId, type Sandbox } from "./types";
import { defaultSandboxMode, readyBridge } from "./bridge";

/** Agents the sandbox image has. */
export const SANDBOX_TERMINAL_AGENTS: Agent[] = ["claude", "codex"];

/** Providers that can run an interactive agent in a tab. */
export const canRunTerminal = (id: ProviderId) => !!provider(id)?.tty;

const session = (tabId: string) => `desk-${tabId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40)}`;

/**
 * Opens an agent tab in a sandbox: `where` is an existing sandbox's id, or a
 * provider to make a new one with.
 */
export async function openSandboxTerminal(projectId: string, tool: Agent, where: { sandboxId: string } | { provider: ProviderId }) {
  const desk = useDesk.getState();
  const project = desk.projects.find((p) => p.id === projectId);
  if (!project) return;
  const root = rootProject(project);
  // One progress line per tab being opened, so several can be on their way at once.
  const key = `term:|${root.id}|${tool}|${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const say = (text: string) => useSandboxes.getState().set({ progress: { [key]: text } });
  try {
    let sandbox: Sandbox | undefined = "sandboxId" in where ? desk.sandboxes.find((x) => x.id === where.sandboxId) : undefined;
    if ("provider" in where) sandbox = await createSandbox(root.id, where.provider, key);
    if (!sandbox) throw new Error("That sandbox was removed.");
    if (defaultSandboxMode() === "code") {
      // The agent runs in a tab here; desk-sandbox sends the code there when it builds or runs something.
      await readyBridge(sandbox, root, say);
      openTerminal(projectId, tool, { codeSandbox: sandbox.id });
      return;
    }
    say("Starting the sandbox…");
    sandbox = await ensureRunning(sandbox, say);
    const slug = `${tool}-${Date.now().toString(36).slice(-5)}`;
    const work = await syncIn(sandbox, root.path, slug, say);
    const failed = await runStartScripts(sandbox, work.cwd, root.id, say);
    if (failed) desk.toast(`Your start script failed; ${TOOL_LABEL[tool]} starts anyway. ${failed.split("\n").slice(-1)[0]}`, "error");
    openTerminal(projectId, tool, { sandboxId: sandbox.id, remote: { cwd: work.cwd, branch: work.branch, base: work.base } });
  } catch (e) {
    useDesk.getState().toast(e instanceof Error ? e.message : String(e), "error");
  } finally {
    useSandboxes.setState((s) => { const progress = { ...s.progress }; delete progress[key]; return { progress }; });
  }
}

/** The account folder an agent uses there: ~/.desk/accounts/<name>, as chats do. */
function accountVar(tab: TerminalTab) {
  const s = useDesk.getState();
  const project = s.projects.find((p) => p.id === tab.projectId);
  const kind = tab.tool as Agent;
  const account = s.accounts.find((a) => a.id === tab.accountId) ?? projectAccount(s.accounts, project, kind);
  const folder = account?.dir ? account.dir.replace(/\/+$/, "").split("/").pop()!.replace(/^\.+/, "") : null;
  if (!folder) return { account, line: "" };
  const name = kind === "codex" ? "CODEX_HOME" : kind === "claude" ? "CLAUDE_CONFIG_DIR" : null;
  return { account, line: name ? `export ${name}="$HOME/.desk/accounts/${folder.replace(/[^A-Za-z0-9._-]/g, "-")}"` : "" };
}

/** The command a sandbox tab runs: tmux there, attaching to its session or starting it. */
export async function sandboxTerminalSpec(tab: TerminalTab): Promise<SessionSpec> {
  const fail = (text: string): SessionSpec => ({ cwd: "/", command: `printf '%s\\n' ${q(text)}; exit 1`, env: {}, unset: [], keepShell: false });
  const desk = useDesk.getState();
  let sandbox = desk.sandboxes.find((x) => x.id === tab.sandboxId);
  const p = sandbox && provider(sandbox.provider);
  if (!sandbox || !p?.tty || !tab.remote) return fail("This tab's sandbox was removed. Open a new tab to pick another.");
  const project = desk.projects.find((x) => x.id === tab.projectId);
  const home = project?.path ?? "/";
  try {
    sandbox = await ensureRunning(sandbox, () => {});
  } catch (e) {
    return fail(`Couldn't start ${p.label} (${sandbox.name}): ${e instanceof Error ? e.message : String(e)}`);
  }
  const name = session(tab.id);
  const secretFile = `"$HOME/.desk/tty-${name}.env"`;
  // A token you pasted goes up on stdin into an owner-only file the session reads once.
  const { account, line: accountLine } = accountVar(tab);
  const variable = TOKEN_VAR[tab.tool];
  if (variable && account && (await ipc.sandboxSecretHas(tokenKey(account.id)).catch(() => false))) {
    await ipc.sandboxRun(await p.exec(sandbox.remoteId, `umask 077; mkdir -p "$HOME/.desk"; cat > ${secretFile}`), { secrets: [{ name: variable, key: tokenKey(account.id) }], timeoutSecs: 60 }).catch(() => null);
  }
  const agent = tab.tool === "shell" ? "${SHELL:-bash} -l" : tab.tool;
  const inner = [
    `f=${secretFile}`,
    'if [ -f "$f" ]; then while IFS= read -r l || [ -n "$l" ]; do case "$l" in [A-Za-z_]*=*) export "$l" ;; esac; done < "$f"; rm -f "$f"; fi',
    accountLine,
    `cd ${q(tab.remote.cwd)} || exit 1`,
    `exec ${agent}`,
  ].filter(Boolean).join("\n");
  const outer = [
    `if command -v tmux >/dev/null 2>&1; then`,
    `  tmux has-session -t ${name} 2>/dev/null && exec tmux attach -t ${name}`,
    `  exec tmux new-session -s ${name} sh -lc ${q(inner)}`,
    `fi`,
    `printf '%s\\n\\n' 'tmux is not in this sandbox, so the agent stops when this tab closes.'`,
    inner,
  ].join("\n");
  return { cwd: home, command: p.tty(sandbox.remoteId, outer), env: {}, unset: [], keepShell: false };
}

/** Ends the tab's agent in the sandbox (closing the tab means you're done with it). */
export function endSandboxTerminal(tab: TerminalTab) {
  const sandbox = useDesk.getState().sandboxes.find((x) => x.id === tab.sandboxId);
  if (!sandbox) return;
  void sandboxExec(sandbox, `tmux kill-session -t ${session(tab.id)} 2>/dev/null; rm -f "$HOME/.desk/tty-${session(tab.id)}.env"; true`).catch(() => {});
}
