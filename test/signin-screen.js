// g1518: "relaymote shudnt enable debugger on such sign in screens, shud wait for me to login then
// attempt". After an account switch Claude Desktop showed Sign In ("Continue with Google / Continue with
// email"), but its config still held the old account's token, so the macro's signed-in test passed and it
// clicked through the menus on the login screen (exit 4). The macro now reads the window itself and waits
// (exit 10, retried every minute, never counted as a failure) while the Sign In screen is up.
const fs = require('fs'), os = require('os'), path = require('path'), { execFileSync, spawnSync } = require('child_process');
const macro = path.join(__dirname, '..', 'scripts', 'enable-debugger.ps1');
const src = fs.readFileSync(macro, 'utf8');
let fails = 0;
const check = (ok, what, got) => { console.log((ok ? 'ok   ' : 'FAIL ') + what + (got !== undefined ? '  ' + JSON.stringify(got) : '')); if (!ok) fails++; };

// The check sits after "is Desktop running" and BEFORE the countdown and any click.
const at = (s) => src.indexOf(s);
const gate = at("if (SignInScreen $h) { Finish 10");
check(gate > at("Finish 1 'Claude Desktop is not running") && gate < at('$script:bar = New-Object RelaymoteBar') && gate < at('RealClick $menu;'),
      'the Sign In check runs before the countdown and before any click');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
check(/DEBUGGER_WAITING = new Set\(\[[^\]]*\b10\b/.test(server), 'exit 10 is a wait (retried each minute), not one of the three failures');

if (process.platform !== 'win32') { console.log('skip: the window probe is Windows-only'); }
else {
  // A real window with the Sign In screen's buttons, and one without: the macro's own probe reads each.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-signin-'));
  const fake = path.join(dir, 'fake.ps1');
  fs.writeFileSync(fake, [
    'param([string]$Macro, [switch]$SignIn)',
    'Add-Type -AssemblyName System.Windows.Forms',
    "$f = New-Object System.Windows.Forms.Form; $f.ShowInTaskbar = $false; $f.StartPosition = 'Manual'; $f.Left = -3000",
    "$labels = if ($SignIn) { 'Continue with Google', 'Continue with email' } else { 'New session', 'Settings' }",
    '$y = 10; foreach ($l in $labels) { $b = New-Object System.Windows.Forms.Button; $b.Text = $l; $b.Top = $y; $b.Width = 200; $f.Controls.Add($b); $y += 40 }',
    '$f.Show(); [System.Windows.Forms.Application]::DoEvents()',
    '& powershell -NoProfile -ExecutionPolicy Bypass -File $Macro -ProbeSignIn ([int64]$f.Handle) | Out-Null',
    '$code = $LASTEXITCODE; $f.Close(); exit $code',
  ].join('\r\n'));
  const run = (signIn) => spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', fake, '-Macro', macro].concat(signIn ? ['-SignIn'] : []),
    { windowsHide: true, timeout: 60000 }).status;
  check(run(true) === 10, 'a window showing "Continue with Google / Continue with email" is the Sign In screen: wait');
  check(run(false) === 0, 'a signed-in window is not');
  fs.rmSync(dir, { recursive: true, force: true });
}

if (fails) { console.error(fails + ' failed'); process.exit(1); }
console.log('signin-screen: all checks passed');
