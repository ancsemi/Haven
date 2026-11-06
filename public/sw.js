// ═══════════════════════════════════════════════════════════
// Haven: Service Worker for Push Notifications
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
    icon: payload.icon || '/icon-192.svg',
    badge: '/icon-192.svg',
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

  const targetUrl = event.notification.data?.url || '/app';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      // If Haven is already open, focus it and navigate
      for (const client of windowClients) {
        if (client.url.includes('/app')) {
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

// Activate immediately; don't wait for old SW to die
self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});

// A client (another open tab/device) marked the channel read: close any of
// our own push notifications for it so the badge/toast doesn't linger after
// the message has already been seen elsewhere.
self.addEventListener('message', (event) => {
  if (event.data?.type !== 'close-channel-notifications' || !event.data.channelCode) return;
  const tag = `haven-${event.data.channelCode}`;
  event.waitUntil(
    self.registration.getNotifications({ tag }).then((notifications) => {
      for (const notification of notifications) notification.close();
    })
  );
});
