import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { useDesk } from "./store";

/** What to show when you come back to Desk after a notification (clicking it brings Desk forward). */
let pending: (() => void) | null = null;
let allowed: boolean | null = null;

async function permitted() {
  if (allowed !== null) return allowed;
  try {
    allowed = (await isPermissionGranted()) || (await requestPermission()) === "granted";
  } catch {
    allowed = false;
  }
  return allowed;
}

/** A macOS notification, only while Desk is in the background. `show` runs when you come back. */
export function notify(title: string, body: string, show?: () => void) {
  if (!useDesk.getState().preferences.systemNotifications || document.hasFocus()) return;
  pending = show ?? null;
  void permitted().then((ok) => { if (ok) sendNotification({ title, body }); });
}

/** Called when Desk comes forward: shows whatever the last notification was about. */
export function takeNotified() {
  const show = pending;
  pending = null;
  show?.();
}

/** Desk came forward on its own (not through a notification): forget it. */
export function clearNotified() {
  pending = null;
}
