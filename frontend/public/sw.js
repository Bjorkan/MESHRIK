/* Service worker for PWA installability and Web Push notifications. */

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// No-op fetch handler — required for PWA installability criteria.
// We don't cache anything; the app always fetches from the network.
self.addEventListener('fetch', () => {});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'New message', body: event.data?.text() || '' };
  }

  const title = data.title || 'New message';
  const options = {
    body: data.body || '',
    icon: '/favicon-256x256.png',
    badge: '/favicon-96x96.png',
    tag: data.tag || 'meshcore-push',
    data: { url_path: data.url_path || '/' },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const rawUrlPath = event.notification.data?.url_path;
  const urlPath = typeof rawUrlPath === 'string' && rawUrlPath.startsWith('/') ? rawUrlPath : '/';
  const appOrigin = `${self.location.origin}/`;
  const targetUrl = new URL(urlPath, appOrigin).href;

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (windowClients) => {
      // Focus an existing tab if one is open
      for (const client of windowClients) {
        if (client.url.startsWith(appOrigin)) {
          await client.focus();
          await client.navigate(targetUrl);
          return;
        }
      }
      // Otherwise open a new tab
      return clients.openWindow(targetUrl);
    })
  );
});
