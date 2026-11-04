/** Tools with chats, session history and usage limits. */
export type Tool = "claude" | "codex";
/** Every coding agent Desk can run in a terminal tab, each with its own accounts. */
export type Agent = Tool | "gemini" | "cursor" | "grok";
export type TabTool = Agent | "shell";

/** An account is a config directory. `dir: null` is the tool's default (~/.claude, ~/.codex). */
export interface Account {
  id: string;
  kind: Agent;
  name: string;
  dir: string | null;
  color: string;
}

export interface Identity {
  path: string;
  email: string | null;
  org: string | null;
  signedIn: boolean;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  claudeAccountId: string | null;
  codexAccountId: string | null;
  /** Set once the user picks an account by hand; automatic detection then leaves it alone. */
  claudeChosen?: boolean;
  codexChosen?: boolean;
  /** Accounts for the other agents (Gemini CLI, Cursor Agent, Grok); missing means default. */
  agentAccounts?: Partial<Record<Agent, string | null>>;
  /** Set for a git worktree: the project it was branched from. Shown nested under it. */
  worktreeOf?: string;
  /** Branch checked out in the worktree, and the branch it started from. */
  branch?: string;
  base?: string;
}

/** A saved command, usually ssh, opened in its own tab. Its password is kept in
 * Desk's support folder (owner-only), never in this state. */
export interface SshConnection {
  id: string;
  name: string;
  command: string;
  /** Whether a password is saved for this connection. */
  password: boolean;
  /** Project whose tab group it opens in; null opens in the selected project. */
  projectId: string | null;
}

export interface TerminalTab {
  id: string;
  projectId: string;
  type: "terminal";
  tool: TabTool;
  /** Account picked explicitly for this tab, overriding the project's (claude/codex tabs). */
  accountId: string | null;
  /** Accounts the running session was actually started with; set at every spawn. */
  runAs?: Partial<Record<Agent, string>>;
  /** Saved connection this tab runs (a shell tab running its command). */
  sshId?: string;
  cwd: string;
  title: string;
  status: "starting" | "running" | "exited";
  exitCode: number | null;
  activity: boolean;
  restored?: boolean;
  /** Claude Code or Codex is producing output (working on something). */
  busy?: boolean;
  /** Why the agent wants you: it finished, rang the bell, or sent a notification. */
  attention?: string | null;
  /** Claude Code conversation this tab runs, so it can be resumed after Desk restarts. */
  sessionId?: string;
  /** Codex conversation to resume when the tab starts. */
  resume?: string;
  /** Command a shell tab runs once when it first starts (e.g. a merge). */
  command?: string;
}

export interface FileTab {
  id: string;
  projectId: string;
  type: "file";
  path: string;
  title: string;
  dirty: boolean;
  conflict: boolean;
  ready: boolean;
  error: string | null;
  recovery?: { content: string; baseline: string };
}

export type Tab = TerminalTab | FileTab;

export interface Layout {
  sidebarWidth: number;
  filesWidth: number;
  sidebarOpen: boolean;
  filesOpen: boolean;
  accountsOpen: boolean;
  claudeOpen: boolean;
  codexOpen: boolean;
  sshOpen: boolean;
  panel: "files" | "search" | "git" | "sessions";
  splitRatio: number;
  /** Split side by side ("row") or stacked ("column"). */
  splitDir: "row" | "column";
}

export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
  ignored: boolean;
}

export interface DetectedAccount {
  kind: Agent;
  dir: string | null;
  path: string;
  email: string | null;
  org: string | null;
  signedIn: boolean;
}

export interface MenuItem {
  label?: string;
  hint?: string;
  icon?: React.ReactNode;
  checked?: boolean;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
  swatches?: { colors: string[]; current: string; onPick: (c: string) => void };
  onSelect?: () => void;
}

export interface GitChange { path: string; originalPath: string | null; index: string; worktree: string; stagedLines: [number, number] | null; unstagedLines: [number, number] | null }
export interface GitStatus { root: string; branch: string; changes: GitChange[]; upstream: string | null; ahead: number; behind: number; lastCommit: string | null }
export interface Worktree { path: string; branch: string | null; head: string; main: boolean; locked: boolean; prunable: boolean }
/** Share of an allowance used, 0 to 100, and when it starts over (ms since the epoch). */
export interface UsageWindow { used: number; resetsAt: number | null; minutes: number }
export interface UsageLimits { tool: Tool; dir: string | null; session: UsageWindow | null; weekly: UsageWindow | null; plan: string | null; updated: number }
export interface AgentSession { tool: Tool; dir: string | null; id: string; title: string; prompt: string | null; cwd: string; updated: number }
export interface SearchFile { path: string; original: string; matches: { line: number; text: string }[]; count: number }
export interface SearchResults { files: SearchFile[]; truncated: boolean; skipped: number }
