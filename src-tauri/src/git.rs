//! Git operations use argument arrays and literal paths; never a shell.
use serde::Serialize;
use std::{
    path::{Component, Path},
    process::Command,
};

fn run(root: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .args(["--literal-pathspecs", "-C", root])
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|e| format!("Couldn't run Git: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    String::from_utf8(output.stdout).map_err(|_| "Git returned a filename that isn't UTF-8".into())
}
fn validate_path(path: &str) -> Result<(), String> {
    if path.is_empty()
        || Path::new(path)
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err("Expected a repository-relative file path".into());
    }
    Ok(())
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub path: String,
    pub original_path: Option<String>,
    pub index: String,
    pub worktree: String,
    /// Lines added and removed in the staged and unstaged parts; None for binary files.
    pub staged_lines: Option<(u32, u32)>,
    pub unstaged_lines: Option<(u32, u32)>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub root: String,
    pub branch: String,
    pub changes: Vec<Change>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    /// Subject of the latest commit; None in a repository without commits.
    pub last_commit: Option<String>,
}
fn parse_status(text: &str) -> Vec<Change> {
    let mut fields = text.split('\0').filter(|s| !s.is_empty());
    let mut changes = Vec::new();
    while let Some(field) = fields.next() {
        if field.len() < 4 {
            continue;
        }
        let index = &field[0..1];
        let worktree = &field[1..2];
        let original_path = if index == "R" || index == "C" || worktree == "R" || worktree == "C" {
            fields.next().map(str::to_string)
        } else {
            None
        };
        changes.push(Change {
            path: field[3..].into(),
            original_path,
            index: index.into(),
            worktree: worktree.into(),
            staged_lines: None,
            unstaged_lines: None,
        });
    }
    changes
}
pub fn status(root: &str) -> Result<Status, String> {
    let top = run(root, &["rev-parse", "--show-toplevel"])?
        .trim()
        .to_string();
    let branch = run(&top, &["symbolic-ref", "--quiet", "--short", "HEAD"])
        .or_else(|_| run(&top, &["rev-parse", "--short", "HEAD"]))?
        .trim()
        .to_string();
    let mut changes = parse_status(&run(
        &top,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    )?);
    let staged = run(&top, &["diff", "--cached", "--numstat", "-z", "--no-renames"]).map(|t| parse_numstat(&t)).unwrap_or_default();
    let unstaged = run(&top, &["diff", "--numstat", "-z", "--no-renames"]).map(|t| parse_numstat(&t)).unwrap_or_default();
    let mut untracked_counted = 0;
    for change in &mut changes {
        change.staged_lines = staged.get(&change.path).copied().flatten();
        change.unstaged_lines = unstaged.get(&change.path).copied().flatten();
        // Reading new files is capped so a folder of untracked files can't stall the panel.
        if change.index == "?" && untracked_counted < 200 {
            untracked_counted += 1;
            change.unstaged_lines = count_lines(&Path::new(&top).join(&change.path)).map(|n| (n, 0));
        }
    }
    let upstream = run(&top, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let (ahead, behind) = upstream
        .as_ref()
        .and_then(|_| run(&top, &["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]).ok())
        .and_then(|s| {
            let mut n = s.split_whitespace().map(|x| x.parse::<u32>().unwrap_or(0));
            Some((n.next()?, n.next()?))
        })
        .unwrap_or((0, 0));
    let last_commit = run(&top, &["log", "-1", "--format=%s"]).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    Ok(Status {
        root: top,
        branch,
        changes,
        upstream,
        ahead,
        behind,
        last_commit,
    })
}

/// Number of changed files, for sidebar badges. One cheap git call, no line counts.
pub fn change_count(root: &str) -> Result<usize, String> {
    Ok(parse_status(&run(root, &["status", "--porcelain=v1", "-z", "--untracked-files=all"])?).len())
}

/// `git diff --numstat -z` output by path. Binary files map to None.
fn parse_numstat(text: &str) -> std::collections::HashMap<String, Option<(u32, u32)>> {
    let mut out = std::collections::HashMap::new();
    for record in text.split('\0').filter(|s| !s.is_empty()) {
        let mut parts = record.splitn(3, '\t');
        let (Some(added), Some(removed), Some(path)) = (parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        let lines = added.parse().ok().zip(removed.parse().ok());
        out.insert(path.to_string(), lines);
    }
    out
}

/// Line count of a new file, skipped for binary or large files.
fn count_lines(path: &Path) -> Option<u32> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > 2 * 1024 * 1024 {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    if bytes.contains(&0) {
        return None;
    }
    let n = bytes.iter().filter(|&&b| b == b'\n').count();
    Some((n + usize::from(!bytes.is_empty() && !bytes.ends_with(b"\n"))) as u32)
}
pub fn diff(root: &str, path: &str, staged: bool) -> Result<String, String> {
    validate_path(path)?;
    let state = status(root)?;
    let change = state
        .changes
        .iter()
        .find(|c| c.path == path)
        .ok_or("File no longer has changes. Refresh the list.")?;
    if change.index == "?" {
        let full = Path::new(&state.root).join(path);
        let meta = std::fs::symlink_metadata(&full).map_err(|e| e.to_string())?;
        if meta.file_type().is_symlink() {
            return Ok(format!(
                "New symbolic link: {}",
                std::fs::read_link(full)
                    .map_err(|e| e.to_string())?
                    .display()
            ));
        }
        return crate::files::read_file(&full.to_string_lossy())
            .map(|f| f.content.lines().map(|s| format!("+{s}\n")).collect());
    }
    let mut args = vec!["diff", "--no-ext-diff", "--no-textconv", "--no-color"];
    if staged {
        args.push("--cached");
    }
    args.extend(["--", path]);
    if let Some(original) = &change.original_path {
        args.push(original);
    }
    let text = run(&state.root, &args)?;
    if text.len() > 2 * 1024 * 1024 {
        return Err("Diff exceeds 2 MB. Review this file in your terminal.".into());
    }
    Ok(text)
}
pub fn stage(root: &str, path: &str, staged: bool) -> Result<(), String> {
    validate_path(path)?;
    let state = status(root)?;
    let change = state
        .changes
        .iter()
        .find(|c| c.path == path)
        .ok_or("File no longer has changes. Refresh the list.")?;
    let mut paths = vec![path];
    if !staged {
        if let Some(original) = &change.original_path {
            paths.push(original);
        }
    }
    if staged {
        let mut args = vec!["add", "--all", "--"];
        args.extend(paths);
        run(&state.root, &args)?;
    } else if run(&state.root, &["rev-parse", "--verify", "HEAD"]).is_ok() {
        let mut args = vec!["reset", "--quiet", "HEAD", "--"];
        args.extend(paths);
        run(&state.root, &args)?;
    } else {
        let mut args = vec!["rm", "--cached", "--force", "--quiet", "--"];
        args.extend(paths);
        run(&state.root, &args)?;
    }
    Ok(())
}
/// Stages or unstages every change at once.
pub fn stage_all(root: &str, staged: bool) -> Result<(), String> {
    let top = run(root, &["rev-parse", "--show-toplevel"])?.trim().to_string();
    if staged {
        run(&top, &["add", "--all"])?;
    } else if run(&top, &["rev-parse", "--verify", "HEAD"]).is_ok() {
        run(&top, &["reset", "--quiet", "HEAD"])?;
    } else {
        run(&top, &["rm", "-r", "--cached", "--force", "--quiet", "."])?;
    }
    Ok(())
}

/// Throws away unstaged edits to one file. Tracked files go back to their staged
/// (or committed) version; untracked files are moved to the Trash, never deleted.
pub fn discard(root: &str, path: &str) -> Result<(), String> {
    validate_path(path)?;
    let state = status(root)?;
    let change = state
        .changes
        .iter()
        .find(|c| c.path == path)
        .ok_or("File no longer has changes. Refresh the list.")?;
    if change.index == "?" {
        return crate::files::move_to_trash(&Path::new(&state.root).join(path).to_string_lossy());
    }
    if change.worktree == " " {
        return Err("This file has no unstaged changes to discard. Unstage it first.".into());
    }
    run(&state.root, &["restore", "--worktree", "--", path]).map(|_| ())
}

pub fn commit(root: &str, message: &str) -> Result<String, String> {
    if message.trim().is_empty() {
        return Err("Enter a commit message".into());
    }
    run(root, &["commit", "-m", message])
}

// Worktrees

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    pub path: String,
    pub branch: Option<String>,
    pub head: String,
    /// The repository's main checkout (the first entry git lists).
    pub main: bool,
    pub locked: bool,
    pub prunable: bool,
}

fn parse_worktrees(text: &str) -> Vec<Worktree> {
    let mut out: Vec<Worktree> = Vec::new();
    for line in text.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            out.push(Worktree { path: path.into(), branch: None, head: String::new(), main: out.is_empty(), locked: false, prunable: false });
            continue;
        }
        let Some(w) = out.last_mut() else { continue };
        if let Some(head) = line.strip_prefix("HEAD ") {
            w.head = head.chars().take(8).collect();
        } else if let Some(branch) = line.strip_prefix("branch ") {
            w.branch = Some(branch.strip_prefix("refs/heads/").unwrap_or(branch).into());
        } else if line == "locked" || line.starts_with("locked ") {
            w.locked = true;
        } else if line == "prunable" || line.starts_with("prunable ") {
            w.prunable = true;
        }
    }
    out
}

pub fn worktrees(root: &str) -> Result<Vec<Worktree>, String> {
    Ok(parse_worktrees(&run(root, &["worktree", "list", "--porcelain"])?))
}

/// Branch names Desk creates or merges: letters, digits and `._/-` only, so they
/// are safe in paths and shell commands without quoting surprises.
pub fn check_branch(name: &str) -> Result<(), String> {
    let ok = !name.is_empty()
        && name.len() <= 100
        && name.chars().all(|c| c.is_ascii_alphanumeric() || "._/-".contains(c))
        && !name.starts_with(['-', '/', '.'])
        && !name.ends_with(['/', '.'])
        && !name.contains("..")
        && !name.contains("//")
        && !name.ends_with(".lock");
    if ok { Ok(()) } else { Err("Use letters, numbers, dots, dashes and slashes for the branch name.".into()) }
}

pub fn branches(root: &str) -> Result<Vec<String>, String> {
    Ok(run(root, &["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads"])?
        .lines()
        .map(str::to_string)
        .collect())
}

/// Where Desk puts a new worktree: next to the repository, in `<repo>.worktrees/`.
/// Outside the repository so it never shows up in its status, search or watcher.
pub fn worktree_path(top: &str, branch: &str) -> Result<String, String> {
    let top = Path::new(top);
    let repo = top.file_name().ok_or("Repository has no folder name")?.to_string_lossy();
    let parent = top.parent().ok_or("Repository has no parent folder")?;
    let slug = branch.replace('/', "-");
    Ok(parent.join(format!("{repo}.worktrees")).join(slug).to_string_lossy().into_owned())
}

/// Creates a worktree on a new branch from `base` (or checks out an existing
/// branch that isn't checked out anywhere) and returns its folder.
pub fn add_worktree(root: &str, branch: &str, base: &str) -> Result<String, String> {
    check_branch(branch)?;
    let top = run(root, &["rev-parse", "--show-toplevel"])?.trim().to_string();
    let path = worktree_path(&top, branch)?;
    if Path::new(&path).exists() {
        return Err(format!("{path} already exists. Pick another branch name."));
    }
    let exists = run(&top, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")]).is_ok();
    if exists {
        run(&top, &["worktree", "add", &path, branch])?;
    } else {
        if base.is_empty() {
            return Err("Pick a branch to start from.".into());
        }
        run(&top, &["rev-parse", "--verify", "--quiet", &format!("{base}^{{commit}}")]).map_err(|_| format!("Couldn't find the branch {base}."))?;
        run(&top, &["worktree", "add", "-b", branch, &path, base])?;
    }
    Ok(path)
}

/// Removes a worktree folder. Without `force`, git refuses when it has
/// uncommitted or untracked files, and that refusal is passed on as is.
pub fn remove_worktree(root: &str, path: &str, force: bool) -> Result<(), String> {
    let list = worktrees(root)?;
    let real = |p: &str| std::fs::canonicalize(p).unwrap_or_else(|_| p.into());
    let target = list.iter().find(|w| real(&w.path) == real(path)).ok_or("Git doesn't list this folder as a worktree.")?;
    if target.main {
        return Err("The main checkout can't be removed.".into());
    }
    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push(&target.path);
    run(root, &args).map(|_| ())
}

/// Deletes a branch only when it is fully merged (`git branch -d`).
pub fn delete_branch(root: &str, branch: &str) -> Result<(), String> {
    check_branch(branch)?;
    run(root, &["branch", "-d", branch]).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_renames_and_special_filenames() {
        let changes = parse_status("R  new name\0old name\0?? odd\nname\0 M file\0");
        assert_eq!(changes.len(), 3);
        assert_eq!(changes[0].original_path.as_deref(), Some("old name"));
        assert_eq!(changes[1].path, "odd\nname");
        assert_eq!(changes[2].worktree, "M");
        assert!(validate_path("../outside").is_err());
        assert!(validate_path("/absolute").is_err());
    }
    #[test]
    fn parses_numstat_and_worktrees() {
        let stats = parse_numstat("3\t1\tsrc/a.rs\0-\t-\timg.png\0");
        assert_eq!(stats["src/a.rs"], Some((3, 1)));
        assert_eq!(stats["img.png"], None);
        let list = parse_worktrees("worktree /r/app\nHEAD 0123456789abcdef\nbranch refs/heads/main\n\nworktree /r/app.worktrees/fix\nHEAD fedcba9876543210\nbranch refs/heads/desk/fix\nlocked\n\nworktree /r/old\nHEAD 1111111111111111\ndetached\nprunable gitdir file points to non-existent location\n");
        assert_eq!(list.len(), 3);
        assert!(list[0].main && !list[1].main);
        assert_eq!(list[1].branch.as_deref(), Some("desk/fix"));
        assert!(list[1].locked && list[2].prunable && list[2].branch.is_none());
        assert_eq!(list[0].head, "01234567");
    }
    #[test]
    fn checks_branch_names() {
        assert!(check_branch("desk/fix-login_2").is_ok());
        for bad in ["", "-x", "a..b", "a b", "a'b", "a/", "x.lock", "/a", "a//b", "a;rm"] {
            assert!(check_branch(bad).is_err(), "{bad}");
        }
        assert_eq!(worktree_path("/r/app", "desk/fix").unwrap(), "/r/app.worktrees/desk-fix");
    }
    #[test]
    fn worktrees_discard_and_line_counts() {
        let base = std::env::temp_dir().join(format!("desk-worktree-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let dir = base.join("app");
        std::fs::create_dir_all(&dir).unwrap();
        let root = dir.to_str().unwrap();
        run(root, &["init", "-b", "main"]).unwrap();
        run(root, &["config", "user.name", "Desk Test"]).unwrap();
        run(root, &["config", "user.email", "test@example.invalid"]).unwrap();
        std::fs::write(dir.join("a.txt"), "one\ntwo\n").unwrap();
        stage_all(root, true).unwrap();
        commit(root, "initial").unwrap();

        std::fs::write(dir.join("a.txt"), "one\nTWO\nthree\n").unwrap();
        std::fs::write(dir.join("new.txt"), "x\ny").unwrap();
        let s = status(root).unwrap();
        let a = s.changes.iter().find(|c| c.path == "a.txt").unwrap();
        assert_eq!(a.unstaged_lines, Some((2, 1)));
        let n = s.changes.iter().find(|c| c.path == "new.txt").unwrap();
        assert_eq!(n.unstaged_lines, Some((2, 0)));
        assert_eq!(s.last_commit.as_deref(), Some("initial"));
        assert_eq!((s.ahead, s.behind, s.upstream.is_none()), (0, 0, true));

        discard(root, "a.txt").unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "one\ntwo\n");
        stage_all(root, true).unwrap();
        assert!(status(root).unwrap().changes.iter().all(|c| c.worktree == " "));
        stage_all(root, false).unwrap();
        assert!(status(root).unwrap().changes.iter().all(|c| c.index == " " || c.index == "?"));
        std::fs::remove_file(dir.join("new.txt")).unwrap();

        let path = add_worktree(root, "desk/fix", "main").unwrap();
        assert_eq!(path, std::fs::canonicalize(&base).unwrap().join("app.worktrees").join("desk-fix").to_string_lossy());
        assert!(add_worktree(root, "desk/fix", "main").is_err());
        let list = worktrees(root).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[1].branch.as_deref(), Some("desk/fix"));
        assert!(branches(root).unwrap().contains(&"desk/fix".to_string()));

        std::fs::write(Path::new(&path).join("scratch.txt"), "x").unwrap();
        assert!(remove_worktree(root, &path, false).is_err());
        assert!(remove_worktree(root, root, true).is_err());
        remove_worktree(root, &path, true).unwrap();
        assert!(!Path::new(&path).exists());
        delete_branch(root, "desk/fix").unwrap();
        assert!(!branches(root).unwrap().contains(&"desk/fix".to_string()));
        std::fs::remove_dir_all(base).unwrap();
    }
    #[test]
    fn stages_unstages_and_commits_literal_paths() {
        let dir = std::env::temp_dir().join(format!("desk-git-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let root = dir.to_str().unwrap();
        run(root, &["init"]).unwrap();
        run(root, &["config", "user.name", "Desk Test"]).unwrap();
        run(root, &["config", "user.email", "test@example.invalid"]).unwrap();
        std::fs::write(dir.join("[file].txt"), "hello\n").unwrap();
        stage(root, "[file].txt", true).unwrap();
        assert_eq!(status(root).unwrap().changes[0].index, "A");
        stage(root, "[file].txt", false).unwrap();
        assert!(dir.join("[file].txt").exists());
        stage(root, "[file].txt", true).unwrap();
        commit(root, "initial").unwrap();
        std::fs::write(dir.join("[file].txt"), "changed\n").unwrap();
        assert!(
            diff(root, "[file].txt", false)
                .unwrap()
                .contains("+changed")
        );
        stage(root, "[file].txt", true).unwrap();
        stage(root, "[file].txt", false).unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.join("[file].txt")).unwrap(),
            "changed\n"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
}
