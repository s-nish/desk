//! Local bridge: lets other apps on this Mac (same user only) type into a Desk
//! terminal, addressed by its tty. Speaky uses it to deliver dictated prompts to a
//! Claude Code or Codex session running in Desk.
//!
//! Unix socket at ~/.desk/bridge.sock (0600, in a 0700 folder), one JSON request
//! per connection:
//!   {"cmd":"ping"}                            -> {"ok":true,"app":"desk"}
//!   {"cmd":"sessions"}                        -> {"ok":true,"ttys":["/dev/ttys012"]}
//!   {"cmd":"write","tty":"…","data":"…"}      -> {"ok":true} | {"ok":false,"error":"…"}

use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::Arc;
use std::thread;

use serde_json::{Value, json};

use crate::pty::PtyManager;

pub fn socket_path() -> Option<PathBuf> {
    let dir = match std::env::var_os("DESK_HOME") {
        Some(d) => PathBuf::from(d),
        None => dirs::home_dir()?.join(".desk"),
    };
    Some(dir.join("bridge.sock"))
}

pub fn start(manager: Arc<PtyManager>) {
    let Some(path) = socket_path() else { return };
    let Some(dir) = path.parent() else { return };
    if std::fs::create_dir_all(dir).is_err() {
        return;
    }
    let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
    // A live socket means another Desk owns the bridge; leave it alone.
    if UnixStream::connect(&path).is_ok() {
        return;
    }
    let _ = std::fs::remove_file(&path);
    let Ok(listener) = UnixListener::bind(&path) else { return };
    let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    let _ = thread::Builder::new().name("desk-bridge".into()).spawn(move || {
        for conn in listener.incoming().flatten() {
            let manager = Arc::clone(&manager);
            let _ = thread::Builder::new().name("desk-bridge-conn".into()).spawn(move || {
                let _ = handle(conn, &manager);
            });
        }
    });
}

fn handle(conn: UnixStream, manager: &PtyManager) -> std::io::Result<()> {
    let mut line = String::new();
    BufReader::new(&conn).read_line(&mut line)?;
    let reply = respond(&line, manager);
    let mut out = &conn;
    writeln!(out, "{reply}")
}

fn respond(line: &str, manager: &PtyManager) -> Value {
    let msg: Value = serde_json::from_str(line).unwrap_or(Value::Null);
    let s = |k: &str| msg.get(k).and_then(Value::as_str).unwrap_or("");
    match s("cmd") {
        "ping" => json!({"ok": true, "app": "desk"}),
        "sessions" => json!({"ok": true, "ttys": manager.ttys()}),
        "write" => match manager.write_tty(s("tty"), s("data").as_bytes()) {
            Ok(()) => json!({"ok": true}),
            Err(e) => json!({"ok": false, "error": e}),
        },
        _ => json!({"ok": false, "error": "unknown command"}),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_tty_and_commands_are_errors() {
        let m = PtyManager::default();
        assert_eq!(respond(r#"{"cmd":"ping"}"#, &m)["ok"], true);
        assert_eq!(respond(r#"{"cmd":"sessions"}"#, &m)["ttys"], json!([]));
        assert_eq!(respond(r#"{"cmd":"write","tty":"/dev/nope","data":"x"}"#, &m)["ok"], false);
        assert_eq!(respond("not json", &m)["ok"], false);
    }
}
