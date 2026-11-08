/* Desk landing page — theme, motion, nav, tour tabs, reveals and the pixel-wave backdrop. */
(() => {
  const root = document.documentElement;
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
  };
  const systemDark = matchMedia("(prefers-color-scheme: dark)");
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const isLight = () => root.dataset.theme ? root.dataset.theme === "light" : !systemDark.matches;
  const motionOn = () => root.dataset.motion !== "off" && !reduced.matches;

  /* ── Theme ── */
  const themeButtons = document.querySelectorAll("[data-theme-toggle]");
  const syncThemeUI = () => {
    const next = isLight() ? "dark" : "light";
    themeButtons.forEach((b) => b.setAttribute("aria-label", `Switch to ${next} theme`));
    document.querySelectorAll("[data-theme-label]").forEach((el) => (el.textContent = isLight() ? "Light" : "Dark"));
    pixels.forEach((p) => p.restart());
  };
  themeButtons.forEach((b) =>
    b.addEventListener("click", () => {
      const next = isLight() ? "dark" : "light";
      // Back to "follow the system" when the choice matches it.
      if ((next === "dark") === systemDark.matches) { delete root.dataset.theme; store.set("desk-site-theme", null); }
      else { root.dataset.theme = next; store.set("desk-site-theme", next); }
      syncThemeUI();
    })
  );
  systemDark.addEventListener("change", () => syncThemeUI());

  /* ── Motion ── */
  const motionBtn = document.querySelector("[data-motion-toggle]");
  const syncMotionUI = () => motionBtn && motionBtn.setAttribute("aria-pressed", String(root.dataset.motion !== "off"));
  motionBtn?.addEventListener("click", () => {
    if (root.dataset.motion === "off") { delete root.dataset.motion; store.set("desk-site-motion", null); }
    else { root.dataset.motion = "off"; store.set("desk-site-motion", "off"); }
    syncMotionUI();
    pixels.forEach((p) => p.restart());
  });
  reduced.addEventListener("change", () => pixels.forEach((p) => p.restart()));

  /* ── Nav ── */
  const nav = document.querySelector("[data-nav]");
  const onScroll = () => nav.classList.toggle("scrolled", scrollY > 24);
  addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  const menuBtn = document.querySelector("[data-menu-toggle]");
  const menu = document.getElementById("mobile-menu");
  const setMenu = (open) => {
    menu.hidden = !open;
    menuBtn.setAttribute("aria-expanded", String(open));
    menuBtn.setAttribute("aria-label", open ? "Close menu" : "Open menu");
  };
  menuBtn.addEventListener("click", () => setMenu(menu.hidden));
  menu.addEventListener("click", (e) => { if (e.target.closest("a")) setMenu(false); });
  addEventListener("keydown", (e) => { if (e.key === "Escape" && !menu.hidden) { setMenu(false); menuBtn.focus(); } });

  /* ── Tour tabs (WAI-ARIA tabs with arrow keys) ── */
  const tabs = [...document.querySelectorAll('[data-tour] [role="tab"]')];
  const select = (tab, focus) => {
    tabs.forEach((t) => {
      const on = t === tab;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
      document.getElementById(t.getAttribute("aria-controls")).hidden = !on;
    });
    if (focus) tab.focus();
    tab.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  };
  tabs.forEach((t, i) => {
    t.addEventListener("click", () => select(t));
    t.addEventListener("keydown", (e) => {
      const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
      if (d) { e.preventDefault(); select(tabs[(i + d + tabs.length) % tabs.length], true); }
      if (e.key === "Home") { e.preventDefault(); select(tabs[0], true); }
      if (e.key === "End") { e.preventDefault(); select(tabs[tabs.length - 1], true); }
    });
  });

  /* ── Accent preview (Themes tile) ── */
  const swatches = [...document.querySelectorAll("[data-accent]")];
  swatches.forEach((s) =>
    s.addEventListener("click", () => {
      const a = s.dataset.accent;
      if (a === "electric") delete root.dataset.accent; else root.dataset.accent = a;
      swatches.forEach((x) => x.setAttribute("aria-checked", String(x === s)));
      pixels.forEach((p) => p.restart());
    })
  );

  /* ── Reveal on scroll ── */
  const io = new IntersectionObserver(
    (entries) => entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } }),
    { rootMargin: "0px 0px -8% 0px", threshold: 0.08 }
  );
  document.querySelectorAll(".reveal").forEach((el) => io.observe(el));

  /* ── Pixel waves ──────────────────────────────────────────────
     Two rolling crests of square pixels (6 alpha levels), ~5% warm
     sparks, a dithered haze that stays clear in the middle, and a few
     twinkling stars. Colours come from CSS vars at draw time.
     24 fps (12 for strips), paused off-screen / hidden tab, one still
     frame when motion is off. */
  const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);

  function Pixels(canvas) {
    const ctx = canvas.getContext("2d");
    const full = canvas.dataset.pixels === "full";
    const fps = full ? 24 : 12;
    let raf = 0, last = 0, visible = true, colors;

    const readColors = () => {
      const css = getComputedStyle(root);
      colors = {
        wave: css.getPropertyValue("--wave-rgb").trim() || "2, 151, 222",
        spark: css.getPropertyValue("--spark-rgb").trim() || "252, 115, 77",
        alpha: parseFloat(css.getPropertyValue("--wave-alpha")) || 0.4,
        star: css.getPropertyValue("--star-rgb").trim() || "255, 255, 255",
        light: isLight(),
      };
    };
    const resize = () => {
      const dpr = Math.min(devicePixelRatio || 1, 2);
      canvas.width = Math.round(canvas.clientWidth * dpr);
      canvas.height = Math.round(canvas.clientHeight * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const draw = (time) => {
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (!w || !h) return;
      const t = time / 1000;
      ctx.clearRect(0, 0, w, h);
      const cell = full ? 5 : 4, gap = full ? 4 : 3, step = cell + gap;
      const cols = Math.ceil(w / step), rows = Math.ceil(h / step);
      const levels = 6;
      const base = full ? 0.6 : 0.42;
      const buckets = Array.from({ length: levels + 1 }, () => []);
      const sparks = [], haze = [], stars = [];
      const epoch = Math.floor(t * 0.6);

      if (full) {
        for (let c = 0; c < cols; c++) {
          const x = c / Math.max(cols - 1, 1);
          for (let r = 0; r < rows; r++) {
            const y = r / Math.max(rows - 1, 1);
            if (y > 0.6) break;
            const n = 0.5 + 0.22 * Math.sin(c * 0.043 + t * 0.06) + 0.18 * Math.sin(r * 0.071 - c * 0.019 + 1.3 + t * 0.04) + 0.12 * Math.sin((c + r) * 0.11 - t * 0.08);
            // Clear in the middle where the headline sits; clouds toward the edges.
            const fall = Math.max(0, 1 - y / 0.6) * Math.min(1, Math.max(0, Math.abs(x - 0.5) * 2.6 - 0.35));
            const v = Math.min(1, Math.max(0, (n - 0.42) * 2.4)) * fall;
            let hsh = (Math.imul(c, 2654435761) ^ Math.imul(r, 40503)) >>> 0;
            hsh ^= hsh >>> 15; hsh = Math.imul(hsh, 0x2c1b3c6d) >>> 0; hsh ^= hsh >>> 12;
            const th = 0.7 * ((hsh & 1023) / 1023) + 0.3 * BAYER[(c & 3) + (r & 3) * 4];
            if (v * 0.85 > th) haze.push(c * step, r * step);
            if (y < 0.5 && hsh % 1000 < 3 && Math.abs(x - 0.5) > 0.22) stars.push(c * step + cell / 2, r * step + cell / 2, (hsh >>> 10) % 7);
          }
        }
      }

      for (let c = 0; c < cols; c++) {
        const crest = base + 0.08 * Math.sin(c * 0.07 + t * 0.55) + 0.05 * Math.sin(c * 0.031 - t * 0.35);
        const crest2 = crest + 0.14 + 0.05 * Math.sin(c * 0.11 - t * 0.7 + 1.7);
        for (let r = 0; r < rows; r++) {
          const y = r / Math.max(rows - 1, 1);
          const band = (wv, f) => { const d = y - wv; return d < 0 ? Math.max(0, 1 + d * 22) * 0.55 : Math.exp(-d * f); };
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
      ctx.fillStyle = `rgba(${colors.spark}, 0.65)`;
      for (let i = 0; i < sparks.length; i += 2) ctx.fillRect(sparks[i], sparks[i + 1], cell, cell);
    };

    const loop = (time) => {
      raf = requestAnimationFrame(loop);
      if (document.hidden || !visible || time - last < 1000 / fps) return;
      last = time;
      draw(time);
    };
    const restart = () => {
      cancelAnimationFrame(raf);
      readColors();
      resize();
      if (!motionOn()) draw(4000);
      else raf = requestAnimationFrame(loop);
    };

    new ResizeObserver(restart).observe(canvas);
    new IntersectionObserver(([e]) => { visible = e.isIntersecting; }).observe(canvas);
    return { restart };
  }

  const pixels = [...document.querySelectorAll("canvas[data-pixels]")].map(Pixels);
  syncThemeUI();
  syncMotionUI();
})();
