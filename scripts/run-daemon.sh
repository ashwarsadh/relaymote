#!/bin/sh
# run-daemon.sh - start the Relaymote daemon so that what node writes when it dies is kept.
# The macOS/Linux twin of run-daemon.cmd (see lib/launch.js for why): rotate the capture at 10 MB
# before node starts (one generation kept), write a launch line, append node's STDERR only, then an
# exit line with the code. A launchd or systemd --user unit can run this script directly.
#
# Environment: RELAYMOTE_NODE, RELAYMOTE_HOME / RELAYMOTE_STATE_DIR, RELAYMOTE_DAEMON_ENTRY (tests),
# RELAYMOTE_STDIO_MAX_BYTES (tests).

ROOT=$(cd "$(dirname "$0")/.." && pwd)
if [ -n "$RELAYMOTE_STATE_DIR" ]; then STATE="$RELAYMOTE_STATE_DIR"
elif [ -n "$RELAYMOTE_HOME" ]; then STATE="$RELAYMOTE_HOME/state"
else STATE="$HOME/.relaymote/state"; fi
NODE="${RELAYMOTE_NODE:-node}"
ENTRY="${RELAYMOTE_DAEMON_ENTRY:-$ROOT/server.js}"
MAX="${RELAYMOTE_STDIO_MAX_BYTES:-10485760}"
LOG="$STATE/daemon-stdio.log"

mkdir -p "$STATE"
# A watchdog (cron, launchd StartInterval) passes --watchdog: it must not undo `relaymote stop`.
if [ "$1" = "--watchdog" ] && [ -f "$STATE/stopped-by-user.json" ]; then exit 0; fi
if [ -f "$LOG" ]; then
  SIZE=$(wc -c < "$LOG" | tr -d ' ')
  if [ "$SIZE" -gt "$MAX" ]; then mv -f "$LOG" "$LOG.1"; fi
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] --- launching $ENTRY ---" >> "$LOG"
"$NODE" "$ENTRY" 2>> "$LOG"
RC=$?
echo "[$(date '+%Y-%m-%d %H:%M:%S')] --- daemon exited with code $RC ---" >> "$LOG"
exit $RC
