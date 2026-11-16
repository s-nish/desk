//! More than one Desk window. The first is "main"; others are "w-<id>", each with
//! its own projects, tabs and chats saved in windows/<label>.json. Settings,
//! accounts, SSH connections and sandboxes live in state.json, which only the
//! main window writes; the windows keep each other up to date with events (see
//! src/windows.ts). Extra windows open again when Desk does, until you close them.

use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Emitter, EventTarget, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};

pub const MAIN: &str = "main";
const PREFIX: &str = "w-";

/// Whether a webview label is one of Desk's own windows.
pub fn is_desk(label: &str) -> bool {
    label == MAIN || is_extra(label)
}

pub fn is_extra(label: &str) -> bool {
    label
        .strip_prefix(PREFIX)
        .is_some_and(|id| !id.is_empty() && id.len() <= 40 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'))
}

fn data_dir() -> PathBuf {
    dirs::data_dir().unwrap_or_else(|| PathBuf::from(".")).join(crate::variant::app_dir())
}

fn windows_dir() -> PathBuf {
    data_dir().join("windows")
}

/// Where a window's workspace is saved: state.json for the main one.
pub fn state_file(label: &str) -> Result<PathBuf, String> {
    if label == MAIN {
        Ok(data_dir().join("state.json"))
    } else if is_extra(label) {
        Ok(windows_dir().join(format!("{label}.json")))
    } else {
        Err("Not one of Desk's windows.".into())
    }
}

/// Sends an event to Desk's own windows only: never the notch or a browser page.
pub fn emit_to_desk<R: Runtime, S: Serialize + Clone>(app: &AppHandle<R>, event: &str, payload: S) {
    let _ = app.emit_filter(event, payload, |target| match target {
        EventTarget::WebviewWindow { label } | EventTarget::Webview { label } | EventTarget::Window { label } => is_desk(label),
        _ => false,
    });
}

fn new_label() -> String {
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    format!("{PREFIX}{:x}{:04x}", nanos, std::process::id() & 0xffff)
}

/// Opens a Desk window. A new one (no label) starts empty.
pub fn open<R: Runtime>(app: &AppHandle<R>, label: Option<String>) -> Result<String, String> {
    let label = label.unwrap_or_else(new_label);
    if !is_extra(&label) {
        return Err("Not a window label Desk makes.".into());
    }
    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.set_focus();
        return Ok(label);
    }
    // Next to the window you're in, a little down and to the right, like other Mac apps.
    let near = app
        .webview_windows()
        .values()
        .filter(|w| is_desk(w.label()))
        .find(|w| w.is_focused().unwrap_or(false))
        .and_then(|w| Some((w.outer_position().ok()?, w.scale_factor().ok()?)));
    let mut builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title(crate::variant::name())
        .inner_size(1280.0, 840.0)
        .min_inner_size(960.0, 600.0)
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(16.0, 26.0))
        .background_color(tauri::window::Color(2, 7, 10, 255));
    if let Some((pos, scale)) = near {
        builder = builder.position(pos.x as f64 / scale + 28.0, pos.y as f64 / scale + 28.0);
    }
    builder.build().map_err(|e| e.to_string())?;
    Ok(label)
}

/// The extra windows open now.
pub fn labels<R: Runtime>(app: &AppHandle<R>) -> Vec<String> {
    app.webview_windows().keys().filter(|l| is_extra(l)).cloned().collect()
}

/// Opens the extra windows that were open when Desk quit.
pub fn reopen<R: Runtime>(app: &AppHandle<R>) {
    let Ok(dir) = std::fs::read_dir(windows_dir()) else { return };
    let mut saved: Vec<(std::time::SystemTime, String)> = dir
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let label = name.strip_suffix(".json")?.to_string();
            let modified = e.metadata().and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH);
            is_extra(&label).then_some((modified, label))
        })
        .collect();
    saved.sort();
    for (_, label) in saved {
        if let Err(e) = open(app, Some(label.clone())) {
            eprintln!("Couldn't reopen window {label}: {e}");
        }
    }
}

/// Closes an extra window for good: its saved workspace goes too.
pub fn forget<R: Runtime>(app: &AppHandle<R>, label: &str) -> Result<(), String> {
    if !is_extra(label) {
        return Err("Only extra windows close this way; closing the main window quits Desk.".into());
    }
    let _ = std::fs::remove_file(state_file(label)?);
    if let Some(window) = app.get_webview_window(label) {
        window.destroy().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Brings a window forward (a click in the notch, the menu bar or a notification
/// for something that lives in it).
pub fn focus<R: Runtime>(app: &AppHandle<R>, label: &str) {
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_and_files() {
        assert!(is_desk("main") && is_desk("w-18ab") && !is_desk("notch") && !is_desk("browser"));
        assert!(!is_extra("w-") && !is_extra("w-../x") && !is_extra("w-a/b") && !is_extra("main"));
        assert!(state_file("main").unwrap().ends_with("state.json"));
        assert!(state_file("w-12").unwrap().ends_with("windows/w-12.json"));
        assert!(state_file("browser").is_err());
        let a = new_label();
        assert!(is_extra(&a), "{a}");
    }
}
