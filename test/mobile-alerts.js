// mobile-alerts.js — the alert path: web push (VAPID audience + contact), the backup channel
// (ntfy / webhook / command), its rate cap, and the account-switch wording. Offline: push services
// are stubbed at https.request, the backup endpoints are a local HTTP server, the command is node.
'use strict';
const H = require('./mobile-harness');
const W = H.world('alerts', { demo: false, env: true });
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { check } = H;

const config = require('../lib/config');
const push = require('../mobile/push');
const alerts = require('../mobile/alerts');

// ---- a local endpoint that records what the backup channel sends ----------------------------
const hits = [];
let failNext = 0;
const srv = http.createServer((req, res) => {
  let b = ''; req.on('data', c => b += c);
  req.on('end', () => {
    hits.push({ path: req.url, headers: req.headers, body: b });
    if (failNext > 0) { failNext--; res.writeHead(502); return res.end('gateway'); }
    res.writeHead(200); res.end('ok');
  });
});

// ---- web push stubbed at the transport: capture what would go to the push service -----------
const pushed = [];
const realRequest = https.request;
https.request = (opts, cb) => {
  const { EventEmitter } = require('events');
  const req = new EventEmitter();
  req.end = () => {
    pushed.push(opts);
    const res = new EventEmitter(); res.statusCode = 201; res.resume = () => {};
    setImmediate(() => { cb(res); res.emit('end'); });
  };
  req.destroy = () => {};
  return req;
};
const jwtOf = (o) => JSON.parse(Buffer.from(String(o.headers.Authorization).match(/t=([^,]+)/)[1].split('.')[1], 'base64url').toString());
function fakeSub(endpoint) {
  const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
  return { endpoint, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } };
}

(async () => {
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;

  console.log('--- web push: VAPID audience and contact ---');
  check(push.audience('https://fcm.googleapis.com/fcm/send/abc') === 'https://fcm.googleapis.com',
        'the audience is scheme + "//" + host', push.audience('https://fcm.googleapis.com/fcm/send/abc'));
  push.subscribe(fakeSub('https://push.example.test:8443/wp/abc?x=1'));
  let r = await push.send({ title: 't', body: 'b' });
  check(r.sent === 1 && pushed.length === 1, 'send() reaches the (stubbed) push service', r);
  let jwt = jwtOf(pushed[0]);
  check(jwt.aud === 'https://push.example.test:8443', 'the JWT sent carries aud = https://host (regression: the missing //)', jwt.aud);
  check(jwt.sub === push.PLACEHOLDER_SUBJECT && push.subjectStatus().placeholder === true,
        'with no contact set, the placeholder is used and reported as a placeholder', jwt.sub);
  config.set({ notifications: { pushSubject: 'mailto:owner@example.com' } });
  await push.send({ title: 't', body: 'b' });
  jwt = jwtOf(pushed[1]);
  check(jwt.sub === 'mailto:owner@example.com', 'a contact entered in Settings applies on the NEXT send, without a restart', jwt.sub);
  check(push.subjectStatus().placeholder === false, 'and Settings stops asking for one');
  config.set({ notifications: { pushSubject: 'admin' } });
  await push.send({ title: 't', body: 'b' });
  check(jwtOf(pushed[2]).sub === push.PLACEHOLDER_SUBJECT && push.subjectStatus().placeholder === true,
        'a malformed contact is refused (placeholder, and Settings keeps asking)', jwtOf(pushed[2]).sub);
  push.drop('https://push.example.test:8443/wp/abc?x=1');
  check(push.count() === 0, 'precondition for the rest: no phone subscribed');

  console.log('\n--- backup channel: off by default ---');
  check(config.DEFAULTS.notifications.backup.kind === 'off', 'the default kind is off');
  r = await alerts.deliver({ kind: 'done', title: 'A', body: 'Finished' });
  check(r.backup === null && hits.length === 0, 'with push unavailable and backup off, nothing is sent anywhere', r);
  check(/nowhere/.test(alerts.route()), 'and the route says so', alerts.route());

  console.log('\n--- ntfy ---');
  config.set({ notifications: { backup: { kind: 'ntfy', url: base + '/my-topic' } } });
  r = await alerts.deliver({ kind: 'awaiting', title: 'Fix the tests — ü', body: 'Needs your input · web-app', url: '/?s=x' });
  const n1 = hits[hits.length - 1];
  check(r.backup && r.backup.ok && n1 && n1.path === '/my-topic', 'no push subscription -> the alert goes to the ntfy topic', r.backup);
  check(n1 && n1.body === 'Needs your input · web-app', 'the message body is the alert body', n1 && n1.body);
  check(n1 && /^=\?UTF-8\?B\?/.test(n1.headers.title) && Buffer.from(n1.headers.title.slice(10, -2), 'base64').toString() === 'Fix the tests — ü',
        'a non-ASCII title survives, RFC 2047 encoded', n1 && n1.headers.title);
  check(n1 && !n1.headers.click, 'a relative link is not sent as a Click URL');

  console.log('\n--- webhook ---');
  config.set({ notifications: { backup: { kind: 'webhook', url: base + '/hook' } } });
  alerts._resetCap();
  r = await alerts.deliver({ kind: 'done', title: 'Deploy', body: 'Finished', tag: 't1' });
  const h1 = hits[hits.length - 1]; let hj = {}; try { hj = JSON.parse(h1.body); } catch {}
  check(r.backup.ok && h1.path === '/hook' && /application\/json/.test(h1.headers['content-type']), 'the webhook receives a JSON POST', h1 && h1.headers['content-type']);
  check(hj.title === 'Deploy' && hj.body === 'Finished' && hj.kind === 'done' && hj.text === 'Deploy\nFinished' && hj.source === 'baton', 'with title, body, kind and text', hj);

  console.log('\n--- local command ---');
  const outFile = path.join(W.dir, 'cmd-out.json');
  const script = path.join(W.dir, 'recv.js');
  fs.writeFileSync(script, `let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{require('fs').writeFileSync(${JSON.stringify(outFile)},JSON.stringify({env:{t:process.env.BATON_ALERT_TITLE,b:process.env.BATON_ALERT_BODY,k:process.env.BATON_ALERT_KIND},stdin:JSON.parse(s)}));});`);
  config.set({ notifications: { backup: { kind: 'command', url: '', command: `"${process.execPath}" "${script}"` } } });
  const evil = 'x" & echo pwned > "' + path.join(W.dir, 'pwned.txt') + '" & "';
  r = await alerts.deliver({ kind: 'awaiting', title: evil, body: '$(whoami) `id`' });
  let got = null; try { got = JSON.parse(fs.readFileSync(outFile, 'utf8')); } catch {}
  check(r.backup.ok && got, 'the command runs', r.backup);
  check(got && got.env.t === evil && got.env.b === '$(whoami) `id`' && got.env.k === 'awaiting', 'the alert reaches it in BATON_ALERT_* env vars, verbatim', got && got.env);
  check(got && got.stdin.title === evil, 'and as JSON on stdin');
  check(!fs.existsSync(path.join(W.dir, 'pwned.txt')), 'a session title cannot inject shell syntax (it is never on the command line)');
  config.set({ notifications: { backup: { kind: 'command', command: `"${process.execPath}" -e "process.exit(3)"` } } });
  r = await alerts.sendBackup({ title: 'x' }, { test: true });
  check(r.ok === false && r.code === 3, 'a failing command is reported as a failure with its exit code', r);

  console.log('\n--- push first; backup only when push reached nobody (or always) ---');
  config.set({ notifications: { backup: { kind: 'webhook', url: base + '/hook', always: false } } });
  alerts._resetCap();
  let fakeSent = 1;
  alerts._setPush({ count: () => 1, send: async () => ({ sent: fakeSent, gone: 0 }) });
  let before = hits.length;
  r = await alerts.deliver({ kind: 'done', title: 'P', body: 'b' });
  check(r.push.sent === 1 && r.backup === null && hits.length === before, 'push reached a phone -> the backup channel stays quiet', r);
  fakeSent = 0;
  r = await alerts.deliver({ kind: 'done', title: 'P', body: 'b' });
  check(r.push.subscribed === 1 && r.push.sent === 0 && r.backup && r.backup.ok && hits.length === before + 1,
        'a subscription exists but push reached nobody -> the backup channel is used', r);
  fakeSent = 1;
  config.set({ notifications: { backup: { always: true } } });
  r = await alerts.deliver({ kind: 'done', title: 'P', body: 'b' });
  check(r.push.sent === 1 && r.backup && r.backup.ok && hits.length === before + 2, 'backup.always -> both legs', r);
  alerts._setPush(push);
  config.set({ notifications: { backup: { always: false } } });

  console.log('\n--- the rate cap: counted before sending, never retried ---');
  config.set({ notifications: { maxPer10Min: 3, backup: { kind: 'webhook', url: base + '/cap' } } });
  alerts._resetCap();
  const capHits = () => hits.filter(h => h.path === '/cap').length;
  failNext = 1;
  const res = [];
  for (let i = 0; i < 5; i++) res.push(await alerts.deliver({ kind: 'done', title: 'cap ' + i, body: 'b' }));
  check(res[0].backup.ok === false && res[0].backup.status === 502, 'the first send fails at the gateway (502)', res[0].backup);
  check(capHits() === 3, 'only 3 of 5 alerts left the machine (cap 3) — the failed one was NOT retried', capHits());
  check(res[3].backup.skipped === 'rate cap' && res[4].backup.skipped === 'rate cap', 'the cap REFUSES the 4th and 5th', res.map(x => x.backup.skipped || x.backup.ok));
  check(res[0].backup.ok === false && res[1].backup.ok && res[2].backup.ok, 'a failed send still used its slot (counted before sending)');
  const t = await alerts.sendBackup({ title: 'test' }, { test: true });
  check(t.ok && capHits() === 4, 'the Settings test button is an explicit tap: it bypasses the cap', t);
  check((await alerts.deliver({ title: 'after test' })).backup.skipped === 'rate cap', '...and does not free or use a slot');
  check(alerts.underCap(3, Date.now() + alerts.WINDOW_MS + 1000) === true, 'the window slides: ten minutes later there is room again');
  config.set({ notifications: { maxPer10Min: 0 } });
  check(alerts.settings().maxPer10Min === alerts.DEFAULT_CAP, 'a nonsense cap (0) falls back to the default of 6, never "unlimited"', alerts.settings().maxPer10Min);

  console.log('\n--- bad channel settings fail loudly, not silently ---');
  alerts._resetCap();
  config.set({ notifications: { backup: { kind: 'webhook', url: '' } } });
  r = await alerts.sendBackup({ title: 'x' });
  check(r.ok === false && /no webhook URL/.test(r.error), 'an empty URL is reported', r);
  config.set({ notifications: { backup: { kind: 'ntfy', url: 'file:///etc/passwd' } } });
  r = await alerts.sendBackup({ title: 'x' });
  check(r.ok === false && /http/.test(r.error), 'a non-http URL is refused', r);
  config.set({ notifications: { backup: { kind: 'carrier-pigeon' } } });
  check(alerts.settings().kind === 'off', 'an unknown kind is treated as off');

  console.log('\n--- account-switch wording comes from the real settings ---');
  const D = config.DEFAULTS;
  const w0 = alerts.accountSwitchText(D, { to: 'Work', from: 'Home' });
  check(w0.ask === false && /set up Accounts/.test(w0.body) && /Work/.test(w0.body), 'defaults (Accounts module off): a neutral "set up Accounts" line, and no question', w0.body);
  const all = s => [s.note, s.body, s.transferToast].join(' ');
  check(!/both ways|15 minutes/.test(all(w0)), 'and it no longer claims two-way sync every 15 minutes', all(w0));
  const on = { ...D, modules: { ...D.modules, accounts: true } };
  const w1 = alerts.accountSwitchText(on);
  check(w1.ask === true && /additively/.test(w1.note) && /press Sync/.test(w1.note) && !/both ways|every \d+ minutes/.test(all(w1)),
        'module on, Relaymote defaults (add mode, auto-sync off): says additive and on demand', w1.note);
  const w2 = alerts.accountSwitchText({ ...on, accounts: { ...D.accounts, mode: 'two-way', autoSync: true, intervalMinutes: 20 } });
  check(/both ways, every 20 minutes/.test(w2.note) && /every 20 min/.test(w2.body), 'two-way + auto-sync every 20: says exactly that', w2.note);
  const w3 = alerts.accountSwitchText({ ...on, accounts: { ...D.accounts, autoSync: true, intervalMinutes: 2 } });
  check(/every 5 minutes/.test(w3.note), 'an interval below the sync loop\'s 5-minute floor is reported as 5', w3.note);
  const w4 = alerts.accountSwitchText({ ...on, accounts: { ...D.accounts, enabled: false } });
  check(/switched off/.test(w4.note) && !/copied (both|additively)/.test(w4.note), 'sync disabled in Accounts: says nothing is copied', w4.note);
  check(!/15 minutes|sync both ways already/.test(H.src('mobile/index.js')) && !/already synced both ways/.test(H.src('mobile/public/app.js')),
        'the old fixed claims are gone from the server and the app');

  https.request = realRequest;
  srv.close();
  H.finish(W);
})().catch(e => { console.error('THREW', e); process.exit(1); });
