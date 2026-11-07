'use strict';
// alive-timeout.js — a timeout that gives the event loop a moment to run before it declares failure.
// 07-Nov, Ashwar: the phone said "link to Relaymote is off" though nobody touched Claude Desktop. The link was up. With
// this process's own event loop stalled past 4 s, a plain timer runs BEFORE the socket is read, so an answer that had
// already arrived was thrown away as "cdp probe timeout" (replayed: 5 s block, answer sent in 3 ms, timeout wins).
// The second timer starts only once the stall is over, so the waiting answer is read first.
const SETTLE_MS = 500;
function aliveTimeout(ms, fire) {
  let t = setTimeout(() => { t = setTimeout(fire, SETTLE_MS); if (t.unref) t.unref(); }, ms);
  if (t.unref) t.unref();
  return () => clearTimeout(t);
}
module.exports = { aliveTimeout };
