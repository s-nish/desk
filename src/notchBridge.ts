// Sends the agent feed to the notch window and applies what you click there.

import { listen } from "@tauri-apps/api/event";
import { ipc } from "./ipc";
import { focusedTabId, limitKey, useDesk } from "./store";
import { useChats } from "./chat";
import { applyFeedAction, buildFeed } from "./feed";
import { sampleFeed, type FeedAction, type NotchPayload, type NotchUsage } from "./notch/protocol";

const PREVIEW_MS = 60_000;
let previewUntil = 0;
let schedule: (() => void) | null = null;

/** Shows a sample feed in the notch for a few seconds (Settings ▸ Notch ▸ Preview). */
export function previewNotch() {
  previewUntil = Date.now() + PREVIEW_MS;
  schedule?.();
  setTimeout(() => schedule?.(), PREVIEW_MS + 50);
}

/** The feed row Desk shows right now, if Desk is in front. */
function onScreen(): string | null {
  if (typeof document === "undefined" || !document.hasFocus()) return null;
  const desk = useDesk.getState();
  if (desk.preferences.uiMode === "chat") {
    const { activeId, termId } = useChats.getState();
    return termId ? `t:${termId}` : activeId ? `c:${activeId}` : null;
  }
  const tab = focusedTabId(desk);
  return tab ? `t:${tab}` : null;
}

export function notchPayload(now = Date.now()): NotchPayload {
  const desk = useDesk.getState();
  const prefs = desk.preferences;
  const preview = now < previewUntil;
  const items = preview ? sampleFeed(now) : buildFeed();
  const usage: NotchUsage[] = [];
  for (const id of new Set(items.map((i) => i.account).filter((a): a is string => !!a))) {
    const account = desk.accounts.find((a) => a.id === id);
    if (!account || (account.kind !== "claude" && account.kind !== "codex")) continue;
    const session = desk.limits[limitKey(account.kind, account.dir)]?.session;
    if (!session) continue;
    const used = session.resetsAt && session.resetsAt <= now ? 0 : session.used;
    usage.push({ account: id, name: account.name, color: account.color, tool: account.kind, used });
  }
  return {
    enabled: prefs.notch !== false || preview,
    peek: prefs.notchPeek ?? "waiting",
    rings: prefs.notchRings !== false,
    otherScreens: prefs.notchOnOtherScreens !== false || preview,
    reduceMotion: !!prefs.reduceMotion,
    onScreen: onScreen(),
    items,
    usage,
    preview,
  };
}

/** Keeps the notch up to date. Returns a function that stops it. */
export function watchNotch() {
  let last = "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  const push = () => {
    timer = null;
    const payload = notchPayload();
    const key = JSON.stringify(payload);
    if (key === last) return;
    last = key;
    void ipc.notchUpdate(payload).catch(() => {});
  };
  // Quicker than the tray: a permission question should reach the notch at once.
  schedule = () => { if (!timer) timer = setTimeout(push, 80); };
  const offChats = useChats.subscribe(() => schedule?.());
  const offDesk = useDesk.subscribe(() => schedule?.());
  const onFocus = () => schedule?.();
  window.addEventListener("focus", onFocus);
  window.addEventListener("blur", onFocus);
  const tick = setInterval(push, 30_000);
  const unlisten = listen<FeedAction>("notch-action", ({ payload }) => {
    // The preview's rows aren't real; clicking them does nothing.
    if (payload.id.startsWith("preview:")) return;
    applyFeedAction(payload);
  });
  schedule();
  return () => {
    offChats();
    offDesk();
    window.removeEventListener("focus", onFocus);
    window.removeEventListener("blur", onFocus);
    clearInterval(tick);
    if (timer) clearTimeout(timer);
    schedule = null;
    void unlisten.then((f) => f()).catch(() => {});
  };
}
