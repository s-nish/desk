import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { ArrowLeft, ArrowRight, ExternalLink, Globe, LoaderCircle, MousePointerClick, RotateCw, X } from "lucide-react";
import { useDesk } from "../store";
import { errorText, ipc } from "../ipc";
import { activeProject } from "../actions";
import { handToAgent } from "../review";

/** Overlays that sit above the page: the native page would cover them, so it steps aside. */
const OVERLAYS = ".modal-backdrop, .menu, .toast";
const SUGGESTED = ["localhost:3000", "localhost:5173", "localhost:8080", "localhost:4321"];

interface Picked { url: string; title: string; selector: string; html: string; text: string; styles: Record<string, string>; size: [number, number] }

/** What a picked element tells the agent. */
function pickedMessage(p: Picked) {
  const styles = Object.entries(p.styles).map(([k, v]) => `  ${k}: ${v};`).join("\n");
  return [
    `On ${p.url}${p.title ? ` (${p.title})` : ""}, this element (${p.size[0]}×${p.size[1]}px):`,
    "",
    `Selector: ${p.selector}`,
    ...(p.text ? [`Text: ${p.text}`] : []),
    "",
    "```html",
    p.html,
    "```",
    ...(styles ? ["", "Computed styles:", "```css", styles, "```"] : []),
    "",
    "Change: ",
  ].join("\n");
}

export function openBrowser(url?: string) {
  const s = useDesk.getState();
  s.setLayout({ browserOpen: true, ...(url ? { browserUrl: url } : {}) });
}

export function BrowserPane() {
  const url = useDesk((s) => s.layout.browserUrl ?? "");
  const [address, setAddress] = useState(url);
  const [title, setTitle] = useState("");
  const [loading, setLoading] = useState(false);
  const [picking, setPicking] = useState(false);
  // Read by the event listener: a pick only counts while design mode is on, so a page
  // can't fill the message box by navigating to desk-pick: on its own.
  const pickingRef = useRef(false);
  const setPick = (on: boolean) => { pickingRef.current = on; setPicking(on); };
  const [error, setError] = useState("");
  const [created, setCreated] = useState(false);
  const host = useRef<HTMLDivElement>(null);

  // The page follows the placeholder: its place, its size, and whether anything is drawn
  // over it. Only layout changes and overlays coming and going are watched (not every
  // streamed token), and the native view is only told when something actually moved.
  useLayoutEffect(() => {
    if (!created) return;
    let frame = 0;
    let last = "";
    const sync = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const el = host.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        const covered = Array.from(document.querySelectorAll(OVERLAYS)).some((o) => {
          const b = o.getBoundingClientRect();
          return b.right > r.left && b.left < r.right && b.bottom > r.top && b.top < r.bottom;
        });
        const visible = !covered && r.width > 0;
        const key = `${r.left},${r.top},${r.width},${r.height},${visible}`;
        if (key === last) return;
        last = key;
        void ipc.browserBounds(r.left, r.top, r.width, r.height, visible).catch(() => {});
      });
    };
    sync();
    // Columns beside the browser resizing (splitters, panels opening) move it.
    const sizes = new ResizeObserver(sync);
    const watchColumns = () => {
      sizes.disconnect();
      if (host.current) sizes.observe(host.current);
      document.querySelectorAll(".app > .body > *").forEach((el) => sizes.observe(el));
    };
    watchColumns();
    const columns = new MutationObserver(() => { watchColumns(); sync(); });
    const body = document.querySelector(".app > .body");
    if (body) columns.observe(body, { childList: true });
    // Modals, menus and toasts are direct children of the app and of the toast stack.
    const overlays = new MutationObserver(sync);
    for (const el of document.querySelectorAll(".app, .toasts")) overlays.observe(el, { childList: true });
    window.addEventListener("resize", sync);
    return () => { cancelAnimationFrame(frame); sizes.disconnect(); columns.disconnect(); overlays.disconnect(); window.removeEventListener("resize", sync); };
  }, [created]);

  // Closing the pane ends the page and its web process.
  useEffect(() => () => { void ipc.browserClose().catch(() => {}); }, []);

  useEffect(() => {
    const off = [
      listen<{ url: string; loading: boolean }>("browser-state", ({ payload }) => {
        setLoading(payload.loading);
        if (payload.loading) setPick(false); // a new page starts without the picker
        if (!payload.loading) {
          setAddress(payload.url);
          if (useDesk.getState().layout.browserUrl !== payload.url) useDesk.getState().setLayout({ browserUrl: payload.url });
        }
      }),
      listen<string>("browser-title", ({ payload }) => setTitle(payload)),
      listen<Picked | null>("browser-pick", ({ payload }) => {
        if (!pickingRef.current) return;
        setPick(false);
        const project = activeProject();
        if (!payload || !project) return;
        handToAgent(project.path, pickedMessage(payload));
      }),
    ];
    return () => { off.forEach((p) => void p.then((f) => f())); };
  }, []);

  const go = async (to: string) => {
    if (!to.trim()) return;
    const el = host.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setError("");
    setLoading(true);
    try {
      await ipc.browserOpen(to, r.left, r.top, r.width, r.height);
      setCreated(true);
    } catch (e) {
      setError(errorText(e));
      setLoading(false);
    }
  };
  // Reopening Desk with the browser open goes back to the last page.
  useEffect(() => { if (url) void go(url); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = () => {
    const next = !picking;
    setPick(next);
    void ipc.browserCommand(next ? "pick" : "unpick").catch(() => {});
  };
  const close = () => useDesk.getState().setLayout({ browserOpen: false });

  return (
    <section className="browser-pane" aria-label="Browser">
      <header className="browser-bar">
        <button className="icon-btn" aria-label="Back" disabled={!created} onClick={() => void ipc.browserCommand("back")}><ArrowLeft size={14} /></button>
        <button className="icon-btn" aria-label="Forward" disabled={!created} onClick={() => void ipc.browserCommand("forward")}><ArrowRight size={14} /></button>
        <button className="icon-btn" aria-label="Reload" disabled={!created} onClick={() => void ipc.browserCommand("reload")}>{loading ? <LoaderCircle size={13} className="is-spinning" /> : <RotateCw size={13} />}</button>
        <form className="browser-address" onSubmit={(e) => { e.preventDefault(); void go(address); }}>
          <Globe size={12} />
          <input value={address} spellCheck={false} placeholder="localhost:3000 or a web address" aria-label="Address" title={title} onChange={(e) => setAddress(e.target.value)} onFocus={(e) => e.currentTarget.select()} />
        </form>
        <button className={"icon-btn" + (picking ? " is-on" : "")} aria-pressed={picking} aria-label="Pick an element for the agent" title="Design mode: click an element on the page to send its HTML and styles to the agent (Esc to stop)" disabled={!created} onClick={pick}><MousePointerClick size={14} /></button>
        <button className="icon-btn" aria-label="Open in your browser" title="Open in your browser" disabled={!address} onClick={() => void ipc.openExternal(/^\w+:\/\//.test(address) ? address : `http://${address}`)}><ExternalLink size={13} /></button>
        <button className="icon-btn" aria-label="Close browser" title="Close browser" onClick={close}><X size={14} /></button>
      </header>
      {picking && <p className="browser-hint">Click an element on the page. It goes to the agent's message box with its HTML and styles. Esc stops.</p>}
      <div className="browser-host" ref={host}>
        {!created && (
          <div className="browser-start">
            <Globe size={20} />
            <strong>Preview your app</strong>
            <span>Type an address above, or pick a local server. Pages open in a native web view that closes with this panel.</span>
            <div className="browser-suggest">{SUGGESTED.map((u) => <button key={u} className="mini-btn" onClick={() => { setAddress(u); void go(u); }}>{u}</button>)}</div>
            {error && <p className="form-error">{error}</p>}
          </div>
        )}
      </div>
    </section>
  );
}
