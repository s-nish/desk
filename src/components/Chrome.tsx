import { useEffect, useState } from "react";
import { Command, GitBranch, PanelLeft, PanelRight, Settings2 } from "lucide-react";
import { homeDir } from "@tauri-apps/api/path";
import { TOOL_LABEL, projectAccount, shortPath, tabAccount, useDesk, focusedTabId } from "../store";
import type { Account, Project, Tool } from "../types";
import { accountChoices } from "./Sidebar";
import { openMenu } from "./Menu";

let home: string | null = null;
void homeDir().then((h) => (home = h.replace(/\/$/, "")));

export function TitleBar() {
  // Names the project of the tab on screen, matching the status bar.
  const project = useDesk((s) => {
    const tab = s.tabs.find((t) => t.id === focusedTabId(s));
    return s.projects.find((p) => p.id === (tab?.projectId ?? s.activeProjectId));
  });
  const layout = useDesk((s) => s.layout);
  const setLayout = useDesk((s) => s.setLayout);
  return (
    <header className="titlebar" data-tauri-drag-region>
      <div className="titlebar-left" data-tauri-drag-region>
        <button
          className={"icon-btn" + (layout.sidebarOpen ? " is-on" : "")}
          aria-label="Toggle projects sidebar"
          title="Projects (⌘B)"
          onClick={() => setLayout({ sidebarOpen: !layout.sidebarOpen })}
        >
          <PanelLeft size={15} />
        </button>
      </div>
      <div className="titlebar-center" data-tauri-drag-region>
        {project ? (
          <>
            <span className="title-project" data-tauri-drag-region>
              {project.name}
            </span>
            <span className="title-path" data-tauri-drag-region>
              {shortPath(project.path, home)}
            </span>
          </>
        ) : (
          <span className="title-project" data-tauri-drag-region>
            Desk
          </span>
        )}
      </div>
      <div className="titlebar-right" data-tauri-drag-region>
        <button className="icon-btn" aria-label="Open command palette" title="Command palette (⌘⇧P)" onClick={() => useDesk.getState().setCommandOpen(true)}><Command size={15} /></button>
        <button className="icon-btn" aria-label="Open settings" title="Settings (⌘,)" onClick={() => useDesk.getState().setModal({ kind: "settings" })}><Settings2 size={15} /></button>
        <button
          className={"icon-btn" + (layout.filesOpen ? " is-on" : "")}
          aria-label="Toggle files panel"
          title="Files (⌘⇧B)"
          onClick={() => setLayout({ filesOpen: !layout.filesOpen })}
        >
          <PanelRight size={15} />
        </button>
      </div>
    </header>
  );
}

function AccountSegment({ kind, account, project }: { kind: Tool; account: Account; project: Project }) {
  const identity = useDesk((s) => s.identities[account.id]);
  return (
    <button
      className="status-account"
      style={{ "--acct": account.color } as React.CSSProperties}
      title={`${identity?.path ?? ""}\nClick to change the ${TOOL_LABEL[kind]} account for ${project.name}`}
      onClick={(e) => openMenu(e.currentTarget, accountChoices(project, kind))}
    >
      <span className="status-tool">{TOOL_LABEL[kind]}</span>
      <span className="status-name">{account.name}</span>
      {identity?.email && <span className="status-email">{identity.email}</span>}
      {identity && !identity.signedIn && <span className="status-email">not signed in</span>}
    </button>
  );
}

export function StatusBar() {
  // Describes the tab on screen, which can belong to a project other than the selected one.
  const tab = useDesk((s) => s.tabs.find((t) => t.id === focusedTabId(s)));
  const project = useDesk((s) => s.projects.find((p) => p.id === (tab?.projectId ?? s.activeProjectId)));
  const accounts = useDesk((s) => s.accounts);
  const branch = useDesk((s) => (project ? s.branches[project.id] : null));

  // A Claude Code or Codex tab shows only the account it runs as; anything else shows both.
  const segments: [Tool, Account][] = [];
  if (tab?.type === "terminal" && tab.tool !== "shell") segments.push([tab.tool, tabAccount(accounts, project, tab)]);
  else if (tab?.type === "terminal") segments.push(["claude", tabAccount(accounts, project, tab, "claude")], ["codex", tabAccount(accounts, project, tab, "codex")]);
  else if (project) segments.push(["claude", projectAccount(accounts, project, "claude")], ["codex", projectAccount(accounts, project, "codex")]);

  return (
    <footer className="statusbar">
      <div className="status-left">
        {branch && (
          <span className="status-item">
            <GitBranch size={12} /> {branch}
          </span>
        )}
        {tab?.type === "terminal" && <span className="status-item">{shortPath(tab.cwd, home)}</span>}
        {tab?.type === "file" && <span className="status-item">{shortPath(tab.path, home)}</span>}
      </div>
      <div className="status-right">
        {project &&
          segments.map(([kind, account]) => <AccountSegment key={kind} kind={kind} account={account} project={project} />)}
      </div>
    </footer>
  );
}

/** Drag handle between panels. `side` says which edge of the handle the panel sits on. */
export function Splitter({ value, onChange, side, min, max }: { value: number; onChange: (v: number) => void; side: "left" | "right"; min: number; max: number }) {
  const [drag, setDrag] = useState<{ x: number; start: number } | null>(null);
  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => {
      const dx = e.clientX - drag.x;
      onChange(Math.round(Math.max(min, Math.min(max, drag.start + (side === "left" ? dx : -dx)))));
    };
    const up = () => setDrag(null);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    document.body.classList.add("is-resizing");
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("is-resizing");
    };
  }, [drag, onChange, side, min, max]);
  return (
    <div
      className={"splitter" + (drag ? " is-dragging" : "")}
      role="separator"
      aria-orientation="vertical"
      aria-label={side === "left" ? "Resize projects sidebar" : "Resize files panel"}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        const direction = (e.key === "ArrowRight" ? 1 : -1) * (side === "left" ? 1 : -1);
        onChange(Math.max(min, Math.min(max, value + direction * 16)));
      }}
      onPointerDown={(e) => {
        e.preventDefault();
        setDrag({ x: e.clientX, start: value });
      }}
    />
  );
}
