// goals.js — the goal register, the goal chaser and the cache keeper.
//
// The register is <data>/goals/goals.jsonl, an APPEND-ONLY ledger: every change to a goal is one
// line { id, at, ev, ...changed fields }, and a goal is the fold of its lines (last value wins, null
// clears). Nothing is ever rewritten, so a goal's whole history is readable and a crashed writer
// loses at most its own line. A goal has one owner session. Each cycle classifies every open goal
// into one condition (below), hands new or re-homed goals to their owner, and nudges an owner that
// stopped before finishing. The cache keeper times those nudges so they land while the owner's
// prompt cache is still warm: a warm wake re-reads the context from cache, a cold one re-writes all
// of it. An owner gets at most ONE message per cycle carrying all of its goals, and a message is
// only sent after the app has confirmed that the owner is idle right now.
//
// An owner's DONE is not a close: it makes the goal DELIVERED, which waits for the Conductor or the
// user to read the evidence and close it (settings goals.requireVerification false restores the
// old "done closes it" behaviour). The collected ledger (collected.jsonl) records whose finished
// work has been read, so it is not raised again until that session writes something new.
'use strict';
const fs = require('fs');
const path = require('path');
const config = require('./config');

const DIR = path.join(config.DATA, 'goals');
const FILE = path.join(DIR, 'goals.jsonl');
const LEGACY_FILE = path.join(DIR, 'goals.json');
const CHASE_LOG = path.join(DIR, 'chase.jsonl');
const NOTES = path.join(DIR, 'notes.jsonl');
const EVENTS = path.join(DIR, 'goals-events.jsonl');
const HEALTH = path.join(DIR, 'goals-health.json');
const STATE = path.join(DIR, 'goals-state.json');
const COLLECTED = path.join(DIR, 'collected.jsonl');
const OVERSIZE = path.join(DIR, 'oversize');

// quietHours: a goal whose owner has said nothing for this long is STUCK (the health condition).
// warmPingMinQuietHours: the least quiet time before a goal is worth a ping inside the owner's warm
// cache window (a warm ping is cheap, so it may come well before the goal counts as stuck).
const GOAL_DEFAULTS = {
  autoSpawn: false, quietHours: 36, warmPingMinQuietHours: 4, maxChasesPerCycle: 5,
  rechaseHours: 96, maxChases: 3, blockedStaleDays: 7, warmRechaseHours: 12, autoRehome: false,
  requireVerification: true,
};
const CACHE_DEFAULTS = { windowMinutes: 60, pingFromMinutes: 25, pingUntilMinutes: 55, coldAfterHours: 72, keepConductorWarm: false };
const TEXT_CAP = 4000;
const KEEPALIVE_PER_3H = 2;
const SNAPSHOT_MAX_AGE_MS = 5 * 60000;
const H = 3600000, M = 60000;

const FINISHED = ['done', 'closed', 'failed', 'dropped'];
const PENDING_WORK = ['STUCK', 'LATE', 'FRESH', 'WATCH', 'HANDED-OVER'];
const CHASEABLE = ['STUCK', 'LATE'];
const ORDER = ['VERIFY-NOW', 'DELIVERED', 'ORPHAN', 'UNTOLD', 'UNRESPONSIVE', 'LATE', 'STUCK', 'BLOCKED-STALE', 'BLOCKED',
  'OFFLINE', 'HANDED-OVER', 'AWAITING-VERIFICATION', 'WATCH', 'FRESH'];

const iso = (t) => new Date(t).toISOString();
const ms = (s) => { const t = Date.parse(s || ''); return isNaN(t) ? 0 : t; };
const oneLine = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const clip = (s, n) => { const t = oneLine(s); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

/** A settings.json written before quietHours existed may carry stuckHours; honour it as quietHours. */
function legacyQuiet() {
  try {
    const raw = JSON.parse(fs.readFileSync(config.SETTINGS_FILE, 'utf8'));
    const g = (raw && raw.goals) || {};
    return g.quietHours === undefined && g.stuckHours !== undefined ? { quietHours: Number(g.stuckHours) } : {};
  } catch { return {}; }
}
function settings(over = {}) {
  const c = config.get();
  const mods = { ...(c.modules || {}), ...(over.modules || {}) };
  const g = { ...GOAL_DEFAULTS, ...(c.goals || {}), ...legacyQuiet(), ...(over.goals || {}) };
  delete g.stuckHours;
  return {
    goals: g,
    cache: { ...CACHE_DEFAULTS, ...(c.cacheKeeper || {}), ...(over.cacheKeeper || {}) },
    chaser: !!mods.goalChaser,
    keeper: !!mods.cacheKeeper,
    conductor: over.conductor !== undefined ? over.conductor : conductorId(),
  };
}
function conductorId() { try { return require('./master-protocol').conductorId(); } catch { return config.get().conductorSession || null; } }

// ---------------------------------------------------------------- register: an append-only ledger
const LONE_BACKSLASH = /\\(?!["\\/bfnrtu])/g;
const GOAL_ID = /^g\d+$/;
const validRow = (g) => !!(g && typeof g === 'object' && typeof g.id === 'string' && GOAL_ID.test(g.id) && g.title);
const LEDGER_META = ['id', 'at', 'ev'];

/** Parse a text of JSON lines tolerantly: a lone backslash is repaired, an unparsable line is COUNTED, never skipped silently. */
function parseLines(text) {
  const rows = [];
  let corrupt = 0, repaired = 0;
  for (const line of String(text || '').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { rows.push(JSON.parse(s)); continue; } catch {}
    try { rows.push(JSON.parse(s.replace(LONE_BACKSLASH, '\\\\'))); repaired++; } catch { corrupt++; }
  }
  return { rows, corrupt, repaired };
}

/**
 * One-time: turn a goals.json written by an earlier Relaymote into the ledger. Rows that are not usable
 * goals are carried across as `migrated-unusable` lines (kept and counted). The old file is renamed
 * to goals.json.migrated, never deleted. An unparsable goals.json is left exactly as it is, and the
 * register reports itself unreadable rather than starting an empty ledger over it.
 */
function migrateLegacy() {
  if (fs.existsSync(FILE) || !fs.existsSync(LEGACY_FILE)) return { migrated: 0 };
  const raw = fs.readFileSync(LEGACY_FILE, 'utf8');
  let j = null;
  try { j = JSON.parse(raw); } catch { try { j = JSON.parse(raw.replace(LONE_BACKSLASH, '\\\\')); } catch { j = null; } }
  if (!j || typeof j !== 'object') return { unreadable: true };
  const at = iso(Date.now());
  const rows = Array.isArray(j.goals) ? j.goals : [];
  const lines = [JSON.stringify({ id: 'register', at, ev: 'meta', next: Number(j.next) || 1, migratedFrom: 'goals.json' })];
  for (const r of rows) lines.push(JSON.stringify(validRow(r) ? { ...r, id: r.id, at: r.createdAt || at, ev: 'migrated' } : { id: 'register', at, ev: 'migrated-unusable', raw: r }));
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = FILE + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, lines.join('\n') + '\n');
  fs.renameSync(tmp, FILE);
  try { fs.renameSync(LEGACY_FILE, LEGACY_FILE + '.migrated'); } catch {}
  return { migrated: rows.length };
}

/**
 * Fold the ledger. -> { next, goals (usable), bad (rows kept but unusable), corrupt (count of lines
 * that could not be used), repaired, unreadable, meta: id -> { rows, first, last } }
 */
function load() {
  let mig = {};
  try { mig = migrateLegacy(); } catch (e) { mig = { unreadable: true, error: e.message }; }
  if (mig.unreadable) return { version: 2, next: 1, goals: [], bad: [], corrupt: 1, repaired: 0, unreadable: true, meta: {} };
  let text = '';
  try { text = fs.readFileSync(FILE, 'utf8'); } catch {}
  const { rows, corrupt, repaired } = parseLines(text);
  const byId = new Map(), meta = {}, bad = [];
  let next = 1;
  for (const r of rows) {
    if (r && r.ev === 'meta') { next = Math.max(next, Number(r.next) || 1); continue; }
    if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !GOAL_ID.test(r.id)) { bad.push(r && r.raw !== undefined ? r.raw : r); continue; }
    const g = byId.get(r.id) || {};
    for (const [k, v] of Object.entries(r)) {
      if (k === 'at' || k === 'ev') continue;
      if (v === undefined) continue;
      g[k] = v;
    }
    byId.set(r.id, g);
    const m = meta[r.id] || (meta[r.id] = { rows: 0, first: r.at || null, last: null });
    m.rows++; m.last = r.at || m.last;
  }
  const goals = [];
  for (const g of byId.values()) {
    if (validRow(g)) goals.push(g); else bad.push(g);
    next = Math.max(next, (Number(g.id.slice(1)) || 0) + 1);
  }
  goals.sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
  const reg = { version: 2, next, goals, bad, corrupt: corrupt + bad.length, repaired, meta };
  Object.defineProperty(reg, '_snap', { value: new Map(goals.map(g => [g.id, JSON.stringify(g)])), enumerable: false });
  return reg;
}
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}
/** The rows `save` would append: one per new or changed goal, with only the fields that changed. */
function diffRows(reg, ev, now = Date.now()) {
  const out = [];
  const snap = reg._snap || new Map();
  for (const g of reg.goals) {
    if (!g || !g.id) continue;
    const before = snap.get(g.id);
    const tag = g._ev || ev || 'change';
    const clean = {};
    for (const [k, v] of Object.entries(g)) if (!k.startsWith('_') && v !== undefined) clean[k] = v;
    if (!before) { out.push({ ...clean, id: g.id, at: iso(now), ev: tag === 'change' ? 'added' : tag }); continue; }
    const prev = JSON.parse(before), patch = {};
    for (const k of new Set([...Object.keys(prev), ...Object.keys(clean)])) {
      if (LEDGER_META.includes(k)) continue;
      const a = JSON.stringify(prev[k] === undefined ? null : prev[k]), b = JSON.stringify(clean[k] === undefined ? null : clean[k]);
      if (a !== b) patch[k] = clean[k] === undefined ? null : clean[k];
    }
    if (Object.keys(patch).length) out.push({ id: g.id, at: iso(now), ev: tag, ...patch });
  }
  return out;
}
/** Append what changed. Never rewrites the ledger. */
function save(reg, ev) {
  if (reg.unreadable) throw new Error('REGISTER_UNREADABLE: ' + LEGACY_FILE + ' could not be parsed; it was left untouched and no ledger was started over it');
  const rows = diffRows(reg, ev);
  if (!rows.length) return 0;
  fs.mkdirSync(DIR, { recursive: true });
  fs.appendFileSync(FILE, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  reg._snap && rows.forEach(r => { const g = reg.goals.find(x => x.id === r.id); if (g) { delete g._ev; reg._snap.set(g.id, JSON.stringify(g)); } });
  return rows.length;
}
/** Read, change and append in one step. `ev` names the change in the ledger. */
function mutate(fn, ev) { const reg = load(); const out = fn(reg); save(reg, ev); return out; }
/** Every ledger line for one goal, oldest first: its history. */
function history(id) {
  let text = '';
  try { text = fs.readFileSync(FILE, 'utf8'); } catch {}
  return parseLines(text).rows.filter(r => r && r.id === id);
}

function normDue(d) {
  if (!d) return null;
  const t = Date.parse(d);
  return isNaN(t) ? null : iso(t);
}
function capText(id, text) {
  const t = String(text || '');
  if (t.length <= TEXT_CAP) return { text: t };
  const f = path.join(OVERSIZE, id + '.txt');
  try { fs.mkdirSync(OVERSIZE, { recursive: true }); fs.writeFileSync(f, t); } catch {}
  return { text: t.slice(0, TEXT_CAP) + ' …[full text: ' + f + ']', textFile: f };
}
function find(reg, id) {
  const want = String(id || '').trim().toLowerCase();
  return reg.goals.find(g => g.id.toLowerCase() === want) || null;
}

function route(g, deps = {}) {
  const resolve = deps.resolve || ((topic, o) => require('./owner').resolve(topic, o));
  let r;
  try { r = resolve(g.title + ' ' + (g.text || ''), { project: g.project || undefined }); }
  catch (e) { r = { ok: false, refusal: e.message }; }
  if (r && r.ok) {
    g.ownerSessionId = r.owner;
    g.project = g.project || r.project || null;
    g.routing = { state: 'routed', why: (r.why || []).slice(0, 3).join('; ') || 'owner index', score: r.score || null };
  } else {
    g.project = g.project || (r && (r.project || (r.spawn && r.spawn.project))) || null;
    g.routing = { ...(g.routing || {}), state: 'unrouted', why: clip((r && (r.refusal || (r.spawn && r.spawn.why))) || 'no owner found', 200) };
  }
  return g;
}

// ---------------------------------------------------------------- goal operations
/** Add a goal. Without an owner it is routed through the owner index; unrouted goals wait on the board. */
function add(input = {}, deps = {}) {
  const now = deps.now || Date.now();
  const title = clip(input.title || input.text || input.detail, 160);
  if (!title) return { ok: false, error: 'TITLE_REQUIRED', message: 'A goal needs a title or text.' };
  const g = {
    id: null, title, text: '', checks: (Array.isArray(input.checks) ? input.checks : []).map(c => clip(c, 200)).filter(Boolean).slice(0, 12),
    project: input.project ? String(input.project) : null, ownerSessionId: input.ownerSessionId || null, status: 'open',
    createdAt: iso(now), due: normDue(input.due), verifyBy: normDue(input.verifyBy), verifyWhat: input.verifyWhat ? clip(input.verifyWhat, 300) : null,
    lastProgressAt: null, progress: null, blockedOn: null, deliveredAt: null,
    lastChaseAt: null, chases: 0, unanswered: 0, told: !!input.told, toldAt: input.told ? iso(now) : null,
    source: input.source || 'api',
  };
  const conductor = deps.conductor !== undefined ? deps.conductor : conductorId();
  if (g.ownerSessionId && conductor && g.ownerSessionId === conductor) { g.told = true; g.toldAt = iso(now); }
  if (g.ownerSessionId) g.routing = { state: 'routed', why: 'owner given' };
  else route(g, deps);
  const body = input.text || input.detail || '';
  mutate(reg => {
    g.id = 'g' + reg.next++;
    Object.assign(g, capText(g.id, body));
    reg.goals.push(g);
  }, 'added');
  return { ok: true, goal: g };
}

function withGoal(id, fn, ev) {
  return mutate(reg => {
    const g = find(reg, id);
    if (!g) return { ok: false, error: 'NO_SUCH_GOAL', id };
    return fn(g, reg);
  }, ev);
}

/**
 * Close as done or failed. Evidence is required, a closed goal cannot be closed again, and closing on
 * a session's evidence COLLECTS that session's work (collected.jsonl), so it is not raised again.
 */
function close(id, opts = {}) {
  const status = ['done', 'failed', 'dropped', 'closed'].includes(opts.status) ? opts.status : 'done';
  const note = oneLine(opts.note || opts.evidence || '');
  if (!note && status !== 'dropped') return { ok: false, error: 'EVIDENCE_REQUIRED', message: 'Say what shows it is ' + status + '.' };
  const out = withGoal(id, (g) => {
    if (FINISHED.includes(g.status)) return { ok: false, error: 'ALREADY_CLOSED', status: g.status, closedAt: g.closedAt };
    g.status = status; g.closedAt = iso(opts.now || Date.now()); g.outcome = clip(note, 400) || null; g.closedBy = opts.by || null;
    return { ok: true, goal: g };
  }, 'close');
  if (out.ok && out.goal.ownerSessionId && status !== 'dropped') {
    try { recordCollected(out.goal.ownerSessionId, out.goal.id, `closed ${status}: ${clip(note, 160)}`, opts.now); } catch {}
  }
  return out;
}

// Bookkeeping in the shape of a report ("RE-HOMED …", "TOLD …") says who owns a goal, never what
// happened to it; counting it as a report made goals nobody had answered look freshly reported.
const HANDOVER_RX = /^\W*(RE-?HOMED|RE-?ASSIGNED|REASSIGNED|HANDED OVER|TOLD)\b/i;

/**
 * A report from the owner. "DONE: <evidence>" DELIVERS it: the goal waits for the Conductor or the
 * user to read the evidence and close it (or, with a verify date, for that date). With settings
 * goals.requireVerification false, DONE with evidence closes it directly. "BLOCKED on <what>" sets
 * blockedOn; a hand-over note is recorded but is not a report; anything else is progress.
 */
function report(id, text, opts = {}) {
  const now = opts.now || Date.now();
  const t = oneLine(text);
  if (!t) return { ok: false, error: 'TEXT_REQUIRED' };
  const requireVerification = opts.requireVerification !== undefined ? !!opts.requireVerification : settings().goals.requireVerification !== false;
  let closed = null;
  const out = withGoal(id, (g) => {
    if (FINISHED.includes(g.status)) return { ok: false, error: 'ALREADY_CLOSED', status: g.status };
    if (HANDOVER_RX.test(t)) { g.handoverNote = clip(t, 300); g.handoverAt = iso(now); g._ev = 'handover-note'; return { ok: true, goal: g, kind: 'handover-note' }; }
    g.lastProgressAt = iso(now); g.unanswered = 0; g.progress = clip(t, 400);
    const done = /^done\b[\s:.-]*(.*)$/i.exec(t), blocked = /^blocked\b(?:\s+on)?[\s:.-]*(.*)$/i.exec(t);
    if (blocked) { g.blockedOn = clip(blocked[1] || 'blocked', 300); return { ok: true, goal: g, kind: 'blocked' }; }
    g.blockedOn = null;
    if (done) {
      const ev = oneLine(done[1]);
      if (ev && !g.verifyBy && !requireVerification) {
        g.status = 'done'; g.closedAt = iso(now); g.outcome = clip(ev, 400); g.closedBy = opts.by || 'report';
        closed = g;
        return { ok: true, goal: g, kind: 'closed' };
      }
      g.deliveredAt = iso(now); g._ev = 'delivered';
      return { ok: true, goal: g, kind: g.verifyBy ? 'awaiting-verification' : 'delivered' };
    }
    return { ok: true, goal: g, kind: 'progress' };
  }, 'report');
  if (closed && closed.ownerSessionId) { try { recordCollected(closed.ownerSessionId, closed.id, 'closed on its own report', now); } catch {} }
  return out;
}

function reopen(id, reason, opts = {}) {
  const why = oneLine(reason);
  if (!why) return { ok: false, error: 'REASON_REQUIRED' };
  return withGoal(id, (g) => {
    if (!FINISHED.includes(g.status)) return { ok: false, error: 'NOT_CLOSED', status: g.status };
    g.status = 'open'; g.reopenedAt = iso(opts.now || Date.now()); g.reopenReason = clip(why, 300);
    g.closedAt = null; g.deliveredAt = null; g.unanswered = 0; g.lastProgressAt = g.reopenedAt;
    return { ok: true, goal: g };
  }, 'reopen');
}

/** Delivered is not done: the goal waits (never chased) until verifyBy, then shows as VERIFY-NOW. */
function verify(id, verifyBy, verifyWhat) {
  const by = normDue(verifyBy);
  if (!by) return { ok: false, error: 'BAD_DATE', message: 'verify_by must be a date.' };
  return withGoal(id, (g) => {
    if (FINISHED.includes(g.status)) return { ok: false, error: 'ALREADY_CLOSED', status: g.status };
    g.verifyBy = by; g.verifyWhat = verifyWhat ? clip(verifyWhat, 300) : g.verifyWhat || null;
    return { ok: true, goal: g };
  }, 'verify');
}

/**
 * Release a goal from the judgement queue: no answer to maxChases chases, delivered but not good
 * enough, or held because its PREVIOUS owner already reported it done. Say what you read and decided.
 */
function judged(id, note, opts = {}) {
  const why = oneLine(note);
  if (!why) return { ok: false, error: 'NOTE_REQUIRED' };
  return withGoal(id, (g) => {
    if (FINISHED.includes(g.status)) return { ok: false, error: 'ALREADY_CLOSED', status: g.status };
    g.judgedAt = iso(opts.now || Date.now()); g.judgedNote = clip(why, 300); g.unanswered = 0; g.deliveredAt = null;
    return { ok: true, goal: g };
  }, 'judged');
}

// ---------------------------------------------------------------- the collected ledger
// Reading a session's finished work (losslessly, without opening it) does not clear the app's unread
// dot, so the same finished session would be raised to the Conductor every cycle. Banking it here
// stops that — AT a timestamp: the moment the session writes anything after it, it is raised again.
function recordCollected(sessionId, goalId, note, now) {
  if (!sessionId) return { ok: false, error: 'SESSION_REQUIRED' };
  const row = { session: String(sessionId), goal: goalId || null, ts: iso(now || Date.now()), note: clip(note || '', 400) };
  fs.mkdirSync(DIR, { recursive: true });
  fs.appendFileSync(COLLECTED, JSON.stringify(row) + '\n');
  return { ok: true, ...row };
}
/** session id -> { ts (latest), goals, note } */
function collectedMap() {
  let text = '';
  try { text = fs.readFileSync(COLLECTED, 'utf8'); } catch { return {}; }
  const out = {};
  for (const r of parseLines(text).rows) {
    if (!r || !r.session) continue;
    const c = out[r.session] || (out[r.session] = { ts: r.ts, goals: [], note: r.note || '' });
    if (String(r.ts || '') >= String(c.ts || '')) { c.ts = r.ts; c.note = r.note || c.note; }
    if (r.goal && !c.goals.includes(r.goal)) c.goals.push(r.goal);
  }
  return out;
}
function defaultTranscriptMtime(sessionId) {
  try {
    const sessions = require('../mobile/sessions');
    const rec = sessions.get(sessionId) || ((sessions.index() || {}).list || []).find(s => s.id === sessionId);
    const f = rec && sessions.transcriptPath(rec);
    return f ? fs.statSync(f).mtimeMs : null;
  } catch { return null; }
}
/**
 * Has the session written anything after `ts`? -> { moved, known }. A transcript that cannot be found
 * or read is UNKNOWN, never "quiet": "has not moved" is the value that silences the alarm.
 */
function movedSince(sessionId, ts, deps = {}) {
  const t = ms(ts);
  if (!t) return { moved: true, known: false };
  let m = null;
  try { m = (deps.transcriptMtime || defaultTranscriptMtime)(sessionId); } catch { m = null; }
  if (m == null || !isFinite(m)) return { moved: true, known: false };
  return { moved: m > t, known: true };
}
/** 'banked' (read, and silent since) | 'moved-since' (new work: raise it) | 'cannot-verify' (treated as moved) | null (never collected). */
function collectedStatus(sessionId, deps = {}) {
  const map = deps.map || collectedMap();
  const c = map[sessionId] || Object.entries(map).find(([k]) => String(sessionId || '').startsWith(k) || k.startsWith(String(sessionId || '') || '\u0000'))?.[1];
  if (!c) return { state: null, ts: null, goals: [] };
  const mv = movedSince(sessionId, c.ts, deps);
  return { state: !mv.known ? 'cannot-verify' : mv.moved ? 'moved-since' : 'banked', ts: c.ts, goals: c.goals, note: c.note };
}

/** Give a goal a new owner, who is told in the next cycle. Refuses delivered goals and owners that are not live. */
function rehome(id, target, why, ctx = {}) {
  const reason = oneLine(why);
  if (!target) return { ok: false, error: 'TARGET_REQUIRED' };
  const state = ctx.stateOf ? ctx.stateOf(target) : 'unknown';
  if (!['idle', 'running', 'awaiting'].includes(state)) return { ok: false, error: 'TARGET_NOT_LIVE', state };
  return withGoal(id, (g) => {
    if (FINISHED.includes(g.status)) return { ok: false, error: 'ALREADY_CLOSED', status: g.status };
    if (g.deliveredAt || g.verifyBy) return { ok: false, error: 'DELIVERED', message: 'The current owner already delivered this; judge it instead of moving it.' };
    if (g.ownerSessionId === target) return { ok: true, goal: g, unchanged: true };
    g.rehomedFrom = g.ownerSessionId || null; g.ownerSessionId = target; g.rehomeWhy = clip(reason || 'reassigned', 200);
    g.rehomedAt = iso(ctx.now || Date.now()); g.told = false; g.toldAt = null; g.unanswered = 0;
    g.routing = { ...(g.routing || {}), state: 'rehomed', why: g.rehomeWhy };
    g.oldOwnerDone = null;
    return { ok: true, goal: g };
  }, 'rehome');
}

function list(opts = {}) {
  const gs = load().goals;
  return opts.all ? gs : gs.filter(g => g.status === 'open');
}
function show(id) {
  const g = find(load(), id);
  if (!g) return { ok: false, error: 'NO_SUCH_GOAL', id };
  let health = null;
  try { health = (JSON.parse(fs.readFileSync(HEALTH, 'utf8')).items || []).find(i => i.id === g.id) || null; } catch {}
  const events = readJsonl(EVENTS, 0).filter(e => e.id === g.id).slice(-20);
  const chases = readJsonl(CHASE_LOG, 0).filter(e => (e.goals || []).includes(g.id)).slice(-10);
  const collected = g.ownerSessionId ? collectedStatus(g.ownerSessionId) : null;
  return { ok: true, goal: g, health, events, chases, history: history(g.id), collected };
}

// ---------------------------------------------------------------- notes for the user (baton_tell_user)
// Kept as thin wrappers: the notes are inbox items now (lib/inbox.js), numbered and folded there.
const inbox = () => require('./inbox');
function tell({ sessionId, text, kind } = {}, deps = {}) {
  const t = String(text || '').trim();
  if (!t) return { ok: false, error: 'TEXT_REQUIRED' };
  const k = ['decide', 'do', 'fyi'].includes(kind) ? kind : null;
  const r = inbox().add(t, { session: sessionId || null, source: 'tell', ask_kind: k || undefined, now: deps.now });
  if (!r.ok) return r;
  if (k && t.length <= inbox().settings().askMaxChars) inbox().ask(r.n, k, t, { now: deps.now });
  return { ok: true, note: { n: r.n, text: t, session: sessionId || null, kind: k, ts: r.item.ts, status: 'open' }, warnings: r.warnings };
}
function closeNote(n, status = 'done') {
  const it = inbox().get(n);
  if (!it || it.status !== 'open') return { ok: !!it, already: it ? it.status : null };
  return inbox().setStatus(it.n, status === 'dropped' ? 'drop' : 'done', '');
}
function notes(opts = {}) {
  return inbox().all().filter(r => r.kind !== 'log' && (opts.all || r.status === 'open'))
    .sort((a, b) => a.n - b.n).map(r => ({ ...r, kind: r.ask_kind || null }));
}

// ---------------------------------------------------------------- reading files and sessions
function tailText(file, bytes) {
  const st = fs.statSync(file);
  const start = Math.max(0, st.size - bytes);
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(st.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } finally { fs.closeSync(fd); }
}
function readJsonl(file, sinceMs) {
  let text = '';
  try { text = tailText(file, 1024 * 1024); } catch { return []; }
  const out = [];
  for (const l of text.split('\n')) {
    if (!l) continue;
    let r; try { r = JSON.parse(l); } catch { continue; }
    if (!sinceMs || ms(r.at || r.ts) >= sinceMs) out.push(r);
  }
  return out;
}

/**
 * { lastApiAt, replies:[{ts,text}] } from a session's transcript tail. lastApiAt is the last real model
 * response, not the file mtime, which also moves on a rename or a queued message.
 */
function readActivity(sess, sinceMs) {
  const out = { lastApiAt: null, replies: [] };
  let file = null;
  try { file = require('../mobile/sessions').transcriptPath(sess); } catch {}
  if (!file) return out;
  let text;
  try { text = tailText(file, 1536 * 1024); } catch { return out; }
  for (const line of text.split('\n')) {
    if (!line || line.indexOf('"assistant"') < 0) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (r.type !== 'assistant' || r.isSidechain) continue;
    const ts = ms(r.timestamp);
    const m = r.message || {};
    if (m.model && m.model !== '<synthetic>' && ts > (out.lastApiAt || 0)) out.lastApiAt = ts;
    if (ts <= sinceMs || !Array.isArray(m.content)) continue;
    const t = m.content.filter(b => b && b.type === 'text').map(b => b.text).join('\n');
    if (t) out.replies.push({ ts, text: t });
  }
  return out;
}

const MARK_RE = /^[ \t>*_`-]*GOAL[ _-]?(DONE|BLOCKED|PROGRESS)[ \t:]+(g\d+)\b[ \t:.—-]*(.*)$/gim;
/** "GOAL DONE g3: …" / "GOAL BLOCKED g3: …" / "GOAL PROGRESS g3: …" lines in a session's replies. */
function markers(replies) {
  const out = [];
  for (const r of replies || []) {
    MARK_RE.lastIndex = 0;
    let m;
    while ((m = MARK_RE.exec(r.text))) out.push({ kind: m[1].toUpperCase(), id: m[2].toLowerCase(), note: clip(m[3], 300), ts: r.ts });
  }
  return out.sort((a, b) => a.ts - b.ts);
}
function applyMarkers(reg, ownerId, marks, now, opts = {}) {
  const requireVerification = opts.requireVerification !== false;
  const changed = [];
  for (const k of marks) {
    const g = find(reg, k.id);
    if (!g || g.status !== 'open') continue;
    if (g.ownerSessionId !== ownerId) {
      // A DONE from the PREVIOUS owner of a re-homed goal: the work may already be in. Chasing the new
      // owner for it pays twice, so the goal is held until someone reads that report and judges it.
      if (k.kind === 'DONE' && g.rehomedFrom === ownerId && k.ts >= ms(g.createdAt)
          && (!g.oldOwnerDone || ms(g.oldOwnerDone.ts) < k.ts)) {
        g.oldOwnerDone = { session: ownerId, note: k.note || '(no evidence given)', ts: iso(k.ts) };
        g._ev = 'old-owner-delivered';
        changed.push({ id: g.id, kind: 'OLD-OWNER-DONE' });
      }
      continue;
    }
    if (k.ts <= ms(g.scannedAt) || k.ts < ms(g.createdAt)) continue;
    g.scannedAt = iso(k.ts);
    g.unanswered = 0; g.lastProgressAt = iso(k.ts);
    g._ev = 'marker';
    if (k.kind === 'DONE') {
      if (k.note && !g.verifyBy && !requireVerification) { g.status = 'done'; g.closedAt = iso(now); g.outcome = k.note; g.closedBy = 'marker'; }
      else { g.deliveredAt = iso(k.ts); g.progress = 'DONE: ' + (k.note || '(no evidence given)'); g.blockedOn = null; }
    } else if (k.kind === 'BLOCKED') g.blockedOn = k.note || 'blocked';
    else { g.progress = k.note || g.progress; g.blockedOn = null; }
    changed.push({ id: g.id, kind: k.kind });
  }
  return changed;
}

// ---------------------------------------------------------------- owner state and condition
/**
 * running | awaiting | idle | offline | archived | gone | none | unknown. "unknown" means we could not see
 * the app's view; it is never treated as idle, and nothing is sent on it.
 */
function ownerState(sid, sessions, fresh) {
  if (!sid) return 'none';
  const s = sessions.get(sid);
  if (!s) return 'gone';
  if (s.archived) return 'archived';
  if (!fresh) return 'unknown';
  if (s.live === false) return 'offline';
  if (s.running) return 'running';
  if (s.awaiting) return 'awaiting';
  return 'idle';
}

const reportClock = (g) => ms(g.lastProgressAt) || ms(g.toldAt) || ms(g.createdAt);
const quietHours = (g, now) => (now - reportClock(g)) / H;
const isLate = (g, now) => !!g.due && ms(g.due) < now;

/** One condition per open goal, in the order that matters: nothing else about a goal moves until someone holds it. */
function classify(g, state, now, cfg) {
  const q = quietHours(g, now);
  if (g.verifyBy) return ms(g.verifyBy) <= now ? 'VERIFY-NOW' : 'AWAITING-VERIFICATION';
  if (g.deliveredAt) return 'DELIVERED';
  if (state === 'unknown' || state === 'offline') return 'OFFLINE';
  if (!['running', 'idle', 'awaiting'].includes(state)) return 'ORPHAN';
  if (!g.told) return 'UNTOLD';
  if ((g.unanswered || 0) >= cfg.maxChases && q >= cfg.quietHours) return 'UNRESPONSIVE';
  if (g.blockedOn) return q >= cfg.blockedStaleDays * 24 ? 'BLOCKED-STALE' : 'BLOCKED';
  if (isLate(g, now)) return 'LATE';
  if (!g.lastProgressAt && g.toldAt && q < cfg.quietHours) return 'HANDED-OVER';
  if (g.due && q >= cfg.quietHours) return 'WATCH';
  if (q >= cfg.quietHours) return 'STUCK';
  return 'FRESH';
}

/** The previous owner's DONE, still waiting for someone to read it (judged after it clears it). */
const oldOwnerHold = (g) => !!(g.oldOwnerDone && (!g.judgedAt || ms(g.judgedAt) < ms(g.oldOwnerDone.ts)));

/** Classify every open goal. Pure apart from reading the collected ledger for delivered owners. */
function assess({ goals, sessions, fresh = true, now, st, collected }) {
  const items = [];
  for (const g of goals) {
    if (g.status !== 'open') continue;
    const state = ownerState(g.ownerSessionId, sessions, fresh);
    const condition = classify(g, state, now, st.goals);
    const it = { id: g.id, title: g.title, owner: g.ownerSessionId || null, ownerState: state, condition,
      quietH: +quietHours(g, now).toFixed(1), chases: g.chases || 0, unanswered: g.unanswered || 0, due: g.due || null,
      blockedOn: g.blockedOn || null, verifyBy: g.verifyBy || null, verifyWhat: g.verifyWhat || null,
      progress: g.progress || null, project: g.project || null, routing: g.routing || null,
      lastChaseAt: g.lastChaseAt || null, lastProgressAt: g.lastProgressAt || null };
    if (oldOwnerHold(g)) it.oldOwnerDone = g.oldOwnerDone;
    if (condition === 'DELIVERED' && g.ownerSessionId && collected) {
      const c = collected(g.ownerSessionId);
      if (c && c.state === 'banked') it.collected = { state: c.state, ts: c.ts, goals: c.goals };
    }
    items.push(it);
  }
  items.sort((a, b) => ORDER.indexOf(a.condition) - ORDER.indexOf(b.condition) || b.quietH - a.quietH);
  return items;
}

/**
 * Write goals-health.json and goals-events.jsonl: one line per change — a condition change (with the
 * time spent in the old condition), a goal first seen, a close, a new report, a re-home, a chase —
 * so the Board can say what CHANGED in the last 24 hours, never just "N open".
 */
function recordHealth(items, now, extra = {}, goalsById = null) {
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(STATE, 'utf8')) || {}; } catch {}
  const seeded = !Object.keys(prev).length && !fs.existsSync(STATE);
  const next = {}, events = [];
  const at = iso(now);
  for (const it of items) {
    const p = prev[it.id];
    const g = goalsById ? goalsById.get(it.id) : null;
    const cur = { condition: it.condition, since: at, owner: it.owner || null, lastProgressAt: it.lastProgressAt || null, chases: it.chases || 0 };
    if (p && p.condition === it.condition) cur.since = p.since;
    next[it.id] = cur;
    it.since = cur.since;
    if (!p) { if (!seeded) events.push({ at, kind: 'opened', id: it.id, what: clip(it.title, 120), to: it.condition }); continue; }
    if (p.condition !== it.condition) events.push({ at, kind: 'condition', id: it.id, from: p.condition, to: it.condition, forMs: now - ms(p.since) });
    if (p.owner !== undefined && (p.owner || null) !== (it.owner || null)) events.push({ at, kind: 'rehomed', id: it.id, what: `${p.owner || 'nobody'} -> ${it.owner || 'nobody'}` });
    if (p.lastProgressAt !== undefined && it.lastProgressAt && it.lastProgressAt !== p.lastProgressAt) events.push({ at, kind: 'progressed', id: it.id, what: clip(it.blockedOn ? 'BLOCKED: ' + it.blockedOn : it.progress || '', 160) });
    if (p.chases !== undefined && (it.chases || 0) > (p.chases || 0)) events.push({ at, kind: 'chased', id: it.id, what: `chase ${it.chases} -> ${it.owner || '?'}` });
  }
  for (const [id, p] of Object.entries(prev)) {
    if (next[id]) continue;
    const g = goalsById ? goalsById.get(id) : null;
    events.push({ at, kind: 'closed', id, from: p.condition, to: 'CLOSED', forMs: now - ms(p.since),
      what: g ? clip(`${g.status}: ${g.outcome || ''}`, 160) : undefined });
  }
  if (seeded && items.length) events.push({ at, kind: 'seeded', id: '-', what: `first health run: ${items.length} open` });
  const counts = {};
  for (const it of items) counts[it.condition] = (counts[it.condition] || 0) + 1;
  let events24 = [];
  try {
    fs.mkdirSync(DIR, { recursive: true });
    if (events.length) fs.appendFileSync(EVENTS, events.map(e => JSON.stringify(e)).join('\n') + '\n');
    events24 = readJsonl(EVENTS, now - 24 * H).slice(-200);
    writeAtomic(STATE, JSON.stringify(next));
    writeAtomic(HEALTH, JSON.stringify({ at, counts, items, events24, ...extra }, null, 1));
  } catch {}
  return { counts, events, events24 };
}

// ---------------------------------------------------------------- deciding who to message
/**
 * Pure: which owners get a message this cycle, and why everything else waits.
 * ctx: { now, st, goals, items (from assess), sessions, warmth: Map id -> minutes since last API reply }
 */
function plan(ctx) {
  const { now, st } = ctx;
  const c = st.cache, gc = st.goals;
  const held = [], batches = [];
  const cond = new Map(ctx.items.map(i => [i.id, i]));
  const byOwner = new Map();
  for (const g of ctx.goals) {
    if (g.status !== 'open' || !g.ownerSessionId || !cond.has(g.id)) continue;
    if (!byOwner.has(g.ownerSessionId)) byOwner.set(g.ownerSessionId, []);
    byOwner.get(g.ownerSessionId).push(g);
  }
  const chasedWithin = (g, hours) => g.lastChaseAt && now - ms(g.lastChaseAt) < hours * H;
  for (const [sid, gs] of byOwner) {
    const state = cond.get(gs[0].id).ownerState;
    const hold = (why, list = gs) => list.forEach(g => held.push({ id: g.id, owner: sid, why }));
    if (st.conductor && sid === st.conductor) { hold('owned by the Conductor, which is never chased'); continue; }
    if (state !== 'idle') { hold(state === 'running' ? 'owner is mid-turn' : state === 'awaiting' ? 'owner is waiting on you' : 'owner is ' + state); continue; }
    const s = ctx.sessions.get(sid);
    const idleMin = s.lastActivityAt ? (now - s.lastActivityAt) / M : null;
    const api = ctx.warmth.get(sid);
    const apiAgeMin = api != null ? api : idleMin;
    const warmth = { warm: apiAgeMin != null && apiAgeMin < c.windowMinutes,
      apiAgeMin: apiAgeMin == null ? null : Math.round(apiAgeMin), idleMin: idleMin == null ? null : Math.round(idleMin) };

    const fresh = st.chaser ? gs.filter(g => cond.get(g.id).condition === 'UNTOLD') : [];
    // Held, never chased: the previous owner already reported this done. Read that first.
    const oldDone = gs.filter(g => PENDING_WORK.includes(cond.get(g.id).condition) && oldOwnerHold(g));
    for (const g of oldDone) held.push({ id: g.id, owner: sid, why: `previous owner ${String(g.oldOwnerDone.session).slice(0, 14)} already reported it done: read that, then close it or judge it (baton_goal_judged)` });
    const pending = gs.filter(g => PENDING_WORK.includes(cond.get(g.id).condition) && !oldDone.includes(g));
    for (const g of gs) {
      const k = cond.get(g.id).condition;
      if (k !== 'UNTOLD' && !PENDING_WORK.includes(k)) held.push({ id: g.id, owner: sid, why: k.toLowerCase() });
    }
    const minQuiet = gc.warmPingMinQuietHours != null ? gc.warmPingMinQuietHours : 4;
    let chase = [], kind = null;
    if (st.keeper && warmth.warm) {
      kind = 'warm';
      if (apiAgeMin < c.pingFromMinutes) hold(`warm, stopped ${warmth.apiAgeMin}m ago; pinged at ${c.pingFromMinutes}-${c.pingUntilMinutes}m`, pending);
      else if (apiAgeMin > c.pingUntilMinutes) hold('warm but too close to expiry to be worth it', pending);
      else for (const g of pending) {
        if (quietHours(g, now) < minQuiet && !isLate(g, now)) held.push({ id: g.id, owner: sid, why: `quiet only ${quietHours(g, now).toFixed(1)}h; nothing to ask yet` });
        else if (chasedWithin(g, gc.warmRechaseHours)) held.push({ id: g.id, owner: sid, why: `pinged within ${gc.warmRechaseHours}h` });
        else chase.push(g);
      }
    } else if (st.keeper) {
      kind = 'cold';
      const important = pending.filter(g => {
        const k = cond.get(g.id).condition;
        return (k === 'LATE' || (k === 'STUCK' && quietHours(g, now) >= c.coldAfterHours)) && !chasedWithin(g, gc.rechaseHours);
      });
      if (important.length) {
        chase = important.concat(pending.filter(g => !important.includes(g) && quietHours(g, now) >= minQuiet && !chasedWithin(g, gc.warmRechaseHours)));
      } else hold(`cold; waits for its warm window, a due date, or ${c.coldAfterHours}h quiet`, pending);
    } else if (st.chaser) {
      kind = 'stuck';
      for (const g of pending) {
        if (!CHASEABLE.includes(cond.get(g.id).condition)) held.push({ id: g.id, owner: sid, why: cond.get(g.id).condition.toLowerCase() + '; not chased yet' });
        else if (chasedWithin(g, gc.rechaseHours)) held.push({ id: g.id, owner: sid, why: `chased within ${gc.rechaseHours}h` });
        else chase.push(g);
      }
    }
    if (!fresh.length && !chase.length) continue;
    batches.push({ sessionId: sid, title: s.title || '', kind: chase.length ? kind : 'handover', fresh, chase, warmth,
      quietMax: Math.max(0, ...chase.map(g => quietHours(g, now))) });
  }
  // Warm owners closest to going cold first, then new work, then the longest-quiet cold owners.
  const rank = (b) => b.kind === 'warm' ? 0 : b.kind === 'handover' ? 1 : 2;
  batches.sort((a, b) => rank(a) - rank(b) || (rank(a) === 0 ? b.warmth.apiAgeMin - a.warmth.apiAgeMin : b.quietMax - a.quietMax));
  const cap = Math.max(0, Number(gc.maxChasesPerCycle) || 0);
  for (const b of batches.slice(cap)) for (const g of [...b.fresh, ...b.chase]) held.push({ id: g.id, owner: b.sessionId, why: 'over this cycle\'s cap' });
  return { batches: batches.slice(0, cap), held };
}

function keepalivePlan(ctx, recentKeepalives) {
  const { now, st } = ctx;
  const cid = st.conductor;
  if (!st.keeper || !st.cache.keepConductorWarm || !cid) return null;
  if (ownerState(cid, ctx.sessions, ctx.fresh !== false) !== 'idle') return null;
  const cs = ctx.sessions.get(cid);
  const w = ctx.warmth.get(cid);
  const age = w != null ? w : (cs.lastActivityAt ? (now - cs.lastActivityAt) / M : null);
  if (age == null || age < st.cache.pingFromMinutes || age > st.cache.pingUntilMinutes) return null;
  const busy = [...new Set(ctx.items.filter(i => i.ownerState === 'running' && i.owner && i.owner !== cid).map(i => i.owner))];
  if (!busy.length || recentKeepalives >= KEEPALIVE_PER_3H) return null;
  return { sessionId: cid, kind: 'keepalive', busy, warmth: { apiAgeMin: Math.round(age), warm: true },
    leftMin: Math.max(0, Math.round(st.cache.windowMinutes - age)) };
}

/** Pure: orphans whose project has exactly ONE live master get re-homed to it; a tie is refused. */
function rehomePlan({ items, goals, masters, sessions, fresh }) {
  const out = [], refused = [];
  for (const it of items) {
    if (it.condition !== 'ORPHAN') continue;
    const g = goals.find(x => x.id === it.id);
    const proj = String(g.project || '').toLowerCase();
    if (!proj) { refused.push({ id: g.id, why: 'no project to find a master for' }); continue; }
    const cands = (masters || []).filter(m => {
      const k = String(m.project || '').toLowerCase();
      return (k === proj || path.basename(k) === proj) && ['idle', 'running', 'awaiting'].includes(ownerState(m.sessionId, sessions, fresh));
    });
    const ids = [...new Set(cands.map(m => m.sessionId))];
    if (ids.length === 1) out.push({ id: g.id, target: ids[0], why: `the previous owner is ${it.ownerState}; ${ids[0]} is the live master of ${g.project}` });
    else refused.push({ id: g.id, why: ids.length ? `${ids.length} live masters claim ${g.project}; not guessing` : `no live master for ${g.project}` });
  }
  return { out, refused };
}

// ---------------------------------------------------------------- messages
function goalLine(g, now, extra) {
  const bits = [];
  if (g.due) bits.push('due ' + g.due.slice(0, 10) + (isLate(g, now) ? ' (late)' : ''));
  if (extra) bits.push(extra);
  return `• ${g.id} — ${clip(g.title, 140)}` + (bits.length ? ` (${bits.join('; ')})` : '');
}
function detailLines(g) {
  const L = [];
  if (g.text && oneLine(g.text) !== oneLine(g.title)) L.push('  ' + clip(g.text, 600));
  if (g.checks && g.checks.length) L.push('  Done means: ' + clip(g.checks.join('; '), 400));
  return L;
}
function message(b, now) {
  const n = b.fresh.length + b.chase.length;
  const L = [`[Relaymote goals] ${n} goal${n === 1 ? '' : 's'} for this session, in one message so you are woken once.`];
  const moved = b.fresh.filter(g => g.rehomedFrom !== undefined && g.rehomedAt);
  const fresh = b.fresh.filter(g => !moved.includes(g));
  if (fresh.length) {
    L.push('', 'New:');
    for (const g of fresh) L.push(goalLine(g, now), ...detailLines(g));
  }
  if (moved.length) {
    L.push('', 'Re-homed to you:');
    for (const g of moved) L.push(goalLine(g, now, 'why you: ' + (g.rehomeWhy || 'reassigned')), ...detailLines(g));
  }
  if (b.chase.length) {
    L.push('', 'Still open, with no report yet:');
    for (const g of b.chase) {
      const q = quietHours(g, now);
      L.push(goalLine(g, now, `no report for ${q < 1 ? Math.round(q * 60) + 'm' : Math.round(q) + 'h'}` + (g.chases ? `, reminder ${g.chases + 1}` : '')));
    }
  }
  L.push('', 'Carry on with these. Report each one on its own line, starting the line with:',
    '  GOAL DONE <id>: <evidence>',
    '  GOAL BLOCKED <id>: <exactly what you need>',
    '  GOAL PROGRESS <id>: <what is left>',
    'A reply without one of these lines does not count as a report. The baton_goal_progress and baton_goal_done tools work too.');
  return L.join('\n');
}
function keepaliveMessage(k) {
  return `[Relaymote cache keep-alive] Your prompt cache expires in about ${k.leftMin} min and ${k.busy.length} session${k.busy.length === 1 ? '' : 's'} `
    + 'working on open goals will report to you soon. Reply with the single word ok and do nothing else.';
}

// ---------------------------------------------------------------- log + counts
function logSend(rec) {
  try { fs.mkdirSync(DIR, { recursive: true }); fs.appendFileSync(CHASE_LOG, JSON.stringify(rec) + '\n'); } catch {}
}
function status(opts = {}) {
  const now = opts.now || Date.now();
  const reg = load();
  const counts = { open: 0, unrouted: 0, blocked: 0, late: 0, delivered: 0, done: 0, failed: 0, dropped: 0 };
  for (const g of reg.goals) {
    counts[g.status] = (counts[g.status] || 0) + 1;
    if (g.status !== 'open') continue;
    if (!g.ownerSessionId) counts.unrouted++;
    if (g.blockedOn) counts.blocked++;
    if (g.deliveredAt && !g.verifyBy) counts.delivered++;
    if (isLate(g, now)) counts.late++;
  }
  const day = readJsonl(CHASE_LOG, now - 24 * H);
  const pings = { warm: 0, cold: 0, stuck: 0, handover: 0, keepalive: 0, spawn: 0, failed: 0, dryRun: 0 };
  for (const r of day) {
    if (r.dryRun) { pings.dryRun++; continue; }
    if (!r.ok) { pings.failed++; continue; }
    pings[r.kind] = (pings[r.kind] || 0) + 1;
  }
  let health = null;
  try { health = JSON.parse(fs.readFileSync(HEALTH, 'utf8')); } catch {}
  return { counts, conditions: health ? health.counts : {}, healthAt: health ? health.at : null,
    corruptRows: reg.corrupt, repairedEscapes: reg.repaired, unreadable: !!reg.unreadable,
    last24h: pings, recent: day.slice(-10).reverse() };
}

// ---------------------------------------------------------------- the cycle
async function defaultSessions(now) {
  const sessions = require('../mobile/sessions');
  const desktop = require('./desktop');
  await sessions.refresh();
  const snap = desktop.loadSnapshot();
  const fresh = !!(snap && snap.at && now - ms(snap.at) <= SNAPSHOT_MAX_AGE_MS);
  const list = sessions.decorate(sessions.index().list, snap).map(s => ({
    id: s.id, title: s.title, cwd: s.cwd, archived: s.archived, running: s.running, awaiting: s.awaiting, live: s.live,
    lastActivityAt: s.lastActivityAt, _rec: s,
  }));
  return { list, fresh };
}

/** The app's own answer for one session: { state, confirmed }. Anything short of a clear answer is unknown. */
async function defaultConfirm(sessionId) {
  try {
    const st = await require('./bridge').listStates([sessionId]);
    const s = st && st[sessionId];
    if (!s) return { state: 'gone', confirmed: true };
    if (s.isArchived) return { state: 'archived', confirmed: true };
    if (s.isRunning) return { state: 'running', confirmed: true };
    return { state: 'idle', confirmed: true };
  } catch (e) { return { state: 'unknown', confirmed: false, reason: e.message }; }
}
async function defaultDeliver(sessionId, text) {
  return require('./bridge').sendMessage(sessionId, text, { origin: { kind: 'peer', sessionId: 'baton-goals' }, initiator: 'baton-goals' });
}
function defaultMasters() { try { return require('./notify').activeMasters(); } catch { return []; } }

function spawnPrompt(g) {
  return `Goal ${g.id} from the Relaymote goal register: ${g.title}\n\n${g.text && oneLine(g.text) !== oneLine(g.title) ? g.text + '\n\n' : ''}`
    + (g.checks && g.checks.length ? 'Done means: ' + g.checks.join('; ') + '\n\n' : '')
    + `When it is finished, write a line starting "GOAL DONE ${g.id}: <evidence>". If you are blocked, "GOAL BLOCKED ${g.id}: <what you need>".`;
}

/**
 * One cycle. deps (all optional, for tests): now, settings (override), sessions (list), fresh, activity(sess, sinceMs),
 * confirm(id), deliver(id, text), resolve(topic, opts), index, masters, spawn({cwd, prompt}), isIdle(), dryRun.
 */
async function tick(deps = {}) {
  const now = deps.now || Date.now();
  const st = settings(deps.settings || {});
  const res = { at: iso(now), chaser: st.chaser, keeper: st.keeper, done: [], routed: [], rehomed: [], spawned: [], sent: [], failed: [], held: [], skipped: null };
  if (!st.chaser && !st.keeper) { res.skipped = 'modules off'; return res; }
  if (load().unreadable) { res.skipped = 'the old goals.json could not be read; it was left untouched and nothing was migrated'; return res; }
  const dryRun = deps.dryRun !== undefined ? !!deps.dryRun : !!st.goals.dryRun;

  let list, fresh = deps.fresh !== undefined ? !!deps.fresh : true;
  if (deps.sessions) list = deps.sessions;
  else ({ list, fresh } = await defaultSessions(now));
  const sessions = new Map(list.map(s => [s.id, s]));

  // 1. What owners said (done / blocked / progress lines) and when their cache was last written.
  const activity = deps.activity || ((s, since) => readActivity(s._rec || s, since));
  const warmth = new Map();
  const reg0 = load();
  const open0 = reg0.goals.filter(g => g.status === 'open');
  const owners = new Set(open0.filter(g => g.ownerSessionId).map(g => g.ownerSessionId));
  if (st.conductor) owners.add(st.conductor);
  // Previous owners of re-homed goals are read too: a DONE from one of them holds the goal (never the Conductor,
  // which authors and re-homes goals, and never the current owner, which would hold a lane against itself).
  for (const g of open0) if (g.rehomedFrom && g.rehomedFrom !== g.ownerSessionId && g.rehomedFrom !== st.conductor) owners.add(g.rehomedFrom);
  const marksBy = new Map();
  for (const sid of owners) {
    const s = sessions.get(sid);
    if (!s) continue;
    const mine = open0.filter(g => g.ownerSessionId === sid);
    const before = open0.filter(g => g.rehomedFrom === sid && g.ownerSessionId !== sid);
    const since = Math.min(...mine.map(g => ms(g.scannedAt) || ms(g.createdAt)), ...before.map(g => ms(g.createdAt)), now);
    let a = { lastApiAt: null, replies: [] };
    try { a = (await activity(s, since)) || a; } catch {}
    if (a.lastApiAt) warmth.set(sid, (now - a.lastApiAt) / M);
    if (mine.length || before.length) marksBy.set(sid, markers(a.replies));
  }
  const rv = st.goals.requireVerification !== false;
  if (marksBy.size) mutate(reg => { for (const [sid, marks] of marksBy) res.done.push(...applyMarkers(reg, sid, marks, now, { requireVerification: rv })); }, 'marker');

  // 2. Route goals nobody owns; re-home orphans to an unambiguous master; start a session when allowed.
  if (st.chaser) {
    const spawnable = mutate(reg => {
      let pick = null;
      for (const g of reg.goals) {
        if (g.status !== 'open' || g.ownerSessionId) continue;
        route(g, deps);
        if (g.ownerSessionId) { res.routed.push(g.id); continue; }
        const r = g.routing || {};
        if (!pick && st.goals.autoSpawn && g.project && (r.spawnAttempts || 0) < 3 && (!r.lastSpawnAt || now - ms(r.lastSpawnAt) > H)) pick = g.id;
      }
      return pick;
    }, 'route');
    if (st.goals.autoRehome) {
      const items = assess({ goals: load().goals, sessions, fresh, now, st });
      const rp = rehomePlan({ items, goals: load().goals, masters: deps.masters || defaultMasters(), sessions, fresh });
      for (const r of rp.out) {
        const out = rehome(r.id, r.target, r.why, { now, stateOf: (id) => ownerState(id, sessions, fresh) });
        if (out.ok) res.rehomed.push({ id: r.id, to: r.target });
        else res.held.push({ id: r.id, why: 're-home refused: ' + out.error });
      }
      for (const r of rp.refused) res.held.push({ id: r.id, why: 'not re-homed: ' + r.why });
    }
    if (spawnable && deps.spawn && (!deps.isIdle || deps.isIdle())) {
      const g = find(load(), spawnable);
      let ix = deps.index;
      if (ix === undefined) { try { ix = require('./projects').read(); } catch { ix = null; } }
      const p = ix && ix.projects && ix.projects[g.project];
      if (p && p.path) {
        let out;
        try { out = dryRun ? { ok: false, error: 'DRY_RUN' } : await deps.spawn({ cwd: p.path, prompt: spawnPrompt(g) }); }
        catch (e) { out = { ok: false, error: e.message }; }
        mutate(reg => {
          const x = find(reg, g.id);
          if (!x) return;
          x.routing = { ...(x.routing || {}), lastSpawnAt: iso(now), spawnAttempts: ((x.routing || {}).spawnAttempts || 0) + 1 };
          if (out && out.ok && out.sessionId) {
            x.ownerSessionId = out.sessionId; x.told = true; x.toldAt = iso(now);
            x.routing = { ...x.routing, state: 'spawned', why: 'new session in ' + p.path };
          } else x.routing.lastError = clip((out && (out.error || out.message)) || 'spawn failed', 160);
        }, 'spawn');
        logSend({ at: iso(now), kind: 'spawn', to: (out && out.sessionId) || null, goals: [g.id], ok: !!(out && out.ok), error: (out && out.error) || null, dryRun: dryRun || undefined });
        if (out && out.ok) res.spawned.push({ id: g.id, sessionId: out.sessionId });
      }
    }
  }

  // 3. Classify, record health + events, and message owners.
  const reg = load();
  const collected = (sid) => collectedStatus(sid, deps.transcriptMtime ? { transcriptMtime: deps.transcriptMtime } : {});
  const items = assess({ goals: reg.goals, sessions, fresh, now, st, collected });
  res.health = recordHealth(items, now, { corruptRows: reg.corrupt, repairedEscapes: reg.repaired,
    thresholds: { quietHours: st.goals.quietHours, warmPingMinQuietHours: st.goals.warmPingMinQuietHours, rechaseHours: st.goals.rechaseHours,
      maxChasesPerCycle: st.goals.maxChasesPerCycle, blockedStaleDays: st.goals.blockedStaleDays } },
    new Map(reg.goals.map(g => [g.id, g]))).counts;
  if (!fresh) { res.skipped = 'desktop snapshot is stale; cannot tell who is mid-turn'; return res; }
  const ctx = { now, st, goals: reg.goals, items, sessions, warmth, fresh };
  const p = plan(ctx);
  res.held.push(...p.held);
  const confirm = deps.confirm || defaultConfirm;
  const deliver = deps.deliver || defaultDeliver;
  const send = async (sid, text) => {
    if (dryRun) return { ok: false, dryRun: true, error: 'DRY_RUN' };
    let c;
    try { c = await confirm(sid); } catch (e) { c = { state: 'unknown', confirmed: false, reason: e.message }; }
    if (!c || !c.confirmed || c.state !== 'idle') return { ok: false, error: 'NOT_CONFIRMED_IDLE', state: c ? c.state : 'unknown', confirmed: !!(c && c.confirmed) };
    try { return { ...(await deliver(sid, text)), confirmed: true }; } catch (e) { return { ok: false, error: e.message, confirmed: true }; }
  };
  for (const b of p.batches) {
    const text = message(b, now);
    const ids = [...b.fresh, ...b.chase].map(g => g.id);
    const out = await send(b.sessionId, text);
    logSend({ at: iso(now), kind: b.kind, to: b.sessionId, goals: ids, warm: b.warmth.warm, apiAgeMin: b.warmth.apiAgeMin,
      idleMin: b.warmth.idleMin, confirmed: !!out.confirmed, ok: !!out.ok, error: out.ok ? null : (out.error || out.reason || 'send failed'),
      state: out.state, dryRun: dryRun || undefined });
    const rec = { sessionId: b.sessionId, kind: b.kind, goals: ids, warmth: b.warmth, text };
    if (!out.ok) { res.failed.push({ ...rec, error: out.error || 'send failed', state: out.state }); continue; }
    res.sent.push(rec);
    mutate(r => {
      for (const g of b.fresh) { const x = find(r, g.id); if (x) { x.told = true; x.toldAt = iso(now); } }
      for (const g of b.chase) {
        const x = find(r, g.id);
        if (x) { x.lastChaseAt = iso(now); x.chases = (x.chases || 0) + 1; x.unanswered = (x.unanswered || 0) + 1; }
      }
    }, b.chase.length ? 'chased' : 'told');
  }

  // 4. Optionally keep the Conductor's cache warm while goal owners are working.
  const recentKa = readJsonl(CHASE_LOG, now - 3 * H).filter(r => r.kind === 'keepalive' && r.ok).length;
  const k = keepalivePlan(ctx, recentKa);
  if (k) {
    const out = await send(k.sessionId, keepaliveMessage(k));
    logSend({ at: iso(now), kind: 'keepalive', to: k.sessionId, goals: [], warm: true, apiAgeMin: k.warmth.apiAgeMin,
      busy: k.busy.length, confirmed: !!out.confirmed, ok: !!out.ok, error: out.ok ? null : (out.error || null), dryRun: dryRun || undefined });
    if (out.ok) res.sent.push({ sessionId: k.sessionId, kind: 'keepalive', goals: [], warmth: k.warmth });
  }
  return res;
}

// ---------------------------------------------------------------- command line (`baton goal …`)
const USAGE = `baton goal [list] [--all]                  open goals (--all: closed too)
baton goal show <id>                        one goal, with its ledger history, health and chases
baton goal add "<title>" [--owner <id>] [--project <p>] [--due <date>] [--check "…"]…
baton goal progress <id> "<report>"         DONE: … delivers it; BLOCKED on … ; anything else is progress
baton goal done|fail <id> "<evidence>"      close it (evidence required)
baton goal reopen <id> "<why>"
baton goal verify <id> <YYYY-MM-DD> "<what would prove it worked>"
baton goal judged <id> "<what you read and decided>"
baton goal collected [<session> ["<why>"]]  the collected ledger: list it, or bank a session's work by hand
baton goal health                           conditions, and what changed in the last 24 h
Use - as the text to read it from stdin.`;
function cli(argv, io = {}) {
  const stdin = io.stdin || (() => { try { return fs.readFileSync(0, 'utf8'); } catch { return ''; } });
  const a = (argv || []).slice();
  const sub = (a[0] || 'list').toLowerCase();
  const text = (from) => { const r = a.slice(from); return r.length === 1 && r[0] === '-' ? String(stdin() || '') : r.join(' '); };
  const out = (r, ok) => r && r.ok ? { code: 0, text: ok(r) } : { code: 1, text: 'goal: ' + ((r && (r.message || r.error)) || 'failed') + (r && r.status ? ` (${r.status})` : '') };
  switch (sub) {
    case 'help': case '--help': case '-h': return { code: 0, text: USAGE };
    case 'list': case 'ls': case '--all': {
      const gs = list({ all: a.includes('--all') });
      if (!gs.length) return { code: 0, text: 'no goals' };
      return { code: 0, text: gs.map(g => `[${FINISHED.includes(g.status) ? 'x' : g.deliveredAt ? 'D' : ' '}] ${g.id.padEnd(5)} ${g.status.padEnd(7)} ${clip(g.title, 90)}`
        + (g.ownerSessionId ? `  (${g.ownerSessionId.slice(0, 14)})` : '  (unrouted)')).join('\n') };
    }
    case 'show': { const r = show(a[1]); return r.ok ? { code: 0, text: JSON.stringify(r, null, 2) } : { code: 1, text: 'goal: no such goal ' + a[1] }; }
    case 'add': {
      const opts = { checks: [] }, pos = [];
      for (let i = 1; i < a.length; i++) {
        if (a[i] === '--owner') opts.ownerSessionId = a[++i];
        else if (a[i] === '--project') opts.project = a[++i];
        else if (a[i] === '--due') opts.due = a[++i];
        else if (a[i] === '--check') opts.checks.push(a[++i]);
        else if (a[i] === '--detail') opts.text = a[++i];
        else if (/^--./.test(a[i])) return { code: 2, text: `goal add: unknown option ${a[i]}. Nothing was written.` };
        else pos.push(a[i]);
      }
      return out(add({ ...opts, title: pos.join(' '), source: 'cli' }), r => `${r.goal.id} -> ${r.goal.ownerSessionId || 'unrouted (' + ((r.goal.routing || {}).why || '') + ')'}`);
    }
    case 'progress': return out(report(a[1], text(2), { by: 'cli' }), r => `${r.goal.id}: recorded (${r.kind})`);
    case 'done': case 'fail': return out(close(a[1], { status: sub === 'fail' ? 'failed' : 'done', note: text(2), by: 'cli' }), r => `${r.goal.id} -> ${r.goal.status}`);
    case 'reopen': return out(reopen(a[1], text(2)), r => `${r.goal.id} reopened`);
    case 'verify': {
      if (!/^\d{4}-\d{2}-\d{2}/.test(a[2] || '')) return { code: 2, text: 'usage: baton goal verify <id> <YYYY-MM-DD> "<what would prove it actually worked>"' };
      return out(verify(a[1], a[2], text(3)), r => `${r.goal.id}: delivered is not done — AWAITING-VERIFICATION until ${a[2]}, then VERIFY-NOW. Not chased.`);
    }
    case 'judged': return out(judged(a[1], text(2)), r => `${r.goal.id}: released for chasing`);
    case 'collected': {
      if (!a[1]) {
        const m = collectedMap();
        const ids = Object.keys(m).sort((x, y) => String(m[y].ts).localeCompare(String(m[x].ts)));
        if (!ids.length) return { code: 0, text: 'nothing collected yet' };
        return { code: 0, text: ids.map(sid => { const c = collectedStatus(sid, { map: m });
          return `${sid.slice(0, 14).padEnd(14)} ${String(c.state).padEnd(13)} ${String(c.ts || '').slice(0, 16)}  goals ${c.goals.join(',') || '-'}`
            + (c.state === 'moved-since' ? '\n               ^ has produced new work since: raise it again' : ''); }).join('\n') };
      }
      if (a.length > 2) recordCollected(a[1], null, text(2));
      const c = collectedStatus(a[1]);
      return { code: 0, text: `${a[1].slice(0, 14)}: ${c.state || 'never collected'}${c.ts ? ' since ' + String(c.ts).slice(0, 16) : ''} (goals ${c.goals.join(',') || '-'})` };
    }
    case 'health': {
      let h = null; try { h = JSON.parse(fs.readFileSync(HEALTH, 'utf8')); } catch {}
      if (!h) return { code: 0, text: 'not measured yet: the goal cycle writes goals-health.json (modules goalChaser / cacheKeeper)' };
      const L = [`register health — ${String(h.at).slice(0, 16)} UTC`, 'conditions: ' + Object.entries(h.counts || {}).map(([k, v]) => `${k} ${v}`).join(' · '),
        `changed in 24 h: ${(h.events24 || []).length}`];
      for (const e of (h.events24 || []).slice(-30).reverse()) L.push(`  ${String(e.at).slice(5, 16)} ${String(e.kind || 'condition').padEnd(10)} ${e.id} ${e.what || (e.from || '') + ' -> ' + (e.to || '')}`);
      return { code: 0, text: L.join('\n') };
    }
    default: return { code: 2, text: USAGE };
  }
}

module.exports = {
  DIR, FILE, LEGACY_FILE, CHASE_LOG, NOTES, EVENTS, HEALTH, STATE, COLLECTED, GOAL_DEFAULTS, CACHE_DEFAULTS, PENDING_WORK, CHASEABLE, ORDER, FINISHED,
  settings, load, save, mutate, history, parseLines, add, close, report, reopen, verify, judged, rehome, list, show, route, find,
  tell, notes, closeNote, readActivity, markers, applyMarkers, ownerState, classify, assess, recordHealth,
  plan, keepalivePlan, rehomePlan, message, status, tick, defaultSessions, readJsonl,
  recordCollected, collectedMap, collectedStatus, movedSince, oldOwnerHold, cli, USAGE,
};
