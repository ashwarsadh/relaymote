// goals.js — the goal register, the chaser, the cache keeper, the Board generator and the Board's
// batch send, against a fake clock, fake sessions and stub delivery. Never talks to Claude Desktop.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-goals-'));
process.env.BATON_HOME = path.join(TMP, 'baton');
process.env.APPDATA = path.join(TMP, 'appdata');
process.env.CLAUDE_CONFIG_DIR = path.join(TMP, 'claude');
delete process.env.BATON_STATE_DIR;

const goals = require('../lib/goals');
const boardBuild = require('../lib/board-build');
const board = require('../mobile/board');

let failed = 0;
const check = (ok, name, extra) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };

const NOW = Date.parse('2026-01-10T12:00:00Z');
const H = 3600000, MIN = 60000;
const iso = (t) => new Date(t).toISOString();
const sid = (n) => 'local_' + String(n).padStart(8, '0') + '-0000-4000-8000-000000000000';
const CONDUCTOR = sid(99);

const config = require('../lib/config');
const notify = require('../lib/notify');
function reset() { fs.rmSync(goals.DIR, { recursive: true, force: true }); fs.rmSync(path.join(config.DATA, 'board'), { recursive: true, force: true }); }
function set(id, patch) { goals.mutate(reg => Object.assign(goals.find(reg, id), patch)); }
const get = (id) => goals.find(goals.load(), id);

// A session: idle unless told otherwise; `apiMin` = minutes since its last model reply.
function world(defs) {
  const sessions = [], api = {};
  for (const d of defs) {
    sessions.push({ id: d.id, title: d.title || d.id, live: true, running: !!d.running, awaiting: !!d.awaiting,
      archived: !!d.archived, lastActivityAt: NOW - (d.idleMin != null ? d.idleMin : d.apiMin || 0) * MIN });
    if (d.apiMin != null) api[d.id] = NOW - d.apiMin * MIN;
  }
  return { sessions, api };
}
function deps(w, over = {}) {
  const sent = [];
  const d = {
    now: NOW, sessions: w.sessions, fresh: true, dryRun: false,
    settings: { modules: { goalChaser: true, cacheKeeper: false, ...(over.modules || {}) }, conductor: CONDUCTOR,
      goals: { quietHours: 4, ...(over.goals || {}) }, cacheKeeper: over.cacheKeeper || {} },
    activity: (s) => ({ lastApiAt: w.api[s.id] || null, replies: (over.replies || {})[s.id] || [] }),
    confirm: over.confirm || ((id) => ({ state: 'idle', confirmed: true })),
    deliver: async (id, text) => { sent.push({ id, text }); return { ok: true, delivered: true }; },
    resolve: over.resolve || (() => ({ ok: false, refusal: 'no owner' })),
    masters: over.masters || [],
  };
  return { d, sent };
}
// A goal that has been handed over and has had no report for `quietH` hours.
function told(owner, title, quietH, extra = {}) {
  const g = goals.add({ title, ownerSessionId: owner }, { now: NOW - quietH * H, conductor: CONDUCTOR }).goal;
  set(g.id, { told: true, toldAt: iso(NOW - quietH * H), ...extra });
  return g.id;
}

(async () => {
  // ---------------------------------------------------------------- routing
  reset();
  const r1 = goals.add({ title: 'Fix the flaky checkout test', project: 'web-app' },
    { now: NOW, resolve: (topic, o) => ({ ok: true, owner: sid(1), project: o.project, why: ['project=web-app'], score: 80 }) });
  check(r1.ok && r1.goal.ownerSessionId === sid(1) && r1.goal.routing.state === 'routed' && !r1.goal.told, 'a goal without an owner is routed through the owner index');
  const r2 = goals.add({ title: 'Publish the changelog', project: 'docs' }, { now: NOW, resolve: () => ({ ok: false, noOwner: true, spawn: { why: 'nothing matched', project: 'docs' } }) });
  check(r2.ok && !r2.goal.ownerSessionId && r2.goal.routing.state === 'unrouted', 'nobody owns it: it stays unrouted');
  check(goals.add({}).error === 'TITLE_REQUIRED', 'a goal needs a title');

  let w = world([{ id: sid(1), apiMin: 90 }]);
  let { d, sent } = deps(w, { goals: { autoSpawn: true } });
  const spawns = [];
  d.spawn = async (o) => { spawns.push(o); return { ok: true, sessionId: sid(7) }; };
  d.isIdle = () => true;
  d.index = { projects: { docs: { name: 'docs', path: path.join(TMP, 'docs') } } };
  let t = await goals.tick(d);
  check(spawns.length === 1 && spawns[0].cwd === path.join(TMP, 'docs') && /GOAL DONE g2/.test(spawns[0].prompt), 'autoSpawn starts ONE session in the project folder, with the goal as its prompt');
  check(get('g2').ownerSessionId === sid(7) && get('g2').told && get('g2').routing.state === 'spawned', 'the new session owns the goal and has been told');
  check(sent.length === 1 && sent[0].id === sid(1) && /New:[\s\S]*g1/.test(sent[0].text), 'the routed goal is handed to its owner in the same cycle');
  check(get('g1').told && !get('g1').lastProgressAt, 'a hand-over is recorded, but is not a progress report');
  t = await goals.tick(d);
  check(sent.length === 1 && spawns.length === 1, 'nothing is repeated in the next cycle');

  // ---------------------------------------------------------------- batching + mid-turn + unknown
  reset();
  w = world([{ id: sid(1), apiMin: 300 }, { id: sid(2), apiMin: 300 }, { id: sid(3), apiMin: 300, running: true }]);
  told(sid(1), 'Goal A', 6); told(sid(1), 'Goal B', 8);
  goals.add({ title: 'Goal C, new', ownerSessionId: sid(1) }, { now: NOW, conductor: CONDUCTOR });
  told(sid(2), 'Goal D', 5);
  told(sid(3), 'Goal E', 9);
  ({ d, sent } = deps(w));
  t = await goals.tick(d);
  const to1 = sent.filter(s => s.id === sid(1));
  check(to1.length === 1 && /g1/.test(to1[0].text) && /g2/.test(to1[0].text) && /g3/.test(to1[0].text), 'ONE message per owner, carrying all of its goals', `${to1.length} message(s)`);
  check(/New:[\s\S]*g3[\s\S]*Still open[\s\S]*g2/.test(to1[0].text), 'new and still-open goals are separate sections of that one message');
  check(sent.length === 2 && sent.some(s => s.id === sid(2)), 'each owner gets its own message');
  check(!sent.some(s => s.id === sid(3)) && t.held.some(h => h.id === 'g5' && /mid-turn/.test(h.why)), 'a session that is mid-turn is never chased');
  check(get('g1').chases === 1 && get('g1').unanswered === 1 && get('g1').lastChaseAt === iso(NOW), 'a chase is counted on each goal');
  const log = goals.readJsonl(goals.CHASE_LOG, 0);
  check(log.length === 2 && log.every(r => r.ok && r.confirmed && r.kind), 'every send is logged, with confirmation', log.map(r => r.kind).join(','));

  reset();
  told(sid(1), 'Goal A', 6);
  ({ d, sent } = deps(w, { confirm: () => ({ state: 'running', confirmed: true }) }));
  t = await goals.tick(d);
  check(sent.length === 0 && t.failed.length === 1 && t.failed[0].error === 'NOT_CONFIRMED_IDLE', 'the app says it just started a turn: nothing is sent');
  ({ d, sent } = deps(w, { confirm: async () => { throw new Error('bridge down'); } }));
  t = await goals.tick(d);
  check(sent.length === 0 && t.failed[0].state === 'unknown', 'the app cannot be asked: "unknown" refuses the send');
  ({ d, sent } = deps(w));
  d.fresh = false;
  t = await goals.tick(d);
  const h = JSON.parse(fs.readFileSync(goals.HEALTH, 'utf8'));
  check(sent.length === 0 && /stale/.test(t.skipped) && h.items[0].condition === 'OFFLINE', 'a stale view of the app is "unknown", never idle');

  // ---------------------------------------------------------------- warm window (cache keeper)
  const keeper = { modules: { goalChaser: true, cacheKeeper: true } };
  for (const [apiMin, want] of [[30, 1], [10, 0], [70, 0]]) {
    reset();
    told(sid(1), 'Pending work', 6);
    ({ d, sent } = deps(world([{ id: sid(1), apiMin }]), keeper));
    t = await goals.tick(d);
    check(sent.length === want, `warm rule: ${apiMin} min since its last reply -> ${want ? 'pinged' : 'not pinged'}`, t.held.map(x => x.why).join(' | '));
    if (want) check(t.sent[0].kind === 'warm' && goals.readJsonl(goals.CHASE_LOG, 0)[0].warm === true, 'the ping is logged as warm');
  }
  reset();
  told(sid(1), 'Pending work', 6);
  ({ d, sent } = deps(world([{ id: sid(1), apiMin: 30 }]), keeper));
  await goals.tick(d);
  await goals.tick({ ...d, now: NOW + 10 * MIN, sessions: world([{ id: sid(1), apiMin: 40 }]).sessions });
  check(sent.length === 1, 'one warm ping per window, not one per cycle');
  reset();
  told(sid(1), 'Just handed over', 1);
  ({ d, sent } = deps(world([{ id: sid(1), apiMin: 30 }]), keeper));
  t = await goals.tick(d);
  check(sent.length === 0 && t.held.some(x => /quiet only/.test(x.why)), 'a goal with a recent report is not worth a ping yet');

  // ---------------------------------------------------------------- cold rule
  reset();
  told(sid(1), 'Stuck a long time', 80); told(sid(1), 'Stuck a while', 10);
  told(sid(2), 'Only stuck a while', 10);
  told(sid(3), 'Late one', 5, { due: iso(NOW - 2 * H) });
  ({ d, sent } = deps(world([{ id: sid(1), apiMin: 300 }, { id: sid(2), apiMin: 300 }, { id: sid(3), apiMin: 300 }]), keeper));
  t = await goals.tick(d);
  const c1 = sent.find(s => s.id === sid(1));
  check(c1 && /g1/.test(c1.text) && /g2/.test(c1.text), 'cold owner: a goal stuck >= 72h wakes it, and its other pending goals ride along');
  check(!sent.some(s => s.id === sid(2)) && t.held.some(x => x.id === 'g3' && /cold/.test(x.why)), 'cold owner with nothing late or 72h stuck is left to sleep');
  check(sent.some(s => s.id === sid(3)), 'cold owner with a late goal is woken');
  check(t.sent.every(s => s.kind === 'cold'), 'cold wakes are logged as cold');

  // ---------------------------------------------------------------- caps, Conductor, judgement queue
  reset();
  const many = [];
  for (let i = 1; i <= 7; i++) { many.push({ id: sid(i), apiMin: 300 }); told(sid(i), 'Stuck ' + i, 10 + i); }
  told(CONDUCTOR, 'The Conductor\'s own goal', 50);
  many.push({ id: CONDUCTOR, apiMin: 300 });
  ({ d, sent } = deps(world(many)));
  t = await goals.tick(d);
  check(sent.length === 5 && t.held.filter(x => /cap/.test(x.why)).length === 2, 'maxChasesPerCycle caps the messages; the rest wait', `${sent.length} sent`);
  check(sent[0].id === sid(7), 'longest-quiet first');
  check(!sent.some(s => s.id === CONDUCTOR) && t.held.some(x => /Conductor/.test(x.why)), 'the Conductor is never chased');

  reset();
  told(sid(1), 'Nobody answers', 10, { chases: 3, unanswered: 3, lastChaseAt: iso(NOW - 100 * H) });
  ({ d, sent } = deps(world([{ id: sid(1), apiMin: 300 }])));
  t = await goals.tick(d);
  check(sent.length === 0 && JSON.parse(fs.readFileSync(goals.HEALTH, 'utf8')).items[0].condition === 'UNRESPONSIVE', 'after maxChases unanswered chases a goal waits for judgement, it is not chased forever');
  check(goals.judged('g1', 'still needed; owner was on leave').ok && get('g1').unanswered === 0, 'judged releases it');
  t = await goals.tick(d);
  check(sent.length === 1, 'and it is chased again');

  // ---------------------------------------------------------------- reports: markers, tools, verification
  reset();
  told(sid(1), 'Ship it', 10); told(sid(1), 'Wire it', 10); told(sid(1), 'Test it', 10); told(sid(2), 'Someone else', 10);
  const replies = { [sid(1)]: [{ ts: NOW - 5 * MIN, text: 'All set.\nGOAL DONE g1: deployed, smoke test passes\nGOAL BLOCKED g2: need the API key\nGOAL PROGRESS g3: half the cases\nGOAL DONE g4: not mine' }] };
  ({ d, sent } = deps(world([{ id: sid(1), apiMin: 300 }, { id: sid(2), apiMin: 300 }])));
  await goals.tick(d);
  ({ d, sent } = deps(world([{ id: sid(1), apiMin: 300 }, { id: sid(2), apiMin: 300 }]), { replies }));
  t = await goals.tick(d);
  check(get('g1').status === 'open' && get('g1').deliveredAt && /deployed/.test(get('g1').progress), "an owner's GOAL DONE makes the goal DELIVERED, not closed: you read it and close it");
  check(get('g2').blockedOn === 'need the API key' && get('g3').progress === 'half the cases', 'BLOCKED sets blocked_on; PROGRESS records progress');
  check(get('g4').status === 'open', 'a session cannot close a goal it does not own');
  check(goals.report('g2', 'wired, testing now').ok && get('g2').blockedOn === null, 'a later report clears blocked_on');
  check(goals.close('g3', { note: '' }).error === 'EVIDENCE_REQUIRED', 'done without evidence is refused');
  check(goals.close('g3', { note: 'all cases pass' }).ok && goals.close('g3', { note: 'again' }).error === 'ALREADY_CLOSED', 'a double close is refused');
  check(goals.reopen('g3', '').error === 'REASON_REQUIRED' && goals.reopen('g3', 'regressed').ok && get('g3').status === 'open', 'reopen needs a reason');
  goals.verify('g2', iso(NOW + 48 * H), 'the token still works after two days');
  goals.report('g2', 'DONE: rotated the key');
  check(get('g2').status === 'open' && get('g2').deliveredAt, 'delivered with a verify date: stays open');
  let items = goals.assess({ goals: goals.load().goals, sessions: new Map(world([{ id: sid(1), apiMin: 300 }]).sessions.map(s => [s.id, s])), now: NOW, st: goals.settings(d.settings) });
  check(items.find(i => i.id === 'g2').condition === 'AWAITING-VERIFICATION', 'AWAITING-VERIFICATION before the date');
  items = goals.assess({ goals: goals.load().goals, sessions: new Map(), now: NOW + 49 * H, st: goals.settings(d.settings) });
  check(items.find(i => i.id === 'g2').condition === 'VERIFY-NOW', 'VERIFY-NOW once it arrives');
  check(goals.close('g1', { note: 'read the deploy log: live' }).ok, 'the delivered goal is closed by hand, with evidence');
  await goals.tick({ ...d, now: NOW + H });
  const ev = goals.readJsonl(goals.EVENTS, 0);
  check(ev.some(e => e.id === 'g1' && e.kind === 'closed' && e.to === 'CLOSED' && e.forMs != null), 'a close lands in goals-events.jsonl with the time spent in the last condition');
  check(ev.some(e => e.kind === 'condition' && e.forMs != null) && ev.some(e => e.kind === 'progressed'), 'condition changes and progress are events too', [...new Set(ev.map(e => e.kind))].join(','));
  check(goals.status().counts && JSON.parse(fs.readFileSync(goals.HEALTH, 'utf8')).thresholds.quietHours === 4, 'goals-health.json names the thresholds that applied');
  let sentG1 = sent.length;
  await goals.tick({ ...d, now: NOW + 200 * H });
  check(!sent.slice(sentG1).some(x => /g1/.test(x.text)), 'a closed goal is never nudged');

  // requireVerification off: an owner's DONE with evidence closes it, and banks the owner
  reset();
  told(sid(1), 'Ship it', 10);
  ({ d, sent } = deps(world([{ id: sid(1), apiMin: 300 }]), { goals: { requireVerification: false } }));
  await goals.tick(d);
  ({ d, sent } = deps(world([{ id: sid(1), apiMin: 300 }]), { goals: { requireVerification: false }, replies: { [sid(1)]: [{ ts: NOW - MIN, text: 'GOAL DONE g1: shipped, tag v2' }] } }));
  await goals.tick(d);
  check(get('g1').status === 'done' && /shipped/.test(get('g1').outcome), 'goals.requireVerification false: GOAL DONE with evidence closes it');

  // ---------------------------------------------------------------- hand-over notes, thresholds, legacy setting
  reset();
  const gh = told(sid(1), 'Hand-over is not progress', 10);
  goals.report(gh, 'RE-HOMED to the api lane: it owns this now');
  check(!get(gh).lastProgressAt && get(gh).handoverNote, 'a hand-over note is recorded, but is not a progress report');
  goals.report(gh, 'wrote the migration');
  check(get(gh).lastProgressAt && get(gh).progress === 'wrote the migration', 'a real report is');
  check(goals.settings().goals.quietHours === 36 && goals.settings().goals.warmPingMinQuietHours === 4, 'defaults: quiet 36h for health, 4h minimum quiet before a warm ping');
  fs.mkdirSync(path.dirname(config.SETTINGS_FILE), { recursive: true });
  const hadSettings = fs.existsSync(config.SETTINGS_FILE) ? fs.readFileSync(config.SETTINGS_FILE, 'utf8') : null;
  fs.writeFileSync(config.SETTINGS_FILE, JSON.stringify({ goals: { stuckHours: 6 } }));
  check(goals.settings().goals.quietHours === 6 && goals.settings().goals.stuckHours === undefined, 'an old settings.json stuckHours is honoured as quietHours');
  if (hadSettings == null) fs.unlinkSync(config.SETTINGS_FILE); else fs.writeFileSync(config.SETTINGS_FILE, hadSettings);

  // ---------------------------------------------------------------- old owner already delivered
  reset();
  const go = told(sid(1), 'Moved lanes', 10, { project: 'api' });
  const liveO = (id) => goals.ownerState(id, new Map(world([{ id: sid(2), apiMin: 5 }]).sessions.map(x => [x.id, x])), true);
  goals.rehome(go, sid(2), 'api lane owns it', { stateOf: liveO });
  set(go, { told: true, toldAt: iso(NOW - 10 * H) });
  const oldReplies = { [sid(1)]: [{ ts: NOW - 5 * MIN, text: 'GOAL DONE ' + go + ': it was already merged' }] };
  ({ d, sent } = deps(world([{ id: sid(1), apiMin: 300 }, { id: sid(2), apiMin: 300 }]), { replies: oldReplies }));
  t = await goals.tick(d);
  check(get(go).oldOwnerDone && get(go).oldOwnerDone.session === sid(1) && get(go).status === 'open', "the PREVIOUS owner's DONE is recorded on the goal, which stays open");
  check(!sent.some(x => x.id === sid(2)) && t.held.some(x => x.id === go && /previous owner/.test(x.why)), 'and the new owner is not chased for work that may already be in');
  goals.judged(go, 'checked: not merged, new owner carries on');
  ({ d, sent } = deps(world([{ id: sid(1), apiMin: 300 }, { id: sid(2), apiMin: 300 }])));
  await goals.tick(d);
  check(sent.some(x => x.id === sid(2)), 'once judged, the hold lifts and the new owner is chased again');

  // ---------------------------------------------------------------- collected ledger
  reset();
  const gc1 = told(sid(1), 'Collected work', 10);
  goals.close(gc1, { note: 'read and banked' });
  const bankedAt = Date.parse(goals.collectedMap()[sid(1)].ts);
  check(bankedAt > 0 && goals.collectedMap()[sid(1)].goals.includes(gc1), 'closing a goal banks its owner in collected.jsonl');
  check(goals.collectedStatus(sid(1), { transcriptMtime: () => bankedAt - 1000 }).state === 'banked', 'owner silent since: banked');
  check(goals.collectedStatus(sid(1), { transcriptMtime: () => bankedAt + 1000 }).state === 'moved-since', 'its transcript moved since: raise it again');
  check(goals.collectedStatus(sid(1), { transcriptMtime: () => null }).state === 'cannot-verify', 'transcript not found: cannot-verify (treated as moved)');
  check(goals.collectedStatus(sid(5), { transcriptMtime: () => 0 }).state === null, 'a session never collected: null');
  check(goals.collectedStatus(sid(1).slice(0, 14), { transcriptMtime: () => bankedAt - 1000 }).state === 'banked', 'an 8-hex prefix finds the full id');

  // ---------------------------------------------------------------- notify: the banked guard, both directions
  const W = sid(11), CM = sid(12);
  const mastersN = [{ project: 'conductor', sessionId: CM, fleet: [W] }];
  const scan = (state, st) => notify.scanSessions(state, mastersN, { restateAfterMs: 6 * H }, [{ sessionId: W, state: st }], false, NOW);
  const fresh = () => ({ notified: {}, notifiedAt: {}, sessionState: {}, ranSince: {} });
  const runRaise = (stFinal) => { const s0 = fresh(); scan(s0, 'running'); return scan(s0, stFinal); };
  goals.recordCollected(W, null, 'read losslessly');
  const bankedW = Date.parse(goals.collectedMap()[W].ts);
  let prevCheck = notify._setBankedCheck((x) => goals.collectedStatus(x, { transcriptMtime: () => bankedW - 1000 }).state === 'banked');
  check(runRaise('unread').length === 0, 'notify: a finished (unread) session the Conductor already banked is NOT announced again');
  check(runRaise('awaiting_input').length === 1, 'notify: a live question (awaiting_input) is never suppressed, banked or not');
  notify._setBankedCheck((x) => goals.collectedStatus(x, { transcriptMtime: () => bankedW + 1000 }).state === 'banked');
  check(runRaise('unread').length === 1, 'notify: banked but its transcript moved since: announced');
  notify._setBankedCheck((x) => goals.collectedStatus(x, { transcriptMtime: () => null }).state === 'banked');
  check(runRaise('unread').length === 1, 'notify: cannot verify: announced (fails open)');
  notify._setBankedCheck(() => { throw new Error('ledger unreadable'); });
  check(runRaise('unread').length === 1, 'notify: a guard that throws: announced (fails open)');
  notify._setBankedCheck(prevCheck);
  const s1 = fresh(); scan(s1, 'running'); notify._setBankedCheck(() => true); scan(s1, 'unread'); notify._setBankedCheck(prevCheck);
  check(s1.notified['sess:' + W + ':unread'], 'notify: a suppressed raise still writes its dedupe stamp');
  check(notify.scanSessions(fresh(), [{ project: 'web', sessionId: sid(13), fleet: [W] }], { restateAfterMs: 6 * H }, [{ sessionId: W, state: 'running' }], false, NOW).length === 0
    && (() => { const s2 = fresh(); const m2 = [{ project: 'web', sessionId: sid(13), fleet: [W] }]; notify.scanSessions(s2, m2, { restateAfterMs: 6 * H }, [{ sessionId: W, state: 'running' }], false, NOW);
      notify._setBankedCheck(() => true); const e = notify.scanSessions(s2, m2, { restateAfterMs: 6 * H }, [{ sessionId: W, state: 'unread' }], false, NOW); notify._setBankedCheck(prevCheck); return e.length === 1; })(),
    'notify: the guard applies only to raises that go to the Conductor');

  // ---------------------------------------------------------------- re-home
  reset();
  told(sid(1), 'Orphaned work', 10, { project: 'api' });
  const live = (id) => goals.ownerState(id, new Map(world([{ id: sid(2), apiMin: 5 }]).sessions.map(s => [s.id, s])), true);
  check(goals.rehome('g1', sid(5), 'x', { stateOf: live }).error === 'TARGET_NOT_LIVE', 're-home refuses a target that is not live');
  check(goals.rehome('g1', sid(2), 'owns the api project', { stateOf: live }).ok && !get('g1').told && get('g1').rehomedFrom === sid(1), 're-home moves it and marks it untold');
  ({ d, sent } = deps(world([{ id: sid(2), apiMin: 300 }])));
  await goals.tick(d);
  check(sent.length === 1 && /Re-homed to you[\s\S]*owns the api project/.test(sent[0].text), 'the new owner is told, with the reason');
  set('g1', { deliveredAt: iso(NOW) });
  check(goals.rehome('g1', sid(2), 'y', { stateOf: live }).error === 'DELIVERED', 're-home refuses a delivered goal');
  reset();
  told(sid(1), 'Orphan A', 10, { project: 'api' }); told(sid(1), 'Orphan B', 10, { project: 'web' });
  const masters = [{ project: 'api', sessionId: sid(2) }, { project: 'web', sessionId: sid(3) }, { project: 'web', sessionId: sid(4) }];
  ({ d, sent } = deps(world([{ id: sid(2), apiMin: 300 }, { id: sid(3), apiMin: 300 }, { id: sid(4), apiMin: 300 }]), { goals: { autoRehome: true }, masters }));
  t = await goals.tick(d);
  check(get('g1').ownerSessionId === sid(2) && get('g2').ownerSessionId === sid(1), 'auto-rehome goes to the one live master, and refuses a tie');
  check(t.held.some(x => x.id === 'g2' && /2 live masters/.test(x.why)), 'the refusal says why');

  // ---------------------------------------------------------------- the ledger: append-only, tolerant, migrated once
  reset();
  goals.add({ title: 'ledger one' }, { resolve: () => ({ ok: false }) });
  const before = fs.readFileSync(goals.FILE, 'utf8');
  goals.report('g1', 'first step');
  const after = fs.readFileSync(goals.FILE, 'utf8');
  check(after.startsWith(before) && after.split('\n').filter(Boolean).length === before.split('\n').filter(Boolean).length + 1, 'a change APPENDS one row; nothing earlier is rewritten');
  const lastRow = JSON.parse(after.trim().split('\n').pop());
  check(lastRow.id === 'g1' && lastRow.ev && lastRow.progress === 'first step' && !('title' in lastRow), 'the row carries only what changed, and names the change');
  check(goals.history('g1').length === 2, 'history(id) returns every ledger line for the goal');
  fs.appendFileSync(goals.FILE, '{"id":"g1","at":"x","ev":"note","progress":"Path C:\\data\\goals"}\n{ broken\n{"id":"register","ev":"migrated-unusable","raw":{"oops":true}}\n');
  let reg = goals.load();
  check(reg.goals.length === 1 && reg.repaired > 0 && reg.corrupt === 2 && /C:.data/.test(reg.goals[0].progress), 'lone backslashes repaired; a broken line and an unusable row are COUNTED', `repaired ${reg.repaired}, corrupt ${reg.corrupt}`);
  reset();
  fs.mkdirSync(goals.DIR, { recursive: true });
  fs.writeFileSync(goals.LEGACY_FILE, '{"version":1,"next":3,"goals":[{"id":"g1","title":"Path C:\\data\\goals","status":"open"},{"oops":true}]}');
  reg = goals.load();
  check(reg.goals.length === 1 && reg.bad.length === 1 && fs.existsSync(goals.FILE) && fs.existsSync(goals.LEGACY_FILE + '.migrated') && !fs.existsSync(goals.LEGACY_FILE),
    'a goals.json from an earlier Relaymote is migrated ONCE into the ledger (unusable rows kept), and renamed, never deleted');
  goals.add({ title: 'after migration' }, { resolve: () => ({ ok: false }) });
  check(goals.load().goals[1].id === 'g3', 'numbering continues from the old register');
  reset();
  fs.mkdirSync(goals.DIR, { recursive: true });
  fs.writeFileSync(goals.LEGACY_FILE, '{ this is not json');
  let threw = null;
  try { goals.add({ title: 'x' }, { resolve: () => ({ ok: false }) }); } catch (e) { threw = e.message; }
  check(/REGISTER_UNREADABLE/.test(threw || ''), 'writing over an unreadable old register throws instead of starting over');
  check(fs.readFileSync(goals.LEGACY_FILE, 'utf8') === '{ this is not json' && !fs.existsSync(goals.FILE) && goals.status().unreadable, 'an unreadable register is never overwritten');
  reset();
  const big = 'x'.repeat(5000);
  const gb = goals.add({ title: 'big', text: big }, { resolve: () => ({ ok: false }) }).goal;
  check(gb.text.startsWith('x'.repeat(4000) + ' …[full text: ') && !gb.text.includes('x'.repeat(4001)) && gb.textFile && fs.readFileSync(gb.textFile, 'utf8').length === 5000, 'text over 4000 chars spills to a side file');

  // ---------------------------------------------------------------- keep-alive
  reset();
  told(sid(1), 'Busy owner', 2);
  const ka = { modules: { goalChaser: true, cacheKeeper: true }, cacheKeeper: { keepConductorWarm: true } };
  ({ d, sent } = deps(world([{ id: sid(1), apiMin: 1, running: true }, { id: CONDUCTOR, apiMin: 40 }]), ka));
  t = await goals.tick(d);
  check(sent.length === 1 && sent[0].id === CONDUCTOR && /keep-alive/.test(sent[0].text), 'keep-alive: Conductor idle 40 min while an owner works');
  await goals.tick(d); await goals.tick(d);
  check(sent.length === 2, 'at most two keep-alives in three hours');
  reset();
  told(sid(1), 'Busy owner', 2);
  ({ d, sent } = deps(world([{ id: sid(1), apiMin: 1, running: true }, { id: CONDUCTOR, apiMin: 10 }]), ka));
  await goals.tick(d);
  check(sent.length === 0, 'no keep-alive at 10 min');
  ({ d, sent } = deps(world([{ id: sid(1), apiMin: 1, running: true }, { id: CONDUCTOR, apiMin: 40 }]), { modules: { goalChaser: true, cacheKeeper: true } }));
  await goals.tick(d);
  check(sent.length === 0, 'keep-alive is off by default');

  // ---------------------------------------------------------------- counts
  const st = goals.status({ now: NOW });
  check(st.counts && st.last24h && typeof st.last24h.warm === 'number', '/api/goals counts: goals by status and pings by warmth');

  // ---------------------------------------------------------------- board.json
  reset();
  told(sid(1), 'Blocked goal', 10, { blockedOn: 'needs a decision on pricing' });
  goals.add({ title: 'Unowned goal', project: 'docs' }, { resolve: () => ({ ok: false, refusal: 'nothing matched' }) });
  told(sid(2), 'Delivered goal', 10, { deliveredAt: iso(NOW - H), progress: 'DONE: (no evidence given)' });
  goals.tell({ sessionId: sid(3), text: 'Renew the certificate before Friday', kind: 'do' });
  const bsessions = [
    { id: sid(1), title: 'Pricing page', cwd: path.join(TMP, 'web'), lastActivityAt: NOW - 30 * MIN, live: true },
    { id: sid(2), title: 'Docs', cwd: path.join(TMP, 'docs'), lastActivityAt: NOW - 30 * MIN, live: true },
    { id: sid(3), title: 'Needs an answer', cwd: path.join(TMP, 'api'), lastActivityAt: NOW - 5 * MIN, awaiting: true, live: true },
    { id: sid(4), title: 'Silent runner', cwd: path.join(TMP, 'api'), lastActivityAt: NOW - 40 * MIN, running: true, stalled: true, quietFor: 40 * MIN, live: true },
  ];
  const pq = (s) => s.id === sid(3) ? { id: 'q1', questions: [{ question: 'Deploy now or tomorrow?' }] } : null;
  let b = await boardBuild.build({ now: NOW, sessions: bsessions, pendingQuestion: pq, conductor: CONDUCTOR });
  const bj = JSON.parse(fs.readFileSync(boardBuild.boardFile(), 'utf8'));
  check(b.written && bj.generator === 'baton' && bj.built_at && bj.conductor === CONDUCTOR, 'board.json written, stamped as Relaymote\'s');
  check(['rows', 'inbox', 'goals', 'labels', 'hints', 'counts'].every(k => k in bj), 'board.json has the documented sections');
  const bucket = (id) => (bj.rows.find(r => r.id === id) || {}).bucket;
  check(bucket(sid(3)) === 'decide' && /Deploy now/.test(bj.rows.find(r => r.id === sid(3)).ask), 'a session awaiting you is a Decide row with its question');
  check(bucket(sid(4)) === 'nudge', 'a stuck session is a Nudge row');
  check(bucket('g2') === 'un' && bucket('g1') === 'open' && bucket('g3') === 'decide', 'unrouted, blocked and delivered goals get rows');
  check(bj.inbox.length === 1 && bj.inbox[0].n === 1 && bj.inbox[0].status === 'open' && bj.inbox[0].ask_kind === 'do', 'baton_tell_user notes are the inbox');
  check(bj.goals.length === 3 && bj.goals.every(g => g.id && g.title && g.status), 'goals come from the register');
  check(bj.rows.every(r => r.id && r.title && r.bucket && 'age' in r), 'every row has id, title, bucket and age');
  fs.writeFileSync(boardBuild.boardFile(), JSON.stringify({ rows: [], built_at: 'x' }));
  b = await boardBuild.build({ now: NOW, sessions: bsessions, pendingQuestion: pq, conductor: CONDUCTOR });
  check(!b.written && JSON.parse(fs.readFileSync(boardBuild.boardFile(), 'utf8')).built_at === 'x', 'a board.json written by something else is left alone');
  fs.unlinkSync(boardBuild.boardFile());
  await boardBuild.build({ now: NOW, sessions: bsessions, pendingQuestion: pq, conductor: CONDUCTOR });

  // ---------------------------------------------------------------- the Board's batch send
  const msgs = [];
  board._setSender(async (to, text) => { msgs.push({ to, text }); return { ok: true, delivered: true }; });
  board._setConductorState(async () => ({ id: CONDUCTOR, ok: true, reason: 'idle' }));
  let out = await board.actBatch({ items: [
    { kind: 'yes', id: sid(4) }, { kind: 'answer', id: sid(3), text: 'tomorrow, 9am' }, { kind: 'done', id: '#1' },
    { kind: 'yes', id: 'local_nope' }, { kind: 'skip', id: sid(4) },
  ] });
  check(out.code === 200 && msgs.length === 1 && msgs[0].to === CONDUCTOR, 'queued answers go out as ONE message to the Conductor');
  const lines = msgs[0].text.split('\n');
  check(lines.length === 3 && lines.every(l => l.startsWith('[board] ')) && lines.some(l => l.startsWith('[board] skip ' + sid(4))) && !lines.some(l => l.startsWith('[board] yes ' + sid(4))),
    'one "[board] " line per card, no header line; a later tap on the same card replaces the earlier one', lines);
  check(lines.some(l => /^\[board\] answer local_\S+: tomorrow, 9am/.test(l)) && lines.some(l => l.startsWith('[board] done #1')), 'answers and inbox items keep the single-tap line format');
  check(out.body.sent === 3 && out.body.rejected.length === 1 && out.body.rejected[0].id === 'local_nope', 'a card no longer on the board is reported back, not sent');
  const acted = board.readActed();
  check(acted[sid(4)] && acted[sid(3)] && acted['#1'], 'every sent card is marked handled');
  check(goals.notes().length === 0, 'Done on a Relaymote note closes it');
  {
    // The per-line audit records stay (the Conductor's index reads id + kind from each); one batch record joins them.
    const recs = fs.readFileSync(board.AUDIT, 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(r => r.batch === out.body.batch);
    check(recs.filter(r => r.kind === 'batch').length === 1 && recs.filter(r => r.kind !== 'batch' && r.id).length === 3,
      'one batch record plus one record per line, all under the batch id', recs.map(r => r.kind));
  }
  // A retry of the SAME batch (its answer was lost) is answered from memory, never delivered twice.
  const B1 = [{ kind: 'done', id: '#1' }];
  out = await board.actBatch({ items: B1, bid: 'b1-test' });
  const afterFirst = msgs.length;
  const again = await board.actBatch({ items: B1, bid: 'b1-test' });
  check(out.code === 200 && again.code === 200 && again.body.repeat === true && msgs.length === afterFirst, 'the same bid twice: delivered once, the retry is told it went', { afterFirst, n: msgs.length });
  await board.actBatch({ items: B1, bid: 'b2-test' });
  check(msgs.length === afterFirst + 1, 'a different bid is a new batch (the guard keys on bid, not on content)');
  board._setConductorState(async () => ({ id: null, ok: false, reason: 'No Conductor session is claimed' }));
  const before429 = msgs.length;
  out = await board.actBatch({ items: [{ kind: 'yes', id: sid(4) }], bid: 'b3-test' });
  check(out.code === 429 && msgs.length === before429, 'no Conductor: nothing is sent and the queue is kept');
  board._setConductorState(async () => ({ id: CONDUCTOR, ok: true, reason: 'idle' }));
  out = await board.actBatch({ items: [{ kind: 'yes', id: sid(4) }], bid: 'b3-test' });
  check(out.code === 200 && !out.body.repeat && msgs.length === before429 + 1, 'a batch that FAILED is not remembered: its retry is sent');
  board._setSender(null); board._setConductorState(null);

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
