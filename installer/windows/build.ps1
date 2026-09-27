# build.ps1 - build the Windows installer (Inno Setup 6) and a portable zip for Relaymote.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File installer\windows\build.ps1 [-NodeVersion 22.x.y] [-RequireInstaller]
#   (or: npm run build:win)
#
# Output in dist\:
#   Relaymote-Setup-<version>-x64.exe          per-user installer, no admin needed
#   Relaymote-<version>-win-x64-portable.zip   unzip anywhere, run start-relaymote.cmd or relaymote.cmd
#
# A portable Node.js (latest 22.x LTS unless -NodeVersion is given) is downloaded from nodejs.org
# and checked against the release's SHASUMS256.txt before it is bundled. Without Inno Setup the
# script still builds the portable zip and says so; -RequireInstaller turns that into an error (CI).
param(
  [string]$NodeVersion = '',
  [int]$NodeMajor = 22,
  [switch]$RequireInstaller,
  [switch]$SkipInstaller
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.IO.Compression.FileSystem

$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Dist = Join-Path $Repo 'dist'
$Cache = Join-Path $Dist 'cache'
$Stage = Join-Path $Dist 'build\win\Relaymote'
$Version = (Get-Content (Join-Path $Repo 'package.json') -Raw | ConvertFrom-Json).version
function Say($m) { Write-Host "[build-win] $m" }

# --- 1. Node.js runtime, verified -------------------------------------------------------------
function Get-Text($url) { return [string](Invoke-WebRequest -UseBasicParsing $url).Content }
New-Item -ItemType Directory -Force $Cache | Out-Null
$base = 'https://nodejs.org/dist'
if (-not $NodeVersion) {
  $latest = Get-Text "$base/latest-v$NodeMajor.x/SHASUMS256.txt"
  if ($latest -notmatch "node-v($NodeMajor\.\d+\.\d+)-win-x64\.zip") { throw "could not find the latest Node $NodeMajor.x release" }
  $NodeVersion = $Matches[1]
}
$nodeName = "node-v$NodeVersion-win-x64"
$zip = Join-Path $Cache "$nodeName.zip"
$sums = Get-Text "$base/v$NodeVersion/SHASUMS256.txt"
$line = ($sums -split "`r?`n") | Where-Object { $_ -match "^[0-9a-f]{64}\s+$([regex]::Escape($nodeName)).zip$" } | Select-Object -First 1
if (-not $line) { throw "SHASUMS256.txt for v$NodeVersion has no entry for $nodeName.zip" }
$expected = ($line -split '\s+')[0].ToUpper()
if (-not (Test-Path $zip) -or (Get-FileHash $zip -Algorithm SHA256).Hash -ne $expected) {
  Say "downloading $nodeName.zip"
  Invoke-WebRequest -UseBasicParsing "$base/v$NodeVersion/$nodeName.zip" -OutFile $zip
}
$actual = (Get-FileHash $zip -Algorithm SHA256).Hash
if ($actual -ne $expected) { Remove-Item -LiteralPath $zip -Force; throw "SHA256 mismatch for $nodeName.zip: expected $expected, got $actual" }
Say "Node $NodeVersion verified (sha256 $($expected.Substring(0, 16))...)"

# --- 2. Stage the app -------------------------------------------------------------------------
if (-not $Stage.EndsWith('\dist\build\win\Relaymote')) { throw "unexpected stage path $Stage" }
if (Test-Path $Stage) { Remove-Item -LiteralPath $Stage -Recurse -Force }
New-Item -ItemType Directory -Force $Stage | Out-Null
# Everything at the top level ships except development-only folders and files.
$skip = @('.git', '.github', '.claude', '.graphify', 'node_modules', 'dist', 'installer', 'test', 'docs', 'scratchpad', '.gitignore', '.gitattributes', '.env')
Get-ChildItem -LiteralPath $Repo -Force | Where-Object { $skip -notcontains $_.Name -and $_.Name -notlike '*.log' -and $_.Name -notlike '*.bak*' } | ForEach-Object {
  Copy-Item -LiteralPath $_.FullName -Destination $Stage -Recurse -Force
}
Push-Location $Stage
try {
  & npm ci --omit=dev --no-audit --no-fund --loglevel=error
  if ($LASTEXITCODE -ne 0) { throw "npm ci failed ($LASTEXITCODE)" }
} finally { Pop-Location }

$rt = Join-Path $Stage 'runtime'
New-Item -ItemType Directory -Force $rt | Out-Null
$z = [System.IO.Compression.ZipFile]::OpenRead($zip)
try {
  foreach ($e in $z.Entries) {
    if ($e.FullName -eq "$nodeName/node.exe") { [System.IO.Compression.ZipFileExtensions]::ExtractToFile($e, (Join-Path $rt 'node.exe'), $true) }
    if ($e.FullName -eq "$nodeName/LICENSE") { [System.IO.Compression.ZipFileExtensions]::ExtractToFile($e, (Join-Path $rt 'LICENSE-node.txt'), $true) }
  }
} finally { $z.Dispose() }
if (-not (Test-Path (Join-Path $rt 'node.exe'))) { throw 'node.exe missing from the Node zip' }

# Launchers. CRLF line endings: cmd.exe misreads LF-only batch files.
function Write-Cmd($name, [string[]]$lines) { [IO.File]::WriteAllText((Join-Path $Stage $name), (($lines -join "`r`n") + "`r`n"), [Text.Encoding]::ASCII) }
Write-Cmd 'relaymote.cmd' @('@echo off', 'rem relaymote.cmd - the Relaymote command line, run with the Node.js bundled next to it.', '"%~dp0runtime\node.exe" "%~dp0bin\relaymote.js" %*')
Write-Cmd 'relaymote-setup.cmd' @('@echo off', 'title Relaymote setup', 'call "%~dp0relaymote.cmd" setup %*', 'echo.', 'pause')
Write-Cmd 'relaymote-pair.cmd' @('@echo off', 'title Relaymote - Pair a phone', 'call "%~dp0relaymote.cmd" pair', 'echo.', 'pause')
Write-Cmd 'relaymote-status.cmd' @('@echo off', 'title Relaymote - Status', 'call "%~dp0relaymote.cmd" status', 'echo.', 'pause')
Write-Cmd 'start-relaymote.cmd' @('@echo off', 'rem Portable start: runs Relaymote in the background and opens it in your browser.', 'call "%~dp0relaymote.cmd" open')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'stop-relaymote.ps1') -Destination $Stage
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'relaymote.ico') -Destination $Stage

& (Join-Path $rt 'node.exe') (Join-Path $Stage 'bin\relaymote.js') --version
if ($LASTEXITCODE -ne 0) { throw 'the staged CLI does not run' }

# --- 3. Portable zip --------------------------------------------------------------------------
$portable = Join-Path $Dist "Relaymote-$Version-win-x64-portable.zip"
if (Test-Path $portable) { Remove-Item -LiteralPath $portable -Force }
[System.IO.Compression.ZipFile]::CreateFromDirectory($Stage, $portable, [System.IO.Compression.CompressionLevel]::Optimal, $true)
Say "portable: $portable"

# --- 4. Installer -----------------------------------------------------------------------------
if ($SkipInstaller) { Say 'installer skipped (-SkipInstaller)'; exit 0 }
$iscc = @("${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe", "$env:ProgramFiles\Inno Setup 6\ISCC.exe", "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe") |
  Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $iscc) { $c = Get-Command ISCC.exe -ErrorAction SilentlyContinue; if ($c) { $iscc = $c.Source } }
if (-not $iscc) {
  if ($RequireInstaller) { throw 'Inno Setup 6 (ISCC.exe) not found' }
  Say 'Inno Setup 6 not found - built the portable zip only. Install it from https://jrsoftware.org/isdl.php to build the installer.'
  exit 0
}
& $iscc /Qp "/DAppVersion=$Version" "/DSourceDir=$Stage" "/DOutputDir=$Dist" (Join-Path $PSScriptRoot 'relaymote.iss')
if ($LASTEXITCODE -ne 0) { throw "ISCC failed ($LASTEXITCODE)" }
Say "installer: $(Join-Path $Dist "Relaymote-Setup-$Version-x64.exe")"
