// The agent feed: every chat and terminal tab that is working, waiting on you,
// or finished while you weren't looking. The tray menu, the notch and the phone
// page all read this one list. Pure: no Tauri, no stores, so tests import it.

import type { Chat } from "./chat";
import type { Account, Agent, Project, Tab, TerminalTab } from "./types";

export type FeedState = "working" | "waiting" | "done";

export interface FeedApproval {
  requestId: string;
  tool: string;
  summary: string;
  /** Claude Code's "plan ready" question (ExitPlanMode), answered Approve / Keep planning. */
  plan: boolean;
}

export interface FeedItem {
  /** "c:<chatId>" or "t:<tabId>", the same ids the tray menu uses. */
  id: string;
  kind: "chat" | "terminal";
  tool: Agent;
  title: string;
  project: string;
  accountColor: string | null;
  /** "local" for now; sandbox providers join later. */
  where: string;
  state: FeedState;
  /** When the current turn started (ms epoch), for the timer. */
  since: number | null;
  /** What it is doing right now: the running tool, or the end of the answer. */
  activity: string;
  approval: FeedApproval | null;
  /** Chats can always take a reply (queued while busy); terminal tabs can't yet. */
  canReply: boolean;
}

export type FeedAction =
  | { type: "answer"; id: string; requestId: string; allow: boolean }
  | { type: "reply"; id: string; text: string }
  | { type: "stop"; id: string }
  | { type: "open"; id: string }
  | { type: "seen"; id: string };

export interface FeedInput {
  chats: Chat[];
  tabs: Tab[];
  projects: Project[];
  accounts: Account[];
  /** Label for a terminal tab with no title of its own. */
  label: (tool: Agent) => string;
  /** A terminal tab's title, cleaned of the agent's spinner glyphs. */
  tabTitle: (tab: TerminalTab) => string;
}

/** "waiting" when a permission question is open, "running" while a turn runs, else null. */
export function chatBusy(chat: Chat | undefined): "waiting" | "running" | null {
  if (!chat) return null;
  if (chat.items.some((i) => i.kind === "approval" && i.state === "pending")) return "waiting";
  return chat.status === "idle" ? null : "running";
}

const ACTIVITY_CHARS = 80;

/** The running tool's summary, else the last words of the answer so far. */
export function chatActivity(chat: Chat): string {
  for (let i = chat.items.length - 1; i >= 0; i--) {
    const item = chat.items[i];
    if (item.kind === "tool" && item.state === "running") return [item.name, item.summary].filter(Boolean).join(" ");
    if (item.kind === "user") break;
  }
  for (let i = chat.items.length - 1; i >= 0; i--) {
    const item = chat.items[i];
    if (item.kind === "assistant") {
      const text = item.text.trim().split(/\s+/).join(" ");
      return text.length > ACTIVITY_CHARS ? "…" + text.slice(-(ACTIVITY_CHARS - 1)) : text;
    }
    if (item.kind === "user") break;
  }
  return "";
}

function pendingApproval(chat: Chat): FeedApproval | null {
  const item = chat.items.find((i) => i.kind === "approval" && i.state === "pending");
  if (item?.kind !== "approval") return null;
  return { requestId: item.id, tool: item.tool, summary: item.summary, plan: item.tool === "ExitPlanMode" };
}

const ORDER: Record<FeedState, number> = { waiting: 0, working: 1, done: 2 };

export function buildFeedFrom(input: FeedInput): FeedItem[] {
  const projectName = (id: string) => input.projects.find((p) => p.id === id)?.name ?? "Desk";
  const color = (id: string | null | undefined) => (id ? input.accounts.find((a) => a.id === id)?.color ?? null : null);
  const items: FeedItem[] = [];
  for (const chat of input.chats) {
    const busy = chatBusy(chat);
    if (!busy && !chat.unread) continue;
    const state: FeedState = busy === "waiting" ? "waiting" : busy ? "working" : "done";
    items.push({
      id: `c:${chat.id}`,
      kind: "chat",
      tool: chat.tool,
      title: chat.title || "New chat",
      project: projectName(chat.projectId),
      accountColor: color(chat.accountId),
      where: "local",
      state,
      since: busy ? chat.startedAt : null,
      activity: chatActivity(chat),
      approval: state === "waiting" ? pendingApproval(chat) : null,
      canReply: true,
    });
  }
  for (const tab of input.tabs) {
    if (tab.type !== "terminal" || tab.tool === "shell" || tab.sshId) continue;
    const waiting = !!tab.attention;
    if (!waiting && !(tab.busy && tab.status === "running")) continue;
    const tool = tab.tool as Agent;
    items.push({
      id: `t:${tab.id}`,
      kind: "terminal",
      tool,
      title: input.tabTitle(tab) || input.label(tool),
      project: projectName(tab.projectId),
      accountColor: color(tab.runAs?.[tool] ?? tab.accountId),
      where: "local",
      state: waiting ? "waiting" : "working",
      since: null,
      activity: waiting ? tab.attention ?? "" : "",
      approval: null,
      canReply: false,
    });
  }
  // Stable: within a group, chats keep their order, then terminal tabs.
  return items.sort((a, b) => ORDER[a.state] - ORDER[b.state]);
}
