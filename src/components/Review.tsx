import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp, FileText, Minus, Plus, Undo2 } from "lucide-react";
import { useDesk } from "../store";
import { errorText, ipc } from "../ipc";
import { openFile, projectForPath } from "../actions";
import type { GitChange, GitStatus } from "../types";

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

// Unified diff parsing

export interface DiffRow {
  kind: "hunk" | "ctx" | "add" | "del" | "meta";
  old: number | null;
  new: number | null;
  text: string;
}

/** Turns `git diff` output into rows with old and new line numbers. */
export function parseDiff(text: string): DiffRow[] {
  const rows: DiffRow[] = [];
  const lines = text.replace(/\n$/, "").split("\n");
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  // A new untracked file comes back as bare "+" lines without a hunk header.
  if (!text.includes("\n@@") && !text.startsWith("@@") && lines.every((l) => l.startsWith("+") || l === "")) {
    lines.forEach((l, i) => rows.push({ kind: "add", old: null, new: i + 1, text: l.slice(1) }));
    return rows;
  }
  for (const line of lines) {
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      rows.push({ kind: "hunk", old: null, new: null, text: hunk[3] ?? "" });
      continue;
    }
    if (!inHunk) {
      if (/^(new file|deleted file|old mode|new mode|similarity|rename from|rename to|Binary files)/.test(line)) rows.push({ kind: "meta", old: null, new: null, text: line });
      continue;
    }
    if (line.startsWith("+")) rows.push({ kind: "add", old: null, new: newLine++, text: line.slice(1) });
    else if (line.startsWith("-")) rows.push({ kind: "del", old: oldLine++, new: null, text: line.slice(1) });
    else if (line.startsWith("\\")) rows.push({ kind: "meta", old: null, new: null, text: line.slice(2) });
    else if (line.startsWith("diff --git")) inHunk = false;
    else rows.push({ kind: "ctx", old: oldLine++, new: newLine++, text: line.slice(1) });
  }
  return rows;
}

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
            <button className="mini-btn" disabled={code === "D"} onClick={open}><FileText size={12} />Open</button>
            {current && !current.staged && <button className="mini-btn" disabled={busy} onClick={discard}><Undo2 size={12} />Discard</button>}
            {current && <button className="mini-btn is-primary" disabled={busy} onClick={() => void stage()}>{current.staged ? <><Minus size={12} />Unstage</> : <><Plus size={12} />Stage</>}</button>}
          </div>
        </header>
        <div className="review-body" ref={body}>
          {error ? <p className="tool-error">{error}</p> : diff === null ? <p className="tree-note">Loading the diff…</p> : !rows.length ? <p className="tree-note">No text changes to show. The file may be binary, or only its permissions changed.</p> : mode === "unified" ? <Unified rows={rows} /> : <Split rows={rows} />}
        </div>
      </div>
    </div>
  );
}

function Unified({ rows }: { rows: DiffRow[] }) {
  return (
    <div className="diff-table is-unified">
      {rows.map((r, i) => r.kind === "hunk" || r.kind === "meta"
        ? <div key={i} className={"diff-row is-" + r.kind}><span className="diff-hunk-text">{r.kind === "hunk" ? (r.text || "Changes") : r.text}</span></div>
        : (
          <div key={i} className={"diff-row is-" + r.kind}>
            <span className="diff-num">{r.old ?? ""}</span>
            <span className="diff-num">{r.new ?? ""}</span>
            <span className="diff-sign">{r.kind === "add" ? "+" : r.kind === "del" ? "−" : ""}</span>
            <span className="diff-code">{r.text || " "}</span>
          </div>
        ))}
    </div>
  );
}

function Split({ rows }: { rows: DiffRow[] }) {
  const pairs = useMemo(() => pairRows(rows), [rows]);
  const cell = (r: DiffRow | null, side: "old" | "new") => r
    ? <><span className="diff-num">{side === "old" ? r.old : r.new}</span><span className={"diff-code is-" + r.kind}>{r.text || " "}</span></>
    : <><span className="diff-num" /><span className="diff-code is-empty" /></>;
  return (
    <div className="diff-table is-split">
      {pairs.map((p, i) => p.kind
        ? <div key={i} className={"diff-row is-" + p.kind}><span className="diff-hunk-text">{p.kind === "hunk" ? (p.left?.text || "Changes") : p.left?.text}</span></div>
        : <div key={i} className="diff-row is-pair">{cell(p.left, "old")}{cell(p.right, "new")}</div>)}
    </div>
  );
}
