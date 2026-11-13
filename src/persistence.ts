import { ipc } from "./ipc";
import { persistedSlice, useDesk } from "./store";
import { WINDOW_KEYS, isMain, windowKey } from "./windows";

/** Where this window keeps a copy in case the disk save didn't finish. */
export const RECOVERY_KEY = windowKey("desk-recovery-v2");

let queue = Promise.resolve();
let timer: number | undefined;

/**
 * What this window saves. The main window saves everything (state.json); an
 * extra window only its own projects, tabs, layout and view, since the main
 * window saves what they share (see windows.ts).
 */
function saved(s = useDesk.getState()) {
  const all = persistedSlice(s);
  if (isMain) return all;
  const own: Record<string, unknown> = { version: all.version, uiMode: s.preferences.uiMode };
  for (const key of WINDOW_KEYS) own[key] = all[key];
  return own;
}
function snapshot() { return { ...saved(), savedAt: Date.now() }; }
function write(value: ReturnType<typeof snapshot>) {
  const pending = queue.catch(() => {}).then(() => ipc.stateSave(value));
  queue = pending;
  return pending;
}
/** Flush the newest snapshot after queued writes before allowing native quit. */
export async function flushWorkspace() {
  clearTimeout(timer);
  if (!useDesk.getState().loaded) throw new Error("Desk is still restoring your workspace. Try quitting again in a moment.");
  const value = snapshot();
  try { localStorage.setItem(RECOVERY_KEY, JSON.stringify(value)); } catch { /* Native save is authoritative. */ }
  await write(value);
}
export function persistWorkspace() {
  let last = "";
  const unsubscribe = useDesk.subscribe((s) => {
    if (!s.loaded) return;
    const data = saved(s);
    const json = JSON.stringify(data);
    if (json === last) return;
    last = json;
    const value = { ...data, savedAt: Date.now() };
    try { localStorage.setItem(RECOVERY_KEY, JSON.stringify(value)); } catch { /* Native save remains available. */ }
    clearTimeout(timer);
    timer = window.setTimeout(() => { void write(value).catch(() => useDesk.getState().toast("Workspace recovery couldn't be saved to disk.", "error")); }, 200);
  });
  return () => { unsubscribe(); clearTimeout(timer); };
}
