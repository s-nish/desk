// Feeds Desk's menu bar icon: the chats and terminal tabs that are working or
// waiting on you. The menu is native (tray.rs); this decides what goes in it,
// and shows the one you click.

import { listen } from "@tauri-apps/api/event";
import { ipc } from "./ipc";
import { TOOL_LABEL, useDesk } from "./store";
import { useChats } from "./chat";
import { buildFeed, openFeedItem } from "./feed";

export interface TrayItem { id: string; label: string; detail: string; waiting: boolean }

/** "42s", "9m", "1h 05m". Minutes at most, so the menu changes once a minute. */
function since(ms: number | null | undefined) {
  if (!ms) return "";
  const minutes = Math.floor((Date.now() - ms) / 60000);
  if (minutes < 1) return "just started";
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** The menu shows what is working or waiting; finished chats stay off it. */
export function activeAgents(): TrayItem[] {
  return buildFeed()
    .filter((item) => item.state !== "done")
    .map((item) => {
      const waiting = item.state === "waiting";
      const detail = item.kind === "chat"
        ? [TOOL_LABEL[item.tool], item.project, waiting ? "" : since(item.since)]
        : [`${TOOL_LABEL[item.tool]} (terminal)`, item.project];
      return { id: item.id, label: item.title, detail: detail.filter(Boolean).join(" · "), waiting };
    });
}

export const openTrayItem = openFeedItem;

/** Keeps the menu up to date. Returns a function that stops it. */
export function watchTray() {
  let last = "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  const push = () => {
    timer = null;
    const items = activeAgents();
    const key = JSON.stringify(items);
    if (key === last) return;
    last = key;
    void ipc.trayUpdate(items).catch(() => {});
  };
  const schedule = () => { if (!timer) timer = setTimeout(push, 250); };
  const offChats = useChats.subscribe(schedule);
  const offDesk = useDesk.subscribe(schedule);
  // Timers in the menu move once a minute.
  const tick = setInterval(push, 30_000);
  const unlisten = listen<string>("tray-open", ({ payload }) => openTrayItem(payload));
  schedule();
  return () => {
    offChats();
    offDesk();
    clearInterval(tick);
    if (timer) clearTimeout(timer);
    void unlisten.then((f) => f()).catch(() => {});
  };
}
