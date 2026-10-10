'use strict';
// heal.js — diagnose and repair the Relaymote stack: Claude Desktop's debugger, the daemon, the autostart
// that brings it back, the task registry, and the CLI's sign-in.
//
// Every outside probe (HTTP, PowerShell, the registry, the platform) goes through `probes`, so the
// checks can be exercised offline with stubs (test/core.js) instead of against a live machine.
const http = require('http');
const path = require('path');
const fs = require('fs');
const { execFile, execFileSync } = require('child_process');

const config = require('./config');
const port = () => config.get().port;
const cdpPort = () => config.get().cdpPort;
const SCRIPTS = path.join(config.ROOT, 'scripts');
const TASK = 'Relaymote', WATCHDOG = 'Relaymote Watchdog';
const RUNKEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';

const sleep = ms => new Promise(r => setTimeout(r, probes.sleepScale() * ms));

function httpJson(url, timeoutMs = 6000) {
  return new Promise(resolve => {
    const req = http.get(url, res => {
      let s = ''; res.on('data', c => s += c);
      res.on('end', () => { try { resolve({ ok: true, body: JSON.parse(s) }); } catch { resolve({ ok: false, error: 'bad json' }); } });
    });
    req.on('error', e => resolve({ ok: false, error: e.code || e.message }));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
  });
}
const ps = (command, timeout = 30000) => execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', command],
  { timeout, windowsHide: true, encoding: 'utf8' });

// { state, lastResult } for a scheduled task, null when it does not exist. Throws when it cannot ask.
function queryTask(name) {
  const out = ps(`$t=Get-ScheduledTask -TaskName "${name}" -EA SilentlyContinue; $i=Get-ScheduledTaskInfo -TaskName "${name}" -EA SilentlyContinue; if($t){"$($t.State)|$($i.LastTaskResult)|$($t.Principal.LogonType)"}else{"MISSING||"}`).trim();
  const [state, lastResult, logonType] = out.split('|');
  return state === 'MISSING' ? null : { state, lastResult, logonType };
}
function runKeyValue() {
  try {
    const out = execFileSync('reg', ['query', RUNKEY, '/v', TASK], { timeout: 10000, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const m = out.match(/REG_SZ\s+(.+)/);
    return m ? m[1].trim() : null;
  } catch { return null; }
}

const probes = {
  platform: () => process.platform,
  httpJson,
  queryTask,
  runKeyValue,
  autostartRecord: () => { try { return JSON.parse(fs.readFileSync(path.join(config.STATE, 'autostart.json'), 'utf8')); } catch { return null; } },
  ps,
  sleepScale: () => 1,
};
/** Replace probes (tests). Returns the previous set so a test can restore it. */
function _setProbes(p) { const prev = { ...probes }; Object.assign(probes, p || {}); return prev; }

async function confirmWedged(log) {
  const first = await checkDaemon();
  if (first.healthy) return first;
  if (log) log.push(`daemon missed one health check (${first.detail}) — re-checking before touching it`);
  await sleep(4000);
  const second = await checkDaemon();
  if (second.healthy && log) log.push('daemon answered on the second check — it was busy, not wedged; leaving it alone');
  return second;
}

const DAEMON_HEALTH_TIMEOUT_MS = Number(process.env.RELAYMOTE_HEAL_HEALTH_TIMEOUT_MS ?? 25000);

async function checkDaemon() {
  const r = await probes.httpJson(`http://127.0.0.1:${port()}/api/health`, DAEMON_HEALTH_TIMEOUT_MS);
  // app:'relaymote' — another program answering /api/health on our port is not our daemon.
  return r.ok && r.body && r.body.ok && (r.body.app === undefined || r.body.app === 'relaymote')
    ? { name: 'daemon', healthy: true, detail: `up on ${port()} (pid ${r.body.pid}, uptime ${r.body.uptimeSec}s)` }
    : { name: 'daemon', healthy: false, detail: `not responding on ${port()}: ${r.error || (r.body && r.body.app ? 'another program (' + r.body.app + ') holds the port' : 'unhealthy')}`, fixable: true };
}

async function checkCdp() {
  const r = await probes.httpJson(`http://127.0.0.1:${cdpPort()}/json`, 4000);
  return r.ok
    ? { name: 'cdp', healthy: true, detail: `Claude main-process debugger up on ${cdpPort()}` }
    : { name: 'cdp', healthy: false, detail: `debugger not reachable on ${cdpPort()}: ${r.error}`, fixable: true };
}

function checkAuth() {
  let bin;
  try { bin = require('./worker').claudeBin(); }
  catch (e) { return { name: 'auth', healthy: false, detail: 'claude CLI not found: ' + e.message, fixable: false }; }

  const workerEnv = { ...process.env, CLAUDE_CONFIG_DIR: config.AUTH };
  delete workerEnv.CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH;
  delete workerEnv.CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH;

  let statusRaw = null;
  try {
    statusRaw = execFileSync(bin, ['auth', 'status'],
      { timeout: 45000, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: workerEnv });
  } catch (e) { statusRaw = (e && e.stdout) ? String(e.stdout) : null; }

  try {
    const st = statusRaw ? JSON.parse(statusRaw) : null;
    if (st && st.loggedIn === false) {
      return {
        name: 'auth', healthy: false, fixable: false, needsHuman: true,
        detail: `The CLI is NOT logged in (authMethod: ${st.authMethod || 'none'}). Claude Desktop being signed in is a SEPARATE credential store and does not help — every Relaymote worker spawns the standalone CLI, so all of them fail with 0 tokens.`,
        remedy: 'Run `claude auth login` in a terminal and complete the browser sign-in. Relaymote cannot do this for you and must never handle your credentials.',
        credentialsFile: path.join(config.CLAUDE_HOME, '.credentials.json'),
      };
    }
    if (st && st.loggedIn) return { name: 'auth', healthy: true, detail: `CLI logged in (${st.authMethod || 'oauth'}, ${st.apiProvider || 'firstParty'})` };
  } catch { }

  if (process.env.ANTHROPIC_API_KEY) {
    return { name: 'auth', healthy: false, needsHuman: true, fixable: false,
             detail: 'ANTHROPIC_API_KEY is set — workers would bill the PAID API instead of the Max subscription. Unset it.' };
  }
  let raw = null;
  try {
    raw = execFileSync(bin, ['-p', 'ok', '--model', 'haiku', '--effort', 'low',
      '--output-format', 'json', '--permission-mode', 'bypassPermissions'],
      { timeout: 90000, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    raw = (e && e.stdout) ? String(e.stdout) : null;
    if (!raw) {
      return { name: 'auth', healthy: false, fixable: false,
               detail: 'auth probe produced no output: ' + String(e.message || '').slice(0, 140) };
    }
  }

  let j = null;
  try { j = JSON.parse(raw); } catch {
    return { name: 'auth', healthy: false, fixable: false, detail: 'auth probe output was not JSON: ' + raw.slice(0, 140) };
  }

  if (j.is_error || (j.usage && j.usage.input_tokens === 0 && j.usage.output_tokens === 0)) {
    const msg = String(j.result || j.error || '') + ' ' + String(raw).slice(0, 400);
    const expired = /authenticat|oauth|expired|log ?in|sign ?in|unauthor/i.test(msg);
    return {
      name: 'auth', healthy: false, fixable: false, needsHuman: expired,
      detail: expired
        ? 'OAuth session EXPIRED — every worker fails with 0 tokens until you sign in again. This is almost certainly why tasks started failing.'
        : 'CLI returned an error: ' + String(j.result || '').slice(0, 160),
      remedy: expired
        ? 'Sign in again in Claude Desktop (or run `claude` in a terminal and complete the login). Relaymote cannot do this for you and must never handle your credentials.'
        : undefined,
    };
  }
  return { name: 'auth', healthy: true, detail: `OAuth subscription auth working (${j.usage.output_tokens} output tokens)` };
}

function checkRegistry() {
  try {
    const registry = require('./registry');
    const all = registry.allTasks();
    const stuck = all.filter(t => t.status === 'running');
    return {
      name: 'registry', healthy: true,
      detail: `${all.length} task(s) tracked; ${stuck.length} marked running`,
      stuckCount: stuck.length,
    };
  } catch (e) {
    return { name: 'registry', healthy: false, fixable: false, detail: 'registry unreadable: ' + e.message };
  }
}

/**
 * What starts Relaymote at sign-in and brings it back — as INSTALLED, not as assumed. `relaymote autostart`
 * sets up either the "Relaymote" logon task or (without admin rights) the per-user Run key, plus a
 * "Relaymote Watchdog" task every 10 minutes. Not having autostart at all is a choice, not a fault —
 * unless the record says it was installed and it is gone now.
 */
function checkScheduledTask() {
  const name = 'scheduledTask';
  if (probes.platform() !== 'win32') {
    return { name, healthy: true, skipped: true, method: 'none',
             detail: 'autostart is not managed on this platform (use launchd / systemd --user with scripts/run-daemon.sh)' };
  }
  let task, wd;
  try { task = probes.queryTask(TASK); wd = probes.queryTask(WATCHDOG); }
  catch (e) { return { name, healthy: false, fixable: false, detail: 'could not query scheduled tasks: ' + String(e.message).slice(0, 120) }; }
  const runKey = probes.runKeyValue();
  const rec = probes.autostartRecord();
  const wdText = wd ? `watchdog task every 10 min (${wd.state})` : 'no watchdog task — only the tray\'s 20-second health poll restarts the daemon';
  if (task) {
    return { name, healthy: true, method: 'task', state: task.state, lastResult: task.lastResult, watchdog: !!wd,
             detail: `task "${TASK}" state=${task.state} lastResult=${task.lastResult}${task.logonType ? ' logon=' + task.logonType : ''}; ${wdText}` };
  }
  if (runKey) {
    return { name, healthy: true, method: 'runkey', watchdog: !!wd,
             detail: `starts at sign-in from the per-user Run key (no admin needed); ${wdText}` };
  }
  if (wd) return { name, healthy: true, method: 'watchdog-only', watchdog: true, detail: `no sign-in start, but ${wdText} will start Relaymote` };
  if (rec && rec.ok && rec.action === 'install') {
    return { name, healthy: false, fixable: false, method: 'missing',
             detail: `autostart was installed (${rec.logon || '?'} at ${rec.at || '?'}) but neither the "${TASK}" task nor the Run key exists now. Run \`relaymote autostart\` again.` };
  }
  return { name, healthy: true, method: 'none', detail: 'autostart is not set up (optional: `relaymote autostart`)' };
}

function portHolder(p) {
  try {
    const out = probes.ps(`(Get-NetTCPConnection -LocalPort ${Number(p)} -State Listen -EA SilentlyContinue | Select-Object -First 1).OwningProcess`, 20000).trim();
    const pid = parseInt(out, 10);
    return Number.isFinite(pid) ? pid : null;
  } catch { return null; }
}

// Only ever kill Relaymote's own daemon: the port may be held by an unrelated program.
function isRelaymoteProcess(pid) {
  try {
    const cmd = probes.platform() === 'win32'
      ? probes.ps(`(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`, 20000)
      : execFileSync('ps', ['-o', 'command=', '-p', String(Number(pid))], { timeout: 5000, encoding: 'utf8' });
    const norm = x => String(x || '').split(path.sep).join('/').replace(/\\/g, '/').toLowerCase();
    return norm(cmd).includes(norm(path.join(config.ROOT, 'server.js')));
  } catch { return false; }
}

function killPid(pid) {
  if (!isRelaymoteProcess(pid)) return false;
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 20000, windowsHide: true, stdio: 'ignore' });
    else process.kill(Number(pid), 'SIGKILL');
    return true;
  } catch { return false; }
}

async function repairDaemon(log) {
  const holder = portHolder(port());
  if (holder) {
    const h = await confirmWedged(log);
    if (!h.healthy) {
      log.push(`port ${port()} is held by pid ${holder} but it fails health checks — wedged; evicting it`);
      if (killPid(holder)) { log.push(`killed wedged holder pid ${holder}`); await sleep(2000); }
      else log.push(`did not kill pid ${holder} (not Relaymote's own daemon, or needs elevation) — free port ${port()} or change it in Settings`);
    }
  }
  // A repair is an explicit request to have Relaymote running, so it overrides "you stopped Relaymote".
  try { require('./launch').clearStopped(); } catch {}

  const auto = probes.platform() === 'win32' ? checkScheduledTask() : { method: 'none' };
  if (auto.method === 'task') {
    try { probes.ps(`Stop-ScheduledTask -TaskName "${TASK}" -EA SilentlyContinue`); log.push('stopped any existing (possibly zombie) scheduled-task instance'); } catch {}
    await sleep(2500);
    try { probes.ps(`Start-ScheduledTask -TaskName "${TASK}"`); log.push('started the Relaymote scheduled task (it runs the tray, which starts the daemon)'); }
    catch (e) { log.push('scheduled task start failed: ' + String(e.message).slice(0, 80)); }
    for (let i = 0; i < 8; i++) {
      await sleep(2000);
      const r = await checkDaemon();
      if (r.healthy) { log.push('daemon confirmed healthy via scheduled task: ' + r.detail); return true; }
    }
    log.push('task did not yield a live daemon (it can report success while the process exits) — starting the daemon directly');
  } else {
    log.push(`no "${TASK}" logon task (${auto.method || 'none'}) — starting the daemon directly`);
  }
  try {
    const s = require('./launch').spawnDaemon();
    log.push(`started the daemon through ${path.basename(s.wrapper)} (pid ${s.pid}); its stderr goes to ${s.log}`);
  } catch (e2) { log.push('direct start failed: ' + e2.message); return false; }

  for (let i = 0; i < 10; i++) {
    await sleep(2000);
    const r = await checkDaemon();
    if (r.healthy) { log.push('daemon confirmed healthy after direct start: ' + r.detail); return true; }
  }
  log.push('daemon still not responding after both strategies — read ' + require('./launch').logFile());
  return false;
}

// What each enable-debugger.ps1 exit code means, in words for the app. 8 and 9 are Windows' own
// boundary: it does not deliver simulated clicks to a disconnected or locked session.
const DEBUGGER_REASONS = {
  0: 'Claude\'s debugger is on.',
  1: 'Claude Desktop is not running on the computer. Open it, then try again.',
  2: 'Claude Desktop\'s window was not ready (its Menu button was not found). Try again in a few seconds.',
  3: 'Claude Desktop has no Developer menu. Turn on Developer Mode (Help › Troubleshooting › Enable Developer Mode), restart Claude Desktop, then try again.',
  4: 'The Developer menu has no "Enable Main Process Debugger" item. Use the steps below.',
  5: 'The menu item was clicked, but the debugger did not start. Use the steps below.',
  6: 'The debugger started and then stopped again. Try once more.',
  7: 'Windows would not let Relaymote bring Claude Desktop to the front (focus-stealing protection). Click on the Claude window once, then try again.',
  8: 'Blocked by Windows: the computer\'s session is disconnected (Remote Desktop is closed), and Windows does not deliver clicks to a disconnected session. Connect to the computer, then try again; Relaymote also does it by itself when you reconnect.',
  9: 'Blocked by Windows: the computer is locked, and Windows does not deliver clicks behind the lock screen. Unlock it, then try again; Relaymote also does it by itself once it is unlocked.',
  10: 'Claude Desktop is not signed in yet. Sign in; Relaymote then turns the debugger on by itself.',
  11: 'Dry run finished: every step reached the menu item; nothing was clicked.',
  12: 'You kept using the computer during the countdown, so Relaymote held off. It tries again in a minute.',
};
/** Run the macro once. Always resolves to { ok, code, message, detail } — never a silent no-op. */
function enableDebugger({ countdown = 3 } = {}) {
  const macro = process.env.RELAYMOTE_DEBUGGER_MACRO || path.join(SCRIPTS, 'enable-debugger.ps1');   // env: test seam
  if (process.platform !== 'win32') return Promise.resolve({ ok: false, code: -1, message: 'Turning the debugger on automatically is Windows-only. Follow the steps shown.' });
  if (!fs.existsSync(macro)) return Promise.resolve({ ok: false, code: -1, message: 'Relaymote\'s enable-debugger.ps1 is missing from its install folder. Reinstall Relaymote.' });
  // g1662: execFile's timeout only fires its callback once every pipe has closed, so a run that outlives it
  // can still hold its caller for minutes. A hard deadline kills the whole tree and answers regardless.
  return new Promise(resolve0 => {
    const t0 = Date.now(); let done = false, child = null;
    const resolve = r => { if (done) return; done = true; clearTimeout(hard); resolve0({ ...r, ms: Date.now() - t0 }); };
    const hard = setTimeout(() => {
      if (child && child.pid) execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
      resolve({ ok: false, code: -2, message: 'The switch-on took longer than 75 seconds and was stopped.', detail: '' });
    }, 75000);
    if (hard.unref) hard.unref();
    child = execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', macro, '-Port', String(cdpPort()), '-Countdown', String(countdown)],
      { timeout: 60000, windowsHide: true }, (err, stdout, stderr) => {
        const lines = String(stdout || '').trim().split(/\r?\n/).filter(Boolean);
        const detail = lines[lines.length - 1] || String(stderr || '').trim().split(/\r?\n/)[0] || '';
        const code = err ? (typeof err.code === 'number' ? err.code : (err.killed ? -2 : -3)) : 0;
        const message = DEBUGGER_REASONS[code] ||
          (code === -2 ? 'The switch-on took longer than a minute and was stopped.' : 'The switch-on script failed: ' + (detail || (err && err.message) || 'no output').slice(0, 160));
        resolve({ ok: code === 0, code, message, detail });
      });
  });
}

async function repairCdp(log) {
  const r = await enableDebugger();
  log.push(`enable-debugger.ps1 exit ${r.code}: ${r.detail || r.message}`);
  if (!r.ok) return false;
  for (let i = 0; i < 6; i++) {
    const c = await checkCdp();
    if (c.healthy) { log.push('debugger confirmed up'); return true; }
    await sleep(500);
  }
  log.push('the port is open but Relaymote cannot reach the debugger yet');
  return false;
}

function repairStuckTasks(log) {
  try {
    const worker = require('./worker');
    const r = worker.reconcile();
    log.push(`reconciled tasks: ${r.recovered} completed-while-down, ${r.failed} failed, ${r.stillRunning} genuinely running`);
    return true;
  } catch (e) { log.push('reconcile failed: ' + e.message); return false; }
}

/**
 * The ZOMBIE state: the "Relaymote" task says Running (the tray it launched is still alive, or wedged)
 * while nothing answers on the control port. Its MultipleInstances=IgnoreNew setting makes Windows
 * skip every new start while that instance lives, so the task will not bring the daemon back by itself;
 * the tray retries every 20 seconds only if it is healthy, and it was not. heal stops and restarts it.
 */
function zombie(taskCheck, daemonCheck) {
  if (!(taskCheck.healthy && taskCheck.method === 'task' && taskCheck.state === 'Running' && !daemonCheck.healthy)) return taskCheck;
  return { ...taskCheck, healthy: false, fixable: true,
    detail: `ZOMBIE: task "${TASK}" state=Running but nothing answers on ${port()}. The task runs the tray with IgnoreNew, so while this stuck instance lives Windows skips every new start and the task will not bring the daemon back by itself; the tray's own 20-second restart has evidently not worked either. (lastResult=${taskCheck.lastResult})` };
}

async function heal(opts = {}) {
  const repair = opts.repair !== false;
  const log = [];
  const checks = [];

  checks.push(await checkCdp());
  const daemonCheck = await checkDaemon();
  checks.push(daemonCheck);
  checks.push(zombie(checkScheduledTask(), daemonCheck));
  checks.push(checkRegistry());
  if (!opts.skipAuth) checks.push(checkAuth());

  if (repair) {
    const cdp = checks.find(c => c.name === 'cdp');
    if (cdp && !cdp.healthy) { await repairCdp(log); }

    const daemon = checks.find(c => c.name === 'daemon');
    if (daemon && !daemon.healthy) { await repairDaemon(log); }

    const reg = checks.find(c => c.name === 'registry');
    if (reg && reg.stuckCount > 0) { repairStuckTasks(log); }

    const d2 = await checkDaemon();
    const after = [await checkCdp(), d2, zombie(checkScheduledTask(), d2), checkRegistry()];
    for (const a of after) {
      const i = checks.findIndex(c => c.name === a.name);
      if (i >= 0 && a) checks[i] = a;
    }
  }

  const broken = checks.filter(c => !c.healthy);
  const needsHuman = broken.filter(c => c.needsHuman);
  return {
    healthy: broken.length === 0,
    status: broken.length === 0 ? 'HEALTHY'
      : needsHuman.length ? 'NEEDS_HUMAN'
      : 'DEGRADED',
    checks,
    repairsAttempted: repair ? log : ['(diagnosis only — repair was not requested)'],
    blockedOn: needsHuman.map(c => ({ check: c.name, detail: c.detail, remedy: c.remedy })),
    summary: broken.length === 0
      ? 'Relaymote is fully operational.'
      : `${broken.length} problem(s): ${broken.map(c => c.name).join(', ')}` +
        (needsHuman.length ? ' — at least one needs the user and cannot be repaired automatically.' : ''),
  };
}

module.exports = { heal, repairCdp, enableDebugger, DEBUGGER_REASONS, repairDaemon, checkDaemon, checkCdp, checkAuth, checkRegistry, checkScheduledTask, zombie,
  portHolder, killPid, isRelaymoteProcess, _setProbes, TASK, WATCHDOG };
