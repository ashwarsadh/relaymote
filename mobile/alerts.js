// alerts.js — get an alert to the phone: web push first, then an optional backup channel.
//
// Web push is not always possible: plain-HTTP modes (Same Wi-Fi, Tailscale without HTTPS) cannot
// subscribe at all, and a phone's browser can have notifications blocked for the site — a setting
// only its owner can clear. Without a second route, "tell me when a session needs me" silently does
// nothing. The backup channel is that second route. It is OFF by default and has three kinds:
//
//   ntfy     POST the text to an ntfy topic URL (https://ntfy.sh/<topic> or your own server)
//   webhook  POST the alert as JSON to any URL (Slack/Discord bridges, home automation, ...)
//   command  run a local command; the alert arrives in BATON_ALERT_* env vars and as JSON on stdin
//
// Rules carried over from the private tool this was ported from:
//   * Push first. The backup is used when no push subscription succeeded, or always if asked.
//   * A RATE CAP across backup sends (notifications.maxPer10Min, default 6). The slot is counted
//     BEFORE sending, so a failed send still uses it, and nothing is ever retried: a channel that
//     answers with an error after delivering (gateways do) would otherwise turn one alert into a
//     storm of duplicates.
//   * The notification switches (enabled / awaiting / done) are enforced by the CALLER, so they
//     govern push and backup alike.
'use strict';
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const { URL } = require('url');
const config = require('../lib/config');

let push = require('./push');
const KINDS = ['off', 'ntfy', 'webhook', 'command'];
const WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_CAP = 6;
const TIMEOUT_MS = 15000;

const recent = [];   // timestamps of backup sends inside the window (the rate cap)

function settings() {
  const n = config.get().notifications || {};
  const b = n.backup || {};
  return {
    kind: KINDS.includes(b.kind) ? b.kind : 'off',
    url: String(b.url || '').trim(),
    command: String(b.command || '').trim(),
    always: b.always === true,
    maxPer10Min: Number(n.maxPer10Min) > 0 ? Math.floor(Number(n.maxPer10Min)) : DEFAULT_CAP,
  };
}

/** True when another backup send fits under the cap. Prunes the window as a side effect. */
function underCap(cap, now = Date.now()) {
  while (recent.length && recent[0] <= now - WINDOW_MS) recent.shift();
  return recent.length < cap;
}

function textOf(evt) {
  return [evt.title, evt.body].filter(Boolean).join('\n');
}

function httpPost(target, body, headers) {
  return new Promise(resolve => {
    let u;
    try { u = new URL(target); } catch { return resolve({ ok: false, status: 0, error: 'bad url' }); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return resolve({ ok: false, status: 0, error: 'url must be http(s)' });
    const lib = u.protocol === 'https:' ? https : http;
    const buf = Buffer.from(body, 'utf8');
    const req = lib.request({
      method: 'POST', hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search,
      timeout: TIMEOUT_MS,
      headers: { 'Content-Length': buf.length, 'User-Agent': 'Relaymote', ...headers },
    }, res => {
      res.resume();
      res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode }));
    });
    req.on('error', e => resolve({ ok: false, status: 0, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, error: 'timeout' }); });
    req.end(buf);
  });
}

// HTTP header values must be Latin-1; ntfy reads RFC 2047 encoded words for anything else.
const headerSafe = (s) => /^[\x20-\x7e]*$/.test(s) ? s : '=?UTF-8?B?' + Buffer.from(s, 'utf8').toString('base64') + '?=';

function runCommand(cmd, evt) {
  return new Promise(resolve => {
    // The command line is the owner's own setting and runs as written. The alert text is NEVER
    // put on the command line: it travels in env vars and on stdin, so a session title cannot
    // inject shell syntax.
    let child;
    try {
      child = spawn(cmd, { shell: true, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'], env: {
        ...process.env,
        BATON_ALERT_TITLE: String(evt.title || ''), BATON_ALERT_BODY: String(evt.body || ''),
        BATON_ALERT_KIND: String(evt.kind || ''), BATON_ALERT_URL: String(evt.url || ''),
      } });
    } catch (e) { return resolve({ ok: false, error: e.message }); }
    let err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch {} resolve({ ok: false, error: 'timeout' }); }, TIMEOUT_MS);
    child.stderr.on('data', d => { if (err.length < 400) err += d; });
    child.on('error', e => { clearTimeout(timer); resolve({ ok: false, error: e.message }); });
    child.on('close', code => { clearTimeout(timer); resolve(code === 0 ? { ok: true, code } : { ok: false, code, error: err.trim().slice(0, 200) || 'exit ' + code }); });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(evt));
  });
}

async function viaChannel(s, evt) {
  if (s.kind === 'ntfy') {
    if (!s.url) return { ok: false, error: 'no ntfy topic URL set' };
    const h = { 'Content-Type': 'text/plain; charset=utf-8', Title: headerSafe(String(evt.title || 'Relaymote').slice(0, 120)),
                Tags: evt.kind === 'awaiting' || evt.kind === 'question' ? 'bell' : 'white_check_mark' };
    if (/^https?:\/\//i.test(evt.url || '')) h.Click = evt.url;
    return httpPost(s.url, String(evt.body || evt.title || ''), h);
  }
  if (s.kind === 'webhook') {
    if (!s.url) return { ok: false, error: 'no webhook URL set' };
    const payload = { source: 'baton', kind: evt.kind || null, title: evt.title || '', body: evt.body || '',
                      text: textOf(evt), url: evt.url || null, tag: evt.tag || null, at: new Date().toISOString() };
    return httpPost(s.url, JSON.stringify(payload), { 'Content-Type': 'application/json' });
  }
  if (s.kind === 'command') {
    if (!s.command) return { ok: false, error: 'no command set' };
    return runCommand(s.command, evt);
  }
  return { ok: false, skipped: 'off' };
}

/**
 * Send one alert over the backup channel, subject to the cap. `opts.test` (the Settings button)
 * is an explicit tap: it bypasses the cap and does not consume a slot.
 */
async function sendBackup(evt, opts = {}) {
  const s = settings();
  if (s.kind === 'off') return { ok: false, skipped: 'off' };
  if (!opts.test) {
    if (!underCap(s.maxPer10Min)) return { ok: false, skipped: 'rate cap', cap: s.maxPer10Min };
    recent.push(Date.now());          // counted BEFORE sending; never retried
  }
  try { return { ...(await viaChannel(s, evt)), kind: s.kind }; }
  catch (e) { return { ok: false, error: e.message, kind: s.kind }; }
}

/**
 * Deliver an alert: web push to every subscribed phone, then the backup channel when push reached
 * nobody (or on every alert if backup.always). Returns what happened on each leg.
 */
async function deliver(evt, log = () => {}) {
  let pushed = { sent: 0, gone: 0, subscribed: 0 };
  let subscribed = 0;
  try { subscribed = push.count(); } catch {}
  if (subscribed) {
    try { pushed = { ...(await push.send(evt)), subscribed }; }
    catch (e) { pushed = { sent: 0, gone: 0, subscribed, error: e.message }; log('push failed: ' + e.message); }
  }
  const s = settings();
  let backup = null;
  if (s.kind !== 'off' && (pushed.sent === 0 || s.always)) {
    backup = await sendBackup(evt);
    if (backup.skipped) log(`backup alert (${s.kind}) skipped: ${backup.skipped}`);
    else if (!backup.ok) log(`backup alert (${s.kind}) failed: ${backup.error || 'HTTP ' + backup.status}`);
  }
  return { push: pushed, backup };
}

/** One line for logs and the app's diagnostics: where alerts will go right now. */
function route() {
  let n = 0; try { n = push.count(); } catch {}
  const s = settings();
  const b = s.kind === 'off' ? null : s.kind + (s.always ? ' (always)' : ' (when push reaches no phone)');
  if (n && b) return `web push (${n}) + ${b}`;
  if (n) return `web push (${n})`;
  if (b) return s.kind;
  return 'nowhere (no phone subscribed to push, no backup channel)';
}

/**
 * What to tell the user after they switch Claude account, generated from the settings that
 * actually govern it. The text used to be a constant claiming "sessions sync both ways every 15
 * minutes" — false on the defaults (Accounts module off; when on: auto-sync off, additive mode,
 * 30 minutes). `ask` is false when nothing could act on a "carry the chats over" answer.
 */
function accountSwitchText(cfg = config.get(), who = {}) {
  const to = who.to || 'another account', from = who.from || 'the previous one';
  const moduleOn = !!(cfg.modules || {}).accounts;
  const a = cfg.accounts || {};
  const head = `Now on ${to} (was ${from}).`;
  if (!moduleOn) {
    return { ask: false, moduleOn,
      note: 'Each account keeps its own sessions and sidebar. Turn on Accounts (Settings › Modules) to keep them in sync.',
      body: `${head} Switched accounts — set up Accounts to keep sidebars in sync.`,
      transferToast: 'Recorded. The Accounts module is off, so nothing is copied between accounts.' };
  }
  if (a.enabled === false) {
    return { ask: true, moduleOn,
      note: 'Account sync is switched off in Accounts, so nothing is copied between accounts until you turn it on.',
      body: `${head} Account sync is off — tap to decide.`,
      transferToast: 'Recorded. Account sync is off, so nothing will be copied until you turn it on in Accounts.' };
  }
  const how = a.mode === 'two-way' ? 'both ways' : 'additively (each account gets what it lacks; nothing is overwritten)';
  const mins = Math.max(5, Number(a.intervalMinutes) || 30);   // the floor lib/account-sync.js applies
  const when = a.autoSync ? `every ${mins} minutes` : 'when you press Sync in Accounts (automatic sync is off)';
  return { ask: true, moduleOn,
    note: `Sessions and routines are copied ${how}, ${when}. Sidebar groups are copied only while Claude Desktop is closed.`,
    body: `${head} Sessions sync ${a.mode === 'two-way' ? 'both ways' : 'additively'} ${a.autoSync ? `every ${mins} min` : 'on demand'} — tap to decide.`,
    transferToast: a.autoSync
      ? `Recorded. Sessions and routines are copied ${a.mode === 'two-way' ? 'both ways' : 'additively'} every ${mins} minutes.`
      : 'Recorded. Automatic sync is off — open Accounts and press Sync to copy them now.' };
}

module.exports = { deliver, sendBackup, settings, route, underCap, accountSwitchText, KINDS, WINDOW_MS, DEFAULT_CAP,
                   _setPush: (p) => { push = p; }, _resetCap: () => { recent.length = 0; } };
