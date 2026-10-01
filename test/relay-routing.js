// relay-routing.js — which session a message goes to, and the small queues around delivery:
// lib/owner.js (who owns a topic, the check before a send), lib/aliases.js (what routing learns),
// lib/router.js (task difficulty -> model/effort), lib/uiqueue.js (UI actions replayed later),
// lib/await.js (a master parked until its workers finish) and lib/wakes.js (who woke a session).
// Extends test/index.js, test/organizer.js and test/core.js with representative inputs and both
// sides of every guard; nothing here talks to Claude Desktop (uiqueue's desktop calls are stubbed).
'use strict';
const H = require('./relay-harness');
const W = H.world('relay-routing', { demo: false, env: true });
delete process.env.RELAYMOTE_ROLES_JSON;
delete process.env.RELAYMOTE_UIQUEUE_ATTEMPTS;
delete process.env.RELAYMOTE_UIQUEUE_MAX_AGE_MS;
const fs = require('fs');
const path = require('path');
const { check, knownBug } = H;

const config = require('../lib/config');
const owner = require('../lib/owner');
const aliases = require('../lib/aliases');
const router = require('../lib/router');

const id = (hex) => `local_${hex.repeat(8).slice(0, 8)}-1111-4111-8111-${hex.repeat(12).slice(0, 12)}`;
const A = id('a'), B = id('b'), C = id('c'), K = id('d'), X = id('e'), HD = id('f'), D1 = id('1'), D2 = id('2');
const ix = { sessions: {
  [A]: { id: A, title: 'Checkout flow e2e tests', project: 'web-app', group: 'Web', age_days: 1, cli: 'aaaa0001' },
  [B]: { id: B, title: 'Database migration to Postgres', project: 'backend', group: 'Backend', age_days: 3, cli: 'bbbb0001' },
  [C]: { id: C, title: 'Conductor', project: 'web-app', conductor: true },
  [K]: { id: K, title: 'Skill keeper for the docs', project: 'web-app' },
  [X]: { id: X, title: 'Checkout flow e2e tests (old)', project: 'web-app', archived: true },
  [HD]: { id: HD, title: 'Checkout flow e2e tests copy', project: 'web-app', in_sidebar: false },
  [D1]: { id: D1, title: 'Invoice PDF export pipeline', project: 'billing', group: 'Money' },
  [D2]: { id: D2, title: 'Invoice PDF export pipeline rewrite', project: 'reports', group: 'Money' },
}, projects: {} };

(async () => {
  if (!config.DATA.startsWith(W.dir)) { console.error('REFUSING TO RUN: data dir is not inside the temp world -', config.DATA); process.exit(1); }

  console.log('--- owner: no index is a refusal, never a guess ---');
  const emptyDir = path.join(W.dir, 'no-index'); fs.mkdirSync(emptyDir, { recursive: true });
  config.set({ ownerIndex: emptyDir });
  {
    const r = owner.resolve('fix the checkout flow e2e tests');
    check(r.ok === false && r.noIndex === true && /no owner index/.test(r.refusal), 'with no index, resolve() refuses and says why', r.refusal);
    const c = owner.check('fix the checkout flow e2e tests', A);
    check(c.allow === false, 'and check() does not allow a send it cannot justify');
  }
  const ixDir = path.join(W.dir, 'owner-index'); fs.mkdirSync(ixDir, { recursive: true });
  fs.writeFileSync(path.join(ixDir, 'index.json'), JSON.stringify(ix));
  config.set({ ownerIndex: ixDir });

  console.log('\n--- owner: representative topics ---');
  {
    const r = owner.resolve('fix the flaky checkout flow e2e tests');
    check(r.ok && r.owner === A, 'a topic matching one live session routes to it', r.ok ? r.title : r.refusal);
    check(![X, HD, C, K].includes(r.owner) && !(r.candidates || []).some(c => [X, HD, C, K].includes(c.id)),
      'archived, headless (no Desktop row), Conductor and keeper sessions never win, even with the same words');
    const ex = owner.resolve('fix the flaky checkout flow e2e tests', { exclude: A });
    check(ex.ok === false && ex.noOwner === true && ex.spawn, 'excluding the sender (no routing back to itself) leaves no owner: a spawn plan, not the nearest match', ex.spawn && ex.spawn.why);
    const none = owner.resolve('quantum chromodynamics lattice simulation');
    check(none.ok === false && none.noOwner && /under the bar of 30|nothing in the index matched/.test(none.spawn.why) && !none.owner,
      'an unrelated topic gets "no owner" and a spawn plan, even though a weak candidate exists (score 6 < 30)', none.spawn && none.spawn.why);
    const named = owner.resolve(`send this to ${B.slice(6, 14)} about the checkout flow e2e tests`);
    check(named.ok && named.explicit && named.owner === B, 'a session NAMED by its 8-hex prefix wins over a better word match', named.owner);
    const namedBad = owner.resolve(`ask ${C.slice(6, 14)} about checkout`);
    check(namedBad.ok && namedBad.owner === C && /Conductor/.test(namedBad.warning || ''), 'naming the Conductor routes there but carries a warning', namedBad.warning);
    const amb = owner.resolve('invoice pdf export pipeline');
    check(amb.ok === false && amb.ambiguous === true && amb.between.length === 2, 'two projects within 20% of each other: AMBIGUOUS, it refuses to guess', amb.refusal);
    const pinned = owner.resolve('invoice pdf export pipeline', { project: 'billing' });
    check(pinned.ok && pinned.owner === D1, 'passing project settles it', pinned.owner);
  }

  console.log('\n--- owner.check(): the guard before a send ---');
  {
    const t = 'fix the flaky checkout flow e2e tests';
    const ok1 = owner.check(t, A);
    check(ok1.allow === true && ok1.owner === A, 'sending to the owner is allowed');
    const no1 = owner.check(t, B);
    check(no1.allow === false && no1.owner === A && new RegExp(A).test(no1.refusal), 'sending to another session is refused and names the real owner', no1.refusal);
    const no2 = owner.check(t, C);
    check(no2.allow === false && /Conductor/.test(no2.refusal), 'sending project work to the Conductor is refused with the reason', no2.refusal);
    const amb = owner.check('invoice pdf export pipeline', D2);
    check(amb.allow === true && amb.ambiguous === true, 'on an AMBIGUOUS topic either plausible lane is the caller\'s call (allowed)');
    const amb2 = owner.check('invoice pdf export pipeline', B);
    check(amb2.allow === false && amb2.ambiguous === true, 'but a third session outside the pair is refused');
  }

  console.log('\n--- aliases: what routing learns ---');
  {
    check(aliases.learn('', 'reports').ok === false && aliases.learn('pipeline', '').ok === false, 'refusal: learn needs a keyword and a target');
    check(aliases.learn('_secret', 'reports').error === 'REFUSED', 'refusal: keywords starting with "_" are reserved');
    const l1 = aliases.learn('Pipeline', 'reports');
    const l2 = aliases.learn('pipeline', 'REPORTS');
    check(l1.ok && l2.ok && l2.targets.length === 1, 'learning the same alias twice (any case) keeps one target', l2.targets);
    check(aliases.boosts('the pipeline broke').fired.includes('pipeline'), 'an alias fires on the whole word');
    check(!aliases.boosts('the pipelines broke').fired.length && !aliases.boosts('mypipeline').fired.length, 'refusal: it does not fire inside another word');
    const r = owner.resolve('invoice pdf export pipeline');
    check(r.ok && r.owner === D2 && (r.aliases || []).includes('pipeline'), 'the learned alias settles the earlier AMBIGUOUS pair', r.ok ? r.owner : r.refusal);
    check(aliases.logDispatch('', D1).ok === false && aliases.logDispatch('x', '').ok === false, 'refusal: a dispatch needs a query and a target');
    aliases.logDispatch('ledger reconciliation nightly batch', D1, 'guess', false);
    aliases.logDispatch('ledger reconciliation nightly batch', B, 'user said so', true);
    const lr = aliases.learned('rerun the ledger reconciliation');
    check(lr.get(B) === 2 * lr.get(D1) && lr.get(D1) === 2, 'a confirmed past dispatch weighs twice a guess', Object.fromEntries(lr));
    check(aliases.learned('ledger only').size === 0, 'refusal: one shared word is not a learned routing (needs two)');
    const fx = { sessions: ix.sessions };
    check(aliases.findSessions(fx, 'aaa').length === 0, 'refusal: a reference under 4 characters matches nothing');
    check(aliases.findSessions(fx, A.slice(6, 14)).length === 1, 'an 8-hex prefix finds exactly one session');
    const tagAmb = aliases.tag(fx, 'local_', 'x');
    check(tagAmb.ok === false && tagAmb.error === 'REFUSED', 'refusal: tagging needs exactly one match');
  }

  console.log('\n--- router: difficulty -> model/effort ---');
  {
    const hi = router.route('hi');
    check(hi.mode === 'inline' && hi.complexity === 'trivial' && hi.tier === 0, 'a greeting is answered inline on the bottom rung', hi.reason);
    const forced = router.route('hi', { minTier: 2 });
    check(forced.tier >= 2, 'minTier lifts even a trivial message', forced.tier);
    const vague = router.route('so I was thinking about the thing we talked about yesterday and whether the other approach might be nicer overall for everyone involved here today');
    check(vague.confidence < 0.6 && vague.tier === 2, 'an unclear long request gets one rung of headroom (low confidence bump), capped below the top', { conf: vague.confidence, tier: vague.tier });
    check(router.route('fix the typo', { forceModel: 'claude-x-1', forceEffort: 'max' }).model === 'claude-x-1', 'forceModel overrides the ladder');
    const top = router.LADDER[router.LADDER.length - 1];
    check(router.escalate(top.model, top.effort) === null, 'refusal: escalate at the top rung returns null');
    const up = router.escalate(router.LADDER[0].model, router.LADDER[0].effort);
    check(up && up.effort === router.LADDER[1].effort, 'escalate from the bottom climbs exactly one rung', up);
    check(router.toModelId('Sonnet 4.6') === 'claude-sonnet-4-6' && router.toModelId('opus') === 'opus' && router.toModelId('claude-x') === 'claude-x', 'picker names become model ids; aliases and ids pass through');
    check(router.needsModelAssist('so I was thinking about the thing we talked about yesterday and whether the other approach might be nicer overall for everyone involved here today, maybe later this week too') === true
       && router.needsModelAssist('hi') === false, 'only a long, unclear prompt asks for a model to classify it');
  }

  console.log('\n--- uiqueue: UI actions replayed after an outage ---');
  {
    const uiqueue = require('../lib/uiqueue');
    const desktop = require('../lib/desktop');
    try { fs.unlinkSync(path.join(config.STATE, 'ui-queue.json')); } catch {}
    check(uiqueue.enqueue('sendMessage', ['local_x', 'hello']) === null, 'refusal: a message is never put in the replay queue (no duplicate send when Desktop returns)');
    const q1 = uiqueue.enqueue('setGroup', ['local_q', 'Web']);
    const q2 = uiqueue.enqueue('setGroup', ['local_q', 'Web']);
    check(q1 && q2 && q1.id === q2.id && uiqueue.status().pending === 1, 'the same action queued twice (a retry) is one item');
    let calls = 0;
    desktop.setGroup = async () => { calls++; throw new Error('connect ECONNREFUSED 127.0.0.1:9229'); };
    try { fs.unlinkSync(path.join(config.STATE, 'ui-queue.json')); } catch {}
    const item = uiqueue.enqueue('setGroup', ['local_q', 'Web']);
    const d1 = await uiqueue.drain({ force: true });
    check(d1.failed.length === 1 && d1.failed[0].attempts === 1 && d1.pending === 1, 'Desktop away: the drain fails, the item stays queued', d1.failed);
    desktop.setGroup = async () => { calls++; return { ok: true }; };
    const d2 = await uiqueue.drain({ force: true });
    check(d2.done.length === 1 && d2.pending === 0, 'Desktop back: the next drain runs it', d2.done);
    check((await uiqueue.drain({ force: true })).skipped === 'empty', 'and it is not run again');
    check(uiqueue.cancel(item.id).ok === false, 'refusal: cancelling a finished item -> NOT_FOUND');
    desktop.setGroup = async () => { calls++; throw new Error('connect ECONNREFUSED 127.0.0.1:9229'); };
    const lost = uiqueue.enqueue('renameSession', ['local_q', 'New name']);
    desktop.renameSession = desktop.setGroup;
    for (let i = 0; i < 3; i++) await uiqueue.drain({ force: true });
    const st = uiqueue.status();
    knownBug(st.items.some(i => i.id === lost.id),
      'a queued rename survives a Desktop outage longer than three drains (~2 min at the 45s tick, server.js:681): lib/uiqueue.js:73-77 counts "Desktop unreachable" as a failed attempt and drops it after MAX_ATTEMPTS',
      { stillQueued: st.pending });
    const old = uiqueue.enqueue('setGroup', ['local_old', 'Web']);
    const qf = JSON.parse(fs.readFileSync(path.join(config.STATE, 'ui-queue.json'), 'utf8'));
    qf.items.find(i => i.id === old.id).requestedAt = new Date(Date.now() - 7 * 3600 * 1000).toISOString();
    fs.writeFileSync(path.join(config.STATE, 'ui-queue.json'), JSON.stringify(qf));
    const before = calls;
    const dx = await uiqueue.drain({ force: true });
    check(dx.dropped.some(x => x.id === old.id && /replay window/.test(x.reason)) && calls === before, 'a stale item (older than 6h) is dropped without being run');
    const c1 = uiqueue.enqueue('setGroup', ['local_c', 'X']);
    check(uiqueue.cancel(c1.id).ok === true && uiqueue.status().pending === 0, 'a pending item can be cancelled');
  }

  console.log('\n--- await: a master parked on its workers ---');
  {
    const awaits = require('../lib/await');
    try { fs.unlinkSync(awaits.FILE()); } catch {}
    check(awaits.park({ waitingOn: [A] }).error === 'NO_MASTER_SESSION', 'refusal: parking needs the master session');
    check(awaits.park({ masterSessionId: C, waitingOn: [] }).error === 'NOTHING_TO_WAIT_ON', 'refusal: parking needs something to wait on');
    const p1 = awaits.park({ masterSessionId: C, waitingOn: [A, B], reason: 'two workers' });
    const p2 = awaits.park({ masterSessionId: C, waitingOn: [A], reason: 'replaced' });
    check(p1.ok && p2.ok && awaits.list().length === 1 && awaits.list()[0].reason === 'replaced', 'parking again replaces the master\'s previous watch (one live watch per master)');
    const running = { sessions: [{ sessionId: A, isRunning: true, lastActivityAt: new Date().toISOString() }] };
    check(awaits.tick({ snapshot: running }).events.length === 0, 'while the worker runs, no wake');
    const idle = { sessions: [{ sessionId: A, isRunning: false, state: 'idle' }] };
    const t1 = awaits.tick({ snapshot: idle });
    const t2 = awaits.tick({ snapshot: idle });
    check(t1.events.length === 1 && t1.events[0].kind === 'await-complete' && t2.events.length === 0, 'the worker finishes: exactly one wake, a second tick sends nothing more');
    awaits.park({ masterSessionId: C, waitingOn: [A], deadlineMs: 60000 });
    const dl = awaits.tick({ snapshot: running, at: Date.now() + 120000 });
    check(dl.events.length === 1 && dl.events[0].kind === 'await-deadline', 'past its deadline a watch wakes the master with "deadline", even if the worker still runs');
    awaits.park({ masterSessionId: C, waitingOn: [A] });
    const nul = awaits.tick({ snapshot: null });
    knownBug(nul.events.length === 0,
      'with no Desktop snapshot at all (no sidebar scrape has ever succeeded), a watch keeps waiting (lib/await.js:84-85 reads "not in the sidebar" and wakes the master as if the worker had finished)',
      nul.events.map(e => e.kind));
  }

  console.log('\n--- wakes: who woke a session ---');
  {
    const wakes = require('../lib/wakes');
    check(wakes.wakeSender({}, '<cross-session-message from="local_abc" name="Builder">hi</cross-session-message>').from === 'local_abc', 'a cross-session message is attributed to its sender');
    check(wakes.wakeSender({}, '[Relaymote goals] keep going').from === 'relaymote:chase', 'Relaymote\'s own chase line is attributed to Relaymote');
    check(wakes.wakeSender({ origin: { kind: 'peer', from: 'local_p' } }, 'x').from === 'local_p', 'a peer origin on the record is a wake');
    check(wakes.wakeSender({}, 'just the user typing') === null, 'refusal: a plain user message is not a wake');
    check(wakes.wakeSender({ origin: { kind: 'peer', from: 'local_p' }, message: { content: [{ type: 'tool_result' }] } }, '') === null, 'refusal: a tool result is never a wake');
  }

  H.finish(W, 'relay-routing');
})().catch(e => { console.error('THREW', e); process.exit(1); });
