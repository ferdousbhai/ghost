/**
 * Keeps the app shell, and nothing else, so SummonGhost opens without a
 * connection. Network first: an online visit always gets the deployed files
 * and refreshes the copy. Requests to machines are never touched.
 */
const CACHE = "summonghost-shell";
const SHELL = [
  "/", "/app.css", "/js/app.js", "/js/net.js", "/js/store.js", "/js/push.js", "/js/markdown.js", "/js/tool-call.js",
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

// An alert from one of the owner's machines: a ghost finished a turn. The
// conversation the owner is looking at needs none.
self.addEventListener("push", (event) => {
  let alert = {};
  try { alert = event.data.json(); } catch {}
  const url = typeof alert.url === "string" && alert.url.startsWith(self.location.origin + "/") ? alert.url : "/";
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((open) => {
    if (open.some((client) => client.focused && client.url === url)) return;
    return self.registration.showNotification(String(alert.title || alert.ghost || "Ghost"), {
      body: String(alert.body || ""), tag: String(alert.tag || "ghost"), icon: "/icons/icon-192.png", badge: "/icons/icon-192.png", data: { url },
    });
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/";
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((open) => {
    const app = open.find((client) => new URL(client.url).origin === self.location.origin);
    return app ? app.navigate(url).then((client) => (client || app).focus()) : self.clients.openWindow(url);
  }));
});
