// Renaming and deleting past conversations.
// Names live in Desk's preferences. Deleting a Claude Code or Codex conversation moves
// its transcript to the Trash; the ACP agents keep their own, so Desk just forgets it.
import { TOOL_LABEL, useDesk } from "./store";
import { ipc, errorText } from "./ipc";
import { closeTab } from "./actions";
import { closeChat, forgetAcp, useChats, type Chat } from "./chat";
import { isAcpAgent } from "./acp";
import type { Agent, AgentSession } from "./types";

const key = (tool: Agent, id: string) => `${tool}:${id}`;

/** The name you gave a conversation in Desk, if any. */
export function customTitle(tool: Agent, id: string | null | undefined) {
  return id ? useDesk.getState().preferences.sessionTitles?.[key(tool, id)] : undefined;
}

/** Applies your names to a freshly listed set of conversations. */
export function withTitles(list: AgentSession[]): AgentSession[] {
  const titles = useDesk.getState().preferences.sessionTitles ?? {};
  return list.map((s) => (titles[key(s.tool, s.id)] ? { ...s, title: titles[key(s.tool, s.id)] } : s));
}

/** Tells every conversation list to reload. */
function changed() {
  window.dispatchEvent(new Event("desk-sessions-changed"));
}

/** A conversation in the sidebar: a past session, an open chat, or both. */
export interface Target { tool: Agent; title: string; session?: AgentSession; chat?: Chat }

function setTitle(tool: Agent, id: string, title: string | null) {
  const s = useDesk.getState();
  const titles = { ...(s.preferences.sessionTitles ?? {}) };
  if (title) titles[key(tool, id)] = title;
  else delete titles[key(tool, id)];
  s.setPreferences({ sessionTitles: titles });
}

export function renameConversation(t: Target) {
  const id = t.session?.id ?? t.chat?.sessionId ?? null;
  useDesk.getState().setModal({
    kind: "prompt",
    title: "Rename conversation",
    label: "Name",
    initial: t.title,
    confirm: "Rename",
    select: [0, t.title.length],
    onSubmit: (value) => {
      const title = value.trim().split(/\s+/).join(" ");
      if (!title) return "Enter a name.";
      if (title.length > 120) return "Keep it under 120 characters.";
      // Saved conversations keep the name across restarts; a chat not yet saved just shows it.
      if (id && (t.session || t.chat?.saved)) setTitle(t.tool, id, title);
      if (t.chat) useChats.getState().patch(t.chat.id, { title });
      useChats.setState((s) => ({
        sessions: Object.fromEntries(Object.entries(s.sessions).map(([path, list]) => [path, list.map((x) => (x.tool === t.tool && x.id === id ? { ...x, title } : x))])),
      }));
      changed();
    },
  });
}

export function deleteConversation(t: Target) {
  const desk = useDesk.getState();
  const id = t.session?.id ?? t.chat?.sessionId ?? null;
  const saved = !!t.session || !!t.chat?.saved;
  const label = TOOL_LABEL[t.tool];
  const acp = isAcpAgent(t.tool);
  desk.setModal({
    kind: "confirm",
    title: `Delete “${t.title}”?`,
    body: !saved
      ? "This chat hasn't been saved yet. Closing it discards it."
      : acp
        ? `Desk stops listing it and its tab closes. ${label} keeps its own copy of the conversation.`
        : `Its transcript moves to the Trash, so ${label} no longer lists or resumes it, and its tab in Desk closes. You can put it back from the Trash.`,
    confirm: "Delete",
    danger: true,
    onConfirm: async () => {
      // Stop and close everything showing this conversation first.
      for (const c of Object.values(useChats.getState().chats)) {
        if (c === t.chat || (id && c.tool === t.tool && c.sessionId === id)) closeChat(c.id);
      }
      if (id) {
        for (const tab of useDesk.getState().tabs) {
          if (tab.type === "terminal" && tab.tool === t.tool && (tab.sessionId === id || tab.resume === id)) closeTab(tab.id);
        }
      }
      if (!saved || !id) return;
      if (acp) {
        forgetAcp(t.tool, id);
        setTitle(t.tool, id, null);
        useChats.setState((s) => ({
          sessions: Object.fromEntries(Object.entries(s.sessions).map(([path, list]) => [path, list.filter((x) => !(x.tool === t.tool && x.id === id))])),
        }));
        changed();
        useDesk.getState().toast("Removed from Desk.");
        return;
      }
      const dir = t.session?.dir ?? desk.accounts.find((a) => a.id === t.chat?.accountId)?.dir ?? null;
      const cwd = t.session?.cwd ?? t.chat?.cwd ?? "";
      try {
        await ipc.sessionTrash(t.tool as "claude" | "codex", dir, cwd, id);
        setTitle(t.tool, id, null);
        useChats.setState((s) => ({
          sessions: Object.fromEntries(Object.entries(s.sessions).map(([path, list]) => [path, list.filter((x) => !(x.tool === t.tool && x.id === id))])),
        }));
        changed();
        useDesk.getState().toast("Moved to the Trash.");
      } catch (e) {
        useDesk.getState().toast(`Couldn't delete it: ${errorText(e)}`, "error");
      }
    },
  });
}
