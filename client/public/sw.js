/*
 * Hotel Sagarika BarFlow - service worker.
 *
 * Scope is deliberately narrow: it caches the application shell (HTML, manifest,
 * icons and built JS/CSS) so the POS can be opened offline, and it never touches
 * the API. All /api traffic goes straight to the network, so billing, login,
 * stock deduction and the offline sync queue in client/src/api.js behave exactly
 * as they do without a service worker.
 */
const VERSION = 'barflow-shell-v1';

const SHELL = [
  '/',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-192.png',
  '/icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(VERSION);
      // Individual failures must not abort the install (e.g. one icon missing).
      await Promise.all(
        SHELL.map((url) =>
          cache.add(new Request(url, { cache: 'reload' })).catch(() => undefined),
        ),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key)));
      await self.clients.claim();
    })(),
  );
});

function cacheable(response) {
  return (
    response &&
    response.ok &&
    response.status === 200 &&
    (response.type === 'basic' || response.type === 'default')
  );
}

async function putInShell(request, response) {
  const copy = response.clone();
  const cache = await caches.open(VERSION);
  await cache.put(request, copy).catch(() => undefined);
}

self.addEventListener('fetch', (event) => {
  const request = event.request;

  // Only plain same-origin GETs are handled; everything else is untouched.
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;
  if (url.pathname === '/sw.js') return;

  // App shell: always try the network so updates and auth screens stay fresh,
  // and fall back to the cached shell when the device is offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          if (cacheable(response)) await putInShell('/', response);
          return response;
        } catch (error) {
          const cache = await caches.open(VERSION);
          const cached = (await cache.match('/')) || (await cache.match('/index.html'));
          if (cached) return cached;
          return new Response(
            '<!doctype html><meta name="viewport" content="width=device-width"><title>BarFlow offline</title><body style="background:#0f0d0b;color:#f7f2e8;font-family:system-ui;padding:24px"><h1>BarFlow is offline</h1><p>Reopen the app once a connection is available to load the POS.</p></body>',
            { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
          );
        }
      })(),
    );
    return;
  }

  // Static assets (hashed JS/CSS, icons, manifest): cache first, refresh behind.
  event.respondWith(
    (async () => {
      const cache = await caches.open(VERSION);
      const cached = await cache.match(request);
      if (cached) {
        event.waitUntil(
          fetch(request)
            .then((response) => (cacheable(response) ? cache.put(request, response) : undefined))
            .catch(() => undefined),
        );
        return cached;
      }
      try {
        const response = await fetch(request);
        if (cacheable(response)) await putInShell(request, response);
        return response;
      } catch (error) {
        return cached || Response.error();
      }
    })(),
  );
});
