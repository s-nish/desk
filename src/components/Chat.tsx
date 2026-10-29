import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, Asterisk, Check, ChevronDown, ChevronRight, Ellipsis, Gauge, Hexagon, LoaderCircle, MessageSquarePlus, Plus, Search, Server, Settings2, Slash, Square, SquareTerminal, UserRound, X } from "lucide-react";
import { TOOL_LABEL, projectTree, useDesk } from "../store";
import { addProjectsFromDialog, closeTab, openTerminal } from "../actions";
import { TerminalPane, cleanTitle } from "./Workspace";
import { useTabReorder } from "./useTabReorder";
import { ipc } from "../ipc";
import { openMenu } from "./Menu";
import { Connections } from "./Sidebar";
import { relativeTime } from "./Sessions";
import {
  CLAUDE_EFFORTS, CLAUDE_MODELS, CLAUDE_MODES, CODEX_MODES, LOCAL_COMMANDS, answer, chatBusy, closeChat, codexModelList, commandList, loadAllSessions, loadClaudeCommands,
  closeStripTab, moveStripTab, loadCodexModels, loadSessions, newChat, showStripTab, openSession, send, setAccount, setEffort, setMode, setModel, setTool, stop, useChats, type Chat, type ChatItem, type SlashCommand,
} from "../chat";
import type { AgentSession, MenuItem, Project, TerminalTab, Tool } from "../types";

export function ToolGlyph({ tool, size = 13 }: { tool: Tool; size?: number }) {
  return tool === "claude" ? <Asterisk size={size} className="tool-glyph" aria-label="Claude Code" /> : <Hexagon size={size - 1} className="tool-glyph" aria-label="Codex" />;
}

// Sidebar

const SHOWN = 6;

export function ChatSidebar() {
  const projects = useDesk((s) => s.projects);
  const query = useChats((s) => s.query);
  const setQuery = useChats((s) => s.setQuery);
  const activeProjectId = useDesk((s) => s.activeProjectId);
  const accountCount = useDesk((s) => s.accounts.length);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadAllSessions();
    const onFocus = () => loadAllSessions();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [projects.length, accountCount]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && !e.shiftKey && e.key.toLowerCase() === "f" && !(e.target as HTMLElement)?.closest?.(".cm-editor")) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const roots = projectTree(projects).map((t) => t.root);
  const startNew = () => {
    const id = activeProjectId ?? roots[0]?.id;
    if (id) newChat(id);
    else void addProjectsFromDialog();
  };

  return (
    <aside className="sidebar chat-sidebar">
      <div className="chat-side-top">
        <button className="chat-side-action" onClick={startNew}><MessageSquarePlus size={15} /><span>New chat</span><kbd>⌘N</kbd></button>
        <label className="chat-side-search">
          <Search size={14} />
          <input ref={searchRef} aria-label="Search chats" placeholder="Search chats" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setQuery("")} />
          {query && <button className="icon-btn" aria-label="Clear search" onClick={() => setQuery("")}><X size={12} /></button>}
        </label>
      </div>
      <header className="side-header chat-side-header">
        <h2>Projects</h2>
        <button className="icon-btn" aria-label="Add project folder" title="Add project folder (⌘O)" onClick={() => void addProjectsFromDialog()}><Plus size={14} /></button>
      </header>
      <div className="side-scroll chat-side-scroll">
        {roots.map((p) => <ProjectChats key={p.id} project={p} query={query.trim().toLowerCase()} />)}
        {roots.length === 0 && <button className="side-empty" onClick={() => void addProjectsFromDialog()}>Add a project folder to start chatting</button>}
      </div>
      <Connections />
      <button className="settings-link" onClick={() => useDesk.getState().setModal({ kind: "settings" })}><Settings2 size={16} /><span>Settings</span><kbd>⌘,</kbd></button>
    </aside>
  );
}

interface Row { key: string; title: string; tool: Tool; updated: number; session?: AgentSession; chat?: Chat }

function ProjectChats({ project, query }: { project: Project; query: string }) {
  const sessions = useChats((s) => s.sessions[project.path]);
  const chats = useChats((s) => s.chats);
  const activeId = useChats((s) => s.activeId);
  const termId = useChats((s) => s.termId);
  const [expanded, setOpen] = useExpanded(project.id);
  const open = expanded || !!query;
  const [all, setAll] = useState(false);

  const rows = useMemo(() => {
    const live = Object.values(chats).filter((c) => c.projectId === project.id);
    const out: Row[] = [];
    // Chats started here that the CLI hasn't listed yet go first.
    for (const c of live) {
      if (!c.items.length) continue;
      if (!sessions?.some((s) => s.tool === c.tool && s.id === c.sessionId)) out.push({ key: c.id, title: c.title, tool: c.tool, updated: Date.now(), chat: c });
    }
    for (const s of sessions ?? []) out.push({ key: s.tool + s.id, title: s.title, tool: s.tool, updated: s.updated, session: s, chat: live.find((c) => c.tool === s.tool && c.sessionId === s.id) });
    return query ? out.filter((r) => `${r.title} ${r.session?.prompt ?? ""}`.toLowerCase().includes(query)) : out;
  }, [sessions, chats, project.id, query]);

  if (query && !rows.length && !project.name.toLowerCase().includes(query)) return null;
  const shown = all || query ? rows : rows.slice(0, SHOWN);
  const menu = (at: Element | { x: number; y: number }) => openMenu(at, [
    { label: "New Claude Code chat", icon: <Asterisk size={14} />, onSelect: () => newChat(project.id, "claude") },
    { label: "New Codex chat", icon: <Hexagon size={14} />, onSelect: () => newChat(project.id, "codex") },
    { separator: true },
    { label: "Refresh", onSelect: () => void loadSessions(project) },
    { label: "Reveal in Finder", onSelect: () => void ipc.reveal(project.path) },
  ]);
  return (
    <section className="chat-project">
      <div className="chat-project-head" onContextMenu={(e) => { e.preventDefault(); menu({ x: e.clientX, y: e.clientY }); }}>
        <button className="chat-project-name" aria-expanded={open} onClick={() => setOpen(!expanded)} title={project.path}>
          <ChevronRight size={12} className={"chat-project-caret" + (open ? " is-open" : "")} />
          <span>{project.name}</span>
          {!open && rows.length > 0 && <span className="chat-project-count">{rows.length}</span>}
          {rows.some((r) => chatBusy(r.chat)) && !open && <span className="chat-dot is-running" />}
        </button>
        <button className="icon-btn row-more" aria-label={`New chat in ${project.name}`} title="New chat" onClick={() => newChat(project.id)}><Plus size={13} /></button>
        <button className="icon-btn row-more" aria-label={`Actions for ${project.name}`} onClick={(e) => menu(e.currentTarget)}><Ellipsis size={13} /></button>
      </div>
      {open && <>
        {shown.map((r) => {
          const busy = chatBusy(r.chat);
          return (
            <button
              key={r.key}
              className={"chat-row" + (r.chat && r.chat.id === activeId && !termId ? " is-active" : "")}
              title={`${r.title}${r.session ? `\n${TOOL_LABEL[r.tool]}, ${relativeTime(r.updated)}` : ""}`}
              onClick={() => (r.chat ? (useChats.getState().select(r.chat.id), useDesk.getState().selectProject(project.id)) : r.session && openSession(r.session, project))}
            >
              <ToolGlyph tool={r.tool} />
              <span className="chat-row-title">{r.title}</span>
              {busy ? <span className={"chat-dot is-" + busy} aria-label={busy === "waiting" ? "Waiting for you" : "Working"} /> : <span className="chat-row-time">{shortTime(r.updated)}</span>}
            </button>
          );
        })}
        {!query && rows.length > SHOWN && <button className="chat-more" onClick={() => setAll(!all)}>{all ? "Show less" : `Show ${rows.length - SHOWN} more`}</button>}
        {!rows.length && !query && <p className="chat-none">No chats yet</p>}
      </>}
    </section>
  );
}

const OPEN_KEY = "desk-open-projects";
const openProjects = new Set<string>((() => { try { return JSON.parse(localStorage.getItem(OPEN_KEY) ?? "[]"); } catch { return []; } })());
const openListeners = new Set<() => void>();

/** Whether a project's conversation list is open. Closed until clicked, and remembered. */
export function useExpanded(projectId: string): [boolean, (open: boolean) => void] {
  const [, rerender] = useState(0);
  useEffect(() => {
    const listener = () => rerender((n) => n + 1);
    openListeners.add(listener);
    return () => { openListeners.delete(listener); };
  }, []);
  const set = (open: boolean) => {
    if (open) openProjects.add(projectId);
    else openProjects.delete(projectId);
    try { localStorage.setItem(OPEN_KEY, JSON.stringify([...openProjects])); } catch { /* Only a convenience. */ }
    openListeners.forEach((l) => l());
  };
  return [openProjects.has(projectId), set];
}

export function shortTime(ms: number) {
  const minutes = Math.round((Date.now() - ms) / 60000);
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h`;
  if (minutes < 60 * 24 * 7) return `${Math.round(minutes / 1440)}d`;
  return `${Math.round(minutes / 10080)}w`;
}

// Conversation

export function ChatView() {
  const activeId = useChats((s) => s.activeId);
  const termId = useChats((s) => s.termId);
  const chat = useChats((s) => (s.activeId ? s.chats[s.activeId] : undefined));
  const term = useDesk((s) => (termId ? s.tabs.find((t): t is TerminalTab => t.id === termId && t.type === "terminal") : undefined));
  const project = useDesk((s) => s.projects.find((p) => p.id === (chat?.projectId ?? s.activeProjectId)));
  const projects = useDesk((s) => s.projects.length);

  // Something is always on screen: the picked tab, or a blank chat in the selected project.
  useEffect(() => {
    if (term) return;
    if (termId) useChats.setState({ termId: null });
    if (!activeId || !chat) {
      const pid = useDesk.getState().activeProjectId ?? useDesk.getState().projects[0]?.id;
      if (pid) newChat(pid);
    }
  }, [activeId, chat, projects, term, termId]);

  return (
    <main className="workspace chat-main">
      <ChatTabs />
      {term ? (
        <div className="chat-terminal"><TerminalPane tab={term} visible focused /></div>
      ) : chat && project ? (
        <Conversation key={chat.id} chat={chat} project={project} />
      ) : (
        <div className="chat-empty-state"><h1>Chat</h1><p>Add a project folder to start a conversation.</p><button className="btn is-primary" onClick={() => void addProjectsFromDialog()}>Add project folder</button></div>
      )}
    </main>
  );
}

/** Open chats and terminal tabs, side by side, like the terminal view's tabs. */
function ChatTabs() {
  const strip = useChats((s) => s.strip);
  const chats = useChats((s) => s.chats);
  const activeId = useChats((s) => s.activeId);
  const termId = useChats((s) => s.termId);
  const tabs = useDesk((s) => s.tabs);
  const connections = useDesk((s) => s.connections);
  const projectId = useDesk((s) => s.activeProjectId);
  const scroller = useRef<HTMLDivElement>(null);
  const current = termId ? `t:${termId}` : `c:${activeId}`;
  const reorder = useTabReorder(scroller, moveStripTab);

  useEffect(() => {
    scroller.current?.querySelector(".chat-tab.is-active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [current]);

  const items = strip.flatMap((key) => {
    if (key.startsWith("c:")) {
      const chat = chats[key.slice(2)];
      if (!chat) return [];
      return [{ key, title: chat.items.length || chat.saved ? chat.title : "New chat", icon: <ToolGlyph tool={chat.tool} size={12} />, busy: chatBusy(chat), close: () => closeChat(chat.id) }];
    }
    const tab = tabs.find((t): t is TerminalTab => t.id === key.slice(2) && t.type === "terminal");
    if (!tab) return [];
    const connection = tab.sshId ? connections.find((c) => c.id === tab.sshId) : undefined;
    return [{
      key,
      title: tab.sshId ? connection?.name ?? "SSH" : cleanTitle(tab.title) || TOOL_LABEL[tab.tool],
      icon: tab.sshId ? <Server size={12} /> : <SquareTerminal size={12} />,
      busy: tab.busy && tab.status === "running" ? "running" : tab.attention ? "waiting" : null,
      close: () => { closeStripTab(key); closeTab(tab.id); },
    }];
  });

  return (
    <div className="chat-tabs" role="tablist" aria-label="Open chats">
      <div className={"chat-tabs-scroll" + (reorder.landing?.before === null ? " has-drop-at-end" : "")} ref={scroller} onClickCapture={(e) => { if (reorder.suppressClick.current) { e.preventDefault(); e.stopPropagation(); } }}>
        {items.map((t, i) => (
          <div
            key={t.key}
            data-tab-id={t.key}
            role="tab"
            tabIndex={0}
            aria-selected={t.key === current}
            className={"chat-tab" + (t.key === current ? " is-active" : "") + (reorder.draggingId === t.key ? " is-dragging-tab" : "") + (reorder.landing?.before === t.key ? " is-drop-before" : "")}
            title={t.title + "\nDrag to reorder"}
            onPointerDown={(e) => reorder.start(t.key, e)}
            onClick={() => showStripTab(t.key)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") showStripTab(t.key);
              else if (e.altKey && e.shiftKey && e.key === "ArrowLeft" && i > 0) moveStripTab(t.key, items[i - 1].key);
              else if (e.altKey && e.shiftKey && e.key === "ArrowRight" && i < items.length - 1) moveStripTab(t.key, items[i + 2]?.key ?? null);
            }}
            onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); t.close(); } }}
          >
            {t.busy ? <span className={"chat-dot is-" + t.busy} /> : t.icon}
            <span className="chat-tab-title">{t.title}</span>
            <button className="chat-tab-close" aria-label={`Close ${t.title}`} onClick={(e) => { e.stopPropagation(); t.close(); }}><X size={11} /></button>
          </div>
        ))}
      </div>
      <button className="icon-btn chat-tabs-new" aria-label="New chat" title="New chat (⌘N)" onClick={() => projectId && newChat(projectId)}><Plus size={14} /></button>
    </div>
  );
}

function Conversation({ chat, project }: { chat: Chat; project: Project }) {
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const account = useDesk((s) => s.accounts.find((a) => a.id === chat.accountId));

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [chat.items, chat.status, chat.loading]);

  const openInTerminal = () => continueInTerminal(chat);
  const menu = (at: Element) => openMenu(at, [
    { label: "Continue in a terminal tab", icon: <SquareTerminal size={14} />, disabled: !chat.saved || chat.status !== "idle", onSelect: openInTerminal },
    { label: "Copy conversation ID", disabled: !chat.sessionId, onSelect: () => void navigator.clipboard.writeText(chat.sessionId ?? "") },
    { separator: true },
    { label: "Close chat", icon: <X size={14} />, onSelect: () => closeChat(chat.id) },
  ]);
  const empty = !chat.items.length && !chat.loading;

  return (
    <div className="chat-body">
      <header className="chat-head">
        <div className="chat-head-title">
          <strong title={chat.title}>{empty ? "New chat" : chat.title}</strong>
          <span className="chat-head-meta"><ToolGlyph tool={chat.tool} size={12} />{TOOL_LABEL[chat.tool]}{account && <span>· {account.name}</span>}<span>· {project.name}</span></span>
        </div>
        <button className="icon-btn" aria-label="Chat actions" onClick={(e) => menu(e.currentTarget)}><Ellipsis size={15} /></button>
      </header>
      <div className="chat-scroll" ref={scroller} onScroll={(e) => { const el = e.currentTarget; pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
        <div className="chat-thread">
          {chat.truncated && <p className="chat-note">Earlier messages are in the full transcript. Continue in a terminal tab to see everything.</p>}
          {chat.loading && <p className="chat-note"><LoaderCircle size={13} className="is-spinning" />Loading conversation…</p>}
          {empty && <Intro chat={chat} project={project} />}
          {chat.items.map((item, i) => (item.kind === "approval" && item.state === "allowed" && item.tool !== "ExitPlanMode") ? null : <Fragment key={item.id}><Item item={item} chat={chat} />{showDuration(chat, i) && <p className="chat-worked">Worked for {duration(chat.lastTurnMs!)}</p>}</Fragment>)}
          {chat.status !== "idle" && <Working chat={chat} />}
        </div>
      </div>
      <Composer chat={chat} />
    </div>
  );
}

function showDuration(chat: Chat, index: number) {
  return chat.status === "idle" && chat.lastTurnMs != null && index === chat.items.length - 1 && chat.lastTurnMs > 2000;
}

function duration(ms: number) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} seconds` : `${Math.floor(s / 60)} min ${s % 60 ? `${s % 60} s` : ""}`.trim();
}

function Intro({ chat, project }: { chat: Chat; project: Project }) {
  return (
    <div className="chat-intro">
      <h1>What should {TOOL_LABEL[chat.tool]} work on?</h1>
      <p>In <strong>{project.name}</strong>. It runs the {chat.tool === "claude" ? "claude" : "codex"} command you already use, with its own sign-in and history, so you can pick this chat up in a terminal later.</p>
    </div>
  );
}

function Working({ chat }: { chat: Chat }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const waiting = chat.items.some((i) => i.kind === "approval" && i.state === "pending");
  const seconds = chat.startedAt ? Math.round((Date.now() - chat.startedAt) / 1000) : 0;
  return <p className="chat-working"><LoaderCircle size={13} className={waiting ? "" : "is-spinning"} />{waiting ? "Waiting for your answer" : chat.status === "starting" ? "Starting…" : `Working${seconds > 1 ? ` · ${seconds}s` : "…"}`}</p>;
}

function Item({ item, chat }: { item: ChatItem; chat: Chat }) {
  switch (item.kind) {
    case "user":
      return <div className="chat-user"><div className="chat-bubble">{item.text}</div></div>;
    case "assistant":
      return <div className={"chat-assistant" + (item.streaming ? " is-streaming" : "")}><Markdown text={item.text} /></div>;
    case "tool":
      return <ToolRow item={item} />;
    case "approval": {
      const plan = item.tool === "ExitPlanMode" && typeof (item.input as { plan?: unknown })?.plan === "string" ? (item.input as { plan: string }).plan : null;
      if (plan) return (
        <div className={"chat-approval is-" + item.state}>
          <div className="chat-approval-head"><strong>Plan ready</strong>{item.state !== "pending" && <span>{item.state === "allowed" ? "Approved" : item.state === "denied" ? "Kept planning" : "No longer needed"}</span>}</div>
          <div className="chat-plan"><Markdown text={plan} /></div>
          {item.state === "pending" && (
            <div className="chat-approval-actions">
              <button className="btn" onClick={() => answer(chat.id, item.id, false)}>Keep planning</button>
              <button className="btn is-primary" onClick={() => answer(chat.id, item.id, true)}><Check size={14} />Approve plan</button>
            </div>
          )}
        </div>
      );
      return (
        <div className={"chat-approval is-" + item.state}>
          <div className="chat-approval-head"><strong>{TOOL_LABEL[chat.tool]} wants to use {item.tool}</strong>{item.state !== "pending" && <span>{item.state === "allowed" ? "Allowed" : item.state === "denied" ? "Declined" : "No longer needed"}</span>}</div>
          {item.summary && <code className="chat-approval-input">{item.summary}</code>}
          {item.state === "pending" && (
            <div className="chat-approval-actions">
              <button className="btn" onClick={() => answer(chat.id, item.id, false)}>Decline</button>
              <button className="btn is-primary" onClick={() => answer(chat.id, item.id, true)}><Check size={14} />Allow</button>
            </div>
          )}
        </div>
      );
    }
    case "notice":
      return <p className={"chat-notice" + (item.tone === "error" ? " is-error" : "")}>{item.text}</p>;
  }
}

function ToolRow({ item }: { item: Extract<ChatItem, { kind: "tool" }> }) {
  const [open, setOpen] = useState(() => useDesk.getState().preferences.chatToolsOpen);
  const verb = item.name === "Bash" || item.name === "Shell" ? "Ran" : item.name === "Read" ? "Read" : item.name === "Edit" || item.name === "Write" || item.name === "MultiEdit" ? "Edited" : item.name === "Grep" || item.name === "Glob" ? "Searched" : item.name;
  return (
    <div className={"chat-tool is-" + item.state + (open ? " is-open" : "")}>
      <button className="chat-tool-head" onClick={() => setOpen(!open)} disabled={!item.output}>
        {item.state === "running" ? <LoaderCircle size={12} className="is-spinning" /> : <ChevronRight size={12} className="chat-tool-caret" />}
        <span className="chat-tool-verb">{verb}</span>
        {item.summary && <code>{item.summary}</code>}
        {item.state === "error" && <span className="chat-tool-failed">failed</span>}
      </button>
      {open && item.output && <pre className="chat-tool-output">{item.output}</pre>}
    </div>
  );
}

const EFFORT_LABEL: Record<string, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max", minimal: "Minimal", none: "None" };

/** Continues the chat's conversation in a terminal tab, which switches to the terminal view. */
function continueInTerminal(chat: Chat) {
  if (!chat.sessionId || !chat.saved) return useDesk.getState().toast("Send a message first; there is no conversation to continue yet.");
  openTerminal(chat.projectId, chat.tool, { accountId: chat.accountId, cwd: chat.cwd, ...(chat.tool === "claude" ? { sessionId: chat.sessionId } : { resume: chat.sessionId }) });
}

function Composer({ chat }: { chat: Chat }) {
  const [text, setText] = useState("");
  const [pickIndex, setPickIndex] = useState(0);
  const [slashClosed, setSlashClosed] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const accounts = useDesk((s) => s.accounts);
  useChats((s) => s.codexModels);
  useChats((s) => s.commands);
  const account = accounts.find((a) => a.id === chat.accountId);
  const fresh = !chat.saved && !chat.items.length;
  const busy = chat.status !== "idle";
  const modes = chat.tool === "claude" ? CLAUDE_MODES : CODEX_MODES;
  const mode = modes.find((m) => m.id === chat.mode) ?? modes[0];
  const models = chat.tool === "claude" ? CLAUDE_MODELS : [{ id: "", label: "Default model", description: "The model set in Codex" }, ...codexModelList(chat)];
  const model = models.find((m) => m.id === chat.model);
  const efforts = chat.tool === "claude" ? CLAUDE_EFFORTS : (codexModelList(chat).find((m) => m.id === chat.model)?.efforts ?? ["low", "medium", "high", "xhigh"]);

  useEffect(() => { ref.current?.focus(); }, [chat.id]);
  useEffect(() => { if (chat.tool === "codex") void loadCodexModels(chat); }, [chat.tool, chat.accountId]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 260) + "px";
  }, [text]);

  // The slash menu: while the first word is being typed after "/".
  const typed = /^\/(\S*)$/.exec(text)?.[1];
  const commands = useMemo(() => {
    if (typed === undefined) return [];
    const all = [...LOCAL_COMMANDS, ...commandList(chat).filter((c) => !LOCAL_COMMANDS.some((l) => l.name === c.name))];
    const q = typed.toLowerCase();
    return all.filter((c) => c.name.toLowerCase().includes(q)).sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q))).slice(0, 40);
  }, [typed, chat, useChats.getState().commands]); // eslint-disable-line react-hooks/exhaustive-deps
  const slashOpen = typed !== undefined && !slashClosed && commands.length > 0;
  useEffect(() => { if (typed !== undefined) void loadClaudeCommands(chat); }, [typed !== undefined]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setPickIndex(0); setSlashClosed(false); }, [typed]);

  const runLocal = (name: string, arg: string) => {
    const want = arg.trim().toLowerCase();
    switch (name) {
      case "new": newChat(chat.projectId, chat.tool); return true;
      case "terminal": continueInTerminal(chat); return true;
      case "model": {
        const found = models.find((m) => m.id.toLowerCase() === want || m.label.toLowerCase() === want);
        if (found || want === "default") setModel(chat.id, found?.id ?? "");
        else useDesk.getState().toast(`Models: ${models.map((m) => m.id || "default").join(", ")}`);
        return true;
      }
      case "effort": {
        if (efforts.includes(want) || want === "default") setEffort(chat.id, want === "default" ? "" : want);
        else useDesk.getState().toast(`Effort: ${efforts.join(", ")}, or default`);
        return true;
      }
      case "permissions": {
        const found = modes.find((m) => m.id.toLowerCase() === want || m.label.toLowerCase() === want);
        if (found) setMode(chat.id, found.id);
        else useDesk.getState().toast(`Modes: ${modes.map((m) => m.label).join(", ")}`);
        return true;
      }
    }
    return false;
  };

  const choose = (c: SlashCommand) => {
    if (c.local && !c.argumentHint && c.name !== "permissions") {
      runLocal(c.name, "");
      setText("");
      return;
    }
    setText(`/${c.name} `);
    ref.current?.focus();
  };

  const submit = () => {
    if (!text.trim() || busy) return;
    const local = /^\/(\w+)(?:\s+([\s\S]*))?$/.exec(text.trim());
    if (local && LOCAL_COMMANDS.some((c) => c.name === local[1]) && runLocal(local[1], local[2] ?? "")) {
      setText("");
      return;
    }
    void send(chat.id, text);
    setText("");
  };
  const pick = (at: Element, items: MenuItem[]) => openMenu(at, items);

  return (
    <div className="chat-composer-wrap">
      <div className="chat-composer">
        {slashOpen && (
          <div className="chat-slash" role="listbox" aria-label="Slash commands">
            {commands.map((c, i) => (
              <button key={c.name} role="option" aria-selected={i === pickIndex} className={i === pickIndex ? "is-on" : ""} onMouseEnter={() => setPickIndex(i)} onMouseDown={(e) => { e.preventDefault(); choose(c); }}>
                <span className="chat-slash-name">/{c.name}</span>
                {c.argumentHint && <span className="chat-slash-hint">{c.argumentHint}</span>}
                <span className="chat-slash-desc">{c.description}</span>
              </button>
            ))}
            {chat.tool === "claude" && !commandList(chat).length && <p className="chat-slash-note"><LoaderCircle size={12} className="is-spinning" />Loading Claude Code's commands…</p>}
          </div>
        )}
        <textarea
          ref={ref}
          rows={1}
          value={text}
          placeholder={busy ? `${TOOL_LABEL[chat.tool]} is working…` : `Ask ${TOOL_LABEL[chat.tool]}, or type / for commands`}
          aria-label="Message"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (slashOpen) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                setPickIndex((i) => (i + (e.key === "ArrowDown" ? 1 : -1) + commands.length) % commands.length);
                return;
              }
              if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey) {
                e.preventDefault();
                choose(commands[pickIndex]);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setSlashClosed(true);
                return;
              }
            }
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="chat-composer-row">
          {fresh ? (
            <div className="segmented is-small chat-tool-switch" role="radiogroup" aria-label="Agent">
              {(["claude", "codex"] as const).map((t) => <button key={t} role="radio" aria-checked={chat.tool === t} className={chat.tool === t ? "is-on" : ""} onClick={() => setTool(chat.id, t)}><ToolGlyph tool={t} size={12} />{t === "claude" ? "Claude" : "Codex"}</button>)}
            </div>
          ) : <span className="chat-chip is-static"><ToolGlyph tool={chat.tool} size={12} />{chat.tool === "claude" ? "Claude" : "Codex"}</span>}
          <button className="chat-chip" disabled={!fresh} title={fresh ? "Account" : `Account: ${account?.name}. A conversation stays with the account it started on.`} onClick={(e) => pick(e.currentTarget, accounts.filter((a) => a.kind === chat.tool).map((a) => ({ label: a.name, checked: a.id === chat.accountId, onSelect: () => setAccount(chat.id, a.id) })))}>
            <UserRound size={12} />{account?.name ?? "Account"}{fresh && <ChevronDown size={11} />}
          </button>
          <button className="chat-chip" title={mode.hint} onClick={(e) => pick(e.currentTarget, modes.map((m) => ({ label: m.label, hint: m.hint, checked: m.id === chat.mode, onSelect: () => setMode(chat.id, m.id) })))}>
            {mode.label}<ChevronDown size={11} />
          </button>
          <span className="chat-composer-gap" />
          <button className="chat-chip" disabled={busy} title="Model" onClick={(e) => pick(e.currentTarget, models.map((m) => ({ label: m.label, hint: m.description, checked: m.id === chat.model, onSelect: () => setModel(chat.id, m.id) })))}>
            {model?.label ?? chat.model}<ChevronDown size={11} />
          </button>
          <button className="chat-chip" disabled={busy} title="Effort: how hard the model thinks" onClick={(e) => pick(e.currentTarget, [{ label: "Default effort", checked: !chat.effort, onSelect: () => setEffort(chat.id, "") }, ...efforts.map((x) => ({ label: EFFORT_LABEL[x] ?? x, checked: x === chat.effort, onSelect: () => setEffort(chat.id, x) }))])}>
            <Gauge size={12} />{chat.effort ? EFFORT_LABEL[chat.effort] ?? chat.effort : "Effort"}<ChevronDown size={11} />
          </button>
          {busy
            ? <button className="chat-send is-stop" aria-label="Stop" title="Stop" onClick={() => stop(chat.id)}><Square size={11} fill="currentColor" /></button>
            : <button className="chat-send" aria-label="Send" title="Send (Enter)" disabled={!text.trim()} onClick={submit}><ArrowUp size={15} /></button>}
        </div>
      </div>
      <p className="chat-composer-hint"><Slash size={10} />commands · Enter to send · Shift+Enter for a new line</p>
    </div>
  );
}

// Markdown: enough for agent replies (headings, lists, code, quotes, tables, emphasis, links).
// Built as React elements, so nothing in a reply is ever run as HTML.

function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  return <div className="md">{blocks}</div>;
}

function parseBlocks(text: string): React.ReactNode[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: React.ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^\s*(```|~~~)\s*([\w+-]*)/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
      i++;
      out.push(<CodeBlock key={key++} lang={fence[2]} code={body.join("\n")} />);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = Math.min(heading[1].length + 2, 6);
      const Tag = `h${level}` as "h3";
      out.push(<Tag key={key++}>{inline(heading[2])}</Tag>);
      i++;
      continue;
    }
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
      out.push(<hr key={key++} />);
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ""));
      out.push(<blockquote key={key++}>{parseBlocks(body.join("\n"))}</blockquote>);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const cells = (l: string) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(cells(lines[i++]));
      out.push(
        <div className="md-table" key={key++}><table><thead><tr>{head.map((c, j) => <th key={j}>{inline(c)}</th>)}</tr></thead><tbody>{rows.map((r, j) => <tr key={j}>{r.map((c, k) => <td key={k}>{inline(c)}</td>)}</tr>)}</tbody></table></div>,
      );
      continue;
    }
    const list = /^(\s*)([-*+]|\d+[.)])\s+/.exec(line);
    if (list) {
      const ordered = /\d/.test(list[2]);
      const items: string[][] = [];
      const indent = list[1].length;
      while (i < lines.length) {
        const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        if (m && m[1].length <= indent) items.push([m[3]]);
        else if (lines[i].trim() && (/^\s{2,}/.test(lines[i]) || m) && items.length) items[items.length - 1].push(lines[i].replace(new RegExp(`^\\s{0,${indent + 3}}`), ""));
        else if (!lines[i].trim() && i + 1 < lines.length && /^(\s+)([-*+]|\d+[.)])\s+|^\s{2,}\S/.test(lines[i + 1]) && items.length) items[items.length - 1].push("");
        else break;
        i++;
      }
      const Tag = ordered ? "ol" : "ul";
      out.push(<Tag key={key++}>{items.map((body, j) => <li key={j}>{body.length === 1 ? inline(body[0]) : parseBlocks(body.join("\n"))}</li>)}</Tag>);
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^\s*(```|~~~|#{1,6}\s|>|([-*+]|\d+[.)])\s)/.test(lines[i])) para.push(lines[i++]);
    if (!para.length) para.push(lines[i++]);
    out.push(<p key={key++}>{para.map((l, j) => <Fragment key={j}>{j > 0 && <br />}{inline(l)}</Fragment>)}</p>);
  }
  return out;
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="md-code">
      <div className="md-code-head"><span>{lang || "text"}</span><button onClick={() => { void navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1200); }}>{copied ? "Copied" : "Copy"}</button></div>
      <pre><code>{code}</code></pre>
    </div>
  );
}

const INLINE = /(`+)([\s\S]*?)\1|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|_([^_\s][^_]*)_|~~([^~]+)~~|\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>)]+)/g;

function inline(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    if (m[1]) out.push(<code key={key++}>{m[2]}</code>);
    else if (m[3] || m[4]) out.push(<strong key={key++}>{inline(m[3] ?? m[4])}</strong>);
    else if (m[5] || m[6]) out.push(<em key={key++}>{inline(m[5] ?? m[6])}</em>);
    else if (m[7]) out.push(<del key={key++}>{m[7]}</del>);
    else if (m[8]) out.push(<Link key={key++} href={m[9]}>{inline(m[8])}</Link>);
    else if (m[10]) out.push(<Link key={key++} href={m[10]}>{m[10]}</Link>);
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function Link({ href, children }: { href: string; children: React.ReactNode }) {
  const web = /^https?:\/\//.test(href);
  return <a href={web ? href : undefined} title={href} onClick={(e) => { e.preventDefault(); if (web) void ipc.openExternal(href); }}>{children}</a>;
}
