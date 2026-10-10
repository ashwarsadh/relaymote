'use strict';
// desktop-state.js — g1587: say WHICH thing is wrong with Claude Desktop, in words, and repair what
// Relaymote can repair by itself.
//
// After a PC restart Claude Desktop came back signed out, and the phone showed only "desktop link down".
// The link (the debugger port) is down for several different reasons and each needs a different person
// to act: Relaymote can open Claude itself and can turn Developer Mode on in its settings file; only he
// can sign in or unlock the PC. classify() turns what the server knows into one state with plain text;
// the server's debugger tick feeds it, the phone shows it as a banner.

const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const config = require('./config');

// Each state: who acts, and what to tell him. `auto` = Relaymote is already fixing it.
const TEXT = {
  ok:            null,
  missing:       { title: 'Claude Desktop was not found on the PC',
                   text: 'Relaymote could not find Claude Desktop for this Windows user. Install it on the PC from claude.ai/download, open it and sign in; Relaymote connects by itself.' },
  restarting:    { title: 'Restarting Claude…', auto: true,
                   text: 'Claude Desktop was closed, so Relaymote has opened it again on the PC. The app reconnects by itself in about a minute; anything you send waits here and goes then.' },
  starting:      { title: 'Claude Desktop is not running — opening it', auto: true,
                   text: 'Relaymote is starting Claude Desktop on the PC. Your messages wait here and go as soon as it is up.' },
  'wont-launch': { title: 'Claude Desktop will not start',
                   text: 'Relaymote tried to open Claude Desktop and it did not start. Open it on the PC; if it still will not open, reinstall it from claude.ai/download.' },
  'signed-out':  { title: 'Relaymote is connected, but Claude is not logged in',
                   text: 'Log in to Claude on the PC. Relaymote then turns its link on by itself — nothing else to do.' },
  'dev-off':     { title: 'Claude is logged in, but its developer option is off',
                   text: 'Relaymote has switched Developer Mode on. Quit Claude on the PC completely (tray icon › Quit) and open it again; Relaymote then turns its link on by itself.' },
  locked:        { title: 'The PC is locked',
                   text: 'Claude is running, but Windows does not let Relaymote switch its link on behind the lock screen. Unlock the PC; Relaymote then does it by itself.' },
  disconnected:  { title: 'Nobody is signed in to the PC\'s screen',
                   text: 'The PC\'s Remote Desktop session is closed, and Windows does not let Relaymote click in a closed session. Connect to the PC once; Relaymote then turns the link on by itself.' },
  'link-off':    { title: 'Claude is running, but its link to Relaymote is off', auto: true,
                   text: 'Relaymote is switching it on and retries every minute.' },
};

const s = { cdp: null, running: null, exe: undefined, debugger: null, launches: [], launchError: null, devFixed: false };

/** Pure: what the facts add up to. */
function classify(f) {
  if (f.cdp === true) return 'ok';
  const fresh = f.launchedAt && (f.now || Date.now()) - f.launchedAt < 3 * 60000;
  if (f.running === false) {
    if (fresh && !f.launchError) return 'restarting';
    if (f.exe === null) return 'missing';
    const recent = (f.launches || []).filter(t => (f.now || Date.now()) - t < 60 * 60000);
    return recent.length >= 3 || f.launchError ? 'wont-launch' : 'starting';
  }
  const code = f.debugger && f.debugger.code;
  if (code === 10) return 'signed-out';
  if (code === 3 || f.devMode === false) return 'dev-off';
  if (code === 9) return 'locked';
  if (code === 8) return 'disconnected';
  return fresh ? 'restarting' : 'link-off';
}

function devModeOn() {
  try { return JSON.parse(fs.readFileSync(path.join(config.APPDATA, 'Claude', 'developer_settings.json'), 'utf8')).allowDevTools === true; } catch { return false; }
}
/** Developer Mode is a setting in a file: Relaymote can switch it on; Desktop reads it at start. */
function ensureDevMode() {
  const f = path.join(config.APPDATA, 'Claude', 'developer_settings.json');
  if (!fs.existsSync(path.dirname(f)) || devModeOn()) return false;
  let j = {}; try { j = JSON.parse(fs.readFileSync(f, 'utf8')) || {}; } catch {}
  fs.writeFileSync(f, JSON.stringify({ ...j, allowDevTools: true }, null, 2));
  return true;
}

/** Where Claude Desktop is installed for this user, or null. Squirrel's stub starts the newest app-*. */
function findExe() {
  const L = process.env.LOCALAPPDATA || '';
  const cands = [path.join(L, 'AnthropicClaude', 'claude.exe'), path.join(L, 'Programs', 'Claude', 'Claude.exe'),
                 path.join(L, 'Programs', 'claude-desktop', 'Claude.exe')];
  return cands.find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
}

/** The test seam: RELAYMOTE_SIM_DESKTOP=<state> pins the state (demo instances, screenshots). */
function get() {
  const sim = process.env.RELAYMOTE_SIM_DESKTOP;
  const st = sim && TEXT[sim] !== undefined ? sim
    : classify({ ...s, devMode: s.cdp === true ? true : devModeOn(), now: Date.now() });
  const t = TEXT[st];
  return { state: st, ...(t || {}), at: new Date().toISOString(),
           detail: st === 'link-off' && s.debugger ? s.debugger.message : undefined };
}

function note(f) { Object.assign(s, f); if (f.cdp === true) { s.launches = []; s.launchError = null; s.launchedAt = 0; } }

// g1638: "so claude exited relaymote didnt restart it of i used the app". `tasklist claude.exe` also
// counts the Claude Code CLI (it is claude.exe too, under %APPDATA%\Claude\claude-code\, and in other
// Windows sessions), so Desktop always looked "running" and was never reopened. This asks for the Desktop
// app ONLY (its install folder), ONLY in Relaymote's own Windows session, and whether that session has a
// desktop at all (explorer.exe) — a launch from session 0 or a service session would open nowhere.
const PROBE_PS = [
  '$me = (Get-Process -Id $PID).SessionId',
  '$d = @(Get-CimInstance Win32_Process -Filter "Name=\'claude.exe\'" | Where-Object { $_.SessionId -eq $me -and $_.ExecutablePath -and',
  '  (-not $root -or $_.ExecutablePath.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) -and',
  '  $_.ExecutablePath -notmatch "\\\\claude-code\\\\" -and $_.ExecutablePath -match "\\\\(AnthropicClaude|Programs\\\\Claude|claude-desktop|WindowsApps\\\\Claude[^\\\\]*)\\\\" })',
  '$ids = @($d | ForEach-Object { $_.ProcessId })',
  '$main = @($d | Where-Object { $ids -notcontains $_.ParentProcessId } | ForEach-Object { $_.ProcessId })',
  '$ex = @(Get-CimInstance Win32_Process -Filter "Name=\'explorer.exe\'" | Where-Object { $_.SessionId -eq $me }).Count -gt 0',
  '@{ session = $me; main = $main; count = $ids.Count; explorer = $ex } | ConvertTo-Json -Compress',
].join('\n');
let probeSeam = null;   // tests: replace the probe
function probe() {
  if (probeSeam) return Promise.resolve(probeSeam());
  if (process.platform !== 'win32') return Promise.resolve(null);
  // Only the install Relaymote would launch counts (its own folder), so another copy cannot stand in for it.
  const exe = s.exe || findExe();
  const root = exe ? (path.dirname(exe) + path.sep).replace(/'/g, "''") : '';
  const enc = Buffer.from("$root = '" + root + "'\n" + PROBE_PS, 'utf16le').toString('base64');
  return new Promise(r => execFile('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc], { windowsHide: true, timeout: 20000 },
    (e, out) => { if (e) return r(null); try { const j = JSON.parse(String(out).trim()); r({ ...j, main: [].concat(j.main || []) }); } catch { r(null); } }));
}
/** The Desktop app's main pid in Relaymote's session; null when it is not running; undefined when unknown. */
const claudePid = () => probe().then(p => p ? (p.main[0] ? String(p.main[0]) : (p.count ? 'running' : null)) : undefined);

let launching = null, launchSeam = null;
function launch(why, log) {
  s.exe = s.exe || findExe();
  if (!s.exe) { s.exe = null; return { ok: false, state: 'missing' }; }
  const now = Date.now();
  s.launches = s.launches.filter(t => now - t < 60 * 60000);
  s.launches.push(now); s.launchedAt = now; s.running = false; s.launchError = null;
  try {
    if (launchSeam) launchSeam(s.exe);
    else {
      const c = spawn(s.exe, [], { detached: true, stdio: 'ignore', windowsHide: false });
      c.on('error', e => { s.launchError = e.message; if (log) log('open Claude Desktop failed: ' + e.message); });
      c.unref();
    }
    if (log) log('Claude Desktop was not running — opened it (' + why + '; ' + s.launches.length + ' this hour)');
    if (module.exports.onLaunched) module.exports.onLaunched();
    return { ok: true, launched: true };
  } catch (e) { s.launchError = e.message; if (log) log('open Claude Desktop failed: ' + e.message); return { ok: false, error: e.message }; }
}

/**
 * The phone was opened, or he sent something, while the link is down: if the Desktop app is not running
 * in this session, open it now. One at a time; never twice within 90 s (Desktop takes that long to come
 * up); at most six an hour; never in a test.
 */
function wake({ why = 'phone', log } = {}) {
  if (launching) return launching;
  if (process.env.RELAYMOTE_NO_LAUNCH === '1' || config.get().autoLaunchClaude === false) return Promise.resolve({ ok: false, skipped: 'off' });
  if (s.launchedAt && Date.now() - s.launchedAt < 90000) return Promise.resolve({ ok: true, already: true });
  if (s.lastWakeProbe && Date.now() - s.lastWakeProbe < 15000) return Promise.resolve({ ok: true, throttled: true });
  s.lastWakeProbe = Date.now();
  launching = (async () => {
    const p = await probe();
    if (!p) return { ok: false, error: 'probe-failed' };
    s.running = !!(p.main.length || p.count);
    if (s.running) return { ok: true, running: true };
    if (!p.explorer) { if (log) log('Claude Desktop is not running, but Relaymote\'s Windows session ' + p.session + ' has no desktop — not opening it there'); return { ok: false, error: 'no-desktop-session' }; }
    if (s.launches.filter(t => Date.now() - t < 60 * 60000).length >= 6) return { ok: false, error: 'too-many' };
    return launch(why, log);
  })().finally(() => { launching = null; });
  return launching;
}

let notRunningSince = null;
/**
 * Called once a minute by the server when the link is down. Opens Claude when it has been gone two
 * minutes (never while followClaude/an account switch has it closed, never in a test), at most three an hour.
 */
function tick({ running, busy, log }) {
  s.running = running;
  if (running) { notRunningSince = null; return; }
  if (s.exe === undefined || s.exe === null) s.exe = findExe();
  if (!s.exe) return;
  notRunningSince = notRunningSince || Date.now();
  if (Date.now() - notRunningSince < 2 * 60000) return;
  if (process.env.RELAYMOTE_NO_LAUNCH === '1' || process.env.RELAYMOTE_NO_SEND === '1') return;
  if (config.get().autoLaunchClaude === false || busy || launching) return;
  const now = Date.now();
  const recent = s.launches.filter(t => now - t < 60 * 60000);
  if (recent.length >= 3 || (recent.length && now - recent[recent.length - 1] < 10 * 60000)) return;
  launch('gone 2 min', log);
}

module.exports = { classify, get, note, tick, wake, probe, ensureDevMode, devModeOn, findExe, claudePid, TEXT, _s: s,
  _seams: (p, l) => { probeSeam = p; launchSeam = l; }, onLaunched: null, onAppOpen: null };
