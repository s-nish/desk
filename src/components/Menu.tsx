import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { create } from "zustand";
import { Check } from "lucide-react";
import type { MenuItem } from "../types";

interface MenuState {
  menu: { x: number; y: number; items: MenuItem[]; minWidth?: number } | null;
  open(at: { x: number; y: number } | Element, items: MenuItem[]): void;
  close(): void;
}

export const useMenu = create<MenuState>((set) => ({
  menu: null,
  open(at, items) {
    if (at instanceof Element) {
      const r = at.getBoundingClientRect();
      set({ menu: { x: r.left, y: r.bottom + 4, items, minWidth: r.width } });
    } else {
      set({ menu: { x: at.x, y: at.y, items } });
    }
  },
  close() {
    set({ menu: null });
  },
}));

export function openMenu(at: { x: number; y: number } | Element, items: MenuItem[]) {
  useMenu.getState().open(at, items);
}

export function MenuLayer() {
  const menu = useMenu((s) => s.menu);
  const close = useMenu((s) => s.close);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [active, setActive] = useState(-1);

  useLayoutEffect(() => {
    if (!menu || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setPos({
      x: Math.max(8, Math.min(menu.x, window.innerWidth - r.width - 8)),
      y: menu.y + r.height > window.innerHeight - 8 ? Math.max(8, menu.y - r.height - 8) : menu.y,
    });
    setActive(-1);
    ref.current.focus();
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const onBlur = () => close();
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [menu, close]);

  if (!menu) return null;
  const selectable = menu.items.map((it, i) => (it.separator || it.disabled || it.swatches ? -1 : i)).filter((i) => i >= 0);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); return close(); }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const at = selectable.indexOf(active);
      const next = e.key === "ArrowDown" ? (at + 1) % selectable.length : (at - 1 + selectable.length) % selectable.length;
      setActive(selectable[next] ?? -1);
    }
    if (e.key === "Enter" && active >= 0) {
      e.preventDefault();
      close();
      menu.items[active].onSelect?.();
    }
  };

  return (
    <div
      ref={ref}
      className="menu"
      role="menu"
      tabIndex={-1}
      onKeyDown={onKey}
      style={{ left: pos.x, top: pos.y, minWidth: Math.max(menu.minWidth ?? 0, 200) }}
    >
      {menu.items.map((item, i) => {
        if (item.separator) return <div key={i} className="menu-sep" />;
        if (item.swatches) {
          const sw = item.swatches;
          return (
            <div key={i} className="menu-swatches">
              {sw.colors.map((c) => (
                <button
                  key={c}
                  className={"swatch" + (c === sw.current ? " is-current" : "")}
                  style={{ background: c }}
                  aria-label={`Color ${c}`}
                  onClick={() => {
                    close();
                    sw.onPick(c);
                  }}
                />
              ))}
            </div>
          );
        }
        return (
          <button
            key={i}
            role="menuitem"
            className={"menu-item" + (item.danger ? " is-danger" : "") + (i === active ? " is-active" : "")}
            disabled={item.disabled}
            onMouseEnter={() => setActive(i)}
            onClick={() => {
              close();
              item.onSelect?.();
            }}
          >
            <span className="menu-icon">{item.checked ? <Check size={14} /> : item.icon}</span>
            <span className="menu-label">{item.label}</span>
            {item.hint && <span className="menu-hint">{item.hint}</span>}
          </button>
        );
      })}
    </div>
  );
}
