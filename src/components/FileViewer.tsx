import { useEffect, useMemo, useState } from "react";
import { ExternalLink, Maximize2, Minimize2 } from "lucide-react";
import { errorText, ipc } from "../ipc";
import { mimeType, onDiskChange, parseTable, previewKind } from "../preview";
import { editorText } from "../editors";

const TABLE_ROWS = 5000;

function sizeText(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function OpenDefaultButton({ path }: { path: string }) {
  return (
    <button className="mini-btn" title="Open in its default app" onClick={() => void ipc.openDefault(path)}>
      <ExternalLink size={12} /> Open in default app
    </button>
  );
}

/** Images, PDFs, audio and video, read as bytes into a blob URL. Reloads when the
 *  file changes on disk; the URL (and its memory) is released when the tab closes. */
export function FileViewer({ path, onInfo }: { path: string; onInfo: (info: string) => void }) {
  const kind = previewKind(path);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [rev, setRev] = useState(0);
  const [actual, setActual] = useState(false);
  const [size, setSize] = useState("");

  useEffect(() => onDiskChange((paths) => { if (paths.has(path)) setRev((r) => r + 1); }), [path]);

  useEffect(() => {
    let live = true;
    let made: string | null = null;
    ipc.readBytes(path).then((buf) => {
      if (!live) return;
      made = URL.createObjectURL(new Blob([buf], { type: mimeType(path) }));
      setUrl(made);
      setError("");
      setSize(sizeText(buf.byteLength));
      onInfo(sizeText(buf.byteLength));
    }).catch((e) => { if (live) setError(errorText(e)); });
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  }, [path, rev]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) return <div className="pane-message"><p>{error}</p><OpenDefaultButton path={path} /></div>;
  if (!url) return <div className="pane-message is-quiet">Opening…</div>;

  if (kind === "image") return (
    <div className={"viewer viewer-image" + (actual ? " is-actual" : "")}>
      <button className="icon-btn viewer-zoom" title={actual ? "Fit to window" : "Actual size"} aria-label={actual ? "Fit to window" : "Actual size"} onClick={() => setActual(!actual)}>
        {actual ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
      </button>
      <img src={url} alt={path.split("/").pop()} draggable={false} onClick={() => setActual(!actual)}
        onLoad={(e) => { const i = e.currentTarget; onInfo(`${i.naturalWidth} × ${i.naturalHeight} · ${size}`); }} />
    </div>
  );
  if (kind === "pdf") return <iframe className="viewer viewer-pdf" src={url} title={path.split("/").pop()} />;
  if (kind === "video") return <div className="viewer viewer-media"><video src={url} controls /></div>;
  if (kind === "audio") return <div className="viewer viewer-media"><audio src={url} controls /></div>;
  return null;
}

/** CSV/TSV as a table, read from the tab's editor so unsaved edits show too. */
export function TableView({ tabId, path, rev }: { tabId: string; path: string; rev: number }) {
  const text = useMemo(() => editorText(tabId) ?? "", [tabId, rev]); // eslint-disable-line react-hooks/exhaustive-deps
  const { rows, more } = useMemo(() => parseTable(text, path.toLowerCase().endsWith(".tsv"), TABLE_ROWS + 1), [text, path]);
  if (!rows.length) return <div className="pane-message is-quiet">This file is empty.</div>;
  const [head, ...body] = rows;
  const width = Math.max(...rows.slice(0, 200).map((r) => r.length));
  const cols = Array.from({ length: width }, (_, i) => head[i] ?? "");
  return (
    <div className="viewer viewer-table">
      <table>
        <thead><tr><th className="row-num" />{cols.map((c, i) => <th key={i} title={c}>{c}</th>)}</tr></thead>
        <tbody>
          {body.slice(0, TABLE_ROWS).map((r, i) => (
            <tr key={i}><td className="row-num">{i + 1}</td>{cols.map((_, j) => <td key={j} title={r[j]}>{r[j]}</td>)}</tr>
          ))}
        </tbody>
      </table>
      {more && <p className="tree-note">Showing the first {TABLE_ROWS.toLocaleString()} rows. Switch to Text to see the rest.</p>}
    </div>
  );
}
