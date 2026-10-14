// principal-stream.js — g1940. Ashwar 14-Oct: "sagar relaymopte was showing all sessions instead of his sesion
// or sessions he started or invoked". /api/sessions already narrowed Sagar's list, but the live stream's
// 'sessions' push sent everyone's list to every phone, so his list filled up on the first change. Each stream
// now says who holds the phone (?as=, EventSource sends no headers) and gets that principal's list.
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('./mobile-harness');
const { check } = H;

(async () => {
  const boardDir = path.join(require('os').tmpdir(), 'pstream-' + process.pid);
  fs.mkdirSync(boardDir, { recursive: true });
  const w = H.world('pstream', { settings: { board: { dir: boardDir } } });
  const ids = w.sessions().map(s => s.sessionId || s.id).filter(Boolean);
  const SAGAR_C = ids[0];
  fs.writeFileSync(path.join(boardDir, 'principals.json'), JSON.stringify({ default: 'ashwar', principals: {
    ashwar: { name: 'Ashwar', conductor: null, sees: 'all' }, sagar: { name: 'Sagar', conductor: SAGAR_C, sees: 'own' } } }));
  const d = await H.boot(w);
  try {
    const sag = d.stream('phone-sagar', { as: 'sagar' }), ash = d.stream('phone-ashwar');
    const sE = await d.waitFor(sag, e => e.event === 'sessions');
    const aE = await d.waitFor(ash, e => e.event === 'sessions');
    const sIds = sE ? sE.data.sessions.map(s => s.id) : null, aIds = aE ? aE.data.sessions.map(s => s.id) : null;
    check(!!sIds && sIds.length === 1 && sIds[0] === SAGAR_C, "Sagar's stream lists only his Conductor (nothing else touched)", sIds);
    check(!!aIds && aIds.length >= ids.length - 1 && aIds.includes(SAGAR_C), "Ashwar's stream still lists every session", aIds && aIds.length);
    const r = await d.req('/api/sessions?limit=80', { headers: { 'X-Relaymote-As': 'sagar' } });
    check(r.status === 200 && r.json.sessions.map(s => s.id).join() === SAGAR_C, '/api/sessions agrees with his stream', r.json.sessions && r.json.sessions.length);
    check(/'&as=' \+ encodeURIComponent\(who\)/.test(H.src('mobile/public/app.js')), "the phone's stream URL carries ?as= from Settings › This phone");
  } finally {
    await d.stop();
    w.cleanup();
    try { fs.rmSync(boardDir, { recursive: true, force: true }); } catch {}
  }
  H.finish(w);
})().catch(e => { console.error(e); process.exit(1); });
