// launch.js — the ONE way Relaymote starts its daemon in the background, so every start path keeps what
// node says when it dies.
//
// A heap-limit abort, a native fault and an out-of-memory message all report on STDERR, and a daemon
// started with stderr discarded dies without a trace. So every background start goes through a small
// wrapper (scripts/run-daemon.cmd on Windows, scripts/run-daemon.sh elsewhere) that:
//   - rotates state/daemon-stdio.log at 10 MB (one generation kept) BEFORE node starts — a shell
//     redirect holds the file open, so it cannot be rotated under a running process;
//   - writes one "launching" line, appends node's STDERR only, then one "exited with code N" line.
// Stdout is not captured: the daemon's own log (state/baton.log) already records it, and copying it
// would make the capture grow as fast as that log, so "there are bytes in here" would mean nothing.
// A healthy daemon leaves this file almost empty; its SIZE is the signal.
//
// Callers: `baton start`, `baton restart`, `baton open`, heal's direct-spawn repair, and (through the
// same .cmd) the tray's StartDaemon and the autostart tasks.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const MAX_BYTES = 10 * 1024 * 1024;

function stateDir() { return process.env.BATON_STATE_DIR || require('./config').STATE; }
function logFile() { return path.join(stateDir(), 'daemon-stdio.log'); }

/** Rotate `file` to `file.1` when it is larger than `max` bytes. Returns true if it rotated. */
function rotate(file, max = MAX_BYTES) {
  let size = 0;
  try { size = fs.statSync(file).size; } catch { return false; }
  if (size <= max) return false;
  try { fs.unlinkSync(file + '.1'); } catch {}
  try { fs.renameSync(file, file + '.1'); return true; } catch { return false; }
}

function wrapper() {
  const root = require('./config').ROOT;
  return process.platform === 'win32'
    ? { cmd: process.env.ComSpec || 'cmd.exe', args: ['/d', '/c', path.join(root, 'scripts', 'run-daemon.cmd')] }
    : { cmd: '/bin/sh', args: [path.join(root, 'scripts', 'run-daemon.sh')] };
}

/**
 * How a background console program is started with NO window, on Windows through scripts/run-hidden.vbs.
 *
 * Why not spawn(cmd, { detached: true, windowsHide: true }): on Windows `detached` is DETACHED_PROCESS,
 * so cmd.exe gets no console at all, and the first console program IT starts (node.exe) is given a
 * brand-new console, which is VISIBLE: windowsHide only reaches the process spawned, and
 * CREATE_NO_WINDOW is ignored next to DETACHED_PROCESS. Measured: the 0.2.9 -> 0.2.10 self-update left
 * a "node server.js" console window on the desktop (its title was node's own command line, so node
 * owned it); the same spawn reproduced it from a shell, and the run-hidden.vbs route left 0 visible
 * console windows. wscript (a GUI program) starts cmd with a console of its own that is HIDDEN, and
 * node shares it. Dropping `detached` instead is not an option: libuv puts non-detached children in a
 * kill-on-close job, so the daemon would die with `baton start`.
 */
function hiddenPlan(cmd, args, platform = process.platform) {
  if (platform !== 'win32') return { cmd, args };
  const vbs = path.join(require('./config').ROOT, 'scripts', 'run-hidden.vbs');
  return { cmd: 'wscript.exe', args: [vbs, cmd, ...args] };
}
function spawnHidden(cmd, args, opts = {}) {
  const p = hiddenPlan(cmd, args);
  const child = spawn(p.cmd, p.args, { detached: true, stdio: 'ignore', windowsHide: true, ...opts });
  child.unref();
  return child;
}

/**
 * Start the daemon in the background, windowless, through the wrapper. `entry` (default server.js)
 * exists for tests. Returns { pid, log, wrapper } (on Windows pid is the short-lived wscript's).
 */
function spawnDaemon(opts = {}) {
  const log = logFile();
  try { fs.mkdirSync(path.dirname(log), { recursive: true }); } catch {}
  const w = wrapper();
  const env = { ...process.env, BATON_NODE: opts.node || process.execPath };
  if (opts.entry) env.BATON_DAEMON_ENTRY = opts.entry;
  const child = spawnHidden(w.cmd, w.args, { env, cwd: opts.cwd || require('os').homedir() });
  return { pid: child.pid, log, wrapper: w.args[w.args.length - 1] };
}

/**
 * The same wrapper, run in the FOREGROUND and awaited — for tests and for a service manager
 * (systemd / launchd) that wants to supervise the process itself.
 */
function runWrapped(opts = {}) {
  const w = wrapper();
  const env = { ...process.env, BATON_NODE: opts.node || process.execPath };
  if (opts.entry) env.BATON_DAEMON_ENTRY = opts.entry;
  return new Promise(resolve => {
    const child = spawn(w.cmd, w.args, { stdio: 'ignore', windowsHide: true, env });
    child.on('exit', code => resolve(code));
    child.on('error', () => resolve(null));
  });
}

// "The user stopped Relaymote" marker. The tray's health poll and the 10-minute watchdog both restart a
// missing daemon; without this they would undo `baton stop` and the tray's Quit within minutes.
function stopMarker() { return path.join(stateDir(), 'stopped-by-user.json'); }
function markStopped(by) {
  try { fs.mkdirSync(stateDir(), { recursive: true }); fs.writeFileSync(stopMarker(), JSON.stringify({ at: new Date().toISOString(), by: by || 'cli' })); return true; }
  catch { return false; }
}
function clearStopped() { try { fs.unlinkSync(stopMarker()); return true; } catch { return false; } }
function stoppedByUser() { try { return JSON.parse(fs.readFileSync(stopMarker(), 'utf8')); } catch { return null; } }

module.exports = { spawnDaemon, spawnHidden, hiddenPlan, runWrapped, rotate, logFile, wrapper, MAX_BYTES, markStopped, clearStopped, stoppedByUser, stopMarker };
