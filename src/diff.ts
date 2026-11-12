// Unified diff parsing, shared by the Review screen and cross-agent review.

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

