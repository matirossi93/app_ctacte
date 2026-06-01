/* Service Worker mínimo para cumplir criterios PWA (instalable) sin cachear agresivo.
   Estrategia: network-first para todo. No cacheamos /api/ ni HTML, porque son dinámicos.
   Solo entregamos una fallback offline simple si falla el fetch.

   Además: handlers de Web Push (push + notificationclick) para mostrar la
   notificación nativa cuando el server manda push y abrir la URL relevante al
   tocar la notif. */

const CACHE_NAME = 'semillero-pv-v2';
const OFFLINE_URL = '/';

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.add(OFFLINE_URL))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  // Nunca cachear API ni POST/PUT/DELETE.
  if (request.method !== 'GET' || new URL(request.url).pathname.startsWith('/api/')) return;

  event.respondWith(
    fetch(request).catch(() =>
      caches.match(OFFLINE_URL).then((r) => r || new Response('Offline', { status: 503 }))
    )
  );
});

// ─── Web Push ────────────────────────────────────────────────────────────────
self.addEventListener('push', (event) => {
  let payload = { title: 'Semillero', body: '', icon: '/icon-192.png', url: '/' };
  if (event.data) {
    try { payload = { ...payload, ...event.data.json() }; }
    catch { payload.body = event.data.text(); }
  }
  const options = {
    body: payload.body,
    icon: payload.icon || '/icon-192.png',
    badge: payload.badge || '/icon-192.png',
    tag: payload.tag,
    data: { url: payload.url || '/', ...(payload.data || {}) },
    requireInteraction: false,
    timestamp: Date.now(),
  };
  event.waitUntil(self.registration.showNotification(payload.title || 'Semillero', options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of allClients) {
      if ('focus' in c) {
        try { await c.focus(); } catch { }
        if ('navigate' in c) { try { await c.navigate(url); } catch { } }
        return;
      }
    }
    if (self.clients.openWindow) await self.clients.openWindow(url);
  })());
});
