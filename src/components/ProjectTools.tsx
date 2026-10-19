import { useEffect, useRef, useState } from "react";
import { FileText, GitBranch, Minus, Plus, RefreshCw, Search } from "lucide-react";
import { useDesk } from "../store";
import { errorText, ipc } from "../ipc";
import { openFile } from "../actions";
import { handleDiskChanges } from "../editors";
import { FilesPanel } from "./FilesPanel";
import type { GitChange, GitStatus, Project, SearchFile, SearchResults } from "../types";

export function ProjectTools() {
  const project = useDesk((s) => s.projects.find((p) => p.id === s.activeProjectId));
  const panel = useDesk((s) => s.layout.panel);
  return <aside className="project-tools">
    <nav className="tools-nav" aria-label="Project tools">{([['files', FileText, 'Files'], ['search', Search, 'Search'], ['git', GitBranch, 'Changes']] as const).map(([id, Icon, label]) => <button key={id} className={panel === id ? "is-active" : ""} aria-pressed={panel === id} onClick={() => useDesk.getState().setLayout({ panel: id })}><Icon size={14} />{label}</button>)}</nav>
    {!project ? <p className="tree-note">Add a project to explore its files, search, and changes.</p> : panel === "files" ? <FilesPanel /> : panel === "search" ? <ProjectSearch key={project.id} project={project} /> : <GitPanel key={project.id} project={project} />}
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
  const refresh = async () => {
    const request = ++generation.current;
    try { const next = await ipc.gitStatus(project.path); if (mounted.current && request === generation.current) { setStatus(next); setError(""); useDesk.getState().setBranch(project.id, next.branch); } }
    catch (e) { if (mounted.current && request === generation.current) { setError(errorText(e)); setStatus(null); } }
    finally { if (mounted.current && request === generation.current) setLoading(false); }
  };
  useEffect(() => {
    mounted.current = true; void refresh();
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 5000);
    return () => { mounted.current = false; clearInterval(timer); generation.current++; };
  }, [project.path]);
  const changeStage = async (change: GitChange, staged: boolean) => {
    if (!status || busy) return;
    setBusy(true);
    try { await ipc.gitStage(status.root, change.path, staged); await refresh(); }
    catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  };
  const staged = status?.changes.filter((c) => ![" ", "?", "!"].includes(c.index)) ?? [];
  const unstaged = status?.changes.filter((c) => c.worktree !== " ") ?? [];
  const commit = async () => {
    if (!status || !message.trim() || !staged.length || busy) return;
    setBusy(true);
    try { await ipc.gitCommit(status.root, message); setMessage(""); await refresh(); useDesk.getState().toast("Changes committed."); }
    catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  };
  return <div className="tool-panel"><header className="side-header"><h2>Source control</h2><button className="icon-btn" aria-label="Refresh Git changes" disabled={busy} onClick={() => void refresh()}><RefreshCw size={14} /></button></header>
    {loading && <p className="tree-note">Reading repository…</p>}
    {error && <p className="tool-error" role="alert">{error}</p>}
    {status && <><div className="tool-inputs"><span className="git-branch"><GitBranch size={13} />{status.branch}</span>{status.root !== project.path && <p className="settings-note">Repository: {status.root}</p>}<textarea aria-label="Commit message" placeholder="Describe your changes…" value={message} disabled={busy} onChange={(e) => setMessage(e.target.value)} /><button className="btn is-primary" disabled={busy || !message.trim() || !staged.length} onClick={() => void commit()}>{busy ? "Working…" : `Commit ${staged.length} staged file${staged.length === 1 ? "" : "s"}`}</button><small className="settings-note">Only staged disk changes are committed; unsaved edits are excluded. Nothing is pushed.</small></div>
      <div className="tool-results">{([["Staged changes", staged, true], ["Changes", unstaged, false]] as const).map(([label, changes, isStaged]) => <section className="git-group" key={label}><h3>{label}<span className="section-count">{changes.length}</span></h3>{changes.map((change) => <div className="git-file" key={change.path}><button className="git-file-name" title={`Review ${change.path}`} onClick={() => useDesk.getState().setModal({ kind: "diff", root: status.root, path: change.path, staged: isStaged })}><span className="git-status">{isStaged ? change.index : change.worktree}</span><span>{change.path}</span></button><button className="icon-btn" disabled={busy} aria-label={`${isStaged ? "Unstage" : "Stage"} ${change.path}`} title={isStaged ? "Unstage" : "Stage"} onClick={() => void changeStage(change, !isStaged)}>{isStaged ? <Minus size={14} /> : <Plus size={14} />}</button></div>)}</section>)}{!status.changes.length && <p className="tree-note">Working tree clean. You're all caught up.</p>}</div>
    </>}
  </div>;
}

export function DiffView({ root, path, staged }: { root: string; path: string; staged: boolean }) {
  const [diff, setDiff] = useState<string | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { let live = true; void ipc.gitDiff(root, path, staged).then((value) => { if (live) setDiff(value); }).catch((e) => { if (live) setError(errorText(e)); }); return () => { live = false; }; }, [root, path, staged]);
  return <div className="diff-view"><p className="diff-path">{staged ? "Staged" : "Working tree"} · {path}</p>{error ? <p className="tool-error">{error}</p> : diff === null ? <p className="tree-note">Loading diff…</p> : !diff ? <p className="tree-note">No text diff available. The file may have changed or contain a mode-only change.</p> : <pre>{diff.split("\n").map((line, i) => <span key={i} className={line.startsWith("+") ? "diff-add" : line.startsWith("-") ? "diff-remove" : line.startsWith("@@") ? "diff-hunk" : ""}>{line || " "}</span>)}</pre>}</div>;
}
