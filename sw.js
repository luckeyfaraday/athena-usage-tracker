self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data?.json?.() || {};
  } catch {
    payload = {};
  }
  const title = payload.title || "Athena Usage Tracker";
  const options = {
    body: payload.body || "Usage status changed.",
    tag: payload.tag || "athena-usage",
    renotify: true,
    badge: payload.badge || "/",
    data: {
      url: payload.url || "/",
      accountId: payload.accountId || null,
    },
    timestamp: payload.timestamp || Date.now(),
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/";
  event.waitUntil((async () => {
    const windows = await clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if ("focus" in client) {
        await client.focus();
        if ("navigate" in client) await client.navigate(url);
        return;
      }
    }
    await clients.openWindow(url);
  })());
});
