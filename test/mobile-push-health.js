// mobile-push-health.js — the push channel's failure modes must be LOUD, not silent:
//  - an unreadable push.json is refused, never regenerated empty (that unsubscribes every phone);
//  - only a 404/410 prunes a subscription, and send() reports each one's real status;
//  - an alert is logged from what the send did, and one that reached nobody is logged DROPPED;
//  - pushhealth.js says "no phone subscribed" over another channel: on a transition, never on a timer,
//    advancing only when the send succeeded;
//  - the non-push send door raises under RELAYMOTE_NO_SEND (armed here before anything loads).
// Offline: a temp world, https stubbed, the webhook is a local HTTP server.
'use strict';
process.env.RELAYMOTE_NO_SEND = '1';
const H = require('./mobile-harness');
const W = H.world('pushhealth', { demo: false, env: true });
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { check } = H;

const config = require('../lib/config');
const push = require('../mobile/push');
const alerts = require('../mobile/alerts');
const ph = require('../mobile/pushhealth');
const store = path.join(config.MOBILE, 'push.json');

function fakeSub(endpoint) {
  const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
  return { endpoint, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } };
}
const reply = {};   // push-service host -> status it answers
const realRequest = https.request;
https.request = (opts, cb) => {
  const { EventEmitter } = require('events');
  const req = new EventEmitter();
  req.end = () => setImmediate(() => { const res = new EventEmitter(); res.statusCode = reply[opts.hostname]; res.resume = () => {}; cb(res); setImmediate(() => res.emit('end')); });
  req.destroy = () => {};
  return req;
};
const hits = [];
const srv = http.createServer((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => { hits.push(b); res.writeHead(200); res.end('ok'); }); });

(async () => {
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;

  console.log('--- push.json is never regenerated over a file that exists ---');
  fs.writeFileSync(store, '{"vapid":{"publicKey":"KEEP"},"subs":[{"endpoint":"x"');   // torn write
  let threw = false; try { push.count(); } catch { threw = true; }
  check(threw && fs.readFileSync(store, 'utf8').includes('KEEP'), 'an unreadable push.json is refused, not regenerated empty');
  fs.writeFileSync(store, '{"subs":[{"endpoint":"https://a.test/x"}]}');
  threw = false; try { push.publicKey(); } catch { threw = true; }
  check(threw && fs.readFileSync(store, 'utf8').includes('a.test'), 'a store with subscriptions but no VAPID key is refused, not replaced');
  fs.unlinkSync(store);
  check(push.count() === 0 && JSON.parse(fs.readFileSync(store, 'utf8')).vapid.publicKey.length > 40, 'a MISSING push.json still starts fresh');
  const key = push.publicKey();

  console.log('--- only a 404/410 removes a subscription ---');
  for (const h of ['a.test', 'b.test', 'c.test', 'd.test']) push.subscribe(fakeSub(`https://${h}/x`));
  Object.assign(reply, { 'a.test': 201, 'b.test': 500, 'c.test': 429, 'd.test': 410 });
  let r = await push.send({ title: 't' });
  check(r.sent === 1 && r.failed === 2 && r.gone === 1 && push.count() === 3, '5xx/429 keep the subscription, 410 prunes it', r);
  check(r.results.find(x => x.host === 'd.test').status === 410, "send() reports each subscription's real status");
  const o = alerts.outcome({ push: { ...r, subscribed: 4 } });
  check(o.delivered && /^web push sent 1\/4; PRUNED 1 \(410 d\.test\); failed 2 \(500 b\.test, 429 c\.test\)$/.test(o.text), 'the log line is built from the send result, prune included', o.text);
  reply['a.test'] = 404;
  r = await push.send({ title: 't' });
  check(push.count() === 2 && push.publicKey() === key, 'a 404 prunes too; the VAPID key survives every write');
  check(!fs.existsSync(store + '.tmp'), 'writes go through a temp file + rename (none left behind)');
  check(!alerts.outcome({ push: { ...r, subscribed: 3 } }).delivered, 'a send that reached no phone is not "delivered"');
  check(!alerts.outcome({ push: { sent: 0, gone: 0, subscribed: 0 }, backup: null }).delivered, 'no phone and no backup: not delivered');

  console.log('--- the alarm channel and the send door ---');
  check((await alerts.alarm({ title: 'x', body: 'y' })).skipped === 'no alarm channel', 'no backup and no healthAlarm: the alarm says it has no channel');
  config.set({ notifications: { healthAlarm: { kind: 'webhook', url: base + '/alarm' } } });
  let blocked = false; try { await alerts.alarm({ title: 'x', body: 'y' }); } catch (e) { blocked = /RELAYMOTE_NO_SEND/.test(e.message); }
  check(blocked && hits.length === 0, 'the alarm RAISES under RELAYMOTE_NO_SEND and sends nothing');
  config.set({ notifications: { backup: { kind: 'webhook', url: base + '/b' } } });
  const b = await alerts.sendBackup({ title: 'x', body: 'y' });
  check(!b.ok && /RELAYMOTE_NO_SEND/.test(b.error) && hits.length === 0, 'the backup leg reports the block as a failure, never a fake success', b);
  delete process.env.RELAYMOTE_NO_SEND;
  const a = await alerts.alarm({ title: '⚠️ T', body: 'B' });
  check(a.ok && hits.length === 1 && JSON.parse(hits[0]).title === '⚠️ T', 'with the switch off, the alarm reaches its channel', a);
  config.set({ notifications: { healthAlarm: { kind: 'backup' } } });
  check(alerts.alarmChannel().url === base + '/b', "healthAlarm 'backup' uses the backup channel");
  process.env.RELAYMOTE_NO_SEND = '1';

  console.log('--- the watchdog: transition sends only, success-gated, one daily re-assert ---');
  const sent = []; let status = 201;
  const send = async (m) => { sent.push(m); return { ok: status >= 200 && status < 300, status }; };
  const T0 = Date.parse('2026-09-25T07:57:45Z');
  let t = await ph.tick({ count: 0, now: T0, send });
  ph.noteDropped();
  check(t.action === 'unarmed' && !ph.read() && sent.length === 0, 'never subscribed: nothing is watched and nothing is counted');
  t = await ph.tick({ count: 1, now: T0 - 60e3, send });
  check(t.action === 'ok' && ph.read().level === 'OK', 'a subscription arms it');
  t = await ph.tick({ count: 0, now: T0 + 10 * 60e3, send, seedZeroSince: T0 });
  check(t.action === 'wait' && sent.length === 0, 'zero subscriptions for 10 min: nothing sent yet');
  status = 503;
  t = await ph.tick({ count: 0, now: T0 + 31 * 60e3, send });
  check(t.action === 'alarm-failed' && ph.read().level === 'OK', 'a failed alarm does NOT advance the state...');
  status = 201;
  t = await ph.tick({ count: 0, now: T0 + 36 * 60e3, send });
  check(t.action === 'alarm' && ph.read().level === 'DEAD', '...so the next check sends it');
  check(/alerts are OFF/.test(sent[1].title) && sent[1].body.includes(ph.when(T0)), 'the alarm names when the last phone went, in local time', sent[1].body);
  ph.noteDropped(); ph.noteDropped();
  t = await ph.tick({ count: 0, now: T0 + 5 * 3600e3, send });
  check(t.action === 'wait' && sent.length === 2, 'a condition that persists sends nothing (no heartbeat)');
  t = await ph.tick({ count: 0, now: T0 + 36 * 60e3 + 24 * 3600e3, send });
  check(t.action === 'reassert' && /2 alerts not delivered/.test(sent[2].body), 'one re-assert after 24 h, carrying the dropped count', sent[2]);
  t = await ph.tick({ count: 1, now: T0 + 25 * 3600e3, send });
  check(t.action === 'ok' && /back on/.test(sent[3].title) && ph.read().level === 'OK', 'a phone subscribing again sends one "back on" and resets');
  t = await ph.tick({ count: 1, now: T0 + 26 * 3600e3, send });
  check(sent.length === 4, 'healthy stays silent');
  const logs = [];
  const none = async () => ({ ok: false, skipped: 'no alarm channel' });
  await ph.tick({ count: 0, now: T0 + 27 * 3600e3, send: none });
  for (const k of [1, 2]) await ph.tick({ count: 0, now: T0 + 28 * 3600e3 + k * 300e3, send: none, log: (m) => logs.push(m) });
  check(logs.length === 1 && /no alarm channel is set/.test(logs[0]) && ph.read().level === 'OK', 'no channel set: said ONCE in the log, state not advanced', logs);
  fs.unlinkSync(ph.STATE);
  await ph.tick({ count: 1, now: T0, send });
  t = await ph.tick({ count: 0, now: T0 + 40 * 60e3, send, enabled: false, seedZeroSince: T0 });
  check(t.action === 'off' && sent.length === 4, 'with alerts switched off entirely, no alarm is sent');

  console.log('--- wiring ---');
  const idx = H.src('mobile/index.js');
  check(!/-> \$\{alerts\.route\(\)\}/.test(idx), 'no alert is logged from a route taken before the send');
  check(/notify: DROPPED \$\{label\}/.test(idx) && /pushHealth\.noteDropped\(\)/.test(idx), 'an alert that reached nobody is logged DROPPED and counted');
  check(/setInterval\(pushHealthTick, 5 \* 60000\)/.test(idx) && /send: alerts\.alarm/.test(idx), 'the watchdog runs every 5 min and alarms through alerts.alarm');
  check(/p === '\/api\/push\/state'/.test(idx) && /api\('\/api\/push\/state'/.test(H.src('mobile/public/app.js')), 'the app reports its on-open re-subscribe result to the server');

  https.request = realRequest;
  srv.close();
  H.finish(W);
})().catch(e => { console.error('THREW', e); process.exit(1); });
