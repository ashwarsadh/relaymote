'use strict';
// follow.js — followClaude: Relaymote lives only while Claude Desktop does (Windows, with the tray).
//
// The tray starts the daemon when claude.exe appears. This decides when the daemon stops: once it
// has SEEN Desktop running and Desktop has been gone for GONE_MS (a Desktop update restarts faster),
// with no Relaymote task running, it runs the exit-window account sync — every account can be written
// only while Desktop is closed — and then stops, unless Desktop came back during the sync. A daemon
// started with Desktop closed (`baton start`, the watchdog) stays up until Desktop has come and gone.

const GONE_MS = 10000;

/** deps: { enabled(), claudeUp() -> true|false|null, busy() -> string|null, sync() -> Promise<string>, stop(), log(msg), now() } */
function makeFollow(deps) {
  const now = deps.now || Date.now;
  let seen = false, goneAt = null, waiting = null, stopping = false, stopped = false;
  async function tick() {
    if (stopped || stopping || !deps.enabled()) return 'off';
    const up = await deps.claudeUp();
    if (up === null) return 'unknown';
    if (up) { seen = true; goneAt = null; waiting = null; return 'up'; }
    if (!seen) return 'never-seen';
    if (goneAt === null) { goneAt = now(); return 'gone'; }
    if (now() - goneAt < GONE_MS) return 'gone';
    const busy = deps.busy();
    if (busy) { if (waiting !== busy) deps.log('Claude Desktop closed, waiting to stop — ' + busy); waiting = busy; return 'busy'; }
    stopping = true;
    try {
      const s = await deps.sync();
      if (s) deps.log('exit sync: ' + s);
    } catch (e) { deps.log('exit sync failed: ' + e.message); }
    if (await deps.claudeUp()) { stopping = false; goneAt = null; deps.log('Claude Desktop is back — staying up'); return 'back'; }
    stopped = true;
    deps.log('Claude Desktop closed — stopping Relaymote; the tray starts it again when Desktop opens');
    deps.stop();
    return 'stopped';
  }
  return { tick, state: () => ({ seen, goneAt, waiting, stopping, stopped }) };
}

module.exports = { makeFollow, GONE_MS };
