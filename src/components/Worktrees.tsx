import { toSlash } from "../platform";
import { useEffect, useState } from "react";
import { FolderGit2, GitBranchPlus, Plus } from "lucide-react";
import { TOOL_LABEL, useDesk } from "../store";
import { addWorktreeProject, branchSlug, createWorktree, rootProject, untrackedWorktrees } from "../actions";
import { errorText, ipc } from "../ipc";
import { homeDir } from "@tauri-apps/api/path";
import { Shell } from "./Modals";
import type { TabTool, Worktree } from "../types";

let home = "";
void homeDir().then((h) => (home = toSlash(h))).catch(() => {});
const tilde = (p: string) => (home && p.startsWith(home + "/") ? "~" + p.slice(home.length) : p);

const OPEN_WITH: (TabTool | null)[] = ["claude", "codex", "shell", null];

export function WorktreeDialog({ projectId }: { projectId: string }) {
  const project = useDesk((s) => s.projects.find((p) => p.id === projectId));
  const parent = project ? rootProject(project) : undefined;
  const current = useDesk((s) => (parent ? s.branches[parent.id] : null));
  const [branch, setBranch] = useState("");
  const [base, setBase] = useState("");
  const [branches, setBranches] = useState<string[]>([]);
  const [tool, setTool] = useState<TabTool | null>("claude");
  const [path, setPath] = useState("");
  const [existing, setExisting] = useState<Worktree[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const name = branchSlug(branch);

  useEffect(() => {
    if (!parent) return;
    void ipc.gitBranches(parent.path).then((list) => {
      setBranches(list);
      setBase((b) => b || (current && list.includes(current) ? current : list[0] ?? ""));
    }).catch((e) => setError(errorText(e)));
    void untrackedWorktrees(parent).then(setExisting).catch(() => {});
  }, [parent?.path]);

  useEffect(() => {
    if (!parent || !name) { setPath(""); return; }
    const timer = setTimeout(() => void ipc.gitWorktreePath(parent.path, name).then(setPath).catch(() => setPath("")), 120);
    return () => clearTimeout(timer);
  }, [parent?.path, name]);

  if (!project || !parent) return null;
  const taken = branches.includes(name);
  const submit = async () => {
    if (!name || busy) return;
    setBusy(true);
    setError("");
    try {
      await createWorktree(parent.id, name, base, tool);
      useDesk.getState().setModal(null);
      useDesk.getState().toast(`Created ${name}. It's listed under ${parent.name}.`);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <Shell title="New worktree">
      <form className="modal-body worktree-form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <p className="modal-text">A second checkout of <strong>{parent.name}</strong> on its own branch. An agent can work there while your main folder stays as it is.</p>
        <label className="field">
          <span>Branch name</span>
          <input autoFocus value={branch} placeholder="fix-login-redirect" spellCheck={false} onChange={(e) => setBranch(e.target.value)} />
        </label>
        {name && <p className="worktree-preview">
          {taken ? <>Checks out the existing branch <code>{name}</code></> : <>New branch <code>{name}</code></>}
          {path && <> in <code>{tilde(path)}</code></>}
        </p>}
        {!taken && <label className="field">
          <span>Start from</span>
          <select value={base} onChange={(e) => setBase(e.target.value)}>
            {branches.map((b) => <option key={b} value={b}>{b}{b === current ? " (current)" : ""}</option>)}
          </select>
        </label>}
        <div className="field">
          <span>Then open</span>
          <div className="segmented">
            {OPEN_WITH.map((t) => <button type="button" key={t ?? "none"} className={tool === t ? "is-on" : ""} onClick={() => setTool(t)}>{t ? TOOL_LABEL[t] : "Nothing"}</button>)}
          </div>
        </div>
        {existing.length > 0 && <div className="worktree-existing">
          <h3>Already on disk</h3>
          {existing.map((w) => (
            <div key={w.path} className="worktree-row">
              <FolderGit2 size={14} />
              <span><strong>{w.branch ?? `detached at ${w.head}`}</strong><small>{tilde(w.path)}</small></span>
              <button type="button" className="mini-btn" onClick={() => {
                addWorktreeProject(parent, w.path, w.branch);
                setExisting((list) => list.filter((x) => x.path !== w.path));
              }}><Plus size={12} />Add to Desk</button>
            </div>
          ))}
        </div>}
        {error && <p className="form-error">{error}</p>}
        <footer className="modal-foot">
          <button type="button" className="btn" onClick={() => useDesk.getState().setModal(null)}>Cancel</button>
          <button className="btn is-primary" disabled={!name || busy || (!taken && !base)}><GitBranchPlus size={14} />{busy ? "Creating…" : "Create worktree"}</button>
        </footer>
      </form>
    </Shell>
  );
}
