// Keeps the player shell available offline. Content is cached by the page itself, by hash.
// Network first so a new player build is picked up; cache when the network is down.
const SHELL = 'sf-shell-v1';
// A Vite build's hashed file, `assets/<name>-<8 character hash>.<ext>`: each release brings new ones.
const HASHED = /^(.*\/assets\/.+)-[A-Za-z0-9_-]{8}(\.[a-z0-9]+)$/;

const nameOf = (path) => {
  const m = HASHED.exec(path);
  return m ? m[1] + m[2] : undefined;
};

/**
 * Keep one copy of each hashed file: a release replaces them all, and this file stays the same
 * across releases, so the worker is not reinstalled to clear them. `latest`, the path just stored,
 * replaces the others of its name; it is dropped only once its replacement is stored, so the shell
 * stays whole offline. Without it, the newest of each name stays (`keys()` lists in put order).
 */
async function prune(cache, latest) {
  const want = latest && nameOf(latest);
  const kept = new Set();
  for (const req of (await cache.keys()).reverse()) {
    const path = new URL(req.url).pathname;
    const name = nameOf(path);
    if (!name) continue;
    if (latest ? name === want && path !== latest : kept.has(name)) await cache.delete(req);
    kept.add(name);
  }
}

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) =>
  e.waitUntil(
    (async () => {
      await self.clients.claim();
      // The shell's caches before this one, and what the worker before this one kept without pruning.
      for (const name of await caches.keys()) if (name.startsWith('sf-shell-') && name !== SHELL) await caches.delete(name);
      await prune(await caches.open(SHELL));
    })().catch((err) => console.warn('[sf] could not tidy the shell cache', err)),
  ),
);

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
        if (res.ok) {
          const copy = res.clone();
          e.waitUntil(
            (async () => {
              await cache.put(e.request, copy);
              if (nameOf(url.pathname)) await prune(cache, url.pathname);
            })().catch((err) => console.warn('[sf] could not cache', url.pathname, err)),
          );
        }
        return res;
      } catch {
        const hit = await cache.match(e.request, { ignoreSearch: true });
        return hit ?? Response.error();
      }
    })(),
  );
});
