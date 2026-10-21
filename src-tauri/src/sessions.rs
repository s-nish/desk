//! Past Claude Code and Codex conversations for a project, so they can be resumed.
//! Read only: files in the account folders are opened for reading and never
//! written, moved or locked. Only the start and end of each transcript are read.

use std::collections::HashMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use serde_json::Value;

use crate::accounts::claude_project_key;

/// How much of each end of a transcript is read.
const WINDOW: u64 = 64 * 1024;
const MAX_SESSIONS: usize = 60;
/// Codex keeps one folder of sessions for every project; only the newest are checked.
const MAX_CODEX_FILES: usize = 600;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub tool: &'static str,
    /// The account folder as the caller passed it (None for the tool's default).
    pub dir: Option<String>,
    pub id: String,
    pub title: String,
    /// First thing the user asked, when it differs from the title.
    pub prompt: Option<String>,
    pub cwd: String,
    /// Last change, in ms since the epoch.
    pub updated: u64,
}

fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"))
}

fn modified_ms(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// The complete lines in the first and last `WINDOW` bytes of a file.
fn ends(path: &Path) -> Option<(Vec<String>, Vec<String>)> {
    let mut file = fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let mut head = Vec::new();
    (&mut file).take(WINDOW).read_to_end(&mut head).ok()?;
    let head = String::from_utf8_lossy(&head);
    let mut head_lines: Vec<String> = head.lines().map(str::to_string).collect();
    if len > WINDOW && !head.ends_with('\n') {
        head_lines.pop();
    }
    let tail_lines = if len > WINDOW {
        file.seek(SeekFrom::Start(len - WINDOW)).ok()?;
        let mut tail = Vec::new();
        file.take(WINDOW).read_to_end(&mut tail).ok()?;
        let tail = String::from_utf8_lossy(&tail);
        tail.lines().skip(1).map(str::to_string).collect()
    } else {
        head_lines.clone()
    };
    Some((head_lines, tail_lines))
}

/// Whether `cwd` is the project, a folder inside it, or one of its Desk worktrees.
fn belongs(cwd: &str, project: &str) -> bool {
    let project = project.trim_end_matches('/');
    cwd == project || cwd.starts_with(&format!("{project}/")) || cwd.starts_with(&format!("{project}.worktrees/"))
}

/// One line of text for the list: whitespace collapsed, at most 160 characters.
fn tidy(text: &str) -> Option<String> {
    let line: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.is_empty() {
        return None;
    }
    Some(if line.chars().count() > 160 { format!("{}…", line.chars().take(159).collect::<String>()) } else { line })
}

/// Text the user typed, skipping command wrappers and tool results Claude records as user turns.
fn claude_prompt(record: &Value) -> Option<String> {
    if record.get("type")?.as_str()? != "user" || record.get("isMeta").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    let content = record.pointer("/message/content")?;
    let text = match content {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter(|p| p.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|p| p.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(" "),
        _ => return None,
    };
    let text = text.trim();
    if text.is_empty() || text.starts_with('<') || text.starts_with("Caveat:") {
        return None;
    }
    tidy(text)
}

fn claude_session(path: &Path, project: &str, dir: &Option<String>) -> Option<Session> {
    let id = path.file_stem()?.to_string_lossy().into_owned();
    let (head, tail) = ends(path)?;
    let mut cwd = None;
    let mut prompt = None;
    for line in &head {
        if cwd.is_some() && prompt.is_some() {
            break;
        }
        let Ok(record) = serde_json::from_str::<Value>(line) else { continue };
        if cwd.is_none() {
            cwd = record.get("cwd").and_then(Value::as_str).map(str::to_string);
        }
        if prompt.is_none() {
            prompt = claude_prompt(&record);
        }
    }
    let cwd = cwd?;
    if !belongs(&cwd, project) {
        return None;
    }
    let mut title = None;
    let mut last_prompt = None;
    for line in tail.iter().rev() {
        if title.is_some() {
            break;
        }
        if !line.contains("\"ai-title\"") && !line.contains("\"last-prompt\"") {
            continue;
        }
        let Ok(record) = serde_json::from_str::<Value>(line) else { continue };
        match record.get("type").and_then(Value::as_str) {
            Some("ai-title") => title = record.get("aiTitle").and_then(Value::as_str).and_then(tidy),
            Some("last-prompt") if last_prompt.is_none() => last_prompt = record.get("lastPrompt").and_then(Value::as_str).and_then(tidy),
            _ => {}
        }
    }
    // A session with nothing typed into it has nothing to resume.
    let title = title.or_else(|| prompt.clone()).or(last_prompt)?;
    Some(Session {
        tool: "claude",
        dir: dir.clone(),
        prompt: prompt.filter(|p| *p != title),
        title,
        id,
        cwd,
        updated: modified_ms(path),
    })
}

fn claude_sessions(project: &str, dir: &Option<String>) -> Vec<Session> {
    let root = dir.as_ref().map(PathBuf::from).unwrap_or_else(|| home().join(".claude")).join("projects");
    let key = claude_project_key(project);
    // Subfolders and `<project>.worktrees/…` folders encode to names that start with the key.
    let mut files: Vec<(u64, PathBuf)> = Vec::new();
    for folder in fs::read_dir(&root).into_iter().flatten().flatten() {
        let name = folder.file_name().to_string_lossy().into_owned();
        if name != key && !name.starts_with(&format!("{key}-")) {
            continue;
        }
        for file in fs::read_dir(folder.path()).into_iter().flatten().flatten() {
            let path = file.path();
            if path.extension().is_some_and(|x| x == "jsonl") {
                files.push((modified_ms(&path), path));
            }
        }
    }
    files.sort_by(|a, b| b.0.cmp(&a.0));
    files.iter().filter_map(|(_, p)| claude_session(p, project, dir)).take(MAX_SESSIONS).collect()
}

/// Newest rollout files first. Folders are `sessions/YYYY/MM/DD`, so names sort by date.
/// Codex session logs, newest first by the date in their path.
pub(crate) fn codex_files(root: &Path) -> Vec<PathBuf> {
    fn sorted(dir: &Path) -> Vec<PathBuf> {
        let mut entries: Vec<PathBuf> = fs::read_dir(dir).into_iter().flatten().flatten().map(|e| e.path()).collect();
        entries.sort();
        entries.reverse();
        entries
    }
    let mut out = Vec::new();
    for year in sorted(root) {
        for month in sorted(&year) {
            for day in sorted(&month) {
                for file in sorted(&day) {
                    let name = file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                    if name.starts_with("rollout-") && name.ends_with(".jsonl") {
                        out.push(file);
                        if out.len() >= MAX_CODEX_FILES {
                            return out;
                        }
                    }
                }
            }
        }
    }
    out
}

/// Codex names threads in `session_index.jsonl`; later lines win.
fn codex_titles(home: &Path) -> HashMap<String, String> {
    let mut titles = HashMap::new();
    let Ok(text) = fs::read_to_string(home.join("session_index.jsonl")) else { return titles };
    for line in text.lines() {
        let Ok(record) = serde_json::from_str::<Value>(line) else { continue };
        if let (Some(id), Some(name)) = (record.get("id").and_then(Value::as_str), record.get("thread_name").and_then(Value::as_str).and_then(tidy)) {
            titles.insert(id.to_string(), name);
        }
    }
    titles
}

fn codex_prompt(lines: &[String]) -> Option<String> {
    lines.iter().find_map(|line| {
        if !line.contains("user_message") {
            return None;
        }
        let record = serde_json::from_str::<Value>(line).ok()?;
        let payload = record.get("payload")?;
        if payload.get("type")?.as_str()? != "user_message" {
            return None;
        }
        payload.get("message").and_then(Value::as_str).and_then(tidy)
    })
}

fn codex_sessions(project: &str, dir: &Option<String>) -> Vec<Session> {
    let home_dir = dir.as_ref().map(PathBuf::from).unwrap_or_else(|| home().join(".codex"));
    let titles = codex_titles(&home_dir);
    let mut out = Vec::new();
    for path in codex_files(&home_dir.join("sessions")) {
        let Some((head, _)) = ends(&path) else { continue };
        // The first record is the session's metadata. Its instructions can make it
        // longer than the read window, so fall back to the id in the file name.
        let meta = head.first().and_then(|l| serde_json::from_str::<Value>(l).ok());
        let cwd = meta.as_ref().and_then(|m| m.pointer("/payload/cwd")).and_then(Value::as_str).map(str::to_string);
        let Some(cwd) = cwd.or_else(|| first_cwd(&path)) else { continue };
        if !belongs(&cwd, project) {
            continue;
        }
        let id = meta
            .as_ref()
            .and_then(|m| m.pointer("/payload/id"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| id_from_name(&path));
        let Some(id) = id else { continue };
        let prompt = codex_prompt(&head);
        let Some(title) = titles.get(&id).cloned().or_else(|| prompt.clone()) else { continue };
        out.push(Session {
            tool: "codex",
            dir: dir.clone(),
            prompt: prompt.filter(|p| *p != title),
            title,
            id,
            cwd,
            updated: modified_ms(&path),
        });
        if out.len() >= MAX_SESSIONS {
            break;
        }
    }
    out
}

/// `"cwd":"…"` from the start of a long metadata line, without parsing all of it.
fn first_cwd(path: &Path) -> Option<String> {
    let mut head = Vec::new();
    fs::File::open(path).ok()?.take(WINDOW).read_to_end(&mut head).ok()?;
    let text = String::from_utf8_lossy(&head);
    let start = text.find("\"cwd\":\"")? + 7;
    let raw = &text[start..];
    let end = raw.find('"')?;
    serde_json::from_str::<String>(&format!("\"{}\"", &raw[..end])).ok()
}

/// rollout-2026-10-19T19-14-19-<uuid>.jsonl ends with the session's UUID.
fn id_from_name(path: &Path) -> Option<String> {
    let stem = path.file_stem()?.to_string_lossy().into_owned();
    let id = stem.get(stem.len().checked_sub(36)?..)?.to_string();
    (id.len() == 36 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')).then_some(id)
}

pub fn list(project: &str, claude: Vec<Option<String>>, codex: Vec<Option<String>>) -> Vec<Session> {
    let mut all: Vec<Session> = claude
        .iter()
        .flat_map(|d| claude_sessions(project, d))
        .chain(codex.iter().flat_map(|d| codex_sessions(project, d)))
        .collect();
    all.sort_by(|a, b| b.updated.cmp(&a.updated));
    all.truncate(MAX_SESSIONS * 2);
    all
}

/// What Claude Code has saved for conversation `id`: "resumable" once something
/// was typed into it, "empty" for a transcript with only startup records (hooks
/// run before the first prompt), "missing" when there is no transcript yet.
pub fn claude_state(dir: Option<String>, cwd: &str, id: &str) -> &'static str {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
        return "missing";
    }
    let root = dir.map(PathBuf::from).unwrap_or_else(|| home().join(".claude")).join("projects");
    let file = format!("{id}.jsonl");
    let direct = root.join(claude_project_key(cwd)).join(&file);
    let found = if direct.is_file() {
        Some(direct)
    } else {
        fs::read_dir(&root).into_iter().flatten().flatten().map(|e| e.path().join(&file)).find(|p| p.is_file())
    };
    let Some(path) = found else { return "missing" };
    let typed = ends(&path).is_some_and(|(head, _)| {
        head.iter().any(|line| {
            line.contains("\"user\"")
                && serde_json::from_str::<Value>(line).is_ok_and(|r| r.get("type").and_then(Value::as_str) == Some("user") && r.get("isMeta").and_then(Value::as_bool) != Some(true))
        })
    });
    if typed { "resumable" } else { "empty" }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, lines: &[String]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, lines.join("\n") + "\n").unwrap();
    }

    #[test]
    fn lists_claude_and_codex_sessions_for_a_project() {
        let base = std::env::temp_dir().join(format!("desk-sessions-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let claude = base.join("claude");
        let codex = base.join("codex");
        let project = "/p/app";
        let key = claude_project_key(project);
        let id = "11111111-2222-3333-4444-555555555555";
        let mut lines = vec![
            r#"{"type":"last-prompt","sessionId":"x"}"#.to_string(),
            format!(r#"{{"type":"user","cwd":"{project}","message":{{"role":"user","content":"<command-name>/clear</command-name>"}}}}"#),
            format!(r#"{{"type":"user","cwd":"{project}","message":{{"role":"user","content":[{{"type":"text","text":"Fix the   login\nbug"}}]}}}}"#),
        ];
        // Padding pushes the title past the head window, so it must come from the tail.
        lines.extend((0..2000).map(|i| format!(r#"{{"type":"assistant","n":{i},"pad":"{}"}}"#, "x".repeat(40))));
        lines.push(r#"{"type":"ai-title","aiTitle":"Login bug fix","sessionId":"x"}"#.into());
        write(&claude.join("projects").join(&key).join(format!("{id}.jsonl")), &lines);
        // Nothing typed: skipped. Other project with a similar name: skipped.
        write(&claude.join("projects").join(&key).join("empty.jsonl"), &[format!(r#"{{"type":"user","cwd":"{project}","isMeta":true,"message":{{"content":"hi"}}}}"#)]);
        write(&claude.join("projects").join(format!("{key}x")).join("other.jsonl"), &[r#"{"type":"user","cwd":"/p/appx","message":{"content":"nope"}}"#.into()]);
        // Sibling folder whose key starts the same way but isn't inside the project.
        write(&claude.join("projects").join(format!("{key}-web")).join("sib.jsonl"), &[r#"{"type":"user","cwd":"/p/app-web","message":{"content":"sibling"}}"#.into()]);
        // A Desk worktree of the project counts.
        write(&claude.join("projects").join(claude_project_key("/p/app.worktrees/fix")).join("wt.jsonl"), &[r#"{"type":"user","cwd":"/p/app.worktrees/fix","message":{"content":"in the worktree"}}"#.into()]);

        let cid = "019a0000-0000-7000-8000-00000000abcd";
        write(&codex.join("sessions/2026/10/19").join(format!("rollout-2026-10-19T10-00-00-{cid}.jsonl")), &[
            format!(r#"{{"type":"session_meta","payload":{{"id":"{cid}","cwd":"{project}/src"}}}}"#),
            r#"{"type":"event_msg","payload":{"type":"user_message","message":"Add tests"}}"#.into(),
        ]);
        write(&codex.join("sessions/2026/10/18").join("rollout-2026-10-18T10-00-00-019a0000-0000-7000-8000-00000000ffff.jsonl"), &[
            r#"{"type":"session_meta","payload":{"id":"019a0000-0000-7000-8000-00000000ffff","cwd":"/elsewhere"}}"#.into(),
        ]);
        write(&codex.join("session_index.jsonl"), &[format!(r#"{{"id":"{cid}","thread_name":"Test coverage","updated_at":"x"}}"#)]);

        let dir = |p: &Path| Some(p.to_string_lossy().into_owned());
        let sessions = list(project, vec![dir(&claude)], vec![dir(&codex)]);
        let titles: Vec<&str> = sessions.iter().map(|s| s.title.as_str()).collect();
        assert_eq!(sessions.len(), 3, "{titles:?}");
        let login = sessions.iter().find(|s| s.id == id).unwrap();
        assert_eq!(login.title, "Login bug fix");
        assert_eq!(login.prompt.as_deref(), Some("Fix the login bug"));
        assert!(titles.contains(&"in the worktree"));
        let c = sessions.iter().find(|s| s.tool == "codex").unwrap();
        assert_eq!((c.title.as_str(), c.prompt.as_deref(), c.cwd.as_str()), ("Test coverage", Some("Add tests"), "/p/app/src"));

        assert_eq!(claude_state(dir(&claude), project, id), "resumable");
        assert_eq!(claude_state(dir(&claude), project, "99999999-2222-3333-4444-555555555555"), "missing");
        assert_eq!(claude_state(dir(&claude), project, "../x"), "missing");
        // Opened but never typed into: only hook attachments were recorded.
        let blank = "aaaaaaaa-2222-3333-4444-555555555555";
        write(&claude.join("projects").join(&key).join(format!("{blank}.jsonl")), &[r#"{"type":"attachment","attachment":{"hookEvent":"SessionStart"}}"#.into()]);
        assert_eq!(claude_state(dir(&claude), project, blank), "empty");
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn reads_ids_from_rollout_names() {
        assert_eq!(
            id_from_name(Path::new("/x/rollout-2026-10-19T19-14-19-01a156a8-b694-76b1-afcc-bbc9d1093295.jsonl")).as_deref(),
            Some("01a156a8-b694-76b1-afcc-bbc9d1093295")
        );
        assert!(belongs("/p/app.worktrees/x", "/p/app") && !belongs("/p/apple", "/p/app"));
    }
}
