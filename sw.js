/* ------------------------------------------------------------------
   sw.js
   Service worker: network-first for data, cache-first for app shell.
   Paths are relative so the app also works from a GitHub Pages subpath.
   ------------------------------------------------------------------ */

const CACHE_NAME = 'reaktor-v2';
const STATIC_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './js/config.js',
  './js/utils.js',
  './js/api.js',
  './js/river.js',
  './js/weather.js',
  './js/entsoe.js',
  './js/charts.js',
  './js/ui.js',
  './js/main.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

// CDN assets are cached on first install; failures here must not break install.
const CDN_ASSETS = [
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js',
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap'
];

// Static ENTSO-E fallbacks. Best-effort pre-cache so the dashboard still has
// data when the page is opened offline for the first time.
const DATA_ASSETS = [
  './data/plants.json',
  './data/generation.json',
  './data/outages.json',
  './data/be-nuclear.json',
  './data/be-generation-mix.json',
  './data/fr-generation-mix.json',
  './data/aggregated-generation.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(STATIC_ASSETS).then(() =>
        Promise.allSettled(
          CDN_ASSETS.concat(DATA_ASSETS).map((url) => cache.add(url))
        )
      ))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // Data calls: network-first, cached response as fallback.
  const isData = url.pathname.startsWith('/api/') ||
    url.pathname.includes('/data/') ||
    url.hostname === 'hubeau.eaufrance.fr' ||
    url.hostname === 'api.open-meteo.com';

  if (isData) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
            return response;
          }
          // Upstream errors (e.g. a proxy 502) should also use cached data.
          return caches.match(event.request).then((cached) => cached || response);
        })
        .catch(() => caches.match(event.request).then((cached) =>
          cached || Response.error()
        ))
    );
    return;
  }

  // Static assets: cache-first, then network with runtime caching.
  event.respondWith(
    caches.match(event.request)
      .then((cached) => cached || fetch(event.request).then((response) => {
        // Opaque responses (cross-origin fonts, CDN scripts) are cacheable too.
        if (response.ok || response.type === 'opaque') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      }))
  );
});
