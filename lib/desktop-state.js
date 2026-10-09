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
  if (f.running === false) {
    if (f.exe === null) return 'missing';
    const recent = (f.launches || []).filter(t => (f.now || Date.now()) - t < 60 * 60000);
    return recent.length >= 3 || f.launchError ? 'wont-launch' : 'starting';
  }
  const code = f.debugger && f.debugger.code;
  if (code === 10) return 'signed-out';
  if (code === 3 || f.devMode === false) return 'dev-off';
  if (code === 9) return 'locked';
  if (code === 8) return 'disconnected';
  return 'link-off';
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

function note(f) { Object.assign(s, f); if (f.cdp === true) { s.launches = []; s.launchError = null; } }

let notRunningSince = null;
/**
 * Called once a minute by the server when the link is down. Opens Claude when it has been gone two
 * minutes (never while an account switch has it closed, never in a test), at most three times an hour.
 */
function tick({ running, busy, log }) {
  s.running = running;
  if (running) { notRunningSince = null; return; }
  if (s.exe === undefined || s.exe === null) s.exe = findExe();
  if (!s.exe) return;
  notRunningSince = notRunningSince || Date.now();
  if (Date.now() - notRunningSince < 2 * 60000) return;
  if (process.env.RELAYMOTE_NO_LAUNCH === '1' || process.env.RELAYMOTE_NO_SEND === '1') return;
  if (config.get().autoLaunchClaude === false || busy) return;
  const now = Date.now();
  s.launches = s.launches.filter(t => now - t < 60 * 60000);
  if (s.launches.length >= 3) return;
  if (s.launches.length && now - s.launches[s.launches.length - 1] < 10 * 60000) return;
  s.launches.push(now);
  try {
    const c = spawn(s.exe, [], { detached: true, stdio: 'ignore', windowsHide: false });
    c.on('error', e => { s.launchError = e.message; if (log) log('open Claude Desktop failed: ' + e.message); });
    c.unref();
    if (log) log('Claude Desktop was not running for 2 min — opened it (' + s.launches.length + '/3 this hour)');
  } catch (e) { s.launchError = e.message; if (log) log('open Claude Desktop failed: ' + e.message); }
}

const claudePid = () => new Promise(r => execFile('tasklist', ['/FI', 'IMAGENAME eq claude.exe', '/NH', '/FO', 'CSV'], { windowsHide: true },
  (e, out) => { if (e) return r(undefined); const m = /"claude\.exe","(\d+)"/i.exec(String(out)); r(m ? m[1] : null); }));

module.exports = { classify, get, note, tick, ensureDevMode, devModeOn, findExe, claudePid, TEXT, _s: s };
