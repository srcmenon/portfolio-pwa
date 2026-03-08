const CACHE = "portfolio-pwa-v2";

self.addEventListener("install", e => {
e.waitUntil(
caches.open(CACHE).then(cache => {
return cache.addAll([
"/",
"/index.html",
"/style.css",
"/app.js",
"/db.js"
]);
})
);
});

self.addEventListener("activate", event => {
event.waitUntil(
caches.keys().then(keys =>
Promise.all(
keys.filter(key => key !== CACHE_NAME)
.map(key => caches.delete(key))
)
)
);
});
