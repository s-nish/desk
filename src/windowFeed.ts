// In Desk's extra windows: tells the main window about this window's agents, so
// the menu bar icon, the notch, the phone and the Dock badge show them, and
// applies the clicks and replies meant for them. (The main window does both for
// its own in notchBridge.ts, tray.ts and phoneBridge.ts.)

import { emitTo, listen } from "@tauri-apps/api/event";
import { useDesk, waitingTabs } from "./store";
import { useChats } from "./chat";
import { applyFeedAction, buildFeed, openFeedItem } from "./feed";
import { onScreen } from "./notchBridge";
import { applyPhoneAction, phonePayload, watchingTerminal } from "./phoneBridge";
import { localBusySandboxes } from "./sandbox";
import { WINDOW, type WindowFeed } from "./windows";
import type { FeedAction } from "./notch/protocol";
import type { PhoneAction } from "./remote/protocol";

export function reportFeed() {
  let last = "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  const push = () => {
    timer = null;
    const phone = phonePayload();
    const feed: WindowFeed = {
      label: WINDOW,
      items: buildFeed(),
      onScreen: onScreen(),
      sessions: phone.sessions,
      threads: phone.threads,
      busy: localBusySandboxes(),
      waiting: waitingTabs(useDesk.getState()).length,
    };
    const key = JSON.stringify(feed);
    if (key === last) return;
    last = key;
    void emitTo("main", "window-feed", feed).catch(() => {});
  };
  const schedule = () => { if (!timer) timer = setTimeout(push, 150); };
  const offChats = useChats.subscribe(schedule);
  const offDesk = useDesk.subscribe(schedule);
  window.addEventListener("focus", schedule);
  window.addEventListener("blur", schedule);
  // Terminal screens a phone has open aren't in a store; the rest is a safety net.
  const tick = setInterval(() => { if (watchingTerminal()) schedule(); }, 1_000);
  const slow = setInterval(() => { last = ""; push(); }, 20_000);
  const offs = [
    // Each goes to every window; only the one that has the chat or tab acts on it.
    listen<FeedAction>("notch-action", ({ payload }) => { if (!payload.id.startsWith("preview:")) applyFeedAction(payload); }),
    listen<PhoneAction>("remote-action", ({ payload }) => { applyPhoneAction(payload); if (payload.type === "watch") { last = ""; schedule(); } }),
    listen<string>("tray-open", ({ payload }) => openFeedItem(payload)),
  ];
  schedule();
  return () => {
    offChats();
    offDesk();
    window.removeEventListener("focus", schedule);
    window.removeEventListener("blur", schedule);
    clearInterval(tick);
    clearInterval(slow);
    if (timer) clearTimeout(timer);
    offs.forEach((p) => void p.then((f) => f()).catch(() => {}));
  };
}
