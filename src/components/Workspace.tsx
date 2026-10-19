import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Columns2, Play, ArrowUpRight, Layers3, Search, Settings2, ChevronDown, FileText, FolderPlus, Plus, SquareTerminal, TriangleAlert, X } from "lucide-react";
import { TOOL_LABEL, projectAccount, tabAccount, useDesk, focusedTabId } from "../store";
import { addProjectsFromDialog, closeTab, openTerminal, saveTab, terminalSpec, splitWorkspace } from "../actions";
import { mountTerminal, setTerminalVisible, unmountTerminal } from "../terminals";
import { focusEditor, keepEditorVersion, mountEditor, reloadEditor } from "../editors";
import { DeskLogo } from "./DeskLogo";
import { openMenu } from "./Menu";
import type { FileTab, MenuItem, Project, Tab, TabTool, TerminalTab } from "../types";

export function Workspace() {
  const project = useDesk((s) => s.projects.find((p) => p.id === s.activeProjectId));
  const hasProjects = useDesk((s) => s.projects.length > 0);
  const showing = useDesk((s) => s.activeTabId !== null);

  return (
    <main className="workspace">
      {project && <TabBar project={project} />}
      <div className="stage">
        <Panes />
        {!hasProjects && <Welcome />}
        {project && !showing && <Launcher project={project} />}
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
  items.push({ label: "Shell", hint: "", icon: <SquareTerminal size={14} />, onSelect: () => openTerminal(project.id, "shell") });
  const others = accounts.filter((a) => a.id !== projectAccount(accounts, project, a.kind).id);
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

/** Every tab from every project, grouped by project, so switching projects never hides a terminal. */
function TabBar({ project }: { project: Project }) {
  const tabs = useDesk((s) => s.tabs);
  const projects = useDesk((s) => s.projects);
  const activeTabId = useDesk(focusedTabId);
  const multi = new Set(tabs.map((t) => t.projectId)).size > 1;
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scroller.current?.querySelector(".tab.is-active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeTabId]);

  return (
    <div className="tabbar">
      <div className="tabs" ref={scroller} role="tablist">
        {tabs.map((t, i) => {
          const owner = projects.find((p) => p.id === t.projectId);
          if (!owner) return null;
          return (
            <TabButton
              key={t.id}
              tab={t}
              project={owner}
              active={t.id === activeTabId}
              showProject={multi}
              groupStart={i > 0 && tabs[i - 1].projectId !== t.projectId}
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

function TabButton({ tab, project, active, showProject, groupStart }: { tab: Tab; project: Project; active: boolean; showProject: boolean; groupStart: boolean }) {
  const accounts = useDesk((s) => s.accounts);
  const select = () => useDesk.getState().selectTab(tab.id);
  let color = "transparent";
  let label: string;
  let sub = "";
  if (tab.type === "terminal") {
    const account = tab.tool === "shell" ? null : tabAccount(accounts, project, tab);
    color = account?.color ?? "var(--muted-2)";
    label = cleanTitle(tab.title) || TOOL_LABEL[tab.tool];
    sub = account ? account.name : "";
  } else {
    label = tab.title;
  }
  const where = showProject ? project.name : "";

  return (
    <div
      role="tab"
      aria-selected={active}
      tabIndex={0}
      className={
        "tab" +
        (active ? " is-active" : "") +
        (tab.type === "terminal" && tab.status === "exited" ? " is-exited" : "") +
        (tab.type === "file" && tab.dirty ? " is-dirty" : "") +
        (groupStart ? " is-group-start" : "")
      }
      style={{ "--acct": color } as React.CSSProperties}
      onMouseDown={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          closeTab(tab.id);
        }
      }}
      onClick={select}
      onKeyDown={(e) => e.key === "Enter" && select()}
      title={tab.type === "file" ? tab.path : `${TOOL_LABEL[tab.tool]} in ${project.name}${sub ? `, as ${sub}` : ""}\n${tab.cwd}`}
    >
      {tab.type === "terminal" ? <SquareTerminal size={13} className="tab-icon" /> : <FileText size={13} className="tab-icon" />}
      {where && <span className="tab-project">{where}</span>}
      <span className="tab-label">{label}</span>
      {sub && <span className="tab-sub">{sub}</span>}
      {tab.type === "terminal" && tab.activity && !active && <span className="tab-activity" aria-label="New output" />}
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

/** Terminal titles often start with spinner glyphs; keep the readable part. */
function cleanTitle(title: string) {
  return title.replace(/^[^\p{L}\p{N}]+/u, "").trim();
}

// Panes: every tab of every project stays mounted, only the active one is shown.

function Panes() {
  const tabs = useDesk((s) => s.tabs);
  const primary = useDesk((s) => s.activeTabId);
  const secondary = useDesk((s) => s.secondaryTabId);
  const focus = useDesk((s) => s.focusedPane);
  const ratio = useDesk((s) => s.layout.splitRatio);
  const [dragging, setDragging] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent) => {
      const rect = stage.current?.getBoundingClientRect();
      if (rect) useDesk.getState().setLayout({ splitRatio: Math.max(25, Math.min(75, (e.clientX - rect.left) / rect.width * 100)) });
    };
    const up = () => setDragging(false);
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
  }, [dragging]);
  return <div className={"pane-layout" + (secondary ? " is-split" : "")} ref={stage}>
    {tabs.map((t) => {
      const side = t.id === secondary ? "secondary" : "primary";
      const visible = t.id === primary || t.id === secondary;
      const focused = visible && side === focus;
      return <div key={t.id} className={"workspace-pane" + (focused ? " is-focused" : "")} style={{ display: visible ? "block" : "none", left: side === "secondary" ? `${ratio}%` : 0, width: secondary ? `${side === "secondary" ? 100 - ratio : ratio}%` : "100%" }} onPointerDownCapture={() => { if (!focused) useDesk.getState().focusPane(side); }} onFocusCapture={() => { if (!focused) useDesk.getState().focusPane(side); }}>
        {secondary && <div className="split-pane-head"><span>{t.title || (t.type === "terminal" ? TOOL_LABEL[t.tool] : "File")}</span><button className="icon-btn" aria-label="Focus this pane" onClick={() => useDesk.getState().focusPane(side)}><Columns2 size={12} /></button></div>}
        {t.type === "terminal" ? <TerminalPane tab={t} visible={visible} focused={focused} /> : <EditorPane tab={t} visible={visible} focused={focused} />}
      </div>;
    })}
    {secondary && <div className="pane-divider" style={{ left: `${ratio}%` }} role="separator" tabIndex={0} aria-label="Resize split panes" aria-orientation="vertical" aria-valuemin={25} aria-valuemax={75} aria-valuenow={Math.round(ratio)} onPointerDown={(e) => { e.preventDefault(); setDragging(true); }} onKeyDown={(e) => { if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); useDesk.getState().setLayout({ splitRatio: Math.max(25, Math.min(75, ratio + (e.key === "ArrowRight" ? 5 : -5))) }); } }} />}
  </div>;
}

function terminalHooks(tabId: string) {
  const patch = (p: Partial<TerminalTab>) => useDesk.getState().patchTab(tabId, p);
  return {
    spec: () => terminalSpec(tabId),
    onTitle: (title: string) => patch({ title }),
    onStatus: (status: "running" | "exited", exitCode: number | null) => patch({ status, exitCode }),
    onActivity: () => {
      const t = useDesk.getState().tabs.find((x) => x.id === tabId);
      if (t && t.type === "terminal" && !t.activity) patch({ activity: true });
    },
  };
}

function TerminalPane({ tab, visible, focused }: { tab: TerminalTab; visible: boolean; focused: boolean }) {
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
    if (visible && tab.activity) useDesk.getState().patchTab(tab.id, { activity: false });
  }, [visible, focused, tab.id, tab.activity, tab.restored]);

  return (
    <div className={"pane terminal-pane" + (visible ? " is-visible" : "")} style={{ "--acct": account?.color ?? "var(--line-strong)" } as React.CSSProperties}>
      <div className="pane-rule" />
      {tab.restored ? <div className="pane-message restored-session"><SquareTerminal size={28} /><h2>Session restored</h2><p>{TOOL_LABEL[tab.tool]} · {tab.cwd}</p><p>The previous process ended when Desk closed. Restart to begin a new session.</p><button className="btn is-primary" onClick={() => useDesk.getState().patchTab(tab.id, { restored: false, status: "starting" })}><Play size={14} />Restart {TOOL_LABEL[tab.tool]}</button></div> : <div className="terminal-mount" ref={ref} />}
    </div>
  );
}

function EditorPane({ tab, visible, focused }: { tab: FileTab; visible: boolean; focused: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const project = useDesk((s) => s.projects.find((p) => p.id === tab.projectId));
  const rel = project && tab.path.startsWith(project.path + "/") ? tab.path.slice(project.path.length + 1) : tab.path;

  useLayoutEffect(() => {
    if (tab.ready && ref.current) mountEditor(tab.id, ref.current);
  }, [tab.ready, tab.id]);

  useEffect(() => {
    if (visible && focused && tab.ready) focusEditor(tab.id);
  }, [visible, focused, tab.ready, tab.id]);

  return (
    <div className={"pane editor-pane" + (visible ? " is-visible" : "")}>
      <div className="crumbs">
        {rel.split("/").map((part, i, all) => (
          <span key={i} className={i === all.length - 1 ? "crumb is-last" : "crumb"}>
            {part}
          </span>
        ))}
        <span className="crumbs-state">{tab.dirty ? "Unsaved changes" : ""}</span>
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
          <button className="btn" onClick={() => closeTab(tab.id)}>
            Close tab
          </button>
        </div>
      ) : (
        <div className="editor-mount" ref={ref}>
          {!tab.ready && <div className="pane-message is-quiet">Opening…</div>}
        </div>
      )}
    </div>
  );
}

// Empty states

function Launcher({ project }: { project: Project }) {
  const accounts = useDesk((s) => s.accounts);
  const identities = useDesk((s) => s.identities);
  const tiles: { tool: TabTool; key: string; detail: string; color: string }[] = (["claude", "codex"] as const).map((kind, i) => {
    const a = projectAccount(accounts, project, kind);
    const id = identities[a.id];
    return {
      tool: kind,
      key: i === 0 ? "⌘T" : "",
      detail: `${a.name}${id?.email ? `, ${id.email}` : id?.signedIn ? "" : ", not signed in"}`,
      color: a.color,
    };
  });
  tiles.push({ tool: "shell", key: "", detail: "Your login shell in this folder", color: "var(--muted)" });

  return (
    <div className="launcher">
      <div className="launcher-inner">
        <span className="eyebrow">YOUR WORKSPACE</span>
        <h1>{project.name}</h1>
        <p className="launcher-path">{project.path}</p>
        <h2 className="launch-section-title">Start a session <span>Pick your tool. Get into flow.</span></h2>
        <div className="launch-tiles">
          {tiles.map((t) => (
            <button key={t.tool} className="launch-tile" style={{ "--acct": t.color } as React.CSSProperties} onClick={() => openTerminal(project.id, t.tool)}>
              <span className="launch-tool-icon"><SquareTerminal size={19} /></span>
              <span className="launch-name">
                {TOOL_LABEL[t.tool]}
                {t.key && <kbd>{t.key}</kbd>}
              </span>
              <span className="launch-detail">{t.detail}</span>
              <ArrowUpRight size={15} className="launch-arrow" />
            </button>
          ))}
        </div>
        <div className="launcher-actions"><button onClick={() => useDesk.getState().setQuickOpen(true)}><Search size={14} />Open a file<kbd>⌘P</kbd></button><button onClick={() => useDesk.getState().setModal({ kind: "settings" })}><Settings2 size={14} />Customize Desk<kbd>⌘,</kbd></button></div>
      </div>
    </div>
  );
}

function Welcome() {
  return (
    <div className="launcher">
      <div className="launcher-inner">
        <span className="welcome-mark"><DeskLogo size={36} /></span>
        <span className="eyebrow">A LITTLE SPACE. A LOT OF POSSIBILITY.</span>
        <h1>Good work starts here.</h1>
        <p className="launcher-lead">
          Your projects, AI tools, and terminals. One considered workspace.
          Open a folder and make room for your next idea.
        </p>
        <button className="btn is-primary" onClick={() => void addProjectsFromDialog()}>
          <FolderPlus size={15} /> Add project folder
        </button>
        <p className="launcher-hint">Or drop a project folder anywhere in this window.</p>
        <div className="welcome-features"><div><SquareTerminal size={17} /><strong>Your tools, together</strong><span>Claude Code, Codex, and your shell.</span></div><div><Layers3 size={17} /><strong>A place for every project</strong><span>Separate accounts. Persistent sessions.</span></div></div>
        <div className="launcher-actions"><button onClick={() => useDesk.getState().setModal({ kind: "settings" })}><Settings2 size={14} />Make Desk yours<kbd>⌘,</kbd></button></div>
      </div>
    </div>
  );
}
