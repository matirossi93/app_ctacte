/* Service Worker mínimo para cumplir criterios PWA (instalable) sin cachear agresivo.
   Estrategia: network-first para todo. No cacheamos /api/ ni HTML, porque son dinámicos.
   Solo entregamos una fallback offline simple si falla el fetch. */

const CACHE_NAME = 'semillero-pv-v1';
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
