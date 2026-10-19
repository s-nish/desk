import { Channel, invoke } from "@tauri-apps/api/core";
import type { DetectedAccount, DirEntry, GitStatus, SearchResults } from "./types";

export interface SpawnOpts {
  cwd: string;
  command: string | null;
  env: Record<string, string>;
  unset: string[];
  cols: number;
  rows: number;
}

export const ipc = {
  exit: () => invoke<void>("workspace_exit"),
  ptySpawn(opts: SpawnOpts, onData: (bytes: Uint8Array) => void): Promise<number> {
    const channel = new Channel<ArrayBuffer>();
    channel.onmessage = (buf) => onData(new Uint8Array(buf));
    return invoke("pty_spawn", { opts, onData: channel });
  },
  ptyWrite: (id: number, data: string) => invoke<void>("pty_write", { id, data }),
  ptyWriteBytes: (id: number, data: number[]) => invoke<void>("pty_write_bytes", { id, data }),
  ptyResize: (id: number, cols: number, rows: number) => invoke<void>("pty_resize", { id, cols, rows }),
  ptyKill: (id: number) => invoke<void>("pty_kill", { id }),

  accountsDetect: () => invoke<DetectedAccount[]>("accounts_detect"),
  accountInspect: (kind: string, dir: string | null) => invoke<DetectedAccount>("account_inspect", { kind, dir }),
  accountUsage: (path: string, dirs: (string | null)[]) =>
    invoke<{ dir: string | null; sessions: number; lastUsed: number; exact: boolean }[]>("account_usage", { path, dirs }),
  accountCreate: (kind: string, name: string) => invoke<string>("account_create", { kind, name }),

  stateLoad: () => invoke<unknown>("state_load"),
  stateSave: (state: unknown) => invoke<void>("state_save", { state }),

  listDir: (path: string) => invoke<DirEntry[]>("fs_list_dir", { path }),
  listFiles: (root: string) => invoke<string[]>("fs_list_files", { root }),
  readFile: (path: string) => invoke<{ content: string; mtime: number }>("fs_read", { path }),
  writeFile: (path: string, content: string) => invoke<number>("fs_write", { path, content }),
  createFile: (path: string) => invoke<void>("fs_create_file", { path }),
  createDir: (path: string) => invoke<void>("fs_create_dir", { path }),
  rename: (from: string, to: string) => invoke<void>("fs_rename", { from, to }),
  trash: (path: string) => invoke<void>("fs_trash", { path }),
  watch: (root: string) => invoke<void>("fs_watch", { root }),
  unwatch: (root: string) => invoke<void>("fs_unwatch", { root }),
  gitBranch: (root: string) => invoke<string | null>("git_branch", { root }),
  gitStatus: (root: string) => invoke<GitStatus>("git_status", { root }),
  gitDiff: (root: string, path: string, staged: boolean) => invoke<string>("git_diff", { root, path, staged }),
  gitStage: (root: string, path: string, staged: boolean) => invoke<void>("git_stage", { root, path, staged }),
  gitCommit: (root: string, message: string) => invoke<string>("git_commit", { root, message }),
  search: (root: string, query: string, caseSensitive: boolean) => invoke<SearchResults>("project_search", { root, query, caseSensitive }),
  replace: (root: string, query: string, replacement: string, caseSensitive: boolean, snapshots: { path: string; original: string }[]) => invoke<{ modified: string[]; errors: string[] }>("project_replace", { root, query, replacement, caseSensitive, snapshots }),
  pathExists: (path: string) => invoke<boolean>("path_exists", { path }),

  openExternal: (url: string) => invoke<void>("open_external", { url }),
  reveal: (path: string) => invoke<void>("reveal_in_finder", { path }),
};

export function errorText(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e);
}
