//! Sandboxes: Desk runs agents on a machine you own elsewhere (a Docker container,
//! a Boat VM, a Render or Modal sandbox) through that provider's own CLI.
//!
//! Desk has no server. Every provider command is an argv for a CLI you installed,
//! run through your login shell like the agents are. Long-lived streams (following
//! an agent's output, writing to it) use `chat_spawn`; this module adds one-shot
//! commands that return their output, the scripts Desk uploads into a sandbox, and
//! owner-only storage for agent tokens you choose to paste.
//!
//! Tokens never go into argv, `state.json` or a log: `run` appends them to the
//! command's stdin as `NAME=value` lines, which the runner writes to a 0600 file.

use std::io::{Read, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use base64::Engine;
use serde::{Deserialize, Serialize};

/// The runner Desk uploads into every sandbox (see the file for what it does).
pub const RUNNER: &str = include_str!("../resources/desk-run.sh");
/// The image Desk builds for Docker sandboxes on first use.
pub const DOCKERFILE: &str = include_str!("../resources/Dockerfile.sandbox");
/// Modal has no sandbox commands in its CLI; this helper uses its Python SDK.
pub const MODAL_HELPER: &str = include_str!("../resources/desk_modal.py");

const OUTPUT_LIMIT: usize = 64 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretEnv {
    /// Variable name in the sandbox, e.g. CLAUDE_CODE_OAUTH_TOKEN.
    pub name: String,
    /// Which saved token to use.
    pub key: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunOpts {
    pub args: Vec<String>,
    /// Text for stdin.
    #[serde(default)]
    pub stdin: Option<String>,
    /// Bytes for stdin, base64 (a git bundle going up).
    #[serde(default)]
    pub stdin_base64: Option<String>,
    /// Saved tokens to append to stdin as NAME=value lines.
    #[serde(default)]
    pub secrets: Vec<SecretEnv>,
    #[serde(default)]
    pub timeout_secs: Option<u64>,
}

#[derive(Debug, Serialize)]
pub struct RunOutput {
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

fn valid_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_') && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Runs one provider command through the login shell and returns what it printed.
pub fn run(opts: RunOpts) -> Result<RunOutput, String> {
    if opts.args.is_empty() {
        return Err("nothing to run".into());
    }
    let mut input: Vec<u8> = Vec::new();
    if let Some(b64) = &opts.stdin_base64 {
        input = base64::engine::general_purpose::STANDARD.decode(b64).map_err(|e| e.to_string())?;
    }
    if let Some(text) = &opts.stdin {
        input.extend_from_slice(text.as_bytes());
    }
    for secret in &opts.secrets {
        if !valid_name(&secret.name) {
            return Err(format!("invalid variable name: {}", secret.name));
        }
        let value = secret_get(&secret.key)?;
        if value.contains('\n') {
            return Err("A saved token can't contain a line break.".into());
        }
        if !input.is_empty() && !input.ends_with(b"\n") {
            input.push(b'\n');
        }
        input.extend_from_slice(format!("{}={}\n", secret.name, value).as_bytes());
    }

    let shell = crate::pty::user_shell();
    let mut cmd = Command::new(&shell);
    cmd.arg("-l").arg("-i").arg("-c").arg("exec \"$@\"").arg("desk").args(&opts.args);
    cmd.current_dir(dirs::home_dir().unwrap_or_else(|| PathBuf::from("/")));
    cmd.env("NO_COLOR", "1").env("TERM", "dumb");
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = cmd.spawn().map_err(|e| format!("couldn't start {shell}: {e}"))?;
    let mut stdin = child.stdin.take().ok_or("no stdin")?;
    let writer = std::thread::spawn(move || {
        let _ = stdin.write_all(&input);
    });
    let mut out = child.stdout.take().ok_or("no stdout")?;
    let mut err = child.stderr.take().ok_or("no stderr")?;
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = out.by_ref().take(OUTPUT_LIMIT as u64).read_to_end(&mut buf);
        buf
    });
    let errors = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = err.by_ref().take(1024 * 1024).read_to_end(&mut buf);
        buf
    });
    let deadline = Instant::now() + Duration::from_secs(opts.timeout_secs.unwrap_or(120));
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            break Some(status);
        }
        if Instant::now() > deadline {
            // The whole group: the provider CLI and anything it started.
            unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL) };
            let _ = child.wait();
            break None;
        }
        std::thread::sleep(Duration::from_millis(25));
    };
    let _ = writer.join();
    let stdout = String::from_utf8_lossy(&reader.join().unwrap_or_default()).into_owned();
    let mut stderr = String::from_utf8_lossy(&errors.join().unwrap_or_default()).into_owned();
    if status.is_none() {
        stderr.push_str("\nDesk stopped waiting for this command.");
    }
    Ok(RunOutput { code: status.and_then(|s| s.code()), stdout, stderr })
}

// Tokens you paste for a sandbox

fn check_key(key: &str) -> Result<(), String> {
    let ok = !key.is_empty() && key.len() <= 80 && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok { Ok(()) } else { Err(format!("invalid token name: {key}")) }
}

fn secrets_dir() -> Result<PathBuf, String> {
    let dir = dirs::data_dir().ok_or("no Application Support folder")?.join(crate::variant::app_dir()).join("sandbox-tokens");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn secret_path(key: &str) -> Result<PathBuf, String> {
    check_key(key)?;
    Ok(secrets_dir()?.join(key))
}

pub fn secret_set(key: &str, value: &str) -> Result<(), String> {
    let value = value.trim();
    if value.is_empty() {
        return Err("The token is empty.".into());
    }
    if value.contains('\n') {
        return Err("A token can't contain a line break.".into());
    }
    let path = secret_path(key)?;
    let tmp = path.with_extension("tmp");
    let mut file = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&tmp).map_err(|e| e.to_string())?;
    file.write_all(value.as_bytes()).map_err(|e| e.to_string())?;
    drop(file);
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

fn secret_get(key: &str) -> Result<String, String> {
    std::fs::read_to_string(secret_path(key)?).map(|s| s.trim().to_string()).map_err(|_| format!("No saved token named {key}."))
}

pub fn secret_has(key: &str) -> bool {
    secret_path(key).is_ok_and(|p| p.is_file())
}

pub fn secret_delete(key: &str) -> Result<(), String> {
    match std::fs::remove_file(secret_path(key)?) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

/// Writes a bundled helper (the Modal one) into Desk's support folder and returns
/// its path. Rewritten every time, so an old copy never lingers.
pub fn helper_path(name: &str) -> Result<PathBuf, String> {
    let body = match name {
        "desk_modal.py" => MODAL_HELPER,
        _ => return Err(format!("no helper named {name}")),
    };
    let dir = dirs::data_dir().ok_or("no Application Support folder")?.join(crate::variant::app_dir()).join("helpers");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(name);
    write_private(&dir.join(format!(".{name}.tmp")), body)?;
    std::fs::rename(dir.join(format!(".{name}.tmp")), &path).map_err(|e| e.to_string())?;
    Ok(path)
}

fn write_private(path: &Path, body: &str) -> Result<(), String> {
    let mut file = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(path).map_err(|e| e.to_string())?;
    file.write_all(body.as_bytes()).map_err(|e| e.to_string())
}

pub fn resource(name: &str) -> Result<&'static str, String> {
    match name {
        "desk-run" => Ok(RUNNER),
        "Dockerfile" => Ok(DOCKERFILE),
        _ => Err(format!("no resource named {name}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn variable_names() {
        assert!(valid_name("CLAUDE_CODE_OAUTH_TOKEN"));
        assert!(valid_name("_X1"));
        assert!(!valid_name("1X"));
        assert!(!valid_name("A=B"));
        assert!(!valid_name("A B"));
        assert!(!valid_name(""));
    }

    #[test]
    fn token_names() {
        assert!(check_key("claude-work_1").is_ok());
        assert!(check_key("../x").is_err());
        assert!(check_key("a/b").is_err());
        assert!(check_key("").is_err());
    }

    #[test]
    fn runner_is_bundled() {
        assert!(RUNNER.starts_with("#!/bin/sh"));
        assert!(RUNNER.contains("cmd_tail"));
    }

    #[test]
    fn runs_a_command_with_stdin() {
        let out = run(RunOpts { args: vec!["cat".into()], stdin: Some("hello\n".into()), stdin_base64: None, secrets: vec![], timeout_secs: Some(20) }).unwrap();
        assert_eq!(out.code, Some(0));
        assert!(out.stdout.ends_with("hello\n"), "{:?}", out.stdout);
    }

    #[test]
    fn stops_waiting_after_the_timeout() {
        let out = run(RunOpts { args: vec!["sleep".into(), "30".into()], stdin: None, stdin_base64: None, secrets: vec![], timeout_secs: Some(1) }).unwrap();
        assert_eq!(out.code, None);
        assert!(out.stderr.contains("stopped waiting"));
    }
}
