/* ─────────────────────────────────────────────────────────
   CapIntel Service Worker
   BUMP THIS VERSION STRING every time you deploy new code.
   Safari/iPhone will only pick up changes when this string changes.
───────────────────────────────────────────────────────── */
const CACHE_NAME = "capintel-v8.1";

const PRECACHE = [
  "/",
  "/index.html",
  "/style.css",
  "/app.js",
  "/db.js",
  "/manifest.json"
];

/* ── INSTALL: pre-cache core files ── */
self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(PRECACHE))
  );
  self.skipWaiting();
});

/* ── ACTIVATE: delete ALL old caches ── */
self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

/* ── FETCH ── */
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);

  /* Never intercept API calls */
  if (url.pathname.startsWith("/api/")) return;

  /* Never intercept non-GET */
  if (event.request.method !== "GET") return;

  /* Icons, images, fonts → cache-first (they never change) */
  const isStatic = url.pathname.startsWith("/icons/") ||
                   url.pathname.startsWith("/fonts/") ||
                   url.hostname.includes("fonts.googleapis.com") ||
                   url.hostname.includes("fonts.gstatic.com") ||
                   url.pathname.match(/\.(png|jpg|webp|svg|ico|woff2?)$/);

  if (isStatic) {
    event.respondWith(
      caches.match(event.request).then(cached =>
        cached || fetch(event.request).then(res => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(event.request, copy));
          return res;
        })
      )
    );
    return;
  }

  /* HTML, JS, CSS → network-first with cache fallback.
     This ensures Safari/iPhone always gets the latest code.
     Falls back to cache only if offline. */
  event.respondWith(
    fetch(event.request)
      .then(res => {
        if (res && res.status === 200 && res.type !== "opaque") {
          const copy = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(event.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
