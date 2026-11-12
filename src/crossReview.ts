// Cross-agent review: one agent reads another's uncommitted changes, read-only,
// and its findings land in the Review gutter as comments you can untick or send.

import { create } from "zustand";
import { UNTRUSTED_CLAUDE_ARGS, projectForPath, untrustedPath } from "./actions";
import { errorText, ipc } from "./ipc";
import { TOOL_LABEL, projectAccount, sessionEnv, useDesk } from "./store";
import { setAgentComments } from "./review";
import { anchorFindings, parseFindings, reviewPrompt } from "./crossReviewCore";
import { isStaged, isUnstaged } from "./components/Review";

export type Reviewer = "claude" | "codex";
export const REVIEWERS: Reviewer[] = ["claude", "codex"];

interface Running { tool: Reviewer; proc: number | null; startedAt: number; cancelled: boolean }

export const useCrossReview = create<{ running: Record<string, Running | undefined> }>(() => ({ running: {} }));

const setRunning = (root: string, run: Running | undefined) =>
  useCrossReview.setState((s) => ({ running: { ...s.running, [root]: run } }));

const CLAUDE_BLOCKED = ["Bash", "BashOutput", "KillShell", "Edit", "Write", "MultiEdit", "NotebookEdit", "WebFetch", "WebSearch", "Task", "SlashCommand"];

/** The reviewer's command: one shot, nothing it can change. */
export function reviewArgs(tool: Reviewer, prompt: string, untrusted: boolean) {
  if (tool === "claude") {
    // Only reading tools: anything that runs, writes or fetches is switched off outright,
    // not just left to print mode refusing to ask (the diff may be written to mislead it).
    return ["claude", "-p", "--output-format", "json", "--permission-mode", "default", "--disallowedTools", ...CLAUDE_BLOCKED, "--no-session-persistence", ...(untrusted ? UNTRUSTED_CLAUDE_ARGS : []), "--", prompt];
  }
  // Read-only sandbox, and never asks to step outside it.
  return ["codex", "exec", "--json", "--skip-git-repo-check", "-c", 'sandbox_mode="read-only"', "-c", 'approval_policy="never"', "--", prompt];
}

/** What the reviewer finally said, from its JSON output lines. */
export function finalText(tool: Reviewer, lines: string[]) {
  let text = "";
  let error = "";
  for (const line of lines) {
    let r: any;
    try { r = JSON.parse(line); } catch { continue; }
    if (tool === "claude" && r.type === "result") { if (r.is_error) error = String(r.result ?? r.subtype ?? "failed"); else text = String(r.result ?? ""); }
    if (tool === "codex" && r.type === "item.completed" && r.item?.type === "agent_message") text = String(r.item.text ?? "");
    if (tool === "codex" && (r.type === "turn.failed" || r.type === "error")) error = String(r.error?.message ?? r.message ?? "failed");
    if (r.type === "desk_exit" && r.code !== 0 && !text && !error) error = String(r.stderr ?? "").trim().split("\n").slice(-4).join("\n") || `exit ${r.code}`;
  }
  return { text, error };
}

async function changedDiffs(root: string) {
  const status = await ipc.gitStatus(root);
  const diffs: Record<string, string> = {};
  for (const c of status.changes) {
    // What's on disk is what the reviewer reads, so its line numbers win.
    const staged = !isUnstaged(c) && isStaged(c);
    const text = await ipc.gitDiff(root, c.path, staged).catch(() => "");
    if (text.trim()) diffs[c.path] = text;
  }
  return { diffs, branch: status.branch };
}

/** Runs `tool` over the changes in `root` and puts its findings in the gutter. */
export async function crossReview(root: string, tool: Reviewer) {
  const desk = useDesk.getState();
  if (useCrossReview.getState().running[root]) return;
  const project = projectForPath(root);
  const account = projectAccount(desk.accounts, project, tool);
  const { env, unset } = sessionEnv(desk.accounts, project, { [tool]: account });
  const label = TOOL_LABEL[tool];
  const run: Running = { tool, proc: null, startedAt: Date.now(), cancelled: false };
  setRunning(root, run);
  try {
    const { diffs, branch } = await changedDiffs(root);
    const paths = Object.keys(diffs);
    if (!paths.length) { desk.toast("No changes to review."); return; }
    const prompt = reviewPrompt(paths.map((path) => ({ path, diff: diffs[path] })), `the last commit${branch ? ` on ${branch}` : ""}`);
    const untrusted = untrustedPath(root) || !!project?.untrusted;
    const lines: string[] = [];
    await new Promise<void>((resolve, reject) => {
      ipc.chatSpawn({ cwd: root, args: reviewArgs(tool, prompt, untrusted), env, unset, stdin: false }, (line) => {
        lines.push(line);
        if (line.includes('"desk_exit"')) resolve();
      }).then((proc) => { run.proc = proc; if (run.cancelled) void ipc.chatKill(proc); }, reject);
    });
    if (run.cancelled) return;
    const { text, error } = finalText(tool, lines);
    if (!text) throw new Error(error || `${label} didn't answer.`);
    const findings = parseFindings(text);
    if (!findings) throw new Error(`${label} answered without a list of findings.`);
    const anchored = anchorFindings(findings, root, diffs);
    setAgentComments(root, tool, anchored.map((f) => ({
      path: f.file, line: f.line, side: f.side, code: f.code, severity: f.severity,
      text: f.title && f.body ? `${f.title}\n${f.body}` : f.title || f.body,
    })));
    desk.toast(anchored.length ? `${label} left ${anchored.length} comment${anchored.length === 1 ? "" : "s"}.` : `${label} found nothing to change.`);
  } catch (e) {
    if (!run.cancelled) desk.toast(`${label}'s review failed: ${errorText(e)}`, "error");
  } finally {
    setRunning(root, undefined);
  }
}

export function cancelReview(root: string) {
  const run = useCrossReview.getState().running[root];
  if (!run) return;
  run.cancelled = true;
  if (run.proc != null) void ipc.chatKill(run.proc).catch(() => {});
  setRunning(root, undefined);
}
