import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { X } from "lucide-react";
import { useDesk, focusedTabId } from "./store";
import { ipc, errorText } from "./ipc";
import { flushWorkspace, persistWorkspace } from "./persistence";
import {
  activeProject,
  activeTab,
  addProjectPaths,
  addProjectsFromDialog,
  closeTab,
  handleFsChange,
  openFile,
  openTerminal,
  refreshIdentities,
  saveTab,
  watchProject,
  detectProjectAccount,
  restoreWorkspace,
  splitWorkspace,
} from "./actions";
import { resolvedTheme } from "./appearance";
import { updateEditorAppearance } from "./editors";
import { clearTerminal, pasteIntoTerminal, updateTerminalAppearance } from "./terminals";
import { Sidebar } from "./components/Sidebar";
import { Workspace } from "./components/Workspace";
import { ProjectTools } from "./components/ProjectTools";
import { Splitter, StatusBar, TitleBar } from "./components/Chrome";
import { ModalLayer } from "./components/Modals";
import { QuickOpen } from "./components/QuickOpen";
import { CommandPalette } from "./components/CommandPalette";
import { MenuLayer } from "./components/Menu";

async function boot() {
  const [diskSaved, detected] = await Promise.all([ipc.stateLoad().catch(() => null), ipc.accountsDetect().catch(() => [])]);
  let saved = diskSaved;
  try {
    const local = JSON.parse(localStorage.getItem("desk-recovery-v2") ?? "null");
    if (local && local.savedAt > ((diskSaved as { savedAt?: number } | null)?.savedAt ?? 0)) saved = local;
  } catch { /* Native state is the fallback if web storage is unavailable. */ }
  useDesk.getState().init(saved && typeof saved === "object" ? (saved as never) : null, detected);
  await restoreWorkspace();
  await refreshIdentities();
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

function cycleProject(step: number) {
  const s = useDesk.getState();
  if (!s.projects.length) return;
  const i = s.projects.findIndex((p) => p.id === s.activeProjectId);
  s.selectProject(s.projects[(i + step + s.projects.length) % s.projects.length].id);
}

function onKeyDown(e: KeyboardEvent) {
  const s = useDesk.getState();
  if (s.modal) return;
  if ((s.commandOpen || s.quickOpen) && !(e.metaKey && e.key.toLowerCase() === "p")) return;
  const project = activeProject();
  const tab = activeTab();
  const cmd = e.metaKey && !e.ctrlKey;
  let handled = true;

  if (e.ctrlKey && !e.metaKey && e.key === "Tab") cycleTab(e.shiftKey ? -1 : 1);
  else if (!cmd) handled = false;
  else if (e.key.toLowerCase() === "p" && e.shiftKey) s.setCommandOpen(!s.commandOpen);
  else if (e.key.toLowerCase() === "f" && e.shiftKey) s.setLayout({ filesOpen: true, panel: "search" });
  else if (e.key === "\\") splitWorkspace();
  else if (e.key === ",") s.setModal({ kind: "settings" });
  else if (e.key === "t" && !e.shiftKey && project) openTerminal(project.id, "claude");
  else if (e.key === "w" && !e.shiftKey) tab && closeTab(tab.id);
  else if (e.key === "s" && !e.shiftKey) tab && void saveTab(tab.id);
  else if (e.key === "p" && !e.shiftKey) project && s.setQuickOpen(!s.quickOpen);
  else if (e.key === "o" && !e.shiftKey) void addProjectsFromDialog();
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

/** Folders dropped anywhere become projects; files dropped on a terminal are pasted as paths. */
async function onDrop(paths: string[], x: number, y: number) {
  const target = document.elementFromPoint(x, y)?.closest<HTMLElement>(".term-host");
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
      document.documentElement.dataset.density = preferences.density;
      document.documentElement.dataset.accent = preferences.accent;
      document.documentElement.dataset.accountColors = preferences.accountColors ? "on" : "off";
      document.documentElement.dataset.motion = preferences.reduceMotion ? "reduced" : "system";
      document.documentElement.style.setProperty("--code-size", `${preferences.fontSize}px`);
      updateTerminalAppearance();
      updateEditorAppearance();
    };
    apply();
    const media = matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
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
      try { await flushWorkspace(); await ipc.exit(); }
      catch (e) { useDesk.getState().toast(`Couldn't save workspace before quitting: ${errorText(e)}`, "error"); quitting = false; }
    };
    window.addEventListener("keydown", onKeyDown, true);
    const unlisten = [
      listen("desk-quit", () => void quit()),
      getCurrentWindow().onCloseRequested((e) => { e.preventDefault(); void quit(); }),
      listen<{ root: string; paths: string[] }>("fs-change", ({ payload }) => handleFsChange(payload.root, payload.paths)),
      getCurrentWindow().onFocusChanged(({ payload: focused }) => focused && void refreshIdentities()),
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
              <Sidebar />
            </div>
            <Splitter value={layout.sidebarWidth} side="left" min={190} max={420} onChange={(v) => setLayout({ sidebarWidth: v })} />
          </>
        )}
        <Workspace />
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
            <button className="icon-btn" aria-label="Dismiss" onClick={() => useDesk.getState().dismissToast(t.id)}>
              <X size={13} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
