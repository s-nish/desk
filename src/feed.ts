// The live agent feed and the actions it takes back: Allow, Deny, reply, stop,
// open, mark seen. The tray menu, the notch and the phone page all go through here.

import { TOOL_LABEL, chatView, useDesk } from "./store";
import { answer, canAllowOnce, enqueue, markUnread, send, showChat, showStripTab, stop, useChats } from "./chat";
import { cleanTitle } from "./components/Workspace";
import { buildFeedFrom, type FeedAction, type FeedItem } from "./feedCore";

export type { FeedAction, FeedItem, FeedState, FeedApproval } from "./feedCore";

export function buildFeed(): FeedItem[] {
  const desk = useDesk.getState();
  const items = buildFeedFrom({
    chats: Object.values(useChats.getState().chats),
    tabs: desk.tabs,
    projects: desk.projects,
    accounts: desk.accounts,
    label: (tool) => TOOL_LABEL[tool],
    tabTitle: (tab) => cleanTitle(tab.title),
  });
  for (const item of items) if (item.approval) item.approval.allowOnce = canAllowOnce(item.approval.requestId);
  return items;
}

/** Shows what a feed row points at: a chat, or a terminal tab in whichever view is on. */
export function openFeedItem(id: string) {
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

export function applyFeedAction(action: FeedAction) {
  const chatId = action.id.startsWith("c:") ? action.id.slice(2) : null;
  const chat = chatId ? useChats.getState().chats[chatId] : undefined;
  switch (action.type) {
    case "open":
      openFeedItem(action.id);
      return;
    case "answer":
      // From outside the chat (notch, phone): never a standing "always allow".
      if (chat) answer(chat.id, action.requestId, action.allow, true);
      return;
    case "reply": {
      if (!chat || !action.text.trim()) return;
      // A busy chat queues it, exactly like typing in the composer during a turn.
      if (chat.status === "idle") void send(chat.id, action.text);
      else enqueue(chat.id, action.text);
      return;
    }
    case "stop":
      if (chat) stop(chat.id);
      return;
    case "seen":
      if (chat) markUnread(chat.id, false);
      else if (action.id.startsWith("t:")) useDesk.getState().patchTab(action.id.slice(2), { attention: null });
      return;
  }
}
