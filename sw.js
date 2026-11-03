/* Crypto.M — notification click + local showNotification support (no remote VAPID). */
self.addEventListener("install", (e) => { e.waitUntil(self.skipWaiting()); });
self.addEventListener("activate", (e) => { e.waitUntil(self.clients.claim()); });

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const target = data.url || "./?early=" + encodeURIComponent(data.symbol || "") + "#picks";
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of all) {
      try {
        client.postMessage({ type: "mce-focus-early", symbol: data.symbol || "", url: target });
        if ("focus" in client) return client.focus();
      } catch (_) {}
    }
    if (self.clients.openWindow) return self.clients.openWindow(target);
  })());
});
