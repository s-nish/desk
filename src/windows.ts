// More than one Desk window (⌘⇧N). The first is "main"; others are "w-<id>".
//
// Each window has its own projects, tabs and chats, saved in its own file. What
// every window shares (settings, accounts, SSH connections, sandboxes) is saved
// by the main window alone; when one window changes it, the others hear about it
// here and take the new value.
//
// Things there is one of (the menu bar icon, the notch, the phone remote, the
// Dock badge, stopping idle sandboxes) run in the main window. The others send it
// their agents (see windowFeed.ts), and the main window shows everyone's.

import { getCurrentWindow } from "@tauri-apps/api/window";
import { emit, listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import type { FeedItem } from "./feedCore";
import type { PhoneSession, PhoneThread } from "./remote/protocol";

export const WINDOW: string = (() => { try { return getCurrentWindow().label; } catch { return "main"; } })();
export const isMain = WINDOW === "main";

/** A storage key that is this window's own (the main window keeps the original names). */
export const windowKey = (key: string) => (isMain ? key : `${key}:${WINDOW}`);

/** Saved per window. */
export const WINDOW_KEYS = ["projects", "activeProjectId", "layout", "tabs", "activeTabId", "secondaryTabId", "focusedPane"] as const;

interface Shared {
  accounts: unknown[];
  sandboxes: unknown[];
  connections: unknown[];
  /** Without uiMode: chat or terminal view is each window's own. */
  preferences: Record<string, unknown>;
}

type SharedSource = { accounts: unknown[]; sandboxes: unknown[]; connections: unknown[]; preferences: { uiMode?: string } & object };

export function sharedSlice(s: SharedSource): Shared {
  const { uiMode: _view, ...preferences } = s.preferences as Record<string, unknown>;
  return { accounts: s.accounts, sandboxes: s.sandboxes, connections: s.connections, preferences };
}

/**
 * Keeps settings, accounts, connections and sandboxes the same in every window.
 * `read` gives this window's current values; `apply` takes another window's.
 */
export function syncShared<S extends SharedSource>(store: { getState(): S & { loaded: boolean }; subscribe(f: (s: S & { loaded: boolean }) => void): () => void; setState(p: Partial<S>): void }) {
  let last = "";
  const off = store.subscribe((s) => {
    if (!s.loaded) return;
    const shared = sharedSlice(s);
    const json = JSON.stringify(shared);
    if (json === last) return;
    const first = last === "";
    last = json;
    // The first value is what this window loaded: nothing changed yet.
    if (!first) void emit("desk-shared", { from: WINDOW, shared }).catch(() => {});
  });
  const unlisten = listen<{ from: string; shared: Shared }>("desk-shared", ({ payload }) => {
    const shared = payload?.shared;
    if (!shared || payload.from === WINDOW || !store.getState().loaded) return;
    if (!Array.isArray(shared.accounts) || !Array.isArray(shared.sandboxes) || !Array.isArray(shared.connections) || !shared.preferences || typeof shared.preferences !== "object") return;
    last = JSON.stringify(payload.shared);
    const view = store.getState().preferences.uiMode;
    store.setState({
      accounts: payload.shared.accounts,
      sandboxes: payload.shared.sandboxes,
      connections: payload.shared.connections,
      preferences: { ...payload.shared.preferences, uiMode: view },
    } as unknown as Partial<S>);
  });
  return () => { off(); void unlisten.then((f) => f()).catch(() => {}); };
}

/** What an extra window sends the main one about its agents. */
export interface WindowFeed {
  label: string;
  /** Its chats and agent tabs, as the notch and menu bar show them. */
  items: FeedItem[];
  /** The row on screen there, while that window is in front. */
  onScreen: string | null;
  /** For the phone. Threads only for the ones a phone has open. */
  sessions: PhoneSession[];
  threads: Record<string, PhoneThread>;
  /** Sandboxes it's using, so they don't stop as idle. */
  busy: string[];
  /** Terminal tabs waiting on you, for the Dock badge. */
  waiting: number;
}

/** In the main window: the other windows' latest reports. */
export const useWindowFeeds = create<{ feeds: Record<string, WindowFeed> }>(() => ({ feeds: {} }));
export const otherFeeds = () => Object.values(useWindowFeeds.getState().feeds);

function isFeed(f: unknown): f is WindowFeed {
  const x = f as WindowFeed | null;
  return !!x && typeof x.label === "string" && Array.isArray(x.items) && Array.isArray(x.sessions) && Array.isArray(x.busy)
    && !!x.threads && typeof x.threads === "object" && typeof x.waiting === "number";
}

/** The main window listens for the other windows' reports. */
export function collectFeeds() {
  const offs = [
    listen<WindowFeed>("window-feed", ({ payload }) => {
      if (!isFeed(payload) || payload.label === WINDOW) return;
      useWindowFeeds.setState((s) => ({ feeds: { ...s.feeds, [payload.label]: payload } }));
    }),
    listen<string>("window-closed", ({ payload }) => {
      if (typeof payload !== "string") return;
      useWindowFeeds.setState((s) => {
        const feeds = { ...s.feeds };
        delete feeds[payload];
        return { feeds };
      });
    }),
  ];
  return () => offs.forEach((p) => void p.then((f) => f()).catch(() => {}));
}
