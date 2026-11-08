// GitHub through the gh CLI: pull requests, checks, issues. Desk keeps no tokens.
import { ipc } from "./ipc";
import { projectForPath } from "./actions";
import { projectAccount, useDesk } from "./store";

/** The GitHub account (gh config folder) of the project that holds `cwd`; null is gh's default. */
export function ghConfig(cwd: string) {
  return projectAccount(useDesk.getState().accounts, projectForPath(cwd), "github").dir;
}

const ghRaw = (cwd: string, args: string[]) => ipc.ghRun(cwd, args, ghConfig(cwd));

export interface Check { name: string; state: "pass" | "fail" | "pending" | "skip"; url: string | null; runId: string | null }
export interface PullRequest {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | "" | null;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  baseRefName: string;
  headRefName: string;
  checks: Check[];
  comments: number;
}
export interface IssueRow { number: number; title: string; author: string; updatedAt: string; labels: string[]; comments: number }
export interface PrRow { number: number; title: string; author: string; updatedAt: string; headRefName: string; isDraft: boolean; reviewDecision: string | null }

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

async function gh<T = Json>(cwd: string, args: string[]): Promise<T> {
  return JSON.parse(await ghRaw(cwd, args)) as T;
}

/** One state for GitHub's check runs and commit statuses. */
function checkOf(c: Json): Check {
  if (c.__typename === "StatusContext") {
    const s = String(c.state ?? "").toUpperCase();
    return { name: c.context ?? "Status", state: s === "SUCCESS" ? "pass" : s === "PENDING" || s === "EXPECTED" ? "pending" : "fail", url: c.targetUrl ?? null, runId: null };
  }
  const conclusion = String(c.conclusion ?? "").toUpperCase();
  const done = String(c.status ?? "").toUpperCase() === "COMPLETED";
  const state = !done ? "pending" : ["SUCCESS", "NEUTRAL"].includes(conclusion) ? "pass" : conclusion === "SKIPPED" ? "skip" : "fail";
  const url: string | null = c.detailsUrl ?? null;
  return { name: c.name ?? c.workflowName ?? "Check", state, url, runId: /\/actions\/runs\/(\d+)/.exec(url ?? "")?.[1] ?? null };
}

const PR_FIELDS = "number,title,url,state,isDraft,reviewDecision,mergeable,baseRefName,headRefName,statusCheckRollup,comments,reviews";

/** The pull request for the branch checked out in `cwd`, or null when there isn't one. */
export async function currentPr(cwd: string): Promise<PullRequest | null> {
  try {
    const pr = await gh(cwd, ["pr", "view", "--json", PR_FIELDS]);
    return {
      ...pr,
      reviewDecision: pr.reviewDecision ?? null,
      checks: (pr.statusCheckRollup ?? []).map(checkOf),
      comments: (pr.comments?.length ?? 0) + (pr.reviews ?? []).filter((r: Json) => r.body?.trim()).length,
    };
  } catch (e) {
    if (/no (open )?pull requests? found/i.test(String(e))) return null;
    throw e;
  }
}

/** Whether `cwd` is a GitHub repository gh can see. */
export async function repoInfo(cwd: string): Promise<{ name: string; url: string; defaultBranch: string }> {
  const r = await gh(cwd, ["repo", "view", "--json", "nameWithOwner,url,defaultBranchRef"]);
  return { name: r.nameWithOwner, url: r.url, defaultBranch: r.defaultBranchRef?.name ?? "main" };
}

/** Pushes the branch, then opens a pull request. Returns its URL. */
export async function createPr(root: string, pr: { title: string; body: string; base: string; draft: boolean }) {
  await ipc.gitPush(root, ghConfig(root));
  const out = await ghRaw(root, ["pr", "create", "--title", pr.title, "--body", pr.body, "--base", pr.base, ...(pr.draft ? ["--draft"] : [])]);
  return out.trim().split("\n").pop() ?? "";
}

export async function mergePr(root: string, number: number, method: "squash" | "merge" | "rebase") {
  await ghRaw(root, ["pr", "merge", String(number), `--${method}`]);
}

export async function markReady(root: string, number: number) {
  await ghRaw(root, ["pr", "ready", String(number)]);
}

/** The end of each failing GitHub Actions run's log, for an agent to fix. */
export async function failureLogs(root: string, checks: Check[]) {
  const runs = [...new Set(checks.filter((c) => c.state === "fail" && c.runId).map((c) => c.runId!))].slice(0, 3);
  const logs = await Promise.all(runs.map(async (id) => {
    try {
      const log = await ghRaw(root, ["run", "view", id, "--log-failed"]);
      const lines = log.trimEnd().split("\n");
      return `Run ${id} (last ${Math.min(lines.length, 120)} lines):\n${lines.slice(-120).join("\n")}`;
    } catch {
      return "";
    }
  }));
  return logs.filter(Boolean);
}

/** A first draft of a PR's title and description from the branch's commits. */
export async function draftPr(root: string, base: string, branch: string) {
  const commits = await ipc.gitCommitsSince(root, base).catch(() => [] as string[]);
  const subjects = commits.map((c) => c.split("\n")[0]);
  const title = subjects.length === 1 ? subjects[0] : branch.replace(/^desk\//, "").replace(/[-_]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
  const body = commits.length === 1 ? commits[0].split("\n").slice(1).join("\n").trim() : subjects.map((s) => `- ${s}`).join("\n");
  return { title, body, commits: commits.length };
}

export async function listIssues(cwd: string, search = ""): Promise<IssueRow[]> {
  const rows = await gh<Json[]>(cwd, ["issue", "list", "--state", "open", "--limit", "60", ...(search ? ["--search", search] : []), "--json", "number,title,author,updatedAt,labels,comments"]);
  return rows.map((r) => ({ number: r.number, title: r.title, author: r.author?.login ?? "", updatedAt: r.updatedAt, labels: (r.labels ?? []).map((l: Json) => l.name), comments: r.comments?.length ?? 0 }));
}

export async function listPrs(cwd: string, search = ""): Promise<PrRow[]> {
  const rows = await gh<Json[]>(cwd, ["pr", "list", "--state", "open", "--limit", "60", ...(search ? ["--search", search] : []), "--json", "number,title,author,updatedAt,headRefName,isDraft,reviewDecision"]);
  return rows.map((r) => ({ number: r.number, title: r.title, author: r.author?.login ?? "", updatedAt: r.updatedAt, headRefName: r.headRefName, isDraft: r.isDraft, reviewDecision: r.reviewDecision ?? null }));
}

export async function issue(cwd: string, number: number): Promise<{ title: string; body: string; url: string }> {
  return gh(cwd, ["issue", "view", String(number), "--json", "title,body,url"]);
}

export const checkSummary = (checks: Check[]) => ({
  fail: checks.filter((c) => c.state === "fail").length,
  pending: checks.filter((c) => c.state === "pending").length,
  pass: checks.filter((c) => c.state === "pass").length,
});
