export type Tool = "claude" | "codex";
export type TabTool = Tool | "shell";

/** An account is a config directory. `dir: null` is the tool's default (~/.claude, ~/.codex). */
export interface Account {
  id: string;
  kind: Tool;
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
}

export interface TerminalTab {
  id: string;
  projectId: string;
  type: "terminal";
  tool: TabTool;
  /** Account picked explicitly for this tab, overriding the project's (claude/codex tabs). */
  accountId: string | null;
  /** Accounts the running session was actually started with; set at every spawn. */
  runAs?: Partial<Record<Tool, string>>;
  cwd: string;
  title: string;
  status: "starting" | "running" | "exited";
  exitCode: number | null;
  activity: boolean;
  restored?: boolean;
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
  panel: "files" | "search" | "git";
  splitRatio: number;
}

export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
  ignored: boolean;
}

export interface DetectedAccount {
  kind: Tool;
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

export interface GitChange { path: string; originalPath: string | null; index: string; worktree: string }
export interface GitStatus { root: string; branch: string; changes: GitChange[] }
export interface SearchFile { path: string; original: string; matches: { line: number; text: string }[]; count: number }
export interface SearchResults { files: SearchFile[]; truncated: boolean; skipped: number }
