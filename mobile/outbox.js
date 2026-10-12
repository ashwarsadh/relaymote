'use strict';
const fs = require('fs');
const path = require('path');

const STATE = require('../lib/config').STATE;
const FILE = path.join(STATE, 'outbox.json');

const SUSPECT_MS = 15 * 60 * 1000;
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;
// g1783: Desktop silently dropped a bridge send made 157 ms before a turn boundary. No queue row, no user
// row, yet the phone said "delivered" for 73 min. A bridge send (it has a uuid) must show up in the
// transcript within this long, else it is re-sent once under the same uuid, then called NOT delivered.
const ACCEPT_MS = 60 * 1000;
const RESEND_WINDOW_MS = 5 * 60 * 1000;

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Array.isArray(j.entries) ? j.entries : [];
  } catch { return []; }
}

function save(entries) {
  try {
    fs.mkdirSync(STATE, { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ entries }, null, 1));
    fs.renameSync(tmp, FILE);
  } catch { }
}

function norm(t) {
  return String(t || '').replace(/\s+/g, ' ').trim();
}

// An attachment rides as a LEADING "@<path>" line. Only those are skipped: any other "@" line is his
// text. Skipping every "@" line (g1085) joined the lines around a pasted chat mention ("@Name
// card ..1234: …") into a needle that never occurs in the transcript, so a delivered message went
// "waiting for a reply" after 15 min, and its Send again pre-check said it had not landed.
const ATTACH_LINE = /^@(?:[A-Za-z]:[\\/]|[\\/~]|\.{1,2}[\\/])/;
function needleFor(text) {
  const NL = String.fromCharCode(10), CR = String.fromCharCode(13);
  const lines = String(text || '').split(CR).join('').split(NL);
  let i = 0;
  while (i < lines.length && (!lines[i].trim() || ATTACH_LINE.test(lines[i].trim()))) i++;
  const spoken = lines.slice(i).filter(l => l.trim());
  const base = spoken.length ? spoken.join(' ') : lines.join(' ');
  return norm(base).slice(0, 60);
}

function add({ id, session, text, delivery, uuid }) {
  if (!norm(text)) return null;
  const entries = load();
  const e = {
    id: id || ('ob_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
    session, text: String(text), delivery: delivery || null,
    uuid: uuid || null,
    at: Date.now(), confirmedAt: null, state: 'pending',
  };
  entries.push(e);
  save(entries);
  return e;
}

function setUuid(id, uuid) {
  const entries = load();
  const e = entries.find(x => x.id === id);
  if (!e) return null;
  e.uuid = uuid || null;
  save(entries);
  return e;
}

function markSent(id, { delivery, ok, error, proven } = {}) {
  const entries = load();
  const e = entries.find(x => x.id === id);
  if (!e) return null;
  if (e.state === 'confirmed') { e.delivery = delivery || e.delivery; save(entries); return e; }
  e.delivery = delivery || e.delivery;
  if (!ok) { e.state = 'failed'; e.error = String(error || 'send failed'); }
  else if (proven) { e.state = 'confirmed'; e.confirmedAt = Date.now(); }
  else e.state = 'pending';
  save(entries);
  return e;
}

function pending() {
  return load().filter(e => e.state === 'pending' || e.state === 'failed')
               .sort((a, b) => b.at - a.at);
}

function get(id) { return load().find(x => x.id === id) || null; }

function drop(id) {
  const entries = load().filter(x => x.id !== id);
  save(entries);
  return entries;
}

function unescapeTranscript(t) {
  return String(t || '')
    .replace(/\\u([0-9a-fA-F]{4})/g, (m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\[nrt]/g, ' ')
    .replace(/\\\"/g, '\"')
    .replace(/\\\\/g, '\\');
}

const NL = String.fromCharCode(10);
function withoutQueueOps(text) {
  return String(text).split(NL).filter(l => l.indexOf('"type":"queue-operation"') < 0).join(NL);
}

function reconcile(readText, now = Date.now(), busy = null) {
  const entries = load();
  if (!entries.length) return { confirmed: [], suspect: [], checked: 0 };

  const confirmed = [], suspect = [];
  const cache = new Map();
  let checked = 0;

  for (const e of entries) {
    if (e.state !== 'pending' && e.state !== 'failed') continue;
    checked++;
    let hay = cache.get(e.session);
    if (hay === undefined) {
      // A queue "enqueue" row is not delivery: a held message sits there until the turn ends, and
      // confirming on it dropped the message's Send now and × the moment it was queued.
      try { hay = norm(unescapeTranscript(withoutQueueOps(readText(e.session) || ''))); } catch { hay = ''; }
      cache.set(e.session, hay);
    }
    const needle = needleFor(e.text);
    if (needle && hay.includes(needle)) {
      e.state = 'confirmed'; e.confirmedAt = now;
      confirmed.push(e);
    } else if (!e.suspectedAt && (now - e.at) > SUSPECT_MS) {
      let working = false;
      if (busy) { try { working = !!busy(e.session); } catch { working = false; } }
      if (working) continue;
      e.suspectedAt = now;
      suspect.push(e);
    }
  }

  const kept = entries.filter(e => (now - e.at) < KEEP_MS);
  save(kept);
  return { confirmed, suspect, checked };
}

// Did Desktop take it at all? Any trace counts, queue rows included: an enqueue/remove carrying the text,
// a row carrying the uuid (queued_command attachment, remove.commandUuid), or the user turn itself.
function arrivedIn(raw, e) {
  if (!raw) return false;
  if (e.uuid && raw.includes(e.uuid)) return true;
  const needle = needleFor(e.text);
  return !!needle && norm(unescapeTranscript(raw)).includes(needle);
}

// Returns the bridge sends that need a re-send now, and those that failed it. The caller re-sends and then
// calls markResent; nothing here talks to Desktop.
function checkAccepted(readText, now = Date.now()) {
  const entries = load();
  const resend = [], failed = [];
  let changed = false;
  const cache = new Map();
  for (const e of entries) {
    if (e.state !== 'pending' || !e.uuid || e.acceptedAt) continue;
    let raw = cache.get(e.session);
    if (raw === undefined) { try { raw = readText(e.session) || ''; } catch { raw = ''; } cache.set(e.session, raw); }
    if (arrivedIn(raw, e)) { e.acceptedAt = now; changed = true; continue; }
    // Only a fresh send is re-sent: an older one (from before this check, or a tail that no longer reaches
    // back to it) is left to the 15-minute suspect flag rather than risk a late duplicate.
    if (!e.resentAt) { if (now - e.at > ACCEPT_MS && now - e.at < RESEND_WINDOW_MS) resend.push(e); continue; }
    if (now - e.resentAt > ACCEPT_MS) {
      e.state = 'failed'; e.notDelivered = true;
      e.error = 'NOT delivered: Desktop dropped it twice (sent, then re-sent once). Nothing reached the session.';
      failed.push(e); changed = true;
    }
  }
  if (changed) save(entries);
  return { resend, failed };
}

function markResent(id, { ok, error, now = Date.now() } = {}) {
  const entries = load();
  const e = entries.find(x => x.id === id);
  if (!e) return null;
  e.resentAt = now;
  if (!ok) { e.state = 'failed'; e.notDelivered = true; e.error = 'NOT delivered: the re-send failed (' + String(error || 'unknown') + ')'; }
  save(entries);
  return e;
}

module.exports = { checkAccepted, markResent, arrivedIn, ACCEPT_MS, withoutQueueOps, add, setUuid, markSent, pending, get, drop, reconcile, load, norm, needleFor, unescapeTranscript, SUSPECT_MS, KEEP_MS, FILE };
