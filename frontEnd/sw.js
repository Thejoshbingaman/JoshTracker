// Service worker: runs in the background so the phone can show alerts
// even when JoshTracker is closed.

self.addEventListener("install", () => self.skipWaiting());
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
      icon: "icon-192.png",
      badge: "badge-96.png",
      tag: data.tag,          // same tag = replaces the older alert
      data: { url: data.url || "./" },
    })
  );
});

// Tapping the alert opens (or focuses) the app
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      for (const w of windows) {
        if ("focus" in w) return w.focus();
      }
      return self.clients.openWindow(event.notification.data?.url || "./");
    })
  );
});
