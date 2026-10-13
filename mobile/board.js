'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const bridge = require('../lib/bridge');
const orch = require('../lib/orchestrator');
const desktop = require('../lib/desktop');
const sessions = require('./sessions');
const resume = require('../lib/resume');

const config = require('../lib/config');
const CONDUCTOR_DIR = (config.get().board && config.get().board.dir) || path.join(config.DATA, 'board');
const BOARD_JSON = path.join(CONDUCTOR_DIR, 'board.json');
const INDEX_MD = path.join(CONDUCTOR_DIR, 'INDEX.md');
const AUDIT = path.join(CONDUCTOR_DIR, 'board-actions.jsonl');
const ACTED = path.join(require('../lib/config').STATE, 'board-acted.json');
const ACTED_TTL_MS = 12 * 3600 * 1000;

const Filter = require('./public/board-ui.js');
const Principals = require('./principals');
/** g1870: the device's principal (?as=) -> who it is, and the board narrowed to them (the default sees all). */
function principalOf(as) { return Principals.resolve(CONDUCTOR_DIR, as); }
function boardFor(board, p) { return p && p.own ? Principals.narrow(board, p, Principals.load(CONDUCTOR_DIR).default) : board; }
const log = (m) => { try { orch.log('[board] ' + m); } catch { console.log('[board] ' + m); } };

function readBoard() {
  let raw;
  try { raw = fs.readFileSync(BOARD_JSON, 'utf8'); }
  catch (e) {
    return { ok: false, error: 'no-board', detail: e.code === 'ENOENT'
      ? 'board.json not found in ' + CONDUCTOR_DIR + ' (see docs/BOARD.md for the format)'
      : e.message };
  }
  try { return Object.assign({ ok: true }, JSON.parse(raw)); }
  catch (e) { return { ok: false, error: 'bad-board', detail: e.message }; }
}

function conductorId(board) {
  if (config.get().conductorSession) return config.get().conductorSession;
  try {
    const first = fs.readFileSync(INDEX_MD, 'utf8').split(/\r?\n/, 1)[0] || '';
    const m = first.match(/^Conductor id:\s*(\S+)\s*$/);
    if (m && m[1] && m[1] !== 'unknown') return m[1];
  } catch {}
  const b = board || readBoard();
  return (b && b.conductor) || null;
}

function registryRow(sessionId) {
  const want = 'local_' + String(sessionId).replace(/^local_/, '') + '.json';
  let root;
  try { root = resume.registryRoot(); } catch { return null; }
  let best = null;
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) { walk(fp, depth + 1); continue; }
      if (e.name !== want) continue;
      let j; try { j = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { continue; }
      if (!j || !j.sessionId) continue;
      const row = { sessionId: j.sessionId, title: j.title || '', error: j.error || null,
                    errorAt: Number(j.errorAt) || null, isArchived: !!j.isArchived,
                    lastActivityAt: Number(j.lastActivityAt) || 0 };
      if (!best || row.lastActivityAt > best.lastActivityAt ||
          (row.lastActivityAt === best.lastActivityAt && (row.errorAt || 0) > (best.errorAt || 0))) best = row;
    }
  };
  walk(root, 0);
  return best;
}

/* The goal register (goals.jsonl, append-only: one row per change, folded by id) is the source of truth for
   goals; board.json is a snapshot the Conductor rebuilds every 30 min. A goal the Conductor has just
   named in a chat was therefore missing for up to half an hour, and a tapped gNNNN found nothing (g1881).
   Every read of the board folds the register in: rows newer than the snapshot win, new goals are added. */
const GOALS_JSONL = path.join(CONDUCTOR_DIR, 'goals.jsonl');
const GOAL_FIELDS = ['title', 'status', 'session', 'blocked_on', 'progress', 'outcome', 'due', 'checks', 'detail', 'principal'];
let goalCache = { mtime: 0, size: -1, map: new Map() };
function liveGoals() {
  let st;
  try { st = fs.statSync(GOALS_JSONL); } catch { return goalCache.map; }
  if (st.mtimeMs === goalCache.mtime && st.size === goalCache.size) return goalCache.map;
  const map = new Map();
  let text;
  try { text = fs.readFileSync(GOALS_JSONL, 'utf8'); } catch { return goalCache.map; }
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (!o || !/^g\d+$/.test(String(o.id || ''))) continue;
    const g = map.get(o.id) || { id: o.id };
    for (const k of GOAL_FIELDS) if (o[k] !== undefined) g[k] = o[k];
    if (o.closed_ts) g.closed_at = o.closed_ts;
    if (o.reopened_ts) g.closed_at = null;
    if (o.ts && (!g.ts || o.ts > g.ts)) g.ts = o.ts;
    map.set(o.id, g);
  }
  goalCache = { mtime: st.mtimeMs, size: st.size, map };
  return map;
}
/** board.json with the register's newer goal rows folded in (same object shape; the snapshot is not modified). */
function withLiveGoals(board) {
  const live = liveGoals();
  if (!live.size) return board;
  const built = Date.parse(board.built_at || '') || 0;
  const byId = new Map((board.goals || []).map(g => [g.id, g]));
  const goals = (board.goals || []).slice();
  for (const [id, g] of live) {
    const t = Date.parse(g.ts || '') || 0;
    const had = byId.get(id);
    // Unchanged since the snapshot: keep it, but carry the register's last-change time (the card's age).
    if (had && t <= built) { goals[goals.indexOf(had)] = Object.assign({}, had, { ts: g.ts || had.ts || null }); continue; }
    const merged = Object.assign({}, had || { condition: g.status === 'open' || !g.status ? 'FRESH' : null }, g, { fresh: true });
    if (!merged.status) merged.status = 'open';
    if (had) goals[goals.indexOf(had)] = merged; else goals.push(merged);
  }
  return Object.assign({}, board, { goals });
}
function readBoardLive() {
  const raw = readBoard();
  return raw.ok ? withLiveGoals(raw) : raw;
}

const INBOX_JSONL = path.join(CONDUCTOR_DIR, 'inbox.jsonl');
let noteCache = { mtime: 0, size: -1, map: new Map() };
/** n -> the item's CURRENT note, from the folded ledger (a later row that carries no note keeps the earlier one). */
function liveNotes() {
  let st;
  try { st = fs.statSync(INBOX_JSONL); } catch { return noteCache.map; }
  if (st.mtimeMs === noteCache.mtime && st.size === noteCache.size) return noteCache.map;
  const map = new Map();
  try {
    for (const [n, it] of require('../lib/inbox').fold().items) map.set(String(n), typeof it.note === 'string' ? it.note : '');
  } catch { return noteCache.map; }
  noteCache = { mtime: st.mtimeMs, size: st.size, map };
  return map;
}

const stCache = new Map();   // conductor id ('' = the default's) -> { at, val }

async function conductorState(board, opts) {
  const want = (opts && opts.id) || '';
  const hit = stCache.get(want);
  if (!(opts && opts.fresh) && hit && Date.now() - hit.at < 15000) return hit.val;
  const val = computeConductorState(board, want || null);
  stCache.set(want, { at: Date.now(), val });
  return val;
}

function computeConductorState(board, forId) {
  const id = forId || conductorId(board);
  if (!id) return { id: null, ok: false, reason: 'No Conductor session is claimed — set one in Settings > Conductor, or add "conductor" to board.json.' };

  let row = null, snapAt = null;
  try {
    const snap = desktop.loadSnapshot() || {};
    snapAt = snap.at || null;
    row = (snap.sessions || []).find(r => r.sessionId === id) || null;
  } catch {}
  if (!row) return { id, ok: false, reason: 'The Conductor session is not in the Claude Desktop sidebar.', at: snapAt };
  if (row.isArchived) return { id, ok: false, reason: 'The Conductor session is archived.', at: snapAt };

  let reg = null;
  try { reg = registryRow(id); } catch {}
  if (reg && reg.error) {
    return { id, ok: false, at: snapAt, reason: 'The Conductor is stopped: ' + String(reg.error).slice(0, 160) };
  }
  return { id, ok: true, at: snapAt, reason: row.running ? 'running — the line will queue behind its turn' : 'idle' };
}

function composeLine(cmd, id, title, extra) {
  const t = String(title || '').replace(/\s+/g, ' ').trim();
  const x = extra ? String(extra).replace(/[\r\n]+/g, ' ').trim() : '';
  return cmd + ' ' + id + (x ? ': ' + x : '') + '   # ' + t.slice(0, 50);
}

const inboxTitle = (r) => '#' + r.n + ' ' + String(r.text || '').slice(0, 300);

const KINDS = new Set(['yes', 'skip', 'answer', 'done', 'reopen']);

function lineFor(board, kind, id, text) {
  if (!KINDS.has(kind)) return { ok: false, error: 'bad-kind', detail: 'kind must be yes | skip | answer | done | reopen' };
  const raw = String(id == null ? '' : id).trim();
  if (!raw) return { ok: false, error: 'no-id' };

  const n = raw.startsWith('#') ? raw.slice(1) : raw;
  // An inbox item may be open, in flight (waiting) or probably handled (resolved?) — all three are tappable.
  const item = /^\d+$/.test(n) && [].concat(board.inbox || [], board.inbox_resolved || [], board.inbox_waiting || [])
    .find(r => String(r.n) === n);
  if (item) {
    if (kind === 'yes' || kind === 'skip') {
      return { ok: false, error: 'bad-kind', detail: 'inbox items take Done, Answer or Reinstate, not ' + kind };
    }
    const title = inboxTitle(item);
    if (kind === 'done') return { ok: true, line: composeLine('done', '#' + item.n, title), target: 'inbox', title };
    if (kind === 'reopen') return { ok: true, line: composeLine('reopen', '#' + item.n, title), target: 'inbox', title };
    if (!String(text || '').trim()) return { ok: false, error: 'no-text', detail: 'answer needs text' };
    return { ok: true, line: composeLine('answer', '#' + item.n, title, text), target: 'inbox', title };
  }

  // A goal (g1881): Done closes it, Yes = go ahead as the owner proposed, Answer carries his words, Reinstate reopens.
  const goal = /^g\d+$/i.test(raw) && (board.goals || []).find(g => String(g.id).toLowerCase() === raw.toLowerCase());
  if (goal) {
    if (kind === 'answer' && !String(text || '').trim()) return { ok: false, error: 'no-text', detail: 'answer needs text' };
    const cmd = { done: 'close', reopen: 'reopen', yes: 'go', skip: 'skip', answer: 'answer' }[kind];
    return { ok: true, line: composeLine(cmd, goal.id, goal.title, kind === 'answer' ? text : ''), target: 'goal', title: goal.title };
  }

  const row = (board.rows || []).find(r => r.id === raw);
  if (!row) return { ok: false, error: 'unknown-id', detail: raw + ' is not on the current board' };
  if (kind === 'done' || kind === 'reopen') return { ok: false, error: 'bad-kind', detail: 'Done and Reinstate are for inbox items; a session takes yes / skip / answer' };
  if (kind === 'answer' && !String(text || '').trim()) return { ok: false, error: 'no-text', detail: 'answer needs text' };
  return {
    ok: true,
    line: composeLine(kind, row.id, row.title, kind === 'answer' ? text : ''),
    target: 'session', title: row.title,
  };
}

const SEND_TIMEOUT_MS = 20000;

function withTimeout(p, ms, why) {
  let t;
  return Promise.race([
    Promise.resolve(p).finally(() => clearTimeout(t)),
    new Promise((_, rj) => { t = setTimeout(() => rj(new Error(why)), ms); }),
  ]);
}

function readActed() {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(ACTED, 'utf8')) || {}; } catch {}
  const now = Date.now(), out = {};
  for (const [id, r] of Object.entries(raw)) {
    if (r && r.at && now - r.at < ACTED_TTL_MS) out[id] = r;
  }
  return out;
}

function writeActed(map) {
  try {
    fs.mkdirSync(path.dirname(ACTED), { recursive: true });
    fs.writeFileSync(ACTED, JSON.stringify(map), 'utf8');
  } catch (e) { log('acted write failed: ' + e.message); }
}

function recordActed(id, kind) {
  const m = readActed();
  m[String(id)] = { kind, at: Date.now() };
  writeActed(m);
}

function unhide(id) {
  const m = readActed();
  const had = Object.prototype.hasOwnProperty.call(m, String(id));
  delete m[String(id)];
  writeActed(m);
  return had;
}

function audit(rec) {
  try {
    fs.mkdirSync(CONDUCTOR_DIR, { recursive: true });
    fs.appendFileSync(AUDIT, JSON.stringify(rec) + '\n', 'utf8');
  } catch (e) { log('audit write failed: ' + e.message); }
}

async function act({ kind, id, text, who, as }) {
  const raw = readBoardLive();
  if (!raw.ok) return { code: 503, body: { ok: false, error: raw.error, detail: raw.detail } };
  const p = principalOf(as);
  const board = boardFor(raw, p);     // Sagar's taps reach only Sagar's items, and go to Sagar Conductor

  const l = lineFor(board, kind, id, text);
  if (!l.ok) return { code: 400, body: l };

  const st = await STATE_FN(raw, { fresh: true, id: p.conductor });
  if (!st.ok) {
    audit({ at: new Date().toISOString(), kind, id, line: l.line, who: who || 'mobile', result: 'refused', reason: st.reason });
    return { code: 429, body: { ok: false, error: 'conductor-unavailable', reason: st.reason, conductor: st.id, line: l.line } };
  }

  const message = '[board] ' + l.line;
  let out;
  try {
    out = await withTimeout(SEND(st.id, message, {
      origin: { kind: 'peer', sessionId: 'baton-mobile-board' },
      initiator: 'baton-mobile-board',
    }), SEND_TIMEOUT_MS, 'the bridge did not answer in ' + (SEND_TIMEOUT_MS / 1000) + 's');
  } catch (e) {
    out = { ok: false, error: 'SEND_THREW', reason: e.message };
  }

  const rec = {
    at: new Date().toISOString(), kind, id, target: l.target, line: l.line, message,
    conductor: st.id, who: who || 'mobile', principal: p.key,
    result: out.ok ? (out.delivered ? 'delivered' : 'queued') : 'failed',
    reason: out.reason || out.error || null,
  };
  audit(rec);
  log(rec.result + ': ' + l.line);
  if (out.ok) { recordActed(id, kind); closeRelaymoteNote(board, l, kind); }

  if (!out.ok) {
    return { code: 429, body: { ok: false, error: 'send-failed', reason: rec.reason || 'the send did not complete', line: l.line, conductor: st.id } };
  }
  return { code: 200, body: { ok: true, line: l.line, message, delivered: !!out.delivered, queued: !!out.queued, conductor: st.id, at: rec.at } };
}

let SEND = (sid, msg, opts) => bridge.sendMessage(sid, msg, opts);
let STATE_FN = (board, opts) => conductorState(board, opts);
function _setSender(fn) { const p = SEND; SEND = fn || ((s, m, o) => bridge.sendMessage(s, m, o)); return p; }
function _setConductorState(fn) { const p = STATE_FN; STATE_FN = fn || ((b, o) => conductorState(b, o)); return p; }

/** On Relaymote's own board a delivered Done closes the inbox item and a Reinstate re-opens (and pins) it. */
function closeRelaymoteNote(board, l, kind) {
  if ((kind !== 'done' && kind !== 'reopen') || l.target !== 'inbox' || board.generator !== 'relaymote') return;
  const n = String(l.line).split(' ')[1];
  try {
    const inbox = require('../lib/inbox');
    if (kind === 'done') inbox.done(n, 'by ' + inbox.ownerName() + ' from the board');
    else inbox.reopen(n, 'from the board');
  } catch (e) { log('inbox update failed: ' + e.message); }
}

/**
 * Several queued taps delivered to the Conductor as ONE message, one "[board] <line>" per tap. The app
 * queues every tap and sends the queue when you tap "Send all", close the board, or reopen the app
 * with a queue left over. `bid` names the batch: a retry of the same batch (the answer was lost on
 * the way back) is answered from memory and never delivered twice.
 */
const BATCHES = new Map();
async function actBatch({ items, bid, who, as } = {}) {
  bid = bid ? String(bid).slice(0, 80) : null;
  if (bid && BATCHES.has(bid)) return { code: 200, body: { ...BATCHES.get(bid), repeat: true } };
  const raw = readBoardLive();
  if (!raw.ok) return { code: 503, body: { ok: false, error: raw.error, detail: raw.detail } };
  const p = principalOf(as);
  const board = boardFor(raw, p);
  const byId = new Map();
  const rejected = [];
  for (const it of (Array.isArray(items) ? items : []).slice(0, 50)) {
    const l = lineFor(board, it && it.kind, it && it.id, it && it.text);
    if (l.ok) byId.set(String(it.id), { ...l, id: String(it.id), kind: it.kind });
    else rejected.push({ id: it && it.id, kind: it && it.kind, error: l.error, detail: l.detail || null });
  }
  const lines = [...byId.values()];
  if (!lines.length) return { code: 400, body: { ok: false, error: 'nothing-to-send', rejected } };

  const st = await STATE_FN(raw, { fresh: true, id: p.conductor });
  const batch = bid || 'b' + Date.now().toString(36);
  if (!st.ok) {
    audit({ at: new Date().toISOString(), kind: 'batch', batch, lines: lines.map(l => l.line), who: who || 'mobile', result: 'refused', reason: st.reason });
    return { code: 429, body: { ok: false, error: 'conductor-unavailable', reason: st.reason, conductor: st.id, rejected } };
  }
  const message = lines.map(l => '[board] ' + l.line).join('\n');
  let out;
  try {
    out = await withTimeout(SEND(st.id, message, {
      origin: { kind: 'peer', sessionId: 'baton-mobile-board' }, initiator: 'baton-mobile-board',
    }), SEND_TIMEOUT_MS, 'the bridge did not answer in ' + (SEND_TIMEOUT_MS / 1000) + 's');
  } catch (e) { out = { ok: false, error: 'SEND_THREW', reason: e.message }; }
  const at = new Date().toISOString();
  const result = out.ok ? (out.delivered ? 'delivered' : 'queued') : 'failed';
  // One summary record for the batch, then the per-line records the Conductor's index reads (id + kind).
  audit({ at, kind: 'batch', batch, n: lines.length, ids: lines.map(l => l.id), who: who || 'mobile', principal: p.key, conductor: st.id, result, reason: out.reason || out.error || null });
  for (const l of lines) {
    audit({ at, kind: l.kind, id: l.id, target: l.target, line: l.line, batch, conductor: st.id, who: who || 'mobile', result, reason: out.reason || out.error || null });
    if (out.ok) { recordActed(l.id, l.kind); closeRelaymoteNote(board, l, l.kind); }
  }
  log(`${result}: batch of ${lines.length}`);
  if (!out.ok) return { code: 429, body: { ok: false, error: 'send-failed', reason: out.reason || out.error || 'the send did not complete', rejected } };
  const body = { ok: true, sent: lines.length, n: lines.length, ids: lines.map(l => l.id), rejected, message, delivered: !!out.delivered, queued: !!out.queued, conductor: st.id, at, batch };
  if (bid) {
    BATCHES.set(bid, body);
    while (BATCHES.size > 200) BATCHES.delete(BATCHES.keys().next().value);
  }
  return { code: 200, body };
}

async function view({ as } = {}) {
  const raw = readBoardLive();
  if (!raw.ok) return { code: 503, body: raw };
  const p = principalOf(as);
  const board = boardFor(raw, p);
  let st;
  try { st = await conductorState(raw, { id: p.conductor }); }
  catch (e) { st = { id: board.conductor || null, ok: false, reason: 'Conductor check failed: ' + e.message }; }
  let recent = [];
  try {
    recent = fs.readFileSync(AUDIT, 'utf8').trim().split('\n').slice(-60)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(r => r && r.result !== 'refused' && r.kind !== 'batch')
      .map(r => ({ at: r.at, id: String(r.id), kind: r.kind, result: r.result }));
  } catch {}
  const titles = new Map();
  /** A session's sidebar title: the lane a goal or ask belongs to, in his words rather than an id. */
  const titleOf = (sid) => {
    if (!sid) return null;
    if (!titles.has(sid)) { let t = null; try { const s = sessions.get(sid); t = s && s.title || null; } catch {} titles.set(sid, t); }
    return titles.get(sid);
  };
  const actedMap = readActed();
  const mark = (row, key) => {
    const a = actedMap[String(key)];
    return a ? Object.assign({}, row, { acted: { kind: a.kind, at: new Date(a.at).toISOString() } }) : row;
  };

  const rows = (board.rows || []).map(r => {
    let openable = false;
    try { openable = !!sessions.get(r.id); } catch {}
    return mark(Object.assign({}, r, { openable }), r.id);
  });
  const notes = liveNotes();
  const inbox = (board.inbox || []).map(r => {
    let openable = false;
    if (r.session) { try { openable = !!sessions.get(r.session); } catch {} }
    const live = notes.get(String(r.n));
    const note = live === undefined ? (r.note || '') : live;
    return mark(Object.assign({}, r, { openable, note, lane: titleOf(r.session) }), '#' + r.n);
  });

  // The SAME predicate the app's chips use (mobile/public/board-ui.js Filter), with no age cut-off:
  // a lane waiting two weeks needs you more than one waiting two days, so it must still be counted.
  const counts = {};
  for (const b of ['buried', 'decide', 'nudge', 'un', 'open']) counts[b] = rows.filter(r => Filter.matches(r, { bucket: b })).length;
  counts.inbox = inbox.filter(r => Filter.matches(r, { bucket: 'inbox' })).length;
  const openable = (sid) => { if (!sid) return false; try { return !!sessions.get(sid); } catch { return false; } };
  const inboxSide = (list) => (list || []).map(r => mark(Object.assign({}, r, { openable: openable(r.session), lane: titleOf(r.session) }), '#' + r.n));

  return {
    code: 200,
    body: {
      ok: true, built_at: board.built_at, counts, builtCounts: board.counts, projects: board.projects,
      labels: board.labels, hints: board.hints, rows, inbox,
      inbox_waiting: inboxSide(board.inbox_waiting), inbox_resolved: inboxSide(board.inbox_resolved),
      owner_name: board.owner_name || 'you',
      // g1881: the phone shows one card per goal, never the whole history. The full texts of ~1,800 finished
      // goals made this response 4.3 MB, so a tapped goal took seconds to appear on a phone.
      goals: (board.goals || []).map(g => {
        const fin = Filter.FINISHED.includes(g.status);
        const cut = (s, n) => s ? String(s).slice(0, n) : null;
        return {
          id: g.id, title: cut(g.title, fin ? 140 : 400), status: g.status || 'open', due: g.due || null,
          session: g.session || null, owner: titleOf(g.session), fresh: !!g.fresh, ts: g.ts || null,
          blocked_on: fin ? null : cut(g.blocked_on, 600),
          checks: !fin && Array.isArray(g.checks) ? g.checks.slice(0, 2).map(c => String(c).slice(0, 300)) : [],
          progress: cut(g.progress, fin ? 0 : 600), outcome: cut(g.outcome, fin ? 160 : 300),
          detail: fin ? '' : String(g.detail || '').slice(0, 400),
          project: g.project || '', condition: g.condition || null, closed_at: g.closed_at || null,
          principal: g.principal || null,
        };
      }).map(g => mark(g, g.id)),
      goals_waiting: board.goals_waiting || [],
      finished_older: board.finished_older || 0, finished_keep_days: board.finished_keep_days || 3,
      goals_health: board.goals_health ? { at: board.goals_health.at || null, counts: board.goals_health.counts || null } : null,
      hygiene: board.hygiene || null,
      conductor: { id: st.id, ok: st.ok, reason: st.reason, at: st.at || null },
      principal: { key: p.key, name: p.name, own: p.own, conductor: p.conductor || st.id || null },
      principals: Principals.list(CONDUCTOR_DIR),
      recent,
    },
  };
}

// g1885: the phone opened the board over mobile data in seconds — the full view is ~420 KB gzipped (1,883 goals).
// The first screen needs only "Needs you". viewCached() keeps one built view per principal while nothing it
// reads has changed (board.json, goals.jsonl, taps, the audit) and for at most 15 s; needs() cuts it down to the
// cards Needs you shows, the tab counts, and (when a chat link asked for one) that goal and its asks.
const VIEW_TTL = 15000;
const viewMemo = new Map();
const stampOf = () => [BOARD_JSON, GOALS_JSONL, ACTED, AUDIT].map(f => { try { const s = fs.statSync(f); return s.mtimeMs + ':' + s.size; } catch { return '-'; } }).join('|');
async function viewCached({ as } = {}) {
  const key = String(principalOf(as).key || ''), stamp = stampOf(), hit = viewMemo.get(key);
  if (hit && hit.stamp === stamp && Date.now() - hit.at < VIEW_TTL) return hit.r;
  const r = await view({ as });
  if (r.code === 200) viewMemo.set(key, { stamp, at: Date.now(), r });
  return r;
}
/** The whole board as the phone gets it: goals finished more than finished_keep_days ago stay on the PC (they were
 *  ~1,770 of 1,883 goals and most of the 412 KB). A goal id still finds any of them through needs({ goal }). */
function phoneFull(body) {
  if (!body || !body.ok) return body;
  const keep = (Number(body.finished_keep_days) || 3) * 86400000, now = Date.now();
  const goals = (body.goals || []).filter(g => !Filter.FINISHED.includes(g.status) || now - (Date.parse(g.closed_at || g.ts || '') || 0) < keep);
  return Object.assign({}, body, { goals, finished_hidden: (body.goals || []).length - goals.length });
}
const NEED_OLD_DAYS = 7;
const cut = (s, n) => s == null ? s : String(s).length > n ? String(s).slice(0, n) : s;
async function needs({ as, goal } = {}) {
  const r = await viewCached({ as });
  if (r.code !== 200) return r;
  const v = r.body, p = v.principal || {};
  const me = (p.own && p.name) || v.owner_name || 'you';
  const gid = /^g\d+$/i.test(String(goal || '')) ? String(goal).toLowerCase() : '';
  const inbox = [], old_ids = [];
  for (const x of v.inbox || []) {
    if (x.status !== 'open' || Filter.isDone(x)) continue;
    const old = (Filter.ageOf(x) || 0) > NEED_OLD_DAYS;
    const named = gid && new RegExp('\\b' + gid + '\\b', 'i').test((x.ask || '') + ' ' + (x.text || ''));
    // Older than a week sits in a closed fold: its number is enough (count, "Mark all done") until it opens.
    if (old && !named) { old_ids.push(x.n); continue; }
    inbox.push(Object.assign({}, x, { text: cut(x.text, 700), ask: cut(x.ask, 400), note: cut(x.note, 300) }));
  }
  const rows = (v.rows || []).filter(x => !Filter.isDone(x) && ['decide', 'buried', 'nudge'].includes(x.bucket))
    .map(x => Object.assign({}, x, { ask: x.ask ? String(x.ask).slice(-600) : x.ask }));
  const goals = (v.goals || []).filter(g => (!Filter.FINISHED.includes(g.status) && !g.acted && ['you', 'check'].includes(Filter.goalKind(g, me)))
    || (gid && String(g.id).toLowerCase() === gid));
  return { code: 200, body: {
    ok: true, light: true, built_at: v.built_at, owner_name: v.owner_name, principal: v.principal, principals: v.principals,
    conductor: v.conductor, finished_keep_days: v.finished_keep_days, goal: gid || null,
    tab_counts: Filter.tabCounts(v, me), inbox, old_ids, rows, goals, inbox_waiting: [], inbox_resolved: [],
  } };
}

module.exports = { CONDUCTOR_DIR, GOALS_JSONL, liveGoals, withLiveGoals, readBoardLive, view, viewCached, needs, phoneFull, act, actBatch, principalOf, _setSender, _setConductorState, unhide, readActed, readBoard, liveNotes, conductorId, conductorState, composeLine, lineFor, BOARD_JSON, AUDIT };
