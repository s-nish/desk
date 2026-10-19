import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { useDesk } from "../store";
import { openFile } from "../actions";
import { ipc } from "../ipc";

/** Subsequence match; rewards consecutive runs and hits at word or path boundaries. */
export function fuzzyScore(query: string, text: string): number | null {
  if (!query) return 0;
  const q = query.toLowerCase();
  const s = text.toLowerCase();
  let score = 0;
  let qi = 0;
  let run = 0;
  for (let i = 0; i < s.length && qi < q.length; i++) {
    if (s[i] !== q[qi]) {
      run = 0;
      continue;
    }
    const boundary = i === 0 || "/._- ".includes(s[i - 1]);
    run++;
    score += 1 + run * 2 + (boundary ? 6 : 0);
    qi++;
  }
  if (qi < q.length) return null;
  const base = s.slice(s.lastIndexOf("/") + 1);
  if (base.includes(q)) score += 25;
  return score - s.length * 0.05;
}

export function QuickOpen() {
  const open = useDesk((s) => s.quickOpen);
  const project = useDesk((s) => s.projects.find((p) => p.id === s.activeProjectId));
  const [files, setFiles] = useState<string[] | null>(null);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || !project) return;
    setQuery("");
    setIndex(0);
    setFiles(null);
    let live = true;
    void ipc.listFiles(project.path).then((f) => live && setFiles(f));
    return () => {
      live = false;
    };
  }, [open, project]);

  const results = useMemo(() => {
    if (!files) return [];
    if (!query) return files.slice(0, 60);
    const scored: [number, string][] = [];
    for (const f of files) {
      const sc = fuzzyScore(query, f);
      if (sc !== null) scored.push([sc, f]);
    }
    return scored
      .sort((a, b) => b[0] - a[0])
      .slice(0, 60)
      .map(([, f]) => f);
  }, [files, query]);

  useEffect(() => {
    list.current?.querySelector(".qo-item.is-active")?.scrollIntoView({ block: "nearest" });
  }, [index]);

  if (!open || !project) return null;
  const close = () => useDesk.getState().setQuickOpen(false);
  const choose = (rel: string) => {
    close();
    void openFile(project.id, `${project.path}/${rel}`);
  };

  return (
    <div className="modal-backdrop is-top" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="quickopen" role="dialog" aria-label="Open file">
        <div className="qo-input">
          <Search size={15} />
          <input
            autoFocus
            placeholder={`Open a file in ${project.name}`}
            value={query}
            onChange={(e) => (setQuery(e.target.value), setIndex(0))}
            onKeyDown={(e) => {
              if (e.key === "Escape") close();
              else if (e.key === "ArrowDown") (e.preventDefault(), setIndex((i) => Math.min(i + 1, results.length - 1)));
              else if (e.key === "ArrowUp") (e.preventDefault(), setIndex((i) => Math.max(i - 1, 0)));
              else if (e.key === "Enter" && results[index]) choose(results[index]);
            }}
          />
        </div>
        <div className="qo-list" ref={list}>
          {files === null && <p className="qo-note">Reading files…</p>}
          {files && results.length === 0 && <p className="qo-note">No files match “{query}”.</p>}
          {results.map((f, i) => {
            const slash = f.lastIndexOf("/");
            return (
              <button key={f} className={"qo-item" + (i === index ? " is-active" : "")} onMouseMove={() => setIndex(i)} onClick={() => choose(f)}>
                <span className="qo-name">{f.slice(slash + 1)}</span>
                <span className="qo-dir">{slash > 0 ? f.slice(0, slash) : ""}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
