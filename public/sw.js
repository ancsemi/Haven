// ═══════════════════════════════════════════════════════════
// Haven — Service Worker for Push Notifications
// Handles incoming push events and notification click actions
// ═══════════════════════════════════════════════════════════

self.addEventListener('push', (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: 'Haven', body: event.data.text() };
  }

  const title = payload.title || 'Haven';
  const options = {
    body: payload.body || '',
    icon: payload.icon || '/favicon.ico',
    badge: '/favicon.ico',
    tag: payload.tag || 'haven-message',       // collapse similar notifications
    renotify: true,                            // alert even if same tag
    data: {
      channelCode: payload.channelCode || null,
      url: payload.url || '/'
    }
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

// Click notification → focus Haven tab or open it
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const targetUrl = event.notification.data?.url || '/app.html';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      // If Haven is already open, focus it and navigate
      for (const client of windowClients) {
        if (client.url.includes('/app.html')) {
          client.focus();
          // Post the channel code so the app can switch channels
          if (event.notification.data?.channelCode) {
            client.postMessage({
              type: 'push-notification-click',
              channelCode: event.notification.data.channelCode
            });
          }
          return;
        }
      }
      // Otherwise open a new window
      return clients.openWindow(targetUrl);
    })
  );
});

// Activate immediately — don't wait for old SW to die
self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});
