import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeftRight, Columns2, Play, Rows2, Server, ChevronDown, FileText, History, Plus, RotateCcw, SquareTerminal, TriangleAlert, X } from "lucide-react";
import { TOOL_LABEL, projectAccount, tabAccount, useDesk, focusedTabId, type DropZone } from "../store";
import { closeOtherTabs, closeTab, connectionLabel, flipSplit, markAttention, openConnection, openInSplit, openTerminal, refreshLimits, saveTab, startFresh, swapPanes, terminalSpec, splitWorkspace } from "../actions";
import { isTerminalVisible, mountTerminal, setTerminalVisible, unmountTerminal } from "../terminals";
import { focusEditor, keepEditorVersion, mountEditor, reloadEditor } from "../editors";
import { useTabReorder } from "./useTabReorder";
import { FileViewer, OpenDefaultButton, TableView } from "./FileViewer";
import { isBinaryPreview, onDiskChange, previewKind } from "../preview";
import { Home } from "./Home";
import { openMenu } from "./Menu";
import type { Account, Agent, FileTab, MenuItem, Project, Tab, TerminalTab } from "../types";

export function Workspace() {
  const project = useDesk((s) => s.projects.find((p) => p.id === s.activeProjectId));
  const hasProjects = useDesk((s) => s.projects.length > 0);
  const showing = useDesk((s) => s.activeTabId !== null);

  return (
    <main className="workspace">
      {project && <TabBar project={project} />}
      <div className="stage">
        <Panes />
        {(!hasProjects || !showing) && <Home mode="terminal" />}
      </div>
    </main>
  );
}

// Tabs

export function newTabMenu(project: Project): MenuItem[] {
  const { accounts, identities } = useDesk.getState();
  const items: MenuItem[] = (["claude", "codex"] as const).map((kind) => {
    const a = projectAccount(accounts, project, kind);
    return {
      label: TOOL_LABEL[kind],
      hint: a.name,
      icon: <span className="dot" style={{ background: a.color }} />,
      onSelect: () => openTerminal(project.id, kind),
    };
  });
  items.push({ label: "Shell", hint: "⌘J", icon: <SquareTerminal size={14} />, onSelect: () => openTerminal(project.id, "shell") });
  const { connections } = useDesk.getState();
  if (connections.length) {
    items.push({ separator: true });
    for (const c of connections) items.push({ label: c.name, hint: connectionLabel(c), icon: <Server size={14} />, onSelect: () => openConnection(c.id) });
  }
  const others = accounts.filter((a): a is Account & { kind: Agent } => a.kind !== "github" && a.id !== projectAccount(accounts, project, a.kind).id);
  if (others.length) {
    items.push({ separator: true });
    for (const a of others) {
      items.push({
        label: `${TOOL_LABEL[a.kind]} as ${a.name}`,
        hint: identities[a.id]?.email ?? "",
        icon: <span className="dot" style={{ background: a.color }} />,
        onSelect: () => openTerminal(project.id, a.kind, { accountId: a.id }),
      });
    }
  }
  return items;
}

/** Every project shares one reorderable tab strip; pane identity is independent of order. */
function TabBar({ project }: { project: Project }) {
  const tabs = useDesk((s) => s.tabs);
  const projects = useDesk((s) => s.projects);
  const activeTabId = useDesk(focusedTabId);
  const multi = new Set(tabs.map((t) => t.projectId)).size > 1;
  const scroller = useRef<HTMLDivElement>(null);
  const reorder = useTabReorder(scroller);

  useEffect(() => {
    scroller.current?.querySelector(".tab.is-active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeTabId]);

  return (
    <div className="tabbar">
      <div className={"tabs" + (reorder.landing?.before === null ? " has-drop-at-end" : "")} ref={scroller} role="tablist" aria-label="Open tabs" onClickCapture={(e) => { if (reorder.suppressClick.current) { e.preventDefault(); e.stopPropagation(); } }}>
        {tabs.map((t) => {
          const owner = projects.find((p) => p.id === t.projectId);
          if (!owner) return null;
          return (
            <TabButton
              key={t.id}
              tab={t}
              project={owner}
              active={t.id === activeTabId}
              showProject={multi}
              dragging={reorder.draggingId === t.id}
              dropBefore={reorder.landing?.before === t.id}
              onDragPointerDown={(e) => reorder.start(t.id, e)}
            />
          );
        })}
      </div>
      <div className="tabbar-actions">
        <button className="icon-btn" aria-label="Toggle split panes" title="Split workspace (⌘\\)" onClick={splitWorkspace}><Columns2 size={15} /></button>
        <button
          className="new-tab"
          aria-label={`New Claude Code tab in ${project.name}`}
          title={`New Claude Code tab in ${project.name} (⌘T)`}
          onClick={() => openTerminal(project.id, "claude")}
        >
          <Plus size={14} />
          <span>{project.name}</span>
        </button>
        <button className="icon-btn" aria-label="More tab types" title="New tab with another tool or account" onClick={(e) => openMenu(e.currentTarget, newTabMenu(project))}>
          <ChevronDown size={14} />
        </button>
      </div>
    </div>
  );
}

function TabButton({ tab, project, active, showProject, dragging, dropBefore, onDragPointerDown }: {
  tab: Tab; project: Project; active: boolean; showProject: boolean; dragging: boolean; dropBefore: boolean;
  onDragPointerDown: (e: React.PointerEvent) => void;
}) {
  const accounts = useDesk((s) => s.accounts);
  const connection = useDesk((s) => (tab.type === "terminal" && tab.sshId ? s.connections.find((c) => c.id === tab.sshId) : undefined));
  const select = () => useDesk.getState().selectTab(tab.id);
  let color = "transparent";
  let label: string;
  let sub = "";
  if (tab.type === "terminal") {
    const account = tab.tool === "shell" ? null : tabAccount(accounts, project, tab);
    color = account?.color ?? "var(--muted-2)";
    label = tab.sshId ? (connection?.name ?? "Deleted connection") : cleanTitle(tab.title) || TOOL_LABEL[tab.tool];
    sub = tab.sshId ? (tab.status === "running" ? "SSH" : "Closed") : account ? account.name : "";
  } else {
    label = tab.title;
  }
  const where = showProject ? project.name : "";
  const busy = tab.type === "terminal" && tab.busy && tab.status === "running";
  const waiting = tab.type === "terminal" && !!tab.attention;

  return (
    <div
      role="tab"
      aria-selected={active}
      data-tab-id={tab.id}
      onPointerDown={onDragPointerDown}
      tabIndex={0}
      className={
        "tab" +
        (active ? " is-active" : "") +
        (tab.type === "terminal" && tab.status === "exited" ? " is-exited" : "") +
        (tab.type === "file" && tab.dirty ? " is-dirty" : "") +
        (dragging ? " is-dragging-tab" : "") +
        (dropBefore ? " is-drop-before" : "") +
        (busy ? " is-busy" : "") +
        (waiting ? " is-waiting" : "")
      }
      onContextMenu={(e) => {
        e.preventDefault();
        openMenu({ x: e.clientX, y: e.clientY }, tabMenu(tab));
      }}
      style={{ "--acct": color } as React.CSSProperties}
      onMouseDown={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          closeTab(tab.id);
        }
      }}
      onClick={select}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.altKey && e.shiftKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
          e.preventDefault();
          const { tabs, moveTab } = useDesk.getState();
          const at = tabs.findIndex((t) => t.id === tab.id);
          if (e.key === "ArrowLeft" && at > 0) moveTab(tab.id, tabs[at - 1].id);
          else if (e.key === "ArrowRight" && at < tabs.length - 1) moveTab(tab.id, tabs[at + 2]?.id ?? null);
        } else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(); }
      }}
      title={(tab.type === "file" ? tab.path : tab.sshId ? `${connection?.command ?? "Deleted connection"}\nOpened in ${project.name}` : `${TOOL_LABEL[tab.tool]} in ${project.name}${sub ? `, as ${sub}` : ""}\n${tab.cwd}`) + (waiting ? `\n${(tab as TerminalTab).attention}` : busy ? "\nWorking…" : "") + "\nDrag to reorder, or onto the workspace to split"}
    >
      {busy ? <span className="tab-spinner" aria-label="Working" /> : tab.type === "terminal" ? (tab.sshId ? <Server size={13} className="tab-icon" /> : <SquareTerminal size={13} className="tab-icon" />) : <FileText size={13} className="tab-icon" />}
      {where && <span className="tab-project">{where}</span>}
      <span className="tab-label">{label}</span>
      {sub && <span className="tab-sub">{sub}</span>}
      {waiting ? <span className="tab-waiting" aria-label={(tab as TerminalTab).attention ?? "Waiting"} /> : tab.type === "terminal" && tab.activity && !active && <span className="tab-activity" aria-label="New output" />}
      <button
        className="tab-close"
        aria-label={`Close ${label}`}
        onClick={(e) => {
          e.stopPropagation();
          closeTab(tab.id);
        }}
      >
        <X size={12} />
      </button>
    </div>
  );
}

function tabMenu(tab: Tab): MenuItem[] {
  const s = useDesk.getState();
  const split = !!s.secondaryTabId;
  const shown = tab.id === s.activeTabId || tab.id === s.secondaryTabId;
  return [
    { label: "Open to the right", icon: <Columns2 size={14} />, disabled: s.tabs.length < 2 || (split && shown), onSelect: () => openInSplit(tab.id, "right") },
    { label: "Open below", icon: <Rows2 size={14} />, disabled: s.tabs.length < 2 || (split && shown), onSelect: () => openInSplit(tab.id, "bottom") },
    { separator: true },
    { label: "Close", hint: "⌘W", icon: <X size={14} />, onSelect: () => closeTab(tab.id) },
    { label: "Close other tabs", disabled: s.tabs.length < 2, onSelect: () => closeOtherTabs(tab.id, "others") },
    { label: "Close tabs to the right", disabled: s.tabs[s.tabs.length - 1]?.id === tab.id, onSelect: () => closeOtherTabs(tab.id, "right") },
  ];
}

/** Terminal titles often start with spinner glyphs; keep the readable part. */
export function cleanTitle(title: string) {
  return title.replace(/^[^\p{L}\p{N}]+/u, "").trim();
}

// Panes: every tab of every project stays mounted, only the active one is shown.

const DROP_LABEL: Record<DropZone, string> = { left: "Open on the left", right: "Open on the right", top: "Open above", bottom: "Open below", center: "Show here" };

function Panes() {
  const tabs = useDesk((s) => s.tabs);
  const primary = useDesk((s) => s.activeTabId);
  const secondary = useDesk((s) => s.secondaryTabId);
  const focus = useDesk((s) => s.focusedPane);
  const ratio = useDesk((s) => s.layout.splitRatio);
  const dir = useDesk((s) => s.layout.splitDir);
  const dropZone = useDesk((s) => s.dropZone);
  const [dragging, setDragging] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const row = dir !== "column";
  useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent) => {
      const rect = stage.current?.getBoundingClientRect();
      if (!rect) return;
      const at = row ? (e.clientX - rect.left) / rect.width : (e.clientY - rect.top) / rect.height;
      useDesk.getState().setLayout({ splitRatio: Math.max(20, Math.min(80, at * 100)) });
    };
    const up = () => setDragging(false);
    document.body.classList.add(row ? "is-resizing" : "is-resizing-rows");
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
    return () => { document.body.classList.remove("is-resizing", "is-resizing-rows"); window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
  }, [dragging, row]);
  const place = (side: "primary" | "secondary"): React.CSSProperties => {
    if (!secondary) return { inset: 0 };
    const start = side === "secondary" ? `${ratio}%` : 0;
    const size = `${side === "secondary" ? 100 - ratio : ratio}%`;
    return row ? { top: 0, bottom: 0, left: start, width: size } : { left: 0, right: 0, top: start, height: size };
  };
  const nudge = (delta: number) => useDesk.getState().setLayout({ splitRatio: Math.max(20, Math.min(80, ratio + delta)) });
  return <div className={"pane-layout" + (secondary ? " is-split" : "") + (row ? " is-row" : " is-column")} ref={stage}>
    {tabs.map((t) => {
      const side = t.id === secondary ? "secondary" : "primary";
      const visible = t.id === primary || t.id === secondary;
      const focused = visible && side === focus;
      return <div key={t.id} className={"workspace-pane" + (focused ? " is-focused" : "") + (side === "secondary" ? " is-second" : "")} style={{ display: visible ? "block" : "none", ...place(side) }} onPointerDownCapture={() => { if (!focused) useDesk.getState().focusPane(side); }} onFocusCapture={() => { if (!focused) useDesk.getState().focusPane(side); }}>
        {secondary && <PaneHead tab={t} side={side} focused={focused} row={row} />}
        {t.type === "terminal" ? <TerminalPane tab={t} visible={visible} focused={focused} /> : <EditorPane tab={t} visible={visible} focused={focused} />}
      </div>;
    })}
    {secondary && <div className="pane-divider" style={row ? { left: `${ratio}%` } : { top: `${ratio}%` }} role="separator" tabIndex={0} aria-label="Resize split panes" aria-orientation={row ? "vertical" : "horizontal"} aria-valuemin={20} aria-valuemax={80} aria-valuenow={Math.round(ratio)} title="Drag to resize. Double-click to make both panes the same size."
      onPointerDown={(e) => { e.preventDefault(); setDragging(true); }}
      onDoubleClick={() => useDesk.getState().setLayout({ splitRatio: 50 })}
      onKeyDown={(e) => {
        const back = row ? "ArrowLeft" : "ArrowUp";
        const forward = row ? "ArrowRight" : "ArrowDown";
        if (e.key === back || e.key === forward) { e.preventDefault(); nudge(e.key === forward ? 5 : -5); }
      }} />}
    {dropZone && <div className={"drop-overlay is-" + dropZone} aria-hidden><span>{DROP_LABEL[dropZone]}</span></div>}
  </div>;
}

function PaneHead({ tab, side, focused, row }: { tab: Tab; side: "primary" | "secondary"; focused: boolean; row: boolean }) {
  const project = useDesk((s) => s.projects.find((p) => p.id === tab.projectId));
  const connection = useDesk((s) => (tab.type === "terminal" && tab.sshId ? s.connections.find((c) => c.id === tab.sshId) : undefined));
  const title = tab.type === "terminal" ? (tab.sshId ? connection?.name : cleanTitle(tab.title)) || TOOL_LABEL[tab.tool] : tab.title;
  const busy = tab.type === "terminal" && tab.busy && tab.status === "running";
  // Closing a pane keeps the other one on screen, full width.
  const close = () => {
    const s = useDesk.getState();
    if (side === "secondary") useDesk.setState({ secondaryTabId: null, focusedPane: "primary" });
    else useDesk.setState({ activeTabId: s.secondaryTabId, secondaryTabId: null, focusedPane: "primary" });
  };
  return <div className="split-pane-head">
    {busy ? <span className="tab-spinner" /> : tab.type === "terminal" ? <SquareTerminal size={12} /> : <FileText size={12} />}
    <span className="split-pane-title">{title}</span>
    {project && <span className="split-pane-project">{project.name}</span>}
    {focused && <span className="split-pane-focus">Focused</span>}
    <span className="split-pane-actions">
      <button className="icon-btn" aria-label="Swap panes" title="Swap panes" onClick={swapPanes}><ArrowLeftRight size={12} /></button>
      <button className="icon-btn" aria-label={row ? "Stack panes" : "Place panes side by side"} title={row ? "Stack panes (⌘⌥\\)" : "Side by side (⌘⌥\\)"} onClick={flipSplit}>{row ? <Rows2 size={12} /> : <Columns2 size={12} />}</button>
      <button className="icon-btn" aria-label="Close this pane" title="Close this pane (the tab stays open)" onClick={close}><X size={12} /></button>
    </span>
  </div>;
}

function terminalHooks(tabId: string) {
  const patch = (p: Partial<TerminalTab>) => useDesk.getState().patchTab(tabId, p);
  return {
    spec: () => terminalSpec(tabId),
    restartLabel: () => {
      const t = useDesk.getState().tabs.find((x) => x.id === tabId);
      return t?.type === "terminal" && t.sshId ? "reconnect" : "restart";
    },
    onTitle: (title: string) => patch({ title }),
    onStatus: (status: "running" | "exited", exitCode: number | null) => patch(status === "exited" ? { status, exitCode, busy: false } : { status, exitCode }),
    agent: () => {
      const t = useDesk.getState().tabs.find((x) => x.id === tabId);
      return t?.type === "terminal" && t.tool !== "shell";
    },
    onBusy: (busy: boolean) => {
      patch(busy ? { busy, attention: null } : { busy });
      // A finished turn is when the agent last reported its usage.
      if (!busy) setTimeout(() => void refreshLimits(), 1500);
    },
    onAttention: (reason: string) => markAttention(tabId, reason, isTerminalVisible(tabId)),
    onActivity: () => {
      const t = useDesk.getState().tabs.find((x) => x.id === tabId);
      if (t && t.type === "terminal" && !t.activity) patch({ activity: true });
    },
  };
}

export function TerminalPane({ tab, visible, focused }: { tab: TerminalTab; visible: boolean; focused: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const project = useDesk((s) => s.projects.find((p) => p.id === tab.projectId));
  const accounts = useDesk((s) => s.accounts);
  const account = tab.tool === "shell" ? null : tabAccount(accounts, project, tab);

  useLayoutEffect(() => {
    if (tab.restored || !ref.current) return;
    mountTerminal(tab.id, terminalHooks(tab.id), ref.current);
    return () => unmountTerminal(tab.id);
  }, [tab.id, tab.restored]);

  useEffect(() => {
    setTerminalVisible(tab.id, visible, focused);
    if (visible && (tab.activity || (tab.attention && document.hasFocus()))) useDesk.getState().patchTab(tab.id, { activity: false, attention: null });
  }, [visible, focused, tab.id, tab.activity, tab.attention, tab.restored]);

  return (
    <div className={"pane terminal-pane" + (visible ? " is-visible" : "")} style={{ "--acct": account?.color ?? "var(--line-strong)" } as React.CSSProperties}>
      <div className="pane-rule" />
      {tab.restored ? <RestoredSession tab={tab} /> : <div className="terminal-mount" ref={ref} />}
    </div>
  );
}

function RestoredSession({ tab }: { tab: TerminalTab }) {
  const connection = useDesk((s) => s.connections.find((c) => c.id === tab.sshId));
  const restart = () => useDesk.getState().patchTab(tab.id, { restored: false, status: "starting" });
  if (tab.sshId) return <div className="pane-message restored-session"><Server size={28} /><h2>{connection?.name ?? "Deleted connection"}</h2><p>{connection ? connectionLabel(connection) : "This saved connection was deleted from Desk."}</p><p>The connection closed when Desk quit.</p>{connection && <button className="btn is-primary" onClick={restart}><Play size={14} />Reconnect</button>}</div>;
  if ((tab.tool === "claude" && tab.sessionId) || (tab.tool === "codex" && tab.resume)) return <div className="pane-message restored-session"><History size={28} /><h2>Pick up where you left off</h2><p>{TOOL_LABEL[tab.tool]} in {tab.cwd}</p><p>{TOOL_LABEL[tab.tool]} stopped when Desk quit. Resume reopens the same conversation, with its history.</p><div className="restored-actions"><button className="btn is-primary" onClick={restart}><Play size={14} />Resume conversation</button><button className="btn" onClick={() => startFresh(tab.id)}><RotateCcw size={14} />Start a new one</button></div></div>;
  return <div className="pane-message restored-session"><SquareTerminal size={28} /><h2>Session restored</h2><p>{TOOL_LABEL[tab.tool]} in {tab.cwd}</p><p>The previous process ended when Desk closed. Restart to begin a new session.</p><button className="btn is-primary" onClick={restart}><Play size={14} />Restart {TOOL_LABEL[tab.tool]}</button></div>;
}

function EditorPane({ tab, visible, focused }: { tab: FileTab; visible: boolean; focused: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const project = useDesk((s) => s.projects.find((p) => p.id === tab.projectId));
  const rel = project && tab.path.startsWith(project.path + "/") ? tab.path.slice(project.path.length + 1) : tab.path;
  const kind = previewKind(tab.path);
  const viewer = isBinaryPreview(tab.path);
  const [asText, setAsText] = useState(false);
  const [info, setInfo] = useState("");
  // The table re-reads the editor when shown and when the file changes on disk.
  const [rev, setRev] = useState(0);
  useEffect(() => (kind === "table" ? onDiskChange((paths) => { if (paths.has(tab.path)) setRev((r) => r + 1); }) : undefined), [kind, tab.path]);
  const table = kind === "table" && !asText && tab.ready && !tab.error;

  useLayoutEffect(() => {
    if (tab.ready && !viewer && ref.current) mountEditor(tab.id, ref.current);
  }, [tab.ready, tab.id, viewer]);

  useEffect(() => {
    if (visible && focused && tab.ready && !viewer && !table) focusEditor(tab.id);
  }, [visible, focused, tab.ready, tab.id, viewer, table]);

  return (
    <div className={"pane editor-pane" + (visible ? " is-visible" : "")}>
      <div className="crumbs">
        {rel.split("/").map((part, i, all) => (
          <span key={i} className={i === all.length - 1 ? "crumb is-last" : "crumb"}>
            {part}
          </span>
        ))}
        <span className="crumbs-state">{tab.dirty ? "Unsaved changes" : viewer ? info : ""}</span>
        {kind === "table" && tab.ready && !tab.error && (
          <span className="crumbs-switch" role="group" aria-label="View as">
            <button className={"mini-btn" + (!asText ? " is-on" : "")} aria-pressed={!asText} onClick={() => { setAsText(false); setRev((r) => r + 1); }}>Table</button>
            <button className={"mini-btn" + (asText ? " is-on" : "")} aria-pressed={asText} onClick={() => setAsText(true)}>Text</button>
          </span>
        )}
        {viewer && <OpenDefaultButton path={tab.path} />}
      </div>
      {tab.conflict && (
        <div className="banner">
          <TriangleAlert size={14} />
          <span>This file changed on disk while you were editing it.</span>
          <button className="mini-btn" onClick={() => void reloadEditor(tab.id).catch((e) => useDesk.getState().toast(String(e), "error"))}>
            Load disk version
          </button>
          <button className="mini-btn" onClick={() => keepEditorVersion(tab.id)}>
            Keep mine
          </button>
          <button className="mini-btn is-primary" onClick={() => void saveTab(tab.id)}>
            Save mine
          </button>
        </div>
      )}
      {tab.error ? (
        <div className="pane-message">
          <p>{tab.error}</p>
          <div className="pane-actions">
            <OpenDefaultButton path={tab.path} />
            <button className="btn" onClick={() => closeTab(tab.id)}>
              Close tab
            </button>
          </div>
        </div>
      ) : viewer ? (
        tab.ready && <FileViewer path={tab.path} onInfo={setInfo} />
      ) : (
        <>
          {table && <TableView tabId={tab.id} path={tab.path} rev={rev} />}
          <div className="editor-mount" ref={ref} hidden={table}>
            {!tab.ready && <div className="pane-message is-quiet">Opening…</div>}
          </div>
        </>
      )}
    </div>
  );
}

