// mobile-subuser-scope.js — a second, connected identity requesting an ungranted session BY ID
// and being refused, not merely absent from a list. Ported from the private tool's
// test-subuser-scope.js (which ran against the live daemon and real session ids); here the daemon
// runs in a temp world on the demo sessions. Nothing is ever sent to a real session: the debugger
// port points at nothing, and every refusal below happens before any desktop work.
'use strict';
const H = require('./mobile-harness');
const { check } = H;
const w = H.world('subscope');

(async () => {
  const d = await H.boot(w);
  const ids = ((await d.req('/api/sessions?limit=300')).json.sessions || []).map(s => s.id);
  check(ids.length >= 2, 'precondition: at least 2 sessions on disk', ids.length);
  const [GRANTED, NOT_GRANTED] = ids;
  const su = H.subuser(w, 'test-subuser-scope', [GRANTED]);
  const SUB = su.create().token;
  const as = (p, o = {}) => d.req(p, { ...o, token: SUB });

  const subIds = ((await as('/api/sessions?limit=300')).json.sessions || []).map(s => s.id);
  check(subIds.includes(GRANTED), 'sub-user list contains the granted id');
  check(!subIds.includes(NOT_GRANTED) && subIds.length === 1, 'sub-user list does NOT contain the ungranted id', `list has ${subIds.length}`);

  const refused = (r) => r.status === 403 && r.json.error === 'NOT_GRANTED';
  check(refused(await as(`/api/file?session=${NOT_GRANTED}&path=x.txt`)), 'GET /api/file on an ungranted id -> 403 NOT_GRANTED');
  check(refused(await as(`/api/permission?id=${NOT_GRANTED}`)), 'GET /api/permission on an ungranted id -> 403 NOT_GRANTED');
  check(refused(await as(`/api/tier?id=${NOT_GRANTED}`)), 'GET /api/tier on an ungranted id -> 403 NOT_GRANTED');
  check(refused(await as('/api/send', { method: 'POST', body: { id: NOT_GRANTED, text: 'must never be dispatched' } })), 'POST /api/send on an ungranted id -> 403 NOT_GRANTED (nothing dispatched)');
  check(refused(await as('/api/model', { method: 'POST', body: { id: NOT_GRANTED, model: 'opus' } })), 'POST /api/model on an ungranted id -> 403 NOT_GRANTED');
  check(refused(await as('/api/queued/cancel', { method: 'POST', body: { id: NOT_GRANTED, outboxId: 'x' } })), 'POST /api/queued/cancel on an ungranted id -> 403 NOT_GRANTED');

  const perm2 = await as(`/api/permission?id=${GRANTED}`);
  check(perm2.json.error !== 'NOT_GRANTED', 'the GRANTED id is NOT scope-refused', JSON.stringify(perm2.json).slice(0, 80));

  for (const p of ['/api/board', '/api/settings', '/api/notify-config', '/api/account-switch']) {
    const r = await as(p);
    check(r.status === 403 && r.json.error === 'NOT_AVAILABLE', `a whole route off the allowlist (${p}) -> 403 NOT_AVAILABLE`, r.status);
  }
  const t = await as('/api/notify/test-backup', { method: 'POST', body: {} });
  check(t.status === 403, 'a sub-user cannot fire the alert channel test', t.status);

  // The SSE broadcast filter: a sub-user's stream carries only granted sessions.
  const sub = d.stream('sub', { token: SUB });
  const own = d.stream('owner');
  await H.wait(1500);
  // The list event goes out when the list changes; change it (a new, ungranted session appears).
  const fs = require('fs'), path = require('path');
  const nid = 'local_22222222-0000-4000-8000-000000000002';
  fs.writeFileSync(path.join(w.store, nid + '.json'), JSON.stringify({ sessionId: nid, title: 'Appears later', cwd: null, isArchived: false, createdAt: Date.now(), lastActivityAt: Date.now() }));
  const evo = await d.waitFor(own, e => e.event === 'sessions' && e.data.sessions.some(x => x.id === nid), 15000);
  check(!!evo && evo.data.sessions.length > 1, 'the owner\'s stream carries every session, including the new one', evo && evo.data.sessions.length);
  const subLists = sub.filter(e => e.event === 'sessions');
  check(subLists.length > 0 && subLists.every(e => e.data.sessions.length === 1 && e.data.sessions[0].id === GRANTED),
        'every SSE session list sent to the sub-user admits only the granted id', subLists.map(e => e.data.sessions.length));

  // A token that is an Object.prototype member name used to resolve to a sub-user (db[token]):
  // ?k=constructor signed anyone in. Every way of presenting a key is tried.
  for (const bad of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    const viaK = await d.req('/api/bootstrap?k=' + bad, { token: null });
    const viaBearer = await d.req('/api/bootstrap', { token: bad });
    const viaCookie = await d.req('/api/bootstrap', { cookie: bad });
    check(viaK.status === 401 && viaBearer.status === 401 && viaCookie.status === 401,
      `the key "${bad}" is refused by ?k=, Bearer and cookie (401)`, [viaK.status, viaBearer.status, viaCookie.status]);
  }

  su.revoke();
  check((await as('/api/sessions')).status === 401, 'after revoke, the SAME token is unauthenticated (401)');
  su.remove();

  await d.stop();
  if (H.failures()) console.log(d.output().slice(-3000));
  H.finish(w);
})().catch(e => { console.error('THREW', e); process.exit(1); });
