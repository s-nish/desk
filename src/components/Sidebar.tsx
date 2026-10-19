import { useState } from "react";
import { Search, Settings2, ChevronDown, Ellipsis, Folder, FolderOpen, FolderSearch, LogIn, Palette, Pencil, Plus, SquareTerminal, Trash2 } from "lucide-react";
import { ACCOUNT_COLORS, TOOL_LABEL, projectAccount, useDesk } from "../store";
import { addProjectsFromDialog, chooseProjectAccount, openTerminal, removeAccount, removeProject } from "../actions";
import { ipc } from "../ipc";
import { DeskLogo } from "./DeskLogo";
import { openMenu } from "./Menu";
import type { Account, MenuItem, Project, Tool } from "../types";

export function Sidebar() {
  return (
    <aside className="sidebar">
      <div className="sidebar-brand"><span className="brand-mark"><DeskLogo size={22} /></span><div><strong>Desk</strong></div></div>
      <Projects />
      <Accounts />
      <button className="settings-link" onClick={() => useDesk.getState().setModal({ kind: "settings" })}><Settings2 size={16} /><span>Settings</span><kbd>⌘,</kbd></button>
    </aside>
  );
}

/** The accounts a project can use for one tool, with the current one checked. */
export function accountChoices(project: Project, kind: Tool, withAdd = true): MenuItem[] {
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

function AccountPill({ project, kind }: { project: Project; kind: Tool }) {
  const accounts = useDesk((s) => s.accounts);
  const identities = useDesk((s) => s.identities);
  const current = projectAccount(accounts, project, kind);

  const choose = (e: React.MouseEvent) => {
    e.stopPropagation();
    openMenu(e.currentTarget, accountChoices(project, kind));
  };

  return (
    <button
      className="pill"
      style={{ "--acct": current.color } as React.CSSProperties}
      title={`${TOOL_LABEL[kind]} runs as ${current.name}${identities[current.id]?.email ? ` (${identities[current.id]!.email})` : ""}. Click to change.`}
      onClick={choose}
    >
      <span className="pill-tool">{kind === "claude" ? "Claude" : "Codex"}</span>
      <span className="pill-name">{current.name}</span>
      <ChevronDown size={11} className="pill-chevron" />
    </button>
  );
}

function ProjectRow({ project, index }: { project: Project; index: number }) {
  const active = useDesk((s) => s.activeProjectId === project.id);
  const running = useDesk((s) => s.tabs.filter((t) => t.projectId === project.id && t.type === "terminal" && t.status === "running").length);
  const activity = useDesk((s) => s.tabs.some((t) => t.projectId === project.id && t.type === "terminal" && t.activity));
  const showAccounts = useDesk((s) => s.preferences.showProjectAccounts);
  const [dropTarget, setDropTarget] = useState(false);

  const menu = (at: { x: number; y: number } | Element) =>
    openMenu(at, [
      { label: "New Claude Code tab", icon: <SquareTerminal size={14} />, onSelect: () => openTerminal(project.id, "claude") },
      { label: "New Codex tab", icon: <SquareTerminal size={14} />, onSelect: () => openTerminal(project.id, "codex") },
      { label: "New shell tab", icon: <SquareTerminal size={14} />, onSelect: () => openTerminal(project.id, "shell") },
      { separator: true },
      { label: "Claude Code account", disabled: true },
      ...accountChoices(project, "claude", false),
      { label: "Codex account", disabled: true },
      ...accountChoices(project, "codex", false),
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
      onClick={() => useDesk.getState().selectProject(project.id)}
      onKeyDown={(e) => e.key === "Enter" && useDesk.getState().selectProject(project.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        menu({ x: e.clientX, y: e.clientY });
      }}
      title={project.path}
    >
      <div className="project-head">
        {active ? <FolderOpen size={15} className="project-icon" /> : <Folder size={15} className="project-icon" />}
        <span className="project-name">{project.name}</span>
        {running > 0 && (
          <span className={"run-count" + (activity ? " has-activity" : "")} title={`${running} running terminal${running > 1 ? "s" : ""}`}>
            {running}
          </span>
        )}
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
      {(active || showAccounts) && <div className="project-accounts">
        <AccountPill project={project} kind="claude" />
        <AccountPill project={project} kind="codex" />
      </div>}
    </div>
  );
}

function Projects() {
  const projects = useDesk((s) => s.projects);
  const [query, setQuery] = useState("");
  const filtered = projects.filter((p) => `${p.name} ${p.path}`.toLowerCase().includes(query.toLowerCase()));
  return (
    <section className="side-section projects">
      <header className="side-header">
        <h2>Projects <span className="section-count">{projects.length}</span></h2>
        <button className="icon-btn" aria-label="Add project folder" title="Add project folder (⌘O)" onClick={() => void addProjectsFromDialog()}>
          <Plus size={15} />
        </button>
      </header>
      <label className="project-search"><Search size={13} /><input aria-label="Search projects" placeholder="Find a project…" value={query} onChange={(e) => setQuery(e.target.value)} /></label>
      <div className="side-scroll">
        {filtered.map((p) => (
          <ProjectRow key={p.id} project={p} index={projects.indexOf(p)} />
        ))}
        {query && filtered.length === 0 && <p className="search-empty">No matching projects.</p>}
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
  if (account.dir) {
    items.push({ separator: true }, { label: "Remove from Desk", icon: <Trash2 size={14} />, danger: true, onSelect: () => removeAccount(account) });
  }
  return items;
}

export function AccountRow({ account }: { account: Account }) {
  const identity = useDesk((s) => s.identities[account.id]);
  const usedBy = useDesk((s) => s.projects.filter((p) => projectAccount(s.accounts, p, account.kind).id === account.id).length);
  const signedIn = identity?.signedIn ?? false;
  const detail = identity?.email ?? identity?.org ?? (signedIn ? "Signed in" : "Not signed in");

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
      {!signedIn && (
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

function Accounts() {
  const accounts = useDesk((s) => s.accounts);
  const groups: Tool[] = ["claude", "codex"];
  const layout = useDesk((s) => s.layout);
  const setLayout = useDesk((s) => s.setLayout);
  return (
    <section className="side-section accounts">
      <header className="side-header">
        <button className="section-toggle" aria-expanded={layout.accountsOpen} aria-controls="sidebar-accounts" onClick={() => setLayout({ accountsOpen: !layout.accountsOpen })}><ChevronDown size={13} className={layout.accountsOpen ? "" : "is-collapsed"} />Accounts<span className="section-count">{accounts.length}</span></button>
        <button
          className="icon-btn"
          aria-label="Add account"
          title="Add account"
          onClick={() => useDesk.getState().setModal({ kind: "addAccount", tool: "claude" })}
        >
          <Plus size={15} />
        </button>
      </header>
      {layout.accountsOpen && <div className="side-scroll" id="sidebar-accounts">
        {groups.map((kind) => (
          <div key={kind} className="account-group">
            <button className="group-toggle" aria-expanded={layout[kind === "claude" ? "claudeOpen" : "codexOpen"]} onClick={() => setLayout({ [kind === "claude" ? "claudeOpen" : "codexOpen"]: !layout[kind === "claude" ? "claudeOpen" : "codexOpen"] })}><ChevronDown size={12} className={layout[kind === "claude" ? "claudeOpen" : "codexOpen"] ? "" : "is-collapsed"} />{TOOL_LABEL[kind]}</button>
            {layout[kind === "claude" ? "claudeOpen" : "codexOpen"] && accounts
              .filter((a) => a.kind === kind)
              .map((a) => (
                <AccountRow key={a.id} account={a} />
              ))}
          </div>
        ))}
      </div>}
    </section>
  );
}
