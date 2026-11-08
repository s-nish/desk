import { FolderPlus, Layers3, Search, Settings2, SquareTerminal } from "lucide-react";
import { EXTRA_AGENTS, TOOL_LABEL, projectAccount, useDesk } from "../store";
import { addProjectsFromDialog, openTerminal } from "../actions";
import { newChat } from "../chat";
import { RecentSessions } from "./Sessions";
import { DeskLogo } from "./DeskLogo";
import { ToolLogo } from "./ToolLogo";
import { Ambient } from "./Ambient";
import type { Project, TabTool } from "../types";

type Mode = "terminal" | "chat";

const SHORTCUT: Partial<Record<TabTool, string>> = { claude: "⌘D", codex: "⌘E", shell: "⌘J" };

function greeting(now = new Date()) {
  const h = now.getHours();
  return h < 5 ? "Late night" : h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

function shortPath(path: string) {
  return path.replace(/^\/Users\/[^/]+/, "~");
}

const glyph = (tool: TabTool, size = 13) => (tool === "shell" ? <SquareTerminal size={size} /> : <ToolLogo tool={tool} size={size} />);

/**
 * Shown whenever nothing is open, in both terminal and chat view: every project
 * at a glance with one-click sessions, recent conversations for the selected
 * project, over the theme's ambient backdrop.
 */
export function Home({ mode }: { mode: Mode }) {
  const projects = useDesk((s) => s.projects);
  const activeProjectId = useDesk((s) => s.activeProjectId);
  const active = projects.find((p) => p.id === activeProjectId);
  const roots = projects.filter((p) => !p.worktreeOf);

  if (!projects.length) return <Welcome />;

  return (
    <div className="home-shell">
      <Ambient />
      <div className="home launcher">
      <div className="home-inner">
        <p className="eyebrow">{new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</p>
        <h1>{greeting()}. <em>What's next?</em></h1>
        <p className="launcher-lead">
          {roots.length === 1 ? "One project" : `${roots.length} projects`} ready.{" "}
          {mode === "chat" ? "Pick an agent on any project to start a chat." : "Open a session in any of them, or pick up where you left off."}
        </p>

        <div className="home-section-head">
          <h2 className="launch-section-title">Projects</h2>
          <button className="home-add" onClick={() => void addProjectsFromDialog()}><FolderPlus size={13} />Add project</button>
        </div>
        <div className="home-grid">
          {roots.map((p) => <ProjectCard key={p.id} project={p} active={p.id === activeProjectId} mode={mode} />)}
        </div>

        {active && <RecentSessions project={active} />}

        <div className="launcher-actions">
          <button onClick={() => useDesk.getState().setQuickOpen(true)}><Search size={14} />Open a file<kbd>⌘P</kbd></button>
          <button onClick={() => useDesk.getState().setModal({ kind: "settings" })}><Settings2 size={14} />Customize Desk<kbd>⌘,</kbd></button>
        </div>
      </div>
      </div>
    </div>
  );
}

function ProjectCard({ project, active, mode }: { project: Project; active: boolean; mode: Mode }) {
  const accounts = useDesk((s) => s.accounts);
  const tabCount = useDesk((s) => s.tabs.filter((t) => t.projectId === project.id).length);
  const select = () => useDesk.getState().selectProject(project.id);
  // Gemini CLI, Cursor Agent, Grok and OpenCode show up once they have an account.
  const extras = EXTRA_AGENTS.filter((k) => accounts.some((a) => a.kind === k));
  const tools: TabTool[] = ["claude", "codex", ...extras, ...(mode === "terminal" ? ["shell" as const] : [])];
  const start = (tool: TabTool) => {
    select();
    if (mode === "chat" && tool !== "shell") newChat(project.id, tool);
    else openTerminal(project.id, tool);
  };

  return (
    <article className={"home-card" + (active ? " is-active" : "")} aria-current={active || undefined} onClick={select}>
      <header>
        <div className="home-card-title">
          <h3>{active && <span className="home-card-dot" aria-hidden="true" />}{project.name}</h3>
          <span className="home-card-path" title={project.path}>{shortPath(project.path)}</span>
        </div>
        {tabCount > 0 && <span className="home-count">{tabCount} open</span>}
      </header>
      <div className="home-card-actions" role="toolbar" aria-label={`Start in ${project.name}`}>
        {tools.map((tool) => {
          const account = tool === "shell" ? null : projectAccount(accounts, project, tool);
          const what = tool === "shell" ? "New shell" : mode === "chat" ? `New ${TOOL_LABEL[tool]} chat` : `New ${TOOL_LABEL[tool]} tab`;
          const tip = `${what}${account && accounts.filter((a) => a.kind === tool).length > 1 ? ` · ${account.name}` : ""}${active && mode === "terminal" && SHORTCUT[tool] ? `  ${SHORTCUT[tool]}` : ""}`;
          return (
            <button
              key={tool}
              className={"home-icon" + (tool === "shell" ? " is-shell" : "")}
              style={account ? ({ "--acct": account.color } as React.CSSProperties) : undefined}
              aria-label={what}
              data-tip={tip}
              onClick={(e) => { e.stopPropagation(); start(tool); }}
            >
              {glyph(tool, 16)}
            </button>
          );
        })}
      </div>
    </article>
  );
}

function Welcome() {
  return (
    <div className="home-shell">
      <Ambient />
      <div className="launcher">
      <div className="launcher-inner">
        <span className="welcome-mark"><DeskLogo size={36} /></span>
        <p className="eyebrow">Desk · AI workspace</p>
        <h1>Good work starts <em>here.</em></h1>
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
    </div>
  );
}
