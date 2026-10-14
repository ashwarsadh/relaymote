// share-target.js — Ashwar 14-Oct: "In the share menu, I want to receive files from relay mode, and preferably
// attach in the session I was last using." The PWA is an Android share target: the share sheet POSTs the files
// to /share-target, sw.js keeps them in Cache Storage and opens /?share=<id>, and the app attaches them in the
// session last open on this phone. Nothing is sent until he taps send.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failed = 0;
const check = (ok, name, extra) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra !== undefined && !ok ? '  ' + JSON.stringify(extra).slice(0, 300) : ''}`); if (!ok) failed++; };
const pub = path.join(__dirname, '..', 'mobile', 'public');

// 1. The manifest declares the share target (POST multipart, files under "files", images/PDFs/docs).
const man = JSON.parse(fs.readFileSync(path.join(pub, 'manifest.webmanifest'), 'utf8'));
const st = man.share_target || {};
check(st.action === '/share-target' && st.method === 'POST' && st.enctype === 'multipart/form-data', 'manifest share_target POSTs multipart to /share-target', st);
const acc = ((st.params && st.params.files) || []).flatMap(f => f.name === 'files' ? f.accept : []);
for (const t of ['image/*', 'application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'])
  check(acc.includes(t), 'manifest accepts ' + t);

// 2. sw.js keeps the shared files and redirects to /?share=<id>.
(async () => {
  const store = new Map(), listeners = [];
  class Resp { constructor(body, init) { this.body = body; this.headers = (init && init.headers) || {}; } static redirect(u, s) { return { redirect: u, status: s }; } }
  const ctx = {
    self: { addEventListener: (t, f) => { if (t === 'fetch') listeners.push(f); }, location: { origin: 'https://h' } },
    caches: { open: async () => ({ put: async (k, v) => store.set(k, v), match: async () => null }) },
    Response: Resp, URL, Date, Math, String, JSON, console,
  };
  vm.runInNewContext(fs.readFileSync(path.join(pub, 'sw.js'), 'utf8'), ctx);
  const files = [{ name: 'invoice.pdf', type: 'application/pdf', size: 3 }, { name: 'photo.jpg', type: 'image/jpeg', size: 5 }];
  const form = { getAll: (k) => k === 'files' ? files : [], get: (k) => k === 'text' ? 'see attached' : null };
  let out = null;
  const ev = { request: { method: 'POST', url: 'https://h/share-target', formData: async () => form }, respondWith: (p) => { out = p; } };
  for (const f of listeners) f(ev);
  const r = await out;
  const id = r && /\/\?share=([a-z0-9]+)$/.exec(r.redirect || '');
  check(!!id && r.status === 303, 'sw redirects the share to /?share=<id>', r);
  const meta = id && store.get('/__share/' + id[1] + '/meta');
  const m = meta ? JSON.parse(meta.body) : {};
  check((m.files || []).map(f => f.name).join() === 'invoice.pdf,photo.jpg' && m.text === 'see attached', 'sw keeps the file list and the shared text', m);
  check(id && store.get('/__share/' + id[1] + '/0').body === files[0] && store.get('/__share/' + id[1] + '/1').body === files[1], 'sw keeps each file\'s bytes');
  let bad = null;
  const ev2 = { request: { method: 'POST', url: 'https://h/share-target', formData: async () => { throw new Error('x'); } }, respondWith: (p) => { bad = p; } };
  for (const f of listeners) f(ev2);
  check((await bad).redirect === '/?share=failed', 'an unreadable share opens the app with a "share again" note');

  // 3. The server sends a share that reached it (worker not running yet) home, without reading it.
  const idx = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'index.js'), 'utf8');
  const route = idx.indexOf("p === '/share-target'"), auth = idx.indexOf('const open = p === \'/sw.js\'');
  check(route > 0 && route < auth && /Location: '\/\?share=missed'/.test(idx), 'server redirects a missed share to /?share=missed before auth');

  // 4. The app remembers the last session per phone and attaches the share there without sending it.
  const app = fs.readFileSync(path.join(pub, 'app.js'), 'utf8');
  check(/localStorage\.setItem\(LAST_CHAT_KEY, id\)/.test(app), 'opening a session remembers it as the share target');
  const rs = app.slice(app.indexOf('async function receiveShare'), app.indexOf('function currentPlace'));
  check(/await openChat\(t\.id\)/.test(rs) && /uploadFiles\(files\)/.test(rs) && !/\bsend\(/.test(rs), 'a share opens the last session and attaches, never sends');
  check(/c\.delete\('\/__share\/'/.test(rs), 'the kept share is deleted once taken');

  console.log(failed ? `\n${failed} FAILED` : '\nshare-target: all ok');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
