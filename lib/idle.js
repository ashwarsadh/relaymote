'use strict';
// idle.js — how long since the user last touched the keyboard or mouse.
//
// Relaymote drives the Claude Desktop window, so UI actions wait until the user is away (the idle gate,
// Settings › Modules › Idle gate). The answer comes from the platform:
//   Windows  GetLastInputInfo, sampled by one long-lived PowerShell child every 400 ms
//   macOS    `ioreg -c IOHIDSystem` → HIDIdleTime (nanoseconds)
//   Linux    `xprintidle` (milliseconds) when installed
// When there is no way to know (Linux without xprintidle, a probe that keeps failing), idleMs() is
// null — UNKNOWN — and isIdle() treats unknown as NOT idle. Guessing "idle" is how a tool ends up
// typing into the window you are using. To run UI actions without a probe, set idleGateSeconds to 0.

const { spawn, execFile } = require('child_process');

const SAMPLE_MS = 400;
const STALE_MS = 2000;
const RESTART_BACKOFF_MS = 5000;
const POLL_MIN_MS = 1000;          // macOS/Linux: at most one probe per second
const UNAVAILABLE_RECHECK_MS = 60000;

let proc = null;
let lastIdleMs = null;
let lastAt = 0;
let lastSpawnAt = 0;
let starting = false;
let sampler = null;                // test seam: () => number|null|Promise<number|null>
let probing = false, lastProbeAt = 0, unavailableAt = 0, lastError = null;

const platform = () => process.env.BATON_IDLE_PLATFORM || process.platform;

const PS = `
$ErrorActionPreference='Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
public class BatonIdle {
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
  [DllImport("kernel32.dll")] public static extern uint GetTickCount();
  public static uint Ms() {
    LASTINPUTINFO l = new LASTINPUTINFO();
    l.cbSize = (uint)Marshal.SizeOf(l);
    GetLastInputInfo(ref l);
    return GetTickCount() - l.dwTime;
  }
}
"@
while ($true) { [Console]::Out.WriteLine([BatonIdle]::Ms()); Start-Sleep -Milliseconds ${SAMPLE_MS} }
`;

/** macOS: HIDIdleTime is in nanoseconds. Returns ms or null. */
function parseIoreg(text) {
  const m = /"HIDIdleTime"\s*=\s*(\d+)/.exec(String(text || ''));
  if (!m) return null;
  const ms = Math.floor(Number(m[1]) / 1e6);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}
/** Linux: xprintidle prints milliseconds. Returns ms or null. */
function parseXprintidle(text) {
  const t = String(text || '').trim();
  if (!/^\d+$/.test(t)) return null;
  return Number(t);
}

function record(ms) {
  if (Number.isFinite(ms) && ms >= 0) { lastIdleMs = ms; lastAt = Date.now(); lastError = null; }
}

function startWindows() {
  if (proc || starting) return;
  if (Date.now() - lastSpawnAt < RESTART_BACKOFF_MS) return;
  starting = true;
  lastSpawnAt = Date.now();
  try {
    proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    proc.stdout.setEncoding('utf8');
    let buf = '';
    proc.stdout.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        record(Number(line));
      }
    });
    const gone = () => { proc = null; lastIdleMs = null; };
    proc.on('exit', gone);
    proc.on('error', e => { lastError = e.message; gone(); });
    if (proc.unref) proc.unref();
  } catch (e) { proc = null; lastError = e.message; }
  starting = false;
}

// One on-demand probe (macOS/Linux, or the test sampler). Results land asynchronously.
function probeOnce() {
  if (probing || Date.now() - lastProbeAt < POLL_MIN_MS) return;
  if (unavailableAt && Date.now() - unavailableAt < UNAVAILABLE_RECHECK_MS) return;
  probing = true; lastProbeAt = Date.now();
  const done = (ms, err, missing) => {
    probing = false;
    if (ms !== null && ms !== undefined) { record(ms); unavailableAt = 0; }
    else { lastError = err || 'no reading'; if (missing) unavailableAt = Date.now(); }
  };
  if (sampler) {
    Promise.resolve().then(() => sampler()).then(v => done(Number.isFinite(v) ? v : null, 'sampler returned no reading'), e => done(null, e.message));
    return;
  }
  const p = platform();
  if (p === 'darwin') {
    execFile('ioreg', ['-c', 'IOHIDSystem', '-d', '4'], { timeout: 3000, maxBuffer: 4 * 1024 * 1024 },
      (e, out) => { const ms = e ? null : parseIoreg(out); done(ms, e ? e.message : 'HIDIdleTime not found', !!(e && e.code === 'ENOENT')); });
  } else if (p === 'linux') {
    execFile('xprintidle', [], { timeout: 3000 },
      (e, out) => { const ms = e ? null : parseXprintidle(out); done(ms, e ? (e.code === 'ENOENT' ? 'xprintidle is not installed' : e.message) : 'unexpected xprintidle output', !!(e && e.code === 'ENOENT')); });
  } else done(null, 'no idle probe on ' + p, true);
}

function start() {
  if (sampler || platform() !== 'win32') return probeOnce();
  return startWindows();
}

/** Milliseconds since the last keyboard/mouse input, or null when UNKNOWN. */
function idleMs() {
  start();
  if (lastIdleMs === null) return null;
  const age = Date.now() - lastAt;
  if (age > STALE_MS + (platform() === 'win32' && !sampler ? 0 : POLL_MIN_MS)) return null;
  return lastIdleMs + age;
}

/** True only when the user has provably been away for minMs. Unknown is NOT idle. minMs <= 0 = no gate. */
function isIdle(minMs) {
  if (!(minMs > 0)) return true;
  const ms = idleMs();
  return ms !== null && ms >= minMs;
}

function method() {
  if (sampler) return 'test-sampler';
  const p = platform();
  return p === 'win32' ? 'GetLastInputInfo' : p === 'darwin' ? 'ioreg HIDIdleTime' : p === 'linux' ? 'xprintidle' : 'none';
}
/** For `baton status` and the health endpoint: which probe, and whether it is answering. */
function status() {
  const ms = idleMs();
  return { platform: platform(), method: method(), known: ms !== null, idleMs: ms,
           unavailable: !!unavailableAt, error: ms === null ? lastError : null };
}

function stop() { try { if (proc) proc.kill(); } catch {} proc = null; lastIdleMs = null; }

/** Test seam: replace the platform probe. Pass null to restore. Resets the cached reading. */
function _setSampler(fn) {
  const prev = sampler; sampler = fn || null;
  lastIdleMs = null; lastAt = 0; probing = false; lastProbeAt = 0; unavailableAt = 0; lastError = null;
  return prev;
}

module.exports = { idleMs, isIdle, start, stop, status, parseIoreg, parseXprintidle, _setSampler, SAMPLE_MS };
