// Service worker: runs in the background so the phone can show alerts
// even when JoshTracker is closed, and opens the app instantly from saved files.

// ---------- Instant open ----------
// The app's own files are saved on the phone. Each open asks the network first
// (so updates arrive), but if the network is slow or gone, the saved copy shows within 2 seconds.

const APP_CACHE = "joshtracker-app-v2";
const SCOPE = self.registration.scope;
const APP_FILES = [
  "./", "index.html", "style.css", "app.js", "config.js", "manifest.json",
  "icon-192.png?v=3", "icon-512.png?v=3", "badge-96.png?v=3", "favicon.ico?v=3", "us-states.json",
].map((f) => new URL(f, SCOPE).href);

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(APP_CACHE)
      .then((cache) => cache.addAll(APP_FILES))
      .catch(() => {})
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== APP_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network first, saved copy as the fallback. Only our own files; Supabase, maps, and fonts go straight through.
self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || !url.href.startsWith(SCOPE)) return;

  event.respondWith((async () => {
    const cache = await caches.open(APP_CACHE);
    const network = fetch(req).then((res) => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    });
    network.catch(() => {});                                  // a late failure is fine
    const timeout = new Promise((resolve) => setTimeout(resolve, 2000));
    try {
      const first = await Promise.race([network, timeout]);
      if (first) return first;                                // network answered in time
      const saved = await cache.match(req, { ignoreSearch: req.mode === "navigate" });
      return saved || await network;                          // slow network: saved copy now
    } catch {
      const saved = await cache.match(req, { ignoreSearch: req.mode === "navigate" });
      return saved || Response.error();                       // no network at all
    }
  })());
});

// An alert arrives from the server
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }

  event.waitUntil((async () => {
    await self.registration.showNotification(data.title || "JoshTracker", {
      body: data.body || "",
      icon: "icon-192.png?v=3",       // the app icon beside the alert (Android)
      badge: "badge-96.png?v=3",      // the small white heart route in the status bar (Android)
      tag: data.tag,                  // same tag = replaces the older alert
      renotify: Boolean(data.tag),    // a replaced alert still buzzes
      vibrate: [80, 60, 80],
      timestamp: Date.now(),
      data: { url: data.url || "./" },
    });
    // Kiss/hug/punch: show how many are waiting as a number on the app icon
    if ((data.tag || "").startsWith("ping-") && self.navigator.setAppBadge) {
      try {
        const waiting = (await self.registration.getNotifications())
          .filter((n) => (n.tag || "").startsWith("ping-")).length;
        await self.navigator.setAppBadge(waiting || 1);
      } catch { /* badges not supported here */ }
    }
  })());
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
