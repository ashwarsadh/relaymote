// presence.js — is Claude Desktop running, for THIS user, right now?
//
// States:
//   live          a main process with children: Desktop is up
//   launching     a childless main younger than the grace period, or a child with no main
//   orphans-only  only childless mains older than the grace period (a quit can leave one behind)
//   absent        no Desktop process at all
//   unknown       the probe failed: callers must write NOTHING
//
// Counting processes by name is not enough: a quit can leave an orphaned main process behind for
// good, and during a launch the main exists a second before its children do. Age tells the two
// apart. On Windows the probe is limited to our own logon session (a shared machine can run other
// users' Desktops, with their own profiles), and a Desktop process in our session whose path
// cannot be read makes the answer 'unknown' rather than being dropped from the count.
//
// Windows: tested. macOS: written against the documented bundle layout, UNTESTED.
'use strict';
const { execFile } = require('child_process');

const LAUNCH_GRACE_SECONDS = 60;
// One probe costs seconds on Windows (PowerShell + a process enumeration) while the window it
// guards, between Desktop exiting or Relaymote starting and Desktop starting, can be ~10 s. So a
// display or "is a pass worth starting?" question may reuse an answer for 2 s; the check that
// PERMITS a write always asks again (fresh: true).
const CACHE_TTL_MS = 2000;

const PS = `
$me = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
$procs = @(Get-CimInstance Win32_Process -Filter "Name='claude.exe'" |
  Where-Object { $_.SessionId -eq $me } |
  Where-Object { $_.ExecutablePath -like '*AnthropicClaude*' -or $_.ExecutablePath -like '*WindowsApps\\Claude_*' -or -not $_.ExecutablePath })
$kids = @{}
foreach ($p in $procs) { $kids[[string]$p.ParentProcessId] = $true }
$now = Get-Date
foreach ($p in $procs) {
  $age = if ($p.CreationDate) { [int]($now - $p.CreationDate).TotalSeconds } else { -1 }
  $type = if (-not $p.ExecutablePath) { 'opaque' } elseif ($p.CommandLine -match '--type=') { 'child' } else { 'main' }
  $hk = if ($kids[[string]$p.ProcessId]) { 'kids' } else { 'nokids' }
  "$($p.ProcessId) $age $type $hk"
}
`;

function run(cmd, args) {
  return new Promise(resolve => {
    execFile(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => resolve(err ? null : String(stdout || '')));
  });
}

function classify(procs) {
  if (procs.some(p => Number.isNaN(p.pid))) return 'unknown';
  if (procs.some(p => p.opaque)) return 'unknown';
  if (!procs.length) return 'absent';
  const mains = procs.filter(p => p.main);
  if (mains.some(p => p.kids)) return 'live';
  if (mains.some(p => p.age >= 0 && p.age < LAUNCH_GRACE_SECONDS)) return 'launching';
  if (procs.some(p => !p.main)) return 'launching';
  return mains.length ? 'orphans-only' : 'absent';
}

async function probeWindows() {
  const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS]);
  if (out === null) return { state: 'unknown', procs: [] };
  const procs = out.split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(l => {
    const [pid, age, type, hk] = l.split(/\s+/);
    return { pid: +pid, age: +age, main: type === 'main', opaque: type === 'opaque', kids: hk === 'kids' };
  });
  return { state: classify(procs), procs };
}

function etimeSeconds(s) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(String(s).trim());
  if (!m) return -1;
  return (+(m[1] || 0)) * 86400 + (+(m[2] || 0)) * 3600 + (+m[3]) * 60 + (+m[4]);
}

// UNTESTED on macOS: main = .../Claude.app/Contents/MacOS/Claude, children = "Claude Helper*".
async function probeMac() {
  const out = await run('ps', ['-axo', 'pid=,ppid=,uid=,etime=,command=']);
  if (out === null) return { state: 'unknown', procs: [] };
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const rows = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    if (uid !== null && +m[3] !== uid) continue;
    const cmd = m[5];
    if (!/\/Claude\.app\/Contents\//.test(cmd)) continue;
    rows.push({ pid: +m[1], ppid: +m[2], age: etimeSeconds(m[4]), main: /\/Contents\/MacOS\/Claude(\s|$)/.test(cmd) });
  }
  const parents = new Set(rows.map(r => r.ppid));
  const procs = rows.map(r => ({ pid: r.pid, age: r.age, main: r.main, opaque: false, kids: parents.has(r.pid) }));
  return { state: classify(procs), procs };
}

async function probe() {
  if (process.platform === 'win32') return probeWindows();
  if (process.platform === 'darwin') return probeMac();
  return { state: 'unknown', procs: [], note: 'Claude Desktop presence is only detected on Windows and macOS' };
}

let cached = null;
let probeImpl = null;   // tests replace the process probe; nothing else may
function setProbe(fn) { probeImpl = typeof fn === 'function' ? fn : null; cached = null; }
async function doProbe() {
  if (!probeImpl) return probe();
  const r = await probeImpl();
  return typeof r === 'string' ? { state: r, procs: [] } : (r || { state: 'unknown', procs: [] });
}

// `fresh: true` must be used for the check that permits a write. A cached answer is only good
// enough for display and for deciding whether a pass is worth starting.
async function presence({ fresh = false } = {}) {
  if (!fresh && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.result;
  const r = await doProbe();
  cached = { at: Date.now(), result: r };   // stamped on completion: the probe itself takes seconds
  return r;
}

const safeToWriteAll = state => state === 'absent' || state === 'orphans-only';

// What a caller may pass as `presence`:
//   nothing      the real probe (cached for display, fresh when asked)
//   a function   an injected probe (tests, or a caller that owns a better instrument); called
//                every time, fresh or not
//   a string     a measurement HANDED DOWN by the caller. It may start a pass early and it may
//                refuse, but it never PERMITS a write: a fresh request still really probes, and
//                the answer is the more cautious of the two. (A launching Desktop turns an
//                "absent" measured a few seconds ago into a database opened by two writers.)
function resolver(given) {
  if (typeof given === 'function') {
    return async (opts) => {
      const r = await given(opts || {});
      return typeof r === 'string' ? { state: r, procs: [] } : (r || { state: 'unknown', procs: [] });
    };
  }
  if (typeof given === 'string' && given) {
    return async (opts = {}) => {
      if (!opts.fresh) return { state: given, procs: [], handedDown: true };
      const real = await presence({ fresh: true });
      if (!safeToWriteAll(given) && safeToWriteAll(real.state)) return { state: given, procs: [], handedDown: true };
      return real;
    };
  }
  return presence;
}

function liveMainPid(result) {
  const m = (result && result.procs || []).filter(p => p.main && p.kids).sort((a, b) => a.age - b.age)[0];
  return m ? m.pid : null;
}

module.exports = { presence, probe, classify, resolver, safeToWriteAll, liveMainPid, setProbe, LAUNCH_GRACE_SECONDS, CACHE_TTL_MS };
