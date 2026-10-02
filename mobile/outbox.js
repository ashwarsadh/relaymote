'use strict';
const fs = require('fs');
const path = require('path');

const STATE = require('../lib/config').STATE;
const FILE = path.join(STATE, 'outbox.json');

const SUSPECT_MS = 15 * 60 * 1000;
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;

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

function needleFor(text) {
  const NL = String.fromCharCode(10), CR = String.fromCharCode(13);
  const lines = String(text || '').split(CR).join('').split(NL);
  const spoken = lines.filter(l => l.trim() && l.trim().charAt(0) !== '@');
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

module.exports = { withoutQueueOps, add, setUuid, markSent, pending, get, drop, reconcile, load, norm, needleFor, unescapeTranscript, SUSPECT_MS, KEEP_MS, FILE };
