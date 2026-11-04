import { create } from "zustand";
import { EDITOR_THEMES, type EditorThemeId } from "./editorThemes";
import { THEMES, type ThemeId } from "./themeCatalog";
import type { Account, Agent, DetectedAccount, FileTab, Identity, Layout, Project, SshConnection, Tab, TabTool, TerminalTab, Tool, UsageLimits } from "./types";

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

export const TOOL_LABEL: Record<TabTool, string> = { claude: "Claude Code", codex: "Codex", gemini: "Gemini CLI", cursor: "Cursor Agent", grok: "Grok", shell: "Shell" };
/** Short names for tight spots (pills, chips). */
export const TOOL_SHORT: Record<Agent, string> = { claude: "Claude", codex: "Codex", gemini: "Gemini", cursor: "Cursor", grok: "Grok" };
export const AGENTS: Agent[] = ["claude", "codex", "gemini", "cursor", "grok"];
/** Agents beyond Claude Code and Codex: terminal tabs only, no chats or usage limits. */
export const EXTRA_AGENTS: Agent[] = ["gemini", "cursor", "grok"];
/** The variable that points each CLI at an account's folder. Cursor Agent and Grok
 *  have no documented one, so Desk gives them a single (default) account. */
export const ENV_VAR: Record<Agent, string | null> = { claude: "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME", gemini: "GEMINI_CLI_HOME", cursor: null, grok: null };
export const isChatTool = (kind: Agent | TabTool): kind is Tool => kind === "claude" || kind === "codex";

export const accountId = (kind: Agent, dir: string | null) => `${kind}:${dir ?? "default"}`;
export const uid = () => crypto.randomUUID();

export interface Preferences {
  theme: ThemeId | "system";
  /** Bumped when the default look changes; drives one-time theme migration. */
  themeVersion: number;
  /** Pixel themes: animate the pixel-wave backdrop (Reduce motion always shows a still frame). */
  animatedBackground: boolean;
  /** Usage rings, meters and labels show the share used, or what's left. */
  usageShow: "used" | "remaining";
  density: "comfortable" | "compact";
  fontSize: number;
  showProjectAccounts: boolean;
  accent: "neutral";
  showStatusBar: boolean;
  showPaths: boolean;
  showAccountEmails: boolean;
  accountColors: boolean;
  reduceMotion: boolean;
  /** Terminal color preset; "desk" follows the interface theme. */
  terminalTheme: string;
  editorTheme: EditorThemeId;
  /** Colors changed by hand on top of the preset, keyed by xterm theme field. */
  terminalColors: Record<string, string>;
  cursorStyle: "bar" | "block" | "underline";
  cursorBlink: boolean;
  smoothScroll: boolean;
  /** Mark Claude Code and Codex tabs that finished or need input while out of sight. */
  agentAlerts: boolean;
  /** Claude Code tabs report their usage limits through a status line wrapper. */
  usageLimits: boolean;
  /** Show how many agents are waiting on the Dock icon. */
  alertBadge: boolean;
  /** Bounce the Dock icon once when an agent starts waiting and Desk is in the background. */
  alertBounce: boolean;
  /** Claude Code and Codex in terminal tabs, or drawn as a chat. Both run the same CLIs. */
  uiMode: "terminal" | "chat";
  /** Highlight color for toggles, selection and focus; "neutral" follows the theme. */
  accentColor: "neutral" | "sand" | "sage" | "sky" | "rose" | "amber" | "coral";
  corners: "sharp" | "soft" | "round";
  chatFontSize: number;
  chatWidth: "narrow" | "comfortable" | "wide";
  chatToolsOpen: boolean;
}

export const DEFAULT_PREFERENCES: Preferences = { theme: "electric", themeVersion: 2, animatedBackground: true, usageShow: "used", density: "comfortable", fontSize: 14, showProjectAccounts: false, accent: "neutral", showStatusBar: true, showPaths: false, showAccountEmails: false, accountColors: false, reduceMotion: false, terminalTheme: "desk", editorTheme: "desk", terminalColors: {}, cursorStyle: "bar", cursorBlink: true, smoothScroll: true, agentAlerts: true, usageLimits: true, alertBadge: true, alertBounce: true, uiMode: "terminal", accentColor: "neutral", corners: "soft", chatFontSize: 14, chatWidth: "comfortable", chatToolsOpen: false };

export type Modal =
  | { kind: "settings"; section?: string }
  | { kind: "ssh"; id: string | null; from?: "settings" }
  | { kind: "diff"; root: string; path: string; staged: boolean }
  | { kind: "worktree"; projectId: string }
  | { kind: "addAccount"; tool: Agent }
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
  action?: { label: string; run: () => void };
}

/** Where a tab dragged over the workspace would open: an edge splits, the middle replaces. */
export type DropZone = "left" | "right" | "top" | "bottom" | "center";

interface Persisted {
  accounts: Account[];
  connections: SshConnection[];
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
  dropZone: DropZone | null;
  /** Files with Git changes, by project folder. Fills in once its Changes panel has looked. */
  changeCounts: Record<string, number>;
  /** Usage limits per account, keyed by `limitKey`. */
  limits: Record<string, UsageLimits>;

  init(saved: Partial<Persisted> | null, detected: DetectedAccount[]): void;
  mergeDetected(detected: DetectedAccount[]): void;
  addProject(path: string, extra?: Partial<Project>): string;
  removeProject(id: string): void;
  renameProject(id: string, name: string): void;
  moveProject(id: string, toIndex: number): void;
  setProjectAccount(projectId: string, kind: Agent, accountId: string, auto?: boolean): void;
  selectProject(id: string): void;
  addAccount(account: Account): void;
  updateAccount(id: string, patch: Partial<Account>): void;
  removeAccount(id: string): void;
  saveConnection(connection: SshConnection): void;
  removeConnection(id: string): void;
  setIdentity(id: string, identity: Identity): void;
  addTab(tab: Tab): void;
  removeTab(id: string): void;
  moveTab(id: string, beforeId: string | null): void;
  patchTab(id: string, patch: Partial<TerminalTab> | Partial<FileTab>): void;
  selectTab(tabId: string): void;
  setBranch(projectId: string, branch: string | null): void;
  setChangeCount(path: string, count: number): void;
  setLimits(list: UsageLimits[]): void;
  setLayout(patch: Partial<Layout>): void;
  setPreferences(patch: Partial<Preferences>): void;
  setModal(modal: Modal | null): void;
  setQuickOpen(open: boolean): void;
  setCommandOpen(open: boolean): void;
  toggleSplit(): void;
  focusPane(pane: "primary" | "secondary"): void;
  toast(text: string, tone?: Toast["tone"], action?: Toast["action"]): void;
  dismissToast(id: string): void;
}

const DEFAULT_LAYOUT: Layout = { sidebarWidth: 248, filesWidth: 280, sidebarOpen: true, filesOpen: true, accountsOpen: false, claudeOpen: true, codexOpen: true, sshOpen: true, panel: "files", splitRatio: 50, splitDir: "row" };

const THEME_IDS: string[] = [...THEMES.map((theme) => theme.id), "system"];

/** Unknown themes fall back to Electric; saved original palette IDs remain valid.
 *  Anyone still on the previous default (Black) moves to Electric once; any
 *  deliberate choice — including picking Black again afterwards — is kept. */
function migratePreferences(saved: Partial<Preferences> | undefined): Preferences {
  const p = { ...DEFAULT_PREFERENCES, ...saved };
  if (saved && (saved.themeVersion ?? 1) < 2 && (saved.theme ?? "black") === "black") p.theme = "electric";
  p.themeVersion = 2;
  return { ...p, theme: THEME_IDS.includes(p.theme) ? p.theme : "electric", editorTheme: EDITOR_THEMES.some(theme => theme.id === p.editorTheme) ? p.editorTheme : "desk", accent: "neutral" };
}

function baseName(path: string) {
  return path.replace(/\/+$/, "").split("/").pop() || path;
}

/** "~/.claude-work" -> "Work". Default dirs are called "Default". */
function nameFromDir(kind: Agent, dir: string | null) {
  if (!dir) return "Default";
  const rest = baseName(dir).replace(new RegExp(`^\\.${kind}[-_.]?`), "");
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
  const wanted: { kind: Agent; dir: string | null }[] = [
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

/** The chat view shows terminal tabs (SSH included) in its own tab strip; chat.ts sets this. */
export const chatView: { showTerminal: ((tabId: string) => void) | null } = { showTerminal: null };

/** Makes an opened or picked tab visible: a terminal joins the chat view's tabs; anything
 * else (a file) is only shown in the terminal view, so that view comes back. */
function showTabs(tab: Tab | undefined) {
  const s = useDesk.getState();
  if (s.preferences.uiMode !== "chat" || !tab) return;
  if (tab.type === "terminal" && chatView.showTerminal) chatView.showTerminal(tab.id);
  else s.setPreferences({ uiMode: "terminal" });
}

export const useDesk = create<DeskState>((set, get) => ({
  loaded: false,
  accounts: [],
  connections: [],
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
  dropZone: null,
  changeCounts: {},
  limits: {},

  init(saved, detected) {
    const { accounts, identities } = mergeAccounts(saved?.accounts ?? [], detected);
    const projects = saved?.projects ?? [];
    const activeProjectId = projects.some((p) => p.id === saved?.activeProjectId)
      ? saved!.activeProjectId!
      : (projects[0]?.id ?? null);
    const tabs = (saved?.tabs ?? []).filter((t) => projects.some((p) => p.id === t.projectId)).map((t): Tab => t.type === "terminal"
      ? { ...t, status: "exited", activity: false, restored: true, busy: false, attention: null }
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
      connections: saved?.connections ?? [],
      projects,
      activeProjectId,
      layout: { ...DEFAULT_LAYOUT, ...saved?.layout },
      preferences: migratePreferences(saved?.preferences),
    });
  },

  mergeDetected(detected) {
    const { accounts, identities } = mergeAccounts(get().accounts, detected);
    set((s) => ({ accounts, identities: { ...s.identities, ...identities } }));
  },

  addProject(path, extra = {}) {
    const existing = get().projects.find((p) => p.path === path);
    if (existing) {
      set({ activeProjectId: existing.id });
      return existing.id;
    }
    const project: Project = { id: uid(), name: baseName(path), path, claudeAccountId: null, codexAccountId: null, ...extra };
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
        connections: s.connections.map((c) => (c.projectId === id ? { ...c, projectId: null } : c)),
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
    const account = get().accounts.find((a) => a.id === id);
    // The default account is stored as null so it follows the tool's default dir.
    const value = account && account.dir ? id : null;
    if (!isChatTool(kind)) {
      set((s) => ({ projects: s.projects.map((p) => (p.id === projectId ? { ...p, agentAccounts: { ...p.agentAccounts, [kind]: value } } : p)) }));
      return;
    }
    const key = kind === "claude" ? "claudeAccountId" : "codexAccountId";
    const chosen = kind === "claude" ? "claudeChosen" : "codexChosen";
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

  saveConnection(connection) {
    set((s) => ({
      connections: s.connections.some((c) => c.id === connection.id)
        ? s.connections.map((c) => (c.id === connection.id ? connection : c))
        : [...s.connections, connection],
    }));
  },

  removeConnection(id) {
    set((s) => ({ connections: s.connections.filter((c) => c.id !== id) }));
  },

  setIdentity(id, identity) {
    set((s) => ({ identities: { ...s.identities, [id]: identity } }));
  },

  addTab(tab) {
    showTabs(tab);
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

  moveTab(id, beforeId) {
    set((s) => {
      const tab = s.tabs.find((t) => t.id === id);
      if (!tab || id === beforeId || (beforeId !== null && !s.tabs.some((t) => t.id === beforeId))) return {};
      const tabs = s.tabs.filter((t) => t.id !== id);
      const at = beforeId === null ? tabs.length : tabs.findIndex((t) => t.id === beforeId);
      tabs.splice(at, 0, tab);
      return tabs.every((t, i) => t.id === s.tabs[i]?.id) ? {} : { tabs };
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
    showTabs(get().tabs.find((t) => t.id === tabId));
    set((s) => {
      const tab = s.tabs.find((t) => t.id === tabId);
      if (!tab) return {};
      const focus = tabId === s.activeTabId ? "primary" : tabId === s.secondaryTabId ? "secondary" : s.focusedPane;
      return {
        ...(focus === "secondary" ? { secondaryTabId: tabId } : { activeTabId: tabId }),
        focusedPane: focus,
        activeProjectId: tab.projectId,
        tabs: s.tabs.map((t) => t.id === tabId && t.type === "terminal" ? { ...t, activity: false, attention: null } : t),
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
    set((s) => (s.branches[projectId] === branch ? {} : { branches: { ...s.branches, [projectId]: branch } }));
  },

  setLimits(list) {
    set({ limits: Object.fromEntries(list.map((l) => [limitKey(l.tool, l.dir), l])) });
  },

  setChangeCount(path, count) {
    set((s) => (s.changeCounts[path] === count ? {} : { changeCounts: { ...s.changeCounts, [path]: count } }));
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

  toast(text, tone = "info", action) {
    const id = uid();
    set((s) => ({ toasts: [...s.toasts.slice(-2), { id, text, tone, action }] }));
    setTimeout(() => get().dismissToast(id), tone === "error" ? 6000 : action ? 7000 : 3200);
  },

  dismissToast(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
}));

// Derived helpers

export function defaultAccount(accounts: Account[], kind: Agent): Account {
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

export function projectAccount(accounts: Account[], project: Project | undefined, kind: Agent): Account {
  const id = kind === "claude" ? project?.claudeAccountId : kind === "codex" ? project?.codexAccountId : project?.agentAccounts?.[kind];
  // Agents without a default folder (none detected) fall back to their first account.
  return accounts.find((a) => a.id === id) ?? accounts.find((a) => a.kind === kind && a.dir === null) ?? accounts.find((a) => a.kind === kind) ?? defaultAccount(accounts, kind);
}

/**
 * The account a terminal tab runs as for `kind`. Once a session has started this
 * is what it was started with, even if the project's account changed since.
 */
export function tabAccount(
  accounts: Account[],
  project: Project | undefined,
  tab: TerminalTab,
  kind: Agent = tab.tool === "shell" ? "claude" : tab.tool,
): Account {
  const id = tab.runAs?.[kind] ?? (tab.tool === kind ? tab.accountId : null);
  return accounts.find((a) => a.id === id) ?? projectAccount(accounts, project, kind);
}

/** Environment for a session: chosen accounts get their config dir, default accounts unset the variable. */
export function sessionEnv(accounts: Account[], project: Project | undefined, overrides: Partial<Record<Agent, Account>> = {}) {
  const env: Record<string, string> = {};
  const unset: string[] = [];
  for (const kind of AGENTS) {
    const name = ENV_VAR[kind];
    if (!name) continue;
    const account = overrides[kind] ?? projectAccount(accounts, project, kind);
    if (account.dir) env[name] = account.dir;
    else unset.push(name);
  }
  return { env, unset };
}

export function persistedSlice(s: DeskState): Persisted & { version: number } {
  return { version: 4, tabs: s.tabs, activeTabId: s.activeTabId, secondaryTabId: s.secondaryTabId, focusedPane: s.focusedPane, accounts: s.accounts, connections: s.connections, projects: s.projects, activeProjectId: s.activeProjectId, layout: s.layout, preferences: s.preferences };
}

export function shortPath(path: string, home: string | null) {
  return home && path.startsWith(home) ? "~" + path.slice(home.length) : path;
}

export const limitKey = (tool: Agent, dir: string | null) => `${tool}:${dir ?? ""}`;

/** Tabs whose agent finished or wants input, in tab order. */
export function waitingTabs(s: Pick<DeskState, "tabs">) {
  return s.tabs.filter((t): t is TerminalTab => t.type === "terminal" && !!t.attention);
}

/** Top-level projects, each followed by its worktrees. */
export function projectTree(projects: Project[]) {
  const ids = new Set(projects.map((p) => p.id));
  const roots = projects.filter((p) => !p.worktreeOf || !ids.has(p.worktreeOf));
  return roots.map((root) => ({ root, worktrees: projects.filter((p) => p.worktreeOf === root.id) }));
}

export function focusedTabId(s: Pick<DeskState, "focusedPane" | "secondaryTabId" | "activeTabId">) {
  return s.focusedPane === "secondary" && s.secondaryTabId ? s.secondaryTabId : s.activeTabId;
}
