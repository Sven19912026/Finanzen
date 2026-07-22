const CACHE_NAME = 'schulden-pwa-v16-sync-fix';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './firebase-config.js',
  './cloud-sync.js?v=16',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(async cache => {
        for(const url of ASSETS){
          try{
            const response = await fetch(url, { cache: 'reload' });
            if(response.ok) await cache.put(url, response);
          }catch(error){
            console.warn('Datei konnte nicht vorab gespeichert werden:', url, error);
          }
        }
      })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  if(event.request.method !== 'GET') return;
  event.respondWith(
    fetch(new Request(event.request, { cache: 'no-store' }))
      .then(response => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request).then(cached => cached || caches.match('./index.html')))
  );
});
