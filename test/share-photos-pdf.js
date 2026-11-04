// share-photos-pdf.js — Ashwar 22-Oct: "attaching the PDF, deleted the photos, and opening slowly was a relay mode
// issue." Replay of the whole server path: photos and a PDF are uploaded the way the phone does (3 at a time), then
// sent in ONE message; every file must reach the session, and the PDF must not displace a photo.
// Real server.js against a fake Desktop; the phone-side half (a second share appends) is share-target.js.
'use strict';
const fs = require('fs'), http = require('http'), path = require('path');
const H = require('./mobile-harness');
const { check, wait } = H;

function upload(port, token, name, bytes) {
  return new Promise(resolve => {
    const r = http.request({ host: '127.0.0.1', port, path: '/api/upload', method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'X-Filename': name, 'Content-Length': bytes.length, 'Content-Type': 'application/octet-stream' } },
    res => { let s = ''; res.on('data', c => s += c); res.on('end', () => { try { resolve(JSON.parse(s)); } catch { resolve({ ok: false, text: s }); } }); });
    r.on('error', e => resolve({ ok: false, error: e.message }));
    r.end(bytes);
  });
}

(async () => {
  const fake = await H.fakeDesktop();
  const w = H.world('photos-pdf', { settings: { cdpPort: fake.port } });
  const [A] = w.sessions();
  fake.sessions[A.sessionId] = { model: 'claude-opus-5-5', effort: 'high', transcript: [] };
  const d = await H.boot(w);
  try {
    const files = [];
    for (let i = 1; i <= 8; i++) files.push({ name: `IMG-20261022-WA00${10 + i}.jpg`, bytes: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300000 + i, i)]) });
    files.push({ name: 'Purchase order KK-4471.pdf', bytes: Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(900000, 7)]) });
    const t0 = Date.now();
    const paths = [];
    for (let i = 0; i < files.length; i += 3) {                       // the phone's uploadFiles: 3 in flight at most
      const got = await Promise.all(files.slice(i, i + 3).map(f => upload(d.app, d.token, f.name, f.bytes)));
      for (const g of got) paths.push(g.ok ? g.path : null);
    }
    const upMs = Date.now() - t0;
    check(paths.every(Boolean) && paths.length === 9, '8 photos + 1 PDF uploaded', { n: paths.filter(Boolean).length, upMs });
    check(paths.every((p, i) => fs.existsSync(p) && fs.statSync(p).size === files[i].bytes.length), 'each upload is whole on disk, byte for byte');

    const t1 = Date.now();
    const r = await d.req('/api/send', { method: 'POST', body: { id: A.sessionId, text: 'Photos and the PO together', attachments: paths, cmid: 'pp' + Date.now() } });
    check(r.status === 202 || r.status === 200, 'the send is accepted', r.status);
    let row = null;
    for (let i = 0; i < 60 && !row; i++) {
      row = (fake.sessions[A.sessionId].transcript || []).find(m => String(m.message && m.message.content).includes('Photos and the PO together'));
      if (!row) await wait(250);
    }
    const sendMs = Date.now() - t1;
    const text = row ? String(row.message.content) : '';
    const arrived = paths.filter(p => text.includes('@' + p));
    check(!!row, 'the message reached the session', { sendMs });
    check(arrived.length === 9, 'all 9 files arrived in that one message: no photo dropped for the PDF', arrived.length);
    // The server keeps [\w.-] in a name, so "Purchase order" is stored as "Purchase_order".
    check(text.includes('Purchase_order_KK-4471.pdf') && files.slice(0, 8).every(f => text.includes(f.name)), 'the PDF and every photo are named in it');
    check(sendMs < 5000, 'delivered within 5 s of Send', sendMs);
    console.log(`  timings: upload 9 files (${(files.reduce((s, f) => s + f.bytes.length, 0) / 1048576).toFixed(1)} MB) ${upMs} ms, send -> in session ${sendMs} ms`);
  } finally { await d.stop(); fake.close(); w.cleanup(); }
  H.finish(null);
})().catch(e => { console.error(e); process.exit(1); });
