/* Service Worker for TruckerHub
   - Precaches core app shell assets for instant load offline.
   - Cache-first strategy for navigation and static assets.
*/

const PRECACHE = 'truckerhub-precache-v2';
const RUNTIME = 'truckerhub-runtime-v2';
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/style.css?v=1.0.1',
  '/app.js?v=1.0.1',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

const RUNTIME_CACHE_MAX_ENTRIES = 50;

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(PRECACHE).then((cache) => cache.addAll(PRECACHE_URLS))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.map((key) => {
        if (key !== PRECACHE && key !== RUNTIME) return caches.delete(key);
      })
    )).then(() => self.clients.claim())
  );
});

// Helper to trim cache size (simple LRU by insertion order)
async function trimCache(cacheName, maxItems) {
  const cache = await caches.open(cacheName);
  const requests = await cache.keys();
  if (requests.length <= maxItems) return;
  const removeCount = requests.length - maxItems;
  for (let i = 0; i < removeCount; i++) {
    await cache.delete(requests[i]);
  }
}

// Stale-while-revalidate for runtime resources
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // Navigation: network-first, fallback to cache
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).then(resp => {
        // update precache with latest index.html
        const copy = resp.clone();
        caches.open(PRECACHE).then(cache => cache.put('/index.html', copy));
        return resp;
      }).catch(() => caches.match('/index.html'))
    );
    return;
  }

  // For same-origin static assets: stale-while-revalidate using runtime cache
  if (url.origin === location.origin) {
    event.respondWith(
      caches.match(event.request).then(cachedResp => {
        const networkFetch = fetch(event.request).then(networkResp => {
          // store successful responses (status 200)
          if (networkResp && networkResp.status === 200) {
            const clone = networkResp.clone();
            caches.open(RUNTIME).then(cache => {
              cache.put(event.request, clone).then(() => trimCache(RUNTIME, RUNTIME_CACHE_MAX_ENTRIES));
            });
          }
          return networkResp;
        }).catch(() => null);

        // return cached if present immediately, otherwise wait for network
        return cachedResp || networkFetch.then(resp => resp || caches.match('/index.html'));
      })
    );
    return;
  }

  // Cross-origin requests: network-first, fallback to cache
  event.respondWith(
    fetch(event.request).then(resp => resp).catch(() => caches.match(event.request))
  );
});
