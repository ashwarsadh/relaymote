// relay-outbox.js — the outbox (mobile/outbox.js) and the routes around it in mobile/index.js, under
// reconnects: a message typed while Claude Desktop is unreachable, Desktop coming back, the phone's
// "Send again", Cancel and Send now across an outage, ordering of held messages, what survives a
// daemon restart, and an entry going stale. Extends test/mobile-outbox.js (pure outbox rules) and
// test/mobile-queued.js (Cancel / Send now refusals with Desktop up) instead of repeating them.
// Offline: Desktop is mobile-harness fakeDesktop() on 127.0.0.1, or a closed port.
'use strict';
const H = require('./relay-harness');
const fs = require('fs');
const path = require('path');
const { check, knownBug, wait } = H;
const MIN = 60 * 1000;

// In-process half: this process is pointed at world W (before any require of the modules).
const W = H.world('relay-outbox', { env: true });
const outbox = require('../mobile/outbox');
const reset = () => { try { fs.unlinkSync(outbox.FILE); } catch {} };
const seed = (entries) => { fs.mkdirSync(path.dirname(outbox.FILE), { recursive: true }); fs.writeFileSync(outbox.FILE, JSON.stringify({ entries }, null, 1)); };

(async () => {
  if (!outbox.FILE.startsWith(W.dir)) { console.error('REFUSING TO RUN: outbox.FILE is not inside the temp world -', outbox.FILE); process.exit(1); }
  reset();

  console.log('--- enqueue and ordering ---');
  {
    const a = outbox.add({ session: 's1', text: 'first typed while Desktop was away' });
    await wait(5);
    const b = outbox.add({ session: 's1', text: 'second typed while Desktop was away' });
    await wait(5);
    const c = outbox.add({ session: 's2', text: 'third, to another session' });
    check(a.state === 'pending' && a.uuid === null && a.delivery === null, 'a new slip is pending, with no handle and no delivery claim yet', a);
    check(outbox.load().map(e => e.id).join() === [a.id, b.id, c.id].join(), 'the file keeps slips in the order they were typed');
    check(outbox.pending().map(e => e.id).join() === [c.id, b.id, a.id].join(), '/api/outbox order: newest first, so the latest message is on top');
    check(outbox.setUuid(b.id, 'u-123').uuid === 'u-123' && outbox.get(b.id).uuid === 'u-123', 'a handle (uuid) can be attached after the send, and is persisted');
    check(outbox.setUuid('ob_nope', 'u') === null, 'refusal: attaching a handle to an unknown slip is a no-op returning null');
  }

  console.log('\n--- no duplicate confirmation on a retry of the reconciler ---');
  reset();
  {
    const e = outbox.add({ session: 's1', text: 'confirm me exactly once please, thanks a lot' });
    outbox.markSent(e.id, { ok: true, delivery: 'queued' });
    const hay = () => 'noise confirm me exactly once please, thanks a lot noise';
    const r1 = outbox.reconcile(hay);
    const r2 = outbox.reconcile(hay);
    check(r1.confirmed.length === 1, 'the first pass confirms it (and the daemon sends one `outbox` event)');
    check(r2.confirmed.length === 0 && r2.checked === 0, 'a second pass (a retry / the next tick) confirms nothing again: no duplicate event', r2);
  }

  console.log('\n--- an entry going stale: flagged once, never again ---');
  reset();
  {
    const now = Date.now();
    seed([{ id: 'ob_old', session: 's1', text: 'old and never seen', delivery: 'queued', uuid: null, at: now - 16 * MIN, confirmedAt: null, state: 'pending' },
          { id: 'ob_young', session: 's1', text: 'young and never seen', delivery: 'queued', uuid: null, at: now - 5 * MIN, confirmedAt: null, state: 'pending' }]);
    const r1 = outbox.reconcile(() => '', now);
    check(r1.suspect.map(e => e.id).join() === 'ob_old', 'past SUSPECT_MS (15 min) it is raised as suspect', r1.suspect.map(e => e.id));
    check(!outbox.get('ob_young').suspectedAt, 'refusal: a 5-minute-old slip is not raised');
    delete require.cache[require.resolve('../mobile/outbox')];
    const fresh = require('../mobile/outbox');
    check(!!fresh.get('ob_old').suspectedAt, 'the suspect mark is on disk, so it survives a daemon restart');
    const r2 = fresh.reconcile(() => '', now + 30 * MIN);
    check(r2.suspect.length === 1 && r2.suspect[0].id === 'ob_young', 'later passes raise only the newly stale one, never the old one again (one alert per message)', r2.suspect.map(e => e.id));
  }

  console.log('\n--- a failed short message is "confirmed" by any earlier text that contains it ---');
  reset();
  const mob = require('../mobile/index.js');
  const sessions = require('../mobile/sessions');
  await sessions.refresh({ force: true });
  const rich = sessions.index().list.find(s => { try { return fs.statSync(sessions.transcriptPath(s)).size > 600; } catch { return false; } });
  check(!!rich, 'precondition: a demo session with a transcript');
  {
    const file = sessions.transcriptPath(rich);
    fs.appendFileSync(file, JSON.stringify({ type: 'assistant', timestamp: new Date(Date.now() - 3600000).toISOString(),
      message: { role: 'assistant', content: [{ type: 'text', text: 'Shall I run it now? Say yes and I will continue.' }] } }) + '\n');
    const unique = outbox.add({ session: rich.id, text: 'RELAY-OB-UNIQUE a message that never reached the desktop' });
    outbox.markSent(unique.id, { ok: false, error: 'connect ECONNREFUSED 127.0.0.1:9229' });
    const yes = outbox.add({ session: rich.id, text: 'yes' });
    outbox.markSent(yes.id, { ok: false, error: 'connect ECONNREFUSED 127.0.0.1:9229' });
    outbox.reconcile(mob.transcriptTail, Date.now());
    check(outbox.get(unique.id).state === 'failed', 'a failed message whose text is not in the transcript stays failed (Send again stays offered)');
    knownBug(outbox.get(yes.id).state !== 'confirmed',
      'a failed "yes" stays failed (mobile/outbox.js:31-36,112-113 matches the first 60 chars ANYWHERE in the raw 2 MB tail, assistant text included, with no time bound, so an hour-old "Say yes" confirms it and the phone stops offering Send again)',
      { state: outbox.get(yes.id).state });
  }

  console.log('\n--- "the session is still working" is never known to the outbox tick ---');
  reset();
  {
    const desktop = require('../lib/desktop');
    desktop.saveSnapshot({ sessions: [{ sessionId: rich.id, running: true, statusDot: 'Running', group: 'g' }], groups: [], active: null });
    const decorated = sessions.decorate(sessions.index().list, desktop.loadSnapshot()).find(s => s.id === rich.id);
    check(decorated && decorated.running === true, 'precondition: the daemon\'s own session view says this session is Running');
    seed([{ id: 'ob_behind_turn', session: rich.id, text: 'RELAY-OB-HELD waiting behind a long turn', delivery: 'held', uuid: 'u-held',
            at: Date.now() - 16 * MIN, confirmedAt: null, state: 'pending' }]);
    await mob.outboxTick();
    const raw = sessions.get(rich.id);
    knownBug(!outbox.get('ob_behind_turn').suspectedAt,
      'a message held behind a running turn is not raised as "may not have arrived" (mobile/index.js:1796 busy() reads sessions.get(id).running / .dot, which the raw record never has)',
      { suspected: !!outbox.get('ob_behind_turn').suspectedAt, recordHasRunning: 'running' in (raw || {}), recordHasDot: 'dot' in (raw || {}) });
  }
  reset();

  await daemonHalf();
  H.finish(W, 'relay-outbox');
})().catch(e => { console.error('THREW', e); process.exit(1); });

// Daemon half: server.js in its own world, Desktop = fakeDesktop(), reachable or not by moving the debugger port.
async function daemonHalf() {
  const fake = await H.fakeDesktop();
  const dead = await H.deadPort();
  const w = H.world('relay-outbox-d', { settings: { cdpPort: dead } });
  const recs = w.sessions();
  const rec = recs[0], other = recs[1];
  const SID = rec.sessionId;
  const file = H.transcriptFile(w, rec);
  const S = fake.sessions[SID] = { model: 'claude-opus-5', effort: 'high', isRunning: false, file,
    transcript: [{ type: 'assistant', timestamp: new Date(Date.now() - 60000).toISOString(), message: { model: 'claude-opus-5' } }] };
  const inFile = (tag) => (fs.readFileSync(file, 'utf8').match(new RegExp(tag, 'g')) || []).length;
  const OB = path.join(w.home, 'state', 'outbox.json');
  const readOb = () => { try { return JSON.parse(fs.readFileSync(OB, 'utf8')).entries || []; } catch { return []; } };
  const CLIENT = 'relay-outbox';
  const T = Date.now().toString(36);

  let d = await H.boot(w);
  let ev = d.stream(CLIENT);
  await wait(800);
  const post = (p, body) => d.req(p, { method: 'POST', body, headers: { 'X-Baton-Client': CLIENT } });
  const sendRes = async (text) => { const p = await post('/api/send', { id: SID, text }); const e = await d.waitFor(ev, x => x.event === 'sendresult' && x.data.jobId === p.json.jobId, 25000); return e && e.data; };
  const uiRes = async (p) => { const e = await d.waitFor(ev, x => x.event === 'uiresult' && x.data.jobId === p.json.jobId, 25000); return e && e.data; };
  const confirmedEv = (id, ms = 25000) => d.waitFor(ev, e => e.event === 'outbox' && (e.data.confirmed || []).some(x => x.id === id), ms);
  const pendingList = async () => (await d.req('/api/outbox')).json.pending || [];

  console.log('\n--- 1. Desktop unreachable: the message is kept, marked failed ---');
  const TAG1 = 'RELAY-OB-AWAY-' + T;
  const r1 = await sendRes(`${TAG1}: typed while Desktop was closed`);
  check(r1 && r1.ok === false && !!r1.outboxId, 'the send reports failure to the phone, with the slip id', r1 && { ok: r1.ok, error: r1.error });
  const slip1 = readOb().find(e => e.id === (r1 && r1.outboxId));
  check(!!slip1 && slip1.state === 'failed' && slip1.text.startsWith(TAG1), 'the slip is on disk, failed, exact text kept');
  check(inFile(TAG1) === 0, 'nothing reached the transcript');

  console.log('\n--- 2. Desktop comes back; the phone\'s Send again delivers it exactly once ---');
  H.setCdpPort(w, fake.port);
  const chk1 = await d.req('/api/outbox/check?id=' + slip1.id);
  check(chk1.json.ok && chk1.json.landed === false && !chk1.json.gone, 'Send again first asks: not landed, so a resend is allowed', chk1.json);
  await d.req('/api/outbox/drop?id=' + slip1.id);
  const r2 = await sendRes(`${TAG1}: typed while Desktop was closed`);
  check(r2 && r2.ok === true && !!r2.outboxId, 'the resend goes through now that Desktop is back', r2 && { ok: r2.ok, delivery: r2.delivery, error: r2.error });
  check(inFile(TAG1) === 1, 'the transcript has it once');
  const c2 = await confirmedEv(r2 && r2.outboxId);
  check(!!c2, 'the phone is told it was delivered (SSE `outbox` confirmed)');
  const chk2 = await d.req('/api/outbox/check?id=' + (r2 && r2.outboxId));
  check(chk2.json.landed === true, 'a second Send again on the new slip is refused: check says landed');

  console.log('\n--- 3. no duplicate after a reconnect or a retry ---');
  const chkOld = await d.req('/api/outbox/check?id=' + slip1.id);
  check(chkOld.json.landed === false && chkOld.json.gone === true, 'the OLD (dropped) slip now reads { landed:false, gone:true }', chkOld.json);
  const app = H.src('mobile/public/app.js');
  const landedFn = (app.match(/async function alreadyLanded[\s\S]*?\n\}/) || [''])[0];
  knownBug(/gone/.test(landedFn),
    'a second view still showing the old slip (another device, or the phone after a reconnect) treats gone as "do not resend" (app.js:218-223 returns r.landed only, so gone -> resend -> the message lands twice)',
    { alreadyLanded: landedFn.replace(/\s+/g, ' ').slice(0, 140) });
  fake.endTurn(SID);
  const TAG2 = 'RELAY-OB-RETRYPOST-' + T;
  const [p1, p2] = await Promise.all([post('/api/send', { id: SID, text: `${TAG2}: a POST retried after its response was lost` }),
                                      post('/api/send', { id: SID, text: `${TAG2}: a POST retried after its response was lost` })]);
  await d.waitFor(ev, x => x.event === 'sendresult' && x.data.jobId === p1.json.jobId, 25000);
  await d.waitFor(ev, x => x.event === 'sendresult' && x.data.jobId === p2.json.jobId, 25000);
  fake.endTurn(SID);
  if (S.isRunning) fake.endTurn(SID);
  knownBug(inFile(TAG2) === 1, 'the same POST /api/send sent twice (a retry after a lost response) is delivered once (there is no idempotency key: mobile/index.js:1499-1508)',
    { deliveredTimes: inFile(TAG2) });
  if (S.isRunning) fake.endTurn(SID);

  console.log('\n--- 4. held messages keep their order ---');
  S.isRunning = true;
  const TA = 'RELAY-OB-ORDER-A-' + T, TB = 'RELAY-OB-ORDER-B-' + T;
  const ra = await sendRes(`${TA}: first`);
  const rb = await sendRes(`${TB}: second`);
  check(ra && rb && ra.held && rb.held, 'both are held behind the running turn, each with a handle', { a: ra && ra.delivery, b: rb && rb.delivery });
  const lst = (await pendingList()).filter(e => e.id === ra.outboxId || e.id === rb.outboxId).map(e => e.id);
  check(lst.join() === [rb.outboxId, ra.outboxId].join(), '/api/outbox lists the newer one first');
  check((S.queue || []).map(q => q.text.slice(0, TA.length)).join() === [TA, TB].join(), 'Desktop holds them in the order typed');
  fake.endTurn(SID);
  check(inFile(TA) === 1 && inFile(TB) === 0, 'the turn ends: the first is delivered, the second still waits');
  fake.endTurn(SID);
  const body = fs.readFileSync(file, 'utf8');
  check(inFile(TB) === 1 && body.indexOf(TA) < body.indexOf(TB), 'the next turn ends: the second is delivered, after the first');
  check(!!(await confirmedEv(ra.outboxId)) && !!(await confirmedEv(rb.outboxId)), 'both are confirmed to the phone');
  fake.endTurn(SID);

  console.log('\n--- 5. Cancel across an outage: refused while Desktop is away, works once it is back ---');
  S.isRunning = true;
  const TC = 'RELAY-OB-CANCEL-' + T;
  const rc = await sendRes(`${TC}: take this back`);
  check(rc && rc.held, 'a held message');
  H.setCdpPort(w, dead);
  const cx = await uiRes(await post('/api/queued/cancel', { id: SID, outboxId: rc.outboxId }));
  check(cx && cx.ok === false && cx.cancelled === false, 'with Desktop away the cancel says it did NOT cancel', cx && { ok: cx.ok, error: cx.error });
  const kept = readOb().find(e => e.id === rc.outboxId);
  check(!!kept && kept.state === 'pending' && !!kept.uuid, 'the slip and its handle are kept, so the cancel can be tried again');
  H.setCdpPort(w, fake.port);
  const cy = await uiRes(await post('/api/queued/cancel', { id: SID, outboxId: rc.outboxId }));
  check(cy && cy.ok === true && cy.cancelled === true, 'Desktop back: the same cancel works', cy && { ok: cy.ok, error: cy.error });
  fake.endTurn(SID);
  check(inFile(TC) === 0 && !readOb().some(e => e.id === rc.outboxId), 'it never arrives, and the slip is gone');

  console.log('\n--- 6. what survives a daemon restart ---');
  S.isRunning = true;
  const TD = 'RELAY-OB-RESTART-HELD-' + T, TE = 'RELAY-OB-RESTART-FAILED-' + T;
  const rd = await sendRes(`${TD}: held across a restart`);
  check(rd && rd.held, 'a held message before the restart');
  H.setCdpPort(w, dead);
  const re = await sendRes(`${TE}: failed before the restart`);
  check(re && re.ok === false, 'and a failed one');
  await d.stop();
  const now = Date.now();
  const staleId = 'ob_relay_stale_' + T;
  fs.writeFileSync(OB, JSON.stringify({ entries: readOb().concat([{ id: staleId, session: other.sessionId, text: 'RELAY-OB-STALE never arrived', delivery: 'queued',
    uuid: null, at: now - 20 * MIN, confirmedAt: null, state: 'pending' }]) }, null, 1));
  H.setCdpPort(w, fake.port);
  d = await H.boot(w);
  ev = d.stream(CLIENT);
  const after = await pendingList();
  const hd = after.find(e => e.id === rd.outboxId), fe = after.find(e => e.id === re.outboxId);
  check(!!hd && hd.held === true && hd.text.startsWith(TD), 'the held slip is still listed, still held (handle kept)', hd && { held: hd.held, state: hd.state });
  check(!!fe && fe.state === 'failed' && fe.text.startsWith(TE), 'the failed slip is still listed with its exact text, so Send again is offered');
  const al = await d.waitFor(ev, e => e.event === 'alert' && e.data.kind === 'outbox' && e.data.outboxId === staleId, 15000);
  check(!!al, 'a 20-minute-old unconfirmed slip raises one "may not have arrived" alert after the restart');
  const sn = await uiRes(await post('/api/queued/send-now', { id: SID, outboxId: rd.outboxId }));
  check(sn && sn.ok === true && sn.interrupted === true, 'Send now on the slip held from before the restart works', sn && { ok: sn.ok, error: sn.error });
  check(inFile(TD) === 1, 'it is delivered exactly once');
  check(!!(await confirmedEv(rd.outboxId)), 'and confirmed to the phone');
  const again = await post('/api/queued/send-now', { id: SID, outboxId: rd.outboxId });
  check(again.status === 409 && again.json.error === 'ALREADY_DELIVERED', 'refusal: Send now pressed again (a stale button after a reconnect) is refused, nothing sent twice', again.json.error);
  fake.endTurn(SID);
  await d.stop();

  d = await H.boot(w);
  ev = d.stream(CLIENT);
  await wait(6000);
  check(!ev.some(e => e.event === 'alert' && e.data.outboxId === staleId), 'refusal: after another restart the same stale slip is NOT alerted again');
  check((await pendingList()).some(e => e.id === staleId && e.suspect === true), 'but it is still listed as suspect, so nothing is forgotten');
  check(inFile(TD) === 1 && inFile(TC) === 0, 'over everything above, nothing was delivered twice and nothing cancelled arrived');

  await d.stop();
  fake.close();
  if (H.failures()) console.log(d.output().slice(-3000));
  w.cleanup();
}
