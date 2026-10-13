# stop-relaymote.ps1 - stop the Relaymote that runs from THIS folder, so its files can be replaced or removed.
# Called by the installer before an upgrade and by the uninstaller (with -Unregister).
# Leaves the data folder (~\.relaymote) alone.
#
# -ForUpdate (the installer's PrepareToInstall, BEFORE anything is deleted): keep stopping until every file in the
#   folder can be renamed, i.e. nothing holds it open, for up to -WaitSeconds. Exit 3 (and name the file) if one stays
#   locked, so setup aborts with the old install intact. 13-Oct-2026: a tray restarted by the watchdog held
#   assets\tray.png, setup aborted AFTER [InstallDelete] had emptied bin\ lib\ runtime\ ..., and the rollback could
#   not bring them back: Relaymote stayed down until someone reinstalled by hand.
# -Root: the install folder (default: this script's folder; the installer runs a fresh copy from {tmp}).
param([switch]$Unregister, [switch]$ForUpdate, [string]$Root = $PSScriptRoot, [int]$WaitSeconds = 20)
$ErrorActionPreference = 'SilentlyContinue'
$Node = Join-Path $Root 'runtime\node.exe'
$Cli = Join-Path $Root 'bin\relaymote.js'
$norm = { param($s) ([string]$s).ToLower().Replace('/', '\') }

# 1. The tray restarts the daemon every 20 s, so it goes first; so do the hidden wscript wrappers that started it.
function StopTray {
  $tray = & $norm (Join-Path $Root 'scripts\tray.ps1')
  $wrap = & $norm (Join-Path $Root 'scripts\run-hidden.vbs')
  $n = 0
  Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe' OR Name='wscript.exe'" |
    Where-Object { $c = & $norm $_.CommandLine; $c.Contains($tray) -and ($_.Name -ne 'wscript.exe' -or $c.Contains($wrap)) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force; $n++ }
  return $n
}
[void](StopTray)

# 2. Ask the daemon to shut down (relaymote stop only talks to a Relaymote, never to another program on the port).
if ((Test-Path $Node) -and (Test-Path $Cli)) {
  & $Node $Cli stop | Out-Null
  if ($Unregister) {
    & $Node $Cli autostart remove | Out-Null
    & $Node $Cli mcp remove | Out-Null
    & $Node $Cli hooks remove | Out-Null
  }
}

# 3. Anything still running on this folder's node.exe (daemon, MCP server) holds files open.
function StopNode {
  $exe = & $norm $Node
  $left = $null
  for ($i = 0; $i -lt 20; $i++) {
    $left = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.ExecutablePath -and (& $norm $_.ExecutablePath) -eq $exe })
    if ($left.Count -eq 0) { break }
    Start-Sleep -Milliseconds 500
  }
  foreach ($p in $left) { Stop-Process -Id $p.ProcessId -Force }
}
StopNode
if (-not $ForUpdate) { exit 0 }

# 4. -ForUpdate: prove no process holds any file. Opening with FileShare None fails while ANY other handle is
#    open (a loaded tray.png, a running node.exe), which is exactly what makes setup fail later; nothing on disk
#    changes. A tray that comes back is stopped again.
function FirstLocked {
  foreach ($f in Get-ChildItem -LiteralPath $Root -Recurse -File -Force) {
    try { $h = [IO.File]::Open($f.FullName, 'Open', 'Read', 'None'); $h.Close() }
    catch [System.UnauthorizedAccessException] { }
    catch { return $f.FullName }
  }
  return $null
}
$deadline = (Get-Date).AddSeconds($WaitSeconds)
do {
  $locked = FirstLocked
  if (-not $locked) { exit 0 }
  [void](StopTray); StopNode
  Start-Sleep -Milliseconds 700
} while ((Get-Date) -lt $deadline)
[Console]::Error.WriteLine("locked: $locked")
Set-Content -LiteralPath (Join-Path $env:TEMP 'relaymote-update-locked.txt') -Value $locked -Encoding UTF8
exit 3
