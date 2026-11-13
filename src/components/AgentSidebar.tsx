// The one sidebar, in terminal and chat view alike: each project with its agents
// (chats, agent terminal tabs, past conversations) as the same kind of row.
// A live row opens where it lives, switching the view if it has to; a past
// conversation opens in the view you're in.

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Ellipsis, ExternalLink, MessageSquarePlus, MessagesSquare, Pencil, Plus, Search, SquareTerminal, Trash2, X } from "lucide-react";
import { TOOL_LABEL, projectTree, useDesk } from "../store";
import { addProjectsFromDialog, closeTab, openTerminal, resumeSession } from "../actions";
import { deleteConversation, renameConversation, type Target } from "../sessionActions";
import { loadAllSessions, loadSessions, newChat, openSession, useChats, type Chat } from "../chat";
import { chatBusy } from "../feedCore";
import { ToolGlyph, shortTime, useExpanded } from "./Chat";
import { ProjectRow, WorktreeRow, Connections, Accounts } from "./Sidebar";
import { SidebarFooter } from "./SidebarFooter";
import { openMenu } from "./Menu";
import { ToolLogo } from "./ToolLogo";
import { SandboxLogo } from "./SandboxLogo";
import { sandboxTabItems, useSandboxTerminalPicker } from "./Sandboxes";
import type { Agent, AgentSession, Project, TerminalTab } from "../types";

const SHOWN = 6;

type Row =
  | { key: string; kind: "chat"; title: string; tool: Agent; updated: number; chat: Chat; session?: AgentSession }
  | { key: string; kind: "term"; title: string; tool: Agent; updated: number; tab: TerminalTab; session?: AgentSession }
  | { key: string; kind: "past"; title: string; tool: Agent; updated: number; session: AgentSession };

function rowState(r: Row): "waiting" | "running" | "unread" | null {
  if (r.kind === "chat") return chatBusy(r.chat) ?? (r.chat.unread ? "unread" : null);
  if (r.kind === "term") return r.tab.attention ? "waiting" : r.tab.busy && r.tab.status === "running" ? "running" : null;
  return null;
}

function useRows(project: Project, query: string): Row[] {
  const sessions = useChats((s) => s.sessions[project.path]);
  const chats = useChats((s) => s.chats);
  const tabs = useDesk((s) => s.tabs);
  return useMemo(() => {
    const out: Row[] = [];
    const taken = new Set<string>();
    for (const t of tabs) {
      if (t.type !== "terminal" || t.projectId !== project.id || t.tool === "shell" || t.sshId || t.status === "exited") continue;
      const id = t.sessionId ?? t.resume;
      const past = id ? sessions?.find((s) => s.id === id) : undefined;
      if (id) taken.add(id);
      out.push({ key: `t:${t.id}`, kind: "term", title: past?.title || t.title || TOOL_LABEL[t.tool], tool: t.tool as Agent, updated: past?.updated ?? Date.now(), tab: t, session: past });
    }
    for (const c of Object.values(chats)) {
      if (c.projectId !== project.id || !c.items.length) continue;
      const past = sessions?.find((s) => s.tool === c.tool && s.id === c.sessionId);
      if (c.sessionId) taken.add(c.sessionId);
      out.push({ key: `c:${c.id}`, kind: "chat", title: c.title, tool: c.tool, updated: past?.updated ?? Date.now(), chat: c, session: past });
    }
    for (const s of sessions ?? []) if (!taken.has(s.id)) out.push({ key: `p:${s.tool}${s.id}`, kind: "past", title: s.title, tool: s.tool, updated: s.updated, session: s });
    return query ? out.filter((r) => `${r.title} ${r.kind === "past" ? r.session.prompt ?? "" : ""}`.toLowerCase().includes(query)) : out;
  }, [sessions, chats, tabs, project.id, query]);
}

function openRow(r: Row, project: Project) {
  const desk = useDesk.getState();
  if (r.kind === "chat") {
    if (desk.preferences.uiMode !== "chat") desk.setPreferences({ uiMode: "chat" });
    useChats.getState().select(r.chat.id);
    desk.selectProject(project.id);
  } else if (r.kind === "term") {
    if (desk.preferences.uiMode !== "terminal") desk.setPreferences({ uiMode: "terminal" });
    desk.selectProject(project.id);
    desk.selectTab(r.tab.id);
  } else if (desk.preferences.uiMode === "chat") openSession(r.session, project);
  else resumeSession(r.session, project.id);
}

/** Open, Rename and Delete for a row: a chat, an agent tab or a past conversation. */
function rowMenu(r: Row, project: Project) {
  const target: Target = r.kind === "chat" ? { tool: r.tool, title: r.title, chat: r.chat, session: r.session } : { tool: r.tool, title: r.title, session: r.session };
  // A terminal tab whose conversation isn't saved yet: the name and the close are the tab's own.
  const bareTab = r.kind === "term" && !r.session ? r.tab : null;
  const desk = useDesk.getState();
  return [
    { label: "Open", icon: <ExternalLink size={14} />, onSelect: () => openRow(r, project) },
    { separator: true as const },
    {
      label: "Rename…",
      icon: <Pencil size={14} />,
      onSelect: () => bareTab
        ? desk.setModal({ kind: "prompt", title: "Rename tab", label: "Name", initial: r.title, confirm: "Rename", select: [0, r.title.length], onSubmit: (v) => { const t = v.trim(); if (!t) return "Enter a name."; useDesk.getState().patchTab(bareTab.id, { title: t }); } })
        : renameConversation(target),
    },
    {
      label: "Delete…",
      icon: <Trash2 size={14} />,
      danger: true,
      onSelect: () => bareTab
        ? desk.setModal({ kind: "confirm", title: `Close “${r.title}”?`, body: `${TOOL_LABEL[r.tool]} in this tab stops. Its conversation wasn't saved yet, so there's nothing else to delete.`, confirm: "Close tab", danger: true, onConfirm: () => closeTab(bareTab.id) })
        : deleteConversation(target),
    },
  ];
}

function AgentRow({ row, project, active }: { row: Row; project: Project; active: boolean }) {
  const state = rowState(row);
  const where = row.kind === "past" ? null : row.kind === "chat" ? "Chat" : "Terminal";
  const sandboxId = row.kind === "chat" ? row.chat.where : row.kind === "term" ? row.tab.sandboxId ?? row.tab.codeSandbox : null;
  const sandbox = useDesk((s) => (sandboxId ? s.sandboxes.find((x) => x.id === sandboxId) : undefined));
  return (
    <div
      className={"chat-row agent-row" + (active ? " is-active" : "") + (row.kind === "past" ? " is-past" : "")}
      role="button"
      tabIndex={0}
      title={`${row.title}\n${TOOL_LABEL[row.tool]}${where ? ` · ${where.toLowerCase()}, open` : `, ${shortTime(row.updated)} ago. Click to continue`}\nRight-click for more`}
      onClick={() => openRow(row, project)}
      onKeyDown={(e) => { if (e.key === "Enter" && e.target === e.currentTarget) openRow(row, project); }}
      onContextMenu={(e) => { e.preventDefault(); openMenu({ x: e.clientX, y: e.clientY }, rowMenu(row, project)); }}
    >
      <ToolGlyph tool={row.tool} />
      <span className="chat-row-title">{row.title}</span>
      {sandbox && <span className="agent-row-where" aria-label={`In ${sandbox.name}`} title={`Runs in ${sandbox.name}`}><SandboxLogo provider={sandbox.provider} size={11} /></span>}
      {where && <span className="agent-row-where" aria-label={where}>{row.kind === "chat" ? <MessagesSquare size={11} /> : <SquareTerminal size={11} />}</span>}
      {state ? <span className={"chat-dot is-" + state} aria-label={state === "waiting" ? "Waiting for you" : state === "running" ? "Working" : "New"} /> : row.kind === "past" ? <span className="chat-row-time">{shortTime(row.updated)}</span> : null}
      <button className="icon-btn row-more" aria-label={`Actions for ${row.title}`} title="Open, rename, delete" onClick={(e) => { e.stopPropagation(); openMenu(e.currentTarget, rowMenu(row, project)); }}>
        <Ellipsis size={14} />
      </button>
    </div>
  );
}

function ProjectAgents({ project, query }: { project: Project; query: string }) {
  const [expanded] = useExpanded(project.id);
  const open = expanded || !!query;
  const rows = useRows(project, query);
  const activeChat = useChats((s) => (s.termId ? null : s.activeId));
  const activeTab = useDesk((s) => s.activeTabId);
  const chatMode = useDesk((s) => s.preferences.uiMode === "chat");
  const [all, setAll] = useState(false);
  const sessionsLoaded = useChats((s) => !!s.sessions[project.path]);
  useEffect(() => { if (open && !sessionsLoaded) void loadSessions(project); }, [open, project.path]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!open) return null;
  // Live agents first, then the past, newest first.
  const live = rows.filter((r) => r.kind !== "past");
  const past = rows.filter((r) => r.kind === "past");
  const list = [...live, ...(all || query ? past : past.slice(0, Math.max(0, SHOWN - live.length)))];
  const hidden = past.length - (list.length - live.length);
  const isActive = (r: Row) => (r.kind === "chat" ? chatMode && r.chat.id === activeChat : r.kind === "term" ? !chatMode && r.tab.id === activeTab : false);
  return (
    <div className="project-sessions agent-list">
      {list.map((r) => <AgentRow key={r.key} row={r} project={project} active={isActive(r)} />)}
      {!query && hidden > 0 && <button className="chat-more" onClick={() => setAll(true)}>Show {hidden} more</button>}
      {!query && all && past.length > SHOWN && <button className="chat-more" onClick={() => setAll(false)}>Show less</button>}
      {!rows.length && !query && <p className="chat-none">No agents yet</p>}
    </div>
  );
}

/** Starts an agent in the view you're in: a chat, or a terminal tab. */
function startAgent(projectId: string, tool?: Agent) {
  const desk = useDesk.getState();
  if (desk.preferences.uiMode === "chat") newChat(projectId, tool);
  else openTerminal(projectId, tool ?? "claude");
}

function agentChoices(): Agent[] {
  const accounts = useDesk.getState().accounts;
  return (["claude", "codex", "gemini", "cursor", "grok", "opencode"] as Agent[]).filter((a) => a === "claude" || a === "codex" || accounts.some((x) => x.kind === a));
}

export function AgentSidebar() {
  const projects = useDesk((s) => s.projects);
  const activeProjectId = useDesk((s) => s.activeProjectId);
  const accountCount = useDesk((s) => s.accounts.length);
  const chatMode = useDesk((s) => s.preferences.uiMode === "chat");
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const picker = useSandboxTerminalPicker();
  const q = query.trim().toLowerCase();

  useEffect(() => {
    loadAllSessions();
    const onFocus = () => loadAllSessions();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [projects.length, accountCount]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && !e.shiftKey && e.key.toLowerCase() === "f" && !(e.target as HTMLElement)?.closest?.(".cm-editor, .xterm")) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const tree = projectTree(projects);
  const matches = (p: Project) => `${p.name} ${p.path}`.toLowerCase().includes(q);
  const start = (at?: Element) => {
    const id = activeProjectId ?? tree[0]?.root.id;
    if (!id) return void addProjectsFromDialog();
    if (!at) return startAgent(id);
    const items = agentChoices().map((tool) => ({ label: TOOL_LABEL[tool], hint: chatMode ? "Chat" : "Terminal tab", icon: <ToolLogo tool={tool} size={14} />, onSelect: () => startAgent(id, tool) }));
    // A chat picks its sandbox in the message box; a terminal tab picks it here.
    openMenu(at, chatMode ? items : [...items, { separator: true }, ...sandboxTabItems(at as HTMLElement, id, picker)]);
  };

  return (
    <aside className="sidebar agent-sidebar">
      <div className="chat-side-top">
        <div className="agent-side-new">
          <button className="chat-side-action" onClick={() => start()} title={chatMode ? "New chat in this project" : "New Claude Code tab in this project"}><MessageSquarePlus size={15} /><span>New agent</span><kbd>{chatMode ? "⌘N" : "⌘D"}</kbd></button>
          <button className="icon-btn agent-side-pick" aria-label="Choose an agent" title="Choose an agent" onClick={(e) => start(e.currentTarget)}><ChevronDown size={14} /></button>
        </div>
        <label className="chat-side-search">
          <Search size={14} />
          <input ref={searchRef} aria-label="Search projects and agents" placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setQuery("")} />
          {query && <button className="icon-btn" aria-label="Clear search" onClick={() => setQuery("")}><X size={12} /></button>}
        </label>
      </div>
      <section className="side-section projects">
        <header className="side-header">
          <h2>Projects <span className="section-count">{tree.length}</span></h2>
          <button className="icon-btn" aria-label="Add project folder" title="Add project folder (⌘O)" onClick={() => void addProjectsFromDialog()}><Plus size={15} /></button>
        </header>
        <div className="side-scroll">
          {tree.map(({ root, worktrees }) => {
            const wts = worktrees.filter((w) => !q || matches(w) || matches(root));
            return (
              <div key={root.id} className={"project-group" + (wts.length ? " has-worktrees" : "")}>
                <ProjectRow project={root} index={projects.indexOf(root)} />
                <ProjectAgents project={root} query={matches(root) ? "" : q} />
                {wts.length > 0 && <div className="worktree-list">{wts.map((w) => <WorktreeRow key={w.id} project={w} />)}</div>}
              </div>
            );
          })}
          {projects.length === 0 && <button className="side-empty" onClick={() => void addProjectsFromDialog()}>Add a folder, or drop one here</button>}
        </div>
      </section>
      <Connections />
      <Accounts />
      <SidebarFooter />
      {picker.element}
    </aside>
  );
}
