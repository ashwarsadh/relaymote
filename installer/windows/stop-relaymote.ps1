# stop-relaymote.ps1 - stop the Relaymote that runs from THIS folder, so its files can be replaced or removed.
# Called by the installer before an upgrade and by the uninstaller (with -Unregister).
# Leaves the data folder (~\.relaymote) alone.
param([switch]$Unregister)
$ErrorActionPreference = 'SilentlyContinue'
$Root = $PSScriptRoot
$Node = Join-Path $Root 'runtime\node.exe'
$Cli = Join-Path $Root 'bin\relaymote.js'

# 1. The tray restarts the daemon every 20 s, so it goes first.
$tray = (Join-Path $Root 'scripts\tray.ps1').ToLower()
Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains($tray) } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

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
$exe = $Node.ToLower()
$left = $null
for ($i = 0; $i -lt 20; $i++) {
  $left = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.ToLower() -eq $exe })
  if ($left.Count -eq 0) { break }
  Start-Sleep -Milliseconds 500
}
foreach ($p in $left) { Stop-Process -Id $p.ProcessId -Force }
exit 0
