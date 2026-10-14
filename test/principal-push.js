// principal-push.js — g1940 follow-up (Conductor, 14-Oct): "each phone gets pushes only for its own principal's
// sessions, so Ashwar's never reach Sagar's phone, nor the reverse". Headless: the real daemon (server.js) in a
// temp world, with https stubbed by a preload so every web push lands in a log instead of a push service.
// Two phones subscribe (one as Sagar); four sessions raise "needs input":
//   A = Sagar's Conductor, C = a session Sagar started  -> Sagar's phone only
//   B = an ordinary session of Ashwar's                 -> Ashwar's phone only
//   D = Ashwar's session that Sagar only messaged        -> both phones (it is on both lists)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const H = require('./mobile-harness');
const { check } = H;

const fakeSub = (endpoint) => {
  const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
  return { endpoint, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } };
};

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ppush-'));
  const boardDir = path.join(tmp, 'board'), pushLog = path.join(tmp, 'push.log'), stub = path.join(tmp, 'stub.js');
  fs.mkdirSync(boardDir);
  fs.writeFileSync(stub, `const https = require('https'), { EventEmitter } = require('events'), fs = require('fs');
const real = https.request;
https.request = function (opts, cb) {
  if (!opts || !String(opts.hostname || '').endsWith('.push.test')) return real.apply(this, arguments);
  const req = new EventEmitter();
  req.end = () => { fs.appendFileSync(${JSON.stringify(pushLog)}, opts.hostname + '\\n');
    const res = new EventEmitter(); res.statusCode = 201; res.resume = () => {};
    setImmediate(() => { cb(res); res.emit('end'); }); };
  req.write = () => {}; req.destroy = () => {};
  return req;
};`);
  const w = H.world('ppush', { settings: { board: { dir: boardDir } } });
  const ids = w.sessions().map(s => s.sessionId || s.id).filter(Boolean);
  const [A, B, C, D] = ids;
  fs.writeFileSync(path.join(boardDir, 'principals.json'), JSON.stringify({ default: 'ashwar', principals: {
    ashwar: { name: 'Ashwar', conductor: null, sees: 'all' }, sagar: { name: 'Sagar', conductor: A, sees: 'own' } } }));
  const state = path.join(w.home, 'state');
  fs.mkdirSync(state, { recursive: true });
  const now = Date.now();
  fs.writeFileSync(path.join(state, 'principal-touch.json'), JSON.stringify({ files: {}, touch: {
    [C]: { sagar: { first: now, last: now, started: true } }, [D]: { sagar: { first: now, last: now, started: false } } } }));
  const snap = (awaiting) => fs.writeFileSync(path.join(state, 'desktop-snapshot.json'), JSON.stringify({ at: new Date().toISOString(),
    sessions: ids.map(id => ({ sessionId: id, awaiting: awaiting.includes(id), running: false, unread: false })) }));
  snap([]);

  const d = await H.boot(w, { NODE_OPTIONS: '--require ' + JSON.stringify(stub).slice(1, -1) });
  try {
    let r = await d.req('/api/push/subscribe', { method: 'POST', body: Object.assign(fakeSub('https://sagar.push.test/x'), { as: 'sagar' }) });
    check(r.status === 200, "Sagar's phone subscribes as Sagar", r.status);
    r = await d.req('/api/push/subscribe', { method: 'POST', body: Object.assign(fakeSub('https://ashwar.push.test/x'), { as: '' }) });
    check(r.status === 200, "Ashwar's phone subscribes", r.status);
    const subs = JSON.parse(fs.readFileSync(path.join(w.home, 'mobile', 'push.json'), 'utf8')).subs;
    check(subs.find(s => s.endpoint.includes('sagar')).as === 'sagar' && !subs.find(s => s.endpoint.includes('ashwar')).as, 'each subscription records whose phone it is', subs.map(s => s.as || '-'));

    const sag = d.stream('p-sagar', { as: 'sagar' }), ash = d.stream('p-ashwar');
    await d.waitFor(sag, e => e.event === 'sessions'); await d.waitFor(ash, e => e.event === 'sessions');
    await H.wait(2500);                              // the first poll only learns the current state
    const pushedFor = async (id) => {
      fs.writeFileSync(pushLog, '');
      snap([id]);
      for (let i = 0; i < 40; i++) { await H.wait(250); if (fs.readFileSync(pushLog, 'utf8').trim()) break; }
      await H.wait(1500);
      const hosts = [...new Set(fs.readFileSync(pushLog, 'utf8').split('\n').filter(Boolean).map(h => h.split('.')[0]))].sort().join('+');
      snap([]); await H.wait(2000);
      return hosts;
    };
    check((await pushedFor(A)) === 'sagar', "Sagar's Conductor needing him -> only Sagar's phone");
    check((await pushedFor(B)) === 'ashwar', "Ashwar's session -> only Ashwar's phone");
    check((await pushedFor(C)) === 'sagar', 'a session Sagar started -> only Sagar\'s phone');
    check((await pushedFor(D)) === 'ashwar+sagar', 'an Ashwar session Sagar messaged (on both lists) -> both phones');
    const sAlerts = sag.filter(e => e.event === 'alert').map(e => e.data.id), aAlerts = ash.filter(e => e.event === 'alert').map(e => e.data.id);
    check(sAlerts.sort().join() === [A, C, D].sort().join(), "in-app alerts on Sagar's stream follow the same rule", sAlerts);
    check(aAlerts.sort().join() === [B, D].sort().join(), "in-app alerts on Ashwar's stream follow the same rule", aAlerts);
  } finally {
    await d.stop();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
  H.finish(w);
})().catch(e => { console.error(e); process.exit(1); });
