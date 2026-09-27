# tray.ps1 - Relaymote's Windows tray icon. Keeps the daemon running and gives one-click access to the
# app, phone pairing and settings. Started by `relaymote tray` or the `relaymote autostart` logon task.
# -Watchdog: started by the 10-minute "Relaymote Watchdog" task. It exits at once when a tray is already
# running (single-instance lock) or when you stopped Relaymote yourself (state\stopped-by-user.json).
param([switch]$Watchdog)
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$Root = Split-Path -Parent $PSScriptRoot
$Data = if ($env:RELAYMOTE_HOME) { $env:RELAYMOTE_HOME } else { Join-Path $env:USERPROFILE '.relaymote' }

# One tray per user.
$mutex = New-Object System.Threading.Mutex($false, 'Local\RelaymoteTray')
if (-not $mutex.WaitOne(0)) { exit 0 }

# "You stopped Relaymote" marker, shared with `relaymote stop` / `relaymote start` (lib/launch.js).
$State = if ($env:RELAYMOTE_STATE_DIR) { $env:RELAYMOTE_STATE_DIR } else { Join-Path $Data 'state' }
$StopMarker = Join-Path $State 'stopped-by-user.json'
function StoppedByUser { return (Test-Path $StopMarker) }
function MarkStopped { try { New-Item -ItemType Directory -Force $State | Out-Null; ('{"by":"tray","at":"' + (Get-Date).ToString('o') + '"}') | Set-Content -Path $StopMarker -Encoding ascii } catch {} }
function ClearStopped { Remove-Item -Path $StopMarker -Force -ErrorAction SilentlyContinue }
if ($Watchdog -and (StoppedByUser)) { exit 0 }
if (-not $Watchdog) { ClearStopped }   # an explicit start (sign-in, `relaymote tray`) means you want it running

function Settings {
  $s = @{ port = 8788; appPort = 8790 }
  try {
    $j = Get-Content (Join-Path $Data 'settings.json') -Raw | ConvertFrom-Json
    if ($j.port) { $s.port = [int]$j.port }
    if ($j.appPort) { $s.appPort = [int]$j.appPort }
  } catch {}
  return $s
}
function Token {
  try { return (Get-Content (Join-Path $Data 'mobile\secret.json') -Raw | ConvertFrom-Json).token } catch { return '' }
}
function Node {
  if ($env:RELAYMOTE_NODE -and (Test-Path $env:RELAYMOTE_NODE)) { return $env:RELAYMOTE_NODE }
  foreach ($c in @((Join-Path $Root 'node.exe'), (Join-Path $Root 'node\node.exe'), (Join-Path $Root 'runtime\node.exe'))) { if (Test-Path $c) { return $c } }
  $n = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $n) { $n = Join-Path $env:ProgramFiles 'nodejs\node.exe' }
  return $n
}
function Health {
  $s = Settings
  try {
    $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 "http://127.0.0.1:$($s.port)/api/health"
    if ($r.StatusCode -eq 200) { $j = $r.Content | ConvertFrom-Json; if ($j.app -eq 'relaymote') { return $j } }
  } catch {}
  return $null
}
function Healthy { return [bool](Health) }
# followClaude (Settings): Relaymote runs only while Claude Desktop does. The tray starts it when claude.exe
# appears; the daemon stops itself after Desktop exits (and after its account sync).
function FollowClaude { try { return ((Get-Content (Join-Path $Data 'settings.json') -Raw | ConvertFrom-Json).followClaude -eq $true) } catch { return $false } }
function ClaudeUp { return [bool](Get-Process -Name claude -ErrorAction SilentlyContinue) }
function Wanted { return (-not (FollowClaude)) -or (ClaudeUp) }
function StartDaemon {
  if (Healthy) { return }
  if (StoppedByUser) { return }
  # Through run-daemon.cmd, like every other start path: it rotates state\daemon-stdio.log at 10 MB,
  # writes a launch and an exit line, and keeps node's stderr - the only record of a hard crash.
  New-Item -ItemType Directory -Force $State | Out-Null
  $p = New-Object System.Diagnostics.ProcessStartInfo
  $p.FileName = Join-Path $env:SystemRoot 'System32\cmd.exe'
  $p.Arguments = '/d /c "' + (Join-Path $PSScriptRoot 'run-daemon.cmd') + '"'
  $p.EnvironmentVariables['RELAYMOTE_NODE'] = (Node)
  $p.WorkingDirectory = $env:USERPROFILE
  $p.UseShellExecute = $false
  $p.CreateNoWindow = $true
  [System.Diagnostics.Process]::Start($p) | Out-Null
}
function StopDaemon {
  $s = Settings
  try { Invoke-WebRequest -UseBasicParsing -Method Post -TimeoutSec 5 "http://127.0.0.1:$($s.port)/api/shutdown" | Out-Null } catch {}
}
function OpenApp([string]$hash) {
  $s = Settings
  $url = "http://127.0.0.1:$($s.appPort)/?k=" + [uri]::EscapeDataString((Token)) + $hash
  Start-Process $url
}

$icon = New-Object System.Windows.Forms.NotifyIcon
$png = Join-Path $Root 'assets\tray.png'
if (Test-Path $png) { $bmp = New-Object System.Drawing.Bitmap $png; $icon.Icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon()) }
else { $icon.Icon = [System.Drawing.SystemIcons]::Application }
$icon.Text = 'Relaymote'
$icon.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$status = $menu.Items.Add('Starting...'); $status.Enabled = $false
[void]$menu.Items.Add('-')
$menu.Items.Add('Open Relaymote', $null, { OpenApp '' }) | Out-Null
$menu.Items.Add('Pair a phone (QR code)', $null, { OpenApp '#pair' }) | Out-Null
$menu.Items.Add('Settings', $null, { OpenApp '#settings' }) | Out-Null
$fix = $menu.Items.Add('Connect Claude Desktop...', $null, { OpenApp '#desktop' }); $fix.Visible = $false
[void]$menu.Items.Add('-')
$menu.Items.Add('Restart Relaymote', $null, { ClearStopped; StopDaemon; Start-Sleep -Seconds 3; StartDaemon }) | Out-Null
$menu.Items.Add('Quit (stop Relaymote)', $null, {
  MarkStopped; StopDaemon; $icon.Visible = $false; $icon.Dispose(); [System.Windows.Forms.Application]::Exit()
}) | Out-Null
$icon.ContextMenuStrip = $menu
$icon.add_MouseDoubleClick({ OpenApp '' })
$icon.add_BalloonTipClicked({ OpenApp '#desktop' })
$script:warned = $false

if (Wanted) { StartDaemon }

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 20000
$timer.add_Tick({
  $h = Health
  if (-not $h -and (StoppedByUser)) { $status.Text = 'Relaymote is stopped (Restart Relaymote to start it)'; $icon.Text = 'Relaymote - stopped'; $fix.Visible = $false; return }
  if (-not $h -and -not (Wanted)) { $status.Text = 'Relaymote is asleep - it starts when Claude Desktop opens'; $icon.Text = 'Relaymote - waiting for Claude Desktop'; $fix.Visible = $false; return }
  if (-not $h) { $status.Text = 'Relaymote stopped - restarting'; $icon.Text = 'Relaymote - restarting'; $fix.Visible = $false; StartDaemon; return }
  if ($h.cdp -eq $false) {
    $status.Text = 'Claude Desktop not connected'; $icon.Text = 'Relaymote - Claude Desktop not connected'; $fix.Visible = $true
    if (-not $script:warned) {
      $icon.ShowBalloonTip(10000, 'Relaymote', "Claude Desktop's debugger is off, so Relaymote can read sessions but not send or resume. Click to set it up.", [System.Windows.Forms.ToolTipIcon]::Warning)
      $script:warned = $true
    }
  } else {
    $status.Text = 'Relaymote is running'; $icon.Text = 'Relaymote - running'; $fix.Visible = $false; $script:warned = $false
  }
})
$timer.Start()
# Start within seconds of Claude Desktop opening, not on the next 20-second health poll.
$script:wasUp = $false
$follow = New-Object System.Windows.Forms.Timer
$follow.Interval = 3000
$follow.add_Tick({
  if (-not (FollowClaude)) { return }
  $up = ClaudeUp
  if ($up -and -not $script:wasUp -and -not (StoppedByUser)) { StartDaemon; $status.Text = 'Relaymote is running'; $icon.Text = 'Relaymote - running' }
  $script:wasUp = $up
})
$follow.Start()
$status.Text = $(if (Wanted) { 'Relaymote is running' } else { 'Relaymote is asleep - it starts when Claude Desktop opens' })

[System.Windows.Forms.Application]::Run()
