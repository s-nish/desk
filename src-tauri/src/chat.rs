//! Chat mode: Claude Code and Codex run as plain child processes that speak JSON
//! lines, and the conversation is drawn by the interface instead of a terminal.
//! The CLIs keep their own sign-in and session files, exactly as in a terminal tab,
//! so a chat resumes in the CLI and the other way round.
//!
//! Each process starts through the user's login shell so it finds `claude` and
//! `codex` on the same PATH a terminal would. Every stdout line is handed to the
//! interface as it arrives; when the process ends, one last `desk_exit` line says
//! how, with the end of stderr for errors.

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use serde::Deserialize;
use serde_json::{json, Value};

use crate::accounts::claude_project_key;

/// How much of the end of a transcript is shown when a chat opens.
const HISTORY_TAIL: u64 = 6 * 1024 * 1024;
/// Longer strings in old records (tool output, file contents) are cut to this.
const MAX_TEXT: usize = 6000;
const STDERR_KEPT: usize = 4000;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatOpts {
    pub cwd: String,
    /// The program and its arguments, e.g. `["claude", "-p", …]`.
    pub args: Vec<String>,
    /// Variables for this process only (the account's config folder).
    #[serde(default)]
    pub env: HashMap<String, String>,
    /// Variables removed for this process (a default account's folder variable).
    #[serde(default)]
    pub unset: Vec<String>,
    /// Keep stdin open for messages (Claude); otherwise it is closed at once (Codex).
    #[serde(default)]
    pub stdin: bool,
}

struct Running {
    child: Child,
    stdin: Option<ChildStdin>,
}

#[derive(Default)]
pub struct ChatManager {
    next: AtomicU32,
    running: Mutex<HashMap<u32, Running>>,
}

/// Variables a parent Claude Code or Codex sets that would confuse a child one.
fn scrubbed(key: &str) -> bool {
    key.starts_with("CLAUDECODE") || key.starts_with("CLAUDE_") || key.starts_with("CODEX_")
}

impl ChatManager {
    pub fn spawn<F>(self: &Arc<Self>, mut opts: ChatOpts, on_line: F) -> Result<u32, String>
    where
        F: Fn(String) + Send + Sync + 'static,
    {
        if opts.args.is_empty() {
            return Err("nothing to run".into());
        }
        // Saved tokens (MCP servers' keys) go in the environment, not on the command line.
        let secrets = crate::sandbox::take_secrets(&mut opts.env);
        let shell = crate::pty::user_shell();
        // `env` applies the account after rc files run, so they can't override it.
        // Arguments go through "$@", so nothing is quoted or parsed by the shell.
        let mut cmd = Command::new(&shell);
        // A folder to put first on PATH (desk-sandbox) goes on after rc files set PATH.
        let prepend = opts.env.remove("DESK_PATH_PREPEND");
        cmd.arg("-l").arg("-i").arg("-c").arg("[ -n \"${DESK_PATH_PREPEND:-}\" ] && PATH=\"$DESK_PATH_PREPEND:$PATH\" && export PATH; exec env \"$@\"").arg("desk");
        for key in &opts.unset {
            cmd.arg("-u").arg(key);
        }
        for (key, value) in &opts.env {
            cmd.arg(format!("{key}={value}"));
        }
        cmd.args(&opts.args);
        let cwd = Path::new(&opts.cwd);
        cmd.current_dir(if cwd.is_dir() { cwd.to_path_buf() } else { dirs::home_dir().unwrap_or_else(|| PathBuf::from("/")) });
        for (key, _) in std::env::vars_os() {
            if key.to_str().is_some_and(scrubbed) {
                cmd.env_remove(key);
            }
        }
        cmd.env("NO_COLOR", "1").env("TERM", "dumb").env("SHELL", &shell);
        if let Some(dir) = &prepend {
            cmd.env("DESK_PATH_PREPEND", dir);
        }
        for (key, value) in &secrets {
            cmd.env(key, value);
        }
        cmd.stdin(if opts.stdin { Stdio::piped() } else { Stdio::null() }).stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            // Its own process group, so stopping it also stops the tools it started.
            cmd.process_group(0);
        }
        let mut child = cmd.spawn().map_err(|e| format!("couldn't start {shell}: {e}"))?;
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let stdout = child.stdout.take().ok_or("no stdout")?;
        let stderr = child.stderr.take().ok_or("no stderr")?;
        let stdin = child.stdin.take();
        self.running.lock().unwrap().insert(id, Running { child, stdin });

        let errors = Arc::new(Mutex::new(String::new()));
        let kept = Arc::clone(&errors);
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                let mut text = kept.lock().unwrap();
                text.push_str(&line);
                text.push('\n');
                if text.len() > STDERR_KEPT * 2 {
                    let cut = text.len() - STDERR_KEPT;
                    let cut = (cut..text.len()).find(|&i| text.is_char_boundary(i)).unwrap_or(0);
                    text.drain(..cut);
                }
            }
        });
        let manager = Arc::clone(self);
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                // Shell start-up files can print; only JSON records are passed on.
                if line.trim_start().starts_with('{') {
                    on_line(line);
                }
            }
            let child = manager.running.lock().unwrap().remove(&id);
            let code = child.and_then(|mut r| r.child.wait().ok()).and_then(|s| s.code());
            let stderr = errors.lock().unwrap().clone();
            on_line(json!({ "type": "desk_exit", "code": code, "stderr": stderr }).to_string());
        });
        Ok(id)
    }

    /// Sends one JSON line to a process's stdin.
    pub fn write(&self, id: u32, line: &str) -> Result<(), String> {
        let mut running = self.running.lock().unwrap();
        let stdin = running.get_mut(&id).and_then(|r| r.stdin.as_mut()).ok_or("this chat has stopped")?;
        stdin.write_all(line.trim_end().as_bytes()).and_then(|_| stdin.write_all(b"\n")).and_then(|_| stdin.flush()).map_err(|e| e.to_string())
    }

    /// Stops a process and everything it started. Session files are already written
    /// line by line, so nothing is lost.
    pub fn kill(&self, id: u32) {
        if let Some(mut r) = self.running.lock().unwrap().remove(&id) {
            drop(r.stdin.take());
            stop(&mut r.child);
            // Reaped once it exits, so nothing is left behind as a zombie.
            std::thread::spawn(move || {
                let _ = r.child.wait();
            });
        }
    }

    pub fn kill_all(&self) {
        for (_, mut r) in self.running.lock().unwrap().drain() {
            drop(r.stdin.take());
            stop(&mut r.child);
        }
    }
}

fn stop(child: &mut Child) {
    #[cfg(unix)]
    unsafe {
        libc::kill(-(child.id() as i32), libc::SIGTERM);
    }
    #[cfg(not(unix))]
    let _ = child.kill();
    std::thread::spawn({
        let pid = child.id();
        move || {
            std::thread::sleep(std::time::Duration::from_secs(3));
            #[cfg(unix)]
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
            #[cfg(not(unix))]
            let _ = pid;
        }
    });
}

fn shorten(value: &mut Value) {
    match value {
        Value::String(s) if s.len() > MAX_TEXT => {
            let end = (0..=MAX_TEXT).rev().find(|&i| s.is_char_boundary(i)).unwrap_or(0);
            s.truncate(end);
            s.push_str("\n…");
        }
        Value::Array(items) => items.iter_mut().for_each(shorten),
        Value::Object(map) => map.values_mut().for_each(shorten),
        _ => {}
    }
}

/// The complete lines in the last `HISTORY_TAIL` bytes, and whether earlier ones were left out.
fn tail_lines(path: &Path) -> Option<(Vec<String>, bool)> {
    let mut file = fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let cut = len > HISTORY_TAIL;
    if cut {
        file.seek(SeekFrom::Start(len - HISTORY_TAIL)).ok()?;
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).ok()?;
    let text = String::from_utf8_lossy(&bytes);
    let lines = text.lines().skip(usize::from(cut)).map(str::to_string).collect();
    Some((lines, cut))
}

fn claude_file(dir: &Option<String>, cwd: &str, id: &str) -> Option<PathBuf> {
    let root = dir.as_ref().map(PathBuf::from).or_else(|| dirs::home_dir().map(|h| h.join(".claude")))?.join("projects");
    let file = format!("{id}.jsonl");
    let direct = root.join(claude_project_key(cwd)).join(&file);
    if direct.is_file() {
        return Some(direct);
    }
    fs::read_dir(&root).ok()?.flatten().map(|e| e.path().join(&file)).find(|p| p.is_file())
}

fn codex_file(dir: &Option<String>, id: &str) -> Option<PathBuf> {
    let home = dir.as_ref().map(PathBuf::from).or_else(|| dirs::home_dir().map(|h| h.join(".codex")))?;
    crate::sessions::codex_files(&home.join("sessions")).into_iter().find(|p| p.file_name().is_some_and(|n| n.to_string_lossy().contains(id)))
}

/// Records of a past conversation that the chat view draws, oldest first, with long
/// text shortened. Read only. Claude: the main thread's user and assistant records.
/// Codex: the events for messages and the tools it ran.
pub fn history(tool: &str, dir: Option<String>, cwd: &str, id: &str) -> Value {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return json!({ "records": [], "truncated": false });
    }
    let path = if tool == "claude" { claude_file(&dir, cwd, id) } else { codex_file(&dir, id) };
    let Some((lines, truncated)) = path.as_deref().and_then(tail_lines) else {
        return json!({ "records": [], "truncated": false });
    };
    let mut records = Vec::new();
    for line in lines {
        let keep = if tool == "claude" {
            (line.contains("\"type\":\"user\"") || line.contains("\"type\":\"assistant\"")) && !line.contains("\"isSidechain\":true")
        } else {
            line.contains("\"type\":\"event_msg\"")
                && ["\"user_message\"", "\"agent_message\"", "\"item_completed\"", "\"exec_command_end\""].iter().any(|t| line.contains(t))
        };
        if !keep {
            continue;
        }
        let Ok(mut record) = serde_json::from_str::<Value>(&line) else { continue };
        if let Value::Object(map) = &mut record {
            // Claude repeats each tool's full result here; the message already has it.
            map.remove("toolUseResult");
        }
        shorten(&mut record);
        records.push(record);
    }
    json!({ "records": records, "truncated": truncated })
}

/// Models Codex offers in its picker, from the catalog it caches in the account
/// folder. Read only; empty when Codex hasn't fetched one yet.
pub fn codex_models(dir: Option<String>) -> Value {
    let Some(home) = dir.map(PathBuf::from).or_else(|| dirs::home_dir().map(|h| h.join(".codex"))) else { return json!([]) };
    let Ok(text) = fs::read_to_string(home.join("models_cache.json")) else { return json!([]) };
    let Ok(cache) = serde_json::from_str::<Value>(&text) else { return json!([]) };
    let mut models: Vec<&Value> = cache["models"].as_array().map(|m| m.iter().filter(|m| m["visibility"] == "list").collect()).unwrap_or_default();
    models.sort_by_key(|m| m["priority"].as_i64().unwrap_or(99));
    let out: Vec<Value> = models
        .iter()
        .map(|m| {
            json!({
                "id": m["slug"],
                "label": m["display_name"],
                "description": m["description"],
                "efforts": m["supported_reasoning_levels"].as_array().map(|l| l.iter().map(|e| e["effort"].clone()).collect::<Vec<_>>()).unwrap_or_default(),
                "defaultEffort": m["default_reasoning_level"],
            })
        })
        .collect();
    json!(out)
}

/// Largest image sent to an agent; Claude rejects bigger ones.
const MAX_IMAGE_BYTES: u64 = 5 * 1024 * 1024;

/// Desk's own folder for pasted images, so Codex (which takes file paths) can read them.
fn attachment_dir() -> PathBuf {
    dirs::cache_dir().unwrap_or_else(std::env::temp_dir).join(crate::variant::cache_dir()).join("attachments")
}

/// Saves a pasted image and returns its path. Old pastes are cleared after a week.
pub fn save_attachment(name: &str, data: &str) -> Result<String, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD.decode(data).map_err(|e| e.to_string())?;
    let dir = attachment_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    if let Ok(entries) = fs::read_dir(&dir) {
        let week = std::time::Duration::from_secs(7 * 24 * 3600);
        for entry in entries.flatten() {
            let old = entry.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|age| age > week);
            if old {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
    let safe: String = name.chars().map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '-' }).collect();
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let path = dir.join(format!("{stamp}-{safe}"));
    fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// The media type of an image Claude accepts, from the file name.
pub fn image_type(path: &str) -> Option<&'static str> {
    let ext = Path::new(path).extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => return None,
    })
}

/// An image file as `{mediaType, data}` (base64), for Claude's image content blocks.
pub fn read_image(path: &str) -> Result<Value, String> {
    use base64::Engine;
    let media = image_type(path).ok_or("Not a PNG, JPEG, GIF or WebP image.")?;
    let size = fs::metadata(path).map_err(|e| e.to_string())?.len();
    if size > MAX_IMAGE_BYTES {
        return Err(format!("{} is over 5 MB.", Path::new(path).file_name().unwrap_or_default().to_string_lossy()));
    }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    Ok(json!({ "mediaType": media, "data": base64::engine::general_purpose::STANDARD.encode(bytes) }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shortens_long_text_on_a_char_boundary() {
        let mut v = json!({ "a": ["é".repeat(MAX_TEXT)] });
        shorten(&mut v);
        let s = v["a"][0].as_str().unwrap();
        assert!(s.len() <= MAX_TEXT + 4 && s.ends_with('…'));
    }

    #[test]
    fn reads_claude_history_from_the_main_thread() {
        let base = std::env::temp_dir().join(format!("desk-chat-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let id = "11111111-2222-3333-4444-555555555555";
        let folder = base.join("projects").join(claude_project_key("/p/app"));
        fs::create_dir_all(&folder).unwrap();
        fs::write(
            folder.join(format!("{id}.jsonl")),
            [
                r#"{"type":"file-history-snapshot"}"#,
                r#"{"type":"user","message":{"content":"hi"},"toolUseResult":{"big":1}}"#,
                r#"{"type":"assistant","isSidechain":true,"message":{"content":[]}}"#,
                r#"{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}"#,
            ]
            .join("\n"),
        )
        .unwrap();
        let h = history("claude", Some(base.to_string_lossy().into_owned()), "/p/app", id);
        let records = h["records"].as_array().unwrap();
        assert_eq!(records.len(), 2);
        assert!(records[0].get("toolUseResult").is_none());
        assert_eq!(history("claude", None, "/p/app", "../etc")["records"].as_array().unwrap().len(), 0);
        fs::remove_dir_all(base).unwrap();
    }
}
