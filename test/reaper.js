// reaper.js — the idle-CLI reaper, against a fake LocalSessionManager and a temp RELAYMOTE_HOME. Never talks
// to Claude Desktop. Every guard is shown SPARING its session; only a session that passes all of them is
// torn down, and only in live mode.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-reaper-'));
process.env.RELAYMOTE_HOME = path.join(TMP, 'relaymote');
process.env.CLAUDE_CONFIG_DIR = path.join(TMP, 'claude');
process.env.APPDATA = path.join(TMP, 'appdata');
delete process.env.RELAYMOTE_STATE_DIR;

let failed = 0;
const check = (ok, name, extra) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra !== undefined && !ok ? '  ' + JSON.stringify(extra).slice(0, 400) : ''}`); if (!ok) failed++; };

const config = require('../lib/config');
const bridge = require('../lib/bridge');
const reaper = require('../lib/reaper');
const goals = require('../lib/goals');
const awaits = require('../lib/await');

const H = 3600e3;
const CFG = path.join(config.STATE, 'reaper.json');
const LOG = path.join(config.STATE, 'reaper.jsonl');

// ------------------------------------------------------------------ the fake manager
function fakeManager(cases) {
  const now = Date.now();
  const base = () => ({ query: {}, isRunning: false, lastActivityAt: now - 5 * H, lastFocusedAt: now - 4 * H,
    lastCliMessageAt: now - 5 * H, title: 't', cliPid: 0 });
  const sessions = new Map(Object.entries(cases).map(([k, v]) => [k, { ...base(), ...v }]));
  const torn = [], reasons = [];
  globalThis[bridge.PIN] = {
    sessions,
    hasPendingUserInput: s => !!s._pending,
    isCliProvablyIdle: s => { if (s._idleThrows) throw new Error('x'); return !s._notIdle; },
    teardownQuery: (s, kind, o) => { torn.push([...sessions].find(([, x]) => x === s)[0]); reasons.push(kind + ':' + (o && o.teardownReason)); s.query = null; },
  };
  return { torn, reasons };
}
const CASES = {
  ok: {},
  running: { isRunning: true },
  awaiting: { _pending: true },
  notIdleCli: { _notIdle: true },
  idleUnknown: { _idleThrows: true },
  young: { lastActivityAt: Date.now() - 1 * H, lastCliMessageAt: Date.now() - 1 * H, lastFocusedAt: Date.now() },
  youngWork: { lastWorkFrameAt: Date.now() - 10 * 60000 },
  unread: { lastFocusedAt: Date.now() - 6 * H },
  goaled: {},
  awaited: {},
  archived: { isArchived: true },
  stopping: { isStopping: true },
  queued: { deferredSends: [1] },
  held: { heldSteers: new Map([[1, 1]]) },
  cron: { activeCronJobs: new Map([[1, 1]]) },
  wakeup: { pendingLoopWakeup: true },
  rc: { remoteControlEnabled: true },
  ssh: { sshConfig: { host: 'h' } },
  sched: { scheduledTaskId: 'x' },
  noCli: { query: null },
};
function page(opts) {
  const fm = fakeManager(CASES);
  // eslint-disable-next-line no-eval
  const rows = JSON.parse(eval(reaper.PAGE({ idleHours: 3, protect: ['goaled', 'awaited'], only: null, self: [], spareRC: true, act: true, max: 6, ...opts })));
  return { rows, ...fm };
}

console.log('\n--- guards (inside the app) ---');
{
  const { rows, torn, reasons } = page({});
  const why = Object.fromEntries(rows.map(r => [r.id, r.why]));
  check(JSON.stringify(torn) === '["ok"]', 'only the session that passes every guard is torn down', torn);
  check(reasons[0] === 'exited:' + reaper.TEARDOWN_REASON, "through the app's own teardown, tagged", reasons);
  check(!('noCli' in why), 'a session without a CLI is not even listed');
  for (const [k, g] of [['running', 'running'], ['awaiting', 'awaiting-input'], ['notIdleCli', 'cli-not-provably-idle'],
    ['idleUnknown', 'idle-unknown'], ['young', 'idle<3h'], ['youngWork', 'idle<3h'], ['unread', 'unread'],
    ['goaled', 'goal-or-await'], ['awaited', 'goal-or-await'], ['archived', 'archived'], ['stopping', 'stopping'],
    ['queued', 'queued-input'], ['held', 'queued-input'], ['cron', 'background-work'], ['wakeup', 'background-work'],
    ['rc', 'remote-control'], ['ssh', 'ssh-or-wsl'], ['sched', 'scheduled-task']]) {
    check((why[k] || []).includes(g), `${k} spared (${g})`, why[k]);
  }
  check(JSON.stringify(page({ act: false }).torn) === '[]', 'dry never tears down');
  check(JSON.stringify(page({ spareRC: false }).torn) === '["ok"]', 'Remote Control is spared even if a caller asks otherwise (the 0.2.4 option is gone)');
  {
    const fmB = fakeManager({ ok: {}, rcProcess: { remoteControlProcess: {} }, rcBridgeOnly: { bridgeSessionId: 'session_x' } });
    // eslint-disable-next-line no-eval
    const rb = JSON.parse(eval(reaper.PAGE({ idleHours: 3, protect: [], only: null, self: [], spareRC: false, act: true, max: 6 })));
    const w = Object.fromEntries(rb.map(r => [r.id, r.why]));
    check(w.rcProcess.includes('remote-control') && w.rcBridgeOnly.includes('remote-control') && JSON.stringify(fmB.torn) === '["ok"]',
      'an RC process alone, or a live bridge id alone, spares it', rb);
  }
  check(!('spareRemoteControl' in reaper.DEFAULTS) && !('spareRemoteControl' in (config.get().reaper || {})), 'no spareRemoteControl setting exists');
  check(!/o\.spareRC/.test(reaper.PAGE({ idleHours: 3, protect: [], only: null, self: [], act: false, max: 1 })) &&
        !/(opts|st)\.spareRemoteControl/.test(fs.readFileSync(require.resolve('../lib/reaper'), 'utf8')), 'nothing in the reaper reads an RC opt-out');
  const two = { ...CASES, ok2: {} };
  const fm = fakeManager(two);
  // eslint-disable-next-line no-eval
  eval(reaper.PAGE({ idleHours: 3, protect: [], only: null, self: [], spareRC: true, act: true, max: 1 }));
  check(fm.torn.length === 1, 'maxPerTick caps releases per pass');
  check(JSON.stringify(page({ only: ['running', 'ok'] }).rows.map(r => r.id).sort()) === '["ok","running"]', '`only` limits the pass to named sessions');
  check(JSON.stringify(page({ self: ['ok'] }).torn) === '[]', 'the caller\'s own session is never released');
  const failing = fakeManager({ ok: {} });
  globalThis[bridge.PIN].teardownQuery = () => { throw new Error('boom'); };
  // eslint-disable-next-line no-eval
  const fr = JSON.parse(eval(reaper.PAGE({ idleHours: 3, protect: [], only: null, self: [], spareRC: true, act: true, max: 6 })));
  check(fr[0].reaped === false && /boom/.test(fr[0].error) && failing.torn.length === 0, 'a teardown that throws is reported, not counted as released', fr);
}

console.log('\n--- mode: off by default, dry for 24 h, then live ---');
{
  check(config.mod('reaper') === false, 'the reaper module is OFF by default');
  const t0 = Date.parse('2026-06-10T12:00:00Z');
  check(reaper.state(t0, { startClock: false }).mode === 'dry' && !fs.existsSync(CFG), 'a manual run never starts the dry clock');
  const s1 = reaper.state(t0);
  check(s1.mode === 'dry' && fs.existsSync(CFG) && s1.dryUntil === t0 + 24 * H, 'the first daemon tick starts a 24 h dry run', s1);
  check(reaper.state(t0 + 23 * H).mode === 'dry', 'still dry at 23 h');
  check(reaper.state(t0 + 24 * H).mode === 'live', 'live by itself at 24 h');
  check(reaper.state(t0 + 30 * H).dryUntil === t0 + 24 * H, 'the clock is not restarted by later ticks');
  for (const m of ['off', 'dry', 'live']) {
    fs.writeFileSync(CFG, JSON.stringify({ mode: m, dryUntil: t0 }));
    check(reaper.state(t0 + 48 * H).mode === m, `state/reaper.json mode "${m}" pins it`);
  }
  fs.unlinkSync(CFG);
}

console.log('\n--- protected: goal owners and await watches ---');
{
  const r1 = goals.add({ title: 'open goal' }, { resolve: () => ({ ok: true, owner: 'goal-owner' }) });
  const r2 = goals.add({ title: 'finished goal' }, { resolve: () => ({ ok: true, owner: 'done-owner' }) });
  check(r1.ok && r2.ok, 'fixture goals added', [r1, r2]);
  goals.close(r2.goal.id, { note: 'shipped' });
  awaits.park({ masterSessionId: 'parked-master', waitingOn: ['worker-a', 'worker-b'], reason: 'test' });
  awaits.park({ masterSessionId: 'old-master', waitingOn: ['old-worker'], reason: 'test' });
  awaits.cancel('old-master');
  const ids = reaper.protectedIds();
  check(ids.has('goal-owner'), 'the owner of an unfinished goal is protected');
  check(!ids.has('done-owner'), 'the owner of a closed goal is not');
  check(ids.has('parked-master') && ids.has('worker-a') && ids.has('worker-b'), 'a parked master and everything it waits on are protected');
  check(!ids.has('old-master') && !ids.has('old-worker'), 'a resolved watch protects nobody');
}

console.log('\n--- a whole pass through a stubbed bridge ---');
(async () => {
  const orig = { connectRaw: bridge.connectRaw, wsUrl: bridge.wsUrl, locate: bridge.locate };
  bridge.wsUrl = async () => 'ws://stub';
  bridge.locate = async () => ({ found: true });
  // eslint-disable-next-line no-eval
  // The real CDP answer shape, { result: { type, value } } — a stub returning the bare value once agreed
  // with a reaper that read it that way, and the first live run failed.
  bridge.connectRaw = async () => ({ evaluate: async (src) => { try { return { result: { type: 'string', value: eval(src) } }; } catch (e) { return { exceptionDetails: { text: 'Uncaught', exception: { description: String(e) } } }; } }, close() {} });
  try {
    let fm = fakeManager({ ok: {}, running: { isRunning: true }, 'goal-owner': {} });
    let r = await reaper.tick({ mode: 'dry', startClock: false });
    check(r.mode === 'dry' && r.clis === 3 && r.eligible === 1 && r.reaped === 0 && fm.torn.length === 0, 'dry pass: counts the eligible, releases nothing', r);
    check(r.rows.find(x => x.id === 'goal-owner').why.includes('goal-or-await'), 'the pass applies the goal protection read from disk');
    let log = fs.readFileSync(LOG, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    check(log.some(l => l.action === 'WOULD-REAP' && l.id === 'ok') && log.some(l => l.action === 'TICK' && l.mode === 'dry'), 'dry logs WOULD-REAP and a TICK line');

    fm = fakeManager({ ok: {}, ok2: {} });
    r = await reaper.tick({ mode: 'live', startClock: false, max: 1 });
    check(r.reaped === 1 && fm.torn.length === 1, 'live pass releases, capped', r);
    log = fs.readFileSync(LOG, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    check(log.filter(l => l.action === 'REAPED').length === 1 && log.filter(l => l.action === 'CAPPED').length === 1, 'live logs REAPED, and CAPPED for the one left for the next pass');

    // An upgrade from 0.2.4 with the removed opt-out still in settings.json: it must change nothing.
    fs.writeFileSync(config.SETTINGS_FILE, JSON.stringify({ reaper: { spareRemoteControl: false } }));
    fm = fakeManager({ ok: {}, rc: { remoteControlEnabled: true }, bridged: { bridgeSessionId: 'session_y' } });
    r = await reaper.tick({ mode: 'live', startClock: false, spareRemoteControl: false });
    check(JSON.stringify(fm.torn) === '["ok"]' && r.reaped === 1, 'an old spareRemoteControl:false in settings (and in the call) still releases no RC session', fm.torn);
    fs.unlinkSync(config.SETTINGS_FILE);

    fs.writeFileSync(CFG, JSON.stringify({ mode: 'off' }));
    fm = fakeManager({ ok: {} });
    r = await reaper.tick();
    check(r.mode === 'off' && fm.torn.length === 0 && r.rows.length === 0, 'mode off: no pass at all');
    fs.unlinkSync(CFG);

    globalThis[bridge.PIN] = { sessions: null };
    let pageErr = null;
    try { await reaper.tick({ mode: 'dry', startClock: false }); } catch (x) { pageErr = x.message; }
    check(/PAGE_THREW/.test(pageErr || ''), 'a script that throws inside the app fails the pass (never read as no sessions)', pageErr);

    bridge.locate = async () => ({ found: false, reason: 'no manager' });
    let threw = null;
    try { await reaper.tick({ mode: 'live', startClock: false }); } catch (e) { threw = e.message; }
    check(/NO_BRIDGE/.test(threw || ''), 'no bridge: the pass fails loudly instead of reporting zero', threw);
  } finally { Object.assign(bridge, orig); }

  console.log(failed ? `\n${failed} check(s) failed` : '\nall reaper checks passed');
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log('THREW ' + (e.stack || e)); process.exit(1); });
