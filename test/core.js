// core.js — the orchestrator core, offline: router, retry/escalation policy, a worker's whole life
// against a fake `claude` CLI, await, heal (stubbed probes), chipwatch gating (stubbed desktop),
// idle detection, trust roots, the account-switch detector, registry salvage, the AGO import, the
// stderr-keeping launcher, the control-port guard, and — against a throwaway daemon on spare ports —
// the dashboard, `relaymote stop <id>` vs `relaymote stop`, and the account-switch question over the app API.
// Never talks to Claude Desktop, never spends tokens, never touches ~/.relaymote or real scheduled tasks.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-core-'));
const PORT = 19000 + Math.floor(Math.random() * 800), APP = PORT + 900;
process.env.RELAYMOTE_HOME = path.join(TMP, 'relaymote');
process.env.APPDATA = path.join(TMP, 'appdata');
process.env.CLAUDE_CONFIG_DIR = path.join(TMP, 'claude');
process.env.RELAYMOTE_PORT = String(PORT);
process.env.RELAYMOTE_APP_PORT = String(APP);
process.env.RELAYMOTE_CDP_PORT = '9';
delete process.env.RELAYMOTE_STATE_DIR;
delete process.env.ANTHROPIC_API_KEY;
const WIN = process.platform === 'win32';

let failed = 0, passed = 0;
const check = (ok, name, extra) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && extra !== undefined ? '  ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)).slice(0, 400) : ''}`);
  if (ok) passed++; else failed++;
};
const section = s => console.log('\n--- ' + s + ' ---');
const wait = ms => new Promise(r => setTimeout(r, ms));
const md5 = f => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex');
function req(port, p, { method = 'GET', body, headers = {} } = {}) {
  return new Promise(resolve => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port, path: p, method, timeout: 15000,
      headers: { ...headers, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) } },
      res => { let s = ''; res.on('data', c => s += c); res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch {} resolve({ status: res.statusCode, text: s, json: j }); }); });
    r.on('error', e => resolve({ status: 0, text: e.message })); r.on('timeout', () => r.destroy());
    if (data) r.write(data); r.end();
  });
}
function runCli(argv, env) {
  return spawnSync(process.execPath, [path.join(ROOT, 'bin', 'relaymote.js'), ...argv], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 60000 });
}

let daemonChild = null;   // killed on a crash too, so a failed run never leaves a daemon behind
const config = require('../lib/config');
const registry = require('../lib/registry');

(async () => {
  // ------------------------------------------------------------------------------------------------
  section('router: classify, ladder, escalate');
  const router = require('../lib/router');
  const CASES = [
    ['hi', ['trivial'], ['low']], ['thanks', ['trivial'], ['low']],
    ['list files in src', ['simple', 'trivial'], ['low']], ['fix the typo in README', ['simple', 'trivial'], ['low']],
    ['find where sendMessage is defined', ['simple'], ['low']],
    ['why does the worker hang on startup?', ['moderate'], ['medium']],
    ['implement a retry wrapper for the API client', ['moderate'], ['medium']],
    ['debug the race condition in the scheduler', ['complex', 'severe'], ['high']],
    ['audit every file in the codebase for security issues', ['severe', 'complex'], ['high']],
    ['design an end-to-end orchestration system for the whole app', ['complex', 'severe'], ['high']],
    ['restart the web service', ['simple', 'moderate'], ['low', 'medium']],
  ];
  for (const [p, cx, ef] of CASES) {
    const r = router.route(p);
    check(cx.includes(r.complexity) && ef.includes(r.effort), `route ${JSON.stringify(p)} -> ${r.complexity} ${r.model}/${r.effort}`, { cx, ef });
  }
  check(router.route('hi').mode === 'inline' && router.route('fix the typo in README').mode === 'worker', 'trivial chat runs inline, real work goes to a worker');
  check(router.route('audit every file in the codebase for security issues').isolate === true, 'broad/severe work is isolated (no context reuse)');
  for (const p of ['audit every file in the codebase for security issues', 'design an end-to-end orchestration system for the whole app', 'x '.repeat(300)]) {
    check(router.route(p).effort !== 'max', `max is reached only by escalation, never by classification (${p.slice(0, 24)}…)`);
  }
  const L = router.LADDER;
  check(L.length === 4 && L.map(l => l.effort).join() === 'low,medium,high,max', 'default ladder: one model, effort low → max', L.map(l => l.label));
  let cur = { model: L[0].model, effort: 'low' }; const walk = ['low'];
  for (let i = 0; i < 10; i++) { const n = router.escalate(cur.model, cur.effort); if (!n) break; walk.push(n.effort); cur = n; }
  check(walk.join() === 'low,medium,high,max', 'escalate walks low → medium → high → max', walk);
  check(router.escalate(L[3].model, 'max') === null, 'escalate stops at the top rung (no endless escalation)');
  const legacy = router.escalate('sonnet', 'medium');
  check(legacy && legacy.effort === 'high', 'a task stored under an old model name still escalates by effort', legacy);
  config.set({ levels: { easy: { model: 'Haiku 4.5', effort: 'low' }, hard: { model: 'claude-sonnet-4-6', effort: 'high' } } });
  check(router.LADDER[0].model === 'claude-haiku-4-5', 'Settings › Models: a picker name becomes a model id on the ladder', router.LADDER[0]);
  check(router.route('fix the typo in README').model === 'claude-haiku-4-5', 'easy work is routed to the model set for the easy level');
  const up = router.escalate('claude-haiku-4-5', 'low');
  check(up && up.model === router.LADDER[1].model && up.effort === 'medium', 'escalation climbs the CONFIGURED ladder', up);
  check(router.route('debug the race condition in the scheduler').model === 'claude-sonnet-4-6', 'hard work gets the hard level\'s model');
  const forcedR = router.route('fix the typo', { forceModel: 'claude-x', forceEffort: 'max' });
  check(forcedR.model === 'claude-x' && forcedR.effort === 'max', 'forced model/effort override the router');
  config.set({ levels: { easy: { model: 'claude-opus-5-5', effort: 'low' }, hard: { model: 'claude-opus-5-5', effort: 'high' } } });

  // ------------------------------------------------------------------------------------------------
  section('orchestrator: retry and escalation policy');
  const { planRetry } = require('../lib/orchestrator');
  const T = (o = {}) => ({ id: 'tX', model: 'claude-opus-5-5', effort: 'medium', attempt: 1, maxAttempts: 3, error: 'something broke', escalations: [], tokens: { input: 5, output: 5 }, ...o });
  for (const err of ['API Error: 503 overloaded', 'rate limit exceeded (429)', 'socket hang up', 'network timeout']) {
    const p = planRetry(T({ error: err }));
    check(p.action === 'retry', `transient "${err}" retries on the SAME rung (escalating cannot fix a 503)`, p);
  }
  const cap = planRetry(T({ error: 'unable to complete: context too long' }));
  check(cap.action === 'escalate' && cap.next.effort === 'high' && /capability/.test(cap.reason), 'a capability failure escalates one rung', cap);
  const gen = planRetry(T({ effort: 'low', error: 'wrong answer' }));
  check(gen.action === 'escalate' && gen.next.effort === 'medium', 'a generic failure escalates (default posture)', gen);
  check(planRetry(T({ attempt: 3 })).action === 'giveup', 'the attempt budget is enforced');
  const top = planRetry(T({ effort: 'max' }));
  check(top.action === 'giveup' && /strongest/.test(top.reason), 'the top rung gives up instead of escalating forever', top);
  const launch1 = planRetry(T({ status: 'failed', tokens: { input: 0, output: 0 }, error: 'boom' }));
  check(launch1.action === 'retry' && /NOT escalating/.test(launch1.reason), 'a worker that never reached the model (0 tokens) retries in place once', launch1);
  const launch2 = planRetry(T({ status: 'failed', attempt: 2, tokens: { input: 0, output: 0 }, error: 'boom' }));
  check(launch2.action === 'giveup' && /escalation cannot help/.test(launch2.reason), '…then gives up and says escalation cannot help', launch2);
  const env1 = planRetry(T({ error: 'spawn failed (ENOENT)' }));
  check(env1.action === 'retry', 'an environment failure retries in place, not up the ladder', env1);
  check(planRetry(T({ attempt: 2, error: 'spawn failed (ENOENT)' })).action === 'giveup', '…once only');
  let t = T({ effort: 'low', maxAttempts: 99 }), path_ = ['low'];
  for (let i = 0; i < 20; i++) { const p = planRetry(t); if (p.action !== 'escalate') break; path_.push(p.next.effort); t = T({ effort: p.next.effort, maxAttempts: 99 }); }
  check(path_.join() === 'low,medium,high,max', 'a full escalation walk terminates at max', path_);

  // ------------------------------------------------------------------------------------------------
  section('worker lifecycle against a fake claude CLI');
  const STUB = path.join(TMP, 'fake-claude.js');
  const ARGLOG = path.join(TMP, 'fake-claude-args.jsonl');
  fs.writeFileSync(STUB, `
const fs = require('fs');
const a = process.argv.slice(2);
const prompt = a[a.indexOf('-p') + 1] || '';
fs.appendFileSync(${JSON.stringify(ARGLOG)}, JSON.stringify({ args: a, cfg: process.env.CLAUDE_CONFIG_DIR, key: !!process.env.ANTHROPIC_API_KEY }) + '\\n');
const line = o => process.stdout.write(JSON.stringify(o) + '\\n');
if (/HANG/.test(prompt)) { setTimeout(() => {}, 60000); }
else if (/SILENT/.test(prompt)) { process.stderr.write('fake claude crashed before any output\\n'); process.exit(7); }
else {
  line({ type: 'system', subtype: 'init', session_id: 'sess-fake' });
  setTimeout(() => {
    line({ type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } });
    if (/FAIL/.test(prompt)) line({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'boom: could not finish', session_id: 'sess-fake', usage: { input_tokens: 9, output_tokens: 1 } });
    else line({ type: 'result', subtype: 'success', is_error: false, result: 'WORKER_E2E_OK', session_id: 'sess-fake', total_cost_usd: 0.01, num_turns: 1, usage: { input_tokens: 12, output_tokens: 3 } });
  }, 300);
}
`);
  process.env.CLAUDE_CODE_EXECPATH = STUB;
  const worker = require('../lib/worker');
  const a = worker.buildArgs({ prompt: 'x', model: 'claude-opus-5-5', effort: 'low', lean: true });
  check(!a.includes('--bare'), 'never passes --bare (it forces paid API-key auth)');
  check(a[a.indexOf('--output-format') + 1] === 'stream-json' && a.includes('--verbose'), 'streams structured output (stream-json + --verbose)');
  check(a.includes('--strict-mcp-config'), 'lean mode drops the MCP tool schemas');
  const b = worker.buildArgs({ prompt: 'x', resumeSessionId: 's1', sessionId: 's2' });
  check(b.includes('--resume') && !b.includes('--session-id'), 'resume and session-id are mutually exclusive');
  check(worker.claudeBin() === STUB, 'the CLI is located through CLAUDE_CODE_EXECPATH');

  async function runTask(prompt, fields = {}) {
    const task = registry.createTask({ title: prompt, prompt, cwd: TMP, model: 'claude-opus-5-5', effort: 'low', mode: 'worker', ...fields });
    const s = worker.spawnWorker(task.id);
    let fin = s;
    for (let i = 0; i < 60; i++) { await wait(250); fin = worker.poll(task.id); if (fin.status !== 'running') break; }
    return { task, started: s, fin };
  }
  process.env.ANTHROPIC_API_KEY = 'sk-test-should-not-leak-into-billing';
  const ok1 = await runTask('Reply OK');
  delete process.env.ANTHROPIC_API_KEY;
  check(ok1.started.status === 'running' && !!ok1.started.pid, 'spawned: status running with a pid', ok1.started.status);
  check(ok1.fin.status === 'done' && ok1.fin.result === 'WORKER_E2E_OK', 'finished: status done with the result text', ok1.fin.status + ' ' + ok1.fin.error);
  check(ok1.fin.sessionId === 'sess-fake' && ok1.fin.tokens.output === 3 && ok1.fin.pid === null, 'session id and tokens captured, pid cleared', ok1.fin);
  check(registry.getTask(ok1.task.id).status === 'done', 'the outcome survives a fresh read from disk');
  const logged = fs.readFileSync(ARGLOG, 'utf8').trim().split('\n').map(l => JSON.parse(l))[0];
  check(logged.cfg === path.join(config.DATA, 'auth'), 'the worker runs with Relaymote\'s private CLAUDE_CONFIG_DIR', logged.cfg);
  check(logged.args.includes('--permission-mode') && !logged.args.includes('--bare'), 'the real argv has no --bare', logged.args);
  const bad = await runTask('please FAIL');
  check(bad.fin.status === 'failed' && /error_during_execution/.test(bad.fin.error), 'an error result is recorded as a failure, not swallowed', bad.fin.error);
  check(planRetry(registry.getTask(bad.task.id)).action === 'escalate', '…and the policy escalates it (the model ran and failed)');
  const sil = registry.createTask({ title: 'silent', prompt: 'SILENT', cwd: TMP, model: 'claude-opus-5-5', effort: 'low' });
  worker.spawnWorker(sil.id);
  let s1 = null;
  for (let i = 0; i < 40; i++) { await wait(250); s1 = worker.poll(sil.id); if (s1.exitSeenAt) break; }
  check(!!(s1 && s1.exitSeenAt) && s1.status === 'running', 'a worker that died silently is first given a grace period', s1 && s1.status);
  registry.updateTask(sil.id, { exitSeenAt: new Date(Date.now() - 11000).toISOString() });
  const s2 = worker.poll(sil.id);
  check(s2.status === 'failed' && /exited without a result/.test(s2.error) && /crashed before any output/.test(s2.error), 'after the grace period: failed, with its stderr in the error', s2.error);
  check(planRetry(s2).action === 'retry', '…and it is retried in place (never reached the model), not escalated');
  const hang = registry.createTask({ title: 'hang', prompt: 'HANG', cwd: TMP, model: 'claude-opus-5-5', effort: 'low' });
  const hs = worker.spawnWorker(hang.id);
  await wait(400);
  const stopped = worker.stop(hang.id);
  check(stopped.status === 'cancelled' && stopped.pid === null, 'stop() cancels a running worker', stopped.status);
  await wait(500);
  if (WIN) check(!worker.isAlive(hs.pid), 'the worker process is gone after stop()');
  try { process.kill(hs.pid); } catch {}
  const rc = worker.reconcile();
  check(typeof rc.recovered === 'number' && rc.stillRunning === 0, 'reconcile() is safe to run repeatedly', rc);

  // ------------------------------------------------------------------------------------------------
  section('await: park, cancel, tick');
  const awaits = require('../lib/await');
  check(awaits.park({ waitingOn: ['t1'] }).error === 'NO_MASTER_SESSION', 'park refuses without a master session');
  check(awaits.park({ masterSessionId: 'local_m1', waitingOn: [] }).error === 'NOTHING_TO_WAIT_ON', 'park refuses an empty wait list');
  const wa = registry.createTask({ title: 'wa', prompt: 'wa' }), wb = registry.createTask({ title: 'wb', prompt: 'wb' });
  const pk = awaits.park({ masterSessionId: 'local_m1', waitingOn: [wa.id, wb.id], reason: 'two workers' });
  check(pk.ok && awaits.watchFor('local_m1').id === pk.watch.id, 'parked; watchFor finds it');
  check(awaits.tick().events.length === 0, 'no wake while the tasks are queued');
  registry.updateTask(wa.id, { status: 'done', endedAt: new Date().toISOString() });
  check(awaits.tick().events.length === 0, 'no wake while one of two is still pending');
  registry.updateTask(wb.id, { status: 'failed', endedAt: new Date().toISOString() });
  const w1 = awaits.tick();
  check(w1.events.length === 1 && w1.events[0].kind === 'await-complete' && /two workers/.test(w1.events[0].line), 'wakes once everything is terminal (done OR failed)', w1.events);
  check(!awaits.watchFor('local_m1') && awaits.tick().events.length === 0, 'a resolved watch fires once, never again');
  const p2 = awaits.park({ masterSessionId: 'local_m2', waitingOn: [wa.id + '9999'], deadlineMs: 60000 });
  check(awaits.stateOf('t99999999').done === true, 'an unknown task counts as finished rather than being waited on forever');
  awaits.cancel(p2.watch.id);
  const p3 = awaits.park({ masterSessionId: 'local_m3', waitingOn: ['local_worker'], deadlineMs: 60000 });
  const snapRun = { sessions: [{ sessionId: 'local_worker', state: 'running', lastActivityAt: new Date(Date.now() - 50 * 60000).toISOString() }] };
  const st = awaits.tick({ snapshot: snapRun });
  check(st.events.length === 1 && st.events[0].kind === 'await-stale', 'a running session quiet for 45+ minutes produces one STILL WAITING nudge', st.events);
  check(awaits.tick({ snapshot: snapRun }).events.length === 0, 'the stale nudge is sent once per watch');
  const dl = awaits.tick({ snapshot: snapRun, at: Date.now() + 2 * 3600000 });
  check(dl.events.length === 1 && dl.events[0].kind === 'await-deadline', 'the deadline wakes the master even if the work never finishes', dl.events);
  const p4 = awaits.park({ masterSessionId: 'local_m4', waitingOn: ['local_x'] });
  const p5 = awaits.park({ masterSessionId: 'local_m4', waitingOn: ['local_y'] });
  check(awaits.list().filter(w => w.masterSessionId === 'local_m4').length === 1 && awaits.watchFor('local_m4').id === p5.watch.id, 're-parking replaces the master\'s previous open watch');
  check(awaits.cancel('local_m4').ok && awaits.cancel('local_m4').error === 'NO_SUCH_WATCH', 'cancel by master id works once, then reports NO_SUCH_WATCH');
  void p3; void p4;
  check(awaits.stateOf('local_gone', { sessions: [] }).done === true, 'a session no longer in the sidebar counts as finished');

  // ------------------------------------------------------------------------------------------------
  section('heal: checks with stubbed probes');
  const heal = require('../lib/heal');
  const httpStub = map => async url => { for (const [k, v] of Object.entries(map)) if (url.includes(':' + k + '/')) return v; return { ok: false, error: 'ECONNREFUSED' }; };
  const UP = { ok: true, body: { ok: true, app: 'relaymote', pid: 1, uptimeSec: 5 } };
  const prev = heal._setProbes({ platform: () => 'win32', queryTask: () => null, runKeyValue: () => 'wscript.exe run-hidden.vbs …tray.ps1', autostartRecord: () => ({ ok: true, action: 'install', logon: 'runkey' }), sleepScale: () => 0 });
  let a1 = heal.checkScheduledTask();
  check(a1.healthy && a1.method === 'runkey' && /Run key/.test(a1.detail), 'the Run-key fallback counts as autostart (was reported MISSING)', a1);
  heal._setProbes({ queryTask: n => n === heal.WATCHDOG ? { state: 'Ready', lastResult: '0' } : null });
  a1 = heal.checkScheduledTask();
  check(a1.healthy && a1.watchdog && /watchdog task every 10 min/.test(a1.detail), 'the watchdog task is reported alongside it', a1.detail);
  heal._setProbes({ queryTask: () => null, runKeyValue: () => null });
  a1 = heal.checkScheduledTask();
  check(!a1.healthy && a1.method === 'missing', 'installed-then-vanished autostart is a fault (the guard fires)', a1);
  heal._setProbes({ autostartRecord: () => null });
  check(heal.checkScheduledTask().healthy && heal.checkScheduledTask().method === 'none', 'never installing autostart is a choice, not a fault');
  heal._setProbes({ queryTask: () => { throw new Error('access denied'); } });
  check(!heal.checkScheduledTask().healthy, 'a task query that fails is reported, not assumed fine');
  heal._setProbes({ platform: () => 'darwin' });
  check(heal.checkScheduledTask().skipped === true, 'outside Windows the check is skipped honestly');
  heal._setProbes({ platform: () => 'win32', queryTask: n => n === heal.TASK ? { state: 'Running', lastResult: '267009' } : null });
  const tk = heal.checkScheduledTask();
  const z = heal.zombie(tk, { healthy: false });
  check(!z.healthy && z.fixable && /ZOMBIE/.test(z.detail) && /tray/.test(z.detail) && /IgnoreNew/.test(z.detail), 'ZOMBIE: task Running + daemon down, described as what Relaymote installs (the tray task)', z.detail);
  check(heal.zombie(tk, { healthy: true }).healthy, 'Running + daemon up is not a zombie');
  heal._setProbes({ httpJson: httpStub({ 9: { ok: true, body: [] }, [PORT]: UP }) });
  const h1 = await heal.heal({ repair: false, skipAuth: true });
  check(h1.status === 'HEALTHY' && h1.healthy, 'all probes up: HEALTHY', h1.summary);
  heal._setProbes({ httpJson: httpStub({ 9: { ok: true, body: [] } }) });
  const h2 = await heal.heal({ repair: false, skipAuth: true });
  check(h2.status === 'DEGRADED' && /daemon/.test(h2.summary) && h2.checks.find(c => c.name === 'scheduledTask').detail.includes('ZOMBIE'), 'daemon down: DEGRADED, and the zombie task is named', h2.summary);
  heal._setProbes({ httpJson: httpStub({ [PORT]: { ok: true, body: { ok: true, app: 'someone-else' } } }) });
  check(!(await heal.checkDaemon()).healthy, 'another program answering on the port is not our daemon');
  heal._setProbes({ ps: () => 'C:\\somewhere\\other-app.exe --serve' });
  check(heal.isRelaymoteProcess(4242) === false && heal.killPid(4242) === false, 'killPid refuses a process that is not Relaymote\'s own daemon (guard fires)');
  heal._setProbes({ ps: () => `"${process.execPath}" "${path.join(ROOT, 'server.js')}"` });
  check(heal.isRelaymoteProcess(4242) === true, '…and recognises Relaymote\'s own server.js');
  heal._setProbes(prev);

  // ------------------------------------------------------------------------------------------------
  section('idle detection');
  const idle = require('../lib/idle');
  const ioreg = '    | |   "HIDIdleTime" = 4200000000\n    | |   "HIDIdleTimeDelta" = 1';
  check(idle.parseIoreg(ioreg) === 4200, 'macOS: HIDIdleTime nanoseconds → ms');
  check(idle.parseIoreg('nothing here') === null && idle.parseXprintidle('1234\n') === 1234 && idle.parseXprintidle('err') === null, 'parsers return null on anything unexpected');
  check(idle.isIdle(0) === true, 'a gate of 0 never waits');
  idle._setSampler(() => null);
  idle.idleMs(); await wait(50);
  check(idle.idleMs() === null && idle.isIdle(1000) === false, 'UNKNOWN idle time counts as NOT idle (the gate holds)');
  idle._setSampler(() => 5000);
  idle.idleMs(); await wait(50);
  check(idle.isIdle(1000) === true && idle.isIdle(60000) === false, 'a real reading is compared with the gate');
  check(idle.status().known && idle.status().method === 'test-sampler', 'status() names the probe');
  idle._setSampler(null);
  if (!WIN) {
    // on a machine without xprintidle the Linux probe must report unknown, not idle
  }
  process.env.RELAYMOTE_IDLE_PLATFORM = 'linux';
  idle._setSampler(null);
  idle.idleMs(); await wait(1500);
  const lin = idle.status();
  const hasXprint = spawnSync(WIN ? 'where' : 'which', ['xprintidle']).status === 0;
  if (!hasXprint) check(lin.known === false && idle.isIdle(1000) === false && /xprintidle/.test(String(lin.error)), 'Linux without xprintidle: unknown, reported, and NOT idle (was: always idle)', lin);
  delete process.env.RELAYMOTE_IDLE_PLATFORM;
  idle._setSampler(null); idle.stop();

  // ------------------------------------------------------------------------------------------------
  section('chipwatch: tick gating (stubbed desktop)');
  const started = [];
  const stubDesktop = {
    allChipQueues: async () => ({ ok: true, total: 2, sessions: new Map([['local_owned', { chips: [{ taskId: 'task_a', title: 'A' }, { taskId: 'task_b', title: 'B' }] }]]) }),
    startTask: async ({ taskId }) => { started.push(taskId); if (onStart) onStart(); return { ok: true, startedSessionId: 'local_new_' + taskId }; },
    loadSnapshot: () => ({ sessions: [] }), setGroup: async () => ({ ok: true }), setModel: async () => ({ ok: true }),
  };
  let onStart = null;
  const dPath = require.resolve('../lib/desktop'), cPath = require.resolve('../lib/chipwatch');
  const realDesktop = require.cache[dPath];
  require.cache[dPath] = { id: dPath, filename: dPath, loaded: true, exports: stubDesktop };
  delete require.cache[cPath];
  const chipwatch = require('../lib/chipwatch');
  if (realDesktop) require.cache[dPath] = realDesktop; else delete require.cache[dPath];
  delete require.cache[cPath];
  idle._setSampler(() => 0);
  const c0 = await chipwatch.tick();
  check(c0.skipped === 'user-active' && started.length === 0, 'the user is at the keyboard: nothing is pressed', c0);
  idle._setSampler(() => null);
  const cU = await chipwatch.tick();
  check(cU.skipped === 'user-active' && started.length === 0, 'idle time UNKNOWN: nothing is pressed (the guard fires)', cU);
  idle._setSampler(() => 10 * 60000);
  const c1 = await chipwatch.tick();
  check(c1.skipped === 'no-master-owns-anything' && started.length === 0, 'idle, but no master owns a session: nothing is pressed', c1);
  fs.writeFileSync(path.join(config.STATE, 'masters.json'), JSON.stringify({ proj: { sessionId: 'local_owned', expiresAt: new Date(Date.now() + 3600000).toISOString(), fleet: [] } }));
  onStart = () => idle._setSampler(() => 0);
  const c2 = await chipwatch.tick();
  check(c2.skipped === 'user-active-mid-tick' && started.join() === 'task_a', 'the user comes back mid-tick: it stops after the chip in hand', c2);
  onStart = null;
  idle._setSampler(() => 10 * 60000);
  const c3 = await chipwatch.tick();
  check(c3.started && c3.started.map(x => x.taskId).join() === 'task_b', 'a started chip is never pressed twice; the next one is', c3);
  const fleet = JSON.parse(fs.readFileSync(path.join(config.STATE, 'masters.json'), 'utf8')).proj.fleet;
  check(fleet.includes('local_new_task_a') && fleet.includes('local_new_task_b'), 'started sessions join the owning master\'s fleet', fleet);
  fs.writeFileSync(path.join(config.STATE, 'masters.json'), JSON.stringify({ proj: { sessionId: 'local_owned', expiresAt: new Date(Date.now() - 1000).toISOString() } }));
  check(chipwatch.ownedSessions().length === 0, 'an expired master claim owns nothing');
  idle._setSampler(null); idle.stop();
  fs.unlinkSync(path.join(config.STATE, 'masters.json'));

  // ------------------------------------------------------------------------------------------------
  section('trusted roots');
  const trust = require('../lib/trust');
  const tr = trust.trustedRoots([path.parse(TMP).root, 'relative/dir', path.join(TMP, 'projects'), '']);
  check(tr.roots.length === 1 && tr.refused.length === 2, 'a filesystem root and a relative path are refused (guard fires)', tr);
  check(Array.isArray(config.DEFAULTS.trustedRoots) && config.DEFAULTS.trustedRoots.length === 0, 'settings.trustedRoots defaults to [] (nothing extra trusted)');
  fs.mkdirSync(path.join(TMP, 'projects', 'alpha'), { recursive: true });
  config.set({ trustedRoots: [path.join(TMP, 'projects'), path.parse(TMP).root] });
  const et = trust.ensureDefaultTrust();
  check(trust.isTrusted(path.join(TMP, 'projects', 'alpha')) && et.refusedRoots.length === 1, 'a configured root trusts its subfolders; the drive root is refused and reported', et);
  check(!trust.isTrusted(path.parse(TMP).root.replace(/[\\/]+$/, '') + path.sep + 'Windows'), 'nothing under a refused root was trusted');
  config.set({ trustedRoots: [] });

  // ------------------------------------------------------------------------------------------------
  section('account scope: detector and the switch question');
  const STORE = path.join(process.env.APPDATA, 'Claude', 'claude-code-sessions');
  const mk = (acct, org, n) => { const d = path.join(STORE, acct, org); fs.mkdirSync(d, { recursive: true }); for (let i = 0; i < n; i++) fs.writeFileSync(path.join(d, `local_${acct}-${i}.json`), '{}'); };
  const A1 = 'aaaaaaaa-0000-4000-8000-000000000001', A2 = 'bbbbbbbb-0000-4000-8000-000000000002', ORG = 'cccccccc-0000-4000-8000-00000000000c';
  mk(A1, ORG, 3); mk(A2, ORG, 2);
  const scope = require('../lib/account-scope');
  check(scope.activeScope().state === 'unknown', 'no Desktop config: the account is UNKNOWN, not guessed');
  fs.writeFileSync(scope.DESKTOP_CONFIG, JSON.stringify({ lastKnownAccountUuid: A1 }));
  const live = scope.activeScope();
  check(live.state === 'known' && live.scope === A1 + '/' + ORG && live.records === 3, 'the active account comes from Desktop\'s own config', live);
  check(scope.note(live).baseline === true, 'the first known reading is a baseline, not a switch');
  check(scope.note(live).changed === false, 'the same account again is not a switch');
  const other = { state: 'known', scope: A2 + '/' + ORG, accountId: A2, orgId: ORG };
  const mv = scope.note(other);
  check(mv.changed && mv.from === live.scope && mv.to === other.scope, 'a different account IS a switch, naming both sides', mv);
  check(scope.note({ state: 'unknown' }).changed === false && scope.readState().scope === other.scope, 'unknown (a Desktop restart) neither fakes a switch nor moves the baseline');
  const t0 = 1_000_000_000_000, chg = { changed: true, from: 'A/1', to: 'B/2' };
  const q1 = scope.raise(chg, t0);
  check(q1 && q1.key === 'A/1 -> B/2' && q1.answer === null, 'a genuine switch raises a question');
  check((scope.raise(chg, t0 + 60000) || {}).askedAt === t0, 're-raising the same unanswered switch keeps the same question');
  check(scope.answer('maybe').error === 'BAD_ANSWER', 'a nonsense answer is refused (guard fires)');
  check(scope.answer('dismiss', t0 + 70000).ok && scope.pending() === null, 'answering persists the decision');
  check(scope.raise(chg, t0 + 5 * 60000) === null, 'the identical move minutes later is NOT asked again');
  check(!!scope.raise(chg, t0 + 24 * 3600000), '…but a day later it is a new event');
  scope.answer('dismiss', t0 + 24 * 3600000 + 1);
  check(!!scope.raise({ changed: true, from: 'B/2', to: 'C/3' }, t0 + 24 * 3600000 + 2), 'a different move right after an answer is asked at once');
  check(scope.STATE_FILE.startsWith(TMP) && scope.PENDING_FILE.startsWith(TMP), 'all detector state lives in the temp folder');

  // ------------------------------------------------------------------------------------------------
  section('notify: state folder re-read per call');
  const notify = require('../lib/notify');
  const alt = path.join(TMP, 'alt-state');
  process.env.RELAYMOTE_STATE_DIR = alt;
  try { notify.setConfig({ notifyTasks: false }); } catch {}
  delete process.env.RELAYMOTE_STATE_DIR;
  check(fs.existsSync(path.join(alt, 'notify-config.json')), 'RELAYMOTE_STATE_DIR set after load still redirects notify (read per call)');

  // ------------------------------------------------------------------------------------------------
  section('registry salvage');
  const salvage = require('../lib/salvage');
  const mkState = n => { const s = { version: 1, tasks: {}, seq: n, updatedAt: null }; for (let i = 1; i <= n; i++) { const id = 't' + String(i).padStart(4, '0'); s.tasks[id] = { id, title: 'task ' + i, prompt: 'p' + i, createdAt: new Date(t0 + i).toISOString(), status: 'done', dependsOn: [] }; } return s; };
  const good = JSON.stringify(mkState(3), null, 2);
  const pad = s => s + '\u0000'.repeat(200) + '   ';
  let sv = salvage.salvage(pad(good));
  check(sv && sv.method === 'trimmed padding only' && Object.keys(sv.data.tasks).length === 3, 'zero-filled tail: trimming is enough', sv && sv.method);
  const cut = good.slice(0, good.indexOf('"t0003"') + 40);
  sv = salvage.salvage(pad(cut));
  check(sv && sv.method === 'closed at the last complete task' && Object.keys(sv.data.tasks).join() === 't0001,t0002' && sv.data.seq >= 2, 'cut mid-task: closed after the last complete task', sv && sv.method);
  sv = salvage.salvage(pad(cut.replace('"tasks": {', '"tasks": [')));
  check(sv && sv.method === 'per-task scan' && Object.keys(sv.data.tasks).length === 2, 'mangled structure: tasks recovered one by one', sv && sv.method);
  check(salvage.salvage('\u0000'.repeat(500)) === null, 'nothing but padding: honestly nothing recoverable');
  // live quarantine: the registry module moves a corrupt file aside and keeps numbering above it
  fs.writeFileSync(registry.FILE, pad(cut));
  const errW = process.stderr.write; let said = ''; process.stderr.write = s => { said += s; return true; };
  const afterQ = registry.allTasks();
  process.stderr.write = errW;
  const qfile = salvage.newestCorrupt(registry.STATE_DIR);
  check(afterQ.length === 0 && !!qfile && /relaymote salvage/.test(said), 'a corrupt registry is quarantined (not deleted) and the way back is printed', said.trim());
  const nt = registry.createTask({ title: 'new after crash', prompt: 'new after crash' });
  check(nt.id === 't0004', 'new ids continue ABOVE the damaged file\'s ids, so salvage cannot collide', nt.id);
  const qHash = md5(qfile);
  const dry = salvage.run({});
  check(dry.ok && !dry.applied && dry.added === 2 && registry.allTasks().length === 1, 'salvage is a dry run by default', dry);
  const wet = salvage.run({ apply: true });
  check(wet.applied && registry.allTasks().length === 3 && md5(qfile) === qHash, 'salvage --apply merges the tasks back; the quarantined file is untouched', wet);
  check(salvage.run({ apply: true }).added === 0, 'running it twice adds nothing');
  const col = salvage.mergeTasks({ tasks: { t0001: { id: 't0001', prompt: 'other', createdAt: 'x' } }, seq: 1 }, mkState(2));
  check(col.renumbered.t0001 && col.merged.tasks[col.renumbered.t0001].originalId === 't0001' && col.merged.tasks.t0001.prompt === 'other', 'an id taken by a different live task: the salvaged one is renumbered, never dropped', col.renumbered);

  // ------------------------------------------------------------------------------------------------
  section('launcher: stderr kept, rotated, launch/exit lines');
  const launch = require('../lib/launch');
  const LS = path.join(TMP, 'launch-state');
  process.env.RELAYMOTE_STATE_DIR = LS;
  fs.mkdirSync(LS, { recursive: true });
  fs.writeFileSync(path.join(LS, 'daemon-stdio.log'), 'x'.repeat(300));
  const entry = path.join(TMP, 'entry.js');
  fs.writeFileSync(entry, "process.stderr.write('dying words on stderr\\n'); console.log('stdout is not captured'); process.exit(3);\n");
  process.env.RELAYMOTE_STDIO_MAX_BYTES = '100';
  const code = await launch.runWrapped({ entry });
  const log = fs.readFileSync(launch.logFile(), 'utf8');
  check(code === 3, 'the wrapper returns the daemon\'s exit code', code);
  check(/launching/.test(log) && /dying words on stderr/.test(log) && /exited with code 3/.test(log), 'launch line, stderr and the exit line are all kept', log);
  check(!/stdout is not captured/.test(log), 'stdout is not duplicated into the capture');
  check(fs.statSync(launch.logFile() + '.1').size === 300, 'an over-size capture is rotated to .1 before node starts');
  launch.markStopped('test');
  const before = fs.readFileSync(launch.logFile(), 'utf8');
  const w = launch.wrapper();
  spawnSync(w.cmd, [...w.args, '--watchdog'], { env: { ...process.env, RELAYMOTE_DAEMON_ENTRY: entry, RELAYMOTE_NODE: process.execPath }, windowsHide: true });
  check(fs.readFileSync(launch.logFile(), 'utf8') === before, 'a watchdog run does nothing after the user stopped Relaymote');
  check(launch.clearStopped() && !launch.stoppedByUser(), 'the stop marker clears');
  delete process.env.RELAYMOTE_STDIO_MAX_BYTES;
  delete process.env.RELAYMOTE_STATE_DIR;

  // ------------------------------------------------------------------------------------------------
  section('control-port guard');
  const guard = require('../lib/control-guard');
  const G = (method, headers) => guard.check({ method, headers }, PORT);
  check(G('POST', { host: `127.0.0.1:${PORT}` }) === null, 'the CLI / MCP (no Origin, loopback Host) pass');
  check(G('POST', { host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}` }) === null, 'the dashboard itself passes');
  check(G('POST', { host: `127.0.0.1:${PORT}`, origin: 'https://evil.example' }).body.error === 'CROSS_ORIGIN', 'a POST from another website is refused');
  check(G('POST', { host: `127.0.0.1:${PORT}`, origin: 'null' }).body.error === 'CROSS_ORIGIN', 'a sandboxed/file page (Origin: null) is refused');
  check(G('GET', { host: `evil.example:${PORT}` }).body.error === 'BAD_HOST', 'a rebinding hostname is refused even for GET');
  check(G('POST', { host: `localhost:${PORT}`, 'sec-fetch-site': 'cross-site' }).body.error === 'CROSS_ORIGIN', 'Sec-Fetch-Site: cross-site is refused');

  // ------------------------------------------------------------------------------------------------
  if (WIN) {
    section('autostart script (dry run only — nothing is registered)');
    const ps1 = path.join(ROOT, 'scripts', 'register-autostart.ps1');
    const parse = spawnSync('powershell.exe', ['-NoProfile', '-Command', `$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('${ps1}', [ref]$null, [ref]$e); $e.Count; $e2=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('${path.join(ROOT, 'scripts', 'tray.ps1')}', [ref]$null, [ref]$e2); $e2.Count`], { encoding: 'utf8' });
    check(parse.stdout.trim().split(/\s+/).join() === '0,0', 'register-autostart.ps1 and tray.ps1 parse cleanly', parse.stdout + parse.stderr);
    const dr = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-DryRun'], { encoding: 'utf8' });
    let j = null; try { j = JSON.parse(dr.stdout.trim()); } catch {}
    check(j && j.ok && j.dryRun && j.plan.some(p => /at sign-in \+1 min.*IgnoreNew, restart 3x\/1 min/.test(p)) && j.plan.some(p => /Watchdog: every 10 min/.test(p)), 'plan: sign-in task (1-min delay, IgnoreNew, restart 3x/1 min) + 10-minute watchdog', j || dr.stdout + dr.stderr);
    const dh = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-DryRun', '-Mode', 'headless'], { encoding: 'utf8' });
    let jh = null; try { jh = JSON.parse(dh.stdout.trim()); } catch {}
    check(jh && jh.s4u === true && jh.plan[0].includes('S4U'), 'headless mode tries S4U first', jh || dh.stdout);
  }

  // ------------------------------------------------------------------------------------------------
  section('against a throwaway daemon: dashboard, guard, stop <id> vs stop, account-switch question');
  const DH = path.join(TMP, 'daemon');
  fs.mkdirSync(path.join(DH, 'state'), { recursive: true });
  fs.writeFileSync(path.join(DH, 'settings.json'), JSON.stringify({ cdpPort: 9, onboarded: true, autoEnableDebugger: false,
    modules: { autoResume: false, orchestrator: false, chipAutostart: false, masterNotify: false, organizer: false, transcriptIndex: false, accounts: true },   // Accounts on so a switch is ASKED; sync itself stays off
    accounts: { enabled: false, autoSync: false } }));
  fs.writeFileSync(path.join(DH, 'state', 'registry.json'), JSON.stringify({ version: 1, seq: 1, tasks: {
    t0001: { id: 't0001', title: 'a queued task', prompt: 'x', status: 'queued', mode: 'inline', createdAt: new Date().toISOString(), dependsOn: [] } } }, null, 2));
  fs.writeFileSync(path.join(DH, 'state', 'account-scope.json'), JSON.stringify({ scope: A1 + '/' + ORG, accountId: A1, orgId: ORG, since: Date.now() }));
  fs.writeFileSync(scope.DESKTOP_CONFIG, JSON.stringify({ lastKnownAccountUuid: A1 }));
  const denv = { ...process.env, RELAYMOTE_HOME: DH, RELAYMOTE_PORT: String(PORT), RELAYMOTE_APP_PORT: String(APP) };
  delete denv.CLAUDE_CODE_EXECPATH;
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: denv, stdio: ['ignore', 'pipe', 'pipe'] });
  daemonChild = child;
  let dout = ''; child.stdout.on('data', d => dout += d); child.stderr.on('data', d => dout += d);
  let upd = false;
  for (let i = 0; i < 80 && !upd; i++) { await wait(250); const r = await req(PORT, '/api/health'); upd = r.status === 200 && r.json && r.json.app === 'relaymote'; }
  check(upd, 'daemon answers on the spare port');
  const dash = await req(PORT, '/');
  check(dash.status === 200 && /Relaymote · control/.test(dash.text) && dash.text.includes(`127.0.0.1:${APP}/`) && /route-preview/.test(dash.text) && /escalate/.test(dash.text), 'GET / serves the control dashboard (submit + preview, stop/escalate, sessions by group), with the configured app port');
  check(!/AGO/.test(dash.text), 'the dashboard carries Relaymote branding only');
  const pv = await req(PORT, '/api/route-preview', { method: 'POST', body: { prompt: 'fix the typo in README' }, headers: { Origin: `http://127.0.0.1:${PORT}` } });
  check(pv.status === 200 && pv.json.decision.effort === 'low', 'the dashboard\'s route preview works from its own origin');
  const evil = await req(PORT, '/api/task', { method: 'POST', body: { prompt: 'rm -rf everything' }, headers: { Origin: 'https://evil.example' } });
  check(evil.status === 403 && evil.json.error === 'CROSS_ORIGIN', 'a cross-site POST /api/task is refused by the live daemon', evil.status);
  const reb = await req(PORT, '/api/state', { headers: { Host: 'rebind.example:' + PORT } });
  check(reb.status === 403, 'a DNS-rebinding Host is refused by the live daemon', reb.status);
  const benv = { RELAYMOTE_HOME: DH, RELAYMOTE_PORT: String(PORT), RELAYMOTE_APP_PORT: String(APP) };
  const s1c = runCli(['stop', 't0001'], benv);
  const afterStop = await req(PORT, '/api/health');
  const t1 = JSON.parse(fs.readFileSync(path.join(DH, 'state', 'registry.json'), 'utf8')).tasks.t0001;
  check(afterStop.status === 200 && t1.status === 'cancelled', '`relaymote stop <id>` stops that task and leaves the daemon running (regression)', { out: s1c.stdout.slice(0, 200), status: t1.status, health: afterStop.status });
  const noSuch = runCli(['stop', 't9999'], benv);
  check(/no such task/.test(noSuch.stderr) && (await req(PORT, '/api/health')).status === 200, '`relaymote stop <unknown id>` says so and still leaves the daemon running', noSuch.stderr);

  // account-switch question through the app's own API (the daemon polls fast while a stream is open)
  let token = null; try { token = JSON.parse(fs.readFileSync(path.join(DH, 'mobile', 'secret.json'), 'utf8')).token; } catch {}
  const mobileErr = (dout.match(/mobile layer failed[^\r\n]*/) || ['no secret.json'])[0];
  check(!!token, 'the app layer started (its access key exists)', mobileErr);
  if (token) {
  const auth = { Authorization: 'Bearer ' + token };
  const stream = http.request({ host: '127.0.0.1', port: APP, path: '/api/stream?client=core-test', headers: { ...auth, Accept: 'text/event-stream' } }, res => res.resume());
  stream.on('error', () => {}); stream.end();
  await wait(3500);
  const none = await req(APP, '/api/account-switch', { headers: auth });
  check(none.status === 200 && none.json.pending === null, 'no question before any switch', none.json);
  fs.writeFileSync(path.join(DH, 'state', 'account-scope.json'), JSON.stringify({ scope: A2 + '/' + ORG, accountId: A2, orgId: ORG, since: Date.now() - 60000 }));
  let q = null;
  for (let i = 0; i < 24 && !q; i++) { await wait(500); const r = await req(APP, '/api/account-switch', { headers: auth }); q = r.json && r.json.pending; }
  check(q && q.from === A2 + '/' + ORG && q.to === A1 + '/' + ORG && q.answer === null, 'the daemon noticed the switch and asked, acting on nothing', q);
  const badA = await req(APP, '/api/account-switch', { method: 'POST', headers: auth, body: { answer: 'maybe' } });
  check(badA.status === 400 && badA.json.error === 'BAD_ANSWER', 'a nonsense answer is refused over the API');
  const okA = await req(APP, '/api/account-switch', { method: 'POST', headers: auth, body: { answer: 'dismiss' } });
  const onDisk = JSON.parse(fs.readFileSync(path.join(DH, 'state', 'account-switch.json'), 'utf8'));
  check(okA.status === 200 && onDisk.answer === 'dismiss' && (await req(APP, '/api/account-switch', { headers: auth })).json.pending === null, 'the answer is on disk and the question is closed');
  try { stream.destroy(); } catch {}
  }

  const s2c = runCli(['stop'], benv);
  for (let i = 0; i < 60 && child.exitCode === null; i++) await wait(250);
  check(/Stopping/.test(s2c.stdout) && child.exitCode === 0, 'bare `relaymote stop` shuts the daemon down cleanly', { out: s2c.stdout, exit: child.exitCode });
  check(fs.existsSync(path.join(DH, 'state', 'stopped-by-user.json')), '…and records that the user stopped it (tray/watchdog leave it stopped)');
  if (child.exitCode === null) child.kill();
  if (failed) console.log('\n--- daemon output (tail) ---\n' + dout.slice(-3000));

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('CRASH', e && e.stack || e); try { if (daemonChild && daemonChild.exitCode === null) daemonChild.kill(); } catch {} try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} process.exit(1); });
