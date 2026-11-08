// Feeds Desk's menu bar icon: the chats and terminal tabs that are working or
// waiting on you. The menu is native (tray.rs); this decides what goes in it,
// and shows the one you click.

import { listen } from "@tauri-apps/api/event";
import { ipc } from "./ipc";
import { TOOL_LABEL, chatView, useDesk } from "./store";
import { chatBusy, showChat, showStripTab, useChats } from "./chat";
import { cleanTitle } from "./components/Workspace";

export interface TrayItem { id: string; label: string; detail: string; waiting: boolean }

/** "42s", "9m", "1h 05m". Minutes at most, so the menu changes once a minute. */
function since(ms: number | null | undefined) {
  if (!ms) return "";
  const minutes = Math.floor((Date.now() - ms) / 60000);
  if (minutes < 1) return "just started";
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export function activeAgents(): TrayItem[] {
  const desk = useDesk.getState();
  const projectName = (id: string) => desk.projects.find((p) => p.id === id)?.name ?? "Desk";
  const items: TrayItem[] = [];
  for (const chat of Object.values(useChats.getState().chats)) {
    const busy = chatBusy(chat);
    if (!busy) continue;
    const waiting = busy === "waiting";
    items.push({
      id: `c:${chat.id}`,
      label: chat.title || "New chat",
      detail: [TOOL_LABEL[chat.tool], projectName(chat.projectId), waiting ? "" : since(chat.startedAt)].filter(Boolean).join(" · "),
      waiting,
    });
  }
  for (const tab of desk.tabs) {
    if (tab.type !== "terminal" || tab.tool === "shell" || tab.sshId) continue;
    const waiting = !!tab.attention;
    if (!waiting && !(tab.busy && tab.status === "running")) continue;
    items.push({
      id: `t:${tab.id}`,
      label: cleanTitle(tab.title) || TOOL_LABEL[tab.tool],
      detail: [`${TOOL_LABEL[tab.tool]} (terminal)`, projectName(tab.projectId)].join(" · "),
      waiting,
    });
  }
  return items.sort((a, b) => Number(b.waiting) - Number(a.waiting));
}

/** Shows what a menu row points at: a chat, or a terminal tab in whichever view is on. */
export function openTrayItem(id: string) {
  const desk = useDesk.getState();
  if (id.startsWith("c:")) {
    if (useChats.getState().chats[id.slice(2)]) showChat(id.slice(2));
    return;
  }
  const tab = desk.tabs.find((t) => t.id === id.slice(2));
  if (!tab) return;
  if (desk.preferences.uiMode === "chat") {
    chatView.showTerminal?.(tab.id);
    showStripTab(`t:${tab.id}`);
  } else {
    desk.selectTab(tab.id);
  }
}

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
