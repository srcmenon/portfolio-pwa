const CACHE = "portfolio-v1";

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

self.addEventListener("fetch", event => {
event.respondWith(
caches.match(event.request).then(res => {
return res || fetch(event.request);
})
);
});