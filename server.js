'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const registry = require('./lib/registry');
const orch = require('./lib/orchestrator');
const desktop = require('./lib/desktop');
const router = require('./lib/router');
const notify = require('./lib/notify');
const chipwatch = require('./lib/chipwatch');
const uiqueue = require('./lib/uiqueue');
const resume = require('./lib/resume');
const heal = require('./lib/heal');
const goal = require('./lib/goal');
const awaits = require('./lib/await');
const config = require('./lib/config');
const projects = require('./lib/projects');
const organizer = require('./lib/organizer');
const goals = require('./lib/goals');
const boardBuild = require('./lib/board-build');

try { process.chdir(require('os').homedir()); } catch {}
const PORT = config.get().port;
const PUMP_MS = 5000;
const DESKTOP_MS = 30000;
const NOTIFY_MS = 15000;
const RESUME_MS = 60000;
const CHIPWATCH_MS = Number(process.env.RELAYMOTE_CHIPWATCH_MS || 60000);
const idleMinMs = () => Number(process.env.RELAYMOTE_IDLE_MIN_MS ?? (config.get().idleGateSeconds * 1000));

const serialise = desktop.serializeUi;
// Every master notification is a wake: log it (with the warmth it went at) in <data>/conductor/wakes.jsonl.
try { const prevSend = notify._setSender(); notify._setSender(require('./lib/wakes').instrument(prevSend, 'notify')); } catch {}

let lastDesktopErr = null;
let lastChipwatch = null, lastUiQueue = null;
let lastCdpOk = null, lastCdpAt = 0, lastDesktopAt = 0;
async function uiQueueTick() {
  try { lastUiQueue = { at: new Date().toISOString(), ...(await uiqueue.drain()) }; }
  catch (e) { lastUiQueue = { at: new Date().toISOString(), error: e.message }; }
  if (lastUiQueue && lastUiQueue.done && lastUiQueue.done.length) {
    orch.log('ui-queue ran: ' + lastUiQueue.done.map(d => d.action).join(', '));
  }
}

async function chipwatchTick() {
  if (!config.mod('chipAutostart')) return;
  try {
    const r = await chipwatch.tick();
    lastChipwatch = { at: new Date().toISOString(), ...r };
    if (r && r.started && r.started.length) {
      orch.log('chipwatch started: ' + r.started.map(x => x.taskId + ' -> ' + x.sessionId).join(', '));
    }
  } catch (e) { lastChipwatch = { at: new Date().toISOString(), error: e.message }; }
}

async function refreshDesktop() {
  const _t0 = Date.now();
  try {
  lastDesktopAt = Date.now();
  desktop.cdpAvailable().then(ok => { lastCdpOk = ok; lastCdpAt = Date.now(); }).catch(() => { lastCdpOk = false; lastCdpAt = Date.now(); });
  try {
    const sidebar = await desktop.scrapeSidebar();
    // Running comes from Desktop's session API when it answers; the sidebar label is the fallback.
    const truth = await desktop.readRunningAll(sidebar.sessions.map(s => s.id)).catch(() => ({}));
    for (const s of sidebar.sessions) if (typeof truth[s.id] === 'boolean') s.running = truth[s.id];
    const agents = await claudeAgents();
    const cwdMap = desktop.buildCwdMap(agents);
    const merged = desktop.mergeSessions(
      sidebar.sessions.map(s => {
        const c = desktop.lookupCwd(cwdMap, s.id);
        return {
          sessionId: s.id, title: s.title, cwd: c.cwd || null, projectSlug: c.slug || null,
          isArchived: s.archived, isRunning: s.running, lastActivityAt: null,
        };
      }),
      sidebar
    );
    for (const m of merged) {
      const c = desktop.lookupCwd(cwdMap, m.sessionId);
      if (!m.cwd && c.cwd) m.cwd = c.cwd;
      m.projectSlug = c.slug || null;
    }
    const held = desktop.confirmAttentionStates(merged);
    if (held.length) {
      orch.log('desktop: holding ' + held.length + ' unconfirmed attention dot(s) for one cycle: ' +
        held.map(h => h.pending + ' ' + String(h.title || h.sessionId).slice(0, 40)).join('; '));
    }
    const groups = desktop.groupSessions(merged);
    desktop.saveSnapshot({ sessions: merged, groups, blocker: sidebar.blocker || null, active: sidebar.active });
    lastDesktopErr = null;
    try {
      const vs = await desktop.viewSentinel();
      if (vs.action === 'restored' || vs.action === 'adopted' || vs.action === 'recorded') orch.log('sidebar view sentinel: ' + JSON.stringify(vs));
    } catch (e) { orch.log('sidebar view sentinel error: ' + e.message); }
  } catch (e) {
    lastDesktopErr = e.message;
  }
  } finally { const d = Date.now() - _t0; if (d > 800) orch.log(`refreshDesktop took ${d}ms`); }
}

let lastNotify = null;
function awaitTick() {
  try {
    const r = awaits.tick({ snapshot: desktop.loadSnapshot() });
    for (const e of r.events) {
      const q = notify.pushEvent({ ...e, source: 'await' });
      orch.log(`await: ${e.kind} for ${e.masterSessionId} -> queued=${q.queued}${q.reason ? ' (' + q.reason + ')' : ''}`);
    }
    return r;
  } catch (e) { orch.log('await tick error: ' + e.message); return { events: [], error: e.message }; }
}

async function notifyTick() {
  if (!config.mod('orchestrator')) return;
  awaitTick();
  if (!config.mod('masterNotify')) return;
  try { lastNotify = { at: new Date().toISOString(), ...(await notify.tick()) }; }
  catch (e) { lastNotify = { at: new Date().toISOString(), error: e.message }; orch.log('notify error: ' + e.message); }
  if (lastNotify && lastNotify.delivered) orch.log(`notify: delivered ${lastNotify.delivered} batch(es) ${JSON.stringify(lastNotify.batches || [])}`);
}

// Claude Desktop switches its debugger off whenever it restarts. On Windows, switch it back on as soon as
// Desktop is up and signed in — no idle wait: the macro puts a 3-2-1 countdown on screen first and takes a
// few seconds (input during the countdown snoozes it). Exits that clicked nothing (not signed in, session
// disconnected or locked, Desktop gone, you kept typing: codes 1, 8, 9, 10, 12) are retried every minute; one that clicked and failed backs off ten minutes, and a
// Desktop run gets at most three of those, so a broken menu is never clicked forever.
const DEBUGGER_WAITING = new Set([1, 8, 9, 10, 12]);   // 12: you kept using the computer during the countdown
let debuggerNext = 0, debuggerTries = 0, debuggerPid = null, lastDebuggerWait = null;
async function debuggerTick() {
  if (process.platform !== 'win32' || config.get().autoEnableDebugger === false) return;
  if (lastCdpOk !== false || Date.now() < debuggerNext) return;
  const pid = await new Promise(r => execFile('tasklist', ['/FI', 'IMAGENAME eq claude.exe', '/NH', '/FO', 'CSV'], { windowsHide: true },
    (e, out) => { const m = !e && /"claude\.exe","(\d+)"/i.exec(String(out)); r(m ? m[1] : null); }));
  if (!pid) return;
  if (pid !== debuggerPid) { debuggerPid = pid; debuggerTries = 0; }
  if (debuggerTries >= 3) return;
  const r = await heal.enableDebugger().catch(e => ({ ok: false, code: -3, message: e.message }));
  if (r.ok) { lastCdpOk = true; debuggerTries = 0; lastDebuggerWait = null; orch.log('debugger auto-enable: on again'); return; }
  if (DEBUGGER_WAITING.has(r.code)) {
    debuggerNext = Date.now() + 60000;
    if (lastDebuggerWait !== r.code) orch.log('debugger auto-enable: waiting — ' + r.message);
    lastDebuggerWait = r.code;
    return;
  }
  debuggerTries++; debuggerNext = Date.now() + 10 * 60000; lastDebuggerWait = null;
  orch.log('debugger auto-enable: failed (' + debuggerTries + '/3, exit ' + r.code + ') — ' + r.message + (r.detail ? ' [' + r.detail + ']' : ''));
}

// followClaude (lib/follow.js): the tray starts Relaymote when Claude Desktop opens; this stops it after
// Desktop exits, once the exit-window account sync has run.
const claudeUp = () => new Promise(r => execFile('tasklist', ['/FI', 'IMAGENAME eq claude.exe', '/NH'], { windowsHide: true },
  (e, out) => r(e ? null : /claude\.exe/i.test(String(out)))));
const follow = require('./lib/follow').makeFollow({
  enabled: () => process.platform === 'win32' && config.get().followClaude === true,
  claudeUp,
  busy: () => require('./lib/updater').busyReason(),
  sync: async () => {
    const acct = config.get().accounts || {};
    if (!config.mod('accounts') || acct.enabled === false) return 'accounts off';
    const sync = require('./lib/account-sync');
    let out = 'auto-sync off';
    if (acct.autoSync) {
      const r = await sync.bootPass({ trigger: 'desktop-exit' });
      out = !r ? 'not run' : r.skipped ? 'skipped (' + r.presence + ')' : r.ok === false ? 'failed: ' + r.error
        : (r.applied ? r.applied.count : 0) + ' change(s) written, ' + (r.pendingCount || 0) + ' pending';
    }
    try { await sync.transferTick({ exited: true }); } catch (e) { out += '; account-switch transfer failed: ' + e.message; }
    return out;
  },
  // run-daemon.cmd sees this marker and starts Relaymote again the moment claude.exe reappears.
  stop: () => { try { fs.writeFileSync(path.join(registry.STATE_DIR, 'follow-sleep.json'), JSON.stringify({ at: new Date().toISOString(), pid: process.pid })); } catch {} shutdown('follow-claude'); },
  log: (m) => orch.log('follow Claude: ' + m),
});

// The project index (lib/projects.js) is file reads only, so it runs outside the UI lane; the
// organizer's moves drive the sidebar, so they run inside it, idle-gated per move.
const INDEX_MS = 30 * 60000, ORGANIZE_MS = 5 * 60000;
async function indexTick() {
  if (!config.mod('orchestrator') && !config.mod('organizer')) return null;
  try {
    const intel = require('./lib/summarize');
    const ix = await projects.build(intel.buildOpts());
    // after the build (digests included): overviews, then the roles DB — its own lock, throttle and budgets, never awaited here
    intel.cycle({ log: orch.log, rebuild: () => projects.build(intel.buildOpts()) }).catch(e => orch.log('intel cycle: ' + e.message));
    // transcripts are read under a per-tick time budget; while a first index is still catching up,
    // come back in a minute rather than in half an hour (one pending catch-up at a time)
    if (ix && ix.transcripts && ix.transcripts.pending && !indexTick.catchUp) {
      indexTick.catchUp = setTimeout(() => { indexTick.catchUp = null; indexTick(); }, 60000);
    }
    return ix;
  }
  catch (e) { orch.log('project index error: ' + e.message); return null; }
}
// Goal chaser + cache keeper: bridge sends need no UI, so only starting a new session is idle-gated
// and serialised. The Board file is rebuilt on the same cycle.
const GOALS_MS = 10 * 60000;
let lastGoals = null;
async function goalsTick() {
  if (config.mod('goalChaser') || config.mod('cacheKeeper')) {
    try {
      lastGoals = await goals.tick({
        spawn: (o) => serialise(() => require('./mobile/newsession').newSession(o)),
        isIdle: () => desktop.isIdle(idleMinMs()),
      });
      if (lastGoals.sent.length || lastGoals.failed.length || lastGoals.spawned.length || lastGoals.done.length) {
        orch.log(`goals: sent ${lastGoals.sent.map(s => s.kind + ' ' + s.sessionId + ' [' + s.goals.join(',') + ']').join('; ') || 'none'}` +
          (lastGoals.failed.length ? `, failed ${lastGoals.failed.map(f => f.sessionId + ' ' + f.error).join('; ')}` : '') +
          (lastGoals.done.length ? `, reports ${lastGoals.done.map(d => d.id + ' ' + d.kind).join(', ')}` : '') +
          (lastGoals.spawned.length ? `, started ${lastGoals.spawned.map(s => s.id + ' -> ' + s.sessionId).join(', ')}` : ''));
      }
    } catch (e) { lastGoals = { at: new Date().toISOString(), error: e.message }; orch.log('goals error: ' + e.message); }
  }
  await hygieneTick();
  if (config.mod('board')) {
    try { const b = await boardBuild.build(); if (!b.written) orch.log('board: ' + b.reason); }
    catch (e) { orch.log('board build error: ' + e.message); }
  }
}

// Context hygiene (lib/hygiene.js): runs inside the goals cycle — index -> goals -> hygiene -> board — but
// only every hygiene.intervalMinutes (30). Report files always; /compact only with module autoCompact, typed
// through the composer inside the UI lane. It also writes the daily wake roll-up and ARCHIVE-CANDIDATES.md.
// Idle-CLI reaper (lib/reaper.js): every 10 min, release the CLI of a session idle 3 h+ that passes every
// guard, through the app's own teardown. Dry for its first 24 h (state/reaper.json), then live.
const REAPER_MS = 10 * 60000;
let lastReaper = null;
async function reaperTick() {
  if (!config.mod('reaper')) return;
  try {
    const r = await require('./lib/reaper').tick();
    lastReaper = { at: r.at, mode: r.mode, clis: r.clis, eligible: r.eligible, reaped: r.reaped, mb: r.mb };
    if (r.reaped || r.eligible) orch.log(`reaper(${r.mode}): ${r.eligible} eligible, ${r.reaped} released, ${r.mb} MB`);
  } catch (e) { lastReaper = { at: new Date().toISOString(), error: e.message }; orch.log('reaper error: ' + e.message); }
}

// Self-update (lib/updater.js): every 10 min ask whether a check is due (update.checkHours); a verified
// newer release is installed by a detached script that stops and restarts this daemon.
const UPDATE_MS = 10 * 60000;
async function updateTick() {
  if (!config.mod('autoUpdate')) return;
  try {
    const r = await require('./lib/updater').tick();
    if (r && r.action) orch.log(`update: ${r.action} ${r.latest || ''}${r.error ? ' — ' + r.error : ''}${r.why ? ' — ' + r.why : ''}`);
  } catch (e) { orch.log('update error: ' + e.message); }
}

let lastHygiene = null;
async function hygieneTick() {
  if (!config.mod('hygiene')) return;
  try {
    const r = await require('./lib/hygiene').cycle({ compact: (id) => serialise(() => require('./lib/hygiene').composerCompact(id)) });
    if (r.skipped) return;
    lastHygiene = r;
    if (!r.ok) return orch.log('hygiene: ' + r.error);
    if (r.compact && (r.compact.sent || r.compact.failed)) orch.log(`hygiene: /compact sent ${r.compact.sent}, failed ${r.compact.failed}` + (r.failures.length ? ' — ' + r.failures.map(f => f.id + ' ' + f.result).join('; ') : ''));
    if (r.newUnverified.length) orch.log(`hygiene: /compact sent but NEVER took (no compaction after the verify window): ${r.newUnverified.join(', ')}`);
  } catch (e) { lastHygiene = { at: new Date().toISOString(), error: e.message }; orch.log('hygiene error: ' + e.message); }
}

// Directives module (lib/directions.js): once a day at settings.directives.runAt, rebuild the owner's
// own words per project from the digests and regenerate each project's DIRECTIVES.md. File work only.
const DIRECTIVES_MS = 10 * 60000;
function directivesTick() {
  if (!config.mod('directives')) return;
  try {
    const r = require('./lib/directions').tick();
    if (r) orch.log(`directives: ${r.ok ? 'ok' : 'FAILED'} — ${r.error ? r.error + ' ' + (r.message || '') : `${r.written} written, ${r.failed} failed`}` +
      ((r.lines || []).filter(l => / (restore-failed|conflict|kept-edited-above|error)\b|^NOTHING/.test(l)).map(l => '; ' + l.trim()).join('')));
  } catch (e) { orch.log('directives error: ' + e.message); }
}

async function organizerTick() {
  if (!config.mod('organizer')) return;
  const index = await indexTick();
  if (!index) return;
  const r = await serialise(() => organizer.tick({ index, isIdle: () => desktop.isIdle(idleMinMs()) }))
    .catch(e => ({ moved: [], failed: [], skipped: 'error: ' + e.message }));
  if (r.moved.length || r.failed.length) {
    orch.log(`organizer: moved ${r.moved.length}, failed ${r.failed.length}` + (r.skipped ? ` (stopped: ${r.skipped})` : '') +
      ' — ' + r.moved.map(m => `${m.sessionId} -> ${m.group}`).join(', '));
  }
}

let lastResume = null;
async function resumeTick() {
  if (!config.mod('autoResume')) return;
  try {
    const r = await resume.tick({ idleMaxWaitMs: 20000 });
    if (r.crash && (r.crash.attempted || []).length || r.limit && (r.limit.attempted || []).length || r.desktop && r.desktop.crashDetected) {
      lastResume = { at: new Date().toISOString(), ...r };
    }
    if (r.desktop && r.desktop.crashDetected) orch.log(`resume: Claude Desktop restarted (new pid ${r.desktop.pid}) — crash path armed`);
    for (const [label, part] of [['crash-resume', r.crash], ['resume', r.limit]]) {
      if (part && part.attempted && part.attempted.length) {
        orch.log(`${label}: ` + part.attempted.map(a => `${a.verdict} ${a.sessionId} "${String(a.title || '').slice(0, 40)}" (${a.mode || a.result} via ${a.via || '?'})`).join('; '));
      }
    }
    if (r.crashError) orch.log('crash-resume error: ' + r.crashError);
    if (r.limitError) orch.log('resume error: ' + r.limitError);
  } catch (e) {
    lastResume = { at: new Date().toISOString(), error: e.message };
    orch.log('resume error: ' + e.message);
  }
}

const INSTANCE = Math.random().toString(36).slice(2, 10);
const startedAt = Date.now();
function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  const stamped = (body && typeof body === 'object' && !Array.isArray(body))
    ? { ...body, _daemon: { pid: process.pid, instance: INSTANCE, uptimeSec: Math.round(process.uptime()), shuttingDown } }
    : body;
  res.end(JSON.stringify(stamped));
}
function readBody(req) {
  return new Promise(r => { let s = ''; req.on('data', c => s += c); req.on('end', () => r(s)); });
}

function claudeAgents() {
  return new Promise(resolve => {
    const worker = require('./lib/worker');
    // A missing CLI must not take the sidebar dots down with it: they come from the Desktop DOM.
    let bin; try { bin = worker.claudeBin(); } catch { return resolve([]); }
    execFile(bin, ['agents', '--json'], { timeout: 20000, windowsHide: true, maxBuffer: 4 << 20 },
      (err, stdout) => {
        if (err) return resolve([]);
        try { resolve(JSON.parse(stdout)); } catch { resolve([]); }
      });
  });
}

let shuttingDown = false;
let inFlight = 0;

const server = http.createServer(async (req, res) => {
  if (shuttingDown) {
    return json(res, 503, { ok: false, error: 'daemon-shutting-down',
      message: 'The Relaymote daemon is restarting and did not start this request. Nothing was done; retry in a few seconds.' });
  }
  inFlight++;
  res.on('close', () => { inFlight--; });
  try {
    const u = new URL(req.url, `http://127.0.0.1:${PORT}`);

    // Loopback programs only: refuses other websites (Origin) and DNS rebinding (Host). lib/control-guard.js
    const refused = require('./lib/control-guard').check(req, PORT);
    if (refused) return json(res, refused.status, refused.body);

    if (req.method === 'GET' && u.pathname === '/') {
      // The control dashboard: submit with a live route preview, per-task stop/escalate, sessions by group.
      let page = HTML;
      try { page = fs.readFileSync(path.join(__dirname, 'lib', 'dashboard.html'), 'utf8').replace(/__APP_PORT__/g, String(Number(config.get().appPort))); } catch {}
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY', 'Cache-Control': 'no-store' });
      return res.end(page);
    }

    if (req.method === 'GET' && u.pathname === '/api/state') {
      const tasks = registry.allTasks();
      const snap = desktop.loadSnapshot();
      return json(res, 200, {
        ok: true,
        summary: orch.summary(),
        tasks,
        desktop: snap ? { at: snap.at, sessions: snap.sessions, groups: snap.groups, active: snap.active } : null,
        desktopError: lastDesktopErr,
        config: orch.CONFIG,
        notify: { last: lastNotify, ...notify.status() },
        resume: { last: lastResume, ...resume.status() },
        ladder: router.LADDER.map(l => l.label),
      });
    }

    if (req.method === 'GET' && u.pathname === '/api/resume') return json(res, 200, { ok: true, last: lastResume, ...resume.status() });
    if (req.method === 'POST' && u.pathname === '/api/resume') {
      const body = JSON.parse(await readBody(req) || '{}');
      const via = body.via === 'composer' ? 'composer' : undefined;
      const opts = { source: body.source || 'api', sessionIds: body.session_ids || body.sessionIds, force: !!body.force,
                     dryRun: !!body.dry_run, idle: body.idle === false ? false : undefined, ui: body.ui === false ? false : undefined,
                     via,
                     idleMaxWaitMs: body.idle_max_wait_ms !== undefined ? Number(body.idle_max_wait_ms) : undefined, message: body.message };
      const fn = body.crash ? () => resume.runCrash({ ...opts, crash: true }) : () => resume.run(opts);
      const out = opts.dryRun ? await fn() : await serialise(fn);
      if (!opts.dryRun) lastResume = { at: new Date().toISOString(), ...out };
      return json(res, out.ok === false && out.error === 'DISABLED' ? 409 : 200, out);
    }
    if (req.method === 'POST' && u.pathname === '/api/goal') {
      const body = JSON.parse(await readBody(req) || '{}');
      const sid = body.session_id || body.sessionId;
      if (!sid) return json(res, 400, { ok: false, error: 'session_id required' });
      const action = String(body.action || (body.condition ? 'set' : 'status')).toLowerCase();
      const HTTP_WAIT_MS = 120000;
      const opts = { dryRun: !!body.dry_run, noQueue: !!body.no_queue,
                     waitMs: body.wait_ms !== undefined ? Number(body.wait_ms) : HTTP_WAIT_MS };
      let fn;
      if (action === 'set') {
        if (!String(body.condition || '').trim()) return json(res, 400, { ok: false, error: 'condition required to set a goal' });
        fn = () => goal.setGoal(sid, body.condition, opts);
      } else if (action === 'status') fn = () => goal.goalStatus(sid, opts);
      else if (action === 'clear')    fn = () => goal.clearGoal(sid, opts);
      else return json(res, 400, { ok: false, error: 'action must be set | status | clear' });
      const out = await serialise(fn);
      return json(res, 200, { ok: out.ok !== false, action, ...out });
    }

    if (req.method === 'POST' && u.pathname === '/api/shutdown') {
      const drainMs = 10000;
      json(res, 200, { ok: true, draining: inFlight, message: `Draining ${inFlight} in-flight request(s), then exiting. Start the scheduled task again once the port is free.` });
      setTimeout(() => shutdown('api'), 50);
      return;
    }

    if (req.method === 'GET' && u.pathname === '/api/await') {
      return json(res, 200, { ok: true, watches: awaits.list({ includeResolved: u.searchParams.get('all') === '1' }) });
    }
    if (req.method === 'POST' && u.pathname === '/api/await') {
      const body = JSON.parse(await readBody(req) || '{}');
      const r = awaits.park({
        masterSessionId: body.master_session_id || body.masterSessionId,
        project: body.project,
        waitingOn: body.waiting_on || body.waitingOn,
        reason: body.reason,
        deadlineMs: body.deadline_ms !== undefined ? Number(body.deadline_ms) : undefined,
      });
      if (r.ok) { try { awaitTick(); } catch {} }
      return json(res, r.ok ? 200 : 400, r);
    }
    if (req.method === 'POST' && u.pathname === '/api/await/cancel') {
      const body = JSON.parse(await readBody(req) || '{}');
      return json(res, 200, awaits.cancel(body.id || body.master_session_id || body.masterSessionId));
    }

    if (req.method === 'POST' && u.pathname === '/api/resume/config') {
      const body = JSON.parse(await readBody(req) || '{}');
      return json(res, 200, { ok: true, config: resume.config(body) });
    }

    if (req.method === 'GET' && u.pathname === '/api/notify') return json(res, 200, { ok: true, ...notify.status(), last: lastNotify });
    if (req.method === 'POST' && u.pathname === '/api/notify/config') {
      const body = JSON.parse(await readBody(req) || '{}');
      try { return json(res, 200, { ok: true, config: notify.setConfig(body) }); }
      catch (e) { return json(res, 400, { ok: false, error: e.message }); }
    }
    if (req.method === 'POST' && u.pathname === '/api/notify/flush') {
      const out = await serialise(() => notify.tick({ force: true }));
      return json(res, 200, { ok: true, ...out });
    }

    if (req.method === 'GET' && u.pathname === '/api/agents') return json(res, 200, { ok: true, agents: await claudeAgents() });

    if (req.method === 'POST' && u.pathname === '/api/task') {
      const body = JSON.parse(await readBody(req) || '{}');
      if (!body.prompt) return json(res, 400, { ok: false, error: 'prompt required' });
      // Settings › New session is the default for every spawn: nothing starts on a model or effort nobody chose.
      const ns = config.get().newSession || {};
      const t = orch.enqueue(body.prompt, {
        title: body.title, cwd: body.cwd, tags: body.tags,
        forceModel: body.model || ns.model || undefined, forceEffort: body.effort || ns.effort || undefined,
        isolate: body.isolate, noReuse: body.noReuse, dependsOn: body.dependsOn,
        dispatch: body.dispatch,
        masterId: body.masterId || null,
        maxAttempts: Number(body.maxAttempts) > 0 ? Number(body.maxAttempts) : undefined,
      });
      Promise.resolve(orch.pump()).catch(e => orch.log('pump error: ' + e.message));
      return json(res, 200, { ok: true, task: t });
    }

    if (req.method === 'POST' && u.pathname === '/api/route-preview') {
      const body = JSON.parse(await readBody(req) || '{}');
      return json(res, 200, { ok: true, decision: router.route(body.prompt || '') });
    }

    if (req.method === 'POST' && u.pathname.startsWith('/api/task/') && u.pathname.endsWith('/stop')) {
      const id = u.pathname.split('/')[3];
      const by = u.searchParams.get('by') || 'unknown caller';
      return json(res, 200, { ok: true, task: await orch.stopTask(id, { by }) });
    }

    if (req.method === 'POST' && u.pathname.startsWith('/api/task/') && u.pathname.endsWith('/escalate')) {
      const id = u.pathname.split('/')[3];
      const t = registry.getTask(id);
      if (!t) return json(res, 404, { ok: false, error: 'no such task' });
      const next = router.escalate(t.model, t.effort);
      if (!next) return json(res, 200, { ok: false, error: 'already at strongest rung' });
      const updated = registry.updateTask(id, {
        status: 'queued', error: null, model: next.model, effort: next.effort, lean: false,
        resumeSessionId: null,
        escalations: (t.escalations || []).concat([{ from: { model: t.model, effort: t.effort }, to: next, reason: 'manual', at: new Date().toISOString() }]),
      });
      Promise.resolve(orch.pump()).catch(e => orch.log('pump error: ' + e.message));
      return json(res, 200, { ok: true, task: updated });
    }

    if (req.method === 'POST' && u.pathname === '/api/prune') {
      return json(res, 200, { ok: true, removed: registry.prune(Number(u.searchParams.get('days') || 14)) });
    }

    if (req.method === 'GET' && (u.pathname === '/open' || u.pathname === '/api/open')) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      const sid = String(u.searchParams.get('session') || '').trim();
      if (!/^local_[0-9a-f-]{36}$/i.test(sid)) {
        return json(res, 400, { ok: false, error: 'BAD_SESSION_ID', got: sid.slice(0, 60),
          message: 'Pass ?session=local_<uuid>.' });
      }
      let conn = null;
      try {
        conn = await desktop.connect(await desktop.wsUrl());
        const CID = await desktop.pickChat(conn);
        if (desktop.knownToApp && !(await desktop.knownToApp(conn, CID, sid))) {
          return json(res, 404, { ok: false, error: 'NO_SUCH_SESSION', sessionId: sid });
        }
        const ok = await desktop.navTo(conn, CID, sid, 4000, { idle: false });
        return json(res, ok ? 200 : 502, { ok, sessionId: sid,
          message: ok ? 'Opened in Claude Desktop.' : 'Could not open it; the app did not land on that session.' });
      } catch (e) {
        return json(res, 500, { ok: false, error: 'OPEN_FAILED', message: e.message });
      } finally { try { if (conn) conn.close(); } catch {} }
    }

    if (req.method === 'GET' && u.pathname === '/api/health') {
      return json(res, 200, {
        ok: true, app: 'relaymote', port: PORT, pid: process.pid,
        cdp: lastCdpOk,
        cdpCheckedSecAgo: lastCdpAt ? Math.round((Date.now() - lastCdpAt) / 1000) : null,
        uptimeSec: Math.round(process.uptime()),
        lastDesktopTickSecAgo: lastDesktopAt ? Math.round((Date.now() - lastDesktopAt) / 1000) : null,
        summary: orch.summary(),
        build: (() => { try { return require('./mobile').buildReport(); } catch { return null; } })(),
      });
    }

    json(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    json(res, 500, { ok: false, error: e.message });
  }
});

const HTML = '<!doctype html><meta charset=utf-8><title>Relaymote</title><body style="font:15px system-ui;padding:2rem">Relaymote control API. Open the app: run <code>relaymote open</code>.</body>';

function probeExisting() {
  return new Promise(resolve => {
    const req = http.get(`http://127.0.0.1:${PORT}/api/health`, { timeout: 3000 }, res => {
      let s = ''; res.on('data', c => s += c);
      res.on('end', () => { try { resolve(JSON.parse(s).ok === true); } catch { resolve(false); } });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

let evictedWedged = false;
async function evictWedgedHolder(reason) {
  if (evictedWedged) return false;
  if (await probeExisting()) return false;
  let holder = null;
  try { holder = heal.portHolder(PORT); } catch {}
  if (!holder || holder === process.pid) return false;
  evictedWedged = true;
  orch.log(`port ${PORT} held by pid ${holder} which fails /api/health — wedged (${reason}); evicting it`);
  let killed = false;
  try { killed = heal.killPid(holder); } catch {}
  orch.log(killed ? `killed wedged holder pid ${holder}; taking over` : `could not kill wedged holder pid ${holder}`);
  return killed;
}

(async () => {
  if (await probeExisting()) {
    orch.log(`daemon already healthy on ${PORT} — this watchdog run exits (pid ${process.pid})`);
    process.exit(0);
  }
  await evictWedgedHolder('startup probe');

  server.on('error', async e => {
    if (e && e.code === 'EADDRINUSE') {
      if (await probeExisting()) { orch.log(`port ${PORT} taken by a healthy instance — exiting cleanly`); process.exit(0); }
      const took = await evictWedgedHolder('EADDRINUSE');
      if (took) { orch.log('rebinding after evicting the wedged holder'); setTimeout(() => { try { server.listen(PORT, '127.0.0.1'); } catch {} }, 1500); return; }
      orch.log(`port ${PORT} held and could not be taken over — exiting cleanly`); process.exit(0);
    }
    orch.log('server error: ' + (e && e.stack || e));
    process.exit(1);
  });

  let started = false;
  function reportPreviousExit() {
    const f = path.join(registry.STATE_DIR, 'daemon-exit.json');
    let prev = null;
    try { prev = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
    try { fs.unlinkSync(f); } catch {}
    if (prev && prev.clean) {
      orch.log(`start: previous exit was a CLEAN shutdown at ${prev.at} via ${prev.signal} (that was pid ${prev.pid}); now running as pid ${process.pid}`);
      return;
    }
    if (prev && prev.selfExit) {
      orch.log(`start: previous exit was the process EXITING ITSELF with code ${prev.code} at ${prev.at} (pid ${prev.pid}, up ${prev.uptimeSec}s, rss ${prev.rssMb}MB) — not graceful, but not an outside kill either; now running as pid ${process.pid}`);
      try {
        notify.pushEvent({
          key: `daemon-restart:${INSTANCE}`, kind: 'daemon-restart', source: 'daemon',
          line: `Relaymote daemon restarted: the previous process (pid ${prev.pid}) EXITED ITSELF with code ${prev.code} after ${prev.uptimeSec}s, using ${prev.rssMb}MB. Now pid ${process.pid}. Check relaymote.log around ${prev.at} for what led to it; relaymote_await watches and the notify queue both survived.`,
        });
      } catch {}
      return;
    }
    function lastTaskExitCode() {
      try {
        const ps = "$e = Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-TaskScheduler/Operational'; Id=201; StartTime=(Get-Date).AddMinutes(-10)} -EA SilentlyContinue | " +
                   "Where-Object { $_.Message -like '*Relaymote*' } | Select-Object -First 1; " +
                   "if ($e -and $e.Message -match 'return code (-?\\d+)') { $matches[1] } else { '' }";
        const out = require('child_process').execFileSync('powershell',
          ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 8000, windowsHide: true, encoding: 'utf8' });
        return String(out || '').trim() || null;
      } catch { return null; }
    }

    function recentlyDeployed() {
      const dirs = [__dirname, path.join(__dirname, 'lib'), path.join(__dirname, 'mcp'), path.join(__dirname, 'scripts')];
      let newest = 0, which = null;
      for (const d of dirs) {
        let names = [];
        try { names = fs.readdirSync(d); } catch { continue; }
        for (const n of names) {
          if (!/\.(js|cmd|ps1)$/.test(n)) continue;
          try {
            const m = fs.statSync(path.join(d, n)).mtimeMs;
            if (m > newest) { newest = m; which = path.join(d, n); }
          } catch {}
        }
      }
      const ageSec = newest ? Math.round((Date.now() - newest) / 1000) : null;
      return { ageSec, which, likely: ageSec !== null && ageSec < 300 };
    }

    const code = lastTaskExitCode();
    const dep = recentlyDeployed();
    const stoppedByRequest = code === '2147943691';
    const AGOLOG = path.join(registry.STATE_DIR, 'relaymote.log');
    const STDIO = path.join(registry.STATE_DIR, 'daemon-stdio.log');

    const why = stoppedByRequest
      ? `the task engine terminated it because somebody ran Stop-ScheduledTask (event 201 return code ${code} = 0x8007050B, which is always paired with event 330)`
      : code === '0'
        ? 'the task engine recorded a clean return code 0, so the process ended on its own even though it left no marker'
        : code
          ? `the task engine recorded return code ${code}, which is neither the stop code nor a clean 0 — this one is worth reading`
          : 'the task engine had no return code to give (no event 201 for this task in the last 10 minutes)';
    const deployNote = dep.likely
      ? ` The daemon's own files changed ${dep.ageSec}s ago (${dep.which}), so this is very likely a deploy.`
      : '';

    orch.log(`start: previous exit left no marker — ${why}.${deployNote} Now running as pid ${process.pid}`);

    if (stoppedByRequest && dep.likely) {
      orch.log('start: not notifying — a deliberate stop plus a fresh deploy explains this completely');
    } else {
      try {
        notify.pushEvent({
          key: `daemon-restart:${INSTANCE}`, kind: 'daemon-restart', source: 'daemon',
          line: `Relaymote daemon restarted (now pid ${process.pid}). Cause: ${why}.${deployNote}` +
                ` Read ${AGOLOG} around that time; node's own dying output, when there is any, is in ${STDIO}.` +
                ` To check yourself: Get-WinEvent -LogName Microsoft-Windows-TaskScheduler/Operational | Where-Object { $_.Message -like '*Relaymote*' } | Select-Object TimeCreated,Id -First 20` +
                ` — 330 = stopped by request, 111 = terminated, 110 = started by request, 107 = time trigger, 322 = skipped because already running.` +
                ` relaymote_await watches and the notify queue both survived; only work in flight was lost.`,
        });
      } catch {}
    }
  }

  server.listen(PORT, '127.0.0.1', () => {
    if (started) return;
    started = true;
    orch.log(`Relaymote daemon on http://127.0.0.1:${PORT} (pid ${process.pid})`);
    reportPreviousExit();
    try { fs.unlinkSync(path.join(registry.STATE_DIR, 'follow-sleep.json')); } catch {}   // awake again
    Promise.resolve(orch.recover())
      .then(r => orch.log(`startup recovery: ${JSON.stringify(r)}`))
      .catch(e => orch.log('startup recovery failed: ' + e.message))
      .then(() => serialise(refreshDesktop))
      .then(() => serialise(notifyTick));
    setInterval(() => { if (config.mod('orchestrator')) Promise.resolve(orch.pump()).catch(e => orch.log('pump error: ' + e.message)); }, PUMP_MS);
    setInterval(() => serialise(refreshDesktop), DESKTOP_MS);
    setInterval(() => serialise(notifyTick), NOTIFY_MS);
    setInterval(() => serialise(resumeTick), RESUME_MS);
    setInterval(() => serialise(chipwatchTick), CHIPWATCH_MS);
    setInterval(() => serialise(uiQueueTick), 45000);
    setInterval(() => serialise(debuggerTick), 60000);
    setInterval(() => { follow.tick().catch(e => orch.log('follow Claude: ' + e.message)); }, 5000);
    setInterval(() => { if (config.mod('accounts')) require('./lib/account-sync').autoTick().then(r => { if (r && (r.applied || r.error)) orch.log('accounts auto-sync: ' + (r.error || r.applied + ' change(s) written')); }).catch(e => orch.log('accounts auto-sync: ' + e.message)); }, 15000);
    // Boot window: Desktop not running yet when Relaymote starts -> the pass that waits for a closed Desktop runs now.
    if (config.mod('accounts')) require('./lib/account-sync').bootPass().then(r => { if (r && (r.applied || r.error)) orch.log('accounts boot pass: ' + (r.error || (r.applied.count || 0) + ' change(s) written')); }).catch(e => orch.log('accounts boot pass: ' + e.message));
    setTimeout(() => serialise(resumeTick), 20000);
    setInterval(() => { if (!config.mod('organizer')) indexTick(); }, INDEX_MS);
    setInterval(organizerTick, ORGANIZE_MS);
    setTimeout(() => (config.mod('organizer') ? organizerTick() : indexTick()), 90000);
    setInterval(goalsTick, GOALS_MS);
    setTimeout(goalsTick, 120000);
    setInterval(directivesTick, DIRECTIVES_MS);
    setInterval(() => serialise(reaperTick), REAPER_MS);
    setInterval(updateTick, UPDATE_MS);
    setTimeout(updateTick, 3 * 60000);
    // Straight after an update: record it, remove the one-shot task, bring the tray back (lib/updater.js landed()).
    setTimeout(() => { try { if (config.mod('autoUpdate')) require('./lib/updater').landed(); } catch (e) { orch.log('update landed: ' + e.message); } }, 30000);

    try {
      if (config.mod('app')) require('./mobile')();
      else orch.log('app module is off (Settings > Modules)');
    } catch (e) {
      orch.log('mobile layer failed to start: ' + (e && e.stack || e));
    }
  });
})();

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    fs.writeFileSync(path.join(registry.STATE_DIR, 'daemon-exit.json'),
      JSON.stringify({ at: new Date().toISOString(), clean: true, signal, pid: process.pid, instance: INSTANCE }));
  } catch {}
  orch.log(`shutdown on ${signal}: draining ${inFlight} in-flight request(s)`);
  try { server.close(); } catch {}
  const deadline = Date.now() + 10000;
  const tick = setInterval(() => {
    if (inFlight <= 0 || Date.now() > deadline) {
      clearInterval(tick);
      orch.log(`shutdown complete (${inFlight} still in flight)`);
      process.exit(0);
    }
  }, 200);
  if (tick.unref) tick.unref();
}
for (const sig of ['SIGTERM', 'SIGINT', 'SIGBREAK']) {
  try { process.on(sig, () => shutdown(sig)); } catch {}
}

process.on('exit', code => {
  try {
    const f = path.join(registry.STATE_DIR, 'daemon-exit.json');
    if (fs.existsSync(f)) return;
    const m = process.memoryUsage();
    fs.writeFileSync(f, JSON.stringify({
      at: new Date().toISOString(), clean: false, selfExit: true, code,
      pid: process.pid, instance: INSTANCE, uptimeSec: Math.round(process.uptime()),
      rssMb: Math.round(m.rss / 1048576), heapMb: Math.round(m.heapUsed / 1048576),
    }));
  } catch {}
});

setInterval(() => {
  const m = process.memoryUsage();
  orch.log(`heartbeat: uptime ${Math.round(process.uptime())}s rss ${Math.round(m.rss / 1048576)}MB heap ${Math.round(m.heapUsed / 1048576)}/${Math.round(m.heapTotal / 1048576)}MB`);
}, 10 * 60 * 1000).unref();

process.on('uncaughtException', e => {
  if (e && e.code === 'EADDRINUSE') { orch.log('EADDRINUSE — exiting cleanly'); process.exit(0); }
  orch.log('uncaught: ' + (e && e.stack || e));
});
process.on('unhandledRejection', e => orch.log('unhandled: ' + (e && e.message || e)));
