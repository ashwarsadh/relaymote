// g1588: "when I send one message while the app is in error state, it gets queued. But then as soon as
// another message is sent, the first message gets lost." This runs the client's own outbox code against a
// fake localStorage and a fake PC: three messages typed with the PC unreachable, the app killed and opened
// again, then the PC comes back. All three must arrive, once each, in the order typed; a lost answer must
// not become a double send; a PC-side failure keeps the message.
const fs = require('fs'), path = require('path');
let fails = 0;
const check = (ok, what, got) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) { fails++; if (got !== undefined) console.log('     ', JSON.stringify(got)); } };

const app = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'public', 'app.js'), 'utf8');
const ob = app.slice(app.indexOf("const OB_KEY = "), app.indexOf('function obRetryNow('));
const sendFn = app.slice(app.indexOf('async function send(target) {'), app.indexOf('/* ---- The phone\'s outbox'));

const store = new Map();
const localStorage = { getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };

// The fake PC: down until pc.up; types each message into "Claude" once per cmid, like mobile/index.js.
const pc = { up: false, typed: [], cmids: new Map(), loseAnswer: 0, failNext: 0 };
async function apiOnce(p, o) {
  if (!pc.up) throw Object.assign(new Error('Your PC can\'t be reached'), { conn: true, kind: 'pc-down' });
  if (p.startsWith('/api/send/status')) {
    const v = pc.cmids.get(new URL(p, 'http://x').searchParams.get('cmid'));
    return v ? { ok: true, known: true, done: true, result: v } : { ok: true, known: false };
  }
  const b = JSON.parse(o.body);
  const seen = pc.cmids.get(b.cmid);
  if (seen && seen.ok) return { ok: true, already: true, result: seen };
  if (pc.failNext) { pc.failNext--; const r = { ok: false, error: 'no-editor', jobId: 'j' }; pc.results.push([b.cmid, r]); return { ok: true, queued: true, jobId: 'j' + pc.typed.length }; }
  pc.typed.push(b.text);
  const r = { ok: true, confirmed: true, jobId: 'j' + pc.typed.length, cmid: b.cmid };
  pc.cmids.set(b.cmid, r);
  if (pc.loseAnswer) { pc.loseAnswer--; throw Object.assign(new Error('timed out'), { conn: true, kind: 'timeout' }); }
  pc.results.push([b.cmid, r]);
  return { ok: true, queued: true, jobId: r.jobId };
}
pc.results = [];

function boot() {   // a fresh app: everything in memory is gone, only localStorage survives
  const state = { open: 'local_a', messages: [], pending: null, sending: false };
  const env = new Function('localStorage', 'state', 'apiOnce', 'window', 'sendNowBlocked', 'renderLog', 'renderDeskState',
    'noteConnOk', 'noteConnFail', 'sendError', 'checkPermission', 'checkOutbox', 'setTimeout', 'clearTimeout', 'CONN_TITLE',
    ob + '\nreturn { obAdd, obFlush, obResult, obFind, get items() { return obItems; } };');
  const timers = [];
  const o = env(localStorage, state, apiOnce, { addEventListener() {} }, new Map(), () => {}, () => {},
    () => {}, () => {}, (e) => 'Send failed: ' + e, () => {}, () => {},
    (f) => { timers.push(f); return timers.length; }, () => {}, { 'pc-down': "Your PC can't be reached", timeout: 'Your PC is answering slowly' });
  return { o, state };
}
// Deliver the sendresults the fake PC produced (the live stream), as the app's handler does.
async function stream(app) { while (pc.results.length) { const [cmid, r] = pc.results.shift(); const it = app.o.obFind(cmid); if (it) app.o.obResult(it, r); } await app.o.obFlush(); }

(async () => {
  let a = boot();
  for (const t of ['first: check the bills', 'second: and the meter', 'third: then mail the team']) { a.o.obAdd('local_a', t, []); await a.o.obFlush(); }
  check(a.o.items.length === 3 && pc.typed.length === 0, 'three messages typed with the PC unreachable are all held, none replaced', a.o.items.map(x => x.text));
  check(a.o.items[0].state === 'waiting' && /reached/.test(a.o.items[0].error) && a.o.items.slice(1).every(x => x.state === 'new'),
        'the first says why it is waiting; the others wait behind it, so the order cannot change', a.o.items.map(x => x.state));

  a = boot();   // the app is killed and opened again
  check(a.o.items.length === 3 && a.o.items.map(x => x.text).join('|') === 'first: check the bills|second: and the meter|third: then mail the team',
        'after the app is killed and reopened, all three are still there, in order');

  pc.up = true;
  for (const it of a.o.items) it.next = 0;
  for (let i = 0; i < 6 && a.o.items.length; i++) await stream(a);
  check(pc.typed.join('|') === 'first: check the bills|second: and the meter|third: then mail the team', 'the PC comes back: all three reach Claude, in the order typed', pc.typed);
  check(a.o.items.length === 0, 'and the outbox is empty only after the PC said each one arrived');

  // A lost answer (the PC typed it, the phone never heard): the retry carries the same cmid, nothing is typed twice.
  pc.typed = []; pc.loseAnswer = 1;
  a.o.obAdd('local_a', 'fourth: only once', []); await a.o.obFlush();
  check(a.o.items.length === 1, 'when the answer is lost, the message stays in the outbox');
  a.o.items[0].next = 0; await stream(a);
  check(pc.typed.length === 1 && a.o.items.length === 0, 'the retry is recognised by the PC (same cmid): typed once, then cleared', pc.typed);

  // The PC accepted it and then failed to type it: kept, retried; after three PC failures it stops and asks.
  pc.typed = []; pc.failNext = 3;
  a.o.obAdd('local_a', 'fifth: a stuck one', []);
  for (let i = 0; i < 10 && a.o.items[0] && a.o.items[0].state !== 'stuck'; i++) { a.o.items[0].next = 0; await stream(a); }
  check(a.o.items.length === 1 && a.o.items[0].state === 'stuck', 'a message the PC keeps failing is kept as "not sent" with Retry, never dropped', a.o.items[0]);

  check(/obAdd\(id, text, atts\)/.test(sendFn) && !/state\.pending = \{ sid: id, text, atts, status: 'sending'/.test(sendFn), 'send() puts the message in the outbox instead of the single pending slot');
  check(/if \(r\.cmid\) \{ const it = obFind\(r\.cmid\); if \(it\) obResult\(it, r\); return; \}/.test(app), 'the PC\'s sendresult is matched to its outbox message by cmid');
  const srv = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'index.js'), 'utf8');
  check(/if \(seen && seen\.done && seen\.ok\) return json\(res, 200, \{ ok: true, already: true/.test(srv), 'the server never types the same cmid twice');

  if (fails) { console.error(fails + ' failed'); process.exit(1); }
  console.log('phone-outbox: all checks passed');
})().catch(e => { console.error(e); process.exit(1); });
