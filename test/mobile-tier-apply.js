// mobile-tier-apply.js — model / effort changes from the phone, queue-and-apply like the desktop.
// Ported from the private tool's test-tier-apply.js, which needed a REAL running session. Here the
// daemon talks to a stand-in desktop (test/mobile-harness.js fakeDesktop) over the same debugger
// protocol, so every request goes through the phone's HTTP API and SSE stream and every
// confirmation is read back from the session's own state, exactly as before.
//   1. effort labels land on the right CLI level (extra -> xhigh, ultracode -> the flag), and a
//      nonsense level is refused and never sent;
//   2. a MODEL change made WHILE THE SESSION IS RUNNING is accepted, the result says `pending`,
//      the turn in flight finishes on the OLD model and the NEXT turn's message carries the new one;
//      /api/tier reports modelPending in between and clears it afterwards.
'use strict';
const H = require('./mobile-harness');
const { check, wait } = H;

(async () => {
  const fake = await H.fakeDesktop();
  const w = H.world('tier', { settings: { cdpPort: fake.port } });
  const SID = w.sessions()[0].sessionId;
  const ts = () => new Date().toISOString();
  const S = fake.sessions[SID] = { model: 'claude-opus-5', effort: 'high', ultracode: false, isRunning: false,
    transcript: [{ type: 'assistant', timestamp: new Date(Date.now() - 60000).toISOString(), message: { model: 'claude-opus-5' } }] };
  const endTurn = () => { S.transcript.push({ type: 'assistant', timestamp: ts(), message: { model: S.model } }); S.isRunning = false; };
  const fam = (s) => String(s || '').replace(/^claude-/, '').split(/[\s\-_[]/)[0].toLowerCase();

  const d = await H.boot(w);
  const CLIENT = 'test-tier';
  const ev = d.stream(CLIENT);
  await wait(800);
  const post = (p, body) => d.req(p, { method: 'POST', body, headers: { 'X-Baton-Client': CLIENT } });
  // An effort change answers in the same request since g1133 (sync); a model change still sends a job.
  const answer = async (p) => p.json && p.json.sync ? p.json : result(p.json.jobId);
  const result = async (jobId) => { const e = await d.waitFor(ev, x => x.event === 'uiresult' && x.data.jobId === jobId, 20000); return e && e.data; };
  const tier = async () => (await d.req('/api/tier?id=' + encodeURIComponent(SID))).json;

  const start = await tier();
  check(start.ok && start.recorded && start.applied, '/api/tier reads the session (recorded + applied + effort)', start);

  console.log('\n--- 1. effort labels ---');
  for (const [label, want] of [['extra', 'xhigh'], ['ultracode', 'ultracode'], ['max', 'max'], ['high', 'high']]) {
    const p = await post('/api/effort', { id: SID, effort: label });
    const r = await answer(p);
    const t = await tier();
    const landed = label === 'ultracode' ? t.ultracode === true : (t.effort === want && !t.ultracode);
    check(r && r.ok && landed, `effort "${label}" -> the session reports ${label === 'ultracode' ? 'ultracode:true' : want}`, { ok: r && r.ok, effort: t.effort, ultracode: t.ultracode, label: t.effortLabel });
  }
  check((await tier()).effortLabel === 'high', 'the CLI level is shown back in the app\'s words');
  {
    const before = fake.calls.length;
    const p = await post('/api/effort', { id: SID, effort: 'turbo' });
    const r = await answer(p);
    check(r && !r.ok && /not an effort level/.test(r.error || ''), 'a nonsense effort is refused with the app\'s own words', r && r.error);
    check(!fake.calls.slice(before).some(c => c[0] === 'setEffort' || c[0] === 'applyFlagSettings'), '...and nothing was sent to the session');
  }

  console.log('\n--- 2. model change WHILE RUNNING ---');
  S.isRunning = true;
  check((await tier()).running === true, 'the session is running');
  const p = await post('/api/model', { id: SID, model: 'Sonnet 5' });
  check(p.status === 202 && p.json.ok && !!p.json.jobId, 'POST /api/model while running answers 202 (accepted, not refused)', p.json);
  const r = await result(p.json.jobId);
  check(r && r.ok, 'the SSE result is ok', r);
  check(r && r.pending === true && r.confirmed === false && fam(r.was) === 'opus', '...and says PENDING, naming the running turn\'s model', r && { pending: r.pending, was: r.was, note: r.note });
  check(!(r && /running/i.test(String(r.error || ''))), '...and NOT "cannot change while the session is running"');
  const mid = await tier();
  check(fam(mid.recorded) === 'sonnet' && mid.modelPending === true, '/api/tier mid-turn: recorded=sonnet and modelPending=true', { recorded: mid.recorded, applied: mid.applied, modelPending: mid.modelPending });
  endTurn();   // the turn that was in flight finishes on the model it started with
  S.transcript[S.transcript.length - 1].message.model = 'claude-opus-5';
  const t1 = await tier();
  check(fam(t1.applied) === 'opus' && t1.modelPending === true, 'the turn in flight finished on the OLD model; the change is still pending', { applied: t1.applied, modelPending: t1.modelPending });
  await wait(20);
  S.isRunning = true; endTurn();   // the NEXT turn
  const t2 = await tier();
  check(fam(t2.applied) === 'sonnet', 'the NEXT turn\'s own assistant message is on the NEW model', t2.applied);
  check(fam(t2.recorded) === fam(t2.applied) && t2.modelPending === false, '/api/tier now agrees: recorded == applied, modelPending=false', { recorded: t2.recorded, modelPending: t2.modelPending });

  console.log('\n--- an idle change applies at once ---');
  const q = await post('/api/model', { id: SID, model: 'Opus 5' });
  const qr = await result(q.json.jobId);
  check(qr && qr.ok && qr.confirmed === true && qr.pending === false, 'an idle session confirms the change immediately', qr && { confirmed: qr.confirmed, pending: qr.pending });

  await d.stop();
  fake.close();
  if (H.failures()) console.log(d.output().slice(-3000));
  H.finish(w);
})().catch(e => { console.error('THREW', e); process.exit(1); });
