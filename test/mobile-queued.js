// mobile-queued.js — queued messages from the phone, with the desktop's two controls (Cancel and
// Send now). Ported from the private tool's test-queued.js, which drove a REAL running session:
// start a long turn, hold a message behind it, cancel one, send-now another, watch a third drain.
// Those halves need a live Claude Desktop turn and cannot run offline; they are listed as SKIP.
// What CAN be proven offline is every refusal and every guarantee that no words are lost:
//   * a send that cannot reach the desktop keeps its text in the outbox, marked failed;
//   * Cancel / Send now on a DELIVERED slip are refused up front (409 ALREADY_DELIVERED), so
//     nothing is sent twice; on a composer-sent slip (no handle) -> NOT_ADDRESSABLE; on another
//     session's slip -> NO_SUCH_MESSAGE;
//   * a Cancel or Send now the desktop could not carry out keeps the slip (the text is not dropped
//     and not marked sent), and the result goes back to the client that tapped;
//   * the bridge's send-now on a uuid it cannot confirm never reports success.
'use strict';
const H = require('./mobile-harness');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { check, wait } = H;
const w = H.world('queued');

(async () => {
  const d = await H.boot(w);
  const OB = path.join(w.home, 'state', 'outbox.json');
  const SID = (w.sessions()[0] || {}).sessionId;
  const OTHER = (w.sessions()[1] || {}).sessionId;
  const CLIENT = 'test-queued';
  const ev = d.stream(CLIENT);
  await wait(800);
  const post = (p, body) => d.req(p, { method: 'POST', body, headers: { 'X-Baton-Client': CLIENT } });
  const readOb = () => { try { return JSON.parse(fs.readFileSync(OB, 'utf8')).entries || []; } catch { return []; } };

  console.log('--- a send that cannot reach the desktop keeps its words ---');
  const TAG = 'QUEUE-TEST-' + Date.now().toString(36);
  const s1 = await post('/api/send', { id: SID, text: `${TAG}: reply with the word NEVER` });
  check(s1.status === 202 && !!s1.json.jobId, 'the send is accepted for processing (202 + job id)', s1.json);
  const r1 = await d.waitFor(ev, e => e.event === 'sendresult' && e.data.jobId === s1.json.jobId, 20000);
  check(!!r1 && r1.data.ok === false, 'its result says it failed (no desktop), and reaches the client that sent it', r1 && r1.data);
  const slip = readOb().find(e => e.text.includes(TAG));
  check(!!slip && slip.state === 'failed' && slip.text.startsWith(TAG), 'the outbox kept the exact text, marked failed with a reason', slip && { state: slip.state, error: slip.error });
  const list = (await d.req('/api/outbox')).json.pending || [];
  check(list.some(e => e.id === (slip && slip.id)), '/api/outbox lists it, so the phone can offer Send again');

  console.log('\n--- Cancel / Send now: refusals that happen before any desktop work ---');
  const base = { at: Date.now(), confirmedAt: null, delivery: 'held' };
  const seeded = [
    { ...base, id: 'ob_delivered', session: SID, text: 'already delivered words', uuid: crypto.randomUUID(), state: 'confirmed', confirmedAt: Date.now() },
    { ...base, id: 'ob_composer', session: SID, text: 'sent through the composer', uuid: null, state: 'pending', delivery: 'queued' },
    { ...base, id: 'ob_held', session: SID, text: 'held behind a running turn', uuid: crypto.randomUUID(), state: 'pending' },
  ];
  fs.writeFileSync(OB, JSON.stringify({ entries: readOb().concat(seeded) }, null, 1));
  await new Promise(r => setTimeout(r, 1100));   // 10-Nov: the server keeps the outbox in memory and looks at the file's time once a second
  const held = (await d.req('/api/outbox')).json.pending.find(e => e.id === 'ob_held');
  check(!!held && held.held === true, '/api/outbox marks a slip with a handle as held', held);

  for (const op of ['send-now', 'cancel']) {
    const a = await post('/api/queued/' + op, { id: SID, outboxId: 'ob_delivered' });
    check(a.status === 409 && a.json.error === 'ALREADY_DELIVERED', `${op} on a delivered message is refused up front (409 ALREADY_DELIVERED)`, a.json);
    const b = await post('/api/queued/' + op, { id: SID, outboxId: 'ob_composer' });
    check(b.status === 409 && b.json.error === 'NOT_ADDRESSABLE', `${op} on a composer-sent message (no handle) -> NOT_ADDRESSABLE`, b.json.error);
    const c = await post('/api/queued/' + op, { id: OTHER, outboxId: 'ob_held' });
    check(c.status === 404 && c.json.error === 'NO_SUCH_MESSAGE', `${op} naming another session's slip -> NO_SUCH_MESSAGE`, c.json.error);
    const e = await post('/api/queued/' + op, { id: SID, outboxId: 'ob_nope' });
    check(e.status === 404, `${op} on an unknown slip -> 404`, e.status);
  }

  console.log('\n--- a Cancel / Send now the desktop could not carry out loses nothing ---');
  const c1 = await post('/api/queued/cancel', { id: SID, outboxId: 'ob_held' });
  check(c1.status === 202 && !!c1.json.jobId, 'cancel on a held slip is accepted for processing');
  const cr = await d.waitFor(ev, e => e.event === 'uiresult' && e.data.jobId === c1.json.jobId, 15000);
  check(!!cr && cr.data.ok === false && cr.data.cancelled === false, 'the result says it did NOT cancel (no desktop) — to the tapping client', cr && cr.data);
  const afterCancel = readOb().find(e => e.id === 'ob_held');
  check(!!afterCancel && afterCancel.state === 'pending' && afterCancel.text === 'held behind a running turn', 'the slip and its words are still there');
  const s2 = await post('/api/queued/send-now', { id: SID, outboxId: 'ob_held' });
  const sr = await d.waitFor(ev, e => e.event === 'uiresult' && e.data.jobId === s2.json.jobId, 15000);
  check(!!sr && sr.data.ok === false && sr.data.interrupted === false, 'send-now reports failure, not an interruption it did not make', sr && sr.data);
  const afterNow = readOb().find(e => e.id === 'ob_held');
  check(!!afterNow && afterNow.state === 'pending' && afterNow.delivery !== 'sent-now', 'and the slip is NOT marked sent', afterNow && afterNow.delivery);
  check(readOb().find(e => e.id === 'ob_delivered').state === 'confirmed', 'the delivered slip was never touched');

  console.log('\n--- the bridge-level guard ---');
  Object.assign(process.env, w.env);
  const desktop = require('../lib/desktop');
  let g;
  try { g = await desktop.sendQueuedNowByUuid(SID, crypto.randomUUID()); } catch (e) { g = { ok: false, threw: e.code || e.message }; }
  check(g && g.ok !== true, 'bridge send-now on a uuid it cannot confirm never reports success', g);

  await d.stop();
  if (H.failures()) console.log(d.output().slice(-3000));
  await withDesktop();
  H.finish(w);
})().catch(e => { console.error('THREW', e); process.exit(1); });

// The half that needed a live running turn, against the stand-in desktop: its queue behaves like
// the desktop's (a message sent while a turn runs is held; the turn's end delivers the next one;
// cancel / promote / interrupt act on it), and delivery writes the row into the real .jsonl file
// the daemon reconciles against.
async function withDesktop() {
  const path = require('path');
  const fake = await H.fakeDesktop();
  const w2 = H.world('queued-live', { settings: { cdpPort: fake.port } });
  const rec = w2.sessions()[0];
  const SID = rec.sessionId;
  const file = path.join(w2.claude, 'projects', rec.cwd.replace(/[^A-Za-z0-9]/g, '-'), rec.cliSessionId + '.jsonl');
  const S = fake.sessions[SID] = { model: 'claude-opus-5', effort: 'high', isRunning: false, file,
    transcript: [{ type: 'assistant', timestamp: new Date(Date.now() - 60000).toISOString(), message: { model: 'claude-opus-5' } }] };
  const inFile = (tag) => (fs.readFileSync(file, 'utf8').match(new RegExp(tag, 'g')) || []).length;
  const d = await H.boot(w2);
  const CLIENT = 'test-queued-live';
  const ev = d.stream(CLIENT, {});
  await wait(800);
  const post = (p, body) => d.req(p, { method: 'POST', body, headers: { 'X-Baton-Client': CLIENT } });
  const sendRes = async (text) => { const p = await post('/api/send', { id: SID, text }); const e = await d.waitFor(ev, x => x.event === 'sendresult' && x.data.jobId === p.json.jobId, 20000); return e && e.data; };
  const uiRes = async (p) => { const e = await d.waitFor(ev, x => x.event === 'uiresult' && x.data.jobId === p.json.jobId, 20000); return e && e.data; };

  console.log('\n--- 1. a message sent WHILE RUNNING is held, with a slip the phone can act on ---');
  S.isRunning = true;
  const T = Date.now().toString(36);
  const TAG_CANCEL = 'QUEUE-TEST-CANCEL-' + T, TAG_NOW = 'QUEUE-TEST-NOW-' + T, TAG_DRAIN = 'QUEUE-TEST-DRAIN-' + T;
  const r1 = await sendRes(`${TAG_CANCEL}: reply with the word NEVER`);
  check(r1 && r1.ok && r1.delivery === 'held' && r1.held === true && !!r1.outboxId, 'delivery is "held" with held:true and an outbox slip', r1 && { delivery: r1.delivery, held: r1.held });
  const slip1 = ((await d.req('/api/outbox')).json.pending || []).find(e => e.id === (r1 && r1.outboxId));
  check(!!slip1 && slip1.held === true, '/api/outbox lists it as held');
  check(inFile(TAG_CANCEL) === 0 && S.queue.length === 1, 'it is in the desktop\'s queue, not the transcript');

  console.log('\n--- 2. CANCEL takes it back; it never arrives ---');
  const cr = await uiRes(await post('/api/queued/cancel', { id: SID, outboxId: r1.outboxId }));
  check(cr && cr.ok && cr.cancelled === true, 'the result says cancelled', cr);
  check(!((await d.req('/api/outbox')).json.pending || []).some(e => e.id === r1.outboxId), 'the slip is gone from the outbox');

  console.log('\n--- 3. SEND NOW interrupts the turn and lands the message at once ---');
  const r2 = await sendRes(`${TAG_NOW}: reply with the single word LANDED`);
  check(r2 && r2.ok && r2.held === true, 'a second message is held too');
  const sr = await uiRes(await post('/api/queued/send-now', { id: SID, outboxId: r2.outboxId }));
  check(sr && sr.ok && sr.interrupted === true, 'the result says the running turn was interrupted', sr);
  check(inFile(TAG_NOW) === 1, 'the message is in the transcript file at once');
  const ob2 = await d.waitFor(ev, e => e.event === 'outbox' && (e.data.confirmed || []).some(x => x.id === r2.outboxId), 15000);
  check(!!ob2, 'the phone is told it was delivered (SSE outbox confirmed)');
  fake.endTurn(SID);
  check(inFile(TAG_CANCEL) === 0, 'the CANCELLED message never arrived, even after the turn ended');

  console.log('\n--- 4. a held message LEFT ALONE is confirmed to the phone when it drains ---');
  S.isRunning = true;
  const r3 = await sendRes(`${TAG_DRAIN}: reply with the single word DRAINED`);
  check(r3 && r3.held === true, 'a third message is held');
  await wait(1000);
  const drainedAt = Date.now();
  fake.endTurn(SID);   // the turn ends; the desktop delivers the queued message as the next turn
  const ob3 = await d.waitFor(ev, e => e.event === 'outbox' && (e.data.confirmed || []).some(x => x.id === r3.outboxId), 30000);
  const lag = ob3 ? (ob3.at - drainedAt) / 1000 : null;
  check(!!ob3 && lag <= 10, 'the phone receives `outbox` confirmed within 10s of the drain (poll-driven, not the 60s sweep)', lag === null ? 'no event in 30s' : lag.toFixed(1) + 's');
  check(!((await d.req('/api/outbox')).json.pending || []).some(e => e.id === r3.outboxId), '/api/outbox no longer lists it');

  console.log('\n--- 5. Send now / x pressed AFTER delivery are harmless no-ops ---');
  const s3 = await post('/api/queued/send-now', { id: SID, outboxId: r3.outboxId });
  check(s3.status === 409 && s3.json.error === 'ALREADY_DELIVERED', 'send-now on a delivered message is refused up front', s3.json.error);
  const c3 = await post('/api/queued/cancel', { id: SID, outboxId: r3.outboxId });
  check(c3.status === 409 && c3.json.error === 'ALREADY_DELIVERED', 'cancel on a delivered message is refused up front too', c3.json.error);
  // This process loaded the bridge for the first world; point it at the stand-in desktop.
  require('../lib/config').set({ cdpPort: fake.port });
  const desktop = require('../lib/desktop');
  const guard = await desktop.sendQueuedNowByUuid(SID, crypto.randomUUID());
  check(guard && guard.ok === false && guard.error === 'ALREADY_SENT' && guard.alreadySent === true, 'bridge send-now on a uuid that is not queued is ALREADY_SENT, not a send', guard);
  const back = await desktop.cancelQueued(SID, crypto.randomUUID());
  check(back && back.ok === false && back.alreadySent === true, 'bridge cancel on a uuid that is not queued says already sent, not cancelled', back);
  fake.endTurn(SID);
  check(inFile(TAG_DRAIN) === 1 && inFile(TAG_NOW) === 1, 'each delivered message appears in the transcript exactly once');

  await d.stop();
  fake.close();
  if (H.failures()) console.log(d.output().slice(-3000));
  w2.cleanup();
}
