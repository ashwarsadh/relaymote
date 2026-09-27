# migrate-from-baton.ps1 - move an install from before v0.2.27 (called Baton) to the Relaymote names.
#
#   powershell -ExecutionPolicy Bypass -File migrate-from-baton.ps1 -Installer <Relaymote-Setup-x.y.z-x64.exe>
#
# Old -> new: %LOCALAPPDATA%\Programs\Baton -> ...\Programs\Relaymote, ~\.baton -> ~\.relaymote, tasks
# "Baton" / "Baton Watchdog" / "Baton Update" and the Run value "Baton" -> the Relaymote ones, the MCP
# server "baton" -> "relaymote" (only if the old one was registered).
#
# Order matters: the old tasks are DISABLED (not deleted) before anything moves, so the old watchdog cannot
# restart the old copy on an empty data folder. The old names are removed only after the new copy answers
# /api/health as "relaymote" from the new folder. Any failure before that puts everything back.
# Prints one line of JSON at the end.
param([Parameter(Mandatory = $true)][string]$Installer)
$ErrorActionPreference = 'Stop'
$Old = Join-Path $env:LOCALAPPDATA 'Programs\Baton'
$New = Join-Path $env:LOCALAPPDATA 'Programs\Relaymote'
$OldData = Join-Path $env:USERPROFILE '.baton'
$NewData = Join-Path $env:USERPROFILE '.relaymote'
$OldTasks = @('Baton', 'Baton Watchdog', 'Baton Update')
$RunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$out = [ordered]@{ ok = $false; steps = @(); removed = @(); errors = @() }
function Step($s) { $script:out.steps += $s; Write-Host "- $s" }
function Health {
  try { return Invoke-RestMethod -Uri 'http://127.0.0.1:8798/api/health' -TimeoutSec 3 } catch { return $null }
}

if (-not (Test-Path $Installer)) { throw "installer not found: $Installer" }
if (-not (Test-Path $OldData)) { throw "nothing to migrate: $OldData does not exist" }
if (Test-Path $NewData) { throw "$NewData already exists; move or remove it first (nothing was changed)" }

$disabled = @()
$moved = $false
try {
  foreach ($t in $OldTasks) {
    if (Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue) { Disable-ScheduledTask -TaskName $t | Out-Null; $disabled += $t }
  }
  Step "disabled old tasks: $($disabled -join ', ')"
  $runVal = (Get-ItemProperty -Path $RunKey -Name 'Baton' -ErrorAction SilentlyContinue).Baton

  $stop = Join-Path $Old 'stop-baton.ps1'
  if (Test-Path $stop) { & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $stop | Out-Null }
  for ($i = 0; $i -lt 20 -and (Health); $i++) { Start-Sleep -Milliseconds 500 }
  if (Health) { throw 'the old copy is still answering on port 8798 after stop-baton.ps1' }
  Step 'stopped the old copy'

  Move-Item -LiteralPath $OldData -Destination $NewData
  $moved = $true
  Step "moved $OldData -> $NewData"
  $sf = Join-Path $NewData 'settings.json'
  if (Test-Path $sf) {
    $txt = [IO.File]::ReadAllText($sf)
    $txt = $txt.Replace('\\.baton', '\\.relaymote').Replace('/.baton', '/.relaymote').Replace('Programs\\Baton', 'Programs\\Relaymote')
    [IO.File]::WriteAllText($sf, $txt, (New-Object Text.UTF8Encoding $false))
    Step 'rewrote paths in settings.json'
  }

  $log = Join-Path $env:TEMP 'relaymote-migrate-setup.log'
  $p = Start-Process -FilePath $Installer -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', "/DIR=`"$New`"", '/TASKS=addtopath', "/LOG=`"$log`"") -Wait -PassThru
  if ($p.ExitCode -ne 0) { throw "installer exited $($p.ExitCode) (log: $log)" }
  $node = Join-Path $New 'runtime\node.exe'; $cli = Join-Path $New 'bin\relaymote.js'
  if (-not (Test-Path $cli)) { throw "the installer did not put $cli in place" }
  Step "installed $(& $node $cli --version) to $New"

  & $node $cli autostart | Out-Null
  & $node $cli start | Out-Null
  $h = $null
  for ($i = 0; $i -lt 30; $i++) { $h = Health; if ($h -and $h.app -eq 'relaymote') { break }; Start-Sleep -Seconds 1 }
  if (-not $h -or $h.app -ne 'relaymote') { throw 'the new copy did not answer /api/health as "relaymote"' }
  $exe = (Get-CimInstance Win32_Process -Filter "ProcessId=$($h.pid)").ExecutablePath
  if (-not $exe -or -not $exe.ToLower().StartsWith($New.ToLower())) { throw "the daemon answering is not the new copy ($exe)" }
  $newTasks = @('Relaymote', 'Relaymote Watchdog') | Where-Object { Get-ScheduledTask -TaskName $_ -ErrorAction SilentlyContinue }
  $newRun = (Get-ItemProperty -Path $RunKey -Name 'Relaymote' -ErrorAction SilentlyContinue).Relaymote
  if (-not ($newTasks -contains 'Relaymote Watchdog') -or (-not ($newTasks -contains 'Relaymote') -and -not $newRun)) { throw 'the new autostart is not registered' }
  & $node $cli tray | Out-Null
  Step "verified: pid $($h.pid) from $exe; autostart: $($newTasks -join ', ')$(if ($newRun) { ', Run key' })"
} catch {
  $out.errors += "$_"
  Write-Host "FAILED: $_ - putting everything back" -ForegroundColor Red
  $ns = Join-Path $New 'stop-relaymote.ps1'
  if (Test-Path $ns) { & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ns -Unregister | Out-Null }
  if ($moved -and (Test-Path $NewData) -and -not (Test-Path $OldData)) { Move-Item -LiteralPath $NewData -Destination $OldData }
  foreach ($t in $disabled) { Enable-ScheduledTask -TaskName $t | Out-Null }
  if ($disabled -contains 'Baton Watchdog') { Start-ScheduledTask -TaskName 'Baton Watchdog' }
  $out | ConvertTo-Json -Compress
  exit 1
}

# The new copy runs: now, and only now, the old names go.
foreach ($t in $disabled) { Unregister-ScheduledTask -TaskName $t -Confirm:$false; $out.removed += "task $t" }
if ($runVal) { Remove-ItemProperty -Path $RunKey -Name 'Baton'; $out.removed += 'Run value Baton' }
$path = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($path) {
  $parts = $path.Split(';') | Where-Object { $_ -and ($_.TrimEnd('\') -ne $Old) }
  $np = $parts -join ';'
  if ($np -ne $path) { [Environment]::SetEnvironmentVariable('Path', $np, 'User'); $out.removed += "PATH entry $Old" }
}
try {
  # node, not ConvertFrom-Json: Windows PowerShell 5 refuses ~/.claude.json when two project keys differ only
  # in case (measured: "D:/..." and "d:/..."), which would silently skip this step.
  $node = Join-Path $New 'runtime\node.exe'
  $hasOld = & $node -e "try{const j=require(require('os').homedir()+'/.claude.json');process.stdout.write(j.mcpServers&&j.mcpServers.baton?'1':'0')}catch(e){process.stdout.write('0')}"
  if ($hasOld -eq '1') {
    & claude mcp remove --scope user baton | Out-Null
    & (Join-Path $New 'runtime\node.exe') (Join-Path $New 'bin\relaymote.js') mcp | Out-Null
    $out.removed += 'MCP server baton (relaymote registered)'
  }
} catch { $out.errors += "MCP: $_" }
if (Test-Path $Old) {
  try { Remove-Item -LiteralPath $Old -Recurse -Force; $out.removed += $Old } catch { $out.errors += "could not remove ${Old}: $_" }
}
$out.ok = $true
$out | ConvertTo-Json -Compress
