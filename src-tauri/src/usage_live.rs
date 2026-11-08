//! Live usage limits, asked of each provider the way Claude Code's /usage and
//! Codex's /status do, so the numbers move even when no agent is running.
//!
//! Sign-ins are only read: Claude Code's token from the macOS Keychain (or its
//! `.credentials.json`), Codex's from `auth.json`. Nothing is stored or written,
//! tokens are never refreshed (that would sign the CLI out), and they go to the
//! provider over the system `curl`, on stdin so they never show in `ps`.
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;

use crate::limits::{Limits, Window};

/// Keychain items Desk was refused (or that don't exist), so macOS doesn't ask again this run.
static REFUSED: Mutex<Option<HashSet<String>>> = Mutex::new(None);
/// The last live answer per account, merged into what the logs say.
static LIVE: Mutex<Option<HashMap<String, Limits>>> = Mutex::new(None);

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_default()
}

fn key(tool: &str, dir: &Option<String>) -> String {
    format!("{tool}:{}", dir.as_deref().unwrap_or(""))
}

// Keychain

#[cfg(target_os = "macos")]
mod keychain {
    use std::process::{Command, Stdio};

    pub enum Read {
        Found(Vec<u8>),
        /// No such item: try the next place.
        Missing,
        /// Refused or cancelled at the prompt: don't ask again.
        Refused,
    }

    /// Reads a generic password by service name through Apple's `security` tool.
    /// Desk's own signature changes with every build (and Claude Code rewrites the
    /// item when it refreshes its token), so an "Always Allow" given to Desk would
    /// not stick. `security` is Apple-signed with a fixed identity and is what
    /// Claude Code writes the item with, so it is normally trusted already, and an
    /// "Always Allow" given to it lasts. The secret comes back on a pipe, never
    /// in arguments.
    pub fn read(service: &str) -> Read {
        let out = Command::new("/usr/bin/security")
            .args(["find-generic-password", "-s", service, "-w"])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output();
        match out {
            Ok(o) if o.status.success() => {
                let mut bytes = o.stdout;
                while bytes.last().is_some_and(|b| *b == b'\n' || *b == b'\r') {
                    bytes.pop();
                }
                Read::Found(bytes)
            }
            Ok(o) if o.status.code() == Some(44) => Read::Missing, // errSecItemNotFound
            _ => Read::Refused,
        }
    }
}

/// Claude Code names its Keychain item after the config folder it was started with.
fn claude_service(dir: &Option<String>) -> String {
    use sha2::{Digest, Sha256};
    match dir {
        None => "Claude Code-credentials".into(),
        Some(d) => {
            let hash = Sha256::digest(d.as_bytes());
            let hex: String = hash.iter().take(4).map(|b| format!("{b:02x}")).collect();
            format!("Claude Code-credentials-{hex}")
        }
    }
}

/// The account's OAuth access token, if it's there and not expired.
fn claude_token(dir: &Option<String>) -> Result<String, String> {
    let folder = dir.as_ref().map(PathBuf::from).unwrap_or_else(|| home().join(".claude"));
    let mut raw = fs::read(folder.join(".credentials.json")).ok();
    #[cfg(target_os = "macos")]
    if raw.is_none() {
        let service = claude_service(dir);
        let refused = REFUSED.lock().unwrap().get_or_insert_with(HashSet::new).contains(&service);
        if !refused {
            match keychain::read(&service) {
                keychain::Read::Found(bytes) => raw = Some(bytes),
                keychain::Read::Missing | keychain::Read::Refused => {
                    REFUSED.lock().unwrap().get_or_insert_with(HashSet::new).insert(service);
                }
            }
        }
    }
    let value: Value = serde_json::from_slice(&raw.ok_or("No Claude sign-in found for this account.")?).map_err(|e| e.to_string())?;
    let oauth = value.get("claudeAiOauth").ok_or("This account doesn't use a Claude subscription.")?;
    if oauth.get("expiresAt").and_then(Value::as_u64).is_some_and(|at| at <= now_ms()) {
        return Err("The sign-in token has expired; it renews the next time Claude Code runs.".into());
    }
    oauth.get("accessToken").and_then(Value::as_str).map(str::to_string).ok_or_else(|| "No access token.".into())
}

// HTTP through the system curl

fn quote(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

/// GET `url` with these headers; the config (with the token) goes in on stdin.
fn get(url: &str, headers: &[(&str, &str)]) -> Result<Value, String> {
    let mut config = format!("url = {}\n", quote(url));
    for (k, v) in headers {
        config.push_str(&format!("header = {}\n", quote(&format!("{k}: {v}"))));
    }
    let mut child = Command::new("/usr/bin/curl")
        .args(["-sS", "--max-time", "12", "-w", "\n%{http_code}", "-K", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Couldn't run curl: {e}"))?;
    child.stdin.take().ok_or("curl has no stdin")?.write_all(config.as_bytes()).map_err(|e| e.to_string())?;
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout);
    let (body, code) = text.rsplit_once('\n').unwrap_or(("", "0"));
    match code.trim() {
        "200" => serde_json::from_str(body).map_err(|e| e.to_string()),
        "401" | "403" => Err("The provider didn't accept the sign-in token.".into()),
        "000" | "0" => Err(String::from_utf8_lossy(&out.stderr).trim().to_string()),
        other => Err(format!("The usage request failed (HTTP {other}).")),
    }
}

/// `2025-11-05T18:00:00.123+00:00` or `…Z` as ms since the epoch.
fn iso_ms(s: &str) -> Option<u64> {
    let (date, rest) = s.split_once('T')?;
    let mut d = date.split('-').map(|p| p.parse::<i64>());
    let (y, m, day) = (d.next()?.ok()?, d.next()?.ok()?, d.next()?.ok()?);
    let time_end = rest.find(|c: char| c == 'Z' || c == '+' || (c == '-')).unwrap_or(rest.len());
    let (time, zone) = rest.split_at(time_end);
    let mut t = time.split(':');
    let (h, min) = (t.next()?.parse::<i64>().ok()?, t.next()?.parse::<i64>().ok()?);
    let sec: f64 = t.next().unwrap_or("0").parse().ok()?;
    let offset = match zone {
        "" | "Z" => 0,
        z => {
            let sign = if z.starts_with('-') { -1 } else { 1 };
            let mut p = z[1..].split(':');
            sign * (p.next()?.parse::<i64>().ok()? * 3600 + p.next().unwrap_or("0").parse::<i64>().ok()? * 60)
        }
    };
    // Days from 1970-01-01 (Howard Hinnant's days_from_civil).
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + day - 1;
    let days = era * 146097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719468;
    let secs = days * 86400 + h * 3600 + min * 60 - offset;
    (secs >= 0).then(|| (secs as f64 * 1000.0 + sec * 1000.0) as u64)
}

fn claude_window(v: Option<&Value>, minutes: u64) -> Option<Window> {
    let v = v.filter(|v| v.is_object())?;
    let used = v.get("utilization")?.as_f64()?;
    Some(Window { used: used.clamp(0.0, 100.0), resets_at: v.get("resets_at").and_then(Value::as_str).and_then(iso_ms), minutes })
}

fn claude_live(dir: &Option<String>) -> Result<Limits, String> {
    let token = claude_token(dir)?;
    let v = get("https://api.anthropic.com/api/oauth/usage", &[("Authorization", &format!("Bearer {token}")), ("anthropic-beta", "oauth-2025-04-20"), ("Accept", "application/json")])?;
    Ok(Limits { tool: "claude", dir: dir.clone(), session: claude_window(v.get("five_hour"), 300), weekly: claude_window(v.get("seven_day"), 10080), plan: None, updated: now_ms() })
}

fn codex_window(v: Option<&Value>, now: u64) -> Option<Window> {
    let v = v.filter(|v| v.is_object())?;
    let used = v.get("used_percent")?.as_f64()?;
    let seconds = v.get("limit_window_seconds").and_then(Value::as_u64).unwrap_or(0);
    let resets_at = v.get("reset_at").and_then(Value::as_u64).map(|s| if s < 1_000_000_000_000 { s * 1000 } else { s })
        .or_else(|| v.get("reset_after_seconds").and_then(Value::as_u64).map(|s| now + s * 1000));
    Some(Window { used: used.clamp(0.0, 100.0), resets_at, minutes: seconds / 60 })
}

fn codex_live(dir: &Option<String>) -> Result<Limits, String> {
    let folder = dir.as_ref().map(PathBuf::from).unwrap_or_else(|| home().join(".codex"));
    let auth: Value = serde_json::from_str(&fs::read_to_string(folder.join("auth.json")).map_err(|_| "No Codex sign-in found for this account.")?).map_err(|e| e.to_string())?;
    let tokens = auth.get("tokens").ok_or("This account uses an API key, which has no plan limits.")?;
    let token = tokens.get("access_token").and_then(Value::as_str).ok_or("No access token.")?;
    let mut headers = vec![("Authorization".to_string(), format!("Bearer {token}"))];
    if let Some(id) = tokens.get("account_id").and_then(Value::as_str) {
        headers.push(("ChatGPT-Account-Id".into(), id.into()));
    }
    let refs: Vec<(&str, &str)> = headers.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
    let v = get("https://chatgpt.com/backend-api/wham/usage", &refs)?;
    let now = now_ms();
    let rate = v.get("rate_limit").unwrap_or(&Value::Null);
    let windows = [codex_window(rate.get("primary_window"), now), codex_window(rate.get("secondary_window"), now)];
    // The short window is the session one; the other is weekly, whichever order they come in.
    let (mut session, mut weekly) = (None, None);
    for w in windows.into_iter().flatten() {
        if w.minutes > 0 && w.minutes <= 24 * 60 { session = Some(w) } else { weekly = Some(w) }
    }
    if session.is_none() && weekly.is_none() {
        return Err("The usage answer had no limits in it.".into());
    }
    Ok(Limits { tool: "codex", dir: dir.clone(), session, weekly, plan: v.get("plan_type").and_then(Value::as_str).map(str::to_string), updated: now })
}

/// Asks every account's provider at once. Accounts that fail keep what the logs say.
pub fn refresh(claude: Vec<Option<String>>, codex: Vec<Option<String>>) -> Vec<String> {
    let jobs: Vec<_> = claude.into_iter().map(|d| ("claude", d)).chain(codex.into_iter().map(|d| ("codex", d))).collect();
    let handles: Vec<_> = jobs
        .into_iter()
        .map(|(tool, dir)| std::thread::spawn(move || (key(tool, &dir), if tool == "claude" { claude_live(&dir) } else { codex_live(&dir) })))
        .collect();
    let mut errors = Vec::new();
    for h in handles {
        let Ok((k, result)) = h.join() else { continue };
        match result {
            Ok(limits) => { LIVE.lock().unwrap().get_or_insert_with(HashMap::new).insert(k, limits); }
            Err(e) => errors.push(format!("{k}: {e}")),
        }
    }
    errors
}

/// Puts the newest of what the logs say and what the provider last said, per account.
pub fn merge(mut list: Vec<Limits>) -> Vec<Limits> {
    let live = LIVE.lock().unwrap();
    let Some(live) = live.as_ref() else { return list };
    for (k, l) in live {
        match list.iter_mut().find(|x| key(x.tool, &x.dir) == *k) {
            Some(x) if x.updated >= l.updated => {}
            Some(x) => *x = l.clone(),
            None => list.push(l.clone()),
        }
    }
    list
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_iso_times() {
        assert_eq!(iso_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(iso_ms("2025-11-05T18:00:00+00:00"), Some(1_762_365_600_000));
        assert_eq!(iso_ms("2025-11-05T19:30:00.500+01:30"), Some(1_762_365_600_500));
    }
    #[test]
    fn names_claude_keychain_items() {
        assert_eq!(claude_service(&None), "Claude Code-credentials");
        assert!(claude_service(&Some("/Users/a/.claude-work".into())).starts_with("Claude Code-credentials-"));
        assert_eq!(claude_service(&Some("/x".into())).len(), "Claude Code-credentials-".len() + 8);
    }
    #[test]
    fn sorts_codex_windows_by_length() {
        let v: Value = serde_json::from_str(r#"{"used_percent": 12.5, "limit_window_seconds": 18000, "reset_after_seconds": 60}"#).unwrap();
        let w = codex_window(Some(&v), 1000).unwrap();
        assert_eq!((w.minutes, w.resets_at), (300, Some(61_000)));
    }
}
