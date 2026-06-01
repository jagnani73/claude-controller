// Minimal service worker for Claude Controller.
//
// Its primary job is to satisfy Android Chrome's WebAPK installability
// criteria (a registered SW with a fetch handler) so the app installs as a
// real PWA — honoring the manifest name + maskable icon — rather than a
// bookmark shortcut that gets a monogram label and a white icon plate.
//
// Strategy: network-first for navigations and install-critical resources (the
// manifest + icons — so the browser always (re)mints the installed PWA from
// fresh metadata, never a pinned old name/icon), falling back to cache offline.
// Cache-first for content-hashed static assets. WS / health traffic is untouched.

const CACHE = "cc-shell-v1";
const SHELL = ["/", "/index.html", "/manifest.json"];

// Paths the browser re-reads when it installs or re-mints the home-screen PWA.
// These MUST stay fresh: a controlling SW that serves a stale manifest or icon
// here is exactly what freezes the install to an old app name / white icon, and
// it survives an uninstall+reinstall because the SW cache is origin-level state.
const INSTALL_CRITICAL = /^\/(manifest\.json|icon-[\w-]*\.png|apple-touch-icon\.png|logo\.png)$/;

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

  // Manifest + icons: network-first so install/re-mint always reads the live
  // files; the cache is only a same-path offline fallback, never a pin.
  if (INSTALL_CRITICAL.test(url.pathname)) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok && response.type === "basic") {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => caches.match(request).then((r) => r ?? Response.error())),
    );
    return;
  }

  // Other static assets (Vite content-hashed JS/CSS): cache-first, populate on first fetch.
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
