'use strict';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return;
  event.respondWith(
    fetch(event.request).catch(() => new Response(
      '<!doctype html><meta charset="utf-8"><title>Relaymote</title>' +
      '<body style="font:16px system-ui;background:#12110f;color:#e8e6e3;padding:28px">' +
      '<b>Cannot reach Relaymote</b>' +
      '<p style="color:#9b9691">The desktop is not reachable from here right now.</p>',
      { headers: { 'Content-Type': 'text/html; charset=utf-8' } })));
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
    tag: d.tag || 'baton',
    renotify: true,
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
