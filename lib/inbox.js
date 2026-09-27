// inbox.js — everything the user hands the Conductor, kept verbatim until it is closed.
//
// A second request arriving while the first is being worked on must never make the first one vanish,
// so every item the user gives (or a session raises for them) is written here and stays until
// someone closes it. The file is <board dir>/inbox.jsonl and it is APPEND-ONLY: each line is a patch
// { n, at, op, ...fields } and the item is the fold of its lines, last value wins, null clears a
// field. Nothing is rewritten, so the history of an item (who changed what, when) is always there.
//
// Item NUMBERS never change: the user refers to them by number ("#153"), so ordering is a view.
// Status:  open      only the user can move it; it is on the Board's "For you" list
//          waiting   a session is working on it; folded into the Board's "In flight" drawer
//          resolved? the auto-resolver believes it is already handled; "Probably handled" drawer,
//                    with its evidence and a Reinstate button
//          done | dropped
// Kind:    action    something the user must do (the Board shows only these)
//          log       a record (an instruction logged back, a dispatch note); never on the Board and
//                    closed by `sweep` once quiet
'use strict';
const fs = require('fs');
const path = require('path');
const config = require('./config');

const DEFAULTS = {
  ownerName: 'you',       // how the Board and messages name the user
  graceDays: 4,           // a `resolved?` item earned by a tap closes itself after this long
  recordDays: 5,          // a pure record ("fyi, no action") is flagged resolved? after this long
  sweepDays: 2,           // `sweep` closes log items quiet this long
  visibleChars: 178,      // what a phone card shows before "more" (measured on a 375px screen)
  askMaxChars: 200,       // an ask longer than this is refused
  criticalWords: null,    // null = the generic list below; an array REPLACES it
  recordWords: null,      // null = the generic list below
  undecidedWords: null,   // null = the generic list below
  notOwnerPrefixes: [],   // extra turn prefixes that are NOT the user speaking (added to the built-ins)
};
// Never retired on weak evidence: money, deletion, secrets, anything that goes outward.
const CRITICAL_WORDS = ['money', 'pay', 'payment', 'paid', 'bank', 'refund', 'price', 'pricing', 'purchase', 'buy',
  'bill', 'tax', 'fee', 'penalty', 'fine', 'delete', 'deletion', 'remove', 'wipe', 'drop table', 'archive',
  'rotate', 'secret', 'password', 'credential', 'token', 'key', 'send', 'email', 'publish', 'post', 'deploy',
  'release', 'customer', 'client', 'legal', 'contract', 'urgent', 'deadline', 'late'];
const RECORD_WORDS = ['fyi', 'no action', 'for your information', 'nothing to do', 'informational'];
const UNDECIDED_WORDS = ['one yes', 'yes/no', 'your call', 'only you can', 'approve', 'approval', 'decide', 'decision',
  'confirm', 'which of', 'do you want', 'shall i', 'permission'];
// Turns a digest labels as the user that are not the user: hook feedback, compaction dumps, relayed
// or injected messages, and the Board's own taps (a tap is counted as a tap, not as speech).
const NOT_OWNER = ['Stop hook feedback', 'This session is being continued', '<cross-session-message',
  'Another Claude session sent a message', '[board] ', '[Relaymote', '[Conductor'];

const STATUSES = ['open', 'waiting', 'resolved?', 'done', 'dropped'];
const FINISHED = ['done', 'dropped'];
const SID_FULL = /local_[0-9a-f]{8}-[0-9a-f-]{27}/;
const SID_SHORT = /local_[0-9a-f]{8}(?![0-9a-f-])/;
const LONE_BACKSLASH = /\\(?!["\\/bfnrtu])/g;
const DAY = 86400000, MIN = 60000;

const iso = (t) => new Date(t).toISOString();
const ms = (s) => { const t = Date.parse(s || ''); return isNaN(t) ? 0 : t; };
const oneLine = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

function settings() { return { ...DEFAULTS, ...((config.get() || {}).inbox || {}) }; }
function ownerName() { return settings().ownerName || 'you'; }
const boardDir = () => (config.get().board && config.get().board.dir) || path.join(config.DATA, 'board');
const file = () => path.join(boardDir(), 'inbox.jsonl');
const actionsFile = () => path.join(boardDir(), 'board-actions.jsonl');
const legacyNotes = () => path.join(config.DATA, 'goals', 'notes.jsonl');

function wordsRe(list) {
  const ws = (list || []).map(w => String(w).trim()).filter(Boolean);
  if (!ws.length) return null;
  return new RegExp('\\b(' + ws.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')).join('|') + ')\\b', 'i');
}
const criticalRe = (s = settings()) => wordsRe(Array.isArray(s.criticalWords) ? s.criticalWords : CRITICAL_WORDS);
const recordRe = (s = settings()) => wordsRe(Array.isArray(s.recordWords) ? s.recordWords : RECORD_WORDS);
const undecidedRe = (s = settings()) => wordsRe(Array.isArray(s.undecidedWords) ? s.undecidedWords : UNDECIDED_WORDS);

// ---------------------------------------------------------------- the ledger
/** Parse every line, repairing a lone backslash (a hand-typed Windows path) instead of losing the row. */
function readLines(f) {
  let text = '';
  try { text = fs.readFileSync(f, 'utf8'); } catch { return { rows: [], corrupt: 0, repaired: 0 }; }
  const rows = [];
  let corrupt = 0, repaired = 0;
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { rows.push(JSON.parse(s)); continue; } catch {}
    try { rows.push(JSON.parse(s.replace(LONE_BACKSLASH, '\\\\'))); repaired++; } catch { corrupt++; }
  }
  return { rows, corrupt, repaired };
}

/** One-time import of the notes Relaymote kept before the inbox existed (relaymote_tell_user), numbers kept. */
function migrateLegacy() {
  const f = file();
  if (fs.existsSync(f) || !fs.existsSync(legacyNotes())) return 0;
  const byN = new Map();
  for (const r of readLines(legacyNotes()).rows) if (r && r.n != null) byN.set(String(r.n), { ...(byN.get(String(r.n)) || {}), ...r });
  const out = [];
  for (const r of [...byN.values()].sort((a, b) => a.n - b.n)) {
    const row = { n: Number(r.n), at: r.ts || iso(Date.now()), op: 'import', ts: r.ts || iso(Date.now()), text: String(r.text || ''),
      status: r.status === 'open' ? 'open' : (STATUSES.includes(r.status) ? r.status : 'done'), kind: 'action', note: '', source: 'notes' };
    if (r.session) row.session = r.session;
    if (['decide', 'do', 'fyi'].includes(r.kind)) row.ask_kind = r.kind;
    if (r.closedAt) row.closed = r.closedAt;
    out.push(JSON.stringify(row));
  }
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, out.length ? out.join('\n') + '\n' : '');
  return out.length;
}

/** { items: Map(n -> item), corrupt, repaired, next } — last value wins, null clears a field. */
function fold() {
  try { migrateLegacy(); } catch {}
  const { rows, corrupt, repaired } = readLines(file());
  const items = new Map();
  let bad = 0;
  for (const r of rows) {
    const n = r && Number(r.n);
    if (!r || !Number.isInteger(n) || n < 1) { bad++; continue; }
    const cur = items.get(n) || { n, history: 0 };
    for (const [k, v] of Object.entries(r)) {
      if (k === 'op' || k === 'at' || k === 'n') continue;
      if (v === null) delete cur[k]; else cur[k] = v;
    }
    cur.history++;
    cur.updatedAt = r.at || cur.updatedAt || cur.ts;
    items.set(n, cur);
  }
  const top = [...items.keys()].reduce((m, n) => Math.max(m, n), 0);
  return { items, corrupt: corrupt + bad, repaired, next: top + 1 };
}

function append(n, op, patch, now = Date.now()) {
  const f = file();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.appendFileSync(f, JSON.stringify({ n, at: iso(now), op, ...patch }) + '\n');
}

const newestFirst = (rows) => rows.slice().sort((a, b) => (ms(b.ts) - ms(a.ts)) || (b.n - a.n));
const all = () => [...fold().items.values()];
function get(n) { return fold().items.get(Number(String(n).replace(/^#/, ''))) || null; }

// ---------------------------------------------------------------- operations
/** Record an item, verbatim. kind 'log' keeps it off the Board. */
function add(text, opts = {}) {
  const t = String(text == null ? '' : text).trim();
  if (!t) return { ok: false, error: 'TEXT_REQUIRED', message: 'An inbox item needs text.' };
  const kind = opts.kind === 'log' ? 'log' : 'action';
  const now = opts.now || Date.now();
  const n = fold().next;
  const row = { ts: iso(now), text: t, status: 'open', kind, note: '' };
  if (opts.session) row.session = String(opts.session);
  if (opts.source) row.source = String(opts.source);
  if (opts.ask_kind && ['decide', 'do', 'fyi'].includes(opts.ask_kind)) row.ask_kind = opts.ask_kind;
  append(n, 'add', row, now);
  const warnings = [];
  if (kind === 'action' && !row.session) {
    warnings.push('No session: this card has no "Open session" button, and the auto-resolver can only use weak evidence for it. '
      + `Pass a session if it is about one, or link it now (inbox link ${n} <session id>).`);
  }
  if (t.length > 12000) warnings.push(`#${n} is ${t.length} chars. Nothing was cut; say it shorter if that was not meant.`);
  return { ok: true, n, item: { n, ...row }, warnings };
}

function withItem(n, fn) {
  const it = get(n);
  if (!it) return { ok: false, error: 'NO_SUCH_ITEM', n: String(n) };
  return fn(it);
}

/**
 * The one line the Board exists to carry. The phone shows about `visibleChars` characters, so
 * "#n <ask>" must be complete inside them: the imperative ask first, with the number that makes it matter.
 */
function ask(n, askKind, text, opts = {}) {
  const k = String(askKind || '').toLowerCase();
  if (!['decide', 'do', 'fyi'].includes(k)) return { ok: false, error: 'BAD_KIND', message: 'ask type must be decide | do | fyi' };
  const q = oneLine(text);
  if (!q) return { ok: false, error: 'TEXT_REQUIRED' };
  const s = settings();
  if (q.length > s.askMaxChars) {
    return { ok: false, error: 'TOO_LONG', chars: q.length, message: `${q.length} chars; the phone shows about ${s.visibleChars}. Say it shorter or it is not an ask.` };
  }
  return withItem(n, (it) => {
    append(it.n, 'ask', { ask: q, ask_kind: k }, opts.now);
    const shown = ('#' + it.n + ' ' + q).length;
    const warnings = shown > s.visibleChars
      ? [`"#${it.n} <ask>" is ${shown} chars; only the first ${s.visibleChars} show before "more" — put the imperative and its number first.`] : [];
    return { ok: true, n: it.n, ask: q, ask_kind: k, warnings };
  });
}

function link(n, session, opts = {}) {
  const sid = oneLine(session);
  if (!sid) return { ok: false, error: 'SESSION_REQUIRED' };
  return withItem(n, (it) => { append(it.n, 'link', { session: sid }, opts.now); return { ok: true, n: it.n, session: sid }; });
}

/** A `resolved?` flag (or a close) was wrong: back to open, PINNED so the auto-resolver never touches it again. */
function reopen(n, why, opts = {}) {
  return withItem(n, (it) => {
    const was = it.resolved_why || it.status;
    const add = `reinstated by ${opts.by || ownerName()}` + (oneLine(why) ? ' - ' + oneLine(why) : '') + ` (was: ${String(was).slice(0, 120)})`;
    append(it.n, 'reopen', { status: 'open', no_auto: true, note: ((it.note ? it.note + ' | ' : '') + add),
      resolved_tier: null, resolved_why: null, resolved_evidence: null, resolved_at: null, closed: null }, opts.now);
    return { ok: true, n: it.n, pinned: true };
  });
}

/** Rewrite the text in place (the previous text stays in the ledger). */
function setText(n, body, opts = {}) {
  const t = String(body == null ? '' : body).trim();
  if (t.length < 20) return { ok: false, error: 'TOO_SHORT', message: 'That is a fragment, not a board item (under 20 chars).' };
  return withItem(n, (it) => { append(it.n, 'text', { text: t }, opts.now); return { ok: true, n: it.n, chars: t.length, first: t.slice(0, settings().visibleChars) }; });
}

/** Append to the note. Never truncates: a very long note is reported, not cut. */
function note(n, text, opts = {}) {
  const t = String(text == null ? '' : text).trim();
  if (!t) return { ok: false, error: 'TEXT_REQUIRED' };
  return withItem(n, (it) => {
    const next = (it.note ? it.note + ' | ' : '') + t;
    append(it.n, 'note', { note: next }, opts.now);
    const warnings = next.length > 12000 ? [`#${it.n} note is now ${next.length} chars. Nothing was truncated; if this is a runaway append, fix the writer.`] : [];
    return { ok: true, n: it.n, status: it.status, chars: next.length, warnings };
  });
}

function setKind(ns, kind, opts = {}) {
  if (!['log', 'action'].includes(kind)) return { ok: false, error: 'BAD_KIND', message: "kind must be 'log' or 'action'" };
  const done = [], missing = [];
  for (const raw of String(ns).split(',').map(s => s.trim()).filter(Boolean)) {
    const it = get(raw);
    if (!it) { missing.push(raw); continue; }
    append(it.n, 'kind', { kind }, opts.now);
    done.push(it.n);
  }
  return { ok: done.length > 0, changed: done, missing, kind };
}

/** done | drop | wait. A closing word is ADDED to the note, never replaces it. */
function setStatus(n, status, closing, opts = {}) {
  const st = { done: 'done', drop: 'dropped', dropped: 'dropped', wait: 'waiting', waiting: 'waiting' }[status];
  if (!st) return { ok: false, error: 'BAD_STATUS' };
  return withItem(n, (it) => {
    const patch = { status: st };
    const c = String(closing == null ? '' : closing).trim();
    if (c) patch.note = ((it.note || '') + ' ' + c).trim();
    if (st !== 'waiting') patch.closed = iso(opts.now || Date.now());
    append(it.n, st, patch, opts.now);
    return { ok: true, n: it.n, status: st, was: it.status };
  });
}
const done = (n, note, o) => setStatus(n, 'done', note, o);
const drop = (n, note, o) => setStatus(n, 'drop', note, o);
const wait = (n, note, o) => setStatus(n, 'wait', note, o);

/** Close log items quiet for `days`; list the actions that have gone stale (never closed: only the user decides that). */
function sweep(days, opts = {}) {
  const d = Number(days) > 0 ? Number(days) : settings().sweepDays;
  const now = opts.now || Date.now();
  const cut = now - d * DAY;
  const closed = [], stale = [];
  for (const it of all()) {
    if (!['open', 'waiting'].includes(it.status) || it.no_auto) continue;
    if (ms(it.ts) >= cut) continue;
    if (it.kind === 'log') {
      append(it.n, 'sweep', { status: 'done', closed: iso(now),
        note: ((it.note ? it.note + ' | ' : '') + `auto-closed by sweep: a record quiet for ${d}+ days, never an action. inbox reopen ${it.n} if wrong.`) }, now);
      closed.push(it.n);
    } else stale.push({ n: it.n, text: String(it.text || '').slice(0, 110) });
  }
  return { ok: true, days: d, closed, stale };
}

function list(opts = {}) {
  const items = newestFirst(all());
  const shown = items.filter(it => opts.all || (['open', 'waiting'].includes(it.status) && it.kind !== 'log'));
  const cnt = (st) => items.filter(r => r.status === st && r.kind !== 'log').length;
  return {
    ok: true, items: shown,
    counts: { open: cnt('open'), waiting: cnt('waiting'), resolved: cnt('resolved?'), done: items.filter(r => r.status === 'done').length,
      logHidden: items.filter(r => r.kind === 'log' && ['open', 'waiting'].includes(r.status)).length },
    resolved: items.filter(r => r.status === 'resolved?'),
  };
}
function show(n) {
  const it = get(n);
  if (!it) return { ok: false, error: 'NO_SUCH_ITEM', n: String(n) };
  const hist = readLines(file()).rows.filter(r => r && Number(r.n) === it.n);
  return { ok: true, item: it, history: hist };
}

// ---------------------------------------------------------------- session of an item
let pmCache = { at: 0, map: null };
/** 8-hex-prefix id (local_xxxxxxxx) -> full session id, from the project index. */
function prefixMap(deps = {}) {
  if (deps.prefixMap) return deps.prefixMap;
  if (pmCache.map && Date.now() - pmCache.at < 60000) return pmCache.map;
  const m = new Map();
  try {
    const ix = require('./projects').read();
    for (const sid of Object.keys((ix && ix.sessions) || {})) if (sid.startsWith('local_') && sid.length > 14 && !m.has(sid.slice(0, 14))) m.set(sid.slice(0, 14), sid);
  } catch {}
  pmCache = { at: Date.now(), map: m };
  return m;
}
/** The session an item is about: the recorded one, else a full id named in its text/note, else an 8-hex prefix. */
function sessionOf(it, deps = {}) {
  if (!it) return null;
  if (it.session) return it.session;
  const blob = (it.note || '') + ' ' + (it.text || '');
  const full = SID_FULL.exec(blob);
  if (full) return full[0];
  const short = SID_SHORT.exec(blob);
  if (short) return prefixMap(deps).get(short[0]) || null;
  return null;
}

// ---------------------------------------------------------------- board answers and taps
function readActions() { return readLines(actionsFile()).rows; }

/** The TEXT of an answer given on the Board lands ON the card it answers (note + answered_at). Idempotent. */
function ingestBoardAnswers(opts = {}) {
  const acts = (opts.actions || readActions()).filter(a => a && a.kind === 'answer' && (a.target || 'inbox') === 'inbox'
    && ['delivered', 'queued', undefined].includes(a.result));
  if (!acts.length) return 0;
  const items = fold().items;
  let changed = 0;
  for (const a of acts) {
    const m = /answer\s+#(\d+)\s*:\s*([\s\S]*)/.exec(String(a.line || a.message || ''));
    if (!m) continue;
    let body = m[2];
    const cut = body.indexOf('   # #');
    if (cut > 0) body = body.slice(0, cut);
    body = body.trim();
    const it = items.get(Number(m[1]));
    if (!body || !it) continue;
    const at = String(a.at || '');
    const stamp = 'ANSWER from the board' + (at ? ' ' + at.slice(0, 16) : '');
    if (String(it.note || '').includes(stamp)) continue;
    it.note = ((it.note || '') + '\n\n' + stamp + ': " ' + body + ' "').trim();
    append(it.n, 'answer', { note: it.note, answered_at: at || null }, opts.now);
    changed++;
  }
  return changed;
}

/** '#n' -> { at, kind } of the latest delivered tap on that card. */
function taps(actions) {
  const out = new Map();
  for (const r of actions || readActions()) {
    const id = String((r && r.id) || '');
    if (!id.startsWith('#') || !['delivered', 'queued'].includes(r.result)) continue;
    const t = ms(r.at);
    if (t && (!out.has(id) || t > out.get(id).at)) out.set(id, { at: t, kind: r.kind || 'tap' });
  }
  return out;
}

// ---------------------------------------------------------------- the auto-resolver
const turnMs = (ts) => { const s = String(ts || ''); return ms(/Z|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(' ', 'T') + (s.length <= 16 ? ':00Z' : 'Z')); };
function defaultDeps() {
  const s = settings();
  const notOwner = NOT_OWNER.concat(s.notOwnerPrefixes || []);
  const digests = () => require('./digests');
  const turns = (sid) => { try { return digests().turns(sid) || []; } catch { return []; } };
  let ix; const index = () => { if (ix === undefined) { try { ix = require('./projects').read() || null; } catch { ix = null; } } return ix; };
  return {
    ownerSpokeAfter(sid, when) {
      for (const t of turns(sid)) {
        if (t.kind !== 'OWNER' || notOwner.some(p => String(t.body || '').startsWith(p))) continue;
        const at = turnMs(t.ts);
        if (at - when >= 5 * MIN) return { at, text: t.body };
      }
      return null;
    },
    sessionReportedAfter(sid, when) {
      const info = (index() && index().sessions && index().sessions[sid]) || {};
      if (![undefined, null, '', 'ended'].includes(info.pending)) return null;
      for (const t of turns(sid)) if (t.kind === 'ASSISTANT' && turnMs(t.ts) - when >= 5 * MIN) return { at: turnMs(t.ts) };
      return null;
    },
    relays() {
      let cid = null; try { cid = require('./master-protocol').conductorId(); } catch {}
      if (!cid) return [];
      const out = [];
      for (const t of turns(cid)) {
        if (t.kind !== 'RELAY') continue;
        const m = SID_FULL.exec(String(t.body || '').slice(0, 600));
        if (m) out.push({ at: turnMs(t.ts), session: m[0] });
      }
      return out;
    },
    sessionInfo(sid) { return (index() && index().sessions && index().sessions[sid]) || null; },
  };
}

const STEM_STOP = new Set('master the and for with that this from new session'.split(' '));
const stems = (t) => new Set((String(t || '').toLowerCase().match(/[a-z0-9]{4,}/g) || []).filter(w => !STEM_STOP.has(w)).map(w => w.slice(0, 5)));
/** Two shared word-stems between the item and the session's title/project/tags, or the link is not trusted. */
function linkIsAbout(text, info) {
  if (!info) return false;
  const about = stems([info.title, info.project, (info.tags || []).join(' ')].join(' '));
  let n = 0;
  for (const s of stems(text)) if (about.has(s)) n++;
  return n >= 2;
}
/** The relay that reached the Conductor in the 45 minutes before the item — a guess, used only if linkIsAbout agrees. */
function inferredSession(it, relays, info) {
  const when = ms(it.ts);
  const prev = (relays || []).filter(r => when - r.at >= 0 && when - r.at <= 45 * MIN).sort((a, b) => a.at - b.at);
  if (!prev.length) return null;
  const sid = prev[prev.length - 1].session;
  return linkIsAbout(it.text, info(sid)) ? sid : null;
}

/**
 * Look for evidence that an open item is already dealt with. Never moves anything to `done` directly:
 *   open --(evidence)--> resolved? --(graceDays, earned by a tap or a landed answer)--> done
 * HIGH  the user tapped this card on the Board (board-actions.jsonl).
 * low   a pure record ("fyi, no action") older than recordDays.
 * Speech in a session (named or inferred), or a session that ended after carrying on, only MARKS the
 * item (seen_in_lane / replied_in_lane / orphaned) and leaves it open: the user speaks in a lane about
 * whatever they like, and a lane ending means the work is ownerless, not finished. Pinned items
 * (no_auto) are skipped. Critical items (money / deletion / outward) are never touched on weak evidence.
 */
function autoResolve(deps = {}) {
  const s = settings();
  const d = { ...defaultDeps(), ...deps };
  const now = d.now || Date.now();
  const crit = criticalRe(s), rec = recordRe(s), undecided = undecidedRe(s);
  const tp = taps(d.actions);
  let relays = null;
  const info = (sid) => (d.sessionInfo ? d.sessionInfo(sid) : null);
  const title = (sid) => String((info(sid) || {}).title || sid.slice(0, 14)).slice(0, 60);
  const out = { flagged: [], closed: [], marked: [] };
  for (const it of fold().items.values()) {
    if (it.status === 'resolved?') {
      const earned = it.resolved_tier === 'high' || !!it.answered_at;
      const at = ms(it.resolved_at);
      if (earned && at && now - at >= s.graceDays * DAY) {
        append(it.n, 'auto-close', { status: 'done', closed: iso(now),
          note: ((it.note ? it.note + ' | ' : '') + (it.resolved_why || 'auto-resolved') + ` - closed after ${s.graceDays} days as probably handled, with no objection`) }, now);
        out.closed.push(it.n);
      }
      continue;
    }
    if (it.status !== 'open' || it.no_auto) continue;
    const when = ms(it.ts);
    if (!when) continue;
    const text = String(it.text || '') + ' ' + String(it.ask || '');
    const critical = !!(crit && crit.test(text));
    const flag = (tier, why, evidence) => {
      append(it.n, 'resolve', { status: 'resolved?', resolved_tier: tier, resolved_why: why.slice(0, 200),
        resolved_evidence: evidence.slice(0, 400), resolved_at: iso(now) }, now);
      out.flagged.push({ n: it.n, tier, why });
    };
    const mark = (key, value) => {
      if (it[key]) return;
      append(it.n, 'mark', { [key]: value, [key.replace(/_in_lane$|$/, '') + '_at']: iso(now) }, now);
      out.marked.push({ n: it.n, key });
    };

    const tap = tp.get('#' + it.n);
    if (tap && tap.at >= when) { flag('high', `you tapped "${tap.kind}" on the board`, 'board-actions.jsonl - ' + iso(tap.at)); continue; }

    const named = sessionOf(it, d);
    if (named && d.ownerSpokeAfter) {
      const sp = d.ownerSpokeAfter(named, when);
      if (sp) { mark('seen_in_lane', `you were active in "${title(named)}" after this was raised, but said nothing about this card - it is still open`); continue; }
    }
    if (!critical) {
      if (relays === null) relays = d.relays ? d.relays() : [];
      const guess = named || inferredSession(it, relays, info);
      if (guess) {
        const sp = d.ownerSpokeAfter ? d.ownerSpokeAfter(guess, when) : null;
        if (sp) { if (guess !== named) mark('replied_in_lane', `you replied in "${title(guess)}" after this was raised, but not about this card - it is still open`); continue; }
        const rep = (undecided && undecided.test(text)) ? null : (d.sessionReportedAfter ? d.sessionReportedAfter(guess, when) : null);
        if (rep) { mark('orphaned', `the session "${title(guess)}" carried on past this and has since ended - this item is OWNERLESS, not done; it needs a new owner`); continue; }
      }
      if (rec && rec.test(text.slice(0, 160)) && now - when >= s.recordDays * DAY) {
        flag('low', `a record, not an ask, and ${s.recordDays} days old`, `raised ${iso(when)} - nothing was asked of you`);
      }
    }
  }
  return out;
}

/** What the Board build runs: land board answers always; resolve + sweep only with the inboxAutoResolve module. */
function maintain(deps = {}) {
  const out = { answers: 0, resolve: null, sweep: null };
  try { out.answers = ingestBoardAnswers(deps); } catch (e) { out.error = e.message; }
  if (deps.autoResolve !== undefined ? deps.autoResolve : config.mod('inboxAutoResolve')) {
    try { out.resolve = autoResolve(deps); } catch (e) { out.error = e.message; }
    try { out.sweep = sweep(null, deps); } catch (e) { out.error = e.message; }
  }
  return out;
}

// ---------------------------------------------------------------- command line (`relaymote inbox …`)
const USAGE = `relaymote inbox                                list: open first, newest at the top (--all: everything)
relaymote inbox add "<text>" [--session <id>] [--log]   record it verbatim (--log: a record, never on the Board)
relaymote inbox ask <n> decide|do|fyi "<ask>"   the one-line question the Board shows (≤200 chars)
relaymote inbox link <n> <session id>          attach the session it is about
relaymote inbox reopen <n> ["<why>"]           a probably-handled flag was wrong: back to open, pinned
relaymote inbox text <n> "<text>"              rewrite the text (the old text stays in the ledger)
relaymote inbox note <n> "<text>"              append to the note (never truncated)
relaymote inbox kind <n[,n..]> log|action      reclassify
relaymote inbox done|drop|wait <n> ["<note>"]  close, drop, or mark as being worked on
relaymote inbox sweep [days]                   close quiet log items; list stale actions
relaymote inbox show <n>                       one item with its history
Use - as the text to read it from stdin (a backtick in an inline argument is run by your shell).`;

function narrative(rest, stdin) { return rest.length === 1 && rest[0] === '-' ? String(stdin() || '') : rest.join(' '); }

function formatList(r) {
  const L = [`inbox: ${r.counts.open} for ${ownerName()} open - ${r.counts.waiting} waiting - ${r.counts.resolved} probably handled - ${r.counts.done} done`
    + ` (+${r.counts.logHidden} log items hidden; --all shows them)`];
  for (const it of r.items) {
    L.push(`  #${it.n} [${it.status}]${it.no_auto ? ' PINNED' : ''}${it.kind === 'log' ? ' log' : ''} ${String(it.ts || '').slice(5, 16)}  `
      + (it.ask ? `${String(it.ask_kind || '').toUpperCase()}: ${it.ask}` : String(it.text || '').slice(0, 220)));
    if (it.note) L.push('      note: ' + String(it.note).slice(0, 400));
  }
  if (r.resolved.length) {
    L.push('', `probably handled - closes itself ${settings().graceDays} days after a tap flagged it; inbox reopen <n> puts one back`);
    for (const it of r.resolved) L.push(`  #${it.n} [${it.resolved_tier || '?'}] ${String(it.text || '').slice(0, 120)}\n      ${it.resolved_why || ''}\n      evidence: ${it.resolved_evidence || ''}`);
  }
  return L.join('\n');
}

/** Returns { code, text }. Pure apart from the ledger; bin/relaymote.js prints it. */
function cli(argv, io = {}) {
  const stdin = io.stdin || (() => { try { return fs.readFileSync(0, 'utf8'); } catch { return ''; } });
  const a = (argv || []).slice();
  const sub = (a[0] || 'list').toLowerCase();
  const say = (r, okText) => r.ok ? { code: 0, text: [okText(r), ...(r.warnings || []).map(w => '  ^ ' + w)].join('\n') }
    : { code: 1, text: 'inbox: ' + (r.message || r.error) };
  if (sub === 'help' || sub === '--help' || sub === '-h') return { code: 0, text: USAGE };
  if (sub === 'list' || sub === '--all' || sub === 'ls') return { code: 0, text: formatList(list({ all: a.includes('--all') })) };
  if (sub === 'add') {
    const rest = a.slice(1);
    let session = null, kind = 'action';
    const i = rest.indexOf('--session');
    if (i >= 0) { session = rest[i + 1] || null; rest.splice(i, 2); }
    const j = rest.indexOf('--log');
    if (j >= 0) { kind = 'log'; rest.splice(j, 1); }
    const unknown = rest.filter(x => /^--./.test(x));
    if (unknown.length) {
      return { code: 2, text: `inbox add: unknown option ${unknown.join(', ')}. Valid: --session <id>, --log. Context goes in \`inbox note <n>\`, `
        + 'the question in `inbox ask <n> decide|do|fyi`. Nothing was written.' };
    }
    return say(add(narrative(rest, stdin), { session, kind, source: 'cli' }), r => `inbox #${r.n} added [${kind}]` + (session ? ` about ${session.slice(0, 14)}` : ''));
  }
  const n = a[1];
  if (!n && sub !== 'sweep') return { code: 2, text: USAGE };
  switch (sub) {
    case 'ask': return say(ask(n, a[2], narrative(a.slice(3), stdin)), r => `inbox #${r.n} ask set [${r.ask_kind}] ${r.ask.slice(0, 90)}`);
    case 'link': return say(link(n, a[2]), r => `inbox #${r.n} -> session ${r.session.slice(0, 14)}`);
    case 'reopen': return say(reopen(n, narrative(a.slice(2), stdin)), r => `inbox #${r.n} reopened and pinned (the auto-resolver will not touch it again)`);
    case 'text': return say(setText(n, narrative(a.slice(2), stdin)), r => `inbox #${r.n} rewritten (${r.chars} chars; first ${settings().visibleChars}: ${r.first})`);
    case 'note': return say(note(n, narrative(a.slice(2), stdin)), r => `inbox #${r.n} note added (status unchanged: ${r.status})`);
    case 'kind': return say(setKind(n, a[2]), r => `inbox ${r.changed.join(',')} -> kind ${r.kind}` + (r.missing.length ? ` (no such item: ${r.missing.join(',')})` : ''));
    case 'done': case 'drop': case 'wait': return say(setStatus(n, sub, narrative(a.slice(2), stdin)), r => `inbox #${r.n} -> ${r.status}`);
    case 'show': { const r = show(n); return r.ok ? { code: 0, text: JSON.stringify(r, null, 2) } : { code: 1, text: 'inbox: no item #' + n }; }
    case 'sweep': {
      const r = sweep(n);
      const L = [`sweep: closed ${r.closed.length} log item(s) older than ${r.days}d: ${r.closed.join(', ') || '-'}`];
      if (r.stale.length) { L.push(`still open and >${r.days}d old, and these ARE ${ownerName()}'s to action - chase or withdraw them:`); for (const s of r.stale) L.push(`  #${s.n} ${s.text}`); }
      return { code: 0, text: L.join('\n') };
    }
    default: return { code: 2, text: USAGE };
  }
}

module.exports = {
  DEFAULTS, CRITICAL_WORDS, RECORD_WORDS, UNDECIDED_WORDS, NOT_OWNER, FINISHED,
  file, actionsFile, boardDir, settings, ownerName, fold, all, get, list, show, newestFirst,
  add, ask, link, reopen, setText, note, setKind, setStatus, done, drop, wait, sweep,
  sessionOf, prefixMap, ingestBoardAnswers, taps, autoResolve, maintain, linkIsAbout, inferredSession,
  criticalRe, cli, USAGE,
};
