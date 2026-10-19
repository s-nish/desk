// User-level operations that touch both the store and the terminal/editor registries.

import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { ipc, errorText } from "./ipc";
import { ACCOUNT_COLORS, TOOL_LABEL, accountId, projectAccount, sessionEnv, uid, useDesk, focusedTabId } from "./store";
import { disposeTerminal } from "./terminals";
import { disposeEditor, focusEditor, handleDiskChanges, openEditor, saveEditor, revealEditorLine } from "./editors";
import { useTree } from "./tree";
import type { Account, FileTab, TabTool, TerminalTab, Tool } from "./types";
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

export function openTerminal(projectId: string, tool: TabTool, opts: { accountId?: string; cwd?: string } = {}) {
  const s = desk();
  const project = s.projects.find((p) => p.id === projectId);
  if (!project) return;
  const tab: TerminalTab = {
    id: uid(),
    projectId,
    type: "terminal",
    tool,
    accountId: tool === "shell" ? null : (opts.accountId ?? null),
    cwd: opts.cwd ?? project.path,
    title: "",
    status: "starting",
    exitCode: null,
    activity: false,
  };
  s.addTab(tab);
  return tab.id;
}

/** Re-reads accounts at spawn time so restarts use the current folder for that account. */
export function terminalSpec(tabId: string): SessionSpec {
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
  return { cwd: tab.cwd, command: COMMAND[tab.tool], ...sessionEnv(s.accounts, project, overrides) };
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
  const tabs = s.tabs.filter((t) => t.projectId === projectId);
  const run = () => {
    for (const t of tabs) {
      disposeTerminal(t.id);
      disposeEditor(t.id);
    }
    void ipc.unwatch(project.path);
    desk().removeProject(projectId);
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

export function handleFsChange(root: string, paths: string[]) {
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
