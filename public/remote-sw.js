// The phone page's service worker. When your Mac is asleep or Desk is closed,
// Tailscale answers with an empty error and a reload would show a white page;
// this keeps the last page and its scripts, so the page opens, says the Mac is
// offline, and reconnects by itself. Only the page and its scripts are kept,
// never what Desk sends (that comes over /events, which this leaves alone).

const CACHE = "desk-phone-v1";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  const page = req.mode === "navigate" && url.pathname === "/";
  const asset = url.pathname.startsWith("/assets/");
  if (!page && !asset) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // Asset names change with their contents: a kept copy is always right.
    if (asset) {
      const kept = await cache.match(req);
      if (kept) return kept;
    }
    try {
      const res = await fetch(req);
      if (res.ok) await cache.put(page ? "/" : req, res.clone());
      // 401 (not paired) is the real answer; only "Desk isn't there" falls back.
      if (page && res.status >= 500) return (await cache.match("/")) ?? res;
      return res;
    } catch {
      const kept = await cache.match(page ? "/" : req);
      if (kept) return kept;
      throw new Error("offline");
    }
  })());
});
