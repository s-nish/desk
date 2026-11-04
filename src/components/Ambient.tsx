import { useEffect, useRef } from "react";
import { useDesk } from "../store";
import { resolvedTheme } from "../appearance";
import { PIXEL_THEMES } from "../themeCatalog";

/** Whether the resolved theme uses the full pixel styling layer (serif display,
 *  pill buttons). The backdrop itself shows on every theme. */
export function usePixelTheme() {
  useDesk((s) => s.preferences.theme);
  return PIXEL_THEMES.has(resolvedTheme());
}

/** "#0297de" / "rgb(2, 151, 222)" -> "2, 151, 222". */
function rgbOf(color: string): string | null {
  const c = color.trim();
  const hex = c.match(/^#([0-9a-f]{3}|[0-9a-f]{6})/i)?.[1];
  if (hex) {
    const full = hex.length === 3 ? hex.split("").map((x) => x + x).join("") : hex;
    return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)).join(", ");
  }
  const m = c.match(/rgba?\(([^)]+)\)/);
  return m ? m[1].split(",").slice(0, 3).map((x) => x.trim()).join(", ") : null;
}

// 4×4 ordered (Bayer) dither thresholds, 0..1.
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);

/**
 * Backdrop for every theme: a glow over a warm base, vertical light streaks and
 * slowly rolling pixel waves (2D canvas). Colors come from the theme's CSS
 * variables (--wave-rgb, --spark-rgb, --wave-alpha), read at draw time.
 *
 * Only on Home/launcher screens and as a short strip in the sidebar footer;
 * never behind terminals, editors or conversations. Pauses while the window is
 * hidden, and draws one still frame when animation is off or reduce motion is on.
 */
export function Ambient({ variant = "full" }: { variant?: "full" | "strip" }) {
  const theme = useDesk((s) => s.preferences.theme);
  const animated = useDesk((s) => s.preferences.animatedBackground);
  const reduceMotion = useDesk((s) => s.preferences.reduceMotion);
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const still = () => !animated || reduceMotion || media.matches;
    const fps = variant === "strip" ? 12 : 24;
    let raf = 0;
    let last = 0;
    let colors = { wave: "2, 151, 222", spark: "252, 115, 77", alpha: 0.42, star: "255, 255, 255", light: false };

    // Pixel themes set --wave-rgb etc.; every other theme borrows its accent
    // (neutral themes get soft greys) with a cantaloupe spark.
    const readColors = () => {
      const root = document.documentElement;
      const css = getComputedStyle(root);
      const light = root.dataset.colorScheme === "light";
      const accent = rgbOf(css.getPropertyValue("--ui-accent")) ?? rgbOf(css.getPropertyValue("--accent")) ?? rgbOf(css.getPropertyValue("--text")) ?? colors.wave;
      colors = {
        wave: css.getPropertyValue("--wave-rgb").trim() || accent,
        spark: css.getPropertyValue("--spark-rgb").trim() || "252, 115, 77",
        alpha: parseFloat(css.getPropertyValue("--wave-alpha")) || (light ? 0.2 : 0.3),
        star: light ? "20, 20, 20" : "255, 255, 255",
        light,
      };
    };

    const resize = () => {
      const dpr = Math.min(devicePixelRatio || 1, 2);
      canvas.width = Math.round(canvas.clientWidth * dpr);
      canvas.height = Math.round(canvas.clientHeight * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const draw = (time: number) => {
      const w = canvas.clientWidth, h = canvas.clientHeight;
      const t = time / 1000;
      ctx.clearRect(0, 0, w, h);
      const cell = variant === "strip" ? 4 : 5, gap = variant === "strip" ? 3 : 4, step = cell + gap;
      const cols = Math.ceil(w / step), rows = Math.ceil(h / step);
      const levels = 6;
      const full = variant === "full";
      // Full screens: the waves sit low; above them a dithered haze and a few stars.
      const base = full ? 0.8 : 0.45;
      const buckets: number[][] = Array.from({ length: levels + 1 }, () => []);
      const sparks: number[] = [];
      const epoch = Math.floor(t * 0.6);
      const haze: number[] = [];
      const stars: number[] = [];
      if (full) {
        for (let c = 0; c < cols; c++) {
          const x = c / Math.max(cols - 1, 1);
          for (let r = 0; r < rows; r++) {
            const y = r / Math.max(rows - 1, 1);
            if (y > 0.82) break;
            // Soft drifting clouds, densest at the top and toward the sides.
            const n = 0.5 + 0.22 * Math.sin(c * 0.043 + t * 0.06) + 0.18 * Math.sin(r * 0.071 - c * 0.019 + 1.3 + t * 0.04) + 0.12 * Math.sin((c + r) * 0.11 - t * 0.08);
            // Clear in the middle where the content sits, clouds toward the edges.
            const fall = Math.max(0, 1 - y / 0.82) * (0.18 + 0.82 * Math.min(1, Math.abs(x - 0.5) * 2.4));
            const v = Math.min(1, Math.max(0, (n - 0.42) * 2.4)) * fall;
            let hsh = (Math.imul(c, 2654435761) ^ Math.imul(r, 40503)) >>> 0;
            hsh ^= hsh >>> 15; hsh = Math.imul(hsh, 0x2c1b3c6d) >>> 0; hsh ^= hsh >>> 12;
            // Stipple: a per-cell random threshold mixed with a little Bayer order.
            const th = 0.7 * ((hsh & 1023) / 1023) + 0.3 * BAYER[(c & 3) + (r & 3) * 4];
            if (v * 0.85 > th) haze.push(c * step, r * step);
            if (y < 0.6 && hsh % 1000 < 4) stars.push(c * step + cell / 2, r * step + cell / 2, (hsh >>> 10) % 7);
          }
        }
      }
      for (let c = 0; c < cols; c++) {
        const crest = base + 0.08 * Math.sin(c * 0.07 + t * 0.55) + 0.05 * Math.sin(c * 0.031 - t * 0.35);
        const crest2 = crest + 0.14 + 0.05 * Math.sin(c * 0.11 - t * 0.7 + 1.7);
        for (let r = 0; r < rows; r++) {
          const y = r / Math.max(rows - 1, 1);
          const band = (wv: number, f: number) => { const d = y - wv; return d < 0 ? Math.max(0, 1 + d * 22) * 0.55 : Math.exp(-d * f); };
          let a = Math.max(band(crest, 3.2), band(crest2, 4.5) * 0.8);
          a *= 0.55 + 0.45 * Math.sin(c * 0.9 + r * 0.55 + t * 1.6);
          const lvl = Math.round(a * levels);
          if (lvl <= 0) continue;
          let hsh = (Math.imul(c, 73856093) ^ Math.imul(r, 19349663) ^ Math.imul(epoch, 83492791)) >>> 0;
          hsh ^= hsh >>> 13; hsh = Math.imul(hsh, 0x5bd1e995) >>> 0; hsh ^= hsh >>> 15;
          if (lvl >= levels - 1 && hsh % 100 < 5) sparks.push(c * step, r * step);
          else buckets[Math.min(lvl, levels)].push(c * step, r * step);
        }
      }
      if (haze.length) {
        ctx.fillStyle = `rgba(${colors.wave}, ${colors.alpha * (colors.light ? 0.4 : 0.5)})`;
        for (let i = 0; i < haze.length; i += 2) ctx.fillRect(haze[i], haze[i + 1], cell - 1, cell - 1);
      }
      for (let i = 0; i < stars.length; i += 3) {
        const tw = 0.35 + 0.35 * Math.sin(t * 1.3 + stars[i + 2]);
        ctx.fillStyle = `rgba(${colors.star}, ${(colors.light ? 0.28 : 0.55) * tw})`;
        ctx.fillRect(stars[i] - 1, stars[i + 1] - 1, 2, 2);
      }
      for (let l = 1; l <= levels; l++) {
        ctx.fillStyle = `rgba(${colors.wave}, ${(l / levels) * colors.alpha})`;
        const b = buckets[l];
        for (let i = 0; i < b.length; i += 2) ctx.fillRect(b[i], b[i + 1], cell, cell);
      }
      ctx.fillStyle = `rgba(${colors.spark}, 0.6)`;
      for (let i = 0; i < sparks.length; i += 2) ctx.fillRect(sparks[i], sparks[i + 1], cell, cell);
    };

    const loop = (time: number) => {
      raf = requestAnimationFrame(loop);
      if (document.hidden || time - last < 1000 / fps) return;
      last = time;
      draw(time);
    };

    const restart = () => {
      cancelAnimationFrame(raf);
      readColors();
      resize();
      if (still()) draw(4000); else raf = requestAnimationFrame(loop);
    };

    const observer = new ResizeObserver(restart);
    observer.observe(canvas);
    media.addEventListener("change", restart);
    restart();
    return () => { cancelAnimationFrame(raf); observer.disconnect(); media.removeEventListener("change", restart); };
  }, [theme, animated, reduceMotion, variant]);

  return (
    <div className={"ambient" + (variant === "strip" ? " is-strip" : "")} aria-hidden="true">
      <div className="ambient-glow" />
      <div className="ambient-streaks" />
      <canvas ref={ref} className="ambient-waves" />
    </div>
  );
}
