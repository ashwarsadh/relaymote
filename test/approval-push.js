// approval-push.js — Ashwar 21-Oct-2026: "Using relaymote u shud approve such requests like creative cloud use etc.
// I am not in my pc to allow. ... I want you to allow or show allow button on relaymote". A PC approval (computer-use
// "Allow Claude to use X?", a session's Allow/Deny prompt) reaches the phone as "Approval needed" with the ask and his
// Allow / Deny; only his tap answers it; risky asks (credentials, money, deletion, security) get no one-tap Allow.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failed = 0;
const check = (ok, name, extra) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra !== undefined && !ok ? '  ' + JSON.stringify(extra).slice(0, 400) : ''}`); if (!ok) failed++; };
const root = path.join(__dirname, '..');
const { approvalRisk } = require('../mobile/permission');

// 1. Risk words: no one-tap Allow for these.
for (const [t, risky] of [
  ['Allow Claude to use Adobe Creative Cloud? Install Illustrator for the print library.', false],
  ['Allow Claude to use Calculator?', false],
  ['Allow Claude to use Control Panel?', true],
  ['Bash: rm -rf build', true],
  ['Enter the API key for the portal', true],
  ['Allow Claude to use Google Chrome? Pay the FedEx invoice', true],
  ['Allow Claude to use Windows Security?', true],
]) check(!!approvalRisk(t) === risky, (risky ? 'risky: ' : 'plain: ') + t, approvalRisk(t));

(async () => {
  // 2. approvalEvent turns the awaiting push into an approval with the ask and the buttons.
  const idx = fs.readFileSync(path.join(root, 'mobile', 'index.js'), 'utf8');
  const fnSrc = idx.slice(idx.indexOf('async function approvalEvent'), idx.indexOf('async function notifyAttention'));
  const mk = (pk, read) => { const logs = [], reads = []; const x = { ui: (f) => f(), peekPermission: async () => pk, approvalRisk, log: (l) => logs.push(l), String, Object, logs, reads,
    readPermission: async (id, o) => { reads.push([id, o]); return read || { ok: true, present: false }; } };
    vm.runInNewContext(fnSrc + '\nthis.f = approvalEvent;', x); return x; };
  const card = { ok: true, present: true, card: true, here: 'local_other',
    request: 'Allow Claude to use Adobe Creative Cloud? Install Illustrator for the print library. Your other windows will be hidden, then restored when Claude is done.',
    options: [{ key: 'k0', label: 'Deny', raw: 'Deny', kind: 'deny' }, { key: 'k1', label: 'Allow for this session', raw: 'Allow for this session', kind: 'allow' }] };
  let x = mk(card), evt = { id: 'local_pf', kind: 'awaiting', title: 'Print Finder', body: 'Needs your input', tag: 'sess-local_pf' };
  await x.f({ id: 'local_pf', title: 'Print Finder' }, evt);
  check(evt.kind === 'approval' && /^Approval needed · Print Finder/.test(evt.title), 'the push says "Approval needed" and names the session', evt.title);
  check(/Creative Cloud/.test(evt.body) && /5 minutes/.test(evt.body), 'the body carries the ask and that it is declined by itself in ~5 min', evt.body);
  check(evt.actions.map(a => a.action).join() === 'allow,deny' && evt.actions[0].raw === 'Allow for this session' && evt.requireInteraction,
    'Allow and Deny buttons carry the exact PC button words; the notification stays until answered', evt.actions);
  x = mk({ ...card, request: 'Allow Claude to use Control Panel? Change the firewall' });
  evt = { id: 'local_pf', kind: 'awaiting', title: 't', body: 'b' };
  await x.f({ id: 'local_pf', title: 'Print Finder' }, evt);
  check(evt.kind === 'approval' && evt.actions.map(a => a.action).join() === 'deny' && evt.risk && /open Relaymote/.test(evt.body),
    'a risky ask has NO one-tap Allow: only Deny, and "open Relaymote to answer"', evt);
  x = mk({ ...card, card: false, here: 'local_someone_else' });
  evt = { id: 'local_pf', kind: 'awaiting', title: 't', body: 'Needs your input' };
  await x.f({ id: 'local_pf', title: 'Print Finder' }, evt);
  check(evt.kind === 'awaiting' && !evt.actions, "another session's own prompt on screen is not pinned on this one", evt);
  check(x.reads.length === 1 && x.reads[0][0] === 'local_pf' && x.reads[0][1].restore === true,
    'nothing for it on screen -> its own view is read, and the PC view is put back', x.reads);
  x = mk({ ok: true, present: false });
  evt = { id: 'a', kind: 'awaiting', title: 't', body: 'Needs your input' };
  await x.f({ id: 'a', title: 't' }, evt);
  check(evt.kind === 'awaiting' && evt.body === 'Needs your input', 'no approval anywhere -> the plain awaiting push is unchanged');
  // Measured 21-Oct: the card was not drawn in Print Finder's view, only once the Conductor's was opened.
  x = mk({ ok: true, present: false, here: 'local_pf', card: false }, { ...card, here: undefined, card: true });
  evt = { id: 'local_me', kind: 'awaiting', title: 't', body: 'Needs your input' };
  await x.f({ id: 'local_me', title: 'RelayMote' }, evt);
  check(evt.kind === 'approval' && evt.actions.length === 2, 'a card not drawn in the current view is found by opening the waiting session', evt);
  check(/if \(st === 'awaiting'\) await approvalEvent\(s, evt\);/.test(idx), 'notifyAttention enriches every awaiting push');
  check(!/answerPermission\(/.test(fnSrc), 'approvalEvent never answers anything itself');

  // 3. sw.js shows the buttons and answers ONLY from his tap on one.
  const shown = [], fetched = [], opened = [];
  const listeners = {};
  const ctx = {
    self: { addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); }, location: { origin: 'https://h' },
      registration: { showNotification: async (t, o) => shown.push({ t, o }) },
      clients: { matchAll: async () => [], openWindow: async (u) => opened.push(u) } },
    caches: { open: async () => ({ put: async () => {}, match: async () => null }) },
    fetch: async (u, o) => { fetched.push({ u, body: JSON.parse(o.body) }); return { status: 200, json: async () => ({ ok: true, chose: 'Allow for this session' }) }; },
    Response: class { static redirect() {} }, URL, Date, Math, String, JSON, Object, Array, console, atob: () => '', Uint8Array,
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'mobile', 'public', 'sw.js'), 'utf8'), ctx);
  let wait = null;
  const pushPayload = { id: 'local_pf', kind: 'approval', title: 'Approval needed · Print Finder', body: 'Allow Claude to use Adobe Creative Cloud?',
    tag: 'approval-local_pf', requireInteraction: true, actions: [{ action: 'allow', title: 'Allow for this session', raw: 'Allow for this session' }, { action: 'deny', title: 'Deny', raw: 'Deny' }], url: '/?s=local_pf' };
  for (const f of listeners.push || []) f({ data: { json: () => pushPayload }, waitUntil: (p) => { wait = p; } });
  await wait;
  const n = shown[0];
  check(n && n.o.requireInteraction && n.o.actions.length === 2 && n.o.data.answers.allow === 'Allow for this session', 'the notification shows Allow / Deny and keeps the exact words', n && n.o);
  const click = async (action) => { let w = null; const ev = { action, notification: { close() {}, data: n.o.data }, waitUntil: (p) => { w = p; } };
    for (const f of listeners.notificationclick || []) f(ev); await w; };
  await click('');
  check(fetched.length === 0, 'tapping the notification body answers nothing (it only opens the session)');
  await click('allow');
  check(fetched.length === 1 && fetched[0].u === '/api/permission/answer' && fetched[0].body.kind === 'allow' && fetched[0].body.raw === 'Allow for this session'
    && fetched[0].body.id === 'local_pf' && fetched[0].body.wait === true, 'his Allow tap sends exactly that answer for that session', fetched[0]);
  check(shown.some(s => s.t === 'Allowed on the PC'), 'and he is told it was done on the PC', shown.map(s => s.t));
  ctx.fetch = async () => ({ status: 409, json: async () => ({ ok: false, error: 'NO_PROMPT', message: 'Nothing is waiting for permission in that session.' }) });
  await click('deny');
  check(shown.some(s => /^Not answered/.test(s.t) && /Nothing is waiting/.test(s.o.body)), 'a dialog that already closed (e.g. timed out) is reported, not claimed', shown.map(s => s.t));

  // 4. The answer route logs who answered and is closed to scoped colleagues.
  check(/'approval answer: '/.test(idx) && /body\.wait/.test(idx), 'the answer route logs each answer and can reply with the result');
  check(/isSubuser\(identity\) && \[[^\]]*'\/api\/permission\/answer'/.test(idx), 'a scoped colleague login cannot answer approvals');

  console.log(failed ? `\n${failed} FAILED` : '\napproval-push: all ok');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
