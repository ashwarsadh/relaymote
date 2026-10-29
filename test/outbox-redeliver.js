// outbox-redeliver.js — 21-Oct-2026. Claude Desktop crashed and restarted; Ashwar: "if I am losing some messages
// from the Relay mode, then we can help to fetch the missing things". At-least-once: a send Desktop accepted and then
// lost (no row in the transcript) is re-delivered once with a visible "[Redelivered by Relaymote …]" line, confirmed
// in the transcript; if the re-delivery is lost too, the phone is told "NOT delivered". Real server.js, demo world,
// the send seam losing the first (or every) send the way a crash does.
'use strict';
const H = require('./mobile-harness');
const { check } = H;

async function run(mode) {
  const w = H.world('redeliver-' + mode);
  const ids = w.sessions().map(s => s.sessionId || s.id).filter(Boolean);
  const SID = ids[0];
  const d = await H.boot(w, { RELAYMOTE_FAKE_SEND: mode, RELAYMOTE_OUTBOX_ACCEPT_MS: '1500' });
  const text = 'Rishikesh trip: book the 6 am train for ' + mode + ' ' + Date.now();
  try {
    const ev = d.stream('phone-' + mode);
    const r = await d.req('/api/send', { method: 'POST', headers: { 'X-Baton-Client': 'phone-' + mode }, body: { id: SID, text, cmid: 'm' + Date.now().toString(36) + mode } });
    check(r.status === 202 && r.json.ok, `[${mode}] the send is accepted`, r.status);
    const res = await d.waitFor(ev, e => e.event === 'sendresult' && e.data.id === SID);
    check(!!res && res.data.ok && res.data.outboxId, `[${mode}] Desktop "took" it (an outbox id), yet nothing is in the transcript`, res && res.data.outboxId);
    const obId = res && res.data.outboxId;
    if (mode === 'drop-first') {
      const red = await d.waitFor(ev, e => e.event === 'outbox' && e.data.redelivered, 20000);
      check(!!red && red.data.redelivered[0].id === obId && red.data.redelivered[0].ok, '[drop-first] the lost send is re-delivered by itself', red && red.data);
      const conf = await d.waitFor(ev, e => e.event === 'outbox' && (e.data.confirmed || []).some(x => x.id === obId), 20000);
      check(!!conf, '[drop-first] the re-delivery is then CONFIRMED in the transcript');
      const tr = await d.req('/api/session/' + SID + '?limit=20');
      const mine = (tr.json.transcript && tr.json.transcript.messages || []).filter(m => m.role === 'user' && String(m.text).includes(text));
      check(mine.length === 1 && /^\[Redelivered by Relaymote at \d\d:\d\d IST: the first send at \d\d:\d\d IST never reached this session\]/.test(mine[0].text),
        '[drop-first] the session got it ONCE, with the visible redelivered line', mine.map(m => m.text.slice(0, 90)));
      check(/REDELIVERED once via the composer: ok/.test(d.output()) && /outbox: confirmed /.test(d.output()), '[drop-first] the log says so');
    } else {
      const bad = await d.waitFor(ev, e => e.event === 'alert' && e.data.title === 'Message NOT delivered', 25000);
      check(!!bad && bad.data.outboxId === obId, '[drop-all] re-delivery lost too -> the phone is told "Message NOT delivered"', bad && bad.data.title);
      const ob = await d.req('/api/outbox');
      const e = (ob.json.pending || []).find(x => x.id === obId);
      check(!!e && e.notDelivered && e.redelivered && e.state === 'failed', '[drop-all] /api/outbox shows it NOT delivered (redelivered once), so Send again is offered', e && { st: e.state, nd: e.notDelivered, rd: e.redelivered });
      const tr = await d.req('/api/session/' + SID + '?limit=20');
      check(!(tr.json.transcript.messages || []).some(m => String(m.text).includes(text)), '[drop-all] nothing landed, and nothing was claimed delivered');
    }
  } finally { await d.stop(); w.cleanup(); }
  return w;
}

// 29-Oct (Ashwar: "i sent msgs from relay kote and they never reached"): the send went into the outbox and then hung
// on Desktop's debugger link, so it had no delivery and was never re-sent. Now its job closes after the deadline
// and the PC re-delivers it after STUCK_MS, once, with the visible line.
async function runHang() {
  const w = H.world('redeliver-hang');
  const SID = w.sessions().map(s => s.sessionId || s.id).filter(Boolean)[0];
  const d = await H.boot(w, { RELAYMOTE_FAKE_SEND: 'hang-first', RELAYMOTE_OUTBOX_STUCK_MS: '2000', RELAYMOTE_SEND_DEADLINE_MS: '1500', RELAYMOTE_FAKE_HANG_MS: '14000' });
  const text = 'Euro set reply: wrong photo, send a revised quote ' + Date.now();
  try {
    const ev = d.stream('phone-hang');
    const cmid = 'h' + Date.now().toString(36);
    const t0 = Date.now();
    const r = await d.req('/api/send', { method: 'POST', headers: { 'X-Baton-Client': 'phone-hang' }, body: { id: SID, text, cmid } });
    check(r.status === 202 && r.json.ok, '[hang] the send is accepted', r.status);
    const res = await d.waitFor(ev, e => e.event === 'sendresult' && e.data.id === SID, 10000);
    check(!!res && res.data.ok && res.data.delivery === 'pc-outbox', '[hang] a send stuck past the deadline closes as taken by the PC outbox (the phone stops waiting)', res && res.data);
    const again = await d.req('/api/send', { method: 'POST', headers: { 'X-Baton-Client': 'phone-hang' }, body: { id: SID, text, cmid } });
    check(again.status === 200 && again.json.already, '[hang] a phone retry with the same id is not sent a second time', again.json);
    const red = await d.waitFor(ev, e => e.event === 'outbox' && e.data.redelivered, 25000);
    check(!!red && red.data.redelivered[0].ok, '[hang] the PC re-delivers the stuck send by itself', red && red.data);
    await d.waitFor(ev, e => e.event === 'outbox' && (e.data.confirmed || []).length, 20000);
    const tr = await d.req('/api/session/' + SID + '?limit=20');
    const mine = (tr.json.transcript && tr.json.transcript.messages || []).filter(m => m.role === 'user' && String(m.text).includes(text));
    check(mine.length === 1 && /^\[Redelivered by Relaymote/.test(mine[0].text), '[hang] the session got it once, marked redelivered', mine.map(m => m.text.slice(0, 90)));
    check(/its send never finished\) -- REDELIVERED once via the composer: ok/.test(d.output()), '[hang] the log names why', d.output().split('\n').filter(l => /REDELIVERED|unfinished/.test(l)));
    // 22:23 IST that night the hung send itself went through after all. It must stand down, not land a second copy.
    await new Promise(r => setTimeout(r, Math.max(0, 16000 - (Date.now() - t0))));
    const tr2 = await d.req('/api/session/' + SID + '?limit=20');
    const all = (tr2.json.transcript && tr2.json.transcript.messages || []).filter(m => m.role === 'user' && String(m.text).includes(text));
    check(all.length === 1, '[hang] when the hung send finally wakes, it does not deliver a second copy', all.length);
  } finally { await d.stop(); w.cleanup(); }
}

(async () => {
  await runHang();
  await run('drop-first');
  const w = await run('drop-all');
  check(/'redelivered — the first send was lost; checking it arrived'/.test(H.src('mobile/public/app.js')), 'the phone bubble says "redelivered" while it is checked');
  check(/mineHere\.includes\(bodyOf\(e\.text\)\)/.test(H.src('mobile/public/app.js')), "the phone draws its own copy and the PC's copy of one message once, not twice (29-Oct)");
  check(/m\.role === 'user' \|\| m\.role === 'peer'/.test(H.src('mobile/public/app.js')), 'a message the PC recovered and relayed counts as delivered on the phone');
  H.finish(w);
})().catch(e => { console.error(e); process.exit(1); });
