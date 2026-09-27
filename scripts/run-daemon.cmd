@echo off
rem run-daemon.cmd - start the Relaymote daemon so that WHAT NODE WRITES WHEN IT DIES IS KEPT.
rem
rem Used by `relaymote start`, the tray and the autostart tasks (see lib/launch.js). A heap-limit abort, a
rem native fault and an out-of-memory message all report on stderr; the daemon's own markers catch
rem every exit it performs itself, but not a hard kill or an abort. This wrapper outlives node, so it
rem can always write the exit line.
rem
rem STDERR ONLY. The daemon's own log (state\relaymote.log) already has stdout; capturing it here too would
rem make this file grow as fast as that log. A healthy daemon leaves this file almost empty.
rem
rem BOUNDED. Rotated here, before node starts (a redirect holds the file open), at 10 MB, one
rem generation kept (daemon-stdio.log.1).
rem
rem Environment: RELAYMOTE_NODE (node.exe to use; default: a bundled node.exe, then PATH),
rem RELAYMOTE_HOME / RELAYMOTE_STATE_DIR (data folder), RELAYMOTE_DAEMON_ENTRY (script to run; tests only),
rem RELAYMOTE_STDIO_MAX_BYTES (rotation size; tests only).
rem
rem FOLLOW CLAUDE. A daemon that stopped because Claude Desktop closed (Settings > Run Relaymote only while
rem Claude Desktop is open) leaves state\follow-sleep.json. This wrapper then waits, checking every 3
rem seconds, and starts the daemon again as soon as claude.exe appears. That is what brings Relaymote back
rem without the tray (headless autostart), instead of the 10-minute watchdog. `relaymote stop` or the tray's
rem Quit (stopped-by-user.json) ends the wait.

setlocal
set "ROOT=%~dp0.."
if defined RELAYMOTE_STATE_DIR (set "STATE=%RELAYMOTE_STATE_DIR%") else if defined RELAYMOTE_HOME (set "STATE=%RELAYMOTE_HOME%\state") else (set "STATE=%USERPROFILE%\.relaymote\state")
set "NODE=node.exe"
if exist "%ROOT%\runtime\node.exe" set "NODE=%ROOT%\runtime\node.exe"
if exist "%ROOT%\node\node.exe" set "NODE=%ROOT%\node\node.exe"
if exist "%ROOT%\node.exe" set "NODE=%ROOT%\node.exe"
if defined RELAYMOTE_NODE set "NODE=%RELAYMOTE_NODE%"
if defined RELAYMOTE_DAEMON_ENTRY (set "ENTRY=%RELAYMOTE_DAEMON_ENTRY%") else (set "ENTRY=%ROOT%\server.js")
if defined RELAYMOTE_STDIO_MAX_BYTES (set "MAX=%RELAYMOTE_STDIO_MAX_BYTES%") else (set "MAX=10485760")
set "LOG=%STATE%\daemon-stdio.log"

if not exist "%STATE%" mkdir "%STATE%"

rem The 10-minute watchdog passes --watchdog: it must not undo `relaymote stop` or the tray's Quit.
if /i "%~1"=="--watchdog" if exist "%STATE%\stopped-by-user.json" exit /b 0

:launch
if exist "%LOG%" for %%A in ("%LOG%") do if %%~zA GTR %MAX% (
  if exist "%LOG%.1" del /q "%LOG%.1"
  move /y "%LOG%" "%LOG%.1" >nul 2>&1
)

echo [%DATE% %TIME%] --- launching %ENTRY% --->> "%LOG%"
"%NODE%" "%ENTRY%" 2>> "%LOG%"
set "RC=%ERRORLEVEL%"
echo [%DATE% %TIME%] --- daemon exited with code %RC% --->> "%LOG%"
if not exist "%STATE%\follow-sleep.json" exit /b %RC%
echo [%DATE% %TIME%] --- asleep until Claude Desktop opens --->> "%LOG%"
:asleep
if exist "%STATE%\stopped-by-user.json" (
  del /q "%STATE%\follow-sleep.json" >nul 2>&1
  exit /b 0
)
"%SystemRoot%\System32\tasklist.exe" /FI "IMAGENAME eq claude.exe" /NH 2>nul | "%SystemRoot%\System32\find.exe" /i "claude.exe" >nul
if errorlevel 1 (
  "%SystemRoot%\System32\PING.EXE" -n 4 127.0.0.1 >nul
  goto asleep
)
del /q "%STATE%\follow-sleep.json" >nul 2>&1
goto launch
