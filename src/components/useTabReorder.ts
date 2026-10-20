import { useEffect, useRef, useState, type PointerEvent, type RefObject } from "react";
import { useDesk, type DropZone } from "../store";
import { openInSplit } from "../actions";

/** Which part of the workspace the pointer is over: the outer fifth of each side splits, the middle shows the tab. */
function zoneAt(x: number, y: number): DropZone | null {
  const stage = document.querySelector(".stage")?.getBoundingClientRect();
  if (!stage || x < stage.left || x > stage.right || y < stage.top || y > stage.bottom) return null;
  const fx = (x - stage.left) / stage.width;
  const fy = (y - stage.top) / stage.height;
  const edges: [DropZone, number][] = [["left", fx], ["right", 1 - fx], ["top", fy], ["bottom", 1 - fy]];
  const [zone, distance] = edges.sort((a, b) => a[1] - b[1])[0];
  return distance < 0.28 ? zone : "center";
}

function setZone(zone: DropZone | null) {
  if (useDesk.getState().dropZone !== zone) useDesk.setState({ dropZone: zone });
}

/** Pointer dragging works in the desktop webview without intercepting file drops. */
export function useTabReorder(scroller: RefObject<HTMLDivElement | null>) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [landing, setLanding] = useState<{ before: string | null } | null>(null);
  const gesture = useRef<{ id: string; pointerId: number; startX: number; startY: number; x: number; y: number; dragging: boolean } | null>(null);
  const target = useRef<{ before: string | null } | null>(null);
  const suppressClick = useRef(false);

  useEffect(() => {
    let frame = 0;
    let clickTimer: number | undefined;
    const finish = () => {
      cancelAnimationFrame(frame);
      gesture.current = null;
      target.current = null;
      setDraggingId(null);
      setLanding(null);
      setZone(null);
      document.body.classList.remove("is-reordering-tabs");
    };
    const update = () => {
      const drag = gesture.current;
      const el = scroller.current;
      if (!drag?.dragging || !el) return;
      const rect = el.getBoundingClientRect();
      const inside = drag.y >= rect.top && drag.y <= rect.bottom && drag.x >= rect.left - 24 && drag.x <= rect.right + 24;
      let next: { before: string | null } | null = null;
      if (inside) {
        if (drag.x < rect.left + 36) el.scrollLeft -= 9;
        else if (drag.x > rect.right - 36) el.scrollLeft += 9;
        const before = Array.from(el.querySelectorAll<HTMLElement>('[data-tab-id]')).find((tab) => {
          if (tab.dataset.tabId === drag.id) return false;
          const box = tab.getBoundingClientRect();
          return drag.x < box.left + box.width / 2;
        });
        next = { before: before?.dataset.tabId ?? null };
        setZone(null);
      } else setZone(zoneAt(drag.x, drag.y));
      if ((target.current === null) !== (next === null) || target.current?.before !== next?.before) {
        target.current = next;
        setLanding(next);
      }
      frame = requestAnimationFrame(update);
    };
    const move = (e: globalThis.PointerEvent) => {
      const drag = gesture.current;
      if (!drag || e.pointerId !== drag.pointerId) return;
      drag.x = e.clientX; drag.y = e.clientY;
      if (!drag.dragging && Math.hypot(drag.x - drag.startX, drag.y - drag.startY) >= 6) {
        drag.dragging = true;
        suppressClick.current = true;
        setDraggingId(drag.id);
        document.body.classList.add("is-reordering-tabs");
        frame = requestAnimationFrame(update);
      }
      if (drag.dragging) e.preventDefault();
    };
    const up = (e: globalThis.PointerEvent) => {
      const drag = gesture.current;
      if (!drag || e.pointerId !== drag.pointerId) return;
      if (drag.dragging) {
        drag.x = e.clientX; drag.y = e.clientY;
        cancelAnimationFrame(frame);
        update();
      }
      const box = scroller.current?.getBoundingClientRect();
      if (drag.dragging && target.current && box && e.clientY >= box.top && e.clientY <= box.bottom && e.clientX >= box.left - 24 && e.clientX <= box.right + 24) {
        useDesk.getState().moveTab(drag.id, target.current.before);
      } else if (drag.dragging) {
        const zone = zoneAt(e.clientX, e.clientY);
        if (zone) openInSplit(drag.id, zone);
      }
      finish();
      clickTimer = window.setTimeout(() => { suppressClick.current = false; }, 0);
    };
    const cancel = () => { finish(); suppressClick.current = false; };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape" && gesture.current?.dragging) { e.preventDefault(); cancel(); } };
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", cancel);
    window.addEventListener("keydown", key);
    return () => {
      cancelAnimationFrame(frame); clearTimeout(clickTimer);
      document.body.classList.remove("is-reordering-tabs");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("keydown", key);
    };
  }, [scroller]);

  const start = (id: string, e: PointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
    suppressClick.current = false;
    gesture.current = { id, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, x: e.clientX, y: e.clientY, dragging: false };
  };
  return { draggingId, landing, start, suppressClick };
}
