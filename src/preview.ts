/** File types Desk shows in a viewer instead of the text editor. */
export type PreviewKind = "image" | "pdf" | "video" | "audio" | "table";

const TYPES: Record<string, [PreviewKind, string]> = {
  png: ["image", "image/png"], jpg: ["image", "image/jpeg"], jpeg: ["image", "image/jpeg"], gif: ["image", "image/gif"],
  webp: ["image", "image/webp"], avif: ["image", "image/avif"], bmp: ["image", "image/bmp"], ico: ["image", "image/x-icon"],
  icns: ["image", "image/x-icns"], heic: ["image", "image/heic"], heif: ["image", "image/heif"], tif: ["image", "image/tiff"],
  tiff: ["image", "image/tiff"], svg: ["image", "image/svg+xml"],
  pdf: ["pdf", "application/pdf"],
  mp4: ["video", "video/mp4"], m4v: ["video", "video/mp4"], mov: ["video", "video/quicktime"], webm: ["video", "video/webm"],
  mp3: ["audio", "audio/mpeg"], m4a: ["audio", "audio/mp4"], wav: ["audio", "audio/wav"], aac: ["audio", "audio/aac"],
  flac: ["audio", "audio/flac"], ogg: ["audio", "audio/ogg"],
  csv: ["table", "text/csv"], tsv: ["table", "text/tab-separated-values"],
};

const ext = (path: string) => path.slice(path.lastIndexOf(".") + 1).toLowerCase();

export function previewKind(path: string): PreviewKind | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name.includes(".") ? TYPES[ext(path)]?.[0] ?? null : null;
}

/** Viewers that read raw bytes; tables are text and keep a normal (editable) editor. */
export const isBinaryPreview = (path: string) => { const k = previewKind(path); return !!k && k !== "table"; };

export const mimeType = (path: string) => TYPES[ext(path)]?.[1] ?? "application/octet-stream";

/** CSV/TSV parsing (quoted fields, escaped quotes, newlines in quotes). Stops after `limit` rows. */
export function parseTable(text: string, tab: boolean, limit: number): { rows: string[][]; more: boolean } {
  const sep = tab ? "\t" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === sep) { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      rows.push(row); row = [];
      if (rows.length > limit) return { rows: rows.slice(0, limit), more: true };
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return { rows, more: false };
}

// Viewers reload when the file changes on disk (an agent regenerating a chart, say).
const listeners = new Set<(paths: Set<string>) => void>();
export function onDiskChange(fn: (paths: Set<string>) => void) { listeners.add(fn); return () => { listeners.delete(fn); }; }
export function notifyDiskChange(paths: string[]) { const set = new Set(paths); listeners.forEach((fn) => fn(set)); }
