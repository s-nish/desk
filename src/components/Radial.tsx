// A fan of round buttons opening in an arc above a control: the agent picker and
// the "Run in" picker. Arrow keys move, Enter picks, Esc or a click outside closes.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface RadialItem {
  key: string;
  icon: React.ReactNode;
  /** Name shown in the middle while it's hovered or focused. */
  label: string;
  /** One line under the name. */
  sub?: string;
  on?: boolean;
  /** A small status dot: green ready, red not set up, amber needs a start. */
  dot?: "ok" | "bad" | "warn";
  /** A small corner badge (e.g. a cloud for a new sandbox). */
  badge?: React.ReactNode;
  disabled?: boolean;
  onSelect(): void;
}

/** Opens a radial menu from a button; returns what to render and how to open it. */
export function useRadial() {
  const [state, setState] = useState<{ at: { x: number; y: number }; lift: number; from: HTMLElement } | null>(null);
  const open = (from: HTMLElement) => {
    const r = from.getBoundingClientRect();
    // The fan opens above the message box (or the button), so it never covers what you're typing.
    const box = from.closest(".chat-composer")?.getBoundingClientRect();
    setState({ at: { x: r.left + r.width / 2, y: r.top + r.height / 2 }, lift: box ? Math.max(48, r.top + r.height / 2 - box.top + 34) : 48, from });
  };
  return { open, opened: !!state, state, close: () => setState(null) };
}

export function Radial({ state, items, label, onClosed }: {
  state: { at: { x: number; y: number }; lift: number; from: HTMLElement };
  items: RadialItem[];
  label: string;
  onClosed(): void;
}) {
  const [shown, setShown] = useState(false);
  const start = Math.max(0, items.findIndex((i) => i.on));
  const [hover, setHover] = useState(start);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const { at, lift } = state;

  useEffect(() => {
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => { setShown(true); refs.current[start]?.focus(); }));
    return () => cancelAnimationFrame(raf);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const close = (focus = true) => {
    setShown(false);
    setTimeout(onClosed, 180);
    if (focus) state.from.focus();
  };

  // Wider arcs for more items, and never past the window's edges.
  const n = items.length;
  const radius = Math.max(118, Math.min(200, 26 * n));
  const from = 180, to = 0;
  const shift = Math.max(30 - at.x + radius, Math.min(radius * 0.82, window.innerWidth - at.x - radius - 30));
  // Opens downward from a control near the top of the window (the tab bar).
  const down = at.y - radius - lift - 70 < 0;
  const dir = down ? 1 : -1;
  const spot = (i: number) => {
    const a = ((from + ((to - from) * i) / Math.max(1, n - 1)) * Math.PI) / 180;
    return { x: Math.cos(a) * radius + shift, y: dir * (Math.sin(a) * radius + lift) };
  };
  const cur = items[hover];
  const ox = 40 + radius - shift; // the svg's origin, relative to the hub
  const oy = down ? 30 - lift : radius + lift + 40;

  return createPortal(
    <div className={"radial" + (shown ? " is-shown" : "")} onMouseDown={(e) => { if (e.target === e.currentTarget) close(false); }} onKeyDown={(e) => {
      if (e.key === "Escape") { e.preventDefault(); close(); return; }
      const i = refs.current.findIndex((el) => el === document.activeElement);
      const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
      if (d) { e.preventDefault(); const k = (Math.max(i, 0) + d + n) % n; refs.current[k]?.focus(); setHover(k); }
    }}>
      <div className="radial-hub" style={{ left: at.x, top: at.y }} role="menu" aria-label={label}>
        <svg className="radial-arc" width={radius * 2 + 80} height={radius + 70} style={{ left: -ox, top: -oy }} aria-hidden="true">
          <path d={`M ${ox + spot(0).x} ${oy + spot(0).y} A ${radius} ${radius} 0 0 ${down ? 0 : 1} ${ox + spot(n - 1).x} ${oy + spot(n - 1).y}`} />
        </svg>
        {items.map((item, i) => {
          const p = spot(i);
          return (
            <button
              key={item.key}
              ref={(el) => { refs.current[i] = el; }}
              role="menuitemradio"
              aria-checked={!!item.on}
              aria-label={item.sub ? `${item.label}, ${item.sub}` : item.label}
              aria-disabled={item.disabled || undefined}
              className={"radial-item" + (item.on ? " is-on" : "") + (item.disabled ? " is-disabled" : "")}
              style={{ "--x": `${p.x}px`, "--y": `${p.y}px`, "--i": i } as React.CSSProperties}
              onMouseEnter={() => setHover(i)}
              onFocus={() => setHover(i)}
              onClick={() => { if (item.disabled) return; close(); item.onSelect(); }}
            >
              {item.icon}
              {item.dot && <span className={"radial-dot is-" + item.dot} aria-hidden="true" />}
              {item.badge && <span className="radial-badge" aria-hidden="true">{item.badge}</span>}
            </button>
          );
        })}
        <div className="radial-label" aria-live="polite" style={{ left: shift, top: dir * (lift + 34) }}>
          <strong>{cur?.label}</strong>
          {cur?.sub && <span>{cur.sub}</span>}
        </div>
      </div>
    </div>,
    document.body,
  );
}
