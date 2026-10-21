// User-level operations that touch both the store and the terminal/editor registries.

import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { ipc, errorText } from "./ipc";
import { ACCOUNT_COLORS, TOOL_LABEL, accountId, projectAccount, sessionEnv, uid, useDesk, focusedTabId } from "./store";
import { disposeTerminal } from "./terminals";
import { disposeEditor, focusEditor, handleDiskChanges, openEditor, saveEditor, revealEditorLine } from "./editors";
import { useTree } from "./tree";
import type { Account, AgentSession, FileTab, Project, SshConnection, TabTool, TerminalTab, Tool, Worktree } from "./types";
import type { DropZone } from "./store";
import type { SessionSpec } from "./terminals";

const COMMAND: Record<TabTool, string | null> = { claude: "claude", codex: "codex", shell: null };
const SIGN_IN_COMMAND: Record<Tool, string> = { claude: "claude", codex: "codex login" };

const desk = () => useDesk.getState();

export function activeProject() {
  const s = desk();
  return s.projects.find((p) => p.id === s.activeProjectId);
}

export function activeTab() {
  const s = desk();
  return s.tabs.find((t) => t.id === focusedTabId(s));
}

// Terminals

export function openTerminal(projectId: string, tool: TabTool, opts: { accountId?: string; cwd?: string; sshId?: string; sessionId?: string; resume?: string; command?: string } = {}) {
  const s = desk();
  const project = s.projects.find((p) => p.id === projectId);
  if (!project) return;
  const tab: TerminalTab = {
    id: uid(),
    projectId,
    type: "terminal",
    tool,
    accountId: tool === "shell" ? null : (opts.accountId ?? null),
    ...(opts.sshId ? { sshId: opts.sshId } : {}),
    // Each Claude Code tab gets its own conversation id up front, so the tab can
    // pick the same conversation back up after Desk quits.
    ...(tool === "claude" ? { sessionId: opts.sessionId ?? uid() } : {}),
    ...(tool === "codex" && opts.resume ? { resume: opts.resume } : {}),
    ...(tool === "shell" && opts.command ? { command: opts.command } : {}),
    cwd: opts.cwd ?? project.path,
    title: "",
    status: "starting",
    exitCode: null,
    activity: false,
  };
  s.addTab(tab);
  return tab.id;
}

const SAFE_ID = /^[0-9a-zA-Z-]{8,64}$/;

/** Re-reads accounts at spawn time so restarts use the current folder for that account. */
export async function terminalSpec(tabId: string): Promise<SessionSpec> {
  const s = desk();
  const tab = s.tabs.find((t) => t.id === tabId) as TerminalTab | undefined;
  const project = s.projects.find((p) => p.id === tab?.projectId);
  if (!tab) return { cwd: "/", command: null, env: {}, unset: [] };
  // Resolved fresh at every spawn (a restart picks up a changed project account)
  // and recorded, so the tab keeps showing what this session really runs as.
  const resolve = (kind: Tool) =>
    s.accounts.find((a) => tab.tool === kind && a.id === tab.accountId) ?? projectAccount(s.accounts, project, kind);
  const overrides = { claude: resolve("claude"), codex: resolve("codex") };
  s.patchTab(tabId, { runAs: { claude: overrides.claude.id, codex: overrides.codex.id } });
  const env = sessionEnv(s.accounts, project, overrides);
  const claude = tab.tool === "claude" && !tab.sshId ? await claudeCommand(overrides.claude.dir, tab.cwd, env.env) : "claude";
  if (tab.sshId) {
    const connection = s.connections.find((c) => c.id === tab.sshId);
    // The session ends with the command, so Enter reconnects (and fills the password again).
    if (!connection) return { cwd: tab.cwd, command: "printf '%s\\n' 'This saved connection was deleted from Desk.'; exit 1", keepShell: false, ...env };
    return { cwd: tab.cwd, command: connection.command, ssh: connection.password ? connection.id : null, keepShell: false, ...env };
  }
  if (tab.tool === "claude" && tab.sessionId && SAFE_ID.test(tab.sessionId)) {
    // Resume the tab's conversation once Claude Code has saved it; until then, start it under that id.
    const state = await ipc.claudeSessionState(overrides.claude.dir, tab.cwd, tab.sessionId).catch(() => "missing" as const);
    if (state === "resumable") return { cwd: tab.cwd, command: `${claude} --resume ${tab.sessionId}`, ...env };
    // A transcript with nothing typed into it can't be resumed or reused: start over under a new id.
    const id = state === "empty" ? uid() : tab.sessionId;
    if (id !== tab.sessionId) s.patchTab(tabId, { sessionId: id });
    return { cwd: tab.cwd, command: `${claude} --session-id ${id}`, ...env };
  }
  if (tab.tool === "codex" && tab.resume && SAFE_ID.test(tab.resume)) {
    return { cwd: tab.cwd, command: `codex resume ${tab.resume}`, ...env };
  }
  if (tab.tool === "shell" && tab.command) {
    // Runs once; restarting the tab gives a plain shell.
    s.patchTab(tabId, { command: undefined });
    return { cwd: tab.cwd, command: tab.command, ...env };
  }
  return { cwd: tab.cwd, command: tab.tool === "claude" ? claude : COMMAND[tab.tool], ...env };
}

/**
 * `claude`, plus Desk's status line wrapper so the tab reports its usage limits.
 * Adds the wrapper's variables to `env`. Falls back to plain `claude` on any error.
 */
async function claudeCommand(dir: string | null, cwd: string, env: Record<string, string>) {
  if (!desk().preferences.usageLimits) return "claude";
  try {
    const hook = await ipc.claudeLimitsHook(dir, cwd);
    Object.assign(env, hook.env);
    return `claude --settings '${hook.settings.replace(/'/g, "'\\''")}'`;
  } catch (e) {
    console.warn("usage limits unavailable", e);
    return "claude";
  }
}

// Usage limits

let readingLimits = false;

/** Re-reads every account's usage limits. Cheap: a few small files per account. */
export async function refreshLimits() {
  if (readingLimits) return;
  readingLimits = true;
  try {
    const { claude, codex } = accountDirs();
    desk().setLimits(await ipc.usageLimits(claude, codex));
  } catch (e) {
    console.warn("usage limits", e);
  } finally {
    readingLimits = false;
  }
}

/** Restarts a restored Claude Code tab as a new conversation instead of resuming. */
export function startFresh(tabId: string) {
  desk().patchTab(tabId, { sessionId: uid(), resume: undefined, restored: false, status: "starting" });
}

// Waiting agents

/** Marks a tab as waiting when you can't see it (another tab, or Desk in the background). */
export function markAttention(tabId: string, reason: string, visible: boolean) {
  const s = desk();
  const tab = s.tabs.find((t) => t.id === tabId);
  if (!s.preferences.agentAlerts || !tab || tab.type !== "terminal" || tab.tool === "shell") return;
  if (visible && document.hasFocus()) return;
  if (tab.attention === reason) return;
  s.patchTab(tabId, { attention: reason });
  const project = s.projects.find((p) => p.id === tab.projectId);
  if (document.hasFocus()) {
    s.toast(`${TOOL_LABEL[tab.tool]} in ${project?.name ?? "a project"}: ${reason.toLowerCase()}.`, "info", { label: "Show", run: () => desk().selectTab(tabId) });
  }
}

/** Shows the next tab that's waiting for you, after the current one. */
export function jumpToWaiting() {
  const s = desk();
  const waiting = s.tabs.filter((t) => t.type === "terminal" && t.attention);
  if (!waiting.length) {
    s.toast("No agents are waiting for you.");
    return;
  }
  const current = s.tabs.findIndex((t) => t.id === focusedTabId(s));
  const next = waiting.find((t) => s.tabs.indexOf(t) > current) ?? waiting[0];
  s.selectTab(next.id);
}

// Past conversations

/** The project a folder belongs to, preferring the deepest match (a worktree over its repo). */
export function projectForPath(path: string): Project | undefined {
  return desk()
    .projects.filter((p) => path === p.path || path.startsWith(p.path + "/"))
    .sort((a, b) => b.path.length - a.path.length)[0];
}

/** Opens a past conversation in a new tab, or shows the tab already running it. */
export function resumeSession(session: AgentSession, fallbackProjectId: string) {
  const s = desk();
  const open = s.tabs.find((t) => t.type === "terminal" && (t.sessionId === session.id || t.resume === session.id) && t.status !== "exited");
  if (open) {
    s.selectTab(open.id);
    return;
  }
  const project = projectForPath(session.cwd) ?? s.projects.find((p) => p.id === fallbackProjectId);
  if (!project) return;
  const account = s.accounts.find((a) => a.kind === session.tool && a.dir === session.dir);
  return openTerminal(project.id, session.tool, {
    accountId: account?.id,
    cwd: session.cwd,
    ...(session.tool === "claude" ? { sessionId: session.id } : { resume: session.id }),
  });
}

/** Every Claude Code and Codex account folder, for listing past conversations. */
export function accountDirs() {
  const accounts = desk().accounts;
  const dirs = (kind: Tool) => [...new Set(accounts.filter((a) => a.kind === kind).map((a) => a.dir))];
  return { claude: dirs("claude"), codex: dirs("codex") };
}

// Split panes

/** Shows `tabId` next to the focused tab. Left/top puts it first; the middle replaces the focused pane. */
export function openInSplit(tabId: string, zone: DropZone) {
  const s = desk();
  const tab = s.tabs.find((t) => t.id === tabId);
  if (!tab) return;
  if (zone === "center") {
    s.selectTab(tabId);
    return;
  }
  const focused = focusedTabId(s);
  const partner = focused && focused !== tabId ? focused : (s.activeTabId !== tabId ? s.activeTabId : s.secondaryTabId) ?? s.tabs.find((t) => t.id !== tabId)?.id;
  if (!partner || partner === tabId) {
    s.toast("Open another tab to split the workspace.");
    return;
  }
  const first = zone === "left" || zone === "top";
  useDesk.setState((st) => ({
    activeTabId: first ? tabId : partner,
    secondaryTabId: first ? partner : tabId,
    focusedPane: first ? "primary" : "secondary",
    activeProjectId: tab.projectId,
    layout: { ...st.layout, splitDir: zone === "left" || zone === "right" ? "row" : "column" },
    tabs: st.tabs.map((t) => (t.id === tabId && t.type === "terminal" ? { ...t, activity: false, attention: null } : t)),
  }));
}

export function swapPanes() {
  useDesk.setState((s) => (s.secondaryTabId && s.activeTabId ? { activeTabId: s.secondaryTabId, secondaryTabId: s.activeTabId, focusedPane: s.focusedPane === "primary" ? "secondary" : "primary" } : {}));
}

export function flipSplit() {
  const s = desk();
  s.setLayout({ splitDir: s.layout.splitDir === "row" ? "column" : "row" });
}

export function closeOtherTabs(tabId: string, which: "others" | "right") {
  const s = desk();
  const at = s.tabs.findIndex((t) => t.id === tabId);
  for (const t of s.tabs.filter((t, i) => t.id !== tabId && (which === "others" || i > at))) closeTab(t.id);
}

// Worktrees

/** Lowercase words joined by dashes, for a branch name typed as a sentence. */
export function branchSlug(text: string) {
  return text.trim().toLowerCase().replace(/[^a-z0-9._/-]+/g, "-").replace(/-{2,}/g, "-").replace(/^[-./]+|[-./]+$/g, "");
}

/** The repository's own project when given one of its worktrees. */
export function rootProject(project: Project) {
  return (project.worktreeOf && desk().projects.find((p) => p.id === project.worktreeOf)) || project;
}

/** Adds a worktree folder as a project nested under its repository, sharing its accounts. */
export function addWorktreeProject(parent: Project, path: string, branch: string | null, base?: string) {
  const id = desk().addProject(path, {
    name: branch ?? path.split("/").pop() ?? path,
    worktreeOf: parent.id,
    branch: branch ?? undefined,
    base,
    claudeAccountId: parent.claudeAccountId,
    codexAccountId: parent.codexAccountId,
    claudeChosen: true,
    codexChosen: true,
  });
  void watchProject(id);
  return id;
}

export async function createWorktree(parentId: string, branch: string, base: string, tool: TabTool | null) {
  const parent = desk().projects.find((p) => p.id === parentId);
  if (!parent) throw new Error("The project was removed.");
  const path = await ipc.gitWorktreeAdd(parent.path, branch, base);
  const id = addWorktreeProject(parent, path, branch, base);
  if (tool) openTerminal(id, tool);
  return id;
}

/** Worktrees git knows about that aren't in Desk yet. */
export async function untrackedWorktrees(project: Project): Promise<Worktree[]> {
  const list = await ipc.gitWorktrees(project.path);
  const known = new Set(desk().projects.map((p) => p.path));
  return list.filter((w) => !w.main && !w.prunable && !known.has(w.path));
}

/** Opens a shell in the repository with the merge running, so conflicts can be fixed right there. */
export function mergeWorktree(project: Project) {
  const parent = rootProject(project);
  if (parent === project || !project.branch) return;
  const into = project.base ?? desk().branches[parent.id] ?? "the current branch";
  const switches = !!project.base && project.base !== desk().branches[parent.id];
  desk().setModal({
    kind: "confirm",
    title: `Merge ${project.branch} into ${into}?`,
    body: `Desk opens a shell in ${parent.name} and runs git merge ${project.branch} there.${switches ? ` It first switches ${parent.name} to ${project.base}.` : ""} Commit your work in the worktree first. If there are conflicts, resolve them in that shell.`,
    confirm: "Open merge",
    onConfirm: () => {
      openTerminal(parent.id, "shell", { command: `${switches ? `git switch ${shellWord(project.base!)} && ` : ""}git merge --no-ff --no-edit ${shellWord(project.branch!)}` });
    },
  });
}

function shellWord(word: string) {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/** Removes the worktree folder (asking first if it has uncommitted work) and, optionally, its branch. */
export function removeWorktree(project: Project) {
  const parent = rootProject(project);
  if (parent === project) return;
  const s = desk();
  const run = async (force: boolean) => {
    // Stop anything running in the folder before deleting it.
    for (const t of desk().tabs.filter((t) => t.projectId === project.id && t.type === "terminal")) {
      disposeTerminal(t.id);
      desk().patchTab(t.id, { status: "exited", restored: true, busy: false });
    }
    try {
      await ipc.gitWorktreeRemove(parent.path, project.path, force);
    } catch (e) {
      const text = errorText(e);
      if (!force && /modified or untracked|--force/i.test(text)) {
        desk().setModal({
          kind: "confirm",
          title: `${project.name} has uncommitted work`,
          body: "Its changed and new files are deleted with the folder. Commit or copy anything you want to keep first.",
          confirm: "Delete anyway",
          danger: true,
          onConfirm: () => void run(true),
        });
      } else desk().toast(`Couldn't remove the worktree: ${text}`, "error");
      return;
    }
    forgetProject(project.id);
    if (!project.branch) return;
    try {
      await ipc.gitBranchDelete(parent.path, project.branch);
      desk().toast(`Removed ${project.name} and its branch.`);
    } catch {
      desk().toast(`Removed the ${project.name} worktree. Its branch is kept because it has commits that aren't merged.`);
    }
  };
  s.setModal({
    kind: "confirm",
    title: `Remove the ${project.name} worktree?`,
    body: `Deletes the folder ${project.path}. The branch ${project.branch ?? ""} is deleted too if it's fully merged, and kept otherwise. Running terminals in it are stopped.`,
    confirm: "Remove worktree",
    danger: true,
    onConfirm: () => void run(false),
  });
}

/** Drops a project and its tabs from Desk without asking. Folders stay on disk. */
function forgetProject(projectId: string) {
  const project = desk().projects.find((p) => p.id === projectId);
  if (!project) return;
  for (const t of desk().tabs.filter((t) => t.projectId === projectId)) {
    disposeTerminal(t.id);
    disposeEditor(t.id);
  }
  void ipc.unwatch(project.path);
  desk().removeProject(projectId);
}

/** Worktrees deleted outside Desk disappear from the sidebar. */
export async function pruneWorktrees() {
  for (const p of desk().projects.filter((p) => p.worktreeOf)) {
    if (!(await ipc.pathExists(p.path).catch(() => true))) forgetProject(p.id);
  }
}

// Saved connections

export interface SshSummary { user: string | null; host: string | null; port: string | null; forwards: string[]; jump: string | null }

/** Reads the parts of an ssh command worth showing. Non-ssh commands give nulls. */
export function parseSsh(command: string): SshSummary {
  const out: SshSummary = { user: null, host: null, port: null, forwards: [], jump: null };
  const words = command.match(/"[^"]*"|'[^']*'|\S+/g)?.map((w) => w.replace(/^["']|["']$/g, "")) ?? [];
  const at = words.findIndex((w) => w === "ssh" || w.endsWith("/ssh"));
  if (at < 0) return out;
  const withValue = new Set("BbcDEeFIiJLlmOoPpQRSWw".split(""));
  for (let i = at + 1; i < words.length; i++) {
    const w = words[i];
    if (w.startsWith("-") && w.length > 1) {
      // Flags can be grouped (-NfL 8080:...); the first one taking a value ends the group.
      for (let j = 1; j < w.length; j++) {
        const flag = w[j];
        if (!withValue.has(flag)) continue;
        const value = w.slice(j + 1) || words[++i] || "";
        if (flag === "L" || flag === "R") out.forwards.push(`${flag === "L" ? "Local" : "Remote"} ${value}`);
        else if (flag === "D") out.forwards.push(`SOCKS ${value}`);
        else if (flag === "p") out.port = value;
        else if (flag === "l") out.user = value;
        else if (flag === "J") out.jump = value;
        break;
      }
      continue;
    }
    const dest = w.replace(/^ssh:\/\//, "");
    const m = dest.match(/^(?:([^@]+)@)?([^:/]+)(?::(\d+))?/);
    if (m) {
      out.user = m[1] ?? out.user;
      out.host = m[2];
      out.port = m[3] ?? out.port;
    }
    break;
  }
  return out;
}

export function connectionLabel(c: Pick<SshConnection, "command">) {
  const p = parseSsh(c.command);
  return p.host ? `${p.user ? p.user + "@" : ""}${p.host}` : c.command.trim().split(/\s+/).slice(0, 3).join(" ");
}

/** Opens a saved connection in a new tab, in its project or the selected one. */
export function openConnection(id: string) {
  const s = desk();
  const connection = s.connections.find((c) => c.id === id);
  if (!connection) return;
  const project = s.projects.find((p) => p.id === connection.projectId) ?? activeProject() ?? s.projects[0];
  if (!project) {
    s.toast("Add a project folder first. Connections open as tabs inside a project.", "error");
    return;
  }
  return openTerminal(project.id, "shell", { sshId: id });
}

/** Saves the connection; a non-empty `password` replaces the saved one, null removes it. */
export async function saveConnection(connection: SshConnection, password: string | null | undefined) {
  if (password) await ipc.sshSavePassword(connection.id, password);
  else if (password === null) await ipc.sshForgetPassword(connection.id);
  const saved = password ? true : password === null ? false : connection.password;
  desk().saveConnection({ ...connection, password: saved });
}

export function deleteConnection(connection: SshConnection) {
  desk().setModal({
    kind: "confirm",
    title: `Delete ${connection.name}?`,
    body: "The saved command and password are removed from Desk. Tabs already connected stay open until you close them.",
    confirm: "Delete",
    danger: true,
    onConfirm: () => {
      void ipc.sshForgetPassword(connection.id).catch(() => {});
      desk().removeConnection(connection.id);
    },
  });
}

/** Keeps each connection's "password saved" flag in step with the files on disk. */
export async function syncConnectionPasswords() {
  for (const c of desk().connections) {
    const has = await ipc.sshHasPassword(c.id).catch(() => c.password);
    if (has !== c.password) desk().saveConnection({ ...c, password: has });
  }
}

export function signInSpec(account: Account): SessionSpec {
  const s = desk();
  const cwd = activeProject()?.path ?? s.identities[account.id]?.path ?? "/";
  return {
    cwd,
    command: SIGN_IN_COMMAND[account.kind],
    ...sessionEnv(s.accounts, activeProject(), { [account.kind]: account }),
  };
}

// Files

export async function openFile(projectId: string, path: string, line?: number) {
  const s = desk();
  const existing = s.tabs.find((t) => t.type === "file" && t.path === path && t.projectId === projectId);
  if (existing) {
    s.selectTab(existing.id);
    if (line) revealEditorLine(existing.id, line);
    else focusEditor(existing.id);
    return;
  }
  const tab: FileTab = {
    id: uid(),
    projectId,
    type: "file",
    path,
    title: path.split("/").pop() ?? path,
    dirty: false,
    conflict: false,
    ready: false,
    error: null,
  };
  s.addTab(tab);
  try {
    await openEditor(tab.id, path, {
      onDirty: (dirty) => desk().patchTab(tab.id, { dirty }),
      onConflict: (conflict) => desk().patchTab(tab.id, { conflict }),
      onRecovery: (recovery) => desk().patchTab(tab.id, { recovery }),
    });
    desk().patchTab(tab.id, { ready: true, error: null });
    if (line) revealEditorLine(tab.id, line);
    else focusEditor(tab.id);
  } catch (e) {
    desk().patchTab(tab.id, { error: errorText(e) });
  }
}

export async function saveTab(tabId: string, overwrite = false) {
  const tab = desk().tabs.find((t) => t.id === tabId);
  if (!tab || tab.type !== "file" || tab.error) return true;
  if (tab.conflict && !overwrite) {
    desk().setModal({ kind: "confirm", title: "Overwrite the disk version?", body: `${tab.title} changed outside Desk. Save your recovered or edited version over the current file?`, confirm: "Overwrite", danger: true, onConfirm: () => void saveTab(tabId, true) });
    return false;
  }
  try {
    await saveEditor(tabId);
    return true;
  } catch (e) {
    desk().toast(`Couldn't save ${tab.title}: ${errorText(e)}`, "error");
    return false;
  }
}

function disposeTab(tabId: string) {
  disposeTerminal(tabId);
  disposeEditor(tabId);
  desk().removeTab(tabId);
}

export function closeTab(tabId: string) {
  const s = desk();
  const tab = s.tabs.find((t) => t.id === tabId);
  if (!tab) return;
  if (tab.type === "file" && tab.dirty) {
    s.setModal({
      kind: "confirm",
      title: `Save changes to ${tab.title}?`,
      body: tab.conflict ? "The disk version changed outside Desk. Saving overwrites it with your editor version. Closing without saving discards your editor changes." : "Your changes will be lost if you close without saving.",
      confirm: "Save",
      alt: "Don't save",
      onConfirm: async () => {
        if (await saveTab(tabId, true)) disposeTab(tabId);
      },
      onAlt: () => disposeTab(tabId),
    });
    return;
  }
  disposeTab(tabId);
}

// Projects

export async function addProjectPaths(paths: string[]) {
  let added = 0;
  for (const path of paths) {
    try {
      await ipc.listDir(path); // confirms it's a readable folder
    } catch {
      continue;
    }
    const id = desk().addProject(path);
    void watchProject(id);
    void detectProjectAccount(id);
    added++;
  }
  return added;
}

export async function addProjectsFromDialog() {
  const picked = await openDialog({ directory: true, multiple: true, title: "Add project folders" });
  if (!picked) return;
  await addProjectPaths(Array.isArray(picked) ? picked : [picked]);
}

export function removeProject(projectId: string) {
  const s = desk();
  const project = s.projects.find((p) => p.id === projectId);
  if (!project) return;
  // Its worktrees leave Desk with it (their folders stay on disk).
  const ids = [projectId, ...s.projects.filter((p) => p.worktreeOf === projectId).map((p) => p.id)];
  const tabs = s.tabs.filter((t) => ids.includes(t.projectId));
  const run = () => {
    for (const id of ids) forgetProject(id);
  };
  const running = tabs.filter((t) => t.type === "terminal" && t.status === "running").length;
  const dirty = tabs.filter((t) => t.type === "file" && t.dirty).length;
  if (!running && !dirty) return run();
  const parts = [running && `${running} running terminal${running > 1 ? "s" : ""} will be stopped`, dirty && `${dirty} unsaved file${dirty > 1 ? "s" : ""} will be discarded`].filter(Boolean);
  s.setModal({
    kind: "confirm",
    title: `Remove ${project.name} from Desk?`,
    body: `${parts.join(" and ")}. The folder itself stays on disk.`,
    confirm: "Remove",
    danger: true,
    onConfirm: run,
  });
}

export async function watchProject(projectId: string) {
  const project = desk().projects.find((p) => p.id === projectId);
  if (!project) return;
  try {
    await ipc.watch(project.path);
  } catch (e) {
    console.warn("watch failed", project.path, e);
  }
  desk().setBranch(projectId, await ipc.gitBranch(project.path).catch(() => null));
}

// Git refreshes follow the file watcher instead of a timer.

const gitListeners = new Map<string, Set<() => void>>();
const gitTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Calls `fn` whenever files in `root` change, at most once a second. */
export function onGitChange(root: string, fn: () => void) {
  const set = gitListeners.get(root) ?? new Set();
  set.add(fn);
  gitListeners.set(root, set);
  return () => { set.delete(fn); };
}

/** Recounts changed files in `root` and tells any open Git panel to refresh. */
export function gitChanged(root: string) {
  // One pending refresh per folder, so a build writing files nonstop can't keep postponing it.
  if (gitTimers.has(root)) return;
  gitTimers.set(root, setTimeout(() => {
    gitTimers.delete(root);
    const listeners = gitListeners.get(root);
    // An open Git panel reads the full status and updates the count itself.
    if (listeners?.size) listeners.forEach((fn) => fn());
    else void ipc.gitChangeCount(root).then((n) => desk().setChangeCount(root, n)).catch(() => {});
  }, 1000));
}

/** Worktree badges and the active project, read once (at start and when Desk comes back into focus). */
export function refreshChangeCounts() {
  const s = desk();
  for (const p of s.projects.filter((p) => p.worktreeOf || p.id === s.activeProjectId)) gitChanged(p.path);
}

export function handleFsChange(root: string, paths: string[]) {
  gitChanged(root);
  // A commit in a worktree moves a branch in the main repository's .git, which is shared.
  if (paths.some((p) => p.includes("/.git/"))) {
    const main = desk().projects.find((p) => p.path === root);
    for (const w of desk().projects.filter((p) => main && p.worktreeOf === main.id)) gitChanged(w.path);
  }
  useTree.getState().refresh(paths);
  void handleDiskChanges(paths);
  if (paths.some((p) => p.endsWith("/.git/HEAD"))) {
    const project = desk().projects.find((p) => p.path === root);
    if (project) void ipc.gitBranch(root).then((b) => desk().setBranch(project.id, b));
  }
}

// Accounts

/**
 * Picks the Claude account a project was last used with, judged from Claude
 * Code's own per-project session history. Skipped once the user picks by hand.
 */
export async function detectProjectAccount(projectId: string) {
  const find = () => desk().projects.find((p) => p.id === projectId);
  const project = find();
  const candidates = desk().accounts.filter((a) => a.kind === "claude");
  if (!project || project.claudeChosen || candidates.length < 2) return;
  let usage;
  try {
    usage = await ipc.accountUsage(project.path, candidates.map((a) => a.dir));
  } catch {
    return;
  }
  const best = usage
    .map((u, i) => ({ u, account: candidates[i] }))
    .filter((x) => x.u.sessions > 0)
    .sort((x, y) => Number(y.u.exact) - Number(x.u.exact) || y.u.lastUsed - x.u.lastUsed)[0];
  const latest = find();
  if (!best || !latest || latest.claudeChosen) return;
  if (projectAccount(desk().accounts, latest, "claude").id === best.account.id) return;
  desk().setProjectAccount(projectId, "claude", best.account.id, true);
  desk().toast(`${latest.name} uses ${best.account.name} for Claude Code, based on your past sessions there. Click its Claude pill to change it.`);
}

/** Sets a project's account by hand and says what happens to tabs already open. */
export function chooseProjectAccount(projectId: string, kind: Tool, id: string) {
  const s = desk();
  const project = s.projects.find((p) => p.id === projectId);
  const account = s.accounts.find((a) => a.id === id);
  if (!project || !account) return;
  const before = projectAccount(s.accounts, project, kind);
  s.setProjectAccount(projectId, kind, id);
  if (before.id === account.id) return;
  const stale = s.tabs.filter(
    (t) => t.type === "terminal" && t.projectId === projectId && t.status === "running" && t.runAs?.[kind] === before.id && (t.tool === kind || t.tool === "shell"),
  ).length;
  s.toast(
    `New ${TOOL_LABEL[kind]} tabs in ${project.name} use ${account.name}.` +
      (stale ? ` ${stale} open tab${stale > 1 ? "s" : ""} keep${stale > 1 ? "" : "s"} ${before.name} until closed.` : ""),
  );
}

export async function refreshIdentities() {
  try {
    const detected = await ipc.accountsDetect();
    const s = desk();
    s.mergeDetected(detected);
    // Accounts that live outside the scanned ~/.claude* / ~/.codex* names.
    for (const a of desk().accounts) {
      if (a.dir && !detected.some((d) => accountId(d.kind, d.dir) === a.id)) {
        const d = await ipc.accountInspect(a.kind, a.dir);
        desk().setIdentity(a.id, { path: d.path, email: d.email, org: d.org, signedIn: d.signedIn });
      }
    }
  } catch (e) {
    console.warn("account refresh failed", e);
  }
}

export async function createAccount(kind: Tool, name: string, color: string) {
  const dir = await ipc.accountCreate(kind, name);
  const account: Account = { id: accountId(kind, dir), kind, dir, name: name.trim(), color: color || ACCOUNT_COLORS[0] };
  desk().addAccount(account);
  return account;
}

export function removeAccount(account: Account) {
  desk().setModal({
    kind: "confirm",
    title: `Remove ${account.name} from Desk?`,
    body: `Projects using it switch to the default account. The folder ${account.dir} and its sign-in stay on disk.`,
    confirm: "Remove",
    danger: true,
    onConfirm: () => desk().removeAccount(account.id),
  });
}

// File operations with prompts

const join = (dir: string, name: string) => `${dir.replace(/\/+$/, "")}/${name}`;

export function promptNewFile(projectId: string, dir: string, isDir: boolean) {
  desk().setModal({
    kind: "prompt",
    title: isDir ? "New folder" : "New file",
    label: "Name",
    initial: "",
    confirm: "Create",
    onSubmit: async (name) => {
      if (!name.trim() || name.includes("/..") || name.startsWith("..")) return "Enter a name";
      const path = join(dir, name.trim());
      try {
        if (isDir) await ipc.createDir(path);
        else {
          const parent = path.slice(0, path.lastIndexOf("/"));
          if (parent !== dir) await ipc.createDir(parent).catch(() => {});
          await ipc.createFile(path);
        }
      } catch (e) {
        return errorText(e);
      }
      useTree.getState().expand(dir);
      void useTree.getState().load(dir);
      if (!isDir) void openFile(projectId, path);
    },
  });
}

export function promptRename(path: string, onRenamed: (to: string) => void) {
  const name = path.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  desk().setModal({
    kind: "prompt",
    title: "Rename",
    label: "New name",
    initial: name,
    confirm: "Rename",
    select: [0, dot > 0 ? dot : name.length],
    onSubmit: async (value) => {
      const next = value.trim();
      if (!next || next.includes("/")) return "Enter a name without slashes";
      if (next === name) return;
      const to = join(path.slice(0, path.lastIndexOf("/")), next);
      try {
        await ipc.rename(path, to);
      } catch (e) {
        return errorText(e);
      }
      onRenamed(to);
    },
  });
}

export function confirmTrash(path: string) {
  const name = path.split("/").pop();
  desk().setModal({
    kind: "confirm",
    title: `Move ${name} to the Trash?`,
    body: "You can restore it from the Trash in Finder.",
    confirm: "Move to Trash",
    danger: true,
    onConfirm: async () => {
      try {
        await ipc.trash(path);
        for (const t of desk().tabs) {
          if (t.type === "file" && (t.path === path || t.path.startsWith(path + "/"))) {
            disposeEditor(t.id);
            desk().removeTab(t.id);
          }
        }
      } catch (e) {
        desk().toast(`Couldn't move ${name} to the Trash: ${errorText(e)}`, "error");
      }
    },
  });
}

/** Reconstruct editor buffers before enabling persistence; terminals wait for Restart. */
export async function restoreWorkspace() {
  await Promise.all(desk().tabs.filter((t): t is FileTab => t.type === "file").map(async (tab) => {
    try {
      await openEditor(tab.id, tab.path, {
        onDirty: (dirty) => desk().patchTab(tab.id, { dirty }),
        onConflict: (conflict) => desk().patchTab(tab.id, { conflict }),
        onRecovery: (recovery) => desk().patchTab(tab.id, { recovery }),
      }, tab.recovery);
      desk().patchTab(tab.id, { ready: true });
    } catch (e) { desk().patchTab(tab.id, { error: errorText(e) }); }
  }));
  useDesk.setState({ loaded: true });
}

export function splitWorkspace() {
  const s = desk();
  if (s.secondaryTabId) { s.toggleSplit(); return; }
  if (!s.activeTabId) { s.toast("Open a file or terminal before splitting the workspace."); return; }
  let other = s.tabs.find((t) => t.id !== s.activeTabId)?.id;
  if (!other && s.activeProjectId) {
    const primary = s.activeTabId;
    other = openTerminal(s.activeProjectId, "shell");
    useDesk.setState({ activeTabId: primary });
  }
  if (other) useDesk.setState({ secondaryTabId: other, focusedPane: "primary" });
}
