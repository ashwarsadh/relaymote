# register-autostart.ps1 - start Relaymote when you sign in, and bring it back if it dies. No admin needed.
#
# Called by `relaymote autostart [remove|status] [--headless] [--dry-run]`. Prints ONE line of JSON saying
# exactly what was registered, so `relaymote` can record it (state\autostart.json) and heal can describe
# what is really installed instead of guessing.
#
# What it sets up, strongest first, falling back when Windows refuses:
#   1. Task "Relaymote"   - at sign-in (1 minute delay), IgnoreNew, restart on failure 3 times 1 minute
#                        apart, no 72-hour time limit. Logon triggers usually need administrator rights;
#                        when refused, the per-user Run key starts Relaymote at sign-in instead.
#   2. Task "Relaymote Watchdog" - every 10 minutes (a time trigger, which a standard user may register).
#                        It starts the tray (or, headless, the daemon) only if it is not running and you
#                        did not stop Relaymote yourself; the tray's single-instance lock and the daemon's
#                        own "already healthy" check make a second copy exit at once.
#   -Mode headless:    no tray; the daemon itself, through run-daemon.cmd (stderr kept, 10 MB rotation).
#                        Registered as S4U (runs with no window, even before sign-in finishes) when
#                        Windows allows it - that needs administrator rights, so otherwise it falls back
#                        to an ordinary interactive task and says so.
param(
  [ValidateSet('install', 'remove', 'status')][string]$Action = 'install',
  [ValidateSet('tray', 'headless')][string]$Mode = 'tray',
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Vbs = Join-Path $PSScriptRoot 'run-hidden.vbs'
$Tray = Join-Path $PSScriptRoot 'tray.ps1'
$Cmd = Join-Path $PSScriptRoot 'run-daemon.cmd'
$RunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$User = if ($env:USERDOMAIN) { "$env:USERDOMAIN\$env:USERNAME" } else { $env:USERNAME }
$out = [ordered]@{ ok = $false; action = $Action; mode = $Mode; dryRun = [bool]$DryRun; logon = $null; watchdog = $null; s4u = $false; notes = @(); errors = @(); plan = @() }

function TrayArgs([bool]$wait, [bool]$watchdog) {
  $a = "`"$Vbs`" "
  if ($wait) { $a += '--wait ' }
  $a += "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Tray`""
  if ($watchdog) { $a += ' -Watchdog' }
  return $a
}
function DaemonArgs([bool]$hidden, [bool]$watchdog) {
  $tail = if ($watchdog) { ' --watchdog' } else { '' }
  if ($hidden) { return @{ exe = 'wscript.exe'; args = "`"$Vbs`" --wait cmd.exe /d /c `"$Cmd`"$tail" } }
  return @{ exe = 'cmd.exe'; args = "/d /c `"$Cmd`"$tail" }
}
function Settings {
  New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
}
function Register([string]$name, $action, $trigger, [string]$logonType) {
  $p = New-ScheduledTaskPrincipal -UserId $User -LogonType $logonType -RunLevel Limited
  Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings (Settings) -Principal $p -Force | Out-Null
}
function TaskInfo([string]$name) {
  $t = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  if (-not $t) { return $null }
  $i = Get-ScheduledTaskInfo -TaskName $name -ErrorAction SilentlyContinue
  return [ordered]@{ state = "$($t.State)"; logonType = "$($t.Principal.LogonType)"; lastResult = if ($i) { $i.LastTaskResult } else { $null } }
}

try {
  if ($Action -eq 'status') {
    $out.task = TaskInfo 'Relaymote'
    $out.watchdogTask = TaskInfo 'Relaymote Watchdog'
    $out.runKey = (Get-ItemProperty -Path $RunKey -Name 'Relaymote' -ErrorAction SilentlyContinue).Relaymote
    $out.ok = $true
  }
  elseif ($Action -eq 'remove') {
    foreach ($n in @('Relaymote', 'Relaymote Watchdog')) {
      if (Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue) {
        $out.plan += "unregister task $n"
        if (-not $DryRun) { Unregister-ScheduledTask -TaskName $n -Confirm:$false }
      }
    }
    if ((Get-ItemProperty -Path $RunKey -Name 'Relaymote' -ErrorAction SilentlyContinue)) {
      $out.plan += 'remove Run key value Relaymote'
      if (-not $DryRun) { Remove-ItemProperty -Path $RunKey -Name 'Relaymote' }
    }
    $out.ok = $true
  }
  else {
    $headless = $Mode -eq 'headless'
    # --- the sign-in start ---
    if ($headless) { $d = DaemonArgs $false $false; $logonAction = New-ScheduledTaskAction -Execute $d.exe -Argument $d.args }
    else { $logonAction = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument (TrayArgs $true $false) }
    $logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $User
    $logonTrigger.Delay = 'PT1M'
    $types = if ($headless) { @('S4U', 'Interactive') } else { @('Interactive') }
    foreach ($lt in $types) {
      $out.plan += "task Relaymote: at sign-in +1 min, $lt, IgnoreNew, restart 3x/1 min"
      if ($DryRun) { $out.logon = 'task'; $out.s4u = ($lt -eq 'S4U'); break }
      try {
        if ($headless -and $lt -eq 'Interactive') { $d = DaemonArgs $true $false; $logonAction = New-ScheduledTaskAction -Execute $d.exe -Argument $d.args }
        Register 'Relaymote' $logonAction $logonTrigger $lt
        $out.logon = 'task'; $out.s4u = ($lt -eq 'S4U'); break
      } catch {
        $out.errors += "task Relaymote ($lt): $($_.Exception.Message.Trim())"
        if ($lt -eq 'S4U') { $out.notes += 'S4U refused (it needs administrator rights); trying an ordinary task that runs while you are signed in.' }
      }
    }
    if (-not $out.logon) {
      $val = if ($headless) { "wscript.exe `"$Vbs`" cmd.exe /d /c `"$Cmd`"" } else { 'wscript.exe ' + (TrayArgs $false $false) }
      $out.plan += 'Run key HKCU\...\Run\Relaymote (sign-in start, no admin)'
      if (-not $DryRun) { Set-ItemProperty -Path $RunKey -Name 'Relaymote' -Value $val }
      $out.logon = 'runkey'
      $out.notes += 'The sign-in task was refused (logon triggers usually need administrator rights), so the per-user Run key starts Relaymote instead. It has no restart-on-failure of its own; the watchdog task below covers that.'
    } elseif (-not $DryRun -and (Get-ItemProperty -Path $RunKey -Name 'Relaymote' -ErrorAction SilentlyContinue)) {
      Remove-ItemProperty -Path $RunKey -Name 'Relaymote'   # a task now does this job; two starters would race
    }
    # --- the 10-minute watchdog ---
    if ($headless) { $d = DaemonArgs (-not $out.s4u) $true; $wdAction = New-ScheduledTaskAction -Execute $d.exe -Argument $d.args }
    else { $wdAction = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument (TrayArgs $true $true) }
    $wdTrigger = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(10)) -RepetitionInterval (New-TimeSpan -Minutes 10) -RepetitionDuration (New-TimeSpan -Days 3650)
    $wdType = if ($out.s4u) { 'S4U' } else { 'Interactive' }
    $out.plan += "task Relaymote Watchdog: every 10 min, $wdType, IgnoreNew, restart 3x/1 min"
    if ($DryRun) { $out.watchdog = 'task' }
    else {
      try { Register 'Relaymote Watchdog' $wdAction $wdTrigger $wdType; $out.watchdog = 'task' }
      catch {
        $out.errors += "task Relaymote Watchdog: $($_.Exception.Message.Trim())"
        $out.notes += 'The watchdog task was refused, so nothing restarts Relaymote if the tray itself stops; the tray still restarts the daemon every 20 seconds while it runs.'
      }
    }
    $out.ok = [bool]$out.logon
  }
} catch {
  $out.errors += $_.Exception.Message.Trim()
}
$out | ConvertTo-Json -Compress -Depth 5
