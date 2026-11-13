import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp, FileText, LoaderCircle, MessageSquarePlus, Minus, Plus, ScanSearch, Send, Trash2, Undo2 } from "lucide-react";
import { TOOL_LABEL, useDesk } from "../store";
import { addComment, removeComment, reviewTargets, sendReview, toggleComment, useReview, type ReviewComment } from "../review";
import { REVIEWERS, cancelReview, crossReview, useCrossReview } from "../crossReview";
import { ToolLogo } from "./ToolLogo";
import { newChat, useChats } from "../chat";
import { openMenu } from "./Menu";
import { errorText, ipc } from "../ipc";
import { openFile, projectForPath } from "../actions";
import type { GitChange, GitStatus } from "../types";
import { parseDiff, type DiffRow } from "../diff";

// Shared Git helpers

const STATUS_WORD: Record<string, string> = { M: "Modified", A: "Added", D: "Deleted", R: "Renamed", C: "Copied", U: "Conflict", "?": "Untracked", T: "Type changed" };

/** The letter shown for a change: untracked files read as U, like in VS Code. */
export function statusLetter(code: string) {
  return code === "?" ? "U" : code;
}

export function statusWord(code: string) {
  return STATUS_WORD[code] ?? "Changed";
}

export function splitPath(path: string) {
  const at = path.lastIndexOf("/");
  return at < 0 ? { dir: "", name: path } : { dir: path.slice(0, at), name: path.slice(at + 1) };
}

export function isStaged(c: GitChange) {
  return ![" ", "?", "!"].includes(c.index);
}

export function isUnstaged(c: GitChange) {
  return c.worktree !== " ";
}

export function LineCounts({ lines, untracked }: { lines: [number, number] | null; untracked?: boolean }) {
  if (!lines) return null;
  const [added, removed] = lines;
  return (
    <span className="line-counts" aria-label={`${added} added, ${removed} removed`}>
      {added > 0 && <span className="is-add">+{added}</span>}
      {removed > 0 && <span className="is-del">−{removed}</span>}
      {!added && !removed && !untracked && <span>0</span>}
    </span>
  );
}

export { parseDiff, type DiffRow } from "../diff";

/** Side-by-side pairs: removed lines sit next to the added lines that replaced them. */
export function pairRows(rows: DiffRow[]) {
  const out: { left: DiffRow | null; right: DiffRow | null; kind?: "hunk" | "meta" }[] = [];
  for (let i = 0; i < rows.length; ) {
    const row = rows[i];
    if (row.kind === "hunk" || row.kind === "meta") {
      out.push({ left: row, right: null, kind: row.kind });
      i++;
    } else if (row.kind === "ctx") {
      out.push({ left: row, right: row });
      i++;
    } else {
      const dels: DiffRow[] = [];
      const adds: DiffRow[] = [];
      while (rows[i]?.kind === "del") dels.push(rows[i++]);
      while (rows[i]?.kind === "add") adds.push(rows[i++]);
      for (let j = 0; j < Math.max(dels.length, adds.length); j++) out.push({ left: dels[j] ?? null, right: adds[j] ?? null });
    }
  }
  return out;
}

// The review screen

interface Selection { path: string; staged: boolean }

export function Review({ root, path, staged }: { root: string; path: string; staged: boolean }) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [selected, setSelected] = useState<Selection>({ path, staged });
  const [diff, setDiff] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"unified" | "split">(() => (localStorage.getItem("desk-diff-mode") === "split" ? "split" : "unified"));
  const body = useRef<HTMLDivElement>(null);
  const comments = useReview((s) => s.comments[root]) ?? NO_COMMENTS;
  const [editing, setEditing] = useState<Spot | null>(null);
  const reviewing = useCrossReview((s) => s.running[root]);

  const refresh = async () => {
    try { setStatus(await ipc.gitStatus(root)); } catch (e) { setError(errorText(e)); }
  };
  useEffect(() => { void refresh(); }, [root]);

  const entries = useMemo(() => {
    const changes = status?.changes ?? [];
    return [
      ...changes.filter(isStaged).map((c) => ({ change: c, staged: true })),
      ...changes.filter(isUnstaged).map((c) => ({ change: c, staged: false })),
    ];
  }, [status]);
  const index = entries.findIndex((e) => e.change.path === selected.path && e.staged === selected.staged);
  const current = entries[index];

  // When the selected file stops having changes in this group (staged, discarded), move to a neighbour.
  useEffect(() => {
    if (!status || index >= 0) return;
    const fallback = entries.find((e) => e.change.path === selected.path) ?? entries[0];
    if (fallback) setSelected({ path: fallback.change.path, staged: fallback.staged });
  }, [status, index]);

  useEffect(() => {
    let live = true;
    setDiff(null);
    setError("");
    void ipc.gitDiff(root, selected.path, selected.staged).then((d) => { if (live) setDiff(d); }).catch((e) => { if (live) setError(errorText(e)); });
    body.current?.scrollTo({ top: 0 });
    return () => { live = false; };
  }, [root, selected.path, selected.staged, status]);

  const step = (delta: number) => {
    const next = entries[(index + delta + entries.length) % entries.length];
    if (next) setSelected({ path: next.change.path, staged: next.staged });
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, textarea")) return;
      if (e.key === "ArrowDown" || e.key === "j") { e.preventDefault(); step(1); }
      if (e.key === "ArrowUp" || e.key === "k") { e.preventDefault(); step(-1); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const act = async (run: () => Promise<void>) => {
    setBusy(true);
    try { await run(); await refresh(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  const stage = () => current && act(() => ipc.gitStage(root, current.change.path, !current.staged));
  const discard = () => {
    if (!current) return;
    const untracked = current.change.index === "?";
    useDesk.getState().setModal({
      kind: "confirm",
      title: `Discard changes to ${splitPath(current.change.path).name}?`,
      body: untracked ? "This new file is moved to the Trash." : "Your unstaged edits to this file are thrown away. Staged changes are kept.",
      confirm: untracked ? "Move to Trash" : "Discard changes",
      danger: true,
      onConfirm: async () => {
        try { await ipc.gitDiscard(root, current.change.path); } catch (e) { useDesk.getState().toast(errorText(e), "error"); }
        useDesk.getState().setModal({ kind: "diff", root, path: current.change.path, staged: false });
      },
    });
  };
  const open = () => {
    const full = `${root}/${selected.path}`;
    const project = projectForPath(full);
    if (!project) return;
    useDesk.getState().setModal(null);
    void openFile(project.id, full);
  };
  const changeMode = (m: "unified" | "split") => {
    setMode(m);
    try { localStorage.setItem("desk-diff-mode", m); } catch { /* per-viewer convenience only */ }
  };

  const rows = useMemo(() => (diff ? parseDiff(diff) : []), [diff]);
  const here = comments.filter((c) => c.path === selected.path);
  const notes: Notes = {
    comments: here,
    editing,
    edit: setEditing,
    save: (text) => { if (editing && text.trim()) addComment(root, { ...editing, path: selected.path, text }); setEditing(null); },
    remove: (id) => removeComment(root, id),
    toggle: (id) => toggleComment(root, id),
  };
  const reviewWith = (at: Element) => {
    const accounts = useDesk.getState().accounts;
    openMenu(at, REVIEWERS.map((tool) => ({
      label: TOOL_LABEL[tool],
      hint: accounts.some((a) => a.kind === tool) ? "Reads the changes, changes nothing" : "No account yet",
      disabled: !accounts.some((a) => a.kind === tool),
      onSelect: () => void crossReview(root, tool),
    })));
  };
  const fileWide = here.filter((c) => !c.line);
  const sending = comments.filter((c) => !c.skip).length;
  const sendTo = (at: Element) => {
    const { chats, tabs } = reviewTargets(root);
    const project = projectForPath(root);
    openMenu(at, [
      ...chats.map((c) => ({ label: c.title, hint: `${TOOL_LABEL[c.tool]} chat`, onSelect: () => sendReview(root, { chat: c }) })),
      ...tabs.map((t) => ({ label: t.title || TOOL_LABEL[t.tool], hint: `${TOOL_LABEL[t.tool]} tab`, onSelect: () => sendReview(root, { tab: t }) })),
      ...(chats.length || tabs.length ? [{ separator: true }] : []),
      ...(project ? [{ label: "New chat", hint: "Start one with these comments", onSelect: () => { const id = newChat(project.id); const chat = id && useChats.getState().chats[id]; if (chat) sendReview(root, { chat }); } }] : []),
    ]);
  };
  const { dir, name } = splitPath(selected.path);
  const code = current ? (current.staged ? current.change.index : current.change.worktree) : "";
  const lines = current ? (current.staged ? current.change.stagedLines : current.change.unstagedLines) : null;

  return (
    <div className="review">
      <nav className="review-files" aria-label="Changed files">
        {(["Staged", "Changes"] as const).map((label) => {
          const group = entries.filter((e) => e.staged === (label === "Staged"));
          if (!group.length) return null;
          return (
            <section key={label}>
              <h3>{label}<span className="section-count">{group.length}</span></h3>
              {group.map((e) => {
                const p = splitPath(e.change.path);
                const c = e.staged ? e.change.index : e.change.worktree;
                const on = e.change.path === selected.path && e.staged === selected.staged;
                return (
                  <button key={label + e.change.path} className={"review-file" + (on ? " is-selected" : "")} aria-current={on} onClick={() => setSelected({ path: e.change.path, staged: e.staged })} title={`${statusWord(c)}: ${e.change.path}`}>
                    <span className={"git-letter is-" + statusLetter(c)}>{statusLetter(c)}</span>
                    <span className="review-file-name">{p.name}{p.dir && <small>{p.dir}</small>}</span>
                  </button>
                );
              })}
            </section>
          );
        })}
        {status && !entries.length && <p className="tree-note">No changes left to review.</p>}
      </nav>
      <div className="review-main">
        <header className="review-head">
          <div className="review-title">
            <strong>{name}</strong>
            {dir && <span>{dir}</span>}
          </div>
          <div className="review-facts">
            {code && <span className={"git-letter is-" + statusLetter(code)}>{statusLetter(code)}</span>}
            {code && <span>{statusWord(code)}{current?.staged ? ", staged" : ""}</span>}
            <LineCounts lines={lines} untracked={code === "?"} />
          </div>
          <div className="review-actions">
            <div className="segmented is-small">
              <button className={mode === "unified" ? "is-on" : ""} onClick={() => changeMode("unified")}>Unified</button>
              <button className={mode === "split" ? "is-on" : ""} onClick={() => changeMode("split")}>Split</button>
            </div>
            <button className="icon-btn" aria-label="Previous file" title="Previous file (↑)" disabled={entries.length < 2} onClick={() => step(-1)}><ChevronUp size={15} /></button>
            <button className="icon-btn" aria-label="Next file" title="Next file (↓)" disabled={entries.length < 2} onClick={() => step(1)}><ChevronDown size={15} /></button>
            <span className="review-sep" />
            <button className="mini-btn" disabled={!!reviewing || !entries.length} onClick={(e) => reviewWith(e.currentTarget)} title="Have another agent review these changes"><ScanSearch size={12} />Review with<ChevronDown size={11} /></button>
            <button className="mini-btn" disabled={code === "D"} onClick={open}><FileText size={12} />Open</button>
            {current && !current.staged && <button className="mini-btn" disabled={busy} onClick={discard}><Undo2 size={12} />Discard</button>}
            {current && <button className="mini-btn is-primary" disabled={busy} onClick={() => void stage()}>{current.staged ? <><Minus size={12} />Unstage</> : <><Plus size={12} />Stage</>}</button>}
          </div>
        </header>
        <div className="review-body" ref={body}>
          {fileWide.length > 0 && <div className="diff-thread is-file">{fileWide.map((c) => <CommentCard key={c.id} c={c} notes={notes} />)}</div>}
          {error ? <p className="tool-error">{error}</p> : diff === null ? <p className="tree-note">Loading the diff…</p> : !rows.length ? <p className="tree-note">No text changes to show. The file may be binary, or only its permissions changed.</p> : mode === "unified" ? <Unified rows={rows} notes={notes} /> : <Split rows={rows} notes={notes} />}
        </div>
        {reviewing && (
          <footer className="review-comments-bar is-reviewing" role="status">
            <LoaderCircle size={14} className="is-spinning" />
            <span>{TOOL_LABEL[reviewing.tool]} is reviewing the changes…</span>
            <span className="review-comments-gap" />
            <button className="mini-btn" onClick={() => cancelReview(root)}>Cancel</button>
          </footer>
        )}
        {comments.length > 0 && (
          <footer className="review-comments-bar">
            <MessageSquarePlus size={14} />
            <span>{sending} of {comments.length} comment{comments.length === 1 ? "" : "s"}{comments.length > here.length ? ` in ${new Set(comments.map((c) => c.path)).size} files` : ""}</span>
            <span className="review-comments-gap" />
            <button className="mini-btn is-primary" disabled={!sending} onClick={(e) => sendTo(e.currentTarget)}><Send size={12} />Send to agent</button>
          </footer>
        )}
      </div>
    </div>
  );
}

const NO_COMMENTS: ReviewComment[] = [];

/** A line a comment is attached to. */
interface Spot { line: number; side: "old" | "new"; code: string }
interface Notes {
  comments: ReviewComment[];
  editing: Spot | null;
  edit(spot: Spot | null): void;
  save(text: string): void;
  remove(id: string): void;
  toggle(id: string): void;
}

const spotOf = (r: DiffRow): Spot | null => (r.kind === "del" ? (r.old ? { line: r.old, side: "old", code: r.text } : null) : r.new ? { line: r.new, side: "new", code: r.text } : null);
const same = (a: Spot | null, b: Spot | null) => !!a && !!b && a.line === b.line && a.side === b.side;

function CommentButton({ spot, notes }: { spot: Spot | null; notes: Notes }) {
  if (!spot) return null;
  return <button className="diff-comment-btn" aria-label={`Comment on line ${spot.line}`} title="Comment on this line" onClick={() => notes.edit(spot)}><Plus size={11} /></button>;
}

/** Comments on these lines, and the editor when one of them is being commented on. */
function Thread({ spots, notes }: { spots: (Spot | null)[]; notes: Notes }) {
  const list = notes.comments.filter((c) => spots.some((s) => s && s.line === c.line && s.side === c.side));
  const open = spots.some((s) => same(s, notes.editing));
  if (!list.length && !open) return null;
  return (
    <div className="diff-thread">
      {list.map((c) => <CommentCard key={c.id} c={c} notes={notes} />)}
      {open && <CommentEditor notes={notes} />}
    </div>
  );
}

function CommentCard({ c, notes }: { c: ReviewComment; notes: Notes }) {
  const [title, ...rest] = c.text.split("\n");
  return (
    <div className={"diff-comment" + (c.author ? " is-agent" : "") + (c.skip ? " is-skipped" : "")}>
      {c.author && (
        <label className="diff-comment-who" title={c.skip ? "Left out when sending" : "Sent with the others"}>
          <input type="checkbox" checked={!c.skip} onChange={() => notes.toggle(c.id)} aria-label={`Send ${TOOL_LABEL[c.author]}'s comment`} />
          <ToolLogo tool={c.author} size={13} />
        </label>
      )}
      <div className="diff-comment-text">
        {c.author ? <><p><strong>{title}</strong>{c.severity && <span className={"diff-severity is-" + c.severity}>{c.severity}</span>}</p>{rest.length > 0 && <p>{rest.join("\n")}</p>}</> : <p>{c.text}</p>}
      </div>
      <button className="icon-btn" aria-label="Delete comment" title="Delete comment" onClick={() => notes.remove(c.id)}><Trash2 size={12} /></button>
    </div>
  );
}

function CommentEditor({ notes }: { notes: Notes }) {
  const [text, setText] = useState("");
  return (
    <form className="diff-comment-editor" onSubmit={(e) => { e.preventDefault(); notes.save(text); }}>
      <textarea
        autoFocus
        rows={2}
        value={text}
        placeholder="What should change here? ⌘Enter to add"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); notes.save(text); }
          if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); notes.edit(null); }
        }}
      />
      <div>
        <button type="button" className="mini-btn" onClick={() => notes.edit(null)}>Cancel</button>
        <button className="mini-btn is-primary" disabled={!text.trim()}>Add comment</button>
      </div>
    </form>
  );
}

function Unified({ rows, notes }: { rows: DiffRow[]; notes: Notes }) {
  return (
    <div className="diff-table is-unified">
      {rows.map((r, i) => {
        if (r.kind === "hunk" || r.kind === "meta") return <div key={i} className={"diff-row is-" + r.kind}><span className="diff-hunk-text">{r.kind === "hunk" ? (r.text || "Changes") : r.text}</span></div>;
        const spot = spotOf(r);
        return (
          <Fragment key={i}>
            <div className={"diff-row is-" + r.kind}>
              <span className="diff-num">{r.old ?? ""}</span>
              <span className="diff-num">{r.new ?? ""}</span>
              <span className="diff-sign">{r.kind === "add" ? "+" : r.kind === "del" ? "−" : ""}<CommentButton spot={spot} notes={notes} /></span>
              <span className="diff-code">{r.text || " "}</span>
            </div>
            <Thread spots={[spot]} notes={notes} />
          </Fragment>
        );
      })}
    </div>
  );
}

function Split({ rows, notes }: { rows: DiffRow[]; notes: Notes }) {
  const pairs = useMemo(() => pairRows(rows), [rows]);
  const spotIn = (r: DiffRow | null, side: "old" | "new"): Spot | null => {
    const line = r && (side === "old" ? r.old : r.new);
    // Unchanged lines are commented on from the new side only.
    if (!r || !line || (side === "old" && r.kind !== "del")) return null;
    return { line, side, code: r.text };
  };
  const cell = (r: DiffRow | null, side: "old" | "new") => r
    ? <><span className="diff-num">{side === "old" ? r.old : r.new}<CommentButton spot={spotIn(r, side)} notes={notes} /></span><span className={"diff-code is-" + r.kind}>{r.text || " "}</span></>
    : <><span className="diff-num" /><span className="diff-code is-empty" /></>;
  return (
    <div className="diff-table is-split">
      {pairs.map((p, i) => p.kind
        ? <div key={i} className={"diff-row is-" + p.kind}><span className="diff-hunk-text">{p.kind === "hunk" ? (p.left?.text || "Changes") : p.left?.text}</span></div>
        : <Fragment key={i}><div className="diff-row is-pair">{cell(p.left, "old")}{cell(p.right, "new")}</div><Thread spots={[spotIn(p.left, "old"), spotIn(p.right, "new")]} notes={notes} /></Fragment>)}
    </div>
  );
}
