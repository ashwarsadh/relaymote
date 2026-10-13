// update-lock.js — an upgrade never empties the install folder because a file is locked (13-Oct-2026, 0.2.102).
// The tray (restarted by the watchdog mid-install) held assets\tray.png; setup aborted AFTER [InstallDelete] had
// removed bin\ lib\ runtime\ node_modules\ ..., its rollback could not restore them, and the stop marker kept the
// watchdog from relaunching. Fix: the installer's PrepareToInstall runs stop-relaymote.ps1 -ForUpdate BEFORE
// anything is deleted; it keeps stopping until no file is held, else exits 3 and setup stops with the old install
// intact. The apply script retries once, always clears the marker, and retries `start`.
// Real locked-file fixtures on Windows (a fake tray holding tray.png with FileShare None); static checks elsewhere.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

let failed = 0;
const check = (ok, name, extra) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra !== undefined && !ok ? '  ' + JSON.stringify(extra).slice(0, 400) : ''}`); if (!ok) failed++; };
const R = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

// ---- the installer: guard before [InstallDelete], with the NEW script
const iss = R('installer', 'windows', 'relaymote.iss');
const prep = (iss.match(/function PrepareToInstall[\s\S]*?\nend;/) || [''])[0];
check(/ExtractTemporaryFile\('stop-relaymote\.ps1'\)/.test(prep) && /-ForUpdate -Root/.test(prep) && /if Rc = 3 then/.test(prep) && /Result := 'A Relaymote file is still in use, so nothing was changed/.test(prep),
  'PrepareToInstall runs the new stop script -ForUpdate and aborts (old install intact) when a file stays locked');
check(/Source: "\{#SourceDir\}\\stop-relaymote\.ps1"; Flags: dontcopy/.test(iss), 'the new stop script is in setup for ExtractTemporaryFile');
check(/\[InstallDelete\][\s\S]*\{app\}\\runtime/.test(iss), 'control: [InstallDelete] still empties runtime\\ etc., which is why the guard must run first');

// ---- the apply script: retry, marker, start twice
process.env.RELAYMOTE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-upd-'));
const U = require('../lib/updater');
const a = U.apply(path.join(os.tmpdir(), 'Relaymote-Setup-9.9.9-x64.exe'), '9.9.9', { dry: true });
const cmd = fs.readFileSync(a.script, 'utf8');
check(/if "%RC%"=="0" goto installed/.test(cmd) && /stop-relaymote\.ps1"/.test(cmd) && /setup-9\.9\.9-retry\.log/.test(cmd), 'a failed install is retried once after stopping everything again', cmd);
check(/:installed\r\ndel \/f \/q "[^"]*stopped-by-user\.json"/.test(cmd), 'the stop marker is always cleared before starting, so tray and watchdog can bring it back', cmd);
check(/" start >> [^\r]*\r\nif errorlevel 1 \(ping -n 11 127\.0\.0\.1 >nul & "[^"]*" "[^"]*" start/.test(cmd), 'a failed start is tried again', cmd);
check(/process\.exitCode = \(await startBackground\(\)\) \? 0 : 1/.test(R('bin', 'relaymote.js')), '`relaymote start` exits 1 when the daemon did not come up');

if (process.platform !== 'win32') { console.log('(lock fixtures run on Windows only)'); done(); }
else {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-root-'));
  for (const d of ['assets', 'scripts', 'lib']) fs.mkdirSync(path.join(root, d));
  fs.writeFileSync(path.join(root, 'assets', 'tray.png'), 'png');
  fs.writeFileSync(path.join(root, 'lib', 'x.js'), '//');
  fs.copyFileSync(path.join(__dirname, '..', 'installer', 'windows', 'stop-relaymote.ps1'), path.join(root, 'stop-relaymote.ps1'));
  // The fake tray: holds tray.png the way System.Drawing does (no sharing) until killed.
  fs.writeFileSync(path.join(root, 'scripts', 'tray.ps1'),
    "$h = [IO.File]::Open((Join-Path $PSScriptRoot '..\\assets\\tray.png'), 'Open', 'Read', 'None'); Start-Sleep -Seconds 120\r\n");
  // An outside holder (not a tray): must make the guard give up and say which file.
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-other-'));
  fs.writeFileSync(path.join(other, 'hold.ps1'), "param($f) $h = [IO.File]::Open($f, 'Open', 'Read', 'None'); Start-Sleep -Seconds 120\r\n");
  // A watchdog that brings the tray back once, 1.5 s after it dies.
  fs.writeFileSync(path.join(other, 'watchdog.ps1'), "param($t) $p = Start-Process powershell.exe -ArgumentList '-NoProfile','-File',$t -PassThru -WindowStyle Hidden; " +
    "$p.WaitForExit(); Start-Sleep -Milliseconds 1500; Start-Process powershell.exe -ArgumentList '-NoProfile','-File',$t -WindowStyle Hidden\r\n");

  const ps = (args, opts) => spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...args], { stdio: 'ignore', windowsHide: true, ...opts });
  const tray = path.join(root, 'scripts', 'tray.ps1'), png = path.join(root, 'assets', 'tray.png');
  const held = () => spawnSync('powershell.exe', ['-NoProfile', '-Command',
    `try { $h=[IO.File]::Open('${png}','Open','Read','None'); $h.Close(); 'free' } catch { 'held' }`], { encoding: 'utf8' }).stdout.trim() === 'held';
  const waitHeld = async () => { for (let i = 0; i < 40 && !held(); i++) await new Promise(r => setTimeout(r, 250)); return held(); };
  const guard = (w) => spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'stop-relaymote.ps1'),
    '-ForUpdate', '-Root', root, '-WaitSeconds', String(w)], { encoding: 'utf8', timeout: 60000 });
  const files = () => ['assets/tray.png', 'lib/x.js', 'scripts/tray.ps1'].every(f => fs.existsSync(path.join(root, f)));

  (async () => {
    // 1. The tray holds tray.png; the OLD logic (no -ForUpdate) would not check. The guard stops it and passes.
    ps(['-File', tray]);
    check(await waitHeld(), 'fixture: the fake tray holds assets\\tray.png');
    const g1 = guard(10);
    check(g1.status === 0 && !held() && files(), 'a tray holding tray.png is stopped and the folder is proven free (exit 0)', { status: g1.status, err: g1.stderr });

    // 2. A watchdog brings the tray back after the first stop: the guard notices and stops it again.
    ps(['-File', path.join(other, 'watchdog.ps1'), tray]);
    check(await waitHeld(), 'fixture: watchdog started the tray');
    const g2 = guard(15);
    check(g2.status === 0 && files(), 'a tray the watchdog restarts is stopped again before setup goes on', { status: g2.status, err: g2.stderr });
    await new Promise(r => setTimeout(r, 2500));
    if (held()) guard(10); // the watchdog's second tray may land after the guard passed; clean up for case 3

    // 3. Something that is not ours holds the file: the guard gives up, names the file, and nothing is removed.
    const h = ps(['-File', path.join(other, 'hold.ps1'), png]);
    check(await waitHeld(), 'fixture: an outside process holds tray.png');
    const g3 = guard(3);
    check(g3.status === 3 && /tray\.png/.test(g3.stderr) && files(), 'a file held by anything else: exit 3 naming it, every file still in place (setup aborts before deleting)',
      { status: g3.status, err: g3.stderr });
    try { process.kill(h.pid); } catch {}
    spawnSync('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -like '*${path.basename(other)}*' -or $_.CommandLine -like '*${path.basename(root)}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`]);
    done();
  })();
}

function done() {
  console.log(failed ? `\n${failed} FAILED` : '\nall update-lock checks passed');
  process.exit(failed ? 1 : 0);
}
