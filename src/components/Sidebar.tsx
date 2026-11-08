import { useEffect, useState } from "react";
import { Search, ChevronDown, ChevronRight, Copy, Ellipsis, Eye, Folder, FolderOpen, FolderSearch, GitBranch, GitBranchPlus, GitMerge, KeyRound, LogIn, Palette, Pencil, Plug, Plus, Server, SquareTerminal, Trash2 } from "lucide-react";
import { ACCOUNT_COLORS, ACCOUNT_KINDS, EXTRA_AGENTS, TOOL_LABEL, isChatTool, projectAccount, projectTree, useDesk } from "../store";
import { ToolLogo } from "./ToolLogo";
import { addProjectsFromDialog, chooseProjectAccount, resumeSession, connectionLabel, deleteConnection, mergeWorktree, openConnection, openTerminal, removeAccount, removeProject, removeWorktree, saveConnection } from "../actions";
import { ipc } from "../ipc";
import { DeskLogo } from "./DeskLogo";
import { SidebarFooter } from "./SidebarFooter";
import { ToolGlyph, shortTime, useExpanded } from "./Chat";
import { loadSessions, useChats } from "../chat";
import { openMenu } from "./Menu";
import type { Account, AccountKind, Agent, MenuItem, Project, SshConnection } from "../types";

export function Sidebar() {
  return (
    <aside className="sidebar">
      <div className="sidebar-brand"><span className="brand-mark"><DeskLogo size={27} /></span><div><strong>Desk</strong></div></div>
      <Projects />
      <Connections />
      <Accounts />
      <SidebarFooter />
    </aside>
  );
}

/** The accounts a project can use for one tool, with the current one checked. */
export function accountChoices(project: Project, kind: AccountKind, withAdd = true): MenuItem[] {
  const { accounts, identities } = useDesk.getState();
  const current = projectAccount(accounts, project, kind);
  const items: MenuItem[] = accounts
    .filter((a) => a.kind === kind)
    .map((a) => ({
      label: a.name,
      hint: identities[a.id]?.email ?? (identities[a.id]?.signedIn ? "" : "Not signed in"),
      checked: a.id === current.id,
      icon: <span className="dot" style={{ background: a.color }} />,
      onSelect: () => chooseProjectAccount(project.id, kind, a.id),
    }));
  if (withAdd) {
    items.push({
      label: "Add account…",
      icon: <Plus size={14} />,
      onSelect: () => useDesk.getState().setModal({ kind: "addAccount", tool: kind }),
    });
  }
  return items;
}

/** Gemini CLI, Cursor Agent, Grok and OpenCode, once they have an account. */
function extraAgents(): Agent[] {
  const { accounts } = useDesk.getState();
  return EXTRA_AGENTS.filter((k) => accounts.some((a) => a.kind === k));
}

/** Running terminals, agents waiting for you, and whether any has new output, for one project. */
function useProjectRuns(projectId: string) {
  const running = useDesk((s) => s.tabs.filter((t) => t.projectId === projectId && t.type === "terminal" && t.status === "running").length);
  const waiting = useDesk((s) => s.tabs.filter((t) => t.projectId === projectId && t.type === "terminal" && t.attention).length);
  const busy = useDesk((s) => s.tabs.some((t) => t.projectId === projectId && t.type === "terminal" && t.busy && t.status === "running"));
  const activity = useDesk((s) => s.tabs.some((t) => t.projectId === projectId && t.type === "terminal" && t.activity));
  return { running, waiting, busy, activity };
}

function RunBadges({ projectId }: { projectId: string }) {
  const { running, waiting, busy, activity } = useProjectRuns(projectId);
  return <>
    {waiting > 0 && <span className="wait-count" title={`${waiting} agent${waiting > 1 ? "s" : ""} waiting for you`}>{waiting}</span>}
    {running > 0 && waiting === 0 && (
      <span className={"run-count" + (activity ? " has-activity" : "") + (busy ? " is-busy" : "")} title={`${running} running terminal${running > 1 ? "s" : ""}${busy ? ", an agent is working" : ""}`}>
        {running}
      </span>
    )}
  </>;
}

function showChanges(projectId: string) {
  const s = useDesk.getState();
  s.selectProject(projectId);
  s.setLayout({ filesOpen: true, panel: "git" });
}

function worktreeMenu(project: Project): MenuItem[] {
  return [
    { label: "New Claude Code tab", icon: <SquareTerminal size={14} />, onSelect: () => openTerminal(project.id, "claude") },
    { label: "New Codex tab", icon: <SquareTerminal size={14} />, onSelect: () => openTerminal(project.id, "codex") },
    { label: "New shell tab", icon: <SquareTerminal size={14} />, onSelect: () => openTerminal(project.id, "shell") },
    { separator: true },
    { label: "Review changes", icon: <Eye size={14} />, onSelect: () => showChanges(project.id) },
    { label: `Merge into ${project.base ?? "its base branch"}…`, icon: <GitMerge size={14} />, disabled: !project.branch, onSelect: () => mergeWorktree(project) },
    { label: "Reveal in Finder", icon: <FolderSearch size={14} />, onSelect: () => void ipc.reveal(project.path) },
    { separator: true },
    { label: "Remove worktree…", icon: <Trash2 size={14} />, danger: true, onSelect: () => removeWorktree(project) },
    { label: "Hide from Desk", hint: "Keeps the folder", onSelect: () => removeProject(project.id) },
  ];
}

function WorktreeRow({ project }: { project: Project }) {
  const active = useDesk((s) => s.activeProjectId === project.id);
  const changes = useDesk((s) => s.changeCounts[project.path] ?? 0);
  const menu = (at: { x: number; y: number } | Element) => openMenu(at, worktreeMenu(project));
  return (
    <div
      className={"project worktree" + (active ? " is-active" : "")}
      role="button"
      tabIndex={0}
      onClick={() => useDesk.getState().selectProject(project.id)}
      onKeyDown={(e) => e.key === "Enter" && useDesk.getState().selectProject(project.id)}
      onContextMenu={(e) => { e.preventDefault(); menu({ x: e.clientX, y: e.clientY }); }}
      title={`${project.path}\nWorktree on ${project.branch ?? "a detached HEAD"}${project.base ? `, from ${project.base}` : ""}`}
    >
      <div className="project-head">
        <GitBranch size={13} className="project-icon" />
        <span className="project-name">{project.name}</span>
        {changes > 0 && <span className="worktree-changes" title={`${changes} changed file${changes > 1 ? "s" : ""}`}>{changes}</span>}
        <RunBadges projectId={project.id} />
        <button className="icon-btn row-more" aria-label="Worktree actions" onClick={(e) => { e.stopPropagation(); menu(e.currentTarget); }}>
          <Ellipsis size={14} />
        </button>
      </div>
    </div>
  );
}

function ProjectRow({ project, index }: { project: Project; index: number }) {
  const active = useDesk((s) => s.activeProjectId === project.id);
  const [open, setOpen] = useExpanded(project.id);
  const count = useChats((s) => s.sessions[project.path]?.length);
  const [dropTarget, setDropTarget] = useState(false);
  // Like the chat sidebar: a click opens the project's conversations; clicking the
  // selected project again folds them away.
  const activate = () => {
    if (!active) { useDesk.getState().selectProject(project.id); setOpen(true); }
    else setOpen(!open);
  };

  const menu = (at: { x: number; y: number } | Element) =>
    openMenu(at, [
      { label: "New Claude Code tab", hint: "⌘D", icon: <SquareTerminal size={14} />, onSelect: () => openTerminal(project.id, "claude") },
      { label: "New Codex tab", hint: "⌘E", icon: <SquareTerminal size={14} />, onSelect: () => openTerminal(project.id, "codex") },
      { label: "New shell tab", hint: "⌘J", icon: <SquareTerminal size={14} />, onSelect: () => openTerminal(project.id, "shell") },
      ...extraAgents().map((k) => ({ label: `New ${TOOL_LABEL[k]} tab`, icon: <ToolLogo tool={k} size={14} />, onSelect: () => openTerminal(project.id, k) })),
      { label: "New worktree…", hint: "⌘⇧T", icon: <GitBranchPlus size={14} />, onSelect: () => useDesk.getState().setModal({ kind: "worktree", projectId: project.id }) },
      { separator: true },
      ...(["claude", "codex", ...extraAgents(), "github"] as AccountKind[]).flatMap((k): MenuItem[] =>
        isChatTool(k) || useDesk.getState().accounts.filter((a) => a.kind === k).length > 1
          ? [{ label: `${TOOL_LABEL[k]} account`, disabled: true }, ...accountChoices(project, k, false)]
          : []),
      { separator: true },
      {
        label: "Rename…",
        icon: <Pencil size={14} />,
        onSelect: () =>
          useDesk.getState().setModal({
            kind: "prompt",
            title: "Rename project",
            label: "Name shown in Desk",
            initial: project.name,
            confirm: "Rename",
            onSubmit: (v) => {
              if (!v.trim()) return "Enter a name";
              useDesk.getState().renameProject(project.id, v.trim());
            },
          }),
      },
      { label: "Reveal in Finder", icon: <FolderSearch size={14} />, onSelect: () => void ipc.reveal(project.path) },
      { separator: true },
      { label: "Remove from Desk", icon: <Trash2 size={14} />, danger: true, onSelect: () => removeProject(project.id) },
    ]);

  return (
    <div
      className={"project" + (active ? " is-active" : "") + (dropTarget ? " is-drop" : "")}
      role="button"
      tabIndex={0}
      draggable
      onDragStart={(e) => e.dataTransfer.setData("desk/project", project.id)}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("desk/project")) {
          e.preventDefault();
          setDropTarget(true);
        }
      }}
      onDragLeave={() => setDropTarget(false)}
      onDrop={(e) => {
        setDropTarget(false);
        const id = e.dataTransfer.getData("desk/project");
        if (id) useDesk.getState().moveProject(id, index);
      }}
      aria-expanded={open}
      onClick={activate}
      onKeyDown={(e) => e.key === "Enter" && activate()}
      onContextMenu={(e) => {
        e.preventDefault();
        menu({ x: e.clientX, y: e.clientY });
      }}
      title={`${project.path}\nClick to ${active && open ? "hide" : "show"} conversations`}
    >
      <div className="project-head">
        <ChevronRight size={12} className={"chat-project-caret project-caret" + (open ? " is-open" : "")} />
        {open ? <FolderOpen size={15} className="project-icon" /> : <Folder size={15} className="project-icon" />}
        <span className="project-name">{project.name}</span>
        {!open && count ? <span className="section-count project-conv-count" title={`${count} conversation${count > 1 ? "s" : ""}`}>{count}</span> : null}
        <RunBadges projectId={project.id} />
        <button
          className="icon-btn row-more"
          aria-label="Project actions"
          onClick={(e) => {
            e.stopPropagation();
            menu(e.currentTarget);
          }}
        >
          <Ellipsis size={14} />
        </button>
      </div>
    </div>
  );
}

/** The project's past conversations, shown while its row is open. Clicking one resumes it in a tab. */
function ProjectSessions({ project }: { project: Project }) {
  const [open] = useExpanded(project.id);
  const sessions = useChats((s) => s.sessions[project.path]);
  const tabs = useDesk((s) => s.tabs);
  const running = tabs.flatMap((t) => (t.type === "terminal" && t.status !== "exited" ? [t.sessionId, t.resume] : []));
  const [all, setAll] = useState(false);
  useEffect(() => { if (open || !sessions) void loadSessions(project); }, [open, project.path]); // eslint-disable-line react-hooks/exhaustive-deps
  const list = sessions ?? [];
  const shown = all ? list : list.slice(0, 6);
  if (!open || !sessions) return null;
  return (
    <div className="project-sessions">
      <div className="project-sessions-list">
        {shown.map((s) => (
          <button key={s.tool + s.id} className={"chat-row" + (running.includes(s.id) ? " is-active" : "")} title={`${s.title}\n${TOOL_LABEL[s.tool]}, click to resume in a tab`} onClick={() => resumeSession(s, project.id)}>
            <ToolGlyph tool={s.tool} />
            <span className="chat-row-title">{s.title}</span>
            <span className="chat-row-time">{shortTime(s.updated)}</span>
          </button>
        ))}
        {list.length > 6 && <button className="chat-more" onClick={() => setAll(!all)}>{all ? "Show less" : `Show ${list.length - 6} more`}</button>}
        {sessions && !list.length && <p className="chat-none">No conversations yet</p>}
      </div>
    </div>
  );
}

function Projects() {
  const projects = useDesk((s) => s.projects);
  const [query, setQuery] = useState("");
  const matches = (p: Project) => `${p.name} ${p.path}`.toLowerCase().includes(query.toLowerCase());
  const tree = projectTree(projects)
    .map(({ root, worktrees }) => ({ root, worktrees: worktrees.filter((w) => !query || matches(w) || matches(root)) }))
    .filter(({ root, worktrees }) => !query || matches(root) || worktrees.length > 0);
  return (
    <section className="side-section projects">
      <header className="side-header">
        <h2>Projects <span className="section-count">{projects.filter((p) => !p.worktreeOf).length}</span></h2>
        <button className="icon-btn" aria-label="Add project folder" title="Add project folder (⌘O)" onClick={() => void addProjectsFromDialog()}>
          <Plus size={15} />
        </button>
      </header>
      <label className="project-search"><Search size={13} /><input aria-label="Search projects" placeholder="Find a project…" value={query} onChange={(e) => setQuery(e.target.value)} /></label>
      <div className="side-scroll">
        {tree.map(({ root, worktrees }) => (
          <div key={root.id} className={"project-group" + (worktrees.length ? " has-worktrees" : "")}>
            <ProjectRow project={root} index={projects.indexOf(root)} />
            <ProjectSessions project={root} />
            {worktrees.length > 0 && <div className="worktree-list">{worktrees.map((w) => <WorktreeRow key={w.id} project={w} />)}</div>}
          </div>
        ))}
        {query && tree.length === 0 && <p className="search-empty">No matching projects.</p>}
        {projects.length === 0 && (
          <button className="side-empty" onClick={() => void addProjectsFromDialog()}>
            Add a folder, or drop one here
          </button>
        )}
      </div>
    </section>
  );
}

function accountMenu(account: Account): MenuItem[] {
  const s = useDesk.getState();
  const items: MenuItem[] = [
    { label: "Sign in…", icon: <LogIn size={14} />, onSelect: () => s.setModal({ kind: "signin", accountId: account.id }) },
    {
      label: "Rename…",
      icon: <Pencil size={14} />,
      onSelect: () =>
        s.setModal({
          kind: "prompt",
          title: "Rename account",
          label: "Name",
          initial: account.name,
          confirm: "Rename",
          onSubmit: (v) => {
            if (!v.trim()) return "Enter a name";
            useDesk.getState().updateAccount(account.id, { name: v.trim() });
          },
        }),
    },
    { label: "Color", icon: <Palette size={14} />, disabled: true },
    { swatches: { colors: ACCOUNT_COLORS, current: account.color, onPick: (color) => useDesk.getState().updateAccount(account.id, { color }) } },
    { separator: true },
    {
      label: "Reveal folder in Finder",
      icon: <FolderSearch size={14} />,
      onSelect: () => {
        const path = useDesk.getState().identities[account.id]?.path ?? account.dir;
        if (path) void ipc.reveal(path);
      },
    },
  ];
  if (account.dir || !isChatTool(account.kind)) {
    items.push({ separator: true }, { label: "Remove from Desk", icon: <Trash2 size={14} />, danger: true, onSelect: () => removeAccount(account) });
  }
  return items;
}

export function AccountRow({ account }: { account: Account }) {
  const identity = useDesk((s) => s.identities[account.id]);
  const usedBy = useDesk((s) => s.projects.filter((p) => projectAccount(s.accounts, p, account.kind).id === account.id).length);
  // Cursor Agent and Grok don't expose who's signed in: say so instead of nagging.
  const readable = account.kind !== "cursor" && account.kind !== "grok";
  const signedIn = identity?.signedIn ?? false;
  const detail = identity?.email ?? identity?.org ?? (signedIn ? "Signed in" : readable ? "Not signed in" : `Signs in through ${TOOL_LABEL[account.kind]}`);

  return (
    <div
      className="account"
      style={{ "--acct": account.color } as React.CSSProperties}
      onContextMenu={(e) => {
        e.preventDefault();
        openMenu({ x: e.clientX, y: e.clientY }, accountMenu(account));
      }}
      title={`${identity?.path ?? account.dir ?? ""}\nUsed by ${usedBy} project${usedBy === 1 ? "" : "s"}`}
    >
      <span className="account-bar" />
      <div className="account-text">
        <span className="account-name">{account.name}</span>
        <span className={"account-detail" + (signedIn ? "" : " is-muted")}>{detail}</span>
      </div>
      {!signedIn && readable && (
        <button className="mini-btn" onClick={() => useDesk.getState().setModal({ kind: "signin", accountId: account.id })}>
          Sign in
        </button>
      )}
      <button className="icon-btn row-more" aria-label={`${account.name} actions`} onClick={(e) => openMenu(e.currentTarget, accountMenu(account))}>
        <Ellipsis size={14} />
      </button>
    </div>
  );
}

export function Accounts() {
  const accounts = useDesk((s) => s.accounts);
  const layout = useDesk((s) => s.layout);
  const setLayout = useDesk((s) => s.setLayout);
  // Claude Code and Codex always; the others once they have an account.
  const groups = ACCOUNT_KINDS.filter((k) => isChatTool(k) || accounts.some((a) => a.kind === k));
  const openKey = (kind: AccountKind) => (kind === "claude" ? "claudeOpen" : kind === "codex" ? "codexOpen" : null);
  const isOpen = (kind: AccountKind) => { const k = openKey(kind); return k ? layout[k] : true; };
  return (
    <section className="side-section accounts">
      <header className="side-header">
        <button className="section-toggle" aria-expanded={layout.accountsOpen} aria-controls="sidebar-accounts" onClick={() => setLayout({ accountsOpen: !layout.accountsOpen })}><ChevronDown size={13} className={layout.accountsOpen ? "" : "is-collapsed"} />Accounts<span className="section-count">{accounts.length}</span></button>
        <button
          className="icon-btn"
          aria-label="Add account"
          title="Add an account: Claude Code, Codex, Gemini CLI, Cursor Agent, Grok or OpenCode"
          onClick={() => useDesk.getState().setModal({ kind: "addAccount", tool: "claude" })}
        >
          <Plus size={15} />
        </button>
      </header>
      {layout.accountsOpen && <div className="side-scroll" id="sidebar-accounts">
        {groups.map((kind) => {
          const k = openKey(kind);
          return (
            <div key={kind} className="account-group">
              <button className="group-toggle" aria-expanded={isOpen(kind)} onClick={() => k && setLayout({ [k]: !layout[k] })}><ChevronDown size={12} className={isOpen(kind) ? "" : "is-collapsed"} /><ToolLogo tool={kind} size={12} />{TOOL_LABEL[kind]}</button>
              {isOpen(kind) && accounts.filter((a) => a.kind === kind).map((a) => <AccountRow key={a.id} account={a} />)}
            </div>
          );
        })}
      </div>}
    </section>
  );
}

// Saved connections

export function connectionMenu(c: SshConnection, from?: "settings"): MenuItem[] {
  const s = useDesk.getState();
  return [
    { label: "Connect in new tab", icon: <Plug size={14} />, onSelect: () => (s.setModal(null), openConnection(c.id)) },
    { label: "Edit…", icon: <Pencil size={14} />, onSelect: () => s.setModal({ kind: "ssh", id: c.id, from }) },
    {
      label: "Duplicate",
      icon: <Copy size={14} />,
      // The copy starts without a password; it's never read back out of storage.
      onSelect: () => void saveConnection({ ...c, id: crypto.randomUUID(), name: `${c.name} copy`, password: false }, undefined),
    },
    { label: "Copy command", icon: <Copy size={14} />, onSelect: () => void navigator.clipboard.writeText(c.command) },
    ...(c.password ? [{ label: "Forget password", icon: <KeyRound size={14} />, onSelect: () => void saveConnection(c, null) }] : []),
    { separator: true },
    { label: "Delete…", icon: <Trash2 size={14} />, danger: true, onSelect: () => deleteConnection(c) },
  ];
}

export function ConnectionRow({ connection, from }: { connection: SshConnection; from?: "settings" }) {
  const status = useDesk((s) => {
    const tabs = s.tabs.filter((t) => t.type === "terminal" && t.sshId === connection.id);
    return tabs.some((t) => t.type === "terminal" && t.status === "running") ? "live" : tabs.length ? "closed" : "idle";
  });
  const detail = connectionLabel(connection);
  const connect = () => {
    // Jump to a tab that's already connected instead of opening another.
    const s = useDesk.getState();
    s.setModal(null);
    const live = s.tabs.find((t) => t.type === "terminal" && t.sshId === connection.id && t.status === "running");
    if (live) s.selectTab(live.id);
    else openConnection(connection.id);
  };
  return (
    <div
      className={"connection is-" + status}
      role="button"
      tabIndex={0}
      onClick={connect}
      onKeyDown={(e) => e.key === "Enter" && connect()}
      onContextMenu={(e) => {
        e.preventDefault();
        openMenu({ x: e.clientX, y: e.clientY }, connectionMenu(connection, from));
      }}
      title={`${connection.command}\n${status === "live" ? "Connected. Click to show the tab." : "Click to connect."}`}
    >
      <span className="connection-icon"><Server size={14} /><i aria-hidden /></span>
      <span className="connection-text">
        <span className="connection-name">{connection.name}</span>
        <span className="connection-detail">{detail}</span>
      </span>
      {connection.password && <KeyRound size={12} className="connection-key" aria-label="Password saved" />}
      <button
        className="icon-btn row-more"
        aria-label={`${connection.name} actions`}
        onClick={(e) => {
          e.stopPropagation();
          openMenu(e.currentTarget, connectionMenu(connection, from));
        }}
      >
        <Ellipsis size={14} />
      </button>
    </div>
  );
}

export function Connections() {
  const connections = useDesk((s) => s.connections);
  const open = useDesk((s) => s.layout.sshOpen);
  const setLayout = useDesk((s) => s.setLayout);
  const add = () => useDesk.getState().setModal({ kind: "ssh", id: null });
  return (
    <section className="side-section connections">
      <header className="side-header">
        <button className="section-toggle" aria-expanded={open} aria-controls="sidebar-connections" onClick={() => setLayout({ sshOpen: !open })}>
          <ChevronDown size={13} className={open ? "" : "is-collapsed"} />SSH<span className="section-count">{connections.length}</span>
        </button>
        <button className="icon-btn" aria-label="New connection" title="New SSH connection" onClick={add}>
          <Plus size={15} />
        </button>
      </header>
      {open && (
        <div className="side-scroll" id="sidebar-connections">
          {connections.map((c) => <ConnectionRow key={c.id} connection={c} />)}
          {connections.length === 0 && (
            <button className="side-empty connection-empty" onClick={add}>
              <Server size={14} />
              <span><strong>Save an SSH connection</strong>Connect in one click, with the password filled in.</span>
            </button>
          )}
        </div>
      )}
    </section>
  );
}
