'use strict';
// pushhealth.js — say so when phone alerts stop reaching anyone.
//
// Web push is silent when it breaks: the phone's browser drops its subscription, the push service
// answers 404/410 on the next alert, that subscription is pruned, and every alert after it reaches no
// phone while the log looks normal. The private tool this was ported from lost three days of alerts
// exactly that way. This watches for "no phone subscribed" and raises it over a DIFFERENT channel:
// notifications.healthAlarm (ntfy / webhook / command), or the backup channel when that is unset.
//
// Discipline — an alarm, never a heartbeat:
//   - CHECK on a timer, SEND on a transition: OK -> DEAD after GRACE of zero subscriptions, and
//     DEAD -> OK ("back on") when a phone subscribes again. A condition that persists sends nothing...
//   - ...except one re-assert while DEAD, after REASSERT (24 h) — the only timer-driven send.
//   - State advances ONLY when the send succeeded, so a failed alarm is retried on the next check.
//     The state that decides to send and the state that records having sent are the same object
//     (`level`), so a failed send cannot be lost between two stores.
//   - Nothing is watched until a phone has subscribed at least once: an install that never set up
//     push has nothing to lose, and alarming there would be noise.
const fs = require('fs');
const path = require('path');
const config = require('../lib/config');

const STATE = path.join(config.MOBILE, 'push-health.json');
const GRACE_MS = 30 * 60 * 1000;
const REASSERT_MS = 24 * 60 * 60 * 1000;
const FRESH = () => ({ level: 'OK', zeroSince: null, alarmedAt: null, dropped: 0 });

function read() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return null; }
}
function write(s) {
  const tmp = STATE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, STATE);
}

// The owner reads this on a phone: this machine's local time, with its zone named.
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function when(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  let zone = '';
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    zone = /^Asia\/(Calcutta|Kolkata)$/.test(tz) ? 'IST'
      : (new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(d).find(x => x.type === 'timeZoneName') || {}).value || '';
  } catch {}
  return `${d.getDate()}-${MON[d.getMonth()]} ${p(d.getHours())}:${p(d.getMinutes())}${zone ? ' ' + zone : ''}`;
}

function deadAlarm(s) {
  const n = s.dropped ? ` ${s.dropped} alert${s.dropped === 1 ? '' : 's'} not delivered.` : '';
  return { title: '⚠️ Relaymote phone alerts are OFF',
           body: `No phone has been subscribed since ${when(s.zeroSince)}, so session alerts are not reaching you.${n} Open Relaymote on your phone once to restore them.` };
}
function okAlarm(count) {
  return { title: '✅ Relaymote phone alerts are back on',
           body: `${count} phone${count === 1 ? '' : 's'} subscribed.` };
}

/**
 * One check. `count` = subscriptions now; `send({title, body})` resolves to { ok, status?, error?,
 * skipped? } (alerts.alarm); `enabled` = the notifications master switch. `seedZeroSince` is used
 * only when the clock starts: push.json's mtime, i.e. when the last subscription went.
 */
async function tick({ count, now = Date.now(), send, log = () => {}, enabled = true, seedZeroSince = null }) {
  const prev = read();
  if (!prev && count === 0) return { action: 'unarmed' };
  let s = prev || FRESH();
  if (count > 0) {
    if (s.level === 'DEAD') {
      if (!enabled) log('push-health: phones back; alerts are switched off, recovery not announced');
      else {
        const r = await trySend(send, okAlarm(count), log);
        if (!r.ok) { write(s); log(`push-health: "back on" FAILED (${why(r)}); retry next check`); return { action: 'recover-failed', status: r.status }; }
        log(`push-health: RECOVERED -> ${count} subscription(s); said so (${why(r)})`);
      }
    }
    if (s.level !== 'OK' || s.zeroSince || s.dropped || !prev) write(FRESH());
    return { action: 'ok' };
  }
  if (!s.zeroSince) s.zeroSince = Math.min(now, seedZeroSince || now);
  const due = s.level === 'OK' ? now - s.zeroSince >= GRACE_MS
                               : now - (s.alarmedAt || 0) >= REASSERT_MS;
  if (!due) { write(s); return { action: 'wait' }; }
  if (!enabled) { write(s); return { action: 'off' }; }
  const r = await trySend(send, deadAlarm(s), log);
  if (r.skipped) {
    // No alarm channel is set up. Said once per outage, not every five minutes.
    if (!s.noChannel) log(`push-health: no phone subscribed since ${new Date(s.zeroSince).toISOString()}, and no alarm channel is set (Settings › Notifications); alerts are going nowhere`);
    s.noChannel = true; write(s);
    return { action: 'no-channel' };
  }
  if (!r.ok) { write(s); log(`push-health: alarm FAILED (${why(r)}); retry next check`); return { action: 'alarm-failed', status: r.status }; }
  const was = s.level;
  s.level = 'DEAD'; s.alarmedAt = now; delete s.noChannel;
  write(s);
  log(`push-health: ${was === 'DEAD' ? 're-asserted' : 'ALARM'} -- 0 subscriptions since ${new Date(s.zeroSince).toISOString()}; said so (${why(r)})`);
  return { action: was === 'DEAD' ? 'reassert' : 'alarm', status: r.status };
}

const why = (r) => [r.kind, r.status ? 'HTTP ' + r.status : null, r.error].filter(Boolean).join(' ') || 'no detail';

async function trySend(send, msg, log) {
  try { const r = await send(msg); return r || { ok: false, status: 0 }; }
  catch (e) { log('push-health: send threw: ' + e.message); return { ok: false, status: 0, error: e.message }; }
}

// An alert that reached no phone. Counted into the next alarm's text; never logged as delivered.
function noteDropped() {
  const s = read();
  if (!s) return;                     // never armed: nothing was lost that anyone set up to receive
  s.dropped = (s.dropped || 0) + 1;
  write(s);
}

module.exports = { tick, noteDropped, read, deadAlarm, okAlarm, when, GRACE_MS, REASSERT_MS, STATE };
