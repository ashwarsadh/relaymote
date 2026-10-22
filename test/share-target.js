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

  // 5. 21-Oct (Sagar, 4 WhatsApp photos shared twice while his phone could not reach the PC): the ?share=<id> page
  //    never booted and the next open carried no id. leftoverShare() takes the newest share under a day old on the
  //    next boot, drops older copies of the same files and anything stale, and keeps a DIFFERENT fresh share for later.
  const ls = app.slice(app.indexOf('async function leftoverShare'), app.indexOf('function currentPlace'));
  const now = Date.now(), cache = new Map();
  const put = (m) => { cache.set('/__share/' + m.id + '/meta', m); for (const f of m.files) cache.set('/__share/' + m.id + '/' + f.i, 'bytes'); };
  const four = [0, 1, 2, 3].map(i => ({ i, name: 'IMG-WA020' + i + '.jpg', type: 'image/jpeg', size: 1000 + i }));
  put({ id: 'first', at: now - 135e3, files: four, text: 'code price for these styles' });
  put({ id: 'again', at: now - 1e3, files: four, text: 'code price for these styles' });
  put({ id: 'other', at: now - 600e3, files: [{ i: 0, name: 'invoice.pdf', type: 'application/pdf', size: 9 }], text: '' });
  put({ id: 'stale', at: now - 30 * 3600e3, files: [{ i: 0, name: 'old.jpg', type: 'image/jpeg', size: 5 }], text: '' });
  const fake = { keys: async () => [...cache.keys()].map(k => ({ url: 'https://h' + k })), match: async (k) => ({ json: async () => cache.get(typeof k === 'string' ? k : new URL(k.url).pathname) }),
                 delete: async (k) => cache.delete(k) };
  const lctx = { caches: { open: async () => fake }, URL, Date, JSON };
  vm.runInNewContext(ls + '\nthis.leftoverShare = leftoverShare;', lctx);
  const got = await lctx.leftoverShare();
  await new Promise(r => setTimeout(r, 0));
  const ids = [...new Set([...cache.keys()].map(k => k.split('/')[2]))].sort();
  check(got === 'again', 'the newest share under a day old is taken on the next boot', got);
  check(ids.join() === 'again,other', 'its older copy and the stale share are dropped; a different fresh share is kept', ids);
  const empty = { keys: async () => [], match: async () => null, delete: async () => true };
  vm.runInNewContext(ls + '\nthis.f = leftoverShare;', Object.assign(lctx, { caches: { open: async () => empty } }));
  check(await lctx.f() === '', 'no share kept -> nothing is taken');
  // 6. QuickDial lane 21-Oct: on a principal's phone the share goes to THEIR Conductor; Ashwar's phone keeps "last".
  const stSrc = app.slice(app.indexOf('function shareTarget'), app.indexOf('async function receiveShare'));
  const live = [{ id: 'cond-sagar' }, { id: 'inquiries' }];
  const tctx = (home, last) => { const x = { principalHome: () => home, localStorage: { getItem: () => last }, LAST_CHAT_KEY: 'k',
    pickFirstScreen: () => ({ kind: 'chat', id: 'first', why: 'first' }) }; vm.runInNewContext(stSrc + '\nthis.st = shareTarget;', x); return x.st; };
  check(tctx('cond-sagar', 'inquiries')(live).id === 'cond-sagar', "a principal's phone attaches in their Conductor, not the last-open session");
  check(tctx('', 'inquiries')(live).id === 'inquiries', "Ashwar's phone (no principal) keeps the session he was last using");
  check(tctx('gone', 'inquiries')(live).id === 'inquiries', 'a home that is not live falls back to the last session');
  // 7. The kept copy is deleted only after every upload reached the PC.
  const rsBody = app.slice(app.indexOf('async function receiveShare'), app.indexOf('async function leftoverShare'));
  const iUp = rsBody.indexOf('await uploadFiles(files)'), iKeep = rsBody.indexOf("ups.every(v => v === true)"), iDel = rsBody.indexOf("c.delete('/__share/'");
  check(iUp > 0 && iKeep > iUp && iDel > iKeep, 'a failed or stalled upload keeps the share for the next open; it is deleted only after all uploads succeed', [iUp, iKeep, iDel]);
  const boot = app.slice(app.indexOf('const shareId = SHARE_ID'), app.indexOf('watchForUpdates();', app.indexOf('const shareId = SHARE_ID')));
  check(/!userMoved && !want \? await leftoverShare\(\)/.test(boot), 'a leftover share never overrides his own navigation or a notification target');

  // 8. 22-Oct, Ashwar (S24): "Then I shared to the relay mode this PDF later then it removed all the photos and just
  //    attached the PDF. Also loading was slow second time." A share reloads the app; attachments lived in memory.
  {
    const grab = (a, b) => app.slice(app.indexOf(a), app.indexOf(b));
    const src = grab('const attsKey', 'function renderAttachments') + grab('const UPLOAD_PARALLEL', 'async function send(');
    const store = new Map();
    const mkCtx = () => {
      const c = { localStorage: { getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) },
        JSON, Array, Promise, Math, toast: () => {}, renderAttachments: () => c.saveAtts(c.state.open, c.state.attachments), live: 0, peak: 0, sent: [],
        state: { open: 'local_s', attachments: [], uploads: [] } };
      c.uploadOne = async (f, rec) => { c.live++; c.peak = Math.max(c.peak, c.live); await new Promise(r => setTimeout(r, 5)); c.live--;
        c.sent.push(f.name); c.state.uploads.splice(c.state.uploads.indexOf(rec), 1);
        if (!c.state.attachments.some(a => c.sameFile(a, f))) c.state.attachments.push({ name: f.name, path: 'C:/up/' + f.name, size: f.size }); c.renderAttachments(); return true; };
      vm.runInNewContext(src + '\nthis.loadAtts = loadAtts; this.saveAtts = saveAtts; this.sameFile = sameFile; this.uploadFiles = uploadFiles;', c);
      return c;
    };
    const photos = Array.from({ length: 20 }, (_, i) => ({ name: 'IMG_' + i + '.jpg', size: 1000 + i }));
    let c = mkCtx();
    await c.uploadFiles(photos);
    check(c.state.attachments.length === 20 && c.peak <= 3, 'share 1: 20 photos attached, at most 3 uploading at a time', { n: c.state.attachments.length, peak: c.peak });
    // The second share reloads the page: a fresh app loads what is pending for the session.
    c = mkCtx(); c.state.attachments = c.loadAtts('local_s');
    check(c.state.attachments.length === 20, 'after the reload the 20 photos are still in the composer');
    await c.uploadFiles([{ name: 'quote.pdf', size: 5000 }, photos[3]]);
    check(c.state.attachments.length === 21 && c.state.attachments.some(a => a.name === 'quote.pdf') && JSON.stringify(c.sent) === '["quote.pdf"]',
      'share 2 (a PDF, plus a photo already there) APPENDS the PDF; the duplicate is neither uploaded nor added again', c.sent);
    c.state.attachments.splice(0, 1); c.renderAttachments();
    check(c.loadAtts('local_s').length === 20, 'removing one keeps the rest (each is removable, and that sticks)');
    c.state.attachments = []; c.renderAttachments();
    check(c.loadAtts('local_s').length === 0 && !store.has('baton.atts.local_s'), 'sending (or Clear all) empties the kept list');
    check(/if \(!sameSession\) state\.attachments = loadAtts\(id\);/.test(app) && !/\n  state\.attachments = \[\]; renderAttachments\(\);\n  state\.openGroups/.test(app),
      'opening a session restores its pending attachments instead of emptying them');
  }

  console.log(failed ? `\n${failed} FAILED` : '\nshare-target: all ok');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
