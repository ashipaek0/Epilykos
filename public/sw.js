/**
 * Epilykos Service Worker
 *
 * Responsibilities:
 * 1. Network URL routing — intercept API calls and route to local IP when on LAN
 * 2. Static asset caching — cache shell for offline display
 * 3. Periodic background sync — refresh metrics even when app is closed
 *
 * URLs are NOT hardcoded. They're received via postMessage from the settings page:
 *   navigator.serviceWorker.controller.postMessage({ type: 'network-config', localURL, remoteURL })
 */

const CACHE_NAME = 'epilykos-v6';
const STATIC_ASSETS = [
  '/',
  '/style.css',
  '/js/main.js',
  '/js/dashboard.js',
  '/js/charts.js',
  '/js/updater.js',
  '/js/csrf.js',
  '/js/theme.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

// ── Runtime state (received via postMessage) ──────────────────────────
let localURL = '';
let remoteURL = '';

// ── Install: pre-cache static shell ────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// ── Activate: clean old caches ─────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ── Message handler: receive URL config from page ──────────────────────
self.addEventListener('message', event => {
  if (event.data?.type === 'network-config') {
    localURL = event.data.localURL || '';
    remoteURL = event.data.remoteURL || '';
    console.log('[SW] Network config updated:', { localURL, remoteURL });
  }
});

// ── Fetch: route API calls through fastest available URL ───────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Only intercept API calls and same-origin requests
  const isSameOrigin = url.origin === self.location.origin;
  const isAPI = url.pathname.startsWith('/api/');

  // IMPORTANT: Never intercept WebSocket connections — service workers
  // cannot proxy WebSocket upgrades via fetch(). Attempting to do so
  // immediately closes the connection (browser throws "WebSocket is closed
  // before the connection is established"). WebSocket URLs must always
  // pass through to the browser's native WebSocket stack.
  const isWS = url.pathname === '/ws';
  if (isWS) return; // pass through — browser handles WebSocket natively

  if (isSameOrigin && isAPI && localURL) {
    event.respondWith(tryLocalThenRemote(event.request, url));
    return;
  }
  
  // Static assets: cache-first
  if (isSameOrigin && !isAPI) {
    event.respondWith(cacheFirst(event.request));
    return;
  }
  
  // Everything else: pass through
  event.respondWith(fetch(event.request));
});

// ── Routing strategy ──────────────────────────────────────────────────
async function tryLocalThenRemote(request, url) {
  // Try local first (2s timeout — LAN is fast)
  // Mixed content: HTTPS pages can't fetch HTTP resources
  const isHTTPS = self.location.protocol === 'https:';
  if (localURL && (!isHTTPS || localURL.startsWith('https://'))) {
    const localReq = new Request(request, {
      url: `${localURL}${url.pathname}${url.search}`
    });
    
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    
    try {
      const res = await fetch(localReq, { signal: controller.signal });
      clearTimeout(timeout);
      if (res.ok) {
        console.debug('[SW] Routed to local:', url.pathname);
        return res;
      }
    } catch (e) {
      clearTimeout(timeout);
      // Local unreachable — fall through to remote
    }
  }
  
  // Fall back to remote
  console.debug('[SW] Routed to remote:', url.pathname);
  return fetch(request);
}

// ── Cache-first for static assets ──────────────────────────────────────
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch (e) {
    // Offline — return cached shell
    return caches.match('/') || new Response('Offline', { status: 503 });
  }
}

// ── Periodic background sync ─────────────────────────────────────────
self.addEventListener('periodicsync', event => {
  if (event.tag === 'refresh-metrics') {
    event.waitUntil(refreshMetrics());
  }
});

async function refreshMetrics() {
  const baseURL = await resolveBaseURL();
  try {
    const res = await fetch(`${baseURL}/api/current`, {
      headers: { 'Accept': 'application/json' }
    });
    if (res.ok) {
      const data = await res.json();
      // Store latest metrics in cache for offline display
      const cache = await caches.open(CACHE_NAME);
      cache.put('/api/current', new Response(JSON.stringify(data), {
        headers: { 'Content-Type': 'application/json' }
      }));
      
      // Notify any open clients
      const clients = await self.clients.matchAll({ type: 'window' });
      clients.forEach(client => {
        client.postMessage({ type: 'background-refresh', data });
      });
    }
  } catch (e) {
    console.warn('[SW] Background sync failed:', e.message);
  }
}

async function resolveBaseURL() {
  // Try local first — but skip if HTTPS page can't reach HTTP local
  const isHTTPS = self.location.protocol === 'https:';
  if (localURL) {
    // Mixed content: HTTPS pages can't fetch HTTP resources
    if (!isHTTPS || localURL.startsWith('https://')) {
      try {
        const res = await fetch(`${localURL}/manifest.json`, {
          signal: AbortSignal.timeout(2000)
        });
        if (res.ok) return localURL;
      } catch (e) { /* unreachable */ }
    }
  }
  return remoteURL || self.location.origin;
}

// ── Push notifications placeholder ────────────────────────────────────
self.addEventListener('push', event => {
  const data = event.data?.json() || { title: 'Epilykos', body: 'Update available' };
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: 'epilykos-update'
    })
  );
});
