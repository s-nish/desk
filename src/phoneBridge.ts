// Sends the phone page (remote.rs serves it over your tailnet) every open chat
// and agent tab, and the full conversation of the ones a phone has open. Applies
// what the phone sends back: allow once, deny, reply, stop, seen, watch.

import { listen } from "@tauri-apps/api/event";
import { ipc } from "./ipc";
import { TOOL_LABEL, useDesk } from "./store";
import { answer, canAllowOnce, enqueue, markUnread, send, stop, useChats, type Chat, type ChatItem } from "./chat";
import { chatActivity, chatBusy } from "./feedCore";
import { cleanTitle } from "./components/Workspace";
import { notchPayload } from "./notchBridge";
import { provider } from "./sandbox/providers";
import { chatSandboxMode } from "./sandbox/bridge";
import { interruptTerminal, terminalScreen, typeIntoTerminal } from "./terminals";
import type { PhoneAction, PhoneEntry, PhonePayload, PhoneSession, PhoneState, PhoneThread, PhoneWhere } from "./remote/protocol";
import type { TerminalTab } from "./types";

/** How long a phone's "I have this open" lasts; the page renews it while open. */
const WATCH_MS = 45_000;
const ENTRIES = 200;
const TEXT_MAX = 16_000;
const OUTPUT_MAX = 1_500;

const watched = new Map<string, number>();
/** When each session last changed, for ordering and "2m ago". */
const changedAt = new Map<string, { sig: string; at: number }>();

function touched(id: string, sig: string) {
  const was = changedAt.get(id);
  if (was?.sig === sig) return was.at;
  const at = was ? Date.now() : Date.now() - 1;
  changedAt.set(id, { sig, at });
  return at;
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}\n…` : text);

function whereOf(sandboxId: string | null | undefined, mode?: "agent" | "code" | null): PhoneWhere {
  const sandbox = sandboxId ? useDesk.getState().sandboxes.find((x) => x.id === sandboxId) : null;
  if (!sandbox) return { provider: "mac", label: "This Mac" };
  return { provider: sandbox.provider, label: `${provider(sandbox.provider)?.label ?? sandbox.provider} · ${sandbox.name}`, mode: mode ?? undefined };
}

function chatEntry(item: ChatItem): PhoneEntry {
  switch (item.kind) {
    case "user": return { kind: "user", id: item.id, text: clip(item.text, TEXT_MAX), ...(item.attachments?.length ? { files: item.attachments.map((a) => a.name) } : {}) };
    case "assistant": return { kind: "assistant", id: item.id, text: clip(item.text, TEXT_MAX), ...(item.streaming ? { streaming: true } : {}) };
    case "tool": return { kind: "tool", id: item.id, name: item.name, summary: clip(item.summary, 400), state: item.state, ...(item.output ? { output: clip(item.output, OUTPUT_MAX) } : {}) };
    case "approval": return { kind: "approval", id: item.id, tool: item.tool, summary: clip(item.summary, 2_000), state: item.state };
    case "notice": return { kind: "notice", id: item.id, text: clip(item.text, 2_000), ...(item.tone ? { tone: item.tone } : {}) };
  }
}

function chatSession(chat: Chat): PhoneSession {
  const desk = useDesk.getState();
  const project = desk.projects.find((p) => p.id === chat.projectId);
  const busy = chatBusy(chat);
  const state: PhoneState = busy === "waiting" ? "waiting" : busy ? "working" : chat.unread ? "done" : "idle";
  const last = chat.items[chat.items.length - 1];
  const approval = chat.items.find((i) => i.kind === "approval" && i.state === "pending");
  return {
    id: `c:${chat.id}`,
    kind: "chat",
    tool: chat.tool,
    title: chat.title || "New chat",
    project: project?.name ?? "Desk",
    projectId: project?.worktreeOf ?? chat.projectId,
    where: whereOf(chat.where, chatSandboxMode(chat)),
    state,
    since: busy ? chat.startedAt : null,
    updated: touched(`c:${chat.id}`, `${chat.items.length}:${last?.kind === "assistant" ? last.text.length : ""}:${chat.status}`),
    activity: chatActivity(chat) || (last?.kind === "user" ? `You: ${last.text}` : ""),
    approval: approval?.kind === "approval" ? { requestId: approval.id, tool: approval.tool, summary: approval.summary, plan: approval.tool === "ExitPlanMode", allowOnce: canAllowOnce(approval.id) } : null,
    canReply: true,
    canStop: chat.status !== "idle",
    unread: !!chat.unread,
    queued: chat.queue?.length ?? 0,
  };
}

function tabSession(tab: TerminalTab): PhoneSession {
  const desk = useDesk.getState();
  const project = desk.projects.find((p) => p.id === tab.projectId);
  const waiting = !!tab.attention;
  const working = !!tab.busy && tab.status === "running";
  const running = tab.status === "running";
  return {
    id: `t:${tab.id}`,
    kind: "terminal",
    tool: tab.tool as PhoneSession["tool"],
    title: cleanTitle(tab.title) || TOOL_LABEL[tab.tool],
    project: project?.name ?? "Desk",
    projectId: project?.worktreeOf ?? tab.projectId,
    where: whereOf(tab.sandboxId ?? tab.codeSandbox, tab.sandboxId ? "agent" : tab.codeSandbox ? "code" : null),
    state: waiting ? "waiting" : working ? "working" : "idle",
    since: null,
    updated: touched(`t:${tab.id}`, `${tab.title}:${waiting}:${working}:${tab.status}`),
    activity: waiting ? tab.attention ?? "" : working ? "Working…" : running ? "In a terminal tab" : "Ended",
    approval: null,
    canReply: running,
    canStop: running && working,
    unread: false,
    queued: 0,
  };
}

const ORDER: Record<PhoneState, number> = { waiting: 0, working: 1, done: 2, idle: 3 };

export function phonePayload(now = Date.now()): PhonePayload {
  const desk = useDesk.getState();
  const chats = Object.values(useChats.getState().chats).filter((c) => c.items.length || c.status !== "idle");
  const tabs = desk.tabs.filter((t): t is TerminalTab => t.type === "terminal" && t.tool !== "shell" && !t.sshId && t.status !== "exited");
  const sessions = [...chats.map(chatSession), ...tabs.map(tabSession)].sort((a, b) => ORDER[a.state] - ORDER[b.state] || b.updated - a.updated);
  const threads: Record<string, PhoneThread> = {};
  for (const [id, until] of watched) {
    if (until < now) { watched.delete(id); continue; }
    if (id.startsWith("c:")) {
      const chat = useChats.getState().chats[id.slice(2)];
      if (!chat) continue;
      const items = chat.items.slice(-ENTRIES);
      threads[id] = { kind: "chat", entries: items.map(chatEntry), truncated: chat.items.length > ENTRIES || chat.truncated };
    } else if (id.startsWith("t:")) {
      const screen = terminalScreen(id.slice(2), 80);
      if (screen != null) threads[id] = { kind: "terminal", screen };
    }
  }
  return { sessions, usage: notchPayload(now).usage, threads };
}

/**
 * What the phone may type into an agent's terminal: one line of plain text. No
 * control or escape characters (they could drive the screen or quit the agent),
 * and not "!", which runs a shell command in Claude Code without asking.
 */
export function terminalText(text: string) {
  const line = text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim();
  return line.startsWith("!") ? "" : line.slice(0, 4_000);
}

function agentTab(id: string) {
  const tab = useDesk.getState().tabs.find((t) => t.id === id.slice(2));
  return tab?.type === "terminal" && tab.tool !== "shell" && !tab.sshId ? tab : null;
}

/** What the phone asked for. remote.rs has already refused anything else. */
export function applyPhoneAction(action: PhoneAction) {
  if (action.id.startsWith("preview:")) return;
  const chat = action.id.startsWith("c:") ? useChats.getState().chats[action.id.slice(2)] : undefined;
  const tab = action.id.startsWith("t:") ? agentTab(action.id) : null;
  switch (action.type) {
    case "watch":
      if (chat || tab) watched.set(action.id, Date.now() + WATCH_MS);
      return;
    case "answer":
      // Never a standing "always allow" from the phone.
      if (chat) answer(chat.id, action.requestId, action.allow, true);
      return;
    case "reply":
      if (!action.text.trim()) return;
      if (chat) { if (chat.status === "idle") void send(chat.id, action.text); else enqueue(chat.id, action.text); }
      else if (tab?.status === "running") { const text = terminalText(action.text); if (text) typeIntoTerminal(tab.id, text); }
      return;
    case "stop":
      if (chat) stop(chat.id);
      else if (tab) interruptTerminal(tab.id);
      return;
    case "seen":
      if (chat) markUnread(chat.id, false);
      else if (tab) useDesk.getState().patchTab(tab.id, { attention: null });
      return;
  }
}

/** Keeps the phone up to date while the phone remote is on. Returns a function that stops it. */
export function watchPhone() {
  let last = "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  const push = () => {
    timer = null;
    if (!useDesk.getState().preferences.remote) return;
    const payload = phonePayload();
    const key = JSON.stringify(payload);
    if (key === last) return;
    last = key;
    void ipc.remoteUpdate(payload).catch(() => {});
  };
  // Streaming text changes many times a second; a few updates a second read as live.
  const schedule = () => { if (!timer) timer = setTimeout(push, 150); };
  const offChats = useChats.subscribe(schedule);
  const offDesk = useDesk.subscribe(schedule);
  // Terminal screens aren't in a store: look again each second while one is open on a phone.
  const tick = setInterval(() => { if ([...watched.keys()].some((k) => k.startsWith("t:"))) schedule(); }, 1_000);
  const slow = setInterval(push, 20_000);
  const unlisten = listen<PhoneAction>("remote-action", ({ payload }) => {
    applyPhoneAction(payload);
    if (payload.type === "watch") { last = ""; schedule(); }
  });
  schedule();
  return () => {
    offChats();
    offDesk();
    clearInterval(tick);
    clearInterval(slow);
    if (timer) clearTimeout(timer);
    void unlisten.then((f) => f()).catch(() => {});
  };
}
