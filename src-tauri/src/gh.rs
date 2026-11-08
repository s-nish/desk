//! GitHub through the `gh` CLI: it already holds the user's sign-in, so Desk
//! stores no tokens. Arguments are passed as an array; never through a shell.
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

use serde::Serialize;

const NOT_INSTALLED: &str = "The GitHub CLI (gh) isn't installed. Install it with `brew install gh`, then run `gh auth login`.";

/// Where `gh` lives. Apps opened from Finder get a short PATH, so the usual
/// install folders are checked first, then a login shell is asked once.
fn gh_path() -> Option<&'static PathBuf> {
    static PATH: OnceLock<Option<PathBuf>> = OnceLock::new();
    PATH.get_or_init(|| {
        let home = dirs::home_dir().unwrap_or_default();
        let known = ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"]
            .iter()
            .map(PathBuf::from)
            .chain([home.join(".local/bin/gh"), home.join("bin/gh")]);
        for p in known {
            if p.is_file() {
                return Some(p);
            }
        }
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let out = Command::new(shell).args(["-l", "-c", "command -v gh"]).output().ok()?;
        let found = String::from_utf8_lossy(&out.stdout).trim().to_string();
        (!found.is_empty() && Path::new(&found).is_file()).then(|| PathBuf::from(found))
    })
    .as_ref()
}

/// Runs `gh` in `cwd` as the account whose folder is `config` (GH_CONFIG_DIR;
/// None is gh's default) and returns its output. Errors carry gh's own message.
pub fn run(cwd: &str, args: &[String], config: Option<&str>) -> Result<String, String> {
    let gh = gh_path().ok_or(NOT_INSTALLED)?;
    let dir = gh.parent().map(|d| d.to_string_lossy().into_owned()).unwrap_or_default();
    let path = format!("{dir}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:{}", std::env::var("PATH").unwrap_or_default());
    let mut cmd = Command::new(gh);
    match config {
        Some(dir) => cmd.env("GH_CONFIG_DIR", dir),
        None => cmd.env_remove("GH_CONFIG_DIR"),
    };
    let output = cmd
        .args(args)
        .current_dir(cwd)
        .env("PATH", path)
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env("NO_COLOR", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes -o ConnectTimeout=10")
        .output()
        .map_err(|e| format!("Couldn't run gh: {e}"))?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if err.contains("Could not resolve to a Repository") {
            return Err("The GitHub account gh is signed in to can't see this repository. Check `gh auth status`, or switch with `gh auth switch`.".into());
        }
        if err.contains("gh auth login") {
            return Err("gh isn't signed in to GitHub. Run `gh auth login` in a terminal.".into());
        }
        return Err(if err.is_empty() { "gh failed without saying why.".into() } else { err });
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Git, with gh's credential helper (if set up) answering as the project's GitHub account.
fn git(root: &str, args: &[&str], config: Option<&str>) -> Result<String, String> {
    let mut cmd = Command::new("git");
    match config {
        Some(dir) => cmd.env("GH_CONFIG_DIR", dir),
        None => cmd.env_remove("GH_CONFIG_DIR"),
    };
    let output = cmd
        .arg("-C")
        .arg(root)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes -o ConnectTimeout=10")
        .output()
        .map_err(|e| format!("Couldn't run Git: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Pushes the current branch, setting its upstream on origin.
pub fn push(root: &str, config: Option<&str>) -> Result<(), String> {
    git(root, &["push", "-u", "origin", "HEAD"], config).map(|_| ())
}

#[derive(Debug, Serialize)]
pub struct PrWorktree {
    pub path: String,
    pub branch: String,
}

/// Checks a pull request out into its own worktree (`<repo>.worktrees/pr-<n>`), with gh
/// setting up the branch so pushes go back to the pull request.
pub fn pr_worktree(root: &str, number: u32, config: Option<&str>) -> Result<PrWorktree, String> {
    let top = git(root, &["rev-parse", "--show-toplevel"], None)?.trim().to_string();
    let path = crate::git::worktree_path(&top, &format!("pr-{number}"))?;
    if !Path::new(&path).exists() {
        git(&top, &["worktree", "add", "--detach", &path, "HEAD"], None)?;
        if let Err(e) = run(&path, &["pr".into(), "checkout".into(), number.to_string()], config) {
            let _ = git(&top, &["worktree", "remove", "--force", &path], None);
            return Err(e);
        }
    }
    let branch = git(&path, &["rev-parse", "--abbrev-ref", "HEAD"], None)?.trim().to_string();
    Ok(PrWorktree { path, branch })
}
