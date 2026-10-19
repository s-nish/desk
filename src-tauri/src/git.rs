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
}
#[derive(Serialize)]
pub struct Status {
    pub root: String,
    pub branch: String,
    pub changes: Vec<Change>,
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
    let changes = parse_status(&run(
        &top,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    )?);
    Ok(Status {
        root: top,
        branch,
        changes,
    })
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
pub fn commit(root: &str, message: &str) -> Result<String, String> {
    if message.trim().is_empty() {
        return Err("Enter a commit message".into());
    }
    run(root, &["commit", "-m", message])
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
