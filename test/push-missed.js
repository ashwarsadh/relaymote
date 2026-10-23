// push-missed.js — 24-Oct board item: "Sagar's phone has no RelayMote push subscription; 124 alerts to Sagar were
// dropped 14-23 Oct". The drops were logged on the PC and nobody told Sagar. Now each alert that finds no phone of
// its person is counted for that person, /api/bootstrap tells their phone, and the phone shows a one-tap
// "Turn on notifications" with the count. Subscribing clears it. Real server.js in a temp world, https stubbed.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const H = require('./mobile-harness');
const { check } = H;

const fakeSub = (endpoint) => {
  const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
  return { endpoint, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } };
};

// The banner's words, from the real app.js.
{
  const app = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'public', 'app.js'), 'utf8');
  const src = app.slice(app.indexOf('function pushNagText'), app.indexOf('function renderPushNag'));
  const ctx = {}; vm.runInNewContext(src + ';this.f=pushNagText;', ctx);
  const t = ctx.f({ missed: { n: 124, since: '2026-10-14T18:12:17Z' } }, 'default');
  check(/^124 alerts for you reached no phone since /.test(t.head) && t.button, 'Sagar sees "124 alerts for you reached no phone since …" and a Turn on button', t);
  const d = ctx.f({ missed: { n: 0 } }, 'denied');
  check(d.head === 'Notifications are off for you' && !d.button && /lock icon/.test(d.how), 'blocked in Chrome: no button, the lock-icon steps instead', d);
  check(/renderPushNag\(\);\n\s+await loadSessions\(\)/.test(app), 'the banner is drawn as the app opens');
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pmiss-'));
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
  const w = H.world('pmiss', { settings: { board: { dir: boardDir } } });
  const ids = w.sessions().map(s => s.sessionId || s.id).filter(Boolean);
  const [A] = ids;
  fs.writeFileSync(path.join(boardDir, 'principals.json'), JSON.stringify({ default: 'ashwar', principals: {
    ashwar: { name: 'Ashwar', conductor: null, sees: 'all' }, sagar: { name: 'Sagar', conductor: A, sees: 'own' } } }));
  const state = path.join(w.home, 'state');
  fs.mkdirSync(state, { recursive: true });
  const snap = (awaiting) => fs.writeFileSync(path.join(state, 'desktop-snapshot.json'), JSON.stringify({ at: new Date().toISOString(),
    sessions: ids.map(id => ({ sessionId: id, awaiting: awaiting.includes(id), running: false, unread: false })) }));
  snap([]);

  const d = await H.boot(w, { NODE_OPTIONS: '--require ' + JSON.stringify(stub).slice(1, -1) });
  try {
    // Only Ashwar's phone is subscribed, as on 14-23 Oct.
    let r = await d.req('/api/push/subscribe', { method: 'POST', body: Object.assign(fakeSub('https://ashwar.push.test/x'), { as: '' }) });
    check(r.status === 200, "Ashwar's phone subscribes", r.status);
    const sag = d.stream('pm-sagar', { as: 'sagar' });
    await d.waitFor(sag, e => e.event === 'sessions');
    await H.wait(2500);
    snap([A]);                                       // Sagar's Conductor needs him
    let missed = null;
    for (let i = 0; i < 40; i++) {
      await H.wait(250);
      try { missed = JSON.parse(fs.readFileSync(path.join(state, 'push-missed.json'), 'utf8')); } catch {}
      if (missed && missed.sagar) break;
    }
    check(missed && missed.sagar && missed.sagar.n === 1 && !missed.ashwar, "the alert that reached no phone of Sagar's is counted for Sagar only", missed);
    check(!fs.existsSync(pushLog) || !fs.readFileSync(pushLog, 'utf8').includes('ashwar'), "and it still did not go to Ashwar's phone");

    const boot = async (as) => (await d.req('/api/bootstrap', { headers: as ? { 'X-Relaymote-As': as } : {} })).json.pushFor;
    let pf = await boot('sagar');
    check(pf && pf.principal === 'sagar' && pf.subscribed === false && pf.missed.n === 1, "Sagar's phone is told: no phone of yours is subscribed, 1 alert missed", pf);
    pf = await boot('');
    check(pf && pf.principal === 'ashwar' && pf.subscribed === true, "Ashwar's phone is told it is covered (no banner)", pf);

    r = await d.req('/api/push/subscribe', { method: 'POST', body: Object.assign(fakeSub('https://sagar.push.test/x'), { as: 'sagar' }) });
    check(r.status === 200, 'Sagar taps Turn on notifications', r.status);
    pf = await boot('sagar');
    check(pf.subscribed === true && pf.missed.n === 0, 'subscribed: the count is cleared and the banner goes', pf);
  } finally {
    await d.stop();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
  H.finish(w);
})().catch(e => { console.error(e); process.exit(1); });
