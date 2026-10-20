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
}

impl Kind {
    fn prefix(self) -> &'static str {
        match self {
            Kind::Claude => ".claude",
            Kind::Codex => ".codex",
        }
    }

    /// Files whose presence marks a directory as a real config dir.
    fn markers(self) -> &'static [&'static str] {
        match self {
            Kind::Claude => &[".claude.json", "settings.json", "projects", "history.jsonl"],
            Kind::Codex => &["auth.json", "config.toml", "sessions"],
        }
    }

    fn parse(s: &str) -> Result<Self, String> {
        match s {
            "claude" => Ok(Kind::Claude),
            "codex" => Ok(Kind::Codex),
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

fn describe(kind: Kind, path: &Path, is_default: bool) -> DetectedAccount {
    let (email, org, signed_in) = match kind {
        Kind::Claude => claude_identity(path, is_default),
        Kind::Codex => codex_identity(path),
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

    for kind in [Kind::Claude, Kind::Codex] {
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

/// Creates `~/.claude-<name>` or `~/.codex-<name>` and returns its path.
/// An existing directory is reused, never cleared.
pub fn create(kind: &str, name: &str) -> Result<String, String> {
    let kind = Kind::parse(kind)?;
    let s = slug(name);
    if s.is_empty() {
        return Err("Account name needs at least one letter or number".into());
    }
    let path = home().join(format!("{}-{}", kind.prefix(), s));
    fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
