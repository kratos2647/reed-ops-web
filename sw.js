/**
 * MM VIRSA Ops — Service Worker (PWA + Android APK Offline Shell)
 * Caches static UI assets for instant mobile startup while keeping API/Sync live.
 */
const CACHE_NAME = 'reed-ops-v47';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './css/styles.css',
  './assets/virsa-icon.png',
  './assets/virsa-icon-192.png',
  './assets/virsa-logo.png',
  './js/security.js',
  './js/couriers.js',
  './js/aging.js',
  './js/audio.js',
  './js/storage.js',
  './js/cloud-sync.js',
  './js/tracking-api.js',
  './js/csv.js',
  './js/scanner.js',
  './js/app.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
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
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Always bypass cache for live APIs & cloud sync
  if (url.pathname.startsWith('/api/') || url.hostname.includes('google.com') || url.hostname.includes('sonic.pk') || url.hostname.includes('leopardscourier.com')) {
    return;
  }
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.status === 200 && url.origin === self.location.origin) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, clone));
        }
        return res;
      })
      .catch(() => caches.match(req))
  );
});
