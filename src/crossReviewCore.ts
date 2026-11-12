// Cross-agent review, the parts with no side effects: the prompt, reading the
// reviewer's answer, and pinning each finding to a line that is really in the diff.

import { parseDiff, type DiffRow } from "./diff";

export type Severity = "high" | "medium" | "low";

export interface Finding {
  file: string;
  line: number;
  severity: Severity;
  title: string;
  body: string;
}

/** A finding placed in the diff: on a changed or context line, or on the file (line 0). */
export interface Anchored extends Finding {
  side: "old" | "new";
  code: string;
}

/** Diff text a reviewer is shown, at most this much; the rest is listed by name. */
export const DIFF_LIMIT = 120_000;
const MAX_FINDINGS = 40;

export function reviewPrompt(diffs: { path: string; diff: string }[], base: string) {
  let size = 0;
  const shown: string[] = [];
  const skipped: string[] = [];
  for (const d of diffs) {
    if (size + d.diff.length > DIFF_LIMIT) { skipped.push(d.path); continue; }
    size += d.diff.length;
    shown.push(`--- ${d.path}\n${d.diff.trimEnd()}`);
  }
  return [
    "You are reviewing another coding agent's uncommitted changes in this repository.",
    `They are compared with ${base}. Read any file you need for context, but do not change anything and do not run commands that write.`,
    "",
    "Look for real problems: bugs, missed cases, security issues, broken behaviour, and changes that don't do what they appear to intend. Skip style nits and anything a formatter would fix. Fewer, solid findings beat many weak ones; an empty list is a fine answer.",
    "",
    "Answer with only a JSON array in a ```json block, nothing after it:",
    '[{"file": "path/from/repo/root", "line": <line number in the new version of the file>, "severity": "high" | "medium" | "low", "title": "<one line>", "body": "<what is wrong and what to do>"}]',
    "",
    "The changes:",
    "",
    shown.join("\n\n"),
    ...(skipped.length ? ["", `Also changed, too large to show here (read them if needed): ${skipped.join(", ")}`] : []),
  ].join("\n");
}

function lastJsonArray(text: string): unknown {
  const fences = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
  for (const body of fences.reverse()) {
    try { const v = JSON.parse(body); if (Array.isArray(v)) return v; } catch { /* next */ }
  }
  // No fence: the outermost [...] that parses.
  const start = text.indexOf("[");
  for (let end = text.lastIndexOf("]"); start >= 0 && end > start; end = text.lastIndexOf("]", end - 1)) {
    try { const v = JSON.parse(text.slice(start, end + 1)); if (Array.isArray(v)) return v; } catch { /* shorter */ }
  }
  return null;
}

const SEVERITIES: Severity[] = ["high", "medium", "low"];

/** Reads findings from what the reviewer said; null when there's no list in it at all. */
export function parseFindings(text: string): Finding[] | null {
  const list = lastJsonArray(text);
  if (!list) return null;
  const out: Finding[] = [];
  for (const raw of list as Record<string, unknown>[]) {
    if (!raw || typeof raw !== "object") continue;
    const file = String(raw.file ?? raw.path ?? "").trim();
    const title = String(raw.title ?? "").trim();
    const body = String(raw.body ?? raw.message ?? raw.description ?? "").trim();
    if (!file || (!title && !body)) continue;
    const line = Math.max(0, Math.floor(Number(raw.line ?? raw.start_line ?? 0)) || 0);
    const sev = String(raw.severity ?? "").toLowerCase();
    out.push({ file, line, severity: (SEVERITIES as string[]).includes(sev) ? (sev as Severity) : "medium", title: title.slice(0, 200), body: body.slice(0, 4000) });
    if (out.length >= MAX_FINDINGS) break;
  }
  return out;
}

/** The repo-relative path a reviewer meant, or null when it isn't one of the changed files. */
export function matchPath(file: string, root: string, paths: string[]) {
  let f = file.replace(/^`|`$/g, "").replace(/:\d+(:\d+)?$/, "");
  if (f.startsWith(root + "/")) f = f.slice(root.length + 1);
  f = f.replace(/^(\.\/|[ab]\/)/, "");
  if (paths.includes(f)) return f;
  const tail = paths.filter((p) => p.endsWith("/" + f) || f.endsWith("/" + p));
  return tail.length === 1 ? tail[0] : null;
}

/** Places findings on diff lines. A line outside every hunk goes on the file; a file outside the diff is dropped. */
export function anchorFindings(findings: Finding[], root: string, diffs: Record<string, string>): Anchored[] {
  const rows = new Map<string, DiffRow[]>();
  const paths = Object.keys(diffs);
  const out: Anchored[] = [];
  for (const f of findings) {
    const path = matchPath(f.file, root, paths);
    if (!path) continue;
    if (!rows.has(path)) rows.set(path, parseDiff(diffs[path]));
    const hit = f.line > 0 ? rows.get(path)!.find((r) => r.new === f.line) : undefined;
    out.push({ ...f, file: path, line: hit ? f.line : 0, side: "new", code: hit?.text ?? "" });
  }
  return out;
}
