import { create } from "zustand";
import { ipc } from "./ipc";
import type { DirEntry } from "./types";

interface TreeState {
  children: Record<string, DirEntry[] | undefined>;
  expanded: Record<string, boolean>;
  errors: Record<string, string | undefined>;
  load(dir: string): Promise<void>;
  toggle(dir: string): void;
  expand(dir: string): void;
  /** Re-lists any loaded directory affected by the changed paths. */
  refresh(paths: string[]): void;
}

const parentOf = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/";

export const useTree = create<TreeState>((set, get) => ({
  children: {},
  expanded: {},
  errors: {},

  async load(dir) {
    try {
      const entries = await ipc.listDir(dir);
      set((s) => ({ children: { ...s.children, [dir]: entries }, errors: { ...s.errors, [dir]: undefined } }));
    } catch (e) {
      set((s) => ({ errors: { ...s.errors, [dir]: String(e) } }));
    }
  },

  toggle(dir) {
    const open = !get().expanded[dir];
    set((s) => ({ expanded: { ...s.expanded, [dir]: open } }));
    if (open && !get().children[dir]) void get().load(dir);
  },

  expand(dir) {
    if (get().expanded[dir]) return;
    set((s) => ({ expanded: { ...s.expanded, [dir]: true } }));
    if (!get().children[dir]) void get().load(dir);
  },

  refresh(paths) {
    const loaded = get().children;
    const dirs = new Set<string>();
    for (const p of paths) {
      const parent = parentOf(p);
      if (loaded[parent]) dirs.add(parent);
      if (loaded[p]) dirs.add(p);
    }
    for (const d of dirs) void get().load(d);
  },
}));
