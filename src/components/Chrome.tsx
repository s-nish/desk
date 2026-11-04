import { useEffect, useState } from "react";
import { Bell, Command, GitBranch, MessagesSquare, Settings2, SquareTerminal } from "lucide-react";
import { homeDir } from "@tauri-apps/api/path";
import { useShallow } from "zustand/react/shallow";
import { TOOL_LABEL, isChatTool, projectAccount, shortPath, tabAccount, useDesk, focusedTabId, waitingTabs } from "../store";
import type { Account, Agent, Project } from "../types";
import { accountChoices } from "./Sidebar";
import { openMenu } from "./Menu";
import { UsageChip } from "./Usage";

let home: string | null = null;
void homeDir().then((h) => (home = h.replace(/\/$/, "")));

/** A window with its side panel drawn filled while the panel is open. */
function PanelIcon({ side, open }: { side: "left" | "right"; open: boolean }) {
  const x = side === "left" ? 6.5 : 9.5;
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2.25" stroke="currentColor" strokeWidth="1.5" />
      {open && <path d={side === "left" ? "M3.5 4.5h2.25v7H3.5z" : "M10.25 4.5h2.25v7h-2.25z"} fill="currentColor" opacity=".55" />}
      <path d={`M${x} 3v10`} stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

export function TitleBar() {
  // Names the project of the tab on screen, matching the status bar.
  const project = useDesk((s) => {
    const tab = s.tabs.find((t) => t.id === focusedTabId(s));
    return s.projects.find((p) => p.id === (tab?.projectId ?? s.activeProjectId));
  });
  const showPaths = useDesk((s) => s.preferences.showPaths);
  const layout = useDesk((s) => s.layout);
  const setLayout = useDesk((s) => s.setLayout);
  return (
    <header className="titlebar" data-tauri-drag-region>
      <div className="titlebar-left" data-tauri-drag-region>
        <button
          className={"icon-btn panel-toggle" + (layout.sidebarOpen ? " is-on" : "")}
          aria-label="Toggle projects sidebar"
          title="Projects (⌘B)"
          onClick={() => setLayout({ sidebarOpen: !layout.sidebarOpen })}
        >
          <PanelIcon side="left" open={layout.sidebarOpen} />
        </button>
      </div>
      <div className="titlebar-center" data-tauri-drag-region>
        {project ? (
          <>
            <span className="title-project" data-tauri-drag-region>
              {project.name}
            </span>
            {showPaths && <span className="title-path" data-tauri-drag-region>
              {shortPath(project.path, home)}
            </span>}
          </>
        ) : (
          <span className="title-project" data-tauri-drag-region>
            Desk
          </span>
        )}
      </div>
      <div className="titlebar-right" data-tauri-drag-region>
        <WaitingButton />
        <ViewSwitch />
        <button className="icon-btn" aria-label="Open command palette" title="Command palette (⌘⇧P)" onClick={() => useDesk.getState().setCommandOpen(true)}><Command size={15} /></button>
        <button className="icon-btn" aria-label="Open settings" title="Settings (⌘,)" onClick={() => useDesk.getState().setModal({ kind: "settings" })}><Settings2 size={15} /></button>
        <button
          className={"icon-btn panel-toggle" + (layout.filesOpen ? " is-on" : "")}
          aria-label="Toggle files panel"
          title="Files (⌘⇧B)"
          onClick={() => setLayout({ filesOpen: !layout.filesOpen })}
        >
          <PanelIcon side="right" open={layout.filesOpen} />
        </button>
      </div>
    </header>
  );
}

/** Flips between terminal tabs and the chat view. */
function ViewSwitch() {
  const mode = useDesk((s) => s.preferences.uiMode);
  const set = (uiMode: "terminal" | "chat") => useDesk.getState().setPreferences({ uiMode });
  return (
    <div className="view-switch" role="radiogroup" aria-label="Agent view">
      <button role="radio" aria-checked={mode === "terminal"} className={mode === "terminal" ? "is-on" : ""} title="Terminal view" onClick={() => set("terminal")}><SquareTerminal size={13} /></button>
      <button role="radio" aria-checked={mode === "chat"} className={mode === "chat" ? "is-on" : ""} title="Chat view" onClick={() => set("chat")}><MessagesSquare size={13} /></button>
    </div>
  );
}

/** Shows up only while agents are waiting; lists them to jump straight to one. */
function WaitingButton() {
  const waiting = useDesk(useShallow((s) => waitingTabs(s)));
  const projects = useDesk((s) => s.projects);
  if (!waiting.length) return null;
  return (
    <button
      className="waiting-button"
      aria-label={`${waiting.length} agent${waiting.length > 1 ? "s" : ""} waiting`}
      title="Agents waiting for you (⌘⇧A)"
      onClick={(e) => openMenu(e.currentTarget, waiting.map((t) => ({
        label: `${TOOL_LABEL[t.tool]} in ${projects.find((p) => p.id === t.projectId)?.name ?? "a project"}`,
        hint: t.attention ?? "",
        icon: <span className="tab-waiting is-menu" />,
        onSelect: () => useDesk.getState().selectTab(t.id),
      })))}
    >
      <Bell size={13} />
      <span>{waiting.length} waiting</span>
    </button>
  );
}

function AccountSegment({ kind, account, project }: { kind: Agent; account: Account; project: Project }) {
  const identity = useDesk((s) => s.identities[account.id]);
  const showEmails = useDesk((s) => s.preferences.showAccountEmails);
  return (
    <span className="status-account-group">
    <button
      className="status-account"
      style={{ "--acct": account.color } as React.CSSProperties}
      title={`${identity?.path ?? ""}\nClick to change the ${TOOL_LABEL[kind]} account for ${project.name}`}
      onClick={(e) => openMenu(e.currentTarget, accountChoices(project, kind))}
    >
      <span className="status-tool">{TOOL_LABEL[kind]}</span>
      <span className="status-name">{account.name}</span>
      {showEmails && identity?.email && <span className="status-email">{identity.email}</span>}
      {identity && !identity.signedIn && isChatTool(kind) && <span className="status-email">not signed in</span>}
    </button>
    {identity?.signedIn !== false && isChatTool(kind) && <UsageChip account={account} />}
    </span>
  );
}

export function StatusBar() {
  // Describes the tab on screen, which can belong to a project other than the selected one.
  const tab = useDesk((s) => s.tabs.find((t) => t.id === focusedTabId(s)));
  const project = useDesk((s) => s.projects.find((p) => p.id === (tab?.projectId ?? s.activeProjectId)));
  const accounts = useDesk((s) => s.accounts);
  const showPaths = useDesk((s) => s.preferences.showPaths);
  const branch = useDesk((s) => (project ? s.branches[project.id] : null));

  // A Claude Code or Codex tab shows only the account it runs as; SSH tabs show none; anything else shows both.
  const segments: [Agent, Account][] = [];
  if (tab?.type === "terminal" && tab.tool !== "shell") segments.push([tab.tool, tabAccount(accounts, project, tab)]);
  else if (tab?.type === "terminal" && tab.sshId) { /* an SSH session runs no Claude Code or Codex account */ }
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
        {showPaths && tab?.type === "terminal" && <span className="status-item">{shortPath(tab.cwd, home)}</span>}
        {showPaths && tab?.type === "file" && <span className="status-item">{shortPath(tab.path, home)}</span>}
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
