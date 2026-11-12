// What the main window sends the notch, and what the notch sends back.
// Types and pure helpers only, so the notch page doesn't pull in Desk's stores.

import type { FeedAction, FeedItem } from "../feedCore";

export type { FeedAction, FeedItem };

export interface NotchUsage {
  account: string;
  name: string;
  color: string;
  tool: FeedItem["tool"];
  /** Share of the 5-hour window used, 0–100. */
  used: number;
}

export interface NotchPayload {
  /** Settings ▸ Notch ▸ Show the notch. */
  enabled: boolean;
  /** When a card opens by itself: something waits on you, also when one finishes, or never. */
  peek: "waiting" | "all" | "never";
  rings: boolean;
  /** Show a pill under the menu bar on screens without a notch. */
  otherScreens: boolean;
  reduceMotion: boolean;
  /** The feed row Desk is showing right now, if Desk is in front. It never peeks for that one. */
  onScreen: string | null;
  items: FeedItem[];
  usage: NotchUsage[];
  /** A sample feed from Settings, so you can see the notch without a running agent. */
  preview: boolean;
}

export interface NotchGeometry {
  hasNotch: boolean;
  notchWidth: number;
  notchHeight: number;
  top: number;
}

export const EMPTY_PAYLOAD: NotchPayload = {
  enabled: false, peek: "waiting", rings: true, otherScreens: true, reduceMotion: false, onScreen: null, items: [], usage: [], preview: false,
};

/** A believable feed for the preview: one waiting, two working, one finished. */
export function sampleFeed(now: number): FeedItem[] {
  const base = { kind: "chat" as const, where: "local", account: null, canReply: true, approval: null };
  return [
    {
      ...base, id: "preview:1", tool: "claude", title: "Fix flaky auth test", project: "desk", accountColor: "#0297de", state: "waiting", since: now - 4 * 60_000,
      activity: "", approval: { requestId: "preview", tool: "Bash", summary: "npm test -- --runInBand auth", plan: false },
    },
    { ...base, id: "preview:2", tool: "codex", title: "Migrate settings store", project: "studio", accountColor: "#fc734d", state: "working", since: now - 12 * 60_000, activity: "Edit src/settings/store.ts" },
    { ...base, id: "preview:3", tool: "gemini", title: "Write release notes", project: "desk", accountColor: null, state: "working", since: now - 60_000, activity: "…grouping the changes by area before writing" },
    { ...base, id: "preview:4", tool: "claude", title: "Add CSV export", project: "desk", accountColor: "#0297de", state: "done", since: null, activity: "Added an Export button to the table header." },
  ];
}

/** "now", "4m", "1h 05m". */
export function elapsed(since: number | null, now: number): string {
  if (!since) return "";
  const minutes = Math.floor((now - since) / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** The row a reply goes to: the selected one if it takes replies, else the first chat. */
export function replyTarget(items: FeedItem[], selected: string | null): FeedItem | null {
  const pick = items.find((i) => i.id === selected && i.canReply);
  return pick ?? items.find((i) => i.canReply) ?? null;
}

/** Ids that just started waiting (or finished, when peeking on everything), to open a card for. */
export function newPeeks(prev: FeedItem[], next: FeedItem[], mode: NotchPayload["peek"], onScreen: string | null): string[] {
  if (mode === "never") return [];
  const before = new Map(prev.map((i) => [i.id, i.state]));
  return next
    .filter((i) => i.id !== onScreen && before.get(i.id) !== i.state && (i.state === "waiting" || (mode === "all" && i.state === "done")))
    .map((i) => i.id);
}
