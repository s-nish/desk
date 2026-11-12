//! Phone remote: the notch's feed on your phone, over your tailnet.
//!
//! Desk listens on 127.0.0.1 only. `tailscale serve` (which you turn on from
//! Settings) publishes that port to your own devices with a real certificate,
//! and adds a `Tailscale-User-Login` header to every request it forwards. Nothing
//! is ever bound to a public interface.
//!
//! A request is served only if it carries a paired device's cookie *and* the
//! Tailscale login that paired it. Pairing is a one-time code (a QR in Settings)
//! that lasts ten minutes; Desk keeps only a SHA-256 of each device's token.
//!
//! The phone can allow (once), deny, reply, stop and mark seen. Nothing else:
//! no modes, accounts or settings. Every action goes to a log you can read.

use std::io::{Read, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, Runtime};

pub const PORT: u16 = 47821;
const COOKIE: &str = "desk_remote";
const PAIR_SECS: u64 = 600;
const LOGIN_HEADER: &str = "Tailscale-User-Login";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    /// SHA-256 of the cookie, hex.
    pub hash: String,
    /// Tailscale login that paired it; every request must come from it.
    pub login: String,
    pub name: String,
    pub added: u64,
    #[serde(default)]
    pub last_seen: u64,
}

#[derive(Default)]
pub struct RemoteState {
    running: AtomicBool,
    stop: Mutex<Option<Arc<tiny_http::Server>>>,
    /// The one-time pairing code and when it expires.
    pairing: Mutex<Option<(String, u64)>>,
    /// Open event streams.
    streams: Mutex<Vec<Sender<String>>>,
    /// Latest feed, sent to each stream when it opens.
    feed: Mutex<Value>,
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn random_hex(bytes: usize) -> Result<String, String> {
    let mut buf = vec![0u8; bytes];
    std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut buf)).map_err(|e| e.to_string())?;
    Ok(buf.iter().map(|b| format!("{b:02x}")).collect())
}

fn sha(text: &str) -> String {
    Sha256::digest(text.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

fn dir() -> Result<PathBuf, String> {
    let dir = dirs::data_dir().ok_or("no Application Support folder")?.join(crate::variant::app_dir()).join("remote");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    Ok(dir)
}

pub fn devices() -> Vec<Device> {
    dir().ok().and_then(|d| std::fs::read_to_string(d.join("devices.json")).ok()).and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

fn save_devices(list: &[Device]) -> Result<(), String> {
    let d = dir()?;
    let tmp = d.join(".devices.tmp");
    let mut f = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&tmp).map_err(|e| e.to_string())?;
    f.write_all(serde_json::to_string_pretty(list).map_err(|e| e.to_string())?.as_bytes()).map_err(|e| e.to_string())?;
    std::fs::rename(tmp, d.join("devices.json")).map_err(|e| e.to_string())
}

pub fn revoke(hash: &str) -> Result<(), String> {
    let list: Vec<Device> = devices().into_iter().filter(|d| d.hash != hash).collect();
    save_devices(&list)
}

/// Appends one line to the action log.
fn log(line: &str) {
    if let Ok(d) = dir() {
        if let Ok(mut f) = std::fs::OpenOptions::new().append(true).create(true).mode(0o600).open(d.join("actions.log")) {
            let _ = writeln!(f, "{}\t{}", now(), line.replace(['\n', '\r'], " "));
        }
    }
}

/// The last `n` lines of the action log, newest first.
pub fn read_log(n: usize) -> Vec<String> {
    let text = dir().ok().and_then(|d| std::fs::read_to_string(d.join("actions.log")).ok()).unwrap_or_default();
    text.lines().rev().take(n).map(str::to_string).collect()
}

/// Starts a pairing window and returns its code.
pub fn pair_start<R: Runtime>(app: &AppHandle<R>) -> Result<String, String> {
    let code = random_hex(12)?;
    *app.state::<RemoteState>().pairing.lock().unwrap() = Some((code.clone(), now() + PAIR_SECS));
    Ok(code)
}

/// The feed changed (from the main window, alongside the notch).
pub fn publish<R: Runtime>(app: &AppHandle<R>, payload: &Value) {
    let Some(state) = app.try_state::<RemoteState>() else { return };
    // The phone gets the rows and usage, not the notch's own display settings.
    let feed = json!({ "items": payload.get("items").cloned().unwrap_or(json!([])), "usage": payload.get("usage").cloned().unwrap_or(json!([])) });
    *state.feed.lock().unwrap() = feed.clone();
    if !state.running.load(Ordering::SeqCst) {
        return;
    }
    let text = feed.to_string();
    state.streams.lock().unwrap().retain(|tx| tx.send(text.clone()).is_ok());
}

pub fn running<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.try_state::<RemoteState>().is_some_and(|s| s.running.load(Ordering::SeqCst))
}

pub fn stop<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<RemoteState>();
    state.running.store(false, Ordering::SeqCst);
    if let Some(server) = state.stop.lock().unwrap().take() {
        server.unblock();
    }
    state.streams.lock().unwrap().clear();
    *state.pairing.lock().unwrap() = None;
}

pub fn start<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let state = app.state::<RemoteState>();
    if state.running.load(Ordering::SeqCst) {
        return Ok(());
    }
    let server = Arc::new(tiny_http::Server::http(("127.0.0.1", PORT)).map_err(|e| format!("Couldn't listen on 127.0.0.1:{PORT}: {e}"))?);
    *state.stop.lock().unwrap() = Some(server.clone());
    state.running.store(true, Ordering::SeqCst);
    let app = app.clone();
    std::thread::spawn(move || {
        for request in server.incoming_requests() {
            let app = app.clone();
            // Event streams stay open, so every request gets its own thread.
            std::thread::spawn(move || handle(&app, request));
        }
    });
    Ok(())
}

fn header<'a>(request: &'a tiny_http::Request, name: &str) -> Option<&'a str> {
    request.headers().iter().find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name)).map(|h| h.value.as_str())
}

fn cookie(request: &tiny_http::Request) -> Option<String> {
    header(request, "Cookie")?.split(';').map(str::trim).find_map(|c| c.strip_prefix(&format!("{COOKIE}=")).map(str::to_string))
}

fn text(code: u16, body: &str) -> tiny_http::Response<std::io::Cursor<Vec<u8>>> {
    tiny_http::Response::from_string(body).with_status_code(code).with_header(h("Content-Type", "text/plain; charset=utf-8")).with_header(h("Cache-Control", "no-store"))
}

fn h(name: &str, value: &str) -> tiny_http::Header {
    tiny_http::Header::from_bytes(name.as_bytes(), value.as_bytes()).expect("valid header")
}

/// Which paired device this request comes from, if any.
pub fn authorize(cookie: Option<&str>, login: Option<&str>, list: &[Device]) -> Option<usize> {
    let (cookie, login) = (cookie?, login?);
    if login.is_empty() {
        return None;
    }
    let hash = sha(cookie);
    list.iter().position(|d| d.hash == hash && d.login == login)
}

/// Whether a pairing code is the one Desk offered, still in time.
pub fn pair_ok(offered: Option<&(String, u64)>, code: &str, at: u64) -> bool {
    offered.is_some_and(|(c, until)| !code.is_empty() && c == code && at <= *until)
}

/// Only what the phone may do, with the fields it needs. Anything else is refused.
pub fn allowed_action(v: &Value) -> Option<Value> {
    let id = v.get("id")?.as_str()?;
    if id.is_empty() || id.len() > 200 {
        return None;
    }
    match v.get("type")?.as_str()? {
        "answer" => Some(json!({ "type": "answer", "id": id, "requestId": v.get("requestId")?.as_str()?, "allow": v.get("allow")?.as_bool()? })),
        "reply" => {
            let t = v.get("text")?.as_str()?;
            (!t.trim().is_empty() && t.len() <= 20_000).then(|| json!({ "type": "reply", "id": id, "text": t }))
        }
        "stop" => Some(json!({ "type": "stop", "id": id })),
        "seen" => Some(json!({ "type": "seen", "id": id })),
        _ => None,
    }
}

fn asset<R: Runtime>(app: &AppHandle<R>, path: &str) -> Option<(Vec<u8>, String)> {
    let asset = app.asset_resolver().get(path.to_string())?;
    Some((asset.bytes().to_vec(), asset.mime_type().to_string()))
}

fn handle<R: Runtime>(app: &AppHandle<R>, mut request: tiny_http::Request) {
    let state = app.state::<RemoteState>();
    let url = request.url().to_string();
    let (path, query) = url.split_once('?').unwrap_or((&url, ""));
    let login = header(&request, LOGIN_HEADER).map(str::to_string);
    let mut list = devices();

    // Pairing: the one-time code from the QR, from a tailnet login.
    if path == "/pair" {
        let code = query.split('&').find_map(|p| p.strip_prefix("code=")).unwrap_or("");
        let mut offered = state.pairing.lock().unwrap();
        let Some(login) = login.filter(|l| !l.is_empty()) else {
            let _ = request.respond(text(403, "Open this through Tailscale (tailscale serve), from your own tailnet."));
            return;
        };
        if !pair_ok(offered.as_ref(), code, now()) {
            let _ = request.respond(text(403, "This pairing code has expired or was already used. Show a new one in Desk ▸ Settings ▸ Phone."));
            return;
        }
        *offered = None;
        drop(offered);
        let Ok(token) = random_hex(32) else { let _ = request.respond(text(500, "No randomness.")); return };
        let agent = header(&request, "User-Agent").unwrap_or("Phone");
        let name = if agent.contains("iPhone") { "iPhone" } else if agent.contains("iPad") { "iPad" } else if agent.contains("Android") { "Android" } else { "Browser" };
        list.push(Device { hash: sha(&token), login: login.clone(), name: name.into(), added: now(), last_seen: now() });
        if save_devices(&list).is_err() {
            let _ = request.respond(text(500, "Couldn't save the device."));
            return;
        }
        log(&format!("paired\t{name}\t{login}"));
        let _ = app.emit_to("main", "remote-changed", ());
        let response = text(303, "Paired.")
            .with_header(h("Location", "/"))
            .with_header(h("Set-Cookie", &format!("{COOKIE}={token}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Strict")));
        let _ = request.respond(response);
        return;
    }

    let Some(index) = authorize(cookie(&request).as_deref(), login.as_deref(), &list) else {
        let _ = request.respond(text(401, "This phone isn't paired with Desk. Scan the code in Desk ▸ Settings ▸ Phone."));
        return;
    };
    if now() - list[index].last_seen > 300 {
        list[index].last_seen = now();
        let _ = save_devices(&list);
    }
    let device = list[index].name.clone();

    match (request.method(), path) {
        (tiny_http::Method::Get, "/events") => {
            let (tx, rx) = channel::<String>();
            let first = state.feed.lock().unwrap().to_string();
            let _ = tx.send(first);
            state.streams.lock().unwrap().push(tx);
            let body = Sse { rx, buf: Vec::new(), pos: 0 };
            let response = tiny_http::Response::new(200.into(), vec![h("Content-Type", "text/event-stream"), h("Cache-Control", "no-store"), h("X-Accel-Buffering", "no")], body, None, None);
            let _ = request.respond(response);
        }
        (tiny_http::Method::Post, "/action") => {
            let mut body = String::new();
            if request.as_reader().take(64 * 1024).read_to_string(&mut body).is_err() {
                let _ = request.respond(text(400, "Bad request."));
                return;
            }
            let parsed: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
            let Some(action) = allowed_action(&parsed) else {
                let _ = request.respond(text(400, "The phone can allow, deny, reply and stop."));
                return;
            };
            let kind = action["type"].as_str().unwrap_or("");
            let detail = match kind {
                "answer" => if action["allow"].as_bool() == Some(true) { "allow once".to_string() } else { "deny".to_string() },
                "reply" => format!("{} chars", action["text"].as_str().map(str::len).unwrap_or(0)),
                _ => String::new(),
            };
            log(&format!("{kind}\t{}\t{device}\t{}\t{detail}", action["id"].as_str().unwrap_or(""), login.as_deref().unwrap_or("")));
            let _ = app.emit_to("main", "remote-action", action);
            let _ = request.respond(text(204, ""));
        }
        (tiny_http::Method::Get, _) => {
            // The page and its scripts, from the app's own bundle.
            let file = if path == "/" { "remote.html" } else { path.trim_start_matches('/') };
            if file.contains("..") || !(file == "remote.html" || file.starts_with("assets/")) {
                let _ = request.respond(text(404, "Not found."));
                return;
            }
            match asset(app, file) {
                Some((bytes, mime)) => {
                    let _ = request.respond(tiny_http::Response::from_data(bytes).with_header(h("Content-Type", &mime)).with_header(h("Cache-Control", "no-cache")).with_header(h("X-Content-Type-Options", "nosniff")).with_header(h("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'")));
                }
                None => { let _ = request.respond(text(404, "Not found.")); }
            }
        }
        _ => { let _ = request.respond(text(405, "Not allowed.")); }
    }
}

/// An event stream: each feed is one `data:` event; a comment every 15 s keeps
/// proxies from closing it. Ends when the stream list drops its sender.
struct Sse {
    rx: Receiver<String>,
    buf: Vec<u8>,
    pos: usize,
}

impl Read for Sse {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        if self.pos >= self.buf.len() {
            self.buf = match self.rx.recv_timeout(Duration::from_secs(15)) {
                Ok(data) => format!("data: {data}\n\n").into_bytes(),
                Err(RecvTimeoutError::Timeout) => b": ping\n\n".to_vec(),
                Err(RecvTimeoutError::Disconnected) => return Ok(0),
            };
            self.pos = 0;
        }
        let n = out.len().min(self.buf.len() - self.pos);
        out[..n].copy_from_slice(&self.buf[self.pos..self.pos + n]);
        self.pos += n;
        Ok(n)
    }
}

// Tailscale

fn tailscale_bin() -> String {
    let app = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
    if std::path::Path::new(app).exists() { app.into() } else { "tailscale".into() }
}

fn ts(args: &[&str]) -> Result<crate::sandbox::RunOutput, String> {
    let mut argv = vec![tailscale_bin()];
    argv.extend(args.iter().map(|s| s.to_string()));
    crate::sandbox::run(crate::sandbox::RunOpts { args: argv, stdin: None, stdin_base64: None, secrets: vec![], timeout_secs: Some(20) })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TailscaleInfo {
    installed: bool,
    running: bool,
    /// https://<mac>.<tailnet>.ts.net, when signed in.
    url: Option<String>,
    detail: String,
}

pub fn tailscale_info() -> TailscaleInfo {
    let out = match ts(&["status", "--json"]) {
        Ok(o) => o,
        Err(e) => return TailscaleInfo { installed: false, running: false, url: None, detail: e },
    };
    if out.code == Some(127) || out.stderr.contains("not found") {
        return TailscaleInfo { installed: false, running: false, url: None, detail: "Tailscale isn't installed.".into() };
    }
    let status: Value = serde_json::from_str(out.stdout.trim()).unwrap_or(Value::Null);
    let state = status.get("BackendState").and_then(Value::as_str).unwrap_or("");
    let dns = status.pointer("/Self/DNSName").and_then(Value::as_str).unwrap_or("").trim_end_matches('.').to_string();
    let running = state == "Running";
    TailscaleInfo {
        installed: true,
        running,
        url: (running && !dns.is_empty()).then(|| format!("https://{dns}")),
        detail: if running { "Connected to your tailnet.".into() } else if state.is_empty() { out.stderr.trim().lines().last().unwrap_or("Tailscale isn't running.").to_string() } else { format!("Tailscale is {state}.") },
    }
}

/// Publishes (or stops publishing) Desk's port to the tailnet.
pub fn tailscale_serve(on: bool) -> Result<(), String> {
    let target = format!("http://127.0.0.1:{PORT}");
    let out = if on { ts(&["serve", "--bg", "--https=443", &target])? } else { ts(&["serve", "--https=443", "off"])? };
    if out.code == Some(0) { Ok(()) } else { Err(format!("{}{}", out.stderr.trim(), out.stdout.trim()).lines().last().unwrap_or("tailscale serve failed").to_string()) }
}

pub fn qr_svg(text: &str) -> Result<String, String> {
    let code = qrcode::QrCode::new(text.as_bytes()).map_err(|e| e.to_string())?;
    Ok(code.render::<qrcode::render::svg::Color>().min_dimensions(220, 220).quiet_zone(true).build())
}

pub fn status_json<R: Runtime>(app: &AppHandle<R>) -> Value {
    let devices: Vec<Value> = devices().into_iter().map(|d| json!({ "hash": d.hash, "name": d.name, "login": d.login, "added": d.added, "lastSeen": d.last_seen })).collect();
    json!({ "running": running(app), "port": PORT, "devices": devices })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dev(token: &str, login: &str) -> Device {
        Device { hash: sha(token), login: login.into(), name: "iPhone".into(), added: 0, last_seen: 0 }
    }

    #[test]
    fn unpaired_or_wrong_login_is_refused() {
        let list = vec![dev("secret", "me@example.com")];
        assert_eq!(authorize(Some("secret"), Some("me@example.com"), &list), Some(0));
        assert_eq!(authorize(Some("secret"), Some("someone@else.com"), &list), None, "another tailnet login");
        assert_eq!(authorize(Some("secret"), None, &list), None, "not through tailscale serve");
        assert_eq!(authorize(Some("secret"), Some(""), &list), None);
        assert_eq!(authorize(Some("guess"), Some("me@example.com"), &list), None, "unpaired cookie");
        assert_eq!(authorize(None, Some("me@example.com"), &list), None);
    }

    #[test]
    fn pairing_code_is_one_time_and_expires() {
        let offered = Some(("abc".to_string(), 100));
        assert!(pair_ok(offered.as_ref(), "abc", 100));
        assert!(!pair_ok(offered.as_ref(), "abc", 101), "expired");
        assert!(!pair_ok(offered.as_ref(), "abd", 50));
        assert!(!pair_ok(offered.as_ref(), "", 50));
        assert!(!pair_ok(None, "abc", 50), "already used");
    }

    #[test]
    fn only_phone_actions_pass() {
        assert_eq!(allowed_action(&json!({"type": "answer", "id": "c:1", "requestId": "r", "allow": true, "always": true})), Some(json!({"type": "answer", "id": "c:1", "requestId": "r", "allow": true})), "extra fields dropped");
        assert!(allowed_action(&json!({"type": "open", "id": "c:1"})).is_none());
        assert!(allowed_action(&json!({"type": "mode", "id": "c:1", "mode": "bypassPermissions"})).is_none());
        assert!(allowed_action(&json!({"type": "reply", "id": "c:1", "text": "  "})).is_none());
        assert!(allowed_action(&json!({"type": "answer", "id": "c:1", "requestId": "r"})).is_none(), "allow is required");
        assert_eq!(allowed_action(&json!({"type": "stop", "id": "t:2"})), Some(json!({"type": "stop", "id": "t:2"})));
    }

    #[test]
    fn qr_renders() {
        assert!(qr_svg("https://mac.tailnet.ts.net/pair?code=abc").unwrap().contains("<svg"));
    }
}
