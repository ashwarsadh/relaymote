// relay-stream.js — the SSE stream (/api/stream in mobile/index.js) under reconnects: what a client
// that drops and comes back is sent, what happens to a client that dies without a goodbye, whether
// the broadcast to everyone else survives it, whether a job's result follows its client across a
// reconnect, and whether sub-user filtering is re-applied on the new connection.
// Extends test/mobile-client-isolation.js (who receives which uiresult) and
// test/mobile-subuser-scope.js (the sub-user list filter on one connection).
// Offline: the debugger port points at a local server that accepts and never answers, so each
// desktop call takes its full probe timeout (~4s) and a /api/fast job takes ~8s: a window in which
// a client can drop and reconnect while its job is still running.
'use strict';
const H = require('./relay-harness');
const fs = require('fs');
const path = require('path');
const { check, knownBug, wait } = H;

(async () => {
  const silent = await H.silentServer();
  const w = H.world('relay-stream', { settings: { cdpPort: silent.port } });
  const d = await H.boot(w);
  const recs = w.sessions();
  const SID = recs[0].sessionId, GRANTED = recs[0].sessionId, NOT_GRANTED = recs[1].sessionId;
  const live = async () => (await d.req('/api/build')).json.connected;
  const newSession = (n) => {
    const id = 'local_33333333-0000-4000-8000-00000000000' + n;
    fs.writeFileSync(path.join(w.store, id + '.json'), JSON.stringify({ sessionId: id, title: 'Relay stream ' + n, cwd: null, isArchived: false, createdAt: Date.now(), lastActivityAt: Date.now() }));
    return id;
  };
  const listHas = (s, id) => s.some(e => e.event === 'sessions' && e.data.sessions.some(x => x.id === id));
  const fast = async (client) => (await d.req('/api/fast', { method: 'POST', body: { id: SID, fast: false }, headers: { 'X-Baton-Client': client } })).json.jobId;
  const gotResult = (s, job) => s.some(e => e.event === 'uiresult' && e.data.jobId === job);

  console.log('--- a client that connects is sent the state it watches ---');
  const A = d.stream('relay-A', { watch: SID });
  const m1 = await d.waitFor(A, e => e.event === 'messages' && e.data.id === SID, 10000);
  check(A.connected && !!m1 && Array.isArray(m1.data.messages) && m1.data.messages.length > 0, 'on connect it gets `: connected` and the watched session\'s transcript', m1 && m1.data.messages.length);
  check((await live()) === 1, 'the daemon counts one live client');

  console.log('\n--- it drops without a goodbye, then reconnects ---');
  A.kill();
  let n = null; for (let i = 0; i < 20; i++) { n = await live(); if (n === 0) break; await wait(150); }
  check(n === 0, 'a client whose connection dies is dropped from the broadcast set at once', n);
  const A2 = d.stream('relay-A', { watch: SID });
  const m2 = await d.waitFor(A2, e => e.event === 'messages' && e.data.id === SID, 10000);
  check(!!m2, 'the reconnected client is sent the watched transcript again (its stamp starts fresh), so the open chat is current');

  console.log('\n--- a dead client does not break the broadcast to the others ---');
  const B = d.stream('relay-B');
  const X = d.stream('relay-X');
  await wait(1200);
  X.kill();
  const id1 = newSession(1);
  check(!!(await d.waitFor(B, e => e.event === 'sessions' && e.data.sessions.some(x => x.id === id1), 15000)), 'the next list change still reaches B after X died mid-stream');
  const jB = await fast('relay-B');
  check(!!(await d.waitFor(B, e => e.event === 'uiresult' && e.data.jobId === jB, 20000)), 'and B still receives its own job result');
  check((await d.req('/api/outbox')).status === 200, 'the daemon is still serving');

  console.log('\n--- a job result follows its client across a reconnect ---');
  const X1 = d.stream('relay-X1'); await wait(500);
  const jX = await fast('relay-X1');
  await wait(300); X1.kill();
  await wait(700);
  const X2 = d.stream('relay-X1');
  check(!!(await d.waitFor(X2, e => e.event === 'uiresult' && e.data.jobId === jX, 20000)), 'reconnected (same client id) before the job finished: the result arrives on the new connection');
  const Y = d.stream('relay-Y'); await wait(500);
  const jY = await fast('relay-Y');
  await wait(300); Y.kill();
  // Wait until the daemon has logged the job's outcome (`fast <job> failed: ...`) while relay-Y is away.
  let doneAway = false;
  for (let i = 0; i < 150 && !doneAway; i++) { await wait(200); doneAway = d.output().includes(`fast ${jY} failed`); }
  check(doneAway, 'precondition: the job finished while its client was disconnected (daemon log shows its outcome)');
  await wait(300);
  const Y2 = d.stream('relay-Y');
  await wait(4000);
  knownBug(gotResult(Y2, jY), 'reconnected AFTER the job finished: the result is sent again (no replay; mobile/index.js:584-590 sends only to clients connected at that moment, so a phone that was reconnecting never hears how its action ended)',
    { received: gotResult(Y2, jY) });

  console.log('\n--- the session list after a reconnect ---');
  const C = d.stream('relay-C'); await wait(1500);
  C.kill();
  const id2 = newSession(2);
  check(!!(await d.waitFor(B, e => e.event === 'sessions' && e.data.sessions.some(x => x.id === id2), 15000)), 'B (connected all along) is sent the new list');
  const C2 = d.stream('relay-C');
  await wait(6000);
  const fetched = ((await d.req('/api/sessions?limit=300')).json.sessions || []).some(s => s.id === id2);
  check(fetched, 'a fetch of /api/sessions is current');
  knownBug(listHas(C2, id2), 'C, which missed that change while reconnecting, is sent the current list on reconnect (mobile/index.js:452-460 compares one GLOBAL lastListKey, so a list another client already saw is never resent)',
    { sessionsEventsOnReconnect: C2.filter(e => e.event === 'sessions').length });

  console.log('\n--- sub-user filtering is re-applied on every connection ---');
  const su = H.subuser(w, 'relay-sub', [GRANTED]);
  const SUB = su.create().token;
  const S1 = d.stream('relay-sub', { token: SUB, watch: NOT_GRANTED });
  await wait(4000);
  check(S1.status === 200 && !S1.some(e => e.event === 'messages'), 'refusal: a sub-user watching an ungranted session is sent no transcript (watch dropped)');
  S1.kill();
  const S2 = d.stream('relay-sub', { token: SUB, watch: GRANTED });
  check(!!(await d.waitFor(S2, e => e.event === 'messages' && e.data.id === GRANTED, 10000)), 'reconnected watching the granted one: its transcript is sent');
  S2.kill();
  const S3 = d.stream('relay-sub', { token: SUB });
  await wait(1200);
  const id3 = newSession(3);
  await d.waitFor(B, e => e.event === 'sessions' && e.data.sessions.some(x => x.id === id3), 15000);
  await wait(800);
  const subLists = S3.filter(e => e.event === 'sessions');
  check(subLists.length > 0 && subLists.every(e => e.data.sessions.length === 1 && e.data.sessions[0].id === GRANTED),
    'after two reconnects every list the sub-user is sent still admits only the granted id', subLists.map(e => e.data.sessions.length));
  const now = Date.now();
  fs.writeFileSync(path.join(w.home, 'state', 'outbox.json'), JSON.stringify({ entries: [GRANTED, NOT_GRANTED].map((sid, i) => ({
    id: 'ob_relay_sub_' + i, session: sid, text: 'RELAY-STREAM-STALE ' + i, delivery: 'queued', uuid: null, at: now - 20 * 60000, confirmedAt: null, state: 'pending' })) }, null, 1));
  await d.waitFor(B, e => e.event === 'alert' && e.data.outboxId === 'ob_relay_sub_1', 15000);
  await wait(800);
  const subAlerts = S3.filter(e => e.event === 'alert' && e.data.kind === 'outbox').map(e => e.data.outboxId);
  const ownAlerts = B.filter(e => e.event === 'alert' && e.data.kind === 'outbox').map(e => e.data.outboxId);
  check(ownAlerts.includes('ob_relay_sub_0') && ownAlerts.includes('ob_relay_sub_1'), 'the owner is alerted about both stale messages', ownAlerts);
  check(subAlerts.join() === 'ob_relay_sub_0', 'the reconnected sub-user is alerted only about the granted session\'s message', subAlerts);
  su.revoke();
  const S4 = d.stream('relay-sub', { token: SUB });
  await wait(1500);
  check(S4.status === 401, 'refusal: after revoke, a reconnect with the same token is refused (401)', S4.status);
  const id4 = newSession(4);
  await d.waitFor(B, e => e.event === 'sessions' && e.data.sessions.some(x => x.id === id4), 15000);
  await wait(800);
  const subNow = S3.filter(e => e.event === 'sessions');
  const stillFed = subNow.length > subLists.length;
  knownBug(!stillFed, 'a revoked sub-user\'s OPEN stream stops receiving (identity is captured once at connect, mobile/index.js:1459; the old connection keeps getting granted-session events until it drops)',
    { sessionsEventsAfterRevoke: subNow.length - subLists.length });
  su.remove();

  await d.stop();
  await silent.close();
  if (H.failures()) console.log(d.output().slice(-3000));
  H.finish(w, 'relay-stream');
})().catch(e => { console.error('THREW', e); process.exit(1); });
