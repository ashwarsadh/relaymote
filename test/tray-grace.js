// tray-grace.js — 19-Nov: blocked is not dead. On 16-Nov 03:24 IST the tray's watchdog ended the daemon after two
// missed health probes during a 186 s PC-wide stall; that cost two restarts and a 72 s boot stall. Now loop-watch's
// worker (alive while the main thread is blocked) writes state/loop-stall.json during a stall, and the tray's
// StalledAlive spares a holder with a fresh note for up to watchdogGraceSec. A silent worker is still ended.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tray-grace-'));
const NOTE = path.join(TMP, 'loop-stall.json');
process.env.RELAYMOTE_LOOP_WINDOW_MS = '4000';
process.env.RELAYMOTE_LOOP_NOTE_AFTER_MS = '1500';
process.env.RELAYMOTE_LOOP_NOTE_EVERY_MS = '1000';
const lw = require('../lib/loop-watch');

let fails = 0;
const check = (ok, what, got) => { console.log((ok ? 'ok   ' : 'FAIL ') + what + (!ok && got !== undefined ? '  ' + JSON.stringify(got) : '')); if (!ok) fails++; };
const wait = (ms) => new Promise(r => setTimeout(r, ms));
function hold(ms) { const e = Date.now() + ms; let x = 0; while (Date.now() < e) x += Math.sqrt(x + 1); return x; }

const TRAY = fs.readFileSync(path.join(ROOT, 'scripts', 'tray.ps1'), 'utf8');
const fn = (/function StalledAlive\(\$procId, \$graceMs\) \{[\s\S]*?\r?\n\}/.exec(TRAY) || [])[0];

function stalledAlive(note, pid, graceMs) {
  if (note === null) { try { fs.unlinkSync(NOTE); } catch {} } else fs.writeFileSync(NOTE, JSON.stringify(note));
  const script = `$State = '${TMP.replace(/'/g, "''")}'\n${fn}\nif (StalledAlive ${pid} ${graceMs}) { 'YES' } else { 'NO' }`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true });
  return (r.stdout || '').trim() + (r.stderr ? ' ERR ' + r.stderr.trim().slice(0, 200) : '');
}

(async () => {
  // 1. The worker writes the note DURING a stall (the main thread cannot) and clears it after.
  const w = lw.start(() => {}, { stallFile: NOTE });
  w.ref();
  await wait(800);
  check(!fs.existsSync(NOTE), 'a quiet loop writes no note');
  const t0 = Date.now();
  hold(4000);
  // Read right after the hold, before the worker's 200 ms tick sees the beat move again.
  let during = null; try { during = JSON.parse(fs.readFileSync(NOTE, 'utf8')); } catch {}
  check(during && during.pid === process.pid && during.stalledSince >= t0 - 300 && during.stalledSince < t0 + 1000,
    'during a 4 s stall the worker wrote {pid, stalledSince} while the main thread was blocked', during);
  check(during && during.at - during.stalledSince >= 1400, 'the note is refreshed while the stall goes on (at moves past stalledSince)', during);
  let after = null;
  for (let i = 0; i < 20; i++) { await wait(150); try { after = JSON.parse(fs.readFileSync(NOTE, 'utf8')); } catch {} if (after && after.stalledSince === null) break; }
  check(after && after.stalledSince === null && after.lastMs >= 3500, 'when the stall ends the note says so (stalledSince null, lastMs)', after);
  await w.terminate();

  // 2. The tray's decision, from the real function text in scripts/tray.ps1.
  check(!!fn, 'tray.ps1 defines StalledAlive($procId, $graceMs)');
  // tray.ps1 is the Windows tray; macOS release runners have no powershell.exe (v0.2.201's mac builds failed here).
  if (process.platform !== 'win32') console.log('skip StalledAlive fixtures: no PowerShell off Windows');
  else if (fn) {
    const now = Date.now();
    check(stalledAlive({ pid: 4242, stalledSince: now - 60000, at: now - 2000 }, 4242, 180000) === 'YES', 'fresh note, same pid, 60 s into a stall: spared');
    check(stalledAlive({ pid: 4242, stalledSince: now - 60000, at: now - 30000 }, 4242, 180000) === 'NO', 'note 30 s old (the worker is silent too, a real hang): ended');
    check(stalledAlive({ pid: 9999, stalledSince: now - 60000, at: now - 2000 }, 4242, 180000) === 'NO', 'note from another pid (an earlier daemon): ended');
    check(stalledAlive({ pid: 4242, stalledSince: now - 200000, at: now - 2000 }, 4242, 180000) === 'NO', 'stalled past the grace: ended');
    check(stalledAlive({ pid: 4242, stalledSince: null, at: now - 2000, lastMs: 5000 }, 4242, 180000) === 'NO', 'no stall open: ended (it is not answering for another reason)');
    check(stalledAlive(null, 4242, 180000) === 'NO', 'no note at all: ended, as before');
  }

  // 3. Wiring: the kill path asks first, the grace is a setting, and the server hands the worker the file.
  const sd = (/function StartDaemon \{[\s\S]*?\r?\n\}/.exec(TRAY) || [''])[0];
  check(sd.indexOf('StalledAlive $held.ProcessId (GraceMs)') > 0 && sd.indexOf('StalledAlive') < sd.indexOf('Stop-Process'),
    'StartDaemon asks StalledAlive before Stop-Process');
  check(/watchdogGraceSec/.test(TRAY) && /\$g = 180/.test(TRAY), 'the grace is settings watchdogGraceSec, default 180 s');
  const srv = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  check(/loop-watch'\)\.start\(orch\.log, \{ stallFile: path\.join\(config\.STATE, 'loop-stall\.json'\) \}\)/.test(srv), 'server.js passes STATE/loop-stall.json to loop-watch');

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  console.log(fails ? `\n${fails} failed` : '\nall tray-grace checks passed');
  process.exit(fails ? 1 : 0);
})();
