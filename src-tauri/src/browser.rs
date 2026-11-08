//! A small built-in browser: one native WKWebView laid over a placeholder in
//! Desk's window. It is created when the browser opens and destroyed when it
//! closes, so it costs nothing otherwise. Pages get no access to Desk: picking
//! an element (design mode) reports back by navigating to a `desk-pick:` URL,
//! which is intercepted here and never loaded.
use serde_json::{json, Value};
use tauri::webview::{PageLoadEvent, WebviewBuilder};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Rect, Url, WebviewUrl};

const LABEL: &str = "browser";

/// Injected into every page: highlights the element under the pointer while
/// picking, and on click sends a description of it.
const PICKER: &str = r##"(() => {
  if (window.__deskPick) return;
  let on = false, box = null, last = null;
  const KEYS = ["display","position","width","height","margin","padding","color","background-color","background-image","font-family","font-size","font-weight","line-height","letter-spacing","text-align","border","border-radius","box-shadow","gap","flex-direction","justify-content","align-items","grid-template-columns","opacity","z-index"];
  const selector = (el) => {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && parts.length < 5; n = n.parentElement) {
      let s = n.tagName.toLowerCase();
      if (n.id) { parts.unshift(s + "#" + CSS.escape(n.id)); break; }
      const cls = [...n.classList].slice(0, 2).map((c) => "." + CSS.escape(c)).join("");
      const sib = n.parentElement ? [...n.parentElement.children].filter((c) => c.tagName === n.tagName) : [];
      parts.unshift(s + cls + (sib.length > 1 ? `:nth-of-type(${sib.indexOf(n) + 1})` : ""));
    }
    return parts.join(" > ");
  };
  const show = (el) => {
    if (!box) { box = document.createElement("div"); box.style.cssText = "position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #fff;outline:1px solid #000;background:rgba(255,255,255,.12);border-radius:3px;transition:all .05s"; document.documentElement.appendChild(box); }
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px", display: "block" });
  };
  const move = (e) => { if (!on) return; const el = e.target; if (el && el !== box && el !== last) { last = el; show(el); } };
  const click = (e) => {
    if (!on || !last) return;
    e.preventDefault(); e.stopPropagation();
    const el = last, cs = getComputedStyle(el), r = el.getBoundingClientRect();
    const styles = {};
    for (const k of KEYS) { const v = cs.getPropertyValue(k); if (v && v !== "none" && v !== "normal" && v !== "auto" && v !== "0px" && v !== "rgba(0, 0, 0, 0)") styles[k] = v; }
    const html = el.outerHTML.length > 4000 ? el.outerHTML.slice(0, 4000) + "…" : el.outerHTML;
    const data = { url: location.href, title: document.title, selector: selector(el), html, text: (el.innerText || "").trim().slice(0, 300), styles, size: [Math.round(r.width), Math.round(r.height)] };
    window.__deskPick(false);
    location.href = "desk-pick://element?d=" + encodeURIComponent(JSON.stringify(data));
  };
  const key = (e) => { if (on && e.key === "Escape") { window.__deskPick(false); location.href = "desk-pick://cancel"; } };
  window.__deskPick = (state) => {
    on = state; last = null;
    if (box) box.style.display = "none";
    document.documentElement.style.cursor = on ? "crosshair" : "";
  };
  addEventListener("mousemove", move, true);
  addEventListener("click", click, true);
  addEventListener("keydown", key, true);
})();"##;

fn parse(url: &str) -> Result<Url, String> {
    let url = url.trim();
    let full = if url.contains("://") || url.starts_with("about:") { url.to_string() } else if url.starts_with("localhost") || url.starts_with("127.") { format!("http://{url}") } else { format!("https://{url}") };
    let parsed = Url::parse(&full).map_err(|e| format!("Not a web address: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https" | "about") {
        return Err("Only http and https pages open in Desk's browser.".into());
    }
    Ok(parsed)
}

fn state(app: &AppHandle, url: &Url, loading: bool) {
    let _ = app.emit_to("main", "browser-state", json!({ "url": url.as_str(), "loading": loading }));
}

/// Opens (or navigates) the browser over the given rectangle, in CSS pixels.
pub fn open(app: &AppHandle, url: &str, x: f64, y: f64, width: f64, height: f64) -> Result<(), String> {
    let url = parse(url)?;
    if let Some(view) = app.get_webview(LABEL) {
        view.navigate(url).map_err(|e| e.to_string())?;
        return bounds(app, x, y, width, height, true);
    }
    let window = app.get_window("main").ok_or("Desk's window isn't open.")?;
    let (nav, load, title) = (app.clone(), app.clone(), app.clone());
    let builder = WebviewBuilder::new(LABEL, WebviewUrl::External(url))
        .initialization_script(PICKER)
        .on_navigation(move |url| {
            if url.scheme() != "desk-pick" {
                return true;
            }
            let picked: Value = url
                .query_pairs()
                .find(|(k, _)| k == "d")
                .and_then(|(_, v)| serde_json::from_str(&v).ok())
                .unwrap_or(Value::Null);
            let _ = nav.emit_to("main", "browser-pick", picked);
            false
        })
        .on_page_load(move |_, payload| state(&load, payload.url(), payload.event() == PageLoadEvent::Started))
        .on_document_title_changed(move |_, t| {
            let _ = title.emit_to("main", "browser-title", t);
        });
    window
        .add_child(builder, LogicalPosition::new(x, y), LogicalSize::new(width.max(1.0), height.max(1.0)))
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn bounds(app: &AppHandle, x: f64, y: f64, width: f64, height: f64, visible: bool) -> Result<(), String> {
    let Some(view) = app.get_webview(LABEL) else { return Ok(()) };
    view.set_bounds(Rect { position: LogicalPosition::new(x, y).into(), size: LogicalSize::new(width.max(1.0), height.max(1.0)).into() })
        .map_err(|e| e.to_string())?;
    if visible && width > 1.0 && height > 1.0 { view.show() } else { view.hide() }.map_err(|e| e.to_string())
}

/// Back, forward, reload, or design mode on and off.
pub fn command(app: &AppHandle, action: &str) -> Result<(), String> {
    let Some(view) = app.get_webview(LABEL) else { return Ok(()) };
    let js = match action {
        "back" => "history.back()",
        "forward" => "history.forward()",
        "reload" => "location.reload()",
        "pick" => "window.__deskPick && window.__deskPick(true)",
        "unpick" => "window.__deskPick && window.__deskPick(false)",
        _ => return Err(format!("Unknown browser action: {action}")),
    };
    view.eval(js).map_err(|e| e.to_string())
}

/// Destroys the page and its web process.
pub fn close(app: &AppHandle) -> Result<(), String> {
    match app.get_webview(LABEL) {
        Some(view) => view.close().map_err(|e| e.to_string()),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_typed_addresses() {
        assert_eq!(parse("localhost:3000").unwrap().as_str(), "http://localhost:3000/");
        assert_eq!(parse("example.com/a").unwrap().as_str(), "https://example.com/a");
        assert!(parse("file:///etc/passwd").is_err());
        assert!(parse("javascript:alert(1)").is_err());
    }
}
