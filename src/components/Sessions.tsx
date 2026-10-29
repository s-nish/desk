import { useEffect, useMemo, useState } from "react";
import { ArrowUpRight, Columns2, Copy, Ellipsis, FolderTree, MessagesSquare, Play, RefreshCw, Search } from "lucide-react";
import { TOOL_LABEL, useDesk } from "../store";
import { accountDirs, openInSplit, resumeSession, searchConversations } from "../actions";
import { ipc } from "../ipc";
import { openMenu } from "./Menu";
import type { AgentSession, Project, Tool } from "../types";

// Listing reads files in every account folder, so results are kept for a short while.
const cache = new Map<string, { at: number; list: AgentSession[] }>();
const FRESH_FOR = 15_000;

function useSessions(project: Project) {
  const cached = cache.get(project.path);
  const [list, setList] = useState<AgentSession[] | null>(cached?.list ?? null);
  const [loading, setLoading] = useState(!cached);
  const [revision, setRevision] = useState(0);
  const accounts = useDesk((s) => s.accounts);
  useEffect(() => {
    let live = true;
    const hit = cache.get(project.path);
    if (hit && revision === 0 && Date.now() - hit.at < FRESH_FOR) {
      setList(hit.list);
      setLoading(false);
      return;
    }
    setLoading(true);
    const { claude, codex } = accountDirs();
    void ipc.sessionsList(project.path, claude, codex).then((next) => {
      cache.set(project.path, { at: Date.now(), list: next });
      if (live) setList(next);
    }).catch(() => { if (live) setList([]); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [project.path, revision, accounts.length]);
  return { list, loading, refresh: () => setRevision((r) => r + 1) };
}

export function relativeTime(ms: number, now = Date.now()) {
  const minutes = Math.round((now - ms) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} d ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function dayGroup(ms: number, now = new Date()) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ms >= start) return "Today";
  if (ms >= start - 86_400_000) return "Yesterday";
  if (ms >= start - 6 * 86_400_000) return "This week";
  return "Older";
}

/** Folder the conversation ran in, relative to the project, when it isn't the project itself. */
function where(session: AgentSession, project: Project) {
  if (session.cwd === project.path) return null;
  if (session.cwd.startsWith(project.path + "/")) return session.cwd.slice(project.path.length + 1);
  if (session.cwd.startsWith(project.path + ".worktrees/")) return "worktree " + session.cwd.slice(project.path.length + 11);
  return session.cwd;
}

function useAccountName() {
  const accounts = useDesk((s) => s.accounts);
  return (session: AgentSession) => {
    const sameKind = accounts.filter((a) => a.kind === session.tool);
    if (sameKind.length < 2) return null;
    return sameKind.find((a) => a.dir === session.dir)?.name ?? null;
  };
}

function useOpenIds() {
  const tabs = useDesk((s) => s.tabs);
  return new Set(tabs.flatMap((t) => (t.type === "terminal" && t.status !== "exited" ? [t.sessionId, t.resume] : [])).filter(Boolean) as string[]);
}

function sessionMenu(session: AgentSession, project: Project) {
  return [
    { label: "Resume in a new tab", icon: <Play size={14} />, onSelect: () => resumeSession(session, project.id) },
    {
      label: "Resume to the right",
      icon: <Columns2 size={14} />,
      onSelect: () => {
        const id = resumeSession(session, project.id);
        if (id) openInSplit(id, "right");
      },
    },
    { separator: true },
    { label: "Copy conversation ID", icon: <Copy size={14} />, onSelect: () => void navigator.clipboard.writeText(session.id) },
  ];
}

function SessionRow({ session, project, open, account }: { session: AgentSession; project: Project; open: boolean; account: string | null }) {
  const folder = where(session, project);
  const meta = [TOOL_LABEL[session.tool], account, relativeTime(session.updated)].filter(Boolean).join(", ");
  return (
    <div
      className={"session-row" + (open ? " is-open" : "")}
      role="button"
      tabIndex={0}
      onClick={() => resumeSession(session, project.id)}
      onKeyDown={(e) => e.key === "Enter" && resumeSession(session, project.id)}
      onContextMenu={(e) => { e.preventDefault(); openMenu({ x: e.clientX, y: e.clientY }, sessionMenu(session, project)); }}
      title={`${session.title}\n${session.cwd}\n${open ? "Open in a tab. Click to show it." : "Click to resume."}`}
    >
      <span className="session-title">{session.title}</span>
      {session.prompt && <span className="session-prompt">{session.prompt}</span>}
      <span className="session-meta">
        <span>{meta}</span>
        {folder && <span className="session-folder"><FolderTree size={10} />{folder}</span>}
        {open && <span className="session-open">Open</span>}
      </span>
      <button className="icon-btn row-more" aria-label={`Actions for ${session.title}`} onClick={(e) => { e.stopPropagation(); openMenu(e.currentTarget, sessionMenu(session, project)); }}>
        <Ellipsis size={14} />
      </button>
    </div>
  );
}

/** Every past conversation in the project, grouped by day. Lives in the right-hand panel. */
export function SessionsPanel({ project }: { project: Project }) {
  const { list, loading, refresh } = useSessions(project);
  const [query, setQuery] = useState("");
  const [tool, setTool] = useState<Tool | "all">("all");
  const openIds = useOpenIds();
  const accountName = useAccountName();
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (list ?? []).filter((s) => (tool === "all" || s.tool === tool) && (!q || `${s.title} ${s.prompt ?? ""} ${s.cwd}`.toLowerCase().includes(q)));
  }, [list, query, tool]);
  const groups = useMemo(() => {
    const out: { label: string; items: AgentSession[] }[] = [];
    for (const s of shown) {
      const label = dayGroup(s.updated);
      if (out[out.length - 1]?.label !== label) out.push({ label, items: [] });
      out[out.length - 1].items.push(s);
    }
    return out;
  }, [shown]);
  const counts = { all: list?.length ?? 0, claude: list?.filter((s) => s.tool === "claude").length ?? 0, codex: list?.filter((s) => s.tool === "codex").length ?? 0 };
  return (
    <div className="tool-panel">
      <header className="side-header"><h2>History</h2><button className="icon-btn" aria-label="Refresh conversations" disabled={loading} onClick={refresh}><RefreshCw size={13} className={loading ? "is-spinning" : ""} /></button></header>
      <div className="tool-inputs">
        <label className="panel-search sessions-search"><Search size={13} /><input aria-label="Search conversations" placeholder="Search conversations…" value={query} onChange={(e) => setQuery(e.target.value)} /></label>
        <div className="segmented is-small" role="radiogroup" aria-label="Show conversations from">
          {(["all", "claude", "codex"] as const).map((t) => (
            <button key={t} role="radio" aria-checked={tool === t} className={tool === t ? "is-on" : ""} onClick={() => setTool(t)}>
              {t === "all" ? "All" : t === "claude" ? "Claude" : "Codex"}<span>{counts[t]}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="tool-results sessions-list">
        {loading && !list ? <p className="tree-note">Looking for conversations…</p> : groups.map((g) => (
          <section key={g.label} className="session-group">
            <h3>{g.label}</h3>
            {g.items.map((s) => <SessionRow key={s.tool + s.id} session={s} project={project} open={openIds.has(s.id)} account={accountName(s)} />)}
          </section>
        ))}
        {list && !shown.length && (
          query || tool !== "all"
            ? <p className="tree-note">No conversations match.</p>
            : <div className="panel-empty"><MessagesSquare size={18} /><strong>No conversations yet</strong><span>Claude Code and Codex sessions you run in {project.name} show up here, ready to resume with their history.</span></div>
        )}
      </div>
    </div>
  );
}

/** The latest few conversations, on the project's start screen. */
export function RecentSessions({ project }: { project: Project }) {
  const { list } = useSessions(project);
  const openIds = useOpenIds();
  const accountName = useAccountName();
  const recent = (list ?? []).slice(0, 4);
  if (!recent.length) return null;
  return (
    <section className="recent-sessions">
      <div className="recent-head">
        <h2 className="launch-section-title">Continue a conversation</h2>
        <button className="text-button" onClick={searchConversations}><Search size={13} />Search all {list!.length}</button>
      </div>
      <div className="recent-list">
        {recent.map((s) => {
          const folder = where(s, project);
          return (
            <button key={s.tool + s.id} className="recent-session" onClick={() => resumeSession(s, project.id)} title={`${s.title}\n${s.cwd}`}>
              <span className="recent-title">{s.title}</span>
              <span className="recent-meta">{[TOOL_LABEL[s.tool], accountName(s), folder, relativeTime(s.updated)].filter(Boolean).join(", ")}{openIds.has(s.id) ? ", open" : ""}</span>
              <ArrowUpRight size={14} className="launch-arrow" />
            </button>
          );
        })}
      </div>
      {(list?.length ?? 0) > recent.length && (
        <button className="text-button recent-all" onClick={() => useDesk.getState().setLayout({ filesOpen: true, panel: "sessions" })}>
          See all {list!.length} conversations
        </button>
      )}
    </section>
  );
}
