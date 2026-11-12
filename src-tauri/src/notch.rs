//! The notch: a small black window that grows out of the MacBook's camera notch
//! (or a pill under the menu bar on screens without one) and shows the agents
//! that are working or waiting, with Allow, Deny and a reply field.
//!
//! The page in it (`notch.html`) is a pure view. The main window builds the feed
//! and sends it here (`notch_update`); Rust keeps the latest copy and forwards it.
//! Clicks come back as actions (`notch_action`), which the main window applies.
//!
//! On macOS the window is turned into a non-activating panel, so clicking it never
//! brings Desk forward or takes focus from the app you're in. It only takes the
//! keyboard when you click into the reply field (`notch_focus`).

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};

pub const LABEL: &str = "notch";

/// The only commands the notch page may call. Everything else is main-window only.
pub const COMMANDS: [&str; 4] = ["notch_snapshot", "notch_action", "notch_resize", "notch_focus"];

#[derive(Default)]
pub struct NotchState {
    /// The latest feed from the main window, handed to the page when it loads.
    payload: Mutex<Value>,
    /// Whether the window is on screen (the hover watcher only runs then).
    shown: AtomicBool,
    hover: AtomicBool,
    geometry: Mutex<Option<Geometry>>,
    /// The size the page last asked for, to re-place it when the screen changes.
    size: Mutex<(f64, f64)>,
}

/// Where the notch is, in points.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Geometry {
    pub has_notch: bool,
    /// Width of the camera housing; 0 on a screen without one.
    pub notch_width: f64,
    /// Height of the notch, or of the pill when there's none.
    pub notch_height: f64,
    /// Distance from the top of the screen to the window: 0 on the notch, the
    /// menu bar's height for the pill.
    pub top: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

const PILL_HEIGHT: f64 = 30.0;

/// The notch from what the screen reports: safe area at the top, and the menu bar
/// areas either side of the camera. A screen without a notch reports none of them.
pub fn metrics(screen_width: f64, safe_top: f64, aux_left: f64, aux_right: f64, menu_bar: f64) -> Geometry {
    if safe_top > 0.0 && aux_left > 0.0 && aux_right > 0.0 && aux_left + aux_right < screen_width {
        Geometry { has_notch: true, notch_width: (screen_width - aux_left - aux_right).round(), notch_height: safe_top, top: 0.0 }
    } else {
        Geometry { has_notch: false, notch_width: 0.0, notch_height: PILL_HEIGHT, top: menu_bar.max(0.0) }
    }
}

/// A `w`×`h` window centred on the screen and hanging from `top` below its top edge.
/// Cocoa coordinates: the origin is the bottom-left corner.
pub fn frame(screen: Rect, top: f64, w: f64, h: f64) -> Rect {
    Rect { x: (screen.x + (screen.w - w) / 2.0).round(), y: (screen.y + screen.h - top - h).round(), w: w.round(), h: h.round() }
}

fn contains(r: Rect, x: f64, y: f64) -> bool {
    x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h
}

/// Creates the window, hidden. It shows once the page sizes it.
pub fn create<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    app.manage(NotchState::default());
    let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("notch.html".into()))
        .title("Desk")
        .inner_size(220.0, 32.0)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .visible(false)
        .focused(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .visible_on_all_workspaces(true)
        .accept_first_mouse(true)
        .build()?;
    #[cfg(target_os = "macos")]
    if let Ok(ptr) = window.ns_window() {
        // SAFETY: setup runs on the main thread and the pointer is the live NSWindow.
        unsafe { mac::make_panel(ptr) };
    }
    #[cfg(not(target_os = "macos"))]
    let _ = window;
    refresh_geometry(app);
    watch_hover(app.clone());
    Ok(())
}

/// The main window's latest feed, forwarded to the page.
pub fn update<R: Runtime>(app: &AppHandle<R>, payload: Value) {
    let Some(state) = app.try_state::<NotchState>() else { return };
    *state.payload.lock().unwrap() = payload.clone();
    let _ = app.emit_to(LABEL, "notch-feed", payload);
}

#[derive(Serialize)]
pub struct Snapshot {
    payload: Value,
    geometry: Option<Geometry>,
}

pub fn snapshot<R: Runtime>(app: &AppHandle<R>) -> Snapshot {
    let state = app.state::<NotchState>();
    let payload = state.payload.lock().unwrap().clone();
    let geometry = *state.geometry.lock().unwrap();
    Snapshot { payload, geometry }
}

/// A click in the notch, applied by the main window. "Open" brings Desk forward first.
pub fn action<R: Runtime>(app: &AppHandle<R>, action: Value) {
    if action.get("type").and_then(Value::as_str) == Some("open") {
        if let Some(main) = app.get_webview_window("main") {
            let _ = main.unminimize();
            let _ = main.show();
            let _ = main.set_focus();
        }
    }
    let _ = app.emit_to("main", "notch-action", action);
}

/// Sizes the window (points), centred under the notch. Zero hides it.
pub fn resize<R: Runtime>(app: &AppHandle<R>, width: f64, height: f64) {
    let state = app.state::<NotchState>();
    *state.size.lock().unwrap() = (width, height);
    let geometry = *state.geometry.lock().unwrap();
    let show = width > 0.0 && height > 0.0 && geometry.is_some();
    state.shown.store(show, Ordering::SeqCst);
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Some(window) = handle.get_webview_window(LABEL) else { return };
        #[cfg(target_os = "macos")]
        if let Ok(ptr) = window.ns_window() {
            // SAFETY: on the main thread, with the live window.
            unsafe { mac::place(ptr, geometry.map(|g| g.top).unwrap_or(0.0), width, height, show) };
        }
        #[cfg(not(target_os = "macos"))]
        let _ = (window, show);
    });
}

/// Gives the panel the keyboard (the reply field was clicked), or hands it back.
pub fn focus<R: Runtime>(app: &AppHandle<R>, focus: bool) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Some(window) = handle.get_webview_window(LABEL) else { return };
        #[cfg(target_os = "macos")]
        if let Ok(ptr) = window.ns_window() {
            // SAFETY: on the main thread, with the live window.
            unsafe { mac::focus(ptr, focus) };
        }
        #[cfg(not(target_os = "macos"))]
        let _ = (window, focus);
    });
}

/// Re-reads the notch from the screen and tells the page if it moved (a monitor
/// was plugged in or out, or the resolution changed).
fn refresh_geometry<R: Runtime>(app: &AppHandle<R>) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        #[cfg(target_os = "macos")]
        let geometry = mac::geometry();
        #[cfg(not(target_os = "macos"))]
        let geometry: Option<Geometry> = None;
        let state = handle.state::<NotchState>();
        let changed = {
            let mut current = state.geometry.lock().unwrap();
            let changed = *current != geometry;
            *current = geometry;
            changed
        };
        if changed {
            let _ = handle.emit_to(LABEL, "notch-geometry", geometry);
            // Move it to the new spot now, rather than waiting for the page.
            let (w, h) = *state.size.lock().unwrap();
            resize(&handle, w, h);
        }
    });
}

/// Hover can't come from the page: a web view in a background window doesn't get
/// mouse-moved events. So Rust watches the pointer while the notch is on screen.
fn watch_hover<R: Runtime>(app: AppHandle<R>) {
    std::thread::spawn(move || {
        let mut ticks: u32 = 0;
        loop {
            std::thread::sleep(Duration::from_millis(60));
            ticks = ticks.wrapping_add(1);
            // Screens change rarely; checking every few seconds is plenty.
            if ticks % 50 == 0 {
                refresh_geometry(&app);
            }
            let state = app.state::<NotchState>();
            if !state.shown.load(Ordering::SeqCst) {
                if state.hover.swap(false, Ordering::SeqCst) {
                    let _ = app.emit_to(LABEL, "notch-hover", false);
                }
                continue;
            }
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || {
                let Some(window) = handle.get_webview_window(LABEL) else { return };
                #[cfg(target_os = "macos")]
                let inside = window.ns_window().ok().map(|ptr| unsafe { mac::pointer_inside(ptr) }).unwrap_or(false);
                #[cfg(not(target_os = "macos"))]
                let inside = { let _ = window; false };
                let state = handle.state::<NotchState>();
                if state.hover.swap(inside, Ordering::SeqCst) != inside {
                    let _ = handle.emit_to(LABEL, "notch-hover", inside);
                }
            });
        }
    });
}

#[cfg(target_os = "macos")]
mod mac {
    use std::ffi::c_void;

    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2::{ClassType, MainThreadMarker, MainThreadOnly, define_class};
    use objc2_app_kit::{NSEvent, NSPanel, NSResponder, NSScreen, NSWindow, NSWindowCollectionBehavior, NSWindowStyleMask};
    use objc2_foundation::{NSObject, NSPoint, NSRect, NSSize};

    use super::{Geometry, Rect, contains, frame, metrics};

    define_class!(
        // A panel that may take the keyboard (for the reply field) but never
        // becomes the main window, and may sit over the menu bar.
        #[unsafe(super(NSPanel, NSWindow, NSResponder, NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "DeskNotchPanel"]
        struct NotchPanel;

        impl NotchPanel {
            #[unsafe(method(canBecomeKeyWindow))]
            fn can_become_key_window(&self) -> bool {
                true
            }

            #[unsafe(method(canBecomeMainWindow))]
            fn can_become_main_window(&self) -> bool {
                false
            }

            #[unsafe(method(constrainFrameRect:toScreen:))]
            fn constrain_frame_rect(&self, rect: NSRect, _screen: Option<&NSScreen>) -> NSRect {
                rect
            }
        }
    );

    /// Above the menu bar (24) and status items (25), below pop-up menus (101).
    const LEVEL: isize = 27;

    unsafe fn window<'a>(ptr: *mut c_void) -> &'a NSWindow {
        unsafe { &*(ptr as *const NSWindow) }
    }

    /// Turns Tauri's window into a non-activating panel. NSPanel adds no instance
    /// variables to NSWindow (checked: both 520 bytes), so swapping the class of the
    /// already-allocated window is safe; the panel subclass only overrides methods.
    pub unsafe fn make_panel(ptr: *mut c_void) {
        let class: &AnyClass = NotchPanel::class();
        unsafe { objc2::ffi::object_setClass(ptr as *mut AnyObject, class) };
        let window = unsafe { window(ptr) };
        window.setStyleMask(window.styleMask() | NSWindowStyleMask::NonactivatingPanel);
        // The class is now a panel subclass, so this view of it is accurate.
        let panel = unsafe { &*(ptr as *const NSPanel) };
        panel.setFloatingPanel(true);
        panel.setBecomesKeyOnlyIfNeeded(true);
        panel.setWorksWhenModal(true);
        window.setLevel(LEVEL);
        window.setHidesOnDeactivate(false);
        window.setExcludedFromWindowsMenu(true);
        window.setHasShadow(false);
        window.setCollectionBehavior(
            NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::Stationary
                | NSWindowCollectionBehavior::FullScreenAuxiliary
                | NSWindowCollectionBehavior::IgnoresCycle,
        );
    }

    /// The screen the notch lives on: the one with a camera notch, else the one
    /// with the menu bar.
    fn screen(mtm: MainThreadMarker) -> Option<Retained<NSScreen>> {
        let screens = NSScreen::screens(mtm);
        let notched = screens.iter().find(|s| s.safeAreaInsets().top > 0.0);
        notched.or_else(|| screens.firstObject())
    }

    fn rect(r: NSRect) -> Rect {
        Rect { x: r.origin.x, y: r.origin.y, w: r.size.width, h: r.size.height }
    }

    pub fn geometry() -> Option<Geometry> {
        let mtm = MainThreadMarker::new()?;
        let screen = screen(mtm)?;
        let full = screen.frame();
        let visible = screen.visibleFrame();
        let menu_bar = (full.origin.y + full.size.height) - (visible.origin.y + visible.size.height);
        Some(metrics(
            full.size.width,
            screen.safeAreaInsets().top,
            screen.auxiliaryTopLeftArea().size.width,
            screen.auxiliaryTopRightArea().size.width,
            menu_bar,
        ))
    }

    pub unsafe fn place(ptr: *mut c_void, top: f64, width: f64, height: f64, show: bool) {
        let window = unsafe { window(ptr) };
        if !show {
            window.orderOut(None);
            return;
        }
        let Some(mtm) = MainThreadMarker::new() else { return };
        let Some(screen) = screen(mtm) else { return };
        let r = frame(rect(screen.frame()), top, width, height);
        window.setFrame_display(NSRect::new(NSPoint::new(r.x, r.y), NSSize::new(r.w, r.h)), true);
        // Never makeKey here: showing must not take the keyboard from your app.
        window.orderFrontRegardless();
    }

    pub unsafe fn focus(ptr: *mut c_void, focus: bool) {
        let window = unsafe { window(ptr) };
        if focus {
            window.makeKeyWindow();
        } else if window.isKeyWindow() {
            // Hiding and showing again hands the keyboard back to the app you were in.
            window.orderOut(None);
            window.orderFrontRegardless();
        }
    }

    pub unsafe fn pointer_inside(ptr: *mut c_void) -> bool {
        let window = unsafe { window(ptr) };
        if !window.isVisible() {
            return false;
        }
        let p = NSEvent::mouseLocation();
        contains(rect(window.frame()), p.x, p.y)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notch_from_screen_metrics() {
        // 14-inch MacBook Pro at its default "looks like 1512 × 982".
        let g = metrics(1512.0, 32.0, 664.0, 664.0, 32.0);
        assert_eq!(g, Geometry { has_notch: true, notch_width: 184.0, notch_height: 32.0, top: 0.0 });
        // 16-inch at 1728 × 1117.
        let g = metrics(1728.0, 32.0, 771.0, 771.0, 32.0);
        assert_eq!(g.notch_width, 186.0);
        // MacBook Air 13-inch at 1470 × 956, with uneven sides.
        let g = metrics(1470.0, 33.0, 642.5, 643.5, 33.0);
        assert!(g.has_notch);
        assert_eq!(g.notch_width, 184.0);
    }

    #[test]
    fn screen_without_a_notch_gets_the_pill() {
        let g = metrics(2560.0, 0.0, 0.0, 0.0, 25.0);
        assert_eq!(g, Geometry { has_notch: false, notch_width: 0.0, notch_height: PILL_HEIGHT, top: 25.0 });
    }

    #[test]
    fn frame_hangs_from_the_top_centre() {
        let screen = Rect { x: 0.0, y: 0.0, w: 1512.0, h: 982.0 };
        assert_eq!(frame(screen, 0.0, 300.0, 32.0), Rect { x: 606.0, y: 950.0, w: 300.0, h: 32.0 });
        // An external screen to the left of the laptop, pill under its menu bar.
        let screen = Rect { x: -2560.0, y: 0.0, w: 2560.0, h: 1440.0 };
        assert_eq!(frame(screen, 25.0, 200.0, 30.0), Rect { x: -1380.0, y: 1385.0, w: 200.0, h: 30.0 });
    }

    #[test]
    fn hit_test() {
        let r = Rect { x: 10.0, y: 10.0, w: 100.0, h: 20.0 };
        assert!(contains(r, 10.0, 30.0));
        assert!(!contains(r, 9.0, 15.0));
        assert!(!contains(r, 50.0, 31.0));
    }

    #[test]
    fn notch_page_may_only_call_its_own_commands() {
        assert!(COMMANDS.iter().all(|c| c.starts_with("notch_")));
        assert!(!COMMANDS.contains(&"notch_update"), "only the main window sends the feed");
    }
}
