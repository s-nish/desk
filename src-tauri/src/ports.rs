//! Port forwarding from sandboxes: a server an agent starts in a sandbox shows up
//! on this Mac at http://localhost:<port>.
//!
//! Desk listens on 127.0.0.1 (and ::1 when it can) and, for each connection,
//! runs the provider's own exec command with a tiny relay inside the sandbox that
//! connects to the server there; bytes pass through that command's stdin and
//! stdout. Nothing is exposed publicly, and the provider's sign-in is the only
//! thing that reaches the sandbox, as with every other command Desk runs.

use std::collections::HashMap;
use std::io::{ErrorKind, Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Connections open at once per forward; each runs a provider command.
const MAX_RELAYS: usize = 32;

struct Forward {
    port: u16,
    args: Vec<String>,
    stop: Arc<AtomicBool>,
    /// Process groups of the relays running now, so stopping ends them too.
    relays: Arc<Mutex<Vec<u32>>>,
}

#[derive(Default)]
pub struct PortState(Mutex<HashMap<String, Forward>>);

/// The login shell's PATH, so provider CLIs installed by Homebrew or pipx are found.
fn login_path() -> String {
    let shell = crate::pty::user_shell();
    Command::new(&shell)
        .args(["-l", "-i", "-c", "printf '\\n__DESK_PATH__%s' \"$PATH\""])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()
        .and_then(|o| {
            let text = String::from_utf8_lossy(&o.stdout).into_owned();
            text.rsplit_once("__DESK_PATH__").map(|(_, p)| p.trim().to_string())
        })
        .filter(|p| !p.is_empty())
        .unwrap_or_else(|| std::env::var("PATH").unwrap_or_default())
}

/// Binds 127.0.0.1:port, and [::1]:port too unless something else has it (a
/// browser asking for "localhost" may try ::1 first).
fn bind(port: u16) -> Option<Vec<TcpListener>> {
    let v4 = TcpListener::bind(("127.0.0.1", port)).ok()?;
    let port = v4.local_addr().ok()?.port();
    let mut all = vec![v4];
    match TcpListener::bind(("::1", port)) {
        Ok(v6) => all.push(v6),
        Err(e) if e.kind() == ErrorKind::AddrInUse => return None,
        Err(_) => {} // No IPv6 here.
    }
    Some(all)
}

/// The first free port of `candidates` (Desk decides which local ports a forward
/// may take), else one the system picks, from its high range no service uses.
pub fn pick(candidates: &[u16]) -> Result<(u16, Vec<TcpListener>), String> {
    for &port in candidates.iter().filter(|p| **p >= 1024) {
        if let Some(all) = bind(port) {
            return Ok((port, all));
        }
    }
    for _ in 0..5 {
        if let Some(all) = bind(0) {
            let port = all[0].local_addr().map_err(|e| e.to_string())?.port();
            return Ok((port, all));
        }
    }
    Err("no free port on this Mac".into())
}

fn relay(mut client: TcpStream, args: &[String], path: &str, relays: &Mutex<Vec<u32>>) {
    let _ = client.set_nonblocking(false);
    let _ = client.set_nodelay(true);
    let mut cmd = Command::new(&args[0]);
    cmd.args(&args[1..])
        .env("PATH", path)
        .env("NO_COLOR", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .current_dir(dirs::home_dir().unwrap_or_else(|| "/".into()));
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let Ok(mut child) = cmd.spawn() else { return };
    let pid = child.id();
    relays.lock().unwrap().push(pid);
    let end = |child: &mut std::process::Child| {
        unsafe { libc::kill(-(pid as i32), libc::SIGTERM) };
        let _ = child.wait();
        relays.lock().unwrap().retain(|p| *p != pid);
    };
    let (Some(mut stdin), Some(mut stdout), Ok(mut upstream)) = (child.stdin.take(), child.stdout.take(), client.try_clone()) else {
        end(&mut child);
        return;
    };
    let up = std::thread::spawn(move || {
        let mut buf = [0u8; 32 * 1024];
        loop {
            match upstream.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if stdin.write_all(&buf[..n]).and_then(|_| stdin.flush()).is_err() {
                        break;
                    }
                }
            }
        }
        // stdin drops here: the relay sees the end, and the server the half-close.
    });
    let mut buf = [0u8; 32 * 1024];
    loop {
        match stdout.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if client.write_all(&buf[..n]).is_err() {
                    break;
                }
            }
        }
    }
    let _ = client.shutdown(Shutdown::Both);
    end(&mut child);
    let _ = up.join();
}

/// A connection's place under MAX_RELAYS, given back however the relay ends.
struct Slot(Arc<AtomicUsize>);
impl Drop for Slot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Forwards localhost:<the first free of `candidates`> to the sandbox through `args` (an exec
/// argv whose stdin and stdout are a connection to the server there). Returns the
/// local port. Starting the same key again with the same command keeps the forward.
pub fn start(state: &PortState, key: &str, args: Vec<String>, candidates: &[u16]) -> Result<u16, String> {
    if args.is_empty() {
        return Err("nothing to run".into());
    }
    {
        let mut all = state.0.lock().unwrap();
        if let Some(f) = all.get(key) {
            if f.args == args {
                return Ok(f.port);
            }
        }
        if let Some(old) = all.remove(key) {
            end(old);
        }
    }
    let (port, listeners) = pick(candidates)?;
    let stop = Arc::new(AtomicBool::new(false));
    let relays = Arc::new(Mutex::new(Vec::new()));
    let active = Arc::new(AtomicUsize::new(0));
    let path = Arc::new(login_path());
    let shared = Arc::new(args.clone());
    for listener in listeners {
        listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        let (stop, relays, path, args, active) = (stop.clone(), relays.clone(), path.clone(), shared.clone(), active.clone());
        std::thread::spawn(move || {
            while !stop.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((client, _)) => {
                        // Taken before the relay starts, so a burst can't get past the limit.
                        if active.fetch_add(1, Ordering::SeqCst) >= MAX_RELAYS {
                            active.fetch_sub(1, Ordering::SeqCst);
                            drop(client);
                            continue;
                        }
                        let slot = Slot(active.clone());
                        let (relays, path, args) = (relays.clone(), path.clone(), args.clone());
                        std::thread::spawn(move || {
                            let _slot = slot;
                            relay(client, &args, &path, &relays);
                        });
                    }
                    Err(e) if e.kind() == ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(40)),
                    Err(_) => std::thread::sleep(Duration::from_millis(200)),
                }
            }
        });
    }
    state.0.lock().unwrap().insert(key.to_string(), Forward { port, args, stop, relays });
    Ok(port)
}

fn end(f: Forward) {
    f.stop.store(true, Ordering::SeqCst);
    for pid in f.relays.lock().unwrap().drain(..) {
        unsafe { libc::kill(-(pid as i32), libc::SIGTERM) };
    }
}

pub fn stop(state: &PortState, key: &str) {
    if let Some(f) = state.0.lock().unwrap().remove(key) {
        end(f);
    }
}

pub fn stop_all(state: &PortState) {
    for (_, f) in state.0.lock().unwrap().drain() {
        end(f);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A stand-in for a provider: `sh -c "nc ..."` isn't everywhere, so the relay
    /// is a small Python one connecting to a local echo server.
    #[test]
    fn forwards_bytes_both_ways() {
        let server = TcpListener::bind("127.0.0.1:0").unwrap();
        let target = server.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for conn in server.incoming() {
                let mut conn = conn.unwrap();
                std::thread::spawn(move || {
                    let mut buf = [0u8; 1024];
                    while let Ok(n) = conn.read(&mut buf) {
                        if n == 0 { break; }
                        let reply: Vec<u8> = buf[..n].iter().map(|b| b.to_ascii_uppercase()).collect();
                        if conn.write_all(&reply).is_err() { break; }
                    }
                });
            }
        });
        let script = format!(
            "import socket,sys,threading\ns=socket.create_connection(('localhost',{target}))\n\
             def up():\n  while True:\n    d=sys.stdin.buffer.read1(65536)\n    if not d: break\n    s.sendall(d)\n  s.shutdown(socket.SHUT_WR)\n\
             threading.Thread(target=up,daemon=True).start()\n\
             while True:\n  d=s.recv(65536)\n  if not d: break\n  sys.stdout.buffer.write(d); sys.stdout.buffer.flush()\n"
        );
        let state = PortState::default();
        let args = vec!["python3".to_string(), "-c".to_string(), script];
        let port = start(&state, "t", args.clone(), &[]).unwrap();
        assert_eq!(start(&state, "t", args, &[]).unwrap(), port, "same key and command keep the forward");
        for word in ["hello", "binary\u{0}\u{ff}"] {
            let mut c = TcpStream::connect(("127.0.0.1", port)).unwrap();
            c.set_read_timeout(Some(Duration::from_secs(20))).unwrap();
            c.write_all(word.as_bytes()).unwrap();
            c.shutdown(Shutdown::Write).unwrap();
            let mut got = Vec::new();
            c.read_to_end(&mut got).unwrap();
            assert_eq!(got, word.as_bytes().to_ascii_uppercase());
        }
        stop(&state, "t");
        std::thread::sleep(Duration::from_millis(150));
        assert!(TcpStream::connect(("127.0.0.1", port)).is_err(), "stopped forwards stop listening");
    }

    /// Against a real sandbox: DESK_TEST_RELAY_ARGS is a JSON argv (a provider's
    /// exec with the relay script) to a server answering GET / with
    /// DESK_TEST_RELAY_EXPECT (hex) as its body.
    /// `cargo test --lib ports::tests::through_a_real_sandbox -- --ignored`
    #[test]
    #[ignore]
    fn through_a_real_sandbox() {
        let args: Vec<String> = serde_json::from_str(&std::env::var("DESK_TEST_RELAY_ARGS").unwrap()).unwrap();
        let expect = std::env::var("DESK_TEST_RELAY_EXPECT").unwrap();
        let state = PortState::default();
        let port = start(&state, "real", args, &[5173, 5174, 5175]).unwrap();
        for _ in 0..3 {
            let mut c = TcpStream::connect(("127.0.0.1", port)).unwrap();
            c.set_read_timeout(Some(Duration::from_secs(30))).unwrap();
            c.write_all(b"GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n").unwrap();
            let mut got = Vec::new();
            c.read_to_end(&mut got).unwrap();
            let at = got.windows(4).position(|w| w == b"\r\n\r\n").expect("an HTTP response") + 4;
            let body: String = got[at..].iter().map(|b| format!("{b:02x}")).collect();
            assert_eq!(body, expect);
        }
        stop(&state, "real");
    }

    #[test]
    fn picks_the_next_free_port() {
        let (port, held) = pick(&[]).unwrap();
        let (next, _held2) = pick(&[port, port + 1]).unwrap();
        assert_ne!(next, port, "a taken one is skipped");
        let (low, _held3) = pick(&[80, 443]).unwrap();
        assert!(low >= 1024, "never below 1024");
        drop(held);
    }
}
