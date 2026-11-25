/**
 * Keeps the app shell, and nothing else, so SummonGhost opens without a
 * connection. Network first: an online visit always gets the deployed files
 * and refreshes the copy. Requests to machines are never touched.
 */
const CACHE = "summonghost-shell";
const SHELL = [
  "/", "/app.css", "/js/app.js", "/js/net.js", "/js/store.js", "/js/markdown.js", "/js/tool-call.js",
  "/manifest.webmanifest", "/icons/ghost.svg", "/icons/icon-192.png", "/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  const key = event.request.mode === "navigate" && url.pathname === "/" ? "/" : url.pathname;
  if (!SHELL.includes(key)) return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(key, copy));
        }
        return response;
      })
      .catch(() => caches.match(key).then((hit) => hit || Response.error())),
  );
});
