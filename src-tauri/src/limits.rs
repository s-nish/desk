//! Usage limits per account: how much of the 5-hour and weekly allowance is used.
//!
//! Codex writes its limits into every session log, so they are read from there.
//! Claude Code only hands them to its status line command. Claude tabs in Desk run
//! with `--settings` pointing at a small status line wrapper that saves them in
//! Desk's own folder and then runs the account's status line as before.
//! Nothing in the account folders is ever written.

use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use serde_json::{json, Value};

use crate::accounts::claude_project_key;
use crate::sessions::codex_files;

/// Newest Codex session logs checked for limits.
const CODEX_FILES: usize = 12;
/// How much of the end of each log is read.
const TAIL: u64 = 256 * 1024;

const WRAPPER: &str = r#"#!/bin/sh
# Written by Desk. Saves the usage limits Claude Code reports to its status line,
# then runs your own status line command so it looks the same as before.
input=$(cat)
if [ -n "$DESK_LIMITS_FILE" ]; then
  case "$input" in
    *'"rate_limits"'*)
      tmp="$DESK_LIMITS_FILE.$$"
      printf '%s' "$input" > "$tmp" 2>/dev/null && mv -f "$tmp" "$DESK_LIMITS_FILE" 2>/dev/null
      ;;
  esac
fi
if [ -n "$DESK_STATUSLINE" ]; then
  printf '%s' "$input" | /bin/sh -c "$DESK_STATUSLINE"
fi
exit 0
"#;

/// Windows: saves the limits and prints nothing. Used only for accounts without
/// a status line of their own, so nothing the user set up is replaced.
const WRAPPER_PS1: &str = r#"# Written by Desk. Saves the usage limits Claude Code reports to its status line.
$data = [Console]::In.ReadToEnd()
if ($env:DESK_LIMITS_FILE -and $data.Contains('"rate_limits"')) {
  $tmp = "$env:DESK_LIMITS_FILE.$PID"
  [IO.File]::WriteAllText($tmp, $data)
  Move-Item -Force -LiteralPath $tmp -Destination $env:DESK_LIMITS_FILE
}
"#;

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Window {
    /// Percent of the allowance used, 0 to 100.
    pub used: f64,
    /// When the window starts over, in ms since the epoch.
    pub resets_at: Option<u64>,
    pub minutes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Limits {
    pub tool: &'static str,
    /// The account folder as the caller passed it (None for the tool's default).
    pub dir: Option<String>,
    /// The short window (5 hours).
    pub session: Option<Window>,
    pub weekly: Option<Window>,
    pub plan: Option<String>,
    /// When these numbers were reported, in ms since the epoch.
    pub updated: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeHook {
    /// File passed to `claude --settings`.
    pub settings: String,
    pub env: std::collections::HashMap<String, String>,
}

fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"))
}

fn limits_dir() -> PathBuf {
    dirs::data_dir().unwrap_or_else(|| PathBuf::from(".")).join("Desk").join("limits")
}

fn claude_dir(dir: &Option<String>) -> PathBuf {
    dir.as_ref().map(PathBuf::from).unwrap_or_else(|| home().join(".claude"))
}

fn modified_ms(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Seconds or milliseconds since the epoch, as a number or a string of digits.
fn epoch_ms(value: &Value) -> Option<u64> {
    let n = match value {
        Value::Number(n) => n.as_f64()?,
        Value::String(s) => s.trim().parse::<f64>().ok()?,
        _ => return None,
    };
    if n <= 0.0 {
        return None;
    }
    Some(if n < 1e12 { (n * 1000.0) as u64 } else { n as u64 })
}

fn window(value: &Value, used_key: &str, default_minutes: u64) -> Option<Window> {
    let used = value.get(used_key)?.as_f64()?;
    Some(Window {
        used: used.clamp(0.0, 100.0),
        resets_at: value.get("resets_at").and_then(epoch_ms),
        minutes: value.get("window_minutes").and_then(Value::as_u64).unwrap_or(default_minutes),
    })
}

/// Where the status line wrapper saves what Claude Code reported for `dir`.
fn claude_file(dir: &Option<String>) -> PathBuf {
    let key = claude_project_key(&claude_dir(dir).to_string_lossy());
    limits_dir().join(format!("claude{key}.json"))
}

fn parse_claude(text: &str) -> Option<(Option<Window>, Option<Window>)> {
    let value: Value = serde_json::from_str(text).ok()?;
    let limits = value.get("rate_limits")?;
    let session = limits.get("five_hour").and_then(|w| window(w, "used_percentage", 300));
    let weekly = limits.get("seven_day").and_then(|w| window(w, "used_percentage", 10080));
    (session.is_some() || weekly.is_some()).then_some((session, weekly))
}

fn claude_limits(dir: Option<String>) -> Option<Limits> {
    let path = claude_file(&dir);
    let (session, weekly) = parse_claude(&fs::read_to_string(&path).ok()?)?;
    Some(Limits { tool: "claude", updated: modified_ms(&path), dir, session, weekly, plan: None })
}

fn tail(path: &Path) -> Option<String> {
    let mut file = fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    if len > TAIL {
        file.seek(SeekFrom::Start(len - TAIL)).ok()?;
    }
    let mut bytes = Vec::new();
    file.take(TAIL).read_to_end(&mut bytes).ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

/// The last limits a Codex log recorded.
fn parse_codex(text: &str) -> Option<(Option<Window>, Option<Window>, Option<String>)> {
    for line in text.lines().rev() {
        if !line.contains("\"rate_limits\"") {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(line) else { continue };
        let Some(limits) = value.pointer("/payload/rate_limits").filter(|v| v.is_object()) else { continue };
        let session = limits.get("primary").and_then(|w| window(w, "used_percent", 300));
        let weekly = limits.get("secondary").and_then(|w| window(w, "used_percent", 10080));
        if session.is_none() && weekly.is_none() {
            continue;
        }
        let plan = limits.get("plan_type").and_then(Value::as_str).map(str::to_string);
        return Some((session, weekly, plan));
    }
    None
}

fn codex_limits(dir: Option<String>) -> Option<Limits> {
    let home_dir = dir.as_ref().map(PathBuf::from).unwrap_or_else(|| home().join(".codex"));
    // Named by start time; a long session started earlier can still be the latest to write.
    let mut files: Vec<(u64, PathBuf)> = codex_files(&home_dir.join("sessions"))
        .into_iter()
        .take(CODEX_FILES)
        .map(|p| (modified_ms(&p), p))
        .collect();
    files.sort_by(|a, b| b.0.cmp(&a.0));
    files.into_iter().find_map(|(updated, path)| {
        let (session, weekly, plan) = parse_codex(&tail(&path)?)?;
        Some(Limits { tool: "codex", dir: dir.clone(), session, weekly, plan, updated })
    })
}

pub fn list(claude: Vec<Option<String>>, codex: Vec<Option<String>>) -> Vec<Limits> {
    claude
        .into_iter()
        .filter_map(claude_limits)
        .chain(codex.into_iter().filter_map(codex_limits))
        .collect()
}

/// The status line Claude Code would use in `cwd` for this account, read only.
fn own_status_line(dir: &Option<String>, cwd: &str) -> Option<Value> {
    let cwd = Path::new(cwd);
    [
        cwd.join(".claude").join("settings.local.json"),
        cwd.join(".claude").join("settings.json"),
        claude_dir(dir).join("settings.json"),
    ]
    .iter()
    .find_map(|path| {
        let value: Value = serde_json::from_str(&fs::read_to_string(path).ok()?).ok()?;
        value.get("statusLine").filter(|v| v.is_object()).cloned()
    })
}

fn write_if_changed(path: &Path, content: &str) -> Result<(), String> {
    if fs::read_to_string(path).ok().as_deref() == Some(content) {
        return Ok(());
    }
    let tmp = path.with_extension("desk-tmp");
    fs::write(&tmp, content).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// Sets up the status line wrapper for a Claude tab about to start in `cwd`.
pub fn claude_hook(dir: Option<String>, cwd: &str) -> Result<ClaudeHook, String> {
    let base = limits_dir();
    fs::create_dir_all(&base).map_err(|e| e.to_string())?;
    let own = own_status_line(&dir, cwd);
    // A Windows status line may be written for Git Bash, cmd or PowerShell, so
    // Desk can't safely run it from a wrapper. It's left alone, without limits.
    if cfg!(windows) && own.is_some() {
        return Err("This Claude account has its own status line, which Desk leaves as it is.".into());
    }
    let command = if cfg!(windows) {
        let path = base.join("statusline.ps1");
        write_if_changed(&path, WRAPPER_PS1)?;
        format!("powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"{}\"", crate::platform::slash(&path))
    } else {
        let path = base.join("statusline.sh");
        write_if_changed(&path, WRAPPER)?;
        format!("/bin/sh '{}'", path.to_string_lossy().replace('\'', r"'\''"))
    };

    let own_command = own
        .as_ref()
        .filter(|s| s.get("type").and_then(Value::as_str).unwrap_or("command") == "command")
        .and_then(|s| s.get("command"))
        .and_then(Value::as_str)
        .map(str::to_string);
    // Keeps the account's own options (padding and the like).
    let mut status_line = own.unwrap_or_else(|| json!({ "padding": 0 }));
    status_line["type"] = json!("command");
    status_line["command"] = json!(command);

    let key = claude_project_key(&claude_dir(&dir).to_string_lossy());
    let settings = base.join(format!("claude{key}.settings.json"));
    write_if_changed(&settings, &serde_json::to_string_pretty(&json!({ "statusLine": status_line })).unwrap_or_default())?;

    let mut env = std::collections::HashMap::new();
    env.insert("DESK_LIMITS_FILE".to_string(), claude_file(&dir).to_string_lossy().into_owned());
    if let Some(command) = own_command {
        env.insert("DESK_STATUSLINE".to_string(), command);
    }
    Ok(ClaudeHook { settings: crate::platform::slash(&settings), env })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_claude_status_input() {
        let text = r#"{"model":{"id":"x"},"rate_limits":{"five_hour":{"used_percentage":42.5,"resets_at":1792541893},"seven_day":{"used_percentage":16,"resets_at":"1793109338"}}}"#;
        let (session, weekly) = parse_claude(text).unwrap();
        assert_eq!(session, Some(Window { used: 42.5, resets_at: Some(1_792_541_893_000), minutes: 300 }));
        assert_eq!(weekly.unwrap().resets_at, Some(1_793_109_338_000));
        assert!(parse_claude(r#"{"model":{"id":"x"}}"#).is_none());
        assert!(parse_claude(r#"{"rate_limits":{}}"#).is_none());
    }

    #[test]
    fn parses_last_codex_limits() {
        let older = r#"{"type":"event_msg","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":10.0,"window_minutes":300,"resets_at":1792541893},"secondary":null,"plan_type":"plus"}}}"#;
        let newer = r#"{"type":"event_msg","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":99.0,"window_minutes":300,"resets_at":1792541893},"secondary":{"used_percent":16.0,"window_minutes":10080,"resets_at":1793109338},"plan_type":"plus"}}}"#;
        let empty = r#"{"type":"event_msg","payload":{"type":"token_count","rate_limits":null}}"#;
        let text = format!("{older}\n{newer}\n{empty}\n{{\"partial");
        let (session, weekly, plan) = parse_codex(&text).unwrap();
        assert_eq!(session.unwrap().used, 99.0);
        assert_eq!(weekly.unwrap().minutes, 10080);
        assert_eq!(plan.as_deref(), Some("plus"));
        assert!(parse_codex("{\"type\":\"session_meta\"}").is_none());
    }

    #[test]
    fn finds_own_status_line_in_project_first() {
        let root = std::env::temp_dir().join(format!("desk-limits-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let account = root.join("account");
        let project = root.join("project");
        fs::create_dir_all(&account).unwrap();
        fs::create_dir_all(project.join(".claude")).unwrap();
        fs::write(account.join("settings.json"), r#"{"statusLine":{"type":"command","command":"echo account","padding":2}}"#).unwrap();
        let dir = Some(account.to_string_lossy().into_owned());
        let cwd = project.to_string_lossy().into_owned();
        assert_eq!(own_status_line(&dir, &cwd).unwrap()["command"], "echo account");
        fs::write(project.join(".claude/settings.json"), r#"{"statusLine":{"type":"command","command":"echo project"}}"#).unwrap();
        assert_eq!(own_status_line(&dir, &cwd).unwrap()["command"], "echo project");
        fs::remove_dir_all(&root).unwrap();
    }
}
