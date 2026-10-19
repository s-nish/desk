import { ipc } from "./ipc";
import { persistedSlice, useDesk } from "./store";

let queue = Promise.resolve();
let timer: number | undefined;
function snapshot() { return { ...persistedSlice(useDesk.getState()), savedAt: Date.now() }; }
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
  try { localStorage.setItem("desk-recovery-v2", JSON.stringify(value)); } catch { /* Native save is authoritative. */ }
  await write(value);
}
export function persistWorkspace() {
  let last = "";
  const unsubscribe = useDesk.subscribe((s) => {
    if (!s.loaded) return;
    const data = persistedSlice(s);
    const json = JSON.stringify(data);
    if (json === last) return;
    last = json;
    const value = { ...data, savedAt: Date.now() };
    try { localStorage.setItem("desk-recovery-v2", JSON.stringify(value)); } catch { /* Native save remains available. */ }
    clearTimeout(timer);
    timer = window.setTimeout(() => { void write(value).catch(() => useDesk.getState().toast("Workspace recovery couldn't be saved to disk.", "error")); }, 200);
  });
  return () => { unsubscribe(); clearTimeout(timer); };
}
