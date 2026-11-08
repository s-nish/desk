import { useEffect, useRef, useState } from "react";
import { ChevronDown, CircleCheck, CircleDot, CircleX, ExternalLink, GitMerge, GitPullRequest, GitPullRequestDraft, LoaderCircle, MessageSquare, RefreshCw, Search, Sparkles, Wrench } from "lucide-react";
import { projectAccount, useDesk } from "../store";
import { accountChoices } from "./Sidebar";
import { ToolLogo } from "./ToolLogo";
import { errorText, ipc } from "../ipc";
import { addWorktreeProject, rootProject } from "../actions";
import { handToAgent } from "../review";
import { ghConfig, checkSummary, createPr, currentPr, draftPr, failureLogs, issue, listIssues, listPrs, markReady, mergePr, repoInfo, type IssueRow, type PrRow, type PullRequest } from "../github";
import { openMenu } from "./Menu";
import { Shell } from "./Modals";
import { relativeTime } from "./Sessions";
import type { Project } from "../types";

const open = (url: string) => void ipc.openExternal(url);
const toast = (text: string, tone?: "error") => useDesk.getState().toast(text, tone);

/** Messages that mean "this isn't a GitHub repo", where the card simply stays away. */
const NOT_GITHUB = /none of the git remotes|not a git repository|no git remotes|could not determine/i;

/** Re-runs `load` every `ms` while Desk is in front, and when it comes back. */
function usePoll(load: () => void, ms: number, deps: unknown[]) {
  useEffect(() => {
    load();
    const timer = setInterval(() => { if (!document.hidden && document.hasFocus()) load(); }, ms);
    window.addEventListener("focus", load);
    return () => { clearInterval(timer); window.removeEventListener("focus", load); };
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
}

/** The project's GitHub account; changing it refetches everything. */
function useGitHubAccount(project: Project) {
  const accounts = useDesk((s) => s.accounts);
  const current = useDesk((s) => s.projects.find((p) => p.id === project.id)) ?? project;
  return projectAccount(accounts, current, "github");
}

/** Which GitHub account (gh folder) this project uses, with a menu to switch or add one. */
function AccountChip({ project }: { project: Project }) {
  const account = useGitHubAccount(project);
  const identity = useDesk((s) => s.identities[account.id]);
  const many = useDesk((s) => s.accounts.filter((a) => a.kind === "github").length);
  const who = identity?.email ?? (identity?.signedIn === false ? "Not signed in" : account.name);
  return (
    <button className="gh-account" title={`GitHub account for ${project.name}: ${account.name}${identity?.email ? ` (${identity.email})` : ""}\nUsed by gh, pull requests and issues here, and by agents running gh in this project.`} onClick={(e) => openMenu(e.currentTarget, many ? accountChoices(project, "github") : [{ label: "Add GitHub account…", onSelect: () => useDesk.getState().setModal({ kind: "addAccount", tool: "github" }) }])}>
      <ToolLogo tool="github" size={11} />
      <span>{who}</span>
      <ChevronDown size={11} />
    </button>
  );
}

// Pull request for the current branch, in the Git panel

export function PrCard({ project, root, branch }: { project: Project; root: string; branch: string }) {
  const [pr, setPr] = useState<PullRequest | null | undefined>(undefined);
  const [base, setBase] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [showChecks, setShowChecks] = useState(false);
  const live = useRef(true);

  const load = () => {
    void Promise.all([currentPr(root), base ? Promise.resolve(null) : repoInfo(root)])
      .then(([next, info]) => {
        if (!live.current) return;
        setPr(next);
        if (info) setBase(info.defaultBranch);
        setError("");
      })
      .catch((e) => live.current && setError(errorText(e)));
  };
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const account = useGitHubAccount(project);
  usePoll(load, 45_000, [root, branch, account.id]);

  if (error) return NOT_GITHUB.test(error) ? null : <div className="pr-note"><span>{error}</span><AccountChip project={project} /></div>;
  if (pr === undefined) return <div className="pr-card is-loading"><LoaderCircle size={13} className="is-spinning" />Checking GitHub…</div>;

  const act = async (label: string, run: () => Promise<unknown>) => {
    setBusy(label);
    try { await run(); load(); } catch (e) { toast(errorText(e), "error"); } finally { setBusy(""); }
  };

  if (!pr || pr.state !== "OPEN") {
    if (branch === base || !base) return null;
    return (
      <div className="pr-card">
        <div className="pr-line">
          <GitPullRequest size={13} />
          <span>{pr?.state === "MERGED" ? <>#{pr.number} was merged.</> : <>No pull request for <strong>{branch}</strong> yet.</>}</span>
        </div>
        {pr?.state !== "MERGED" && <div className="pr-actions">
          <button className="mini-btn is-primary" onClick={() => useDesk.getState().setModal({ kind: "createPr", root, projectId: project.id, branch, base })}><GitPullRequest size={12} />Create PR</button>
          <button className="mini-btn" title="The agent pushes the branch and writes the title and description" onClick={() => handToAgent(root, `Push this branch and open a pull request against ${base} with \`gh pr create\`. Write a clear title, and a description of what changed and why, based on the commits and the diff against ${base}.`)}><Sparkles size={12} />Ask agent</button>
        </div>}
      </div>
    );
  }

  const sum = checkSummary(pr.checks);
  const review = pr.reviewDecision === "APPROVED" ? "Approved" : pr.reviewDecision === "CHANGES_REQUESTED" ? "Changes requested" : pr.reviewDecision === "REVIEW_REQUIRED" ? "Review required" : null;
  const blockers = [
    sum.fail && `${sum.fail} check${sum.fail === 1 ? "" : "s"} failing`,
    sum.pending && `${sum.pending} still running`,
    pr.mergeable === "CONFLICTING" && "conflicts with " + pr.baseRefName,
    pr.reviewDecision === "CHANGES_REQUESTED" && "changes requested",
  ].filter(Boolean) as string[];
  const fixChecks = () => act("fix", async () => {
    const logs = await failureLogs(root, pr.checks);
    const failing = pr.checks.filter((c) => c.state === "fail").map((c) => `- ${c.name}${c.url ? ` (${c.url})` : ""}`).join("\n");
    handToAgent(root, `These checks are failing on PR #${pr.number}:\n${failing}\n\n${logs.length ? `Failure logs:\n\n${logs.join("\n\n")}\n\n` : `Read the failures with \`gh pr checks ${pr.number}\` and \`gh run view <id> --log-failed\`.\n\n`}Fix the cause, run the relevant tests locally, then commit and push.`);
  });
  const merge = (at: Element) => openMenu(at, (["squash", "merge", "rebase"] as const).map((method) => ({
    label: { squash: "Squash and merge", merge: "Create a merge commit", rebase: "Rebase and merge" }[method],
    onSelect: () => useDesk.getState().setModal({
      kind: "confirm",
      title: `Merge #${pr.number} into ${pr.baseRefName}?`,
      body: blockers.length ? `GitHub may refuse: ${blockers.join(", ")}.` : `“${pr.title}” is merged on GitHub with ${method === "squash" ? "one squashed commit" : method === "merge" ? "a merge commit" : "its commits rebased"}.`,
      confirm: "Merge",
      danger: blockers.length > 0,
      onConfirm: () => void act("merge", () => mergePr(root, pr.number, method)).then(() => toast(`Merged #${pr.number}.`)),
    }),
  })));

  return (
    <div className="pr-card">
      <button className="pr-title" title={`${pr.url}\nOpen on GitHub`} onClick={() => open(pr.url)}>
        {pr.isDraft ? <GitPullRequestDraft size={13} /> : <GitPullRequest size={13} />}
        <span><span className="pr-number">#{pr.number}</span> {pr.title}</span>
        <ExternalLink size={11} />
      </button>
      <div className="pr-facts">
        <span className={"pr-badge" + (pr.isDraft ? "" : " is-open")}>{pr.isDraft ? "Draft" : "Open"}</span>
        {review && <span className={"pr-badge" + (pr.reviewDecision === "APPROVED" ? " is-pass" : pr.reviewDecision === "CHANGES_REQUESTED" ? " is-fail" : "")}>{review}</span>}
        {pr.mergeable === "CONFLICTING" && <span className="pr-badge is-fail">Conflicts</span>}
        {pr.checks.length > 0 && (
          <button className={"pr-badge is-button" + (sum.fail ? " is-fail" : sum.pending ? "" : " is-pass")} aria-expanded={showChecks} onClick={() => setShowChecks(!showChecks)}>
            {sum.fail ? <CircleX size={11} /> : sum.pending ? <CircleDot size={11} /> : <CircleCheck size={11} />}
            {sum.fail ? `${sum.fail} failing` : sum.pending ? `${sum.pending} running` : `${sum.pass} passed`}
          </button>
        )}
        {pr.comments > 0 && <span className="pr-badge"><MessageSquare size={11} />{pr.comments}</span>}
      </div>
      {showChecks && <ul className="pr-checks">
        {pr.checks.map((c, i) => (
          <li key={i} className={"is-" + c.state}>
            {c.state === "pass" ? <CircleCheck size={12} /> : c.state === "fail" ? <CircleX size={12} /> : <CircleDot size={12} />}
            <span>{c.name}</span>
            {c.url && <button className="icon-btn" aria-label={`Open ${c.name}`} onClick={() => open(c.url!)}><ExternalLink size={11} /></button>}
          </li>
        ))}
      </ul>}
      <div className="pr-actions">
        {sum.fail > 0 && <button className="mini-btn" disabled={!!busy} onClick={() => void fixChecks()}>{busy === "fix" ? <LoaderCircle size={12} className="is-spinning" /> : <Wrench size={12} />}Fix checks</button>}
        {(pr.comments > 0 || pr.reviewDecision === "CHANGES_REQUESTED") && <button className="mini-btn" onClick={() => handToAgent(root, `Address the review feedback on PR #${pr.number}. Read it with \`gh pr view ${pr.number} --comments\` and the line comments with \`gh api repos/{owner}/{repo}/pulls/${pr.number}/comments\`. Make the changes, then commit and push. Tell me about any comment you disagree with instead of changing it.`)}><MessageSquare size={12} />Address review</button>}
        {pr.isDraft
          ? <button className="mini-btn" disabled={!!busy} onClick={() => void act("ready", () => markReady(root, pr.number))}>Ready for review</button>
          : <button className="mini-btn is-primary" disabled={!!busy} onClick={(e) => merge(e.currentTarget)}>{busy === "merge" ? <LoaderCircle size={12} className="is-spinning" /> : <GitMerge size={12} />}Merge</button>}
        <button className="icon-btn" aria-label="Refresh pull request" title="Refresh" onClick={load}><RefreshCw size={12} /></button>
      </div>
    </div>
  );
}

export function CreatePrDialog({ root, branch, base }: { root: string; branch: string; base: string }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [target, setTarget] = useState(base);
  const [draft, setDraft] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    void draftPr(root, base, branch).then((d) => { setTitle((t) => t || d.title); setBody((b) => b || d.body); });
  }, [root, base, branch]);
  const submit = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const url = await createPr(root, { title: title.trim(), body, base: target.trim() || base, draft });
      useDesk.getState().setModal(null);
      useDesk.getState().toast("Opened the pull request.", "info", url ? { label: "View", run: () => open(url) } : undefined);
      window.dispatchEvent(new Event("focus"));
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };
  return (
    <Shell title="Create pull request">
      <form className="modal-body pr-form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <p className="modal-text">Desk pushes <code>{branch}</code> to origin, then opens the pull request with gh.</p>
        <label className="field"><span>Title</span><input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} /></label>
        <label className="field"><span>Description</span><textarea rows={8} value={body} onChange={(e) => setBody(e.target.value)} placeholder="What changed and why" /></label>
        <div className="pr-form-row">
          <label className="field"><span>Into</span><input value={target} spellCheck={false} onChange={(e) => setTarget(e.target.value)} /></label>
          <label className="check-row"><input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} />Open as draft</label>
        </div>
        {error && <p className="form-error">{error}</p>}
        <footer className="modal-foot">
          <button type="button" className="btn" onClick={() => useDesk.getState().setModal(null)}>Cancel</button>
          <button className="btn is-primary" disabled={!title.trim() || busy}><GitPullRequest size={14} />{busy ? "Pushing…" : "Create pull request"}</button>
        </footer>
      </form>
    </Shell>
  );
}

// GitHub panel: open issues and pull requests, each a click away from an agent working on it

export function GitHubPanel({ project }: { project: Project }) {
  const repo = rootProject(project);
  const [kind, setKind] = useState<"issues" | "prs">(() => (localStorage.getItem("desk-gh-kind") === "prs" ? "prs" : "issues"));
  const [query, setQuery] = useState("");
  const [issues, setIssues] = useState<IssueRow[] | null>(null);
  const [prs, setPrs] = useState<PrRow[] | null>(null);
  const [info, setInfo] = useState<{ name: string; url: string } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);

  const load = (q = query) => {
    setLoading(true);
    const list = kind === "issues" ? listIssues(repo.path, q).then(setIssues) : listPrs(repo.path, q).then(setPrs);
    void Promise.all([list, info ? null : repoInfo(repo.path).then(setInfo)])
      .then(() => setError(""))
      .catch((e) => setError(errorText(e)))
      .finally(() => setLoading(false));
  };
  const account = useGitHubAccount(project);
  usePoll(() => { setInfo(null); load(); }, 120_000, [repo.path, kind, account.id]);
  useEffect(() => {
    const timer = setTimeout(() => load(query), 300);
    return () => clearTimeout(timer);
  }, [query]); // eslint-disable-line react-hooks/exhaustive-deps
  const pick = (k: "issues" | "prs") => {
    setKind(k);
    try { localStorage.setItem("desk-gh-kind", k); } catch { /* per-viewer convenience only */ }
  };

  const startIssue = async (row: IssueRow) => {
    setBusy(row.number);
    try {
      const full = await issue(repo.path, row.number);
      handToAgent(repo.path, `Work on GitHub issue #${row.number}: ${full.title}\n${full.url}\n\n${full.body.trim() || "(No description.)"}\n\nRead the discussion with \`gh issue view ${row.number} --comments\` if you need more context. When it's done, commit, and say what you changed.`, { worktree: true, branch: `issue-${row.number}-${row.title.split(/\s+/).slice(0, 4).join(" ")}` });
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(null);
    }
  };
  const checkout = async (row: PrRow, review: boolean) => {
    setBusy(row.number);
    try {
      const made = await ipc.ghPrWorktree(repo.path, row.number, ghConfig(repo.path));
      const known = useDesk.getState().projects.find((p) => p.path === made.path);
      const id = known?.id ?? addWorktreeProject(repo, made.path, made.branch);
      useDesk.getState().selectProject(id);
      if (review) handToAgent(made.path, `Review pull request #${row.number}: ${row.title}. Read the description with \`gh pr view ${row.number}\` and the diff with \`gh pr diff ${row.number}\`. Point out bugs, risky changes and missing tests, with file and line for each. Don't change any files.`);
      else toast(`Checked out #${row.number} in its own worktree.`);
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(null);
    }
  };

  const rows = kind === "issues" ? issues : prs;
  return (
    <div className="tool-panel github-panel">
      <header className="side-header">
        <h2>{info ? <button className="text-button" title="Open on GitHub" onClick={() => open(info.url)}>{info.name}</button> : "GitHub"}</h2>
        <AccountChip project={project} />
        <button className="icon-btn" aria-label="Refresh" disabled={loading} onClick={() => load()}><RefreshCw size={13} className={loading ? "is-spinning" : ""} /></button>
      </header>
      <div className="github-controls">
        <div className="segmented is-small" role="radiogroup" aria-label="Show">
          <button role="radio" aria-checked={kind === "issues"} className={kind === "issues" ? "is-on" : ""} onClick={() => pick("issues")}>Issues</button>
          <button role="radio" aria-checked={kind === "prs"} className={kind === "prs" ? "is-on" : ""} onClick={() => pick("prs")}>Pull requests</button>
        </div>
        <label className="github-search"><Search size={12} /><input value={query} placeholder={kind === "issues" ? "Search open issues" : "Search open pull requests"} onChange={(e) => setQuery(e.target.value)} /></label>
      </div>
      {error && <p className={NOT_GITHUB.test(error) ? "tree-note" : "tool-error"}>{NOT_GITHUB.test(error) ? `${repo.name} isn't on GitHub, or gh can't see it.` : error}</p>}
      {!error && !rows && <p className="tree-note">Loading…</p>}
      <div className="tool-results github-list">
        {rows?.length === 0 && <div className="panel-empty"><CircleCheck size={18} /><strong>Nothing open</strong><span>{query ? "No matches." : kind === "issues" ? "No open issues." : "No open pull requests."}</span></div>}
        {kind === "issues" && issues?.map((r) => (
          <div key={r.number} className="github-row">
            <button className="github-row-main" title={`#${r.number} ${r.title}\nOpen on GitHub`} onClick={() => info && open(`${info.url}/issues/${r.number}`)}>
              <CircleDot size={13} className="github-open" />
              <span className="github-row-text">
                <span className="github-row-title">{r.title}</span>
                <small>#{r.number} · {r.author} · {relativeTime(Date.parse(r.updatedAt))}{r.comments ? ` · ${r.comments} comments` : ""}</small>
                {r.labels.length > 0 && <span className="github-labels">{r.labels.slice(0, 3).map((l) => <span key={l}>{l}</span>)}</span>}
              </span>
            </button>
            <button className="mini-btn" disabled={busy !== null} title="Start a chat in a new worktree with this issue as the task" onClick={() => void startIssue(r)}>{busy === r.number ? <LoaderCircle size={12} className="is-spinning" /> : <Sparkles size={12} />}Start</button>
          </div>
        ))}
        {kind === "prs" && prs?.map((r) => (
          <div key={r.number} className="github-row">
            <button className="github-row-main" title={`#${r.number} ${r.title}\n${r.headRefName}\nOpen on GitHub`} onClick={() => info && open(`${info.url}/pull/${r.number}`)}>
              {r.isDraft ? <GitPullRequestDraft size={13} /> : <GitPullRequest size={13} className="github-open" />}
              <span className="github-row-text">
                <span className="github-row-title">{r.title}</span>
                <small>#{r.number} · {r.author} · {relativeTime(Date.parse(r.updatedAt))}{r.reviewDecision === "APPROVED" ? " · approved" : r.reviewDecision === "CHANGES_REQUESTED" ? " · changes requested" : ""}</small>
              </span>
            </button>
            <button className="mini-btn" disabled={busy !== null} title="Check out in its own worktree" onClick={(e) => openMenu(e.currentTarget, [
              { label: "Check out in a worktree", onSelect: () => void checkout(r, false) },
              { label: "Review with an agent", hint: "Checks out, then asks for a review", onSelect: () => void checkout(r, true) },
            ])}>{busy === r.number ? <LoaderCircle size={12} className="is-spinning" /> : <GitMerge size={12} />}Open</button>
          </div>
        ))}
      </div>
    </div>
  );
}
