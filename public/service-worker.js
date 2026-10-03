self.addEventListener('push', (event) => {
  if (!event.data) {
    console.error('Received a push event without a notification payload.');
    return;
  }
  const data = event.data.json();
  event.waitUntil(self.registration.showNotification(data.title, {
    body: data.body,
    tag: data.tag,
    vibrate: [220, 100, 220],
    data: { url: data.url }
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data.url, self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
    const existing = clients.find((client) => new URL(client.url).origin === self.location.origin);
    if (existing) {
      existing.navigate(target);
      return existing.focus();
    }
    return self.clients.openWindow(target);
  }));
});
