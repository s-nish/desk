//! Desk's menu bar icon: a pixel "D" (with a dot while agents work) whose menu
//! lists the chats and terminal tabs that are working or waiting on you. The page
//! decides what's active and sends the list (`tray_update`); clicking a row brings
//! Desk forward and tells the page which one to show (`tray-open`).

use serde::Deserialize;
use tauri::image::Image;
use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, Runtime};

const TRAY_ID: &str = "desk";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayItem {
    /// `c:<chat id>` or `t:<tab id>`, handed back to the page when clicked.
    pub id: String,
    pub label: String,
    /// Agent, project and how long it has been working.
    pub detail: String,
    /// Asked something and is waiting for an answer.
    pub waiting: bool,
}

/// The 5×7 pixel "D" from Desk's icon.
const GLYPH: [&str; 7] = ["####.", "#...#", "#...#", "#...#", "#...#", "#...#", "####."];

/// A template image (only alpha counts; macOS tints it to match the menu bar).
fn icon(busy: bool) -> Image<'static> {
    const CELL: usize = 4;
    const GAP: usize = 1;
    const W: usize = 34;
    const H: usize = 36;
    let mut rgba = vec![0u8; W * H * 4];
    let mut fill = |x0: usize, y0: usize, w: usize, h: usize| {
        for y in y0..(y0 + h).min(H) {
            for x in x0..(x0 + w).min(W) {
                let i = (y * W + x) * 4;
                rgba[i + 3] = 255;
            }
        }
    };
    for (row, line) in GLYPH.iter().enumerate() {
        for (col, c) in line.chars().enumerate() {
            if c == '#' {
                fill(1 + col * (CELL + GAP), 1 + row * (CELL + GAP), CELL, CELL);
            }
        }
    }
    if busy {
        // A small square up and to the right, like a pixel badge.
        fill(28, 1, 5, 5);
    }
    Image::new_owned(rgba, W as u32, H as u32)
}

fn clip(text: &str, max: usize) -> String {
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.chars().count() <= max {
        text
    } else {
        format!("{}…", text.chars().take(max - 1).collect::<String>())
    }
}

fn build<R: Runtime>(app: &AppHandle<R>, items: &[TrayItem]) -> tauri::Result<Menu<R>> {
    let mut menu = MenuBuilder::new(app);
    if items.is_empty() {
        menu = menu.item(&MenuItemBuilder::with_id("none", "No agents working").enabled(false).build(app)?);
    }
    let waiting: Vec<_> = items.iter().filter(|i| i.waiting).collect();
    let working: Vec<_> = items.iter().filter(|i| !i.waiting).collect();
    for (title, group, mark) in [("Waiting for you", &waiting, "◐"), ("Working", &working, "●")] {
        if group.is_empty() {
            continue;
        }
        menu = menu.item(&MenuItemBuilder::with_id(format!("head:{title}"), format!("{title} ({})", group.len())).enabled(false).build(app)?);
        for item in group.iter() {
            let text = format!("{mark}  {}  —  {}", clip(&item.label, 48), clip(&item.detail, 60));
            menu = menu.item(&MenuItemBuilder::with_id(format!("go:{}", item.id), text).build(app)?);
        }
    }
    menu.separator()
        .item(&MenuItemBuilder::with_id("open", "Open Desk").build(app)?)
        .item(&MenuItemBuilder::with_id("quit", "Quit Desk").build(app)?)
        .build()
}

fn show<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub fn create<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let menu = build(app, &[])?;
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon(false))
        .icon_as_template(true)
        .tooltip(crate::variant::name())
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show(app),
            // The usual quit: Desk saves the workspace first, as with ⌘Q.
            "quit" => app.exit(0),
            id => {
                if let Some(target) = id.strip_prefix("go:") {
                    show(app);
                    let _ = app.emit("tray-open", target.to_string());
                }
            }
        })
        .build(app)?;
    Ok(())
}

pub fn update<R: Runtime>(app: &AppHandle<R>, items: &[TrayItem]) -> tauri::Result<()> {
    let Some(tray) = app.tray_by_id(TRAY_ID) else { return Ok(()) };
    tray.set_menu(Some(build(app, items)?))?;
    tray.set_icon(Some(icon(!items.is_empty())))?;
    tray.set_icon_as_template(true)?;
    let waiting = items.iter().filter(|i| i.waiting).count();
    let tip = match (items.len(), waiting) {
        (0, _) => crate::variant::name().to_string(),
        (n, 0) => format!("{} · {n} working", crate::variant::name()),
        (n, w) => format!("{} · {} working, {w} waiting for you", crate::variant::name(), n - w),
    };
    tray.set_tooltip(Some(tip))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn icon_draws_the_glyph_and_the_busy_dot() {
        let idle = icon(false);
        let busy = icon(true);
        let lit = |img: &Image| img.rgba().chunks(4).filter(|p| p[3] == 255).count();
        // 18 cells of the D at 4×4 pixels each, plus a 5×5 dot when busy.
        assert_eq!(lit(&idle), 18 * 16);
        assert_eq!(lit(&busy), 18 * 16 + 25);
        assert_eq!((idle.width(), idle.height()), (34, 36));
    }

    #[test]
    fn long_labels_are_clipped() {
        assert_eq!(clip("a  b\nc", 10), "a b c");
        assert_eq!(clip(&"x".repeat(60), 10).chars().count(), 10);
    }
}
