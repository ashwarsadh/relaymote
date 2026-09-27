// mobile-account-switch.js — noticing a Claude account switch, end to end through the daemon poll,
// the SSE stream and the phone's API. Ported from the private tool's test-account-switch.js, which
// drove the LIVE daemon and was opt-in because it pushed a real card to a real phone. This one runs
// in a temp world: two fake account scopes on disk, a switch simulated by rewriting the detector's
// baseline, and the backup alert channel pointed at a local recorder instead of a phone.
//
// Also covers the Relaymote fix: the alert is gated on the Accounts module and its words come from the
// real sync settings (it used to claim "sync both ways every 15 minutes" regardless).
'use strict';
const H = require('./mobile-harness');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { check, wait } = H;

const OTHER = 'aaaaaaaa-other-acct', OTHER_ORG = 'aaaaaaaa-other-org';
const w = H.world('acctswitch');
// A second account with a record, and Desktop's config naming the demo account as the live one.
const otherDir = path.join(w.appdata, 'Claude', 'claude-code-sessions', OTHER, OTHER_ORG);
fs.mkdirSync(otherDir, { recursive: true });
fs.writeFileSync(path.join(otherDir, 'local_11111111-0000-4000-8000-000000000001.json'),
  JSON.stringify({ sessionId: 'local_11111111-0000-4000-8000-000000000001', title: 'Other account work', cwd: null, isArchived: false, createdAt: Date.now() - 1e6, lastActivityAt: Date.now() - 1e6 }));
fs.writeFileSync(path.join(w.appdata, 'Claude', 'config.json'), JSON.stringify({ lastKnownAccountUuid: H.DEMO_ACCOUNT }));

const hooks = [];
const srv = http.createServer((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => { try { hooks.push(JSON.parse(b)); } catch { hooks.push({ raw: b }); } res.end('ok'); }); });

(async () => {
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const settingsFile = path.join(w.home, 'settings.json');
  const s0 = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  s0.notifications = { backup: { kind: 'webhook', url: `http://127.0.0.1:${srv.address().port}/hook` } };
  fs.writeFileSync(settingsFile, JSON.stringify(s0, null, 2));

  const d = await H.boot(w);
  const STATE_FILE = path.join(w.home, 'state', 'account-scope.json');
  const got = d.stream('e2e-switch');
  // Wait for the detector's first baseline (the real, active scope).
  for (let i = 0; i < 40 && !fs.existsSync(STATE_FILE); i++) await wait(250);
  const real = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  check(real.scope === H.DEMO_ACCOUNT + '/' + H.DEMO_ORG, 'the detector baselines on the account Desktop names', real.scope);
  check((await d.req('/api/account-switch')).json.pending === null, 'no question before any switch');

  const simulateSwitchFrom = (acct, org) => fs.writeFileSync(STATE_FILE, JSON.stringify(
    { scope: acct + '/' + org, accountId: acct, orgId: org, since: Date.now() - 60000, firstSeen: real.firstSeen }, null, 1));

  console.log('--- Accounts module OFF (the default): told, not asked ---');
  simulateSwitchFrom(OTHER, OTHER_ORG);
  let a = await d.waitFor(got, e => e.event === 'alert' && e.data.id === 'account-switch');
  check(!!a, 'the daemon poll noticed the switch and alerted the open app');
  check(a && a.data.kind === 'info' && /set up Accounts/.test(a.data.body), 'with the neutral "set up Accounts" text', a && a.data.body);
  check(a && !/both ways|15 minutes/.test(a.data.body), 'and without the old false sync claim');
  await wait(3000);
  check(!got.some(e => e.event === 'accountswitch'), 'no "carry the chats over?" card: with the module off nothing could act on it');
  let g = (await d.req('/api/account-switch')).json;
  check(g.pending === null && g.accountsModule === false && /Turn on Accounts/.test(g.note), 'GET /api/account-switch: nothing pending, note says how to enable it', g.note);
  let hk = hooks.find(h => /switched Claude account/.test(h.title || ''));
  check(!!hk && /set up Accounts/.test(hk.body), 'the alert went through the backup channel (no phone has push)', hk && hk.body);
  const nHooks = hooks.length;
  await wait(3000);
  check(hooks.length === nHooks && got.filter(e => e.event === 'alert' && e.data.id === 'account-switch').length === 1,
        'it is said once, not on every poll');

  console.log('\n--- Accounts module ON: asked, with words from the real settings ---');
  const on = await d.req('/api/settings', { method: 'POST', body: { modules: { accounts: true } } });
  check(on.json.settings && on.json.settings.modules.accounts === true, 'Accounts module switched on');
  // The detector has re-baselined to the demo account; simulate a switch from the other one again.
  simulateSwitchFrom(OTHER, OTHER_ORG);
  const q0 = await d.waitFor(got, e => e.event === 'accountswitch');
  check(!!q0, 'the app was told live over the stream');
  let q = null;
  for (let i = 0; i < 20 && !q; i++) { q = (await d.req('/api/account-switch')).json.pending; if (!q) await wait(500); }
  check(!!q, 'the daemon raised a question');
  check(q && !!q.fromAccount && !!q.toAccount && q.toAccount !== q.fromAccount, 'it names both accounts', q && `${q.fromAccount} -> ${q.toAccount}`);
  check(q && q.answer === null, 'it is unanswered, and nothing has acted');
  a = got.filter(e => e.event === 'alert' && e.data.id === 'account-switch').pop();
  check(a && a.data.kind === 'question' && /additively/.test(a.data.body) && /on demand/.test(a.data.body),
        'the alert says what the defaults really do: additive, on demand', a && a.data.body);
  g = (await d.req('/api/account-switch')).json;
  check(/press Sync/.test(g.note) && !/both ways|15 minutes/.test(g.note), 'the card note is generated from the settings', g.note);
  check(/press Sync/.test(g.transferToast || ''), 'and so is the toast after "carry the chats over"', g.transferToast);

  const before = fs.readFileSync(path.join(w.home, 'state', 'account-switch.json'), 'utf8');
  await wait(4000);
  check(fs.readFileSync(path.join(w.home, 'state', 'account-switch.json'), 'utf8') === before && !!(await d.req('/api/account-switch')).json.pending,
        'an unanswered question does not expire, re-ask, or act');

  const bad = await d.req('/api/account-switch', { method: 'POST', body: { answer: 'maybe' }, headers: { 'X-Baton-Client': 'e2e-switch' } });
  check(bad.json.ok === false && bad.json.error === 'BAD_ANSWER', 'a nonsense answer is refused', bad.json);
  const ans = await d.req('/api/account-switch', { method: 'POST', body: { answer: 'dismiss' }, headers: { 'X-Baton-Client': 'e2e-switch' } });
  check(ans.json.ok === true && ans.json.question.answer === 'dismiss', 'the answer is accepted');
  check(JSON.parse(fs.readFileSync(path.join(w.home, 'state', 'account-switch.json'), 'utf8')).answer === 'dismiss', 'and it was on DISK before the reply came back');
  check((await d.req('/api/account-switch')).json.pending === null, 'the question is no longer pending');

  console.log('\n--- notifications switched off: the card stays in the app, nothing leaves the machine ---');
  await d.req('/api/settings', { method: 'POST', body: { notifications: { enabled: false } } });
  const n2 = hooks.length;
  simulateSwitchFrom('bbbbbbbb-third-acct', 'bbbbbbbb-third-org');
  const q2 = await d.waitFor(got, e => e.event === 'accountswitch' && e.data && String(e.data.from || '').startsWith('bbbbbbbb'));
  check(!!q2, 'the question is still raised in the app');
  await wait(1500);
  check(hooks.length === n2, 'but no alert goes out while notifications are off', hooks.length - n2);

  console.log('\n--- a sub-user hears nothing about accounts ---');
  const sessions = (await d.req('/api/sessions?limit=5')).json.sessions || [];
  const su = H.subuser(w, 'switch-sub', [sessions[0] && sessions[0].id]).create();
  const sub = d.stream('sub-client', { token: su.token });
  await wait(600);
  await d.req('/api/settings', { method: 'POST', body: { notifications: { enabled: true } } });
  simulateSwitchFrom('cccccccc-fourth-acct', 'cccccccc-fourth-org');
  await d.waitFor(got, e => e.event === 'accountswitch' && e.data && String(e.data.from || '').startsWith('cccccccc'));
  await wait(1000);
  check(sub.status === 200, 'precondition: the sub-user stream is connected', sub.status);
  check(!sub.some(e => e.event === 'accountswitch' || (e.event === 'alert' && e.data.id === 'account-switch')), 'a scoped sub-user receives neither the card nor the alert');
  const sw = await d.req('/api/account-switch', { token: su.token });
  check(sw.status === 403, 'and cannot read the question', sw.status);

  await d.stop();
  srv.close();
  if (H.failures()) console.log(d.output().slice(-3000));
  H.finish(w);
})().catch(e => { console.error('THREW', e); process.exit(1); });
