// Cross-agent review: reading recorded reviewer output and pinning findings to the diff.
import ts from "typescript";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const root = new URL("../", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "desk-xr-"));
const emit = (name, text) => { const f = join(dir, name); writeFileSync(f, ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText); return pathToFileURL(f).href; };
const src = (p) => readFileSync(join(root, "src", p), "utf8");
const diff = emit("diff.mjs", src("diff.ts"));
const core = await import(emit("core.mjs", src("crossReviewCore.ts").replace('from "./diff"', `from "${diff}"`)));

// finalText lives with the side effects; take just that function.
const xr = src("crossReview.ts");
const body = xr.slice(xr.indexOf("export function finalText"), xr.indexOf("async function changedDiffs"));
const { finalText } = await import(emit("final.mjs", body));

const lines = (name) => readFileSync(join(root, "tests/fixtures/review", name), "utf8").trim().split("\n");
const authDiff = "diff --git a/src/auth.ts b/src/auth.ts\n--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -1,3 +1,4 @@\n import { check } from './check';\n-export const ok = (t) => check(t);\n+export const ok = (t) => check(t);\n+export const same = (a, b) => a == b;\n export default ok;\n";
const diffs = { "src/auth.ts": authDiff };

try {
  const codex = finalText("codex", lines("codex.jsonl"));
  assert.equal(codex.error, "");
  const found = core.parseFindings(codex.text);
  assert.equal(found.length, 3);
  const placed = core.anchorFindings(found, "/repo", diffs);
  assert.deepEqual(placed.map((f) => [f.file, f.line, f.severity]), [["src/auth.ts", 3, "high"], ["src/auth.ts", 0, "low"]], "on a hunk line, on the file, dropped");
  assert.equal(placed[0].code, "export const same = (a, b) => a == b;");

  const claude = finalText("claude", lines("claude.jsonl"));
  const c = core.anchorFindings(core.parseFindings(claude.text), "/repo", diffs);
  assert.deepEqual(c.map((f) => [f.file, f.line, f.severity]), [["src/auth.ts", 2, "medium"]], "absolute path, unknown severity");

  assert.deepEqual(core.parseFindings("Looks good to me.\n```json\n[]\n```"), []);
  assert.equal(core.parseFindings("No list here."), null);
  assert.equal(finalText("claude", ['{"type":"result","is_error":true,"result":"Credit balance is too low"}']).error, "Credit balance is too low");
  assert.match(finalText("codex", ['{"type":"desk_exit","code":1,"stderr":"not logged in"}']).error, /not logged in/);

  assert.equal(core.matchPath("b/src/auth.ts:12", "/repo", ["src/auth.ts"]), "src/auth.ts");
  assert.equal(core.matchPath("auth.ts", "/repo", ["src/auth.ts", "lib/auth.ts"]), null, "ambiguous names are dropped");

  const prompt = core.reviewPrompt([{ path: "a.ts", diff: "x".repeat(10) }, { path: "big.ts", diff: "y".repeat(core.DIFF_LIMIT) }], "the last commit");
  assert.ok(prompt.includes("--- a.ts") && !prompt.includes("yyyy") && prompt.includes("too large to show here (read them if needed): big.ts"));
  console.log("PASS crossreview: codex and claude output, anchoring, file-level, dropped, lenient parse, prompt limit");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
