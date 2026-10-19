//! Pseudo-terminal sessions. Each session runs the user's login shell (optionally
//! launching a command such as `claude` first) and streams output back in batches.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::Deserialize;

/// Minimum gap between two output flushes. Keeps full-screen TUIs from
/// flooding the IPC bridge while leaving keystroke echo instant when idle.
const FLUSH_INTERVAL: Duration = Duration::from_millis(8);
const MAX_BATCH: usize = 512 * 1024;

/// Inherited variables with these prefixes are dropped. If Desk was launched from
/// inside a Claude Code or Codex session, they carry that session's identity
/// (e.g. CLAUDE_CODE_CHILD_SESSION turns off transcript saving in a fresh
/// `claude`). Anything the user sets on purpose comes back from their rc files,
/// and the account variables are applied afterwards.
const SCRUBBED_PREFIXES: &[&str] = &["CLAUDECODE", "CLAUDE_", "CODEX_"];
const SCRUBBED_ENV: &[&str] = &["TERM_PROGRAM_VERSION"];

fn is_scrubbed(key: &str) -> bool {
    SCRUBBED_ENV.contains(&key) || SCRUBBED_PREFIXES.iter().any(|p| key.starts_with(p))
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnOpts {
    pub cwd: String,
    /// Command run inside the login shell before dropping to an interactive prompt.
    pub command: Option<String>,
    /// Variables set for this session (account config dirs).
    #[serde(default)]
    pub env: HashMap<String, String>,
    /// Variables removed from this session (accounts that use the default dir).
    #[serde(default)]
    pub unset: Vec<String>,
    pub cols: u16,
    pub rows: u16,
}

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

#[derive(Default)]
pub struct PtyManager {
    next_id: AtomicU32,
    sessions: Mutex<HashMap<u32, Session>>,
}

pub fn user_shell() -> String {
    std::env::var("SHELL")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "/bin/zsh".into())
}

fn single_quote(s: &str) -> Result<String, String> {
    if s.contains('\'') {
        return Err(format!("value contains a single quote: {s}"));
    }
    Ok(format!("'{s}'"))
}

/// Builds the `-c` script for command tabs. Account variables are applied with
/// `env` after the user's rc files run, so an rc file can't silently override them.
pub fn command_script(opts: &SpawnOpts, command: &str) -> Result<String, String> {
    let mut parts = vec!["env".to_string()];
    for key in &opts.unset {
        parts.push(format!("-u {key}"));
    }
    let mut keys: Vec<_> = opts.env.keys().collect();
    keys.sort();
    for key in keys {
        parts.push(format!("{key}={}", single_quote(&opts.env[key])?));
    }
    parts.push(command.to_string());
    Ok(format!("{}; exec \"$SHELL\" -l -i", parts.join(" ")))
}

pub fn build_command(opts: &SpawnOpts) -> Result<CommandBuilder, String> {
    let shell = user_shell();
    let mut cmd = CommandBuilder::new(&shell);
    cmd.arg("-l");
    cmd.arg("-i");
    if let Some(command) = opts.command.as_deref().filter(|c| !c.trim().is_empty()) {
        cmd.arg("-c");
        cmd.arg(command_script(opts, command)?);
    }

    let cwd = std::path::Path::new(&opts.cwd);
    if cwd.is_dir() {
        cmd.cwd(cwd);
    } else if let Some(home) = dirs::home_dir() {
        cmd.cwd(home);
    }

    let inherited = std::env::vars_os()
        .filter_map(|(k, _)| k.into_string().ok())
        .filter(|k| is_scrubbed(k));
    for key in inherited.chain(opts.unset.iter().cloned()) {
        cmd.env_remove(key);
    }
    for (key, value) in &opts.env {
        cmd.env(key, value);
    }
    cmd.env("SHELL", &shell);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "Desk");
    if std::env::var("LANG").map(|v| v.is_empty()).unwrap_or(true) {
        cmd.env("LANG", "en_US.UTF-8");
    }
    Ok(cmd)
}

impl PtyManager {
    /// Starts a session. `on_data` receives batched output; `on_exit` fires once
    /// with the exit code after the output stream has drained.
    pub fn spawn<D, E>(
        self: &Arc<Self>,
        opts: SpawnOpts,
        on_data: D,
        on_exit: E,
    ) -> Result<u32, String>
    where
        D: Fn(Vec<u8>) + Send + 'static,
        E: FnOnce(u32, Option<u32>) + Send + 'static,
    {
        let pty = native_pty_system()
            .openpty(PtySize {
                rows: opts.rows.max(2),
                cols: opts.cols.max(2),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;
        let mut child = pty
            .slave
            .spawn_command(build_command(&opts)?)
            .map_err(|e| e.to_string())?;
        drop(pty.slave);

        let mut reader = pty.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pty.master.take_writer().map_err(|e| e.to_string())?;
        let killer = child.clone_killer();

        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        self.sessions.lock().unwrap().insert(
            id,
            Session {
                master: pty.master,
                writer,
                killer,
            },
        );

        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        thread::Builder::new()
            .name(format!("pty-read-{id}"))
            .spawn(move || {
                let mut buf = vec![0u8; 64 * 1024];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            if tx.send(buf[..n].to_vec()).is_err() {
                                break;
                            }
                        }
                    }
                }
            })
            .map_err(|e| e.to_string())?;

        let manager = Arc::clone(self);
        thread::Builder::new()
            .name(format!("pty-flush-{id}"))
            .spawn(move || {
                let mut last_flush = Instant::now() - FLUSH_INTERVAL;
                'outer: while let Ok(first) = rx.recv() {
                    let mut batch = first;
                    let mut closed = false;
                    while let Ok(more) = rx.try_recv() {
                        batch.extend_from_slice(&more);
                    }
                    // Busy stream: hold the batch until the interval elapses.
                    let due = last_flush + FLUSH_INTERVAL;
                    while batch.len() < MAX_BATCH {
                        let now = Instant::now();
                        if now >= due {
                            break;
                        }
                        match rx.recv_timeout(due - now) {
                            Ok(more) => batch.extend_from_slice(&more),
                            Err(RecvTimeoutError::Timeout) => break,
                            Err(RecvTimeoutError::Disconnected) => {
                                closed = true;
                                break;
                            }
                        }
                    }
                    on_data(batch);
                    last_flush = Instant::now();
                    if closed {
                        break 'outer;
                    }
                }
                let code = child.wait().ok().map(|s| s.exit_code());
                manager.sessions.lock().unwrap().remove(&id);
                on_exit(id, code);
            })
            .map_err(|e| e.to_string())?;

        Ok(id)
    }

    pub fn write(&self, id: u32, data: &[u8]) -> Result<(), String> {
        let mut sessions = self.sessions.lock().unwrap();
        let session = sessions.get_mut(&id).ok_or("terminal session not found")?;
        session.writer.write_all(data).map_err(|e| e.to_string())?;
        session.writer.flush().map_err(|e| e.to_string())
    }

    pub fn resize(&self, id: u32, cols: u16, rows: u16) -> Result<(), String> {
        let sessions = self.sessions.lock().unwrap();
        let session = sessions.get(&id).ok_or("terminal session not found")?;
        session
            .master
            .resize(PtySize {
                rows: rows.max(2),
                cols: cols.max(2),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())
    }

    pub fn kill(&self, id: u32) {
        if let Some(session) = self.sessions.lock().unwrap().remove(&id) {
            hang_up(session);
        }
    }

    pub fn kill_all(&self) {
        for (_, session) in self.sessions.lock().unwrap().drain() {
            hang_up(session);
        }
    }
}

/// Ends a session the way closing a Terminal window does: SIGHUP to the
/// foreground job (e.g. `claude`) and to the shell, never SIGKILL, so tools get
/// to flush their session files and exit on their own.
fn hang_up(mut session: Session) {
    if let Some(pgid) = session.master.process_group_leader().filter(|p| *p > 0) {
        unsafe { libc::kill(-pgid, libc::SIGHUP) };
    }
    let _ = session.killer.kill();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(opts: SpawnOpts) -> String {
        let manager = Arc::new(PtyManager::default());
        let out = Arc::new(Mutex::new(Vec::new()));
        let (done_tx, done_rx) = mpsc::channel();
        let sink = Arc::clone(&out);
        manager
            .spawn(
                opts,
                move |b| sink.lock().unwrap().extend(b),
                move |_, _| done_tx.send(()).unwrap(),
            )
            .unwrap();
        done_rx
            .recv_timeout(Duration::from_secs(20))
            .expect("session did not exit");
        String::from_utf8_lossy(&out.lock().unwrap()).into_owned()
    }

    fn opts(command: &str) -> SpawnOpts {
        SpawnOpts {
            cwd: "/tmp".into(),
            // `exit` stops the trailing interactive shell so the test ends.
            command: Some(format!("{command}; exit")),
            env: HashMap::new(),
            unset: vec![],
            cols: 80,
            rows: 24,
        }
    }

    #[test]
    fn sets_account_dir_for_command() {
        let mut o = opts("printf 'dir=[%s]\\n' \"$CLAUDE_CONFIG_DIR\"");
        o.env
            .insert("CLAUDE_CONFIG_DIR".into(), "/tmp/desk-test-work".into());
        assert!(run(o).contains("dir=[/tmp/desk-test-work]"));
    }

    #[test]
    fn unsets_default_account_dir() {
        // Simulate a parent environment that already points somewhere else.
        unsafe { std::env::set_var("CODEX_HOME", "/tmp/should-not-leak") };
        let mut o = opts("printf 'home=[%s]\\n' \"$CODEX_HOME\"");
        o.unset.push("CODEX_HOME".into());
        assert!(run(o).contains("home=[]"));
    }

    #[test]
    fn drops_parent_session_markers() {
        unsafe { std::env::set_var("CLAUDE_CODE_CHILD_SESSION", "1") };
        let mut o = opts(
            "printf 'child=[%s] dir=[%s]\\n' \"$CLAUDE_CODE_CHILD_SESSION\" \"$CLAUDE_CONFIG_DIR\"",
        );
        o.env
            .insert("CLAUDE_CONFIG_DIR".into(), "/tmp/desk-test-work".into());
        assert!(run(o).contains("child=[] dir=[/tmp/desk-test-work]"));
    }

    #[test]
    fn closing_a_session_stops_its_foreground_program() {
        let manager = Arc::new(PtyManager::default());
        let (done_tx, done_rx) = mpsc::channel();
        let mut o = opts("sleep 7331");
        o.command = Some("sleep 7331".into());
        let id = manager
            .spawn(o, |_| {}, move |_, _| done_tx.send(()).unwrap())
            .unwrap();
        thread::sleep(Duration::from_millis(1500));
        manager.kill(id);
        done_rx
            .recv_timeout(Duration::from_secs(10))
            .expect("session did not end");
        let stray = std::process::Command::new("pgrep")
            .args(["-f", "sleep 7331"])
            .output()
            .unwrap();
        assert!(stray.stdout.is_empty(), "foreground program survived");
    }

    #[test]
    fn script_quotes_values() {
        let mut o = opts("claude");
        o.env.insert("CODEX_HOME".into(), "/a b".into());
        o.unset.push("CLAUDE_CONFIG_DIR".into());
        let script = command_script(&o, "claude").unwrap();
        assert_eq!(
            script,
            "env -u CLAUDE_CONFIG_DIR CODEX_HOME='/a b' claude; exec \"$SHELL\" -l -i"
        );
        o.env.insert("X".into(), "it's".into());
        assert!(command_script(&o, "claude").is_err());
    }
}
