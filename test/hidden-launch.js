// hidden-launch.js — no Relaymote launch path may show a console window (lib/launch.js spawnHidden).
// On Windows, spawn(cmd, { detached: true }) is DETACHED_PROCESS: cmd gets no console, so the node.exe it
// starts is given a new, VISIBLE one (windowsHide cannot reach it). Every background start therefore goes
// through wscript + scripts/run-hidden.vbs, which gives cmd a hidden console that node shares.
// Static checks always; RELAYMOTE_LIVE_WINDOWS=1 on Windows also launches a real node both ways and counts
// the visible console windows (the old way is the control: it must show one).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

let failed = 0;
const check = (ok, name, extra) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra !== undefined && !ok ? '  ' + JSON.stringify(extra).slice(0, 300) : ''}`); if (!ok) failed++; };
const ROOT = path.join(__dirname, '..');
const launch = require('../lib/launch');

// The route
const w = launch.hiddenPlan('C:\\Windows\\system32\\cmd.exe', ['/d', '/c', 'x.cmd'], 'win32');
check(w.cmd === 'wscript.exe' && /run-hidden\.vbs$/.test(w.args[0]) && w.args.slice(1).join(' ') === 'C:\\Windows\\system32\\cmd.exe /d /c x.cmd', 'on Windows a background start goes wscript -> run-hidden.vbs -> the command', w);
const u = launch.hiddenPlan('/bin/sh', ['a.sh'], 'linux');
check(u.cmd === '/bin/sh' && u.args.join() === 'a.sh', 'elsewhere it is the command itself');
check(fs.existsSync(path.join(ROOT, 'scripts', 'run-hidden.vbs')), 'run-hidden.vbs ships in scripts/');

// Every detached spawn of a console program goes through spawnHidden. The one allowed exception opens a URL
// (`cmd /c start "" url` starts a GUI browser; cmd's builtin `start` needs no console).
const files = ['bin/relaymote.js', 'server.js', ...fs.readdirSync(path.join(ROOT, 'lib')).filter(f => f.endsWith('.js')).map(f => 'lib/' + f),
  ...fs.readdirSync(path.join(ROOT, 'mobile')).filter(f => f.endsWith('.js')).map(f => 'mobile/' + f)];
const offenders = (src, file) => src.split('\n').map((l, i) => ({ l, i: i + 1 }))
  .filter(({ l }) => /detached: true/.test(l) && !/^\s*(\*|\/\/)/.test(l))
  .filter(({ l }) => !(file === 'lib/launch.js' && /spawn\(p\.cmd, p\.args/.test(l)))          // spawnHidden itself
  .filter(({ l }) => !/\['\/c', 'start', '', url\]/.test(l) && !/'open' : 'xdg-open'/.test(l))  // open a URL
  .filter(({ l }) => !/windowsHide: false/.test(l) && !/explorer\.exe/.test(l))                   // GUI apps (Claude Desktop)
  .map(({ l, i }) => file + ':' + i + ' ' + l.trim().slice(0, 100));
const bad = files.flatMap(f => offenders(fs.readFileSync(path.join(ROOT, f), 'utf8'), f));
check(bad.length === 0, 'no other detached spawn of a console program (daemon, tray, update script)', bad);
check(offenders("  const child = spawn(w.cmd, w.args, {\n    detached: true, stdio: 'ignore', windowsHide: true, env,", 'lib/launch.js').length === 1,
  'control: the old spawnDaemon shape is caught');
const L = fs.readFileSync(path.join(ROOT, 'lib', 'launch.js'), 'utf8');
check(/function spawnDaemon[\s\S]*?spawnHidden\(w\.cmd, w\.args/.test(L), 'spawnDaemon (relaymote start/open/restart, heal) uses spawnHidden');
const U = fs.readFileSync(path.join(ROOT, 'lib', 'updater.js'), 'utf8');
check(/spawnHidden\(process\.env\.ComSpec \|\| 'cmd\.exe', \['\/d', '\/c', cmd\]/.test(U) && /function startTray\(\) \{[\s\S]*?spawnHidden\('powershell\.exe'/.test(U)
  && /wscript\.exe "\$\{vbs\}" cmd\.exe/.test(U), 'the update script (every route) and the tray restart are hidden');
const T = fs.readFileSync(path.join(ROOT, 'scripts', 'tray.ps1'), 'utf8');
check(/\$p\.CreateNoWindow = \$true/.test(T) && /\$p\.UseShellExecute = \$false/.test(T), 'the tray\'s crash respawn starts cmd with CreateNoWindow');

(async () => {
  if (process.platform !== 'win32' || process.env.RELAYMOTE_LIVE_WINDOWS !== '1') {
    console.log('(live window count skipped: set RELAYMOTE_LIVE_WINDOWS=1 on Windows)');
  } else {
    const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-hidden-'));
    fs.writeFileSync(path.join(TMP, 'idle.js'), 'setTimeout(function () {}, 12000);\n');
    fs.writeFileSync(path.join(TMP, 'idle.cmd'), '@echo off\r\n"' + process.execPath + '" "%~dp0idle.js"\r\n');
    const ps = `Add-Type @'
using System; using System.Text; using System.Runtime.InteropServices;
public static class VW { public delegate bool P(IntPtr h, IntPtr l);
 [DllImport("user32.dll")] public static extern bool EnumWindows(P f, IntPtr l);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
 public static int Count(string needle) { int n = 0; EnumWindows((h, l) => { if (IsWindowVisible(h)) { var t = new StringBuilder(1024); GetWindowText(h, t, 1024); if (t.ToString().Contains(needle)) n++; } return true; }, IntPtr.Zero); return n; } }
'@
[VW]::Count('${TMP.replace(/'/g, "''")}')`;
    const visible = () => Number(String(spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true }).stdout).trim());
    const idleGone = async () => { for (let i = 0; i < 20; i++) { if (visible() === 0) return; await new Promise(r => setTimeout(r, 1000)); } };
    const cmd = path.join(TMP, 'idle.cmd');
    launch.spawnHidden(process.env.ComSpec || 'cmd.exe', ['/d', '/c', cmd]);
    await new Promise(r => setTimeout(r, 3000));
    const nNew = visible();
    const old = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', cmd], { detached: true, stdio: 'ignore', windowsHide: true });
    old.unref();
    await new Promise(r => setTimeout(r, 3000));
    const nOld = visible();
    check(nOld >= 1, 'control: the old detached spawn shows a console window (the check can see one)', nOld);
    check(nNew === 0, 'spawnHidden shows NO console window', nNew);
    await idleGone();
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  }
  console.log(failed ? `\n${failed} check(s) failed` : '\nall hidden-launch checks passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
