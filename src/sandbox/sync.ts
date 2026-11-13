// Code in and out of a sandbox with git bundles: no GitHub token in the sandbox,
// unpushed commits travel, and Desk commits nothing. Work comes back as a local
// branch (desk/<slug>) in a worktree, plus the sandbox's uncommitted changes.

import { ipc } from "../ipc";
import { sandboxExec } from "./transport";
import { q, type Sandbox } from "./types";

const PATCH_MARK = "---DESK-PATCH---";

async function local(args: string[], opts: { stdin?: string; timeoutSecs?: number } = {}) {
  const out = await ipc.sandboxRun(args, { timeoutSecs: 300, ...opts });
  if (out.code !== 0) throw new Error((out.stderr || out.stdout).trim().split("\n").slice(-6).join("\n") || `exit ${out.code}`);
  return out.stdout;
}

const git = (root: string, args: string[], opts?: { stdin?: string }) => local(["git", "-C", root, ...args], opts);

/** Folder name for the repository in the sandbox. */
export function repoName(root: string) {
  return (root.replace(/\/+$/, "").split("/").pop() || "repo").replace(/[^A-Za-z0-9._-]/g, "-");
}

export interface RemoteWork {
  /** Folder in the sandbox the agent works in (a worktree). */
  cwd: string;
  branch: string;
  base: string;
}

/**
 * Sends the repository to the sandbox (all of it the first time, then only what's new)
 * and makes a worktree there on a new branch, the way local worktrees are made.
 */
export async function syncIn(sandbox: Sandbox, root: string, slug: string, progress: (text: string) => void): Promise<RemoteWork> {
  progress("Sending the code to the sandbox…");
  const base = (await git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).trim() || "HEAD";
  // Every local branch and HEAD, so unpushed commits come along.
  const bundle = await local(["sh", "-c", 'git -C "$1" bundle create - HEAD --branches 2>/dev/null | base64', "desk", root], { timeoutSecs: 600 });
  const name = (await git(root, ["config", "user.name"]).catch(() => "")).trim();
  const email = (await git(root, ["config", "user.email"]).catch(() => "")).trim();
  const repo = `"$HOME"/work/${q(repoName(root))}`;
  const branch = `desk/${slug}`;
  const wt = `"$HOME"/work/${q(`${repoName(root)}-wt`)}/${q(slug)}`;
  const script = [
    "set -e",
    'mkdir -p "$HOME/work"',
    'b="$HOME/work/.desk-in.bundle"',
    'base64 -d > "$b"',
    `[ -d ${repo}/.git ] || git clone -q "$b" ${repo}`,
    `git -C ${repo} fetch -q "$b" HEAD`,
    `git -C ${repo} update-ref refs/desk/base FETCH_HEAD`,
    ...(name ? [`git -C ${repo} config user.name ${q(name)}`] : []),
    ...(email ? [`git -C ${repo} config user.email ${q(email)}`] : []),
    `if [ -d ${wt} ]; then :; else git -C ${repo} worktree add -q -B ${q(branch)} ${wt} refs/desk/base; fi`,
    'rm -f "$b"',
    `cd ${wt} && pwd`,
  ].join("\n");
  const out = await sandboxExec(sandbox, script, { stdin: bundle, timeoutSecs: 900 });
  const cwd = out.trim().split("\n").slice(-1)[0];
  return { cwd, branch, base };
}

export interface Pulled {
  path: string;
  branch: string;
  /** Uncommitted changes from the sandbox were applied on top. */
  changes: boolean;
}

/** What the last pull applied to each worktree, so pulling again can replace it. */
const LAST_PATCH = "desk-sandbox-patches";
function lastPatches(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(LAST_PATCH) ?? "{}") ?? {}; } catch { return {}; }
}
function savePatch(path: string, patch: string) {
  const all = lastPatches();
  all[path] = patch;
  try { localStorage.setItem(LAST_PATCH, JSON.stringify(all)); } catch { /* Then a second pull asks you to tidy up first. */ }
}

async function sha(text: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Brings the sandbox's branch home as desk/<slug> in a local worktree, with its
 * uncommitted changes applied on top. Refuses if that worktree has edits of its own.
 */
export async function pullOut(sandbox: Sandbox, root: string, work: RemoteWork, worktreePath: (branch: string) => Promise<string>): Promise<Pulled> {
  const script = [
    "set -e",
    `cd ${q(work.cwd)}`,
    // New files show up in the diff without being committed.
    "git add -A -N . >/dev/null 2>&1 || true",
    't=$(mktemp)',
    `git bundle create "$t" ${q(work.branch)} >/dev/null 2>&1`,
    'base64 < "$t"',
    'rm -f "$t"',
    `echo ${PATCH_MARK}`,
    "git diff --binary HEAD | base64",
  ].join("\n");
  const out = await sandboxExec(sandbox, script, { timeoutSecs: 900 });
  const at = out.indexOf(PATCH_MARK);
  if (at < 0) throw new Error("The sandbox didn't send its changes back.");
  const bundle = out.slice(0, at).replace(/\s+/g, "");
  const patch = out.slice(at + PATCH_MARK.length).replace(/\s+/g, "");
  const tmp = (await local(["mktemp", "-t", "desk-bundle"])).trim();
  try {
    await local(["sh", "-c", 'base64 --decode > "$1"', "desk", tmp], { stdin: bundle });
    await git(root, ["fetch", "-q", tmp, `+${work.branch}:refs/remotes/sandbox/${work.branch.replace(/^desk\//, "")}`]);
  } finally {
    await local(["rm", "-f", tmp]).catch(() => {});
  }
  const ref = `refs/remotes/sandbox/${work.branch.replace(/^desk\//, "")}`;
  const path = await worktreePath(work.branch);
  const exists = await local(["test", "-d", path]).then(() => true, () => false);
  if (!exists) {
    const hasBranch = await git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${work.branch}`]).then(() => true, () => false);
    await git(root, hasBranch ? ["worktree", "add", "-q", path, work.branch] : ["worktree", "add", "-q", "-b", work.branch, path, ref]);
  }
  // Anything in the worktree that the last pull didn't put there is yours: leave it alone.
  await git(path, ["add", "-A", "-N", "."]).catch(() => {});
  const mine = await git(path, ["diff", "--binary", "HEAD"]);
  if (mine.trim()) {
    const applied = lastPatches()[path];
    if (!applied || applied !== (await sha(mine))) {
      throw new Error(`${path} has changes of its own. Commit or discard them, then pull again.`);
    }
    await git(path, ["reset", "-q", "--hard"]);
    await git(path, ["clean", "-fdq"]);
  }
  await git(path, ["merge", "-q", "--ff-only", ref]).catch(() => {
    // Never throw away commits: yours on this branch, or a rewrite in the sandbox.
    throw new Error(`${work.branch} here and in the sandbox have gone different ways. Its version is at ${ref}; merge it yourself.`);
  });
  let changes = false;
  if (patch) {
    const diff = await local(["sh", "-c", "base64 --decode", "desk"], { stdin: patch });
    if (diff.trim()) {
      await local(["git", "-C", path, "apply", "--binary", "--whitespace=nowarn", "-"], { stdin: diff });
      await git(path, ["add", "-A", "-N", "."]).catch(() => {});
      savePatch(path, await sha(await git(path, ["diff", "--binary", "HEAD"])));
      changes = true;
    }
  }
  if (!changes) savePatch(path, "");
  return { path, branch: work.branch, changes };
}
