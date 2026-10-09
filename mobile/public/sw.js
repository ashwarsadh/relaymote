'use strict';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// g1588: the app opens with the PC unreachable, so the messages waiting in its outbox are shown (and
// sent the moment it is back) instead of a dead page. The page and its own scripts are kept from the
// last good load; the network always wins when it answers, and nothing under /api/ is ever cached.
const SHELL = 'relaymote-shell-v1';
const SHELL_FILES = /^\/(app\.js|style\.css|manifest\.webmanifest|(icon|badge)(-\d+)?\.(svg|png))$/;
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  const nav = req.mode === 'navigate';
  if (!nav && !SHELL_FILES.test(url.pathname)) return;
  event.respondWith((async () => {
    const key = nav ? '/' : url.pathname;
    try {
      const r = await fetch(req);
      if (r.ok && (!nav || url.pathname === '/')) { const c = await caches.open(SHELL); c.put(key, r.clone()).catch(() => {}); }
      return r;
    } catch (e) {
      const hit = await caches.open(SHELL).then(c => c.match(key)).catch(() => null);
      if (hit) return hit;
      if (!nav) throw e;
      return new Response(
        '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Relaymote</title>' +
        '<body style="font:16px system-ui;background:#12110f;color:#e8e6e3;padding:28px">' +
        '<b>Your PC can\'t be reached</b>' +
        '<p style="color:#9b9691">Your phone may be offline, or the PC is off or asleep. Messages you already typed are kept on this phone. Try again in a moment.</p>' +
        '<button onclick="location.reload()" style="font:inherit;padding:10px 16px">Try again</button>',
        { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
  })());
});

self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    try {
      let key = event.oldSubscription
        && event.oldSubscription.options
        && event.oldSubscription.options.applicationServerKey;
      if (!key) {
        const boot = await fetch('/api/bootstrap', { credentials: 'include' }).then(r => r.json());
        if (!boot || !boot.vapid) return;
        const b64 = boot.vapid, pad = '='.repeat((4 - (b64.length % 4)) % 4);
        const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
        key = Uint8Array.from(raw, (c) => c.charCodeAt(0));
      }
      const sub = event.newSubscription
        || await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      await fetch('/api/push/subscribe', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sub.toJSON()),
      });
    } catch (e) {
      console.warn('pushsubscriptionchange re-subscribe failed:', e && e.message);
    }
  })());
});

self.addEventListener('push', (event) => {
  let d = { title: 'Relaymote', body: 'Update' };
  try { if (event.data) d = event.data.json(); } catch { try { d.body = event.data.text(); } catch {} }
  event.waitUntil(self.registration.showNotification(d.title || 'Relaymote', {
    body: d.body || '',
    icon: '/icon-192.png',
    badge: '/badge-96.png',
    tag: d.tag || 'relaymote',
    renotify: d.renotify !== false,   // false = replace the burst's notification without buzzing again (g770)
    data: { url: d.url || '/', id: d.id || null },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const url = data.url || '/';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (!('focus' in c)) continue;
      await c.focus();
      if (data.id) { try { c.postMessage({ type: 'open-session', id: data.id }); return; } catch {} }
      if ('navigate' in c && url !== '/') { try { await c.navigate(url); } catch {} }
      return;
    }
    await self.clients.openWindow(url);
  })());
});
