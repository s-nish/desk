// What Desk sends the phone page, and what the phone sends back. Types only, so
// the phone's bundle doesn't pull in Desk's stores.

import type { FeedApproval } from "../feedCore";
import type { NotchUsage } from "../notch/protocol";
import type { Agent } from "../types";

export type PhoneState = "waiting" | "working" | "done" | "idle";

/** Where a session runs: this Mac, or a sandbox (its provider id, for the logo). */
export interface PhoneWhere {
  provider: "mac" | "docker" | "dockerCloud" | "boat" | "modal";
  label: string;
  /** In a sandbox: the agent runs there ("agent"), or here with the code there ("code"). */
  mode?: "agent" | "code";
}

export interface PhoneSession {
  /** "c:<chatId>" or "t:<tabId>". */
  id: string;
  kind: "chat" | "terminal";
  tool: Agent;
  title: string;
  project: string;
  projectId: string;
  where: PhoneWhere;
  state: PhoneState;
  /** When the current turn started (ms), for the timer. */
  since: number | null;
  /** Last change (ms), for ordering and "2m ago". */
  updated: number;
  /** One line: the running step, or the end of the last answer. */
  activity: string;
  approval: FeedApproval | null;
  canReply: boolean;
  canStop: boolean;
  unread: boolean;
  /** Messages typed while it was busy, waiting their turn. */
  queued: number;
}

export type PhoneEntry =
  | { kind: "user"; id: string; text: string; files?: string[] }
  | { kind: "assistant"; id: string; text: string; streaming?: boolean }
  | { kind: "tool"; id: string; name: string; summary: string; state: "running" | "done" | "error"; output?: string }
  | { kind: "approval"; id: string; tool: string; summary: string; state: "pending" | "allowed" | "denied" | "expired" }
  | { kind: "notice"; id: string; text: string; tone?: "error" };

export type PhoneThread =
  | { kind: "chat"; entries: PhoneEntry[]; truncated: boolean }
  | { kind: "terminal"; screen: string };

export interface PhonePayload {
  sessions: PhoneSession[];
  usage: NotchUsage[];
  /** Only the sessions a phone has open right now. */
  threads: Record<string, PhoneThread>;
}

export type PhoneAction =
  | { type: "answer"; id: string; requestId: string; allow: boolean }
  | { type: "reply"; id: string; text: string }
  | { type: "stop"; id: string }
  | { type: "seen"; id: string }
  /** The phone has this session open: send its messages for a while. */
  | { type: "watch"; id: string };
