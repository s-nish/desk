import { keys, modKey } from "../platform";
import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Eye, FileText, GitBranch, GitCommitHorizontal, GitMerge, History, Minus, Plus, RefreshCw, Search, Undo2 } from "lucide-react";
import { useDesk } from "../store";
import { errorText, ipc } from "../ipc";
import { gitChanged, mergeWorktree, onGitChange, openFile, rootProject } from "../actions";
import { handleDiskChanges } from "../editors";
import { FilesPanel } from "./FilesPanel";
import { SessionsPanel } from "./Sessions";
import { LineCounts, isStaged, isUnstaged, splitPath, statusLetter, statusWord } from "./Review";
import type { GitChange, GitStatus, Project, SearchFile, SearchResults } from "../types";

/** Change counts per repository root, so the Changes tab can show how many files changed. */
export const useChangeCount = (path: string | undefined) => useDesk((s) => (path ? s.changeCounts[path] ?? 0 : 0));

export function ProjectTools() {
  const project = useDesk((s) => s.projects.find((p) => p.id === s.activeProjectId));
  const panel = useDesk((s) => s.layout.panel);
  const changes = useChangeCount(project?.path);
  // The Git tab's count for a project just switched to.
  useEffect(() => { if (project) gitChanged(project.path); }, [project?.path]);
  const tabs = [["files", FileText, "Files"], ["search", Search, "Search"], ["git", GitBranch, "Git"], ["sessions", History, "History"]] as const;
  return <aside className="project-tools">
    <nav className="tools-nav" aria-label="Project tools">{tabs.map(([id, Icon, label]) => <button key={id} className={panel === id ? "is-active" : ""} aria-pressed={panel === id} title={id === "sessions" ? "Past Claude Code and Codex conversations" : label} onClick={() => useDesk.getState().setLayout({ panel: id })}><span className="tools-icon"><Icon size={14} />{id === "git" && changes > 0 && <span className="tools-count">{changes > 99 ? "99+" : changes}</span>}</span><span>{label}</span></button>)}</nav>
    {!project ? <p className="tree-note">Add a project to explore its files, search, and changes.</p> : panel === "files" ? <FilesPanel /> : panel === "search" ? <ProjectSearch key={project.id} project={project} /> : panel === "git" ? <GitPanel key={project.id} project={project} /> : <SessionsPanel key={project.id} project={project} />}
  </aside>;
}

function ProjectSearch({ project }: { project: Project }) {
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [results, setResults] = useState<SearchResults | null>(null);
  const [showReplace, setShowReplace] = useState(false);
  const [busy, setBusy] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [error, setError] = useState("");
  const [report, setReport] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let live = true;
    setResults(null); setError("");
    if (!query) { setBusy(false); return; }
    setBusy(true);
    const timer = setTimeout(() => {
      void ipc.search(project.path, query, caseSensitive).then((r) => { if (live) setResults(r); }).catch((e) => { if (live) setError(errorText(e)); }).finally(() => { if (live) setBusy(false); });
    }, 250);
    return () => { live = false; clearTimeout(timer); };
  }, [query, caseSensitive, project.path, revision]);
  const replace = (files: SearchFile[]) => {
    const count = files.reduce((n, f) => n + f.count, 0);
    useDesk.getState().setModal({ kind: "confirm", title: `Replace ${count} matches?`, body: `Apply the replacement to ${files.length} file(s) in ${project.name}. Files with unsaved edits or changes since this search will be skipped. This writes to disk.`, confirm: "Replace", onConfirm: async () => {
      setReplacing(true); setReport("");
      const dirtyPaths = new Set(useDesk.getState().tabs.filter((t) => t.type === "file" && t.dirty).map((t) => t.type === "file" ? t.path : ""));
      const safe = files.filter((f) => !dirtyPaths.has(`${project.path}/${f.path}`));
      try {
        const result = await ipc.replace(project.path, query, replacement, caseSensitive, safe.map((f) => ({ path: f.path, original: f.original })));
        await handleDiskChanges(result.modified.map((path) => `${project.path}/${path}`));
        setReport(`${result.modified.length} file(s) updated. ${files.length - safe.length} unsaved file(s) skipped.${result.errors.length ? "\n" + result.errors.join("\n") : ""}`);
        setRevision((r) => r + 1);
      } catch (e) { setError(errorText(e)); }
      finally { setReplacing(false); }
    } });
  };
  const preview = (text: string) => text.replace(new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), caseSensitive ? "gu" : "giu"), () => replacement);
  const total = results?.files.reduce((n, f) => n + f.count, 0) ?? 0;
  return <div className="tool-panel">
    <header className="side-header"><h2>Search project</h2><button className="icon-btn" aria-label="Refresh search" disabled={!query || busy || replacing} onClick={() => setRevision((r) => r + 1)}><RefreshCw size={13} /></button></header>
    <div className="tool-inputs"><input autoFocus aria-label="Search project text" placeholder="Find text in files…" value={query} disabled={replacing} onChange={(e) => { setQuery(e.target.value); setReport(""); }} />
      <div className="search-options"><label><input type="checkbox" checked={caseSensitive} disabled={replacing} onChange={(e) => setCaseSensitive(e.target.checked)} />Match case</label><button className="text-button" aria-expanded={showReplace} onClick={() => setShowReplace(!showReplace)}>{showReplace ? "Hide replacement" : "Replace…"}</button></div>
      {showReplace && <><input aria-label="Replacement text" placeholder="Replace with…" value={replacement} disabled={replacing} onChange={(e) => setReplacement(e.target.value)} /><button className="btn" disabled={!total || !!results?.truncated || busy || replacing} onClick={() => replace(results!.files)}>{replacing ? "Replacing…" : `Replace all ${total} matches`}</button></>}
    </div>
    <div className="tool-results" aria-live="polite">
      {error && <p className="tool-error">{error}</p>}{report && <p className="tool-report">{report}</p>}
      {busy ? <p className="tree-note">Searching…</p> : !query ? <p className="tree-note">Search literal text across project files. Ignored folders and binary files are excluded.</p> : results && <><p className="results-summary">{total} matches in {results.files.length} files</p>{results.truncated && <p className="tool-error">Result limit reached. Narrow your search to enable Replace all.</p>}{results.skipped > 0 && <p className="tree-note">{results.skipped} unreadable, binary, or oversized files skipped.</p>}
        {results.files.map((file) => <details key={file.path} className="search-file" open><summary title={file.path}>{file.path}<span>{file.count}</span></summary>{file.matches.map((match) => <button className="search-match" key={match.line} onClick={() => void openFile(project.id, `${project.path}/${file.path}`, match.line)}><span className="search-line">{match.line}</span><span><code>{match.text}</code>{showReplace && <code className="replacement-preview">{preview(match.text)}</code>}</span></button>)}{showReplace && <button className="text-button" disabled={replacing} onClick={() => replace([file])}>Replace in this file</button>}</details>)}{total === 0 && <p className="tree-note">No matching text.</p>}</>}
    </div>
  </div>;
}

function GitPanel({ project }: { project: Project }) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const generation = useRef(0);
  const mounted = useRef(true);
  const parent = rootProject(project);
  const worktree = parent !== project ? parent : null;
  const refresh = async () => {
    const request = ++generation.current;
    try {
      const next = await ipc.gitStatus(project.path);
      if (mounted.current && request === generation.current) {
        setStatus(next); setError("");
        useDesk.getState().setBranch(project.id, next.branch);
        useDesk.getState().setChangeCount(project.path, next.changes.length);
      }
    }
    catch (e) { if (mounted.current && request === generation.current) { setError(errorText(e)); setStatus(null); } }
    finally { if (mounted.current && request === generation.current) setLoading(false); }
  };
  useEffect(() => {
    mounted.current = true; void refresh();
    // Refreshes when files or Git state change on disk, and when Desk comes back into focus.
    const off = onGitChange(project.path, () => void refresh());
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => { mounted.current = false; off(); window.removeEventListener("focus", onFocus); generation.current++; };
  }, [project.path]);
  const run = async (task: () => Promise<unknown>) => {
    if (!status || busy) return;
    setBusy(true);
    try { await task(); await refresh(); }
    catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  };
  const staged = status?.changes.filter(isStaged) ?? [];
  const unstaged = status?.changes.filter(isUnstaged) ?? [];
  // With nothing staged, Commit takes every change (like VS Code's smart commit).
  const commitAll = staged.length === 0 && unstaged.length > 0;
  const commitCount = commitAll ? unstaged.length : staged.length;
  const commit = () => {
    if (!status || !message.trim() || !commitCount) return;
    void run(async () => {
      if (commitAll) await ipc.gitStageAll(status.root, true);
      await ipc.gitCommit(status.root, message);
      setMessage("");
      useDesk.getState().toast(`Committed ${commitCount} file${commitCount === 1 ? "" : "s"} to ${status.branch}.`);
    });
  };
  const discard = (change: GitChange) => {
    const untracked = change.index === "?";
    const name = splitPath(change.path).name;
    useDesk.getState().setModal({
      kind: "confirm",
      title: `Discard changes to ${name}?`,
      body: untracked ? "This new file is moved to the Trash. You can restore it from there." : "Your unstaged edits to this file are thrown away and can't be recovered. Staged changes are kept.",
      confirm: untracked ? "Move to Trash" : "Discard changes",
      danger: true,
      onConfirm: () => void run(() => ipc.gitDiscard(status!.root, change.path)),
    });
  };
  const review = (change?: GitChange, inStaged = false) => {
    const first = change ?? unstaged[0] ?? staged[0];
    if (!status || !first) return;
    useDesk.getState().setModal({ kind: "diff", root: status.root, path: first.path, staged: change ? inStaged : !unstaged.length });
  };
  const total = (list: GitChange[], key: "stagedLines" | "unstagedLines") => list.reduce<[number, number]>((n, c) => [n[0] + (c[key]?.[0] ?? 0), n[1] + (c[key]?.[1] ?? 0)], [0, 0]);

  return <div className="tool-panel git-panel">
    <header className="side-header"><h2>Source control</h2><button className="icon-btn" aria-label="Refresh Git changes" disabled={busy} onClick={() => void refresh()}><RefreshCw size={13} className={busy ? "is-spinning" : ""} /></button></header>
    {loading && <p className="tree-note">Reading repository…</p>}
    {error && <p className="tool-error" role="alert">{error}</p>}
    {status && <>
      <div className="repo-card">
        <div className="repo-branch">
          <GitBranch size={13} />
          <strong>{status.branch}</strong>
          {status.upstream && (status.ahead > 0 || status.behind > 0) && <span className="repo-sync" title={`${status.ahead} to push, ${status.behind} to pull from ${status.upstream}`}>{status.ahead > 0 && <><ArrowUp size={11} />{status.ahead}</>}{status.behind > 0 && <><ArrowDown size={11} />{status.behind}</>}</span>}
          {status.upstream && status.ahead === 0 && status.behind === 0 && <span className="repo-sync is-even" title={`Up to date with ${status.upstream}`}>synced</span>}
        </div>
        {status.lastCommit && <p className="repo-last" title="Latest commit"><GitCommitHorizontal size={12} /><span>{status.lastCommit}</span></p>}
        {worktree && <div className="repo-worktree">
          <span>Worktree of <strong>{worktree.name}</strong>{project.base ? `, from ${project.base}` : ""}</span>
          <button className="mini-btn" onClick={() => mergeWorktree(project)}><GitMerge size={12} />Merge</button>
        </div>}
        {status.root !== project.path && <p className="settings-note">Repository: {status.root}</p>}
      </div>
      <div className="commit-box">
        <textarea aria-label="Commit message" placeholder={commitAll ? `Message for all ${unstaged.length} changes` : "Commit message"} value={message} disabled={busy}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && modKey(e)) { e.preventDefault(); commit(); } }} />
        <button className="btn is-primary" disabled={busy || !message.trim() || !commitCount} onClick={commit} title={keys("⌘↵")}>
          {busy ? "Working…" : commitCount ? `Commit ${commitAll ? "all " : ""}${commitCount} file${commitCount === 1 ? "" : "s"}` : "Nothing to commit"}
        </button>
        <small className="settings-note">{commitAll ? "Nothing is staged, so every change is included." : "Only staged files are committed."} Unsaved editor changes aren't included. Nothing is pushed.</small>
      </div>
      <div className="tool-results git-results">
        {([["Staged", staged, true], ["Changes", unstaged, false]] as const).map(([label, changes, inStaged]) => changes.length > 0 && <section className="git-group" key={label}>
          <h3>
            <span>{label}</span><span className="section-count">{changes.length}</span>
            <LineCounts lines={total(changes, inStaged ? "stagedLines" : "unstagedLines")} />
            <span className="git-group-actions">
              {!inStaged && <button className="icon-btn" aria-label="Review changes" title="Review all changes" onClick={() => review()}><Eye size={13} /></button>}
              <button className="icon-btn" disabled={busy} aria-label={inStaged ? "Unstage all" : "Stage all"} title={inStaged ? "Unstage all" : "Stage all"} onClick={() => void run(() => ipc.gitStageAll(status.root, !inStaged))}>{inStaged ? <Minus size={13} /> : <Plus size={13} />}</button>
            </span>
          </h3>
          {changes.map((change) => {
            const code = inStaged ? change.index : change.worktree;
            const { dir, name } = splitPath(change.path);
            return <div className="git-file" key={change.path}>
              <button className="git-file-name" title={`${statusWord(code)}: ${change.path}${change.originalPath ? `\nfrom ${change.originalPath}` : ""}\nClick to review`} aria-label={`Review ${change.path}`} onClick={() => review(change, inStaged)}>
                <span className={"git-letter is-" + statusLetter(code)} aria-label={statusWord(code)}>{statusLetter(code)}</span>
                <span className="git-name"><span className={code === "D" ? "is-deleted" : ""}>{name}</span>{dir && <small>{dir}</small>}</span>
                <LineCounts lines={inStaged ? change.stagedLines : change.unstagedLines} untracked={code === "?"} />
              </button>
              <span className="git-file-actions">
                {code !== "D" && <button className="icon-btn" aria-label={`Open ${change.path}`} title="Open file" onClick={() => void openFile(project.id, `${status.root}/${change.path}`)}><FileText size={13} /></button>}
                {!inStaged && <button className="icon-btn" disabled={busy} aria-label={`Discard ${change.path}`} title="Discard changes" onClick={() => discard(change)}><Undo2 size={13} /></button>}
                <button className="icon-btn" disabled={busy} aria-label={`${inStaged ? "Unstage" : "Stage"} ${change.path}`} title={inStaged ? "Unstage" : "Stage"} onClick={() => void run(() => ipc.gitStage(status.root, change.path, !inStaged))}>{inStaged ? <Minus size={13} /> : <Plus size={13} />}</button>
              </span>
            </div>;
          })}
        </section>)}
        {!status.changes.length && <div className="panel-empty"><GitBranch size={18} /><strong>No changes</strong><span>Everything in {status.branch} is committed.</span></div>}
      </div>
    </>}
  </div>;
}
