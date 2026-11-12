// The notch page: a pure view of the feed the main window sends. Four states:
// hidden (nothing running), collapsed (wings either side of the camera), peek
// (one card that opens by itself for six seconds) and expanded (everything).

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ApprovalCard } from "../feedui/ApprovalCard";
import { ReplyField } from "../feedui/ReplyField";
import { Row } from "../feedui/Row";
import { UsageRing } from "../feedui/UsageRing";
import { EMPTY_PAYLOAD, newPeeks, replyTarget, type FeedAction, type FeedItem, type NotchGeometry, type NotchPayload } from "./protocol";

/** Width of each wing beside the camera. */
const WING = 76;
/** The concave corners where the shell meets the top of the screen. */
const EAR = 12;
const EXPANDED_WIDTH = 480;
const PEEK_WIDTH = 420;
const PILL_WIDTH = 176;
const MAX_CONTENT = 520;
const HOVER_OPEN_MS = 150;
const HOVER_CLOSE_MS = 380;
const PEEK_MS = 6000;
/** A little longer than the collapse, so the window shrinks after the shell has. */
const SHRINK_DELAY_MS = 300;

type Mode = "hidden" | "collapsed" | "peek" | "expanded";

const call = (cmd: string, args?: Record<string, unknown>) => void invoke(cmd, args).catch(() => {});
const act = (action: FeedAction) => call("notch_action", { action });

/** The 5×7 pixel "D" from Desk's icon. */
const GLYPH = ["####.", "#...#", "#...#", "#...#", "#...#", "#...#", "####."];
function PixelD() {
  return (
    <svg className="notch-d" width="10" height="14" viewBox="0 0 10 14" aria-hidden="true">
      {GLYPH.flatMap((line, y) => [...line].map((c, x) => (c === "#" ? <rect key={`${x}-${y}`} x={x * 2} y={y * 2} width="1.6" height="1.6" /> : null)))}
    </svg>
  );
}

function PixelWave() {
  return (
    <span className="notch-wave" aria-hidden="true">
      {[0, 1, 2, 3, 4].map((i) => <i key={i} style={{ animationDelay: `${-i * 140}ms` }} />)}
    </span>
  );
}

function useNow() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

export function Notch() {
  const [payload, setPayload] = useState<NotchPayload>(EMPTY_PAYLOAD);
  const [geo, setGeo] = useState<NotchGeometry | null>(null);
  const [hover, setHover] = useState(false);
  const [open, setOpen] = useState(false);
  const [peekId, setPeekId] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [typing, setTyping] = useState(false);
  const [keyed, setKeyed] = useState(false);
  const [answered, setAnswered] = useState<Record<string, "Allowed" | "Declined">>({});
  const [contentHeight, setContentHeight] = useState(0);
  const prevItems = useRef<FeedItem[]>([]);
  const content = useRef<HTMLDivElement>(null);
  const now = useNow();

  // Feed, geometry and hover from Rust.
  useEffect(() => {
    void invoke<{ payload: NotchPayload | null; geometry: NotchGeometry | null }>("notch_snapshot")
      .then((s) => {
        if (s.payload && typeof s.payload === "object" && "items" in s.payload) setPayload(s.payload);
        setGeo(s.geometry);
      })
      .catch(() => {});
    const offs = [
      listen<NotchPayload>("notch-feed", ({ payload }) => setPayload(payload)),
      listen<NotchGeometry | null>("notch-geometry", ({ payload }) => setGeo(payload)),
      listen<boolean>("notch-hover", ({ payload }) => setHover(payload)),
    ];
    return () => offs.forEach((off) => void off.then((f) => f()).catch(() => {}));
  }, []);

  const items = payload.items;
  const show = payload.enabled && items.length > 0 && !!geo && (geo.hasNotch || payload.otherScreens);

  // Peek when something starts waiting (or finishes) and Desk isn't showing it.
  useEffect(() => {
    const ids = newPeeks(prevItems.current, items, payload.peek, payload.onScreen);
    prevItems.current = items;
    if (ids.length && !open) setPeekId(ids[0]);
    // Answers are shown until the question is gone.
    setAnswered((a) => {
      const live = new Set(items.map((i) => i.approval?.requestId).filter(Boolean));
      const next = Object.fromEntries(Object.entries(a).filter(([id]) => live.has(id)));
      return Object.keys(next).length === Object.keys(a).length ? a : next;
    });
  }, [items, payload.peek, payload.onScreen, open]);

  useEffect(() => {
    if (!peekId || hover) return;
    const t = setTimeout(() => setPeekId(null), PEEK_MS);
    return () => clearTimeout(t);
  }, [peekId, hover]);

  // Hover opens after a beat and closes after a longer one, unless you're typing.
  useEffect(() => {
    if (!show) return;
    if (hover) {
      const t = setTimeout(() => setOpen(true), HOVER_OPEN_MS);
      return () => clearTimeout(t);
    }
    if (typing) return;
    const t = setTimeout(() => setOpen(false), HOVER_CLOSE_MS);
    return () => clearTimeout(t);
  }, [hover, typing, show]);

  const close = useCallback(() => {
    setOpen(false);
    setPeekId(null);
    setTyping(false);
    (document.activeElement as HTMLElement | null)?.blur?.();
    if (keyed) {
      call("notch_focus", { focus: false });
      setKeyed(false);
    }
  }, [keyed]);

  // Give the keyboard back as soon as it closes.
  useEffect(() => {
    if (!open && keyed && !typing) {
      call("notch_focus", { focus: false });
      setKeyed(false);
    }
  }, [open, keyed, typing]);

  const wantKeys = useCallback(() => {
    if (!keyed) {
      call("notch_focus", { focus: true });
      setKeyed(true);
    }
  }, [keyed]);

  const mode: Mode = !show ? "hidden" : open ? "expanded" : peekId && items.some((i) => i.id === peekId) ? "peek" : "collapsed";
  if (mode !== "expanded" && peekId && !items.some((i) => i.id === peekId)) queueMicrotask(() => setPeekId(null));

  const waiting = items.filter((i) => i.state === "waiting");
  const working = items.filter((i) => i.state === "working");
  const done = items.filter((i) => i.state === "done");
  const ordered = [...waiting, ...working, ...done];
  const sel = ordered.find((i) => i.id === selected)?.id ?? ordered[0]?.id ?? null;
  const target = replyTarget(ordered, sel);

  const answer = useCallback((item: FeedItem, allow: boolean) => {
    if (!item.approval || (allow && !item.approval.allowOnce)) return;
    setAnswered((a) => ({ ...a, [item.approval!.requestId]: allow ? "Allowed" : "Declined" }));
    act({ type: "answer", id: item.id, requestId: item.approval.requestId, allow });
  }, []);
  const openItem = useCallback((id: string) => {
    act({ type: "open", id });
    close();
  }, [close]);

  // Keys work once the notch has the keyboard (you clicked it or its reply field).
  useEffect(() => {
    if (mode !== "expanded") return;
    const onKey = (e: KeyboardEvent) => {
      const current = ordered.find((i) => i.id === sel);
      const asking = current?.approval ? current : waiting[0];
      if (e.key === "Escape") { e.preventDefault(); close(); return; }
      if (e.metaKey && e.key === "Enter" && asking) { e.preventDefault(); answer(asking, true); return; }
      if (e.metaKey && e.key === "Backspace" && asking) { e.preventDefault(); answer(asking, false); return; }
      if (e.metaKey && e.key.toLowerCase() === "o" && sel) { e.preventDefault(); openItem(sel); return; }
      if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !e.metaKey) {
        e.preventDefault();
        const i = ordered.findIndex((x) => x.id === sel);
        const next = ordered[(i + (e.key === "ArrowDown" ? 1 : -1) + ordered.length) % ordered.length];
        if (next) setSelected(next.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, ordered, sel, waiting, answer, close, openItem]);

  // Measure the open content so the shell (and the window) fit it.
  useLayoutEffect(() => {
    const el = content.current;
    if (!el) return;
    const measure = () => setContentHeight(Math.min(MAX_CONTENT, Math.ceil(el.scrollHeight)));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [mode]);

  const notchW = geo?.hasNotch ? geo.notchWidth : 0;
  const notchH = geo?.notchHeight ?? 32;
  const top = geo?.hasNotch ? notchH : 0;
  const collapsedW = geo?.hasNotch ? notchW + 2 * WING : PILL_WIDTH;
  const shell = useMemo(() => {
    // The content's own top padding already clears the camera.
    if (mode === "expanded") return { w: Math.max(EXPANDED_WIDTH, collapsedW), h: Math.max(notchH, contentHeight) };
    if (mode === "peek") return { w: Math.max(PEEK_WIDTH, collapsedW), h: Math.max(notchH, contentHeight) };
    return { w: collapsedW, h: notchH };
  }, [mode, collapsedW, top, contentHeight, notchH]);

  // The window grows before the shell opens and shrinks after it closes.
  const windowSize = useRef({ w: 0, h: 0 });
  useEffect(() => {
    const ears = geo?.hasNotch ? 2 * EAR : 0;
    const want = mode === "hidden" ? { w: 0, h: 0 } : { w: shell.w + ears, h: shell.h };
    const cur = windowSize.current;
    const grow = want.w > cur.w || want.h > cur.h;
    const apply = () => {
      windowSize.current = want;
      call("notch_resize", { width: want.w, height: want.h });
    };
    if (grow || cur.w === 0) {
      // Grow both ways at once, never smaller than now while the shell animates.
      const both = { w: Math.max(want.w, cur.w), h: Math.max(want.h, cur.h) };
      windowSize.current = both;
      call("notch_resize", { width: both.w, height: both.h });
      if (both.w === want.w && both.h === want.h) return;
    }
    const t = setTimeout(apply, SHRINK_DELAY_MS);
    return () => clearTimeout(t);
  }, [mode, shell.w, shell.h, geo?.hasNotch]);

  const reduced = payload.reduceMotion;
  const peekItem = items.find((i) => i.id === peekId);
  const keys = keyed;
  const rings = payload.rings ? payload.usage : [];

  return (
    <div className={"notch" + (reduced ? " is-reduced" : "") + (geo?.hasNotch ? " has-notch" : " is-pill") + " is-" + mode}>
      <div
        className="notch-shell"
        style={{ width: shell.w, height: mode === "hidden" ? notchH : shell.h }}
        onClick={() => {
          if (mode === "collapsed" || mode === "peek") { setOpen(true); setPeekId(null); wantKeys(); }
        }}
      >
        {(mode === "collapsed" || mode === "hidden") && (
          <div className="notch-wings" style={{ height: notchH }}>
            <span className="notch-wing is-left" style={{ width: geo?.hasNotch ? WING : undefined }}>
              <PixelD />
              <span className="notch-count">{working.length + waiting.length}</span>
            </span>
            {geo?.hasNotch && <span style={{ width: notchW }} />}
            <span className="notch-wing is-right" style={{ width: geo?.hasNotch ? WING : undefined }}>
              {waiting.length > 0 ? (
                <><span className="notch-wait" aria-label={`${waiting.length} waiting for you`} /><span className="notch-count">{waiting.length}</span></>
              ) : working.length > 0 ? <PixelWave /> : <span className="notch-done">✓</span>}
            </span>
          </div>
        )}
        {(mode === "expanded" || mode === "peek") && (
          <div className="notch-content" ref={content} style={{ paddingTop: top + 6 }}>
            {mode === "peek" && peekItem && (
              peekItem.approval
                ? <ApprovalCard item={peekItem} answered={answered[peekItem.approval.requestId] ?? null} selected={false} keys={false} onAnswer={(allow) => answer(peekItem, allow)} onOpen={() => openItem(peekItem.id)} onSelect={() => setOpen(true)} />
                : <Row item={peekItem} now={now} selected={false} onSelect={() => setOpen(true)} onOpen={() => openItem(peekItem.id)} />
            )}
            {mode === "expanded" && (
              <>
                <div className="notch-list" role="listbox" aria-label="Agents">
                  {waiting.length > 0 && <div className="notch-group"><span className="notch-mark is-waiting" />Waiting for you</div>}
                  {waiting.map((item) => item.approval
                    ? <ApprovalCard key={item.id} item={item} answered={answered[item.approval.requestId] ?? null} selected={item.id === sel} keys={keys} onAnswer={(allow) => answer(item, allow)} onOpen={() => openItem(item.id)} onSelect={() => setSelected(item.id)} />
                    : <Row key={item.id} item={item} now={now} selected={item.id === sel} onSelect={() => setSelected(item.id)} onOpen={() => openItem(item.id)} />)}
                  {working.length > 0 && <div className="notch-group"><span className="notch-mark is-working" />Working</div>}
                  {working.map((item) => (
                    <Row key={item.id} item={item} now={now} selected={item.id === sel} onSelect={() => setSelected(item.id)} onOpen={() => openItem(item.id)} onStop={() => act({ type: "stop", id: item.id })} />
                  ))}
                  {done.length > 0 && <div className="notch-group"><span className="notch-mark is-done">✓</span>Finished</div>}
                  {done.map((item) => (
                    <Row key={item.id} item={item} now={now} selected={item.id === sel} onSelect={() => setSelected(item.id)} onOpen={() => openItem(item.id)} onDismiss={() => act({ type: "seen", id: item.id })} />
                  ))}
                </div>
                <ReplyField
                  target={target}
                  onSend={(text) => target && act({ type: "reply", id: target.id, text })}
                  onWantKeys={wantKeys}
                  onFocusChange={setTyping}
                />
                <div className="notch-foot">
                  {rings.map((r) => (
                    <span key={r.account} className="notch-ring" title={`${r.name}: ${Math.round(r.used)}% of the 5-hour limit used`}>
                      <UsageRing used={r.used} color={r.color} />
                      {r.name} {Math.round(r.used)}%
                    </span>
                  ))}
                  {payload.preview && <span className="notch-preview">Preview</span>}
                  <button className="feed-link notch-open" onClick={() => openItem("")}>Open Desk</button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
