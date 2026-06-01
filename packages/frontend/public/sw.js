// Minimal service worker for Claude Controller.
//
// Its primary job is to satisfy Android Chrome's WebAPK installability
// criteria (a registered SW with a fetch handler) so the app installs as a
// real PWA — honoring the manifest name + maskable icon — rather than a
// bookmark shortcut that gets a monogram label and a white icon plate.
//
// Strategy: network-first for navigations (so deploys show up immediately,
// falling back to the cached shell offline), cache-first for static assets.
// WebSocket / health / backend traffic is never intercepted.

const CACHE = "cc-shell-v1";
const SHELL = ["/", "/index.html", "/manifest.json"];

self.addEventListener("install", (event) => {
  // Precache per-item rather than addAll(): addAll is atomic, so one missing
  // entry would reject the whole install and silently leave the SW unactivated
  // (no offline support, no signal). allSettled lets a partial shell through and
  // logs what failed.
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url))))
      .then((results) => {
        const failed = results.filter((r) => r.status === "rejected").length;
        if (failed)
          console.warn(`[sw] shell precache incomplete: ${failed}/${SHELL.length} failed`);
        return self.skipWaiting();
      }),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle same-origin GETs; never touch the WS relay or health probe.
  if (
    request.method !== "GET" ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith("/ws") ||
    url.pathname.startsWith("/health")
  ) {
    return;
  }

  // Navigations: network-first, fall back to the cached app shell offline.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() => caches.match("/index.html").then((r) => r ?? Response.error())),
    );
    return;
  }

  // Static assets: cache-first, populate the cache on first fetch.
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok && response.type === "basic") {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    }),
  );
});
