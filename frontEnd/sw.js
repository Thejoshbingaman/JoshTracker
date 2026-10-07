// Service worker: runs in the background so the phone can show alerts
// even when JoshTracker is closed.

const CHECKLIST_CACHE = "checklist-v1";
const CHECKLIST_URL = new URL("checklist.html", self.registration.scope).href;

// Save the checklist page on install so it works with no signal
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CHECKLIST_CACHE)
      .then((cache) => cache.add(CHECKLIST_URL))
      .catch(() => {})
      .then(() => self.skipWaiting())
  );
});

// Only the checklist page is served offline. Everything else goes to the network as normal.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || !url.pathname.endsWith("/checklist.html")) return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CHECKLIST_CACHE).then((cache) => cache.put(CHECKLIST_URL, copy));
        return response;
      })
      .catch(() => caches.match(CHECKLIST_URL))
  );
});
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

// An alert arrives from the server
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }

  event.waitUntil(
    self.registration.showNotification(data.title || "JoshTracker", {
      body: data.body || "",
      icon: "icon-192.png?v=2",       // the app icon beside the alert (Android)
      badge: "badge-96.png?v=2",      // the small white plane in the status bar (Android)
      tag: data.tag,                  // same tag = replaces the older alert
      renotify: Boolean(data.tag),    // a replaced alert still buzzes
      vibrate: [80, 60, 80],
      timestamp: Date.now(),
      data: { url: data.url || "./" },
    })
  );
});

// Tapping the alert opens (or focuses) the app
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "./", self.registration.scope).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      for (const w of windows) {
        if (w.url.startsWith(self.registration.scope) && "focus" in w) return w.focus();
      }
      return self.clients.openWindow(target);
    })
  );
});
