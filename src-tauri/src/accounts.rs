//! Account discovery. An account is a config directory: Claude Code reads
//! `CLAUDE_CONFIG_DIR` and Codex reads `CODEX_HOME`. The default account of each
//! tool is the one used when the variable is unset.

use std::fs;
use std::path::{Path, PathBuf};

use base64::Engine;
use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Claude,
    Codex,
    Gemini,
    Cursor,
    Grok,
    OpenCode,
    #[serde(rename = "github")]
    GitHub,
}

impl Kind {
    fn prefix(self) -> &'static str {
        match self {
            Kind::Claude => ".claude",
            Kind::Codex => ".codex",
            Kind::Gemini => ".gemini",
            Kind::Cursor => ".cursor",
            Kind::Grok => ".grok",
            Kind::OpenCode => ".opencode",
            // gh's own default; extra accounts are `~/.config/gh-<name>` (GH_CONFIG_DIR).
            Kind::GitHub => ".config/gh",
        }
    }

    /// Files whose presence marks a directory as a real config dir.
    fn markers(self) -> &'static [&'static str] {
        match self {
            Kind::Claude => &[".claude.json", "settings.json", "projects", "history.jsonl"],
            Kind::Codex => &["auth.json", "config.toml", "sessions"],
            // `GEMINI_CLI_HOME=<dir>` keeps its files in `<dir>/.gemini`.
            Kind::Gemini => &["settings.json", "oauth_creds.json", "google_accounts.json", ".gemini"],
            Kind::Cursor => &["cli-config.json"],
            Kind::Grok | Kind::OpenCode => &[],
            Kind::GitHub => &["hosts.yml", "config.yml"],
        }
    }

    fn parse(s: &str) -> Result<Self, String> {
        match s {
            "claude" => Ok(Kind::Claude),
            "codex" => Ok(Kind::Codex),
            "gemini" => Ok(Kind::Gemini),
            "cursor" => Ok(Kind::Cursor),
            "grok" => Ok(Kind::Grok),
            "opencode" => Ok(Kind::OpenCode),
            "github" => Ok(Kind::GitHub),
            _ => Err(format!("unknown account kind: {s}")),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedAccount {
    pub kind: Kind,
    /// `None` for the tool's default directory.
    pub dir: Option<String>,
    pub path: String,
    pub email: Option<String>,
    pub org: Option<String>,
    pub signed_in: bool,
}

fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"))
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
}

fn str_at(v: &Value, ptr: &str) -> Option<String> {
    v.pointer(ptr)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(String::from)
}

/// Claude Code keeps the signed-in account (not the token) in `.claude.json`,
/// which lives in `$HOME` for the default account and inside the config dir otherwise.
fn claude_identity(dir: &Path, is_default: bool) -> (Option<String>, Option<String>, bool) {
    let file = if is_default {
        home().join(".claude.json")
    } else {
        dir.join(".claude.json")
    };
    match read_json(&file) {
        Some(v) => {
            let email = str_at(&v, "/oauthAccount/emailAddress");
            let org = str_at(&v, "/oauthAccount/organizationName");
            let signed_in = email.is_some() || v.get("primaryApiKey").is_some();
            (email, org, signed_in)
        }
        None => (None, None, false),
    }
}

/// Codex stores ChatGPT sign-ins in `auth.json`; the email is a claim in the
/// ID token's payload. Only that claim is decoded; nothing else is kept.
fn codex_identity(dir: &Path) -> (Option<String>, Option<String>, bool) {
    let Some(v) = read_json(&dir.join("auth.json")) else {
        return (None, None, false);
    };
    let email = str_at(&v, "/tokens/id_token").and_then(|jwt| {
        let payload = jwt.split('.').nth(1)?;
        let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(payload.trim_end_matches('='))
            .ok()?;
        let claims: Value = serde_json::from_slice(&bytes).ok()?;
        str_at(&claims, "/email")
    });
    let api_key = v
        .get("OPENAI_API_KEY")
        .map(|k| !k.is_null())
        .unwrap_or(false);
    let org = if email.is_none() && api_key {
        Some("API key".into())
    } else {
        None
    };
    let signed_in = email.is_some() || api_key;
    (email, org, signed_in)
}

/// Gemini CLI keeps the active Google account's email in `google_accounts.json`
/// and its OAuth tokens (never read here) in `oauth_creds.json`.
fn gemini_identity(dir: &Path, is_default: bool) -> (Option<String>, Option<String>, bool) {
    let root = if is_default { dir.to_path_buf() } else { dir.join(".gemini") };
    let email = read_json(&root.join("google_accounts.json")).and_then(|v| str_at(&v, "/active"));
    let signed_in = email.is_some() || root.join("oauth_creds.json").exists();
    (email, None, signed_in)
}

/// gh records who is signed in to github.com in `hosts.yml` (the token itself is in the keychain).
fn github_identity(dir: &Path) -> (Option<String>, Option<String>, bool) {
    let Ok(text) = fs::read_to_string(dir.join("hosts.yml")) else { return (None, None, false) };
    let mut in_github = false;
    for line in text.lines() {
        if !line.starts_with(' ') {
            in_github = line.trim_end() == "github.com:";
        } else if in_github {
            if let Some(user) = line.trim().strip_prefix("user:") {
                let user = user.trim().trim_matches('"');
                if !user.is_empty() {
                    return (Some(format!("@{user}")), None, true);
                }
            }
        }
    }
    (None, None, false)
}

fn describe(kind: Kind, path: &Path, is_default: bool) -> DetectedAccount {
    let (email, org, signed_in) = match kind {
        Kind::Claude => claude_identity(path, is_default),
        Kind::Codex => codex_identity(path),
        Kind::Gemini => gemini_identity(path, is_default),
        // Cursor Agent and Grok don't expose who is signed in; the UI says so.
        Kind::Cursor | Kind::Grok => (None, None, false),
        // OpenCode keeps provider keys in ~/.local/share/opencode/auth.json (never read here).
        Kind::OpenCode => (None, None, home().join(".local/share/opencode/auth.json").exists()),
        Kind::GitHub => github_identity(path),
    };
    DetectedAccount {
        kind,
        dir: (!is_default).then(|| path.to_string_lossy().into_owned()),
        path: path.to_string_lossy().into_owned(),
        email,
        org,
        signed_in,
    }
}

/// Finds `~/.claude*` and `~/.codex*` directories that look like config dirs.
pub fn detect() -> Vec<DetectedAccount> {
    let home = home();
    let mut found = Vec::new();
    let Ok(entries) = fs::read_dir(&home) else {
        return found;
    };
    let mut names: Vec<String> = entries
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();

    // Cursor (~/.cursor also belongs to the editor) and Grok are only ever added by hand.
    for kind in [Kind::Claude, Kind::Codex, Kind::Gemini] {
        for name in &names {
            let Some(rest) = name.strip_prefix(kind.prefix()) else {
                continue;
            };
            if !(rest.is_empty()
                || rest.starts_with('-')
                || rest.starts_with('_')
                || rest.starts_with('.'))
            {
                continue;
            }
            let path = home.join(name);
            if !kind.markers().iter().any(|m| path.join(m).exists()) {
                continue;
            }
            found.push(describe(kind, &path, rest.is_empty()));
        }
    }
    // GitHub (gh) folders live in ~/.config: `gh` itself and `gh-<name>`.
    let config = home.join(".config");
    if let Ok(entries) = fs::read_dir(&config) {
        let mut dirs: Vec<String> = entries.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| n == "gh" || n.starts_with("gh-")).collect();
        dirs.sort();
        for name in dirs {
            let path = config.join(&name);
            if path.join("hosts.yml").exists() {
                found.push(describe(Kind::GitHub, &path, name == "gh"));
            }
        }
    }
    found
}

/// Re-reads one account, used after a sign-in finishes.
pub fn inspect(kind: &str, dir: Option<String>) -> Result<DetectedAccount, String> {
    let kind = Kind::parse(kind)?;
    Ok(match dir {
        Some(d) => describe(kind, Path::new(&d), false),
        None => describe(kind, &home().join(kind.prefix()), true),
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub dir: Option<String>,
    pub sessions: usize,
    /// Newest session file, in ms since the epoch.
    pub last_used: u64,
    /// True when sessions were started in the folder itself, not a subfolder.
    pub exact: bool,
}

/// Claude Code names each project's history folder after its path with every
/// character other than a letter or digit replaced by `-`.
pub(crate) fn claude_project_key(path: &str) -> String {
    path.trim_end_matches('/')
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

fn session_stats(dir: &Path) -> (usize, u64) {
    let Ok(entries) = fs::read_dir(dir) else {
        return (0, 0);
    };
    let mut count = 0;
    let mut newest = 0;
    for e in entries.flatten() {
        if e.path().extension().is_some_and(|x| x == "jsonl") {
            count += 1;
            let modified = e
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            newest = newest.max(modified);
        }
    }
    (count, newest)
}

/// How much each Claude account has been used in `project`, judged from the
/// names and timestamps of its session files. File contents are never read.
pub fn claude_usage(project: &str, dirs: Vec<Option<String>>) -> Vec<Usage> {
    let key = claude_project_key(project);
    dirs.into_iter()
        .map(|dir| {
            let root = match &dir {
                Some(d) => PathBuf::from(d),
                None => home().join(".claude"),
            }
            .join("projects");
            let (mut sessions, mut last_used) = session_stats(&root.join(&key));
            let exact = sessions > 0;
            if !exact {
                // Fall back to sessions started in subfolders of the project.
                let prefix = format!("{key}-");
                for e in fs::read_dir(&root).into_iter().flatten().flatten() {
                    let name = e.file_name().to_string_lossy().into_owned();
                    if name.starts_with(&prefix) {
                        let (n, t) = session_stats(&e.path());
                        sessions += n;
                        last_used = last_used.max(t);
                    }
                }
            }
            Usage {
                dir,
                sessions,
                last_used,
                exact,
            }
        })
        .collect()
}

fn slug(name: &str) -> String {
    let mut out = String::new();
    for c in name.trim().to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    out.trim_matches('-').to_string()
}

/// Creates `~/.claude-<name>`, `~/.codex-<name>` or `~/.gemini-<name>` and returns its path.
/// An existing directory is reused, never cleared.
pub fn create(kind: &str, name: &str) -> Result<String, String> {
    let kind = Kind::parse(kind)?;
    if matches!(kind, Kind::Cursor | Kind::Grok | Kind::OpenCode) {
        return Err("This tool keeps one sign-in per Mac, so it can't have extra accounts".into());
    }
    let s = slug(name);
    if s.is_empty() {
        return Err("Account name needs at least one letter or number".into());
    }
    let path = home().join(format!("{}-{}", kind.prefix(), s));
    fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// True when any of `bins` is on the PATH of the user's login shell (the same
/// `-l -i` shell terminals use, so nvm/asdf installs count). Gives up after 6 s.
pub fn tool_installed(bins: Vec<String>) -> bool {
    use std::process::{Command, Stdio};
    use std::sync::mpsc;
    use std::time::Duration;
    let safe = |b: &String| !b.is_empty() && b.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if bins.is_empty() || !bins.iter().all(safe) {
        return false;
    }
    let script = bins
        .iter()
        .map(|b| format!("command -v {b} >/dev/null 2>&1"))
        .collect::<Vec<_>>()
        .join(" || ");
    let Ok(mut child) = Command::new(crate::pty::user_shell())
        .args(["-l", "-i", "-c", &script])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    else {
        return false;
    };
    let pid = child.id();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(child.wait().map(|s| s.success()).unwrap_or(false));
    });
    match rx.recv_timeout(Duration::from_secs(6)) {
        Ok(found) => found,
        Err(_) => {
            unsafe { libc::kill(pid as i32, libc::SIGKILL) };
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_tools_on_the_login_path() {
        assert!(tool_installed(vec!["sh".into()]));
        assert!(!tool_installed(vec!["desk-no-such-tool-xyz".into()]));
        assert!(!tool_installed(vec!["sh; rm".into()]));
    }

    #[test]
    fn single_account_tools_cannot_create_folders() {
        assert!(create("grok", "work").is_err());
        assert!(create("cursor", "work").is_err());
    }

    #[test]
    fn slugs_names() {
        assert_eq!(slug("Work"), "work");
        assert_eq!(slug("  Side Project #2 "), "side-project-2");
        assert_eq!(slug("!!!"), "");
    }

    #[test]
    fn encodes_project_paths_like_claude_code() {
        assert_eq!(
            claude_project_key("/Users/nish/.speaky"),
            "-Users-nish--speaky"
        );
        assert_eq!(
            claude_project_key("/Users/nish/projects/cortex-backend/"),
            "-Users-nish-projects-cortex-backend"
        );
    }

    #[test]
    fn finds_the_account_with_sessions() {
        let base = std::env::temp_dir().join(format!("desk-usage-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let work = base.join("work");
        let personal = base.join("personal");
        let key = claude_project_key("/p/app");
        fs::create_dir_all(work.join("projects").join(&key)).unwrap();
        fs::write(work.join("projects").join(&key).join("a.jsonl"), "").unwrap();
        fs::create_dir_all(personal.join("projects").join(format!("{key}-web"))).unwrap();
        fs::write(
            personal
                .join("projects")
                .join(format!("{key}-web"))
                .join("b.jsonl"),
            "",
        )
        .unwrap();
        fs::create_dir_all(personal.join("projects").join(format!("{key}x"))).unwrap();
        fs::write(
            personal
                .join("projects")
                .join(format!("{key}x"))
                .join("c.jsonl"),
            "",
        )
        .unwrap();

        let dirs = vec![
            Some(work.to_string_lossy().into_owned()),
            Some(personal.to_string_lossy().into_owned()),
        ];
        let usage = claude_usage("/p/app", dirs);
        assert_eq!((usage[0].sessions, usage[0].exact), (1, true));
        // Subfolder sessions count; a sibling like /p/appx does not.
        assert_eq!((usage[1].sessions, usage[1].exact), (1, false));
    }
    #[test]
    fn reads_the_github_user_from_hosts_yml() {
        let dir = std::env::temp_dir().join(format!("desk-gh-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("hosts.yml"), "gitlab.com:\n    user: other\ngithub.com:\n    git_protocol: https\n    users:\n        octo:\n    user: octo\n").unwrap();
        assert_eq!(github_identity(&dir), (Some("@octo".into()), None, true));
        fs::write(dir.join("hosts.yml"), "").unwrap();
        assert!(!github_identity(&dir).2);
        let _ = fs::remove_dir_all(&dir);
    }
}
