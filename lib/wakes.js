// wakes.js — is a session's prompt cache still warm, and how many of the day's wakes were cold.
//
// A message from one session to another WAKES the target. Inside the prompt-cache window (about an
// hour since its last model reply) the wake re-reads the target's context from cache; after it, the
// whole context is written again, roughly 20x the cost. So the Conductor checks warmth before a send
// that is not urgent, and reads the daily count to see who is sending the cold ones.
//
// Read-only for transcripts: it reads tails under <CLAUDE_CONFIG_DIR>/projects and never opens a session.
//
// Two records, kept apart because they answer different questions:
//   MEASURED  daily(): every wake found in the transcripts (session-to-session AND Relaymote's own), with
//             the gap since the target's last model reply and the woken turn's REAL cache tokens.
//   FORWARD   logWake(): every wake BATON sends (compact, notify; the goal chaser's chase/keepalive
//             lines are read from its own chase.jsonl), with the warmth it was sent at and the sender.
// rollup() appends one line a day to <data>/conductor/wakes-daily.jsonl with both.
'use strict';
const fs = require('fs');
const path = require('path');
const config = require('./config');

const WINDOW_MIN = 60;          // prompt-cache lifetime assumed for "warm"
const TAIL_BYTES = 4 * 1024 * 1024;
const FROM_RE = /<cross-session-message\s+from="([^"]+)"(?:\s+name="([^"]*)")?/;
// Relaymote's own wakes arrive as ordinary user turns; their first words name the sender.
const RELAYMOTE_SENDERS = [[/^\s*\[(?:Relaymote|Baton) goals\]/, 'relaymote:chase'], [/^\s*\[(?:Relaymote|Baton) cache keep-alive\]/, 'relaymote:keepalive'],
  [/^\s*\[(?:Relaymote|Baton)\] Fleet update/, 'relaymote:notify'], [/^\s*\[(?:Relaymote|Baton) task /, 'relaymote:task']];
const CONDUCTOR_DIR = () => path.join(config.DATA, 'conductor');
const WAKELOG = () => path.join(CONDUCTOR_DIR(), 'wakes.jsonl');
const DAILY = () => path.join(CONDUCTOR_DIR(), 'wakes-daily.jsonl');

function tailText(file, bytes) {
  const st = fs.statSync(file);
  const start = Math.max(0, st.size - bytes);
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(st.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const t = buf.toString('utf8');
    return start > 0 ? t.slice(t.indexOf('\n') + 1) : t;
  } finally { fs.closeSync(fd); }
}

function userText(r) {
  const c = r && r.message && r.message.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    if (c.some(b => b && b.type === 'tool_result')) return '';
    return c.filter(b => b && b.type === 'text').map(b => b.text).join('\n');
  }
  return '';
}
function isToolResult(r) {
  const c = r && r.message && r.message.content;
  return Array.isArray(c) && c.some(b => b && b.type === 'tool_result');
}

/**
 * Who woke this session with this user record, or null when it is not a wake. Three shapes:
 * `<cross-session-message from=…>` in the text, the app's `origin: { kind: 'peer', from }` on the
 * record, and Relaymote's own messages (their first words name the sender). Relaymote's label wins.
 */
function wakeSender(r, t) {
  for (const [rx, who] of RELAYMOTE_SENDERS) if (rx.test(t || '')) return { from: who };
  const f = t && t.indexOf('<cross-session-message') >= 0 ? FROM_RE.exec(t) : null;
  if (f) return { from: f[1], name: f[2] || undefined };
  const o = r && r.origin;
  if (o && typeof o === 'object' && o.kind === 'peer' && !isToolResult(r)) return { from: String(o.from || o.sessionId || 'peer') };
  return null;
}

/**
 * Walk one transcript. Returns { lastApiAt, wakes:[{ at, from, name, warm, idleMin, cacheRead, cacheWrite }] }.
 * A wake is a user turn delivered from another session or from Relaymote — a message queued mid-turn
 * reads as warm, the session was already awake. Warm = the previous real model reply is less than
 * `windowMin` old. cacheRead / cacheWrite are the woken turn's first real reply's cache tokens: the
 * measured cost, not the estimate (null when the reply is not in the tail yet).
 */
function scanTranscript(file, opts = {}) {
  const windowMs = (opts.windowMin || WINDOW_MIN) * 60000;
  const since = opts.sinceMs || 0;
  const out = { lastApiAt: null, wakes: [] };
  let text;
  try { text = tailText(file, opts.tailBytes || TAIL_BYTES); } catch { return out; }
  let open = null;                       // the wake whose first reply has not been seen yet
  for (const line of text.split('\n')) {
    if (!line || line[0] !== '{') continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (r.isSidechain) continue;
    const ts = Date.parse(r.timestamp || '') || 0;
    if (r.type === 'assistant') {
      const m = r.message || {};
      if (m.model && m.model !== '<synthetic>') {
        if (open) {
          const u = m.usage || {};
          open.cacheRead = Number(u.cache_read_input_tokens) || 0;
          open.cacheWrite = Number(u.cache_creation_input_tokens) || 0;
          open = null;
        }
        if (ts > (out.lastApiAt || 0)) out.lastApiAt = ts;
      }
      continue;
    }
    if (r.type !== 'user') continue;
    const t = userText(r);
    const f = wakeSender(r, t);
    if (!f || ts < since) continue;
    const idleMs = out.lastApiAt ? ts - out.lastApiAt : Infinity;
    const w = { at: new Date(ts).toISOString(), from: f.from, name: f.name,
                warm: idleMs < windowMs, idleMin: isFinite(idleMs) ? Math.round(idleMs / 60000) : null, cacheRead: null, cacheWrite: null };
    out.wakes.push(w);
    open = w;
  }
  return out;
}

/** Warmth of one transcript right now: { warm, minutesLeft, lastApiAt }. Unknown when never replied. */
function warmthOfFile(file, opts = {}) {
  const now = opts.now || Date.now();
  const windowMin = opts.windowMin || WINDOW_MIN;
  const { lastApiAt } = scanTranscript(file, { ...opts, sinceMs: Infinity });
  if (!lastApiAt) return { warm: false, known: false, note: 'no model reply found in the transcript tail' };
  const ageMin = (now - lastApiAt) / 60000;
  return { warm: ageMin < windowMin, known: true, ageMin: Math.round(ageMin), minutesLeft: Math.max(0, Math.round(windowMin - ageMin)),
           lastApiAt: new Date(lastApiAt).toISOString() };
}

/** Warmth per Desktop session id (local_…), resolved to its transcript. */
async function warmth(sessionIds, opts = {}) {
  const sessions = require('../mobile/sessions');
  try { await sessions.refresh(); } catch {}
  const out = {};
  for (const id of sessionIds || []) {
    const s = sessions.get(id);
    const file = s ? sessions.transcriptPath(s) : null;
    out[id] = file ? { title: s.title, ...warmthOfFile(file, opts) } : { warm: false, known: false, note: s ? 'no transcript on disk' : 'unknown session id' };
  }
  return out;
}

function transcriptFiles(root, sinceMs) {
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => path.join(root, d.name)); } catch { return out; }
  for (const d of dirs) {
    let names = [];
    try { names = fs.readdirSync(d); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue;
      const f = path.join(d, n);
      try { if (fs.statSync(f).mtimeMs >= sinceMs) out.push(f); } catch {}
    }
  }
  return out;
}

/**
 * The daily metric: every session-to-session wake in the last `hours` (default 24), split warm/cold,
 * with the cold ones counted by sender. `root` defaults to <CLAUDE_CONFIG_DIR>/projects.
 */
function daily(opts = {}) {
  const now = opts.now || Date.now();
  const hours = Number(opts.hours) > 0 ? Number(opts.hours) : 24;
  const sinceMs = now - hours * 3600000;
  const root = opts.root || path.join(config.CLAUDE_HOME, 'projects');
  const res = { hours, since: new Date(sinceMs).toISOString(), transcripts: 0, wakes: 0, warm: 0, cold: 0, coldBySender: {}, warmBySender: {},
    unknownGap: 0, cacheTokens: { warmRead: 0, warmWrite: 0, coldRead: 0, coldWrite: 0 }, relaymote: { warm: 0, cold: 0 } };
  for (const f of transcriptFiles(root, sinceMs)) {
    res.transcripts++;
    for (const w of scanTranscript(f, { sinceMs, windowMin: opts.windowMin }).wakes) {
      res.wakes++;
      const key = w.from + (w.name ? ' (' + w.name + ')' : '');
      const bucket = w.warm ? res.warmBySender : res.coldBySender;
      bucket[key] = (bucket[key] || 0) + 1;
      if (w.warm) res.warm++; else res.cold++;
      if (w.idleMin == null) res.unknownGap++;
      if (/^(relaymote|baton):/.test(w.from)) res.relaymote[w.warm ? 'warm' : 'cold']++;
      res.cacheTokens[w.warm ? 'warmRead' : 'coldRead'] += w.cacheRead || 0;
      res.cacheTokens[w.warm ? 'warmWrite' : 'coldWrite'] += w.cacheWrite || 0;
    }
  }
  const sortDesc = o => Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1]));
  res.coldBySender = sortDesc(res.coldBySender);
  res.warmBySender = sortDesc(res.warmBySender);
  // "cold" includes wakes whose previous reply is not in the tail (unknownGap): counted, never hidden.
  res.note = res.wakes
    ? `${res.cold} of ${res.wakes} wakes landed on a cold cache (>${opts.windowMin || WINDOW_MIN} min since the target's last reply); each re-wrote the whole context.`
    : 'No session-to-session wakes in the window.';
  return res;
}

// ---------------------------------------------------------------- the forward log (Relaymote's own sends)
/** Transcript of one session id from the project index (cheap), else from the Desktop session list. */
async function transcriptOf(sessionId) {
  try {
    const ix = require('./projects').read();
    const s = ix && ix.sessions && ix.sessions[sessionId];
    if (s && s.cli) { const f = require('./transcripts').findTranscript(s.cli, s.slug); if (f) return f; }
  } catch {}
  try {
    const sessions = require('../mobile/sessions');
    await sessions.refresh();
    const s = sessions.get(sessionId);
    return s ? sessions.transcriptPath(s) : null;
  } catch { return null; }
}
async function warmthById(sessionId, opts = {}) {
  const f = await transcriptOf(sessionId);
  return f ? warmthOfFile(f, opts) : { warm: false, known: false, note: 'no transcript found' };
}

/**
 * Record one wake Relaymote sent: { to, kind, sender, warmth, what }. kind: chase | keepalive | notify |
 * compact | … Never throws — a logging failure must not fail the send it describes.
 */
function logWake(rec = {}) {
  const w = rec.warmth || {};
  const row = { ts: new Date(rec.now || Date.now()).toISOString(), to: rec.to || null, kind: rec.kind || 'other',
    sender: rec.sender || ('relaymote:' + (rec.kind || 'other')), warm: !!w.warm, known: !!w.known,
    ageMin: w.ageMin != null ? w.ageMin : null, inside: w.known ? !!w.warm : null, what: String(rec.what || '').replace(/\s+/g, ' ').slice(0, 120) };
  try { fs.mkdirSync(CONDUCTOR_DIR(), { recursive: true }); fs.appendFileSync(rec.file || WAKELOG(), JSON.stringify(row) + '\n'); } catch {}
  return row;
}

/** Wrap a sender (sessionId, text, opts) => {ok} so every successful send is logged with the warmth it went at. */
function instrument(send, kind, opts = {}) {
  const probe = opts.warmth || warmthById;
  return async function (sessionId, text, o) {
    let w = null;
    try { w = await probe(sessionId); } catch {}
    const out = await send(sessionId, text, o);
    try { if (out && out.ok) logWake({ to: sessionId, kind, warmth: w || {}, what: String(text || '').split('\n')[0] }); } catch {}
    return out;
  };
}

function readJsonl(file, sinceMs) {
  const out = [];
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return out; }
  for (const ln of text.split('\n')) {
    if (!ln.trim()) continue;
    let r; try { r = JSON.parse(ln); } catch { continue; }
    const t = Date.parse(r.ts || r.at || '') || 0;
    if (t >= sinceMs) out.push(r);
  }
  return out;
}

/**
 * Relaymote's own wakes in the last `hours`, by kind: { kind: { warm, cold, unknown } }. Reads the forward
 * log plus the goal chaser's chase.jsonl (its chase and keep-alive lines carry the warmth they went at).
 */
function forwardLog(opts = {}) {
  const now = opts.now || Date.now();
  const hours = Number(opts.hours) > 0 ? Number(opts.hours) : 24;
  const since = now - hours * 3600000;
  const byKind = {}, total = { warm: 0, cold: 0, unknown: 0 };
  const add = (kind, known, warm) => {
    const k = byKind[kind] || (byKind[kind] = { warm: 0, cold: 0, unknown: 0 });
    const b = !known ? 'unknown' : warm ? 'warm' : 'cold';
    k[b]++; total[b]++;
  };
  for (const r of readJsonl(opts.file || WAKELOG(), since)) add(r.kind || 'other', r.known !== false && r.warm != null, !!r.warm);
  let chaseLog = opts.chaseLog;
  if (chaseLog === undefined) { try { chaseLog = require('./goals').CHASE_LOG; } catch { chaseLog = null; } }
  if (chaseLog) {
    for (const r of readJsonl(chaseLog, since)) {
      if (r.dryRun || !r.ok || r.kind === 'spawn') continue;       // a spawn starts a session, it wakes nobody
      add(r.kind === 'keepalive' ? 'keepalive' : 'chase', typeof r.warm === 'boolean', !!r.warm);
    }
  }
  return { hours, since: new Date(since).toISOString(), total, byKind };
}

/** The last daily roll-up line, or null. */
function lastRollup(file = DAILY()) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const lines = text.trim().split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) { try { return JSON.parse(lines[i]); } catch {} }
  return null;
}

/**
 * Once per 24 h (called from the hygiene tick): one line in wakes-daily.jsonl with the day's measured
 * wakes (warm/cold, cold by sender, real cache tokens) and Relaymote's forward log. Returns the line, or
 * null when the last one is younger than a day (force: true writes anyway).
 */
function rollup(opts = {}) {
  const now = opts.now || Date.now();
  const file = opts.file || DAILY();
  const last = lastRollup(file);
  if (last && !opts.force && now - (Date.parse(last.at) || 0) < 24 * 3600000) return null;
  const measured = (opts.measure || daily)({ hours: 24, now, root: opts.root });
  const line = { at: new Date(now).toISOString(), ...measured, forward: forwardLog({ hours: 24, now, file: opts.wakeLog, chaseLog: opts.chaseLog }) };
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, JSON.stringify(line) + '\n'); } catch {}
  return line;
}

module.exports = { WINDOW_MIN, scanTranscript, warmthOfFile, warmth, daily, transcriptFiles,
  wakeSender, warmthById, transcriptOf, logWake, instrument, forwardLog, rollup, lastRollup, WAKELOG, DAILY };
