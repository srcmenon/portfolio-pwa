const CACHE_NAME = "portfolio-pwa-v2.3";

const STATIC_ASSETS = [
"/",
"/index.html",
"/style.css",
"/app.js",
"/db.js",
"/manifest.json",
"/logo.png",
"https://cdn.jsdelivr.net/npm/chart.js"
];

/* INSTALL */

self.addEventListener("install", event => {
event.waitUntil(
caches.open(CACHE_NAME).then(cache => {
return cache.addAll(STATIC_ASSETS);
})
);
self.skipWaiting();
});

/* ACTIVATE */

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

/* FETCH */

self.addEventListener("fetch", event => {

const url = new URL(event.request.url);

/* NEVER cache API calls */

if(url.pathname.startsWith("/api/")){
return;
}

/* Cache-first strategy for static files */

event.respondWith(
caches.match(event.request).then(cached => {

if(cached){
return cached;
}

return fetch(event.request).then(response => {

const copy = response.clone();

caches.open(CACHE_NAME).then(cache=>{
cache.put(event.request, copy);
});

return response;

});

})
);

});
