import { useEffect } from "react";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { X } from "lucide-react";
import { useDesk, focusedTabId, waitingTabs } from "./store";
import { ipc, errorText } from "./ipc";
import { RECOVERY_KEY, flushWorkspace, persistWorkspace } from "./persistence";
import { WINDOW, WINDOW_KEYS, collectFeeds, isMain, otherFeeds, syncShared, useWindowFeeds, windowKey } from "./windows";
import { reportFeed } from "./windowFeed";
import {
  activeProject,
  activeTab,
  addProjectPaths,
  addProjectsFromDialog,
  closeTab,
  disposeTab,
  handleFsChange,
  openFile,
  openTerminal,
  refreshIdentities,
  saveTab,
  watchProject,
  detectProjectAccount,
  restoreWorkspace,
  splitWorkspace,
  syncConnectionPasswords,
  flipSplit,
  jumpToWaiting,
  pruneWorktrees,
  refreshChangeCounts,
  refreshLimits,
  refreshLiveLimits,
  LIVE_LIMITS_MS,
} from "./actions";
import { isLightTheme, resolvedTheme } from "./appearance";
import { PIXEL_THEMES } from "./themeCatalog";
import { updateEditorAppearance } from "./editors";
import { clearTerminal, pasteIntoTerminal, updateTerminalAppearance } from "./terminals";
import { ChatView } from "./components/Chat";
import { takeNotified } from "./notify";
import { watchTray } from "./tray";
import { watchPhone } from "./phoneBridge";
import { watchNotch } from "./notchBridge";
import { watchSandboxes } from "./sandbox";
import { AgentSidebar } from "./components/AgentSidebar";
import { watchRemote } from "./components/Phone";
import { watchSandboxChats } from "./sandbox/chats";
import { unforward, usePorts, watchPorts } from "./sandbox/ports";
import { attach, closeChat, closeStripTab, markUnread, newChat, showStripTab, useChats } from "./chat";
import { Workspace } from "./components/Workspace";
import { BrowserPane } from "./components/Browser";
import { ProjectTools } from "./components/ProjectTools";
import { Splitter, StatusBar, TitleBar } from "./components/Chrome";
import { ModalLayer } from "./components/Modals";
import { QuickOpen } from "./components/QuickOpen";
import { CommandPalette } from "./components/CommandPalette";
import { MenuLayer } from "./components/Menu";

type Saved = Record<string, unknown> & { savedAt?: number; preferences?: Record<string, unknown>; uiMode?: string };

/** The disk copy, or the browser-storage copy when that one is newer (a save that didn't reach the disk). */
function newest(disk: unknown, key: string): Saved | null {
  const fromDisk = disk && typeof disk === "object" ? (disk as Saved) : null;
  try {
    const local = JSON.parse(localStorage.getItem(key) ?? "null") as Saved | null;
    if (local && (local.savedAt ?? 0) > (fromDisk?.savedAt ?? 0)) return local;
  } catch { /* Native state is the fallback if web storage is unavailable. */ }
  return fromDisk;
}

/**
 * What this window starts with. The main window: everything it saved. An extra
 * window: its own projects, tabs, layout and view, and what every window shares
 * from the main window's save (a new window starts with no projects).
 */
async function loadSaved(): Promise<Saved | null> {
  if (isMain) return newest(await ipc.stateLoad().catch(() => null), RECOVERY_KEY);
  const [own, main] = await Promise.all([ipc.stateLoad().catch(() => null), ipc.stateLoadMain().catch(() => null)]);
  const mine = newest(own, RECOVERY_KEY);
  const shared = newest(main, "desk-recovery-v2") ?? {};
  const out: Saved = { ...shared, projects: [], tabs: [], activeProjectId: null, activeTabId: null, secondaryTabId: null, focusedPane: "primary" };
  for (const key of WINDOW_KEYS) if (mine && key in mine) out[key] = mine[key];
  out.preferences = { ...(shared.preferences ?? {}), ...(mine?.uiMode ? { uiMode: mine.uiMode } : {}) };
  return out;
}

async function boot() {
  const [saved, detected] = await Promise.all([loadSaved(), ipc.accountsDetect().catch(() => [])]);
  useDesk.getState().init(saved as never, detected);
  await restoreWorkspace();
  await refreshIdentities();
  void syncConnectionPasswords();
  void pruneWorktrees().then(refreshChangeCounts);
  void refreshLimits().then(() => refreshLiveLimits());
  for (const p of useDesk.getState().projects) {
    void watchProject(p.id);
    void detectProjectAccount(p.id);
  }
}

function shellQuote(path: string) {
  return /^[\w@%+=:,./-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`;
}

function cycleTab(step: number) {
  const s = useDesk.getState();
  const { tabs, selectTab } = s;
  const activeTabId = focusedTabId(s);
  if (!tabs.length) return;
  const i = tabs.findIndex((t) => t.id === activeTabId);
  selectTab(tabs[(i + step + tabs.length) % tabs.length].id);
}

/** Ctrl+Tab in the chat view: through its own tabs. */
function cycleStrip(step: number) {
  const { strip, termId, activeId } = useChats.getState();
  if (!strip.length) return;
  const i = strip.indexOf(termId ? `t:${termId}` : `c:${activeId}`);
  showStripTab(strip[(i + step + strip.length) % strip.length]);
}

function cycleProject(step: number) {
  const s = useDesk.getState();
  if (!s.projects.length) return;
  const i = s.projects.findIndex((p) => p.id === s.activeProjectId);
  s.selectProject(s.projects[(i + step + s.projects.length) % s.projects.length].id);
}

function inEditor(e: KeyboardEvent) {
  return !!(e.target as HTMLElement | null)?.closest?.(".cm-editor");
}

function onKeyDown(e: KeyboardEvent) {
  const s = useDesk.getState();
  if (s.modal) return;
  if ((s.commandOpen || s.quickOpen) && !(e.metaKey && e.key.toLowerCase() === "p")) return;
  const project = activeProject();
  const tab = activeTab();
  const cmd = e.metaKey && !e.ctrlKey;
  let handled = true;

  const chat = s.preferences.uiMode === "chat";
  if (e.ctrlKey && !e.metaKey && e.key === "Tab") { if (chat) cycleStrip(e.shiftKey ? -1 : 1); else cycleTab(e.shiftKey ? -1 : 1); }
  else if (!cmd) handled = false;
  // In chat view ⌘W closes the chat, and keys that act on the hidden tabs do nothing.
  else if (chat && e.key === "w" && !e.shiftKey) {
    const { activeId, termId } = useChats.getState();
    if (termId) { closeStripTab(`t:${termId}`); closeTab(termId); }
    else if (activeId) closeChat(activeId);
  }
  else if (chat && (e.code === "Backslash" || e.code === "BracketLeft" || e.code === "BracketRight" || (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) || (!e.shiftKey && (e.key === "k" || e.key === "s")))) handled = true;
  else if (e.key.toLowerCase() === "p" && e.shiftKey) s.setCommandOpen(!s.commandOpen);
  else if (e.key.toLowerCase() === "f" && e.shiftKey) s.setLayout({ filesOpen: true, panel: "search" });
  // ⌥ changes the typed character on macOS, so match the physical key.
  else if (e.code === "Backslash" && e.altKey) flipSplit();
  else if (e.code === "Backslash") splitWorkspace();
  else if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight") && s.secondaryTabId) s.focusPane(e.key === "ArrowLeft" ? "primary" : "secondary");
  else if (e.key.toLowerCase() === "a" && e.shiftKey) jumpToWaiting();
  else if (e.key.toLowerCase() === "t" && e.shiftKey && project) s.setModal({ kind: "worktree", projectId: project.id });
  else if (e.key === ",") s.setModal({ kind: "settings" });
  // In chat view the same keys start chats; ⌘J still opens a shell tab.
  else if (chat && project && !e.shiftKey && !e.altKey && (e.key === "n" || e.key === "t" || (e.key === "d" && !inEditor(e)) || e.key === "e")) newChat(project.id, e.key === "e" ? "codex" : e.key === "n" ? undefined : "claude");
  else if (e.key === "t" && !e.shiftKey && project) openTerminal(project.id, "claude");
  // ⌘D/⌘E/⌘J open Claude Code, Codex or a shell in the selected project. In the
  // editor ⌘D keeps its "select next occurrence" meaning.
  else if (e.key === "d" && !e.shiftKey && !e.altKey && project && !inEditor(e)) openTerminal(project.id, "claude");
  else if (e.key === "e" && !e.shiftKey && !e.altKey && project) openTerminal(project.id, "codex");
  else if (e.key === "j" && !e.shiftKey && !e.altKey && project) openTerminal(project.id, "shell");
  // ⇧⌘N: a new window (the menu has it too). ⌥⌘N: a new SSH connection; ⌥ changes the typed character.
  else if (e.code === "KeyN" && e.shiftKey && !e.altKey) void ipc.windowNew().catch((err) => s.toast(errorText(err), "error"));
  else if (e.code === "KeyN" && e.altKey && !e.shiftKey) s.setModal({ kind: "ssh", id: null });
  else if (e.key === "w" && !e.shiftKey) tab && closeTab(tab.id);
  else if (e.key === "s" && !e.shiftKey) tab && void saveTab(tab.id);
  else if (e.key === "p" && !e.shiftKey) project && s.setQuickOpen(!s.quickOpen);
  else if (e.key === "o" && !e.shiftKey) void addProjectsFromDialog();
  else if (e.key.toLowerCase() === "l" && e.shiftKey) s.setLayout({ browserOpen: !s.layout.browserOpen });
  else if (e.key.toLowerCase() === "b") s.setLayout(e.shiftKey ? { filesOpen: !s.layout.filesOpen } : { sidebarOpen: !s.layout.sidebarOpen });
  else if (e.key === "k" && !e.shiftKey && tab?.type === "terminal") clearTerminal(tab.id);
  else if (e.code === "BracketLeft" && e.shiftKey) cycleTab(-1);
  else if (e.code === "BracketRight" && e.shiftKey) cycleTab(1);
  else if (e.altKey && e.key === "ArrowUp") cycleProject(-1);
  else if (e.altKey && e.key === "ArrowDown") cycleProject(1);
  else if (/^[1-9]$/.test(e.key)) {
    const target = e.key === "9" ? s.tabs[s.tabs.length - 1] : s.tabs[Number(e.key) - 1];
    if (target) s.selectTab(target.id);
  } else handled = false;

  if (handled) {
    e.preventDefault();
    e.stopPropagation();
  }
}

/** Keeps the Dock badge in step with waiting agents, and bounces once for a new one in the background. */
function watchAttention() {
  let last = 0;
  const update = () => {
    const s = useDesk.getState();
    // Every window's: the others send theirs (see windows.ts).
    const count = waitingTabs(s).length + otherFeeds().reduce((n, f) => n + f.waiting, 0);
    if (count === last) return;
    const grew = count > last;
    last = count;
    const { alertBadge, alertBounce } = s.preferences;
    void ipc.attention(alertBadge ? count : 0, grew && alertBounce && !document.hasFocus()).catch(() => {});
  };
  const offDesk = useDesk.subscribe(update);
  const offWindows = useWindowFeeds.subscribe(update);
  return () => { offDesk(); offWindows(); };
}

/** Before quitting: the other windows save too (they answer, or Desk stops waiting after a moment). */
async function flushOtherWindows() {
  const labels = await ipc.windowLabels().catch(() => [] as string[]);
  if (!labels.length) return;
  const waiting = new Set(labels);
  let done: () => void = () => {};
  const all = new Promise<void>((resolve) => { done = resolve; });
  const off = await listen<string>("window-flushed", ({ payload }) => { waiting.delete(payload); if (!waiting.size) done(); });
  for (const label of labels) void emitTo(label, "window-flush", null).catch(() => {});
  await Promise.race([all, new Promise((r) => setTimeout(r, 1_500))]);
  off();
}

/** Closes an extra window for good, asking first if agents are running or files are unsaved. */
function closeThisWindow() {
  const s = useDesk.getState();
  const chats = Object.values(useChats.getState().chats);
  const working = chats.filter((c) => c.status !== "idle").length
    + s.tabs.filter((t) => t.type === "terminal" && t.tool !== "shell" && t.status === "running").length;
  const unsaved = s.tabs.filter((t) => t.type === "file" && t.dirty).length;
  const close = () => {
    for (const chat of chats) closeChat(chat.id);
    for (const tab of s.tabs) disposeTab(tab.id);
    for (const f of Object.values(usePorts.getState().forwards)) unforward(f);
    try {
      localStorage.removeItem(RECOVERY_KEY);
      localStorage.removeItem(windowKey("desk.sandboxChats"));
    } catch { /* Only copies. */ }
    void ipc.windowForget().catch((e) => s.toast(errorText(e), "error"));
  };
  if (!working && !unsaved) { close(); return; }
  const what = [working ? `${working} agent${working === 1 ? " is" : "s are"} still working` : "", unsaved ? `${unsaved} file${unsaved === 1 ? " has" : "s have"} unsaved changes` : ""].filter(Boolean).join(", and ");
  s.setModal({ kind: "confirm", title: "Close this window?", body: `In this window, ${what}. Closing it stops them and forgets its projects and tabs.`, confirm: "Close window", onConfirm: close });
}

/** Coming back to Desk clears the alert on whatever tabs are on screen. */
function clearVisibleAttention() {
  const s = useDesk.getState();
  for (const id of [s.activeTabId, s.secondaryTabId]) {
    const tab = s.tabs.find((t) => t.id === id);
    if (tab?.type === "terminal" && tab.attention) s.patchTab(tab.id, { attention: null });
  }
}


/** Folders dropped anywhere become projects; files dropped on a terminal are pasted as paths. */
async function onDrop(paths: string[], x: number, y: number) {
  const over = document.elementFromPoint(x, y);
  const chats = useChats.getState();
  if (over?.closest(".chat-main") && chats.activeId && !chats.termId) {
    attach(chats.activeId, paths);
    return;
  }
  const target = over?.closest<HTMLElement>(".term-host");
  if (target?.dataset.terminal) {
    pasteIntoTerminal(target.dataset.terminal, paths.map(shellQuote).join(" ") + " ");
    return;
  }
  const added = await addProjectPaths(paths);
  const project = activeProject();
  if (added === 0 && project) {
    for (const p of paths.filter((p) => p.startsWith(project.path + "/"))) void openFile(project.id, p);
  }
}

export function App() {
  const preferences = useDesk((s) => s.preferences);
  useEffect(() => {
    const apply = () => {
      document.documentElement.dataset.theme = resolvedTheme();
      document.documentElement.dataset.style = PIXEL_THEMES.has(resolvedTheme()) ? "pixel" : "plain";
      document.documentElement.dataset.colorScheme = isLightTheme() ? "light" : "dark";
      document.documentElement.dataset.density = preferences.density;
      document.documentElement.dataset.accent = preferences.accent;
      document.documentElement.dataset.accountColors = preferences.accountColors ? "on" : "off";
      document.documentElement.dataset.motion = preferences.reduceMotion ? "reduced" : "system";
      document.documentElement.dataset.accentColor = preferences.accentColor;
      document.documentElement.dataset.corners = preferences.corners;
      document.documentElement.style.setProperty("--chat-font", `${preferences.chatFontSize}px`);
      document.documentElement.style.setProperty("--chat-width", { narrow: "680px", comfortable: "820px", wide: "1040px" }[preferences.chatWidth]);
      document.documentElement.style.setProperty("--code-size", `${preferences.fontSize}px`);
      updateTerminalAppearance();
      updateEditorAppearance();
    };
    apply();
    const media = matchMedia("(prefers-color-scheme: dark)");
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    media.addEventListener("change", apply);
    motion.addEventListener("change", apply);
    return () => { media.removeEventListener("change", apply); motion.removeEventListener("change", apply); };
  }, [preferences]);

  const loaded = useDesk((s) => s.loaded);
  const layout = useDesk((s) => s.layout);
  const setLayout = useDesk((s) => s.setLayout);
  const toasts = useDesk((s) => s.toasts);

  useEffect(() => {
    void boot();
    const unsubscribe = persistWorkspace();
    let quitting = false;
    const quit = async () => {
      if (quitting) return;
      quitting = true;
      try { await flushWorkspace(); await flushOtherWindows(); await ipc.exit(); }
      catch (e) { useDesk.getState().toast(`Couldn't save workspace before quitting: ${errorText(e)}`, "error"); quitting = false; }
    };
    window.addEventListener("keydown", onKeyDown, true);
    const unshared = syncShared(useDesk);
    const unsandboxChats = watchSandboxChats();
    const unports = watchPorts();
    // One of each for all of Desk, in the main window; the other windows report to it.
    const singles = isMain
      ? [collectFeeds(), watchAttention(), watchTray(), watchNotch(), watchPhone(), watchSandboxes(), watchRemote()]
      : [reportFeed()];
    // Limits move slowly and are only re-read while Desk is on screen.
    const limits = setInterval(() => { if (!document.hidden) void refreshLimits(); }, 60_000);
    // Live numbers from Claude and Codex themselves, so they move even when nothing runs.
    const live = setInterval(() => { if (!document.hidden) void refreshLiveLimits(); }, LIVE_LIMITS_MS);
    const unlisten = [
      // ⌘Q (from any window), or closing the main window, quits Desk; the main window does it.
      listen("desk-quit", () => { if (isMain) void quit(); else void flushWorkspace().catch(() => {}); }),
      listen("window-flush", () => { void flushWorkspace().catch(() => {}).then(() => emitTo("main", "window-flushed", WINDOW)); }),
      getCurrentWindow().onCloseRequested((e) => { e.preventDefault(); if (isMain) void quit(); else closeThisWindow(); }),
      listen<{ root: string; paths: string[] }>("fs-change", ({ payload }) => handleFsChange(payload.root, payload.paths)),
      getCurrentWindow().onFocusChanged(({ payload: focused }) => {
        if (!focused) return;
        takeNotified();
        const chat = useChats.getState();
        if (useDesk.getState().preferences.uiMode === "chat" && chat.activeId && !chat.termId && chat.chats[chat.activeId]?.unread) markUnread(chat.activeId, false);
        void refreshIdentities();
        clearVisibleAttention();
        // Catches anything the file watcher can't see, like staging in a worktree from outside.
        refreshChangeCounts();
        void refreshLimits();
        void refreshLiveLimits(60_000);
      }),
      getCurrentWebview().onDragDropEvent(({ payload }) => {
        if (payload.type !== "drop") return;
        const ratio = window.devicePixelRatio || 1;
        void onDrop(payload.paths, payload.position.x / ratio, payload.position.y / ratio);
      }),
    ];
    const noContextMenu = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest("input, textarea, .cm-editor, .term-host")) e.preventDefault();
    };
    window.addEventListener("contextmenu", noContextMenu);
    return () => {
      unsubscribe();
      unshared();
      singles.forEach((f) => f());
      unsandboxChats();
      unports();
      clearInterval(limits);
      clearInterval(live);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("contextmenu", noContextMenu);
      unlisten.forEach((p) => void p.then((f) => f()));
    };
  }, []);

  if (!loaded) return <div className="app is-booting" />;

  return (
    <div className="app">
      <TitleBar />
      <div className="body">
        {layout.sidebarOpen && (
          <>
            <div className="col" style={{ width: layout.sidebarWidth }}>
              <AgentSidebar />
            </div>
            <Splitter value={layout.sidebarWidth} side="left" min={190} max={420} onChange={(v) => setLayout({ sidebarWidth: v })} />
          </>
        )}
        {preferences.uiMode === "chat" ? <ChatView /> : <Workspace />}
        {layout.browserOpen && (
          <>
            <Splitter value={layout.browserWidth ?? 560} side="right" min={320} max={1400} onChange={(v) => setLayout({ browserWidth: v })} />
            <div className="col browser-col" style={{ width: layout.browserWidth ?? 560 }}>
              <BrowserPane />
            </div>
          </>
        )}
        {layout.filesOpen && (
          <>
            <Splitter value={layout.filesWidth} side="right" min={200} max={520} onChange={(v) => setLayout({ filesWidth: v })} />
            <div className="col" style={{ width: layout.filesWidth }}>
              <ProjectTools />
            </div>
          </>
        )}
      </div>
      {preferences.showStatusBar && <StatusBar />}
      <ModalLayer />
      <QuickOpen />
      <CommandPalette />
      <MenuLayer />
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={"toast is-" + t.tone}>
            <span>{t.text}</span>
            {t.action && <button className="mini-btn" onClick={() => { t.action!.run(); useDesk.getState().dismissToast(t.id); }}>{t.action.label}</button>}
            <button className="icon-btn" aria-label="Dismiss" onClick={() => useDesk.getState().dismissToast(t.id)}>
              <X size={13} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
