// desktop-cycle.js — "Close Claude, sync, reopen Claude".
//
// The account Desktop is using can only be written while Desktop is closed. This closes it on
// request, runs the sync, and starts it again. Closing Desktop stops every session running in it,
// so the caller must first show which sessions are running or waiting and pass back the confirm
// token it was given: a token is bound to that exact list, so a session that started since does
// not ride on an old confirmation.
//
// Closing is graceful first (Electron app.quit() over the main-process debugger, then a plain
// taskkill without /F). A forced kill happens only after the graceful attempt timed out AND the
// caller confirmed a second time.
//
// Windows only. On macOS (untested) and Linux this returns the manual steps instead.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const pres = require('./presence');

const MANUAL = [
  'Quit Claude Desktop yourself (make sure no session is in the middle of a reply).',
  'Press "Sync now" in Relaymote.',
  'Open Claude Desktop again.',
];

const tokenFor = (running, salt) => crypto.createHash('sha256')
  .update(JSON.stringify((running || []).map(s => s.id).sort()) + '|' + (salt || '')).digest('hex').slice(0, 16);

function exeFromPath(p) {
  const cands = [];
  if (p) cands.push(p);
  const local = require('./core').LOCALAPPDATA;
  cands.push(path.join(local, 'AnthropicClaude', 'claude.exe'), path.join(local, 'Programs', 'Claude', 'Claude.exe'));
  return cands.find(c => { try { return fs.statSync(c).isFile(); } catch { return false; } }) || null;
}

function realDeps() {
  const desktop = () => require('../desktop');
  return {
    platform: process.platform,
    presence: opts => pres.presence(opts),
    quit: async (main) => {
      try {
        const d = desktop(), conn = await d.connect(await d.wsUrl(), { evalTimeout: 5000 });
        try { await conn.evaluate("setTimeout(()=>process.mainModule.require('electron').app.quit(),300);'ok'"); return 'app.quit'; }
        finally { conn.close(); }
      } catch {}
      if (!main) return null;
      await new Promise(r => execFile('taskkill', ['/PID', String(main)], { windowsHide: true }, () => r()));
      return 'taskkill';
    },
    forceQuit: main => new Promise(r => execFile('taskkill', ['/PID', String(main), '/T', '/F'], { windowsHide: true }, () => r('taskkill /F'))),
    launch: exe => { const c = spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: false }); c.unref(); return true; },
    // The Store (MSIX) build has no exe of its own to start: open it through its AppsFolder id.
    aumid: () => require('./launch').msixAumid(),
    launchMsix: id => { const c = spawn('explorer.exe', ['shell:AppsFolder\\' + id], { detached: true, stdio: 'ignore' }); c.unref(); return true; },
    exePath: () => new Promise(resolve => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        "$me=[System.Diagnostics.Process]::GetCurrentProcess().SessionId; Get-CimInstance Win32_Process -Filter \"Name='claude.exe'\" | Where-Object { $_.SessionId -eq $me -and $_.CommandLine -notmatch '--type=' -and $_.ExecutablePath } | Select-Object -First 1 -ExpandProperty ExecutablePath"],
        { windowsHide: true, timeout: 20000 }, (e, out) => resolve(e ? null : String(out || '').trim() || null));
    }),
    sleep: ms => new Promise(r => setTimeout(r, ms)),
  };
}

// opts: { confirm, force, reopen = true, timeoutMs = 30000, runOpts }
// deps (injectable for tests): platform, presence, running, quit, forceQuit, launch, exePath, sync, sleep
async function closeSyncReopen(opts = {}, injected = {}) {
  const d = { ...realDeps(), ...injected };
  if (d.platform !== 'win32') return { ok: false, manual: true, steps: MANUAL, message: 'Closing and reopening Claude Desktop is automated on Windows only.' };
  const log = [];
  const first = await d.presence({ fresh: true });
  const wasOpen = !pres.safeToWriteAll(first.state);
  if (first.state === 'unknown') return { ok: false, error: 'PRESENCE_UNKNOWN', message: 'Could not tell whether Claude Desktop is running, so nothing was done.', steps: MANUAL };

  let exe = null;
  if (wasOpen) {
    const running = (await d.running()) || [];
    const token = tokenFor(running, opts.salt);
    if (!opts.confirm || opts.confirm !== token) {
      return { ok: false, needsConfirm: true, confirm: token, running,
               message: running.length ? running.length + ' session(s) are running or waiting for you. Closing Claude Desktop stops them.'
                                       : 'No session is running right now. Closing Claude Desktop is safe.' };
    }
    exe = await d.exePath();
    const main = pres.liveMainPid(first);
    if (!opts.force) {
      const how = await d.quit(main);
      log.push('asked Claude Desktop to quit (' + (how || 'no method worked') + ')');
    } else {
      if (!opts.forceConfirm || opts.forceConfirm !== token + '-force') {
        return { ok: false, needsForceConfirm: true, forceConfirm: token + '-force', message: 'Force-close Claude Desktop? Unsaved work in it is lost.' };
      }
      await d.forceQuit(main);
      log.push('force-closed Claude Desktop');
    }
    let closed = false;
    const until = Date.now() + (opts.timeoutMs || 30000);
    while (Date.now() < until) {
      await d.sleep(1000);
      const p = await d.presence({ fresh: true });
      if (pres.safeToWriteAll(p.state)) { closed = true; break; }
    }
    if (!closed) {
      return { ok: false, error: 'QUIT_TIMEOUT', log, needsForceConfirm: true, forceConfirm: token + '-force',
               message: 'Claude Desktop did not close. Close it yourself, or confirm a force-close.' };
    }
    log.push('Claude Desktop is closed');
  }

  const result = await d.sync({ ...(opts.runOpts || {}), apply: true });
  log.push('sync: ' + (result.applied ? result.applied.count + ' change(s) written' : result.error || 'not applied'));

  let reopened = false;
  if (wasOpen && opts.reopen !== false) {
    const target = exeFromPath(exe);
    let id = null;
    if (target) { d.launch(target); reopened = true; log.push('started Claude Desktop again'); }
    else if (d.aumid && d.launchMsix && (id = await d.aumid())) { d.launchMsix(id); reopened = true; log.push('started Claude Desktop again (Store app ' + id + ')'); }
    else log.push('could not find Claude Desktop to start it again - open it yourself');
  }
  return { ok: !!result.ok, log, sync: result, reopened };
}

module.exports = { closeSyncReopen, tokenFor, MANUAL, exeFromPath };
