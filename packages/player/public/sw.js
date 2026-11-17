// Keeps the player shell available offline. Content is cached by the page itself, by hash.
// Network first so a new player build is picked up; cache when the network is down.
const SHELL = 'sf-shell-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // Only the player shell is cached here. Content, data and the device API are the page's job.
  if (url.pathname.includes('/content/') || url.pathname.includes('/_sf/') || url.pathname.startsWith('/v1/')) return;
  e.respondWith(
    (async () => {
      const cache = await caches.open(SHELL);
      try {
        const res = await fetch(e.request, { signal: AbortSignal.timeout(4000) });
        if (res.ok) cache.put(e.request, res.clone());
        return res;
      } catch {
        const hit = await cache.match(e.request, { ignoreSearch: true });
        return hit ?? Response.error();
      }
    })(),
  );
});
