import { create } from "zustand";
import type { Account, DetectedAccount, FileTab, Identity, Layout, Project, Tab, TabTool, TerminalTab, Tool } from "./types";

export const ACCOUNT_COLORS = ["#2dd4bf", "#f59e0b", "#60a5fa", "#fb7185", "#4ade80", "#e5e5e5"];

/** Colors from the first palette, mapped to their replacements (purple became blue). */
const LEGACY_COLORS: Record<string, string> = {
  "#5fc8b8": "#2dd4bf",
  "#e8a75a": "#f59e0b",
  "#a48af0": "#60a5fa",
  "#ef7f9b": "#fb7185",
  "#8fc46a": "#4ade80",
  "#62a8ee": "#60a5fa",
};

export const TOOL_LABEL: Record<TabTool, string> = { claude: "Claude Code", codex: "Codex", shell: "Shell" };
export const ENV_VAR: Record<Tool, string> = { claude: "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME" };

export const accountId = (kind: Tool, dir: string | null) => `${kind}:${dir ?? "default"}`;
export const uid = () => crypto.randomUUID();

export interface Preferences {
  theme: "graphite" | "midnight" | "forest" | "paper" | "system";
  density: "comfortable" | "compact";
  fontSize: number;
  showProjectAccounts: boolean;
}

export const DEFAULT_PREFERENCES: Preferences = { theme: "graphite", density: "comfortable", fontSize: 13, showProjectAccounts: false };

export type Modal =
  | { kind: "settings" }
  | { kind: "diff"; root: string; path: string; staged: boolean }
  | { kind: "addAccount"; tool: Tool }
  | { kind: "signin"; accountId: string }
  | {
      kind: "prompt";
      title: string;
      label: string;
      initial: string;
      confirm: string;
      select?: [number, number];
      onSubmit: (value: string) => Promise<string | void> | string | void;
    }
  | {
      kind: "confirm";
      title: string;
      body: string;
      confirm: string;
      danger?: boolean;
      alt?: string;
      onConfirm: () => void;
      onAlt?: () => void;
    };

export interface Toast {
  id: string;
  text: string;
  tone: "info" | "error";
}

interface Persisted {
  accounts: Account[];
  projects: Project[];
  activeProjectId: string | null;
  layout: Layout;
  preferences: Preferences;
  tabs: Tab[];
  activeTabId: string | null;
  secondaryTabId: string | null;
  focusedPane: "primary" | "secondary";
}

interface DeskState extends Persisted {
  loaded: boolean;
  identities: Record<string, Identity>;
  tabs: Tab[];
  /** One tab bar for every project; this is the tab on screen. */
  activeTabId: string | null;
  branches: Record<string, string | null>;
  modal: Modal | null;
  quickOpen: boolean;
  commandOpen: boolean;
  toasts: Toast[];

  init(saved: Partial<Persisted> | null, detected: DetectedAccount[]): void;
  mergeDetected(detected: DetectedAccount[]): void;
  addProject(path: string): string;
  removeProject(id: string): void;
  renameProject(id: string, name: string): void;
  moveProject(id: string, toIndex: number): void;
  setProjectAccount(projectId: string, kind: Tool, accountId: string, auto?: boolean): void;
  selectProject(id: string): void;
  addAccount(account: Account): void;
  updateAccount(id: string, patch: Partial<Account>): void;
  removeAccount(id: string): void;
  setIdentity(id: string, identity: Identity): void;
  addTab(tab: Tab): void;
  removeTab(id: string): void;
  patchTab(id: string, patch: Partial<TerminalTab> | Partial<FileTab>): void;
  selectTab(tabId: string): void;
  setBranch(projectId: string, branch: string | null): void;
  setLayout(patch: Partial<Layout>): void;
  setPreferences(patch: Partial<Preferences>): void;
  setModal(modal: Modal | null): void;
  setQuickOpen(open: boolean): void;
  setCommandOpen(open: boolean): void;
  toggleSplit(): void;
  focusPane(pane: "primary" | "secondary"): void;
  toast(text: string, tone?: Toast["tone"]): void;
  dismissToast(id: string): void;
}

const DEFAULT_LAYOUT: Layout = { sidebarWidth: 248, filesWidth: 280, sidebarOpen: true, filesOpen: true, accountsOpen: false, claudeOpen: true, codexOpen: true, panel: "files", splitRatio: 50 };

function baseName(path: string) {
  return path.replace(/\/+$/, "").split("/").pop() || path;
}

/** "~/.claude-work" -> "Work". Default dirs are called "Default". */
function nameFromDir(kind: Tool, dir: string | null) {
  if (!dir) return "Default";
  const rest = baseName(dir).replace(kind === "claude" ? /^\.claude[-_.]?/ : /^\.codex[-_.]?/, "");
  if (!rest) return "Default";
  return rest
    .split(/[-_.]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function nextColor(accounts: Account[]) {
  const used = new Set(accounts.map((a) => a.color));
  return ACCOUNT_COLORS.find((c) => !used.has(c)) ?? ACCOUNT_COLORS[accounts.length % ACCOUNT_COLORS.length];
}

function identityOf(d: DetectedAccount): Identity {
  return { path: d.path, email: d.email, org: d.org, signedIn: d.signedIn };
}

/** Adds any detected config dirs we don't know yet, and always keeps a default account per tool. */
function mergeAccounts(accounts: Account[], detected: DetectedAccount[]) {
  const out = accounts.map((a) => (LEGACY_COLORS[a.color] ? { ...a, color: LEGACY_COLORS[a.color] } : a));
  const identities: Record<string, Identity> = {};
  const wanted: { kind: Tool; dir: string | null }[] = [
    { kind: "claude", dir: null },
    { kind: "codex", dir: null },
    ...detected.map((d) => ({ kind: d.kind, dir: d.dir })),
  ];
  for (const w of wanted) {
    const id = accountId(w.kind, w.dir);
    if (!out.some((a) => a.id === id)) {
      out.push({ id, kind: w.kind, dir: w.dir, name: nameFromDir(w.kind, w.dir), color: nextColor(out) });
    }
  }
  for (const d of detected) identities[accountId(d.kind, d.dir)] = identityOf(d);
  return { accounts: out, identities };
}

export const useDesk = create<DeskState>((set, get) => ({
  loaded: false,
  accounts: [],
  projects: [],
  activeProjectId: null,
  layout: DEFAULT_LAYOUT,
  preferences: DEFAULT_PREFERENCES,
  identities: {},
  tabs: [],
  activeTabId: null,
  secondaryTabId: null,
  focusedPane: "primary",
  branches: {},
  modal: null,
  quickOpen: false,
  commandOpen: false,
  toasts: [],

  init(saved, detected) {
    const { accounts, identities } = mergeAccounts(saved?.accounts ?? [], detected);
    const projects = saved?.projects ?? [];
    const activeProjectId = projects.some((p) => p.id === saved?.activeProjectId)
      ? saved!.activeProjectId!
      : (projects[0]?.id ?? null);
    const tabs = (saved?.tabs ?? []).filter((t) => projects.some((p) => p.id === t.projectId)).map((t): Tab => t.type === "terminal"
      ? { ...t, status: "exited", activity: false, restored: true }
      : { ...t, ready: false, error: null });
    const activeTabId = tabs.some((t) => t.id === saved?.activeTabId) ? saved!.activeTabId! : tabs[0]?.id ?? null;
    const secondaryTabId = tabs.some((t) => t.id === saved?.secondaryTabId && t.id !== activeTabId) ? saved!.secondaryTabId! : null;
    set({
      loaded: false,
      tabs,
      activeTabId,
      secondaryTabId,
      focusedPane: secondaryTabId && saved?.focusedPane === "secondary" ? "secondary" : "primary",
      accounts,
      identities,
      projects,
      activeProjectId,
      layout: { ...DEFAULT_LAYOUT, ...saved?.layout },
      preferences: { ...DEFAULT_PREFERENCES, ...saved?.preferences },
    });
  },

  mergeDetected(detected) {
    const { accounts, identities } = mergeAccounts(get().accounts, detected);
    set((s) => ({ accounts, identities: { ...s.identities, ...identities } }));
  },

  addProject(path) {
    const existing = get().projects.find((p) => p.path === path);
    if (existing) {
      set({ activeProjectId: existing.id });
      return existing.id;
    }
    const project: Project = { id: uid(), name: baseName(path), path, claudeAccountId: null, codexAccountId: null };
    set((s) => ({ projects: [...s.projects, project], activeProjectId: project.id }));
    return project.id;
  },

  removeProject(id) {
    set((s) => {
      const projects = s.projects.filter((p) => p.id !== id);
      const tabs = s.tabs.filter((t) => t.projectId !== id);
      const activeTabId = tabs.some((t) => t.id === s.activeTabId) ? s.activeTabId : (tabs[tabs.length - 1]?.id ?? null);
      const fallback = tabs.find((t) => t.id === activeTabId)?.projectId ?? projects[0]?.id ?? null;
      return {
        projects,
        tabs,
        secondaryTabId: tabs.some((t) => t.id === s.secondaryTabId && t.id !== activeTabId) ? s.secondaryTabId : null,
        focusedPane: "primary",
        activeTabId,
        activeProjectId: s.activeProjectId === id ? fallback : s.activeProjectId,
      };
    });
  },

  renameProject(id, name) {
    set((s) => ({ projects: s.projects.map((p) => (p.id === id ? { ...p, name } : p)) }));
  },

  moveProject(id, toIndex) {
    set((s) => {
      const projects = [...s.projects];
      const from = projects.findIndex((p) => p.id === id);
      if (from < 0) return {};
      const [p] = projects.splice(from, 1);
      projects.splice(Math.max(0, Math.min(toIndex, projects.length)), 0, p);
      return { projects };
    });
  },

  setProjectAccount(projectId, kind, id, auto = false) {
    const key = kind === "claude" ? "claudeAccountId" : "codexAccountId";
    const chosen = kind === "claude" ? "claudeChosen" : "codexChosen";
    const account = get().accounts.find((a) => a.id === id);
    // The default account is stored as null so it follows the tool's default dir.
    const value = account && account.dir ? id : null;
    set((s) => ({
      projects: s.projects.map((p) => (p.id === projectId ? { ...p, [key]: value, ...(auto ? {} : { [chosen]: true }) } : p)),
    }));
  },

  selectProject(id) {
    set({ activeProjectId: id });
  },

  addAccount(account) {
    set((s) => ({ accounts: [...s.accounts.filter((a) => a.id !== account.id), account] }));
  },

  updateAccount(id, patch) {
    set((s) => ({ accounts: s.accounts.map((a) => (a.id === id ? { ...a, ...patch } : a)) }));
  },

  removeAccount(id) {
    set((s) => ({
      accounts: s.accounts.filter((a) => a.id !== id),
      projects: s.projects.map((p) => ({
        ...p,
        claudeAccountId: p.claudeAccountId === id ? null : p.claudeAccountId,
        codexAccountId: p.codexAccountId === id ? null : p.codexAccountId,
      })),
    }));
  },

  setIdentity(id, identity) {
    set((s) => ({ identities: { ...s.identities, [id]: identity } }));
  },

  addTab(tab) {
    set((s) => {
      // Keep each project's tabs next to each other in the shared tab bar.
      const tabs = [...s.tabs];
      let at = tabs.length;
      for (let i = tabs.length - 1; i >= 0; i--) {
        if (tabs[i].projectId === tab.projectId) {
          at = i + 1;
          break;
        }
      }
      tabs.splice(at, 0, tab);
      return s.focusedPane === "secondary" && s.secondaryTabId
        ? { tabs, secondaryTabId: tab.id, activeProjectId: tab.projectId }
        : { tabs, activeTabId: tab.id, activeProjectId: tab.projectId };
    });
  },

  removeTab(id) {
    set((s) => {
      const index = s.tabs.findIndex((t) => t.id === id);
      if (index < 0) return {};
      const tabs = s.tabs.filter((t) => t.id !== id);
      if (s.secondaryTabId === id) return { tabs, secondaryTabId: null, focusedPane: "primary" };
      if (s.activeTabId !== id) return { tabs };
      const next = tabs.find((t) => t.id !== s.secondaryTabId);
      return next ? { tabs, activeTabId: next.id, activeProjectId: next.projectId }
        : { tabs, activeTabId: s.secondaryTabId, secondaryTabId: null, focusedPane: "primary" };
    });
  },

  patchTab(id, patch) {
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? ({ ...t, ...patch } as Tab) : t)) }));
  },

  selectTab(tabId) {
    set((s) => {
      const tab = s.tabs.find((t) => t.id === tabId);
      if (!tab) return {};
      const focus = tabId === s.activeTabId ? "primary" : tabId === s.secondaryTabId ? "secondary" : s.focusedPane;
      return {
        ...(focus === "secondary" ? { secondaryTabId: tabId } : { activeTabId: tabId }),
        focusedPane: focus,
        activeProjectId: tab.projectId,
        tabs: s.tabs.map((t) => t.id === tabId && t.type === "terminal" ? { ...t, activity: false } : t),
      };
    });
  },

  toggleSplit() {
    set((s) => s.secondaryTabId ? { secondaryTabId: null, focusedPane: "primary" } : {
      secondaryTabId: s.tabs.find((t) => t.id !== s.activeTabId)?.id ?? null,
      focusedPane: "primary",
    });
  },

  focusPane(focusedPane) {
    set((s) => ({ focusedPane, activeProjectId: s.tabs.find((t) => t.id === (focusedPane === "secondary" ? s.secondaryTabId : s.activeTabId))?.projectId ?? s.activeProjectId }));
  },

  setBranch(projectId, branch) {
    set((s) => ({ branches: { ...s.branches, [projectId]: branch } }));
  },

  setLayout(patch) {
    set((s) => ({ layout: { ...s.layout, ...patch } }));
  },

  setPreferences(patch) {
    set((s) => ({ preferences: { ...s.preferences, ...patch } }));
  },

  setModal(modal) {
    set({ modal });
  },

  setQuickOpen(open) {
    set({ quickOpen: open, commandOpen: false });
  },

  setCommandOpen(open) {
    set({ commandOpen: open, quickOpen: false });
  },

  toast(text, tone = "info") {
    const id = uid();
    set((s) => ({ toasts: [...s.toasts.slice(-2), { id, text, tone }] }));
    setTimeout(() => get().dismissToast(id), tone === "error" ? 6000 : 3200);
  },

  dismissToast(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
}));

// Derived helpers

export function defaultAccount(accounts: Account[], kind: Tool): Account {
  return (
    accounts.find((a) => a.kind === kind && a.dir === null) ?? {
      id: accountId(kind, null),
      kind,
      dir: null,
      name: "Default",
      color: ACCOUNT_COLORS[0],
    }
  );
}

export function projectAccount(accounts: Account[], project: Project | undefined, kind: Tool): Account {
  const id = kind === "claude" ? project?.claudeAccountId : project?.codexAccountId;
  return accounts.find((a) => a.id === id) ?? defaultAccount(accounts, kind);
}

/**
 * The account a terminal tab runs as for `kind`. Once a session has started this
 * is what it was started with, even if the project's account changed since.
 */
export function tabAccount(
  accounts: Account[],
  project: Project | undefined,
  tab: TerminalTab,
  kind: Tool = tab.tool === "codex" ? "codex" : "claude",
): Account {
  const id = tab.runAs?.[kind] ?? (tab.tool === kind ? tab.accountId : null);
  return accounts.find((a) => a.id === id) ?? projectAccount(accounts, project, kind);
}

/** Environment for a session: chosen accounts get their config dir, default accounts unset the variable. */
export function sessionEnv(accounts: Account[], project: Project | undefined, overrides: Partial<Record<Tool, Account>> = {}) {
  const env: Record<string, string> = {};
  const unset: string[] = [];
  for (const kind of ["claude", "codex"] as Tool[]) {
    const account = overrides[kind] ?? projectAccount(accounts, project, kind);
    if (account.dir) env[ENV_VAR[kind]] = account.dir;
    else unset.push(ENV_VAR[kind]);
  }
  return { env, unset };
}

export function persistedSlice(s: DeskState): Persisted & { version: number } {
  return { version: 2, tabs: s.tabs, activeTabId: s.activeTabId, secondaryTabId: s.secondaryTabId, focusedPane: s.focusedPane, accounts: s.accounts, projects: s.projects, activeProjectId: s.activeProjectId, layout: s.layout, preferences: s.preferences };
}

export function shortPath(path: string, home: string | null) {
  return home && path.startsWith(home) ? "~" + path.slice(home.length) : path;
}

export function focusedTabId(s: Pick<DeskState, "focusedPane" | "secondaryTabId" | "activeTabId">) {
  return s.focusedPane === "secondary" && s.secondaryTabId ? s.secondaryTabId : s.activeTabId;
}
