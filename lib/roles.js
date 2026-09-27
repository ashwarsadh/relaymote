// roles.js — the ROLES DB: what each live session is FOR, so owner routing stops guessing from titles.
//
// A title cannot say that a session drifted INTO a role or OUT of one, and it can never say what a
// session does NOT own. Per live session (not archived, active within roles.activeDays, reachable in
// the sidebar) this keeps: role (one line), owns_topics / owns_files / owns_goals, not_owns, master
// flag, open goals (from Relaymote's goal register, refreshed every run at no cost) and the exact lines the
// record was drawn from.
//
// Input per session is bounded: the HEAD of its lean digest (first owner prompts: what it was started
// for) and the TAIL (most recent turns: what it does now) — never a whole transcript — plus its goals
// and its overview when lib/summarize.js has one. Lines are numbered so evidence can be checked; a
// citation of a line the model was never shown is dropped, not trusted.
//
// Engines (lib/engine.js): with engine.kind = none (the default) every session gets a free HEURISTIC
// record (title + tags + project -> owns_topics), so routing still gets a signal. With an engine, only
// sessions whose transcript CHANGED are (re)classified, at most roles.budget per run inside
// roles.budgetMin; a failed classification may retry once on engine.fallbackKind (capped per run), and a
// dead login parks the rest in `pending` instead of spinning. One builder at a time (lock file).
//
// WRITES <data>/conductor/roles.json  {built_at, stats, sessions: {id: record}, pending}
// lib/owner.js reads that same file by default (settings.ownerIndex blank).
'use strict';
const fs = require('fs');
const path = require('path');
const config = require('./config');
const engine = require('./engine');

const DB = () => process.env.BATON_ROLES_JSON || path.join(config.DATA, 'conductor', 'roles.json');
const LOCK = () => DB().replace(/\.json$/i, '') + '.lock';
const LOCK_STALE_MS = 2 * 3600000;
const HEAD_PROMPTS = 6, TAIL_ENTRIES = 14, CLIP = 420;
const TAG = 'baton-roles';

const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['role', 'owns_topics', 'owns_files', 'owns_goals', 'not_owns', 'is_master', 'evidence'],
  properties: {
    role: { type: 'string', minLength: 1, description: 'ONE line: what this session is FOR right now, judged mainly from the RECENT (tail) lines, because sessions drift.' },
    owns_topics: { type: 'array', items: { type: 'string' }, description: 'Short noun phrases for the work it currently owns. 1-8 items.' },
    owns_files: { type: 'array', items: { type: 'string' }, description: 'File or module names it edits and owns, only if the SOURCE names them. May be empty.' },
    owns_goals: { type: 'array', items: { type: 'string' }, description: 'Goal ids from the (goal) lines assigned to it. May be empty.' },
    not_owns: { type: 'array', items: { type: 'string' }, description: 'Topics it handed off, declined, said belong elsewhere, or that a reader might wrongly send it. Empty if the SOURCE gives no basis.' },
    is_master: { type: 'boolean', description: 'True only if the SOURCE shows it coordinating other sessions (spawning, dispatching, receiving their reports).' },
    evidence: { type: 'array', items: { type: 'string' }, description: 'The [L<n>] line ids the role and owns_topics were drawn from. 1-6 items.' },
  },
};

const PROMPT = 'Classify the ROLE of one Claude Code session from the SOURCE (numbered lines). ' +
  'Lines marked (goal) are goals assigned to it; (overview) is its current overview card; (head/...) are its FIRST prompts — what it was started for; ' +
  '(tail/...) are its MOST RECENT exchanges — what it is doing NOW. Sessions DRIFT: judge the role from the tail first and the title last. ' +
  'Put in not_owns anything it handed off, declined, or said belongs to another session. role is one line. ' +
  'Every owns_topics item must be supported by a cited [L<n>] line in evidence.';

const settings = () => ({ budget: 60, budgetMin: 15, activeDays: 30, fallbackCap: 12, ...(config.get().roles || {}) });
const iso = () => new Date().toISOString();
function log0() {}

function loadDb() {
  try { const d = JSON.parse(fs.readFileSync(DB(), 'utf8')); if (d && typeof d.sessions === 'object') return d; } catch {}
  return { sessions: {}, stats: {}, pending: {} };
}
function saveDb(db) {
  fs.mkdirSync(path.dirname(DB()), { recursive: true });
  const tmp = DB() + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 1));
  fs.renameSync(tmp, DB());
}

/** Sessions that can receive work now: not archived, in the sidebar, has a transcript, active within the window. Newest first. */
function population(ix, activeDays) {
  const out = [];
  for (const [id, s0] of Object.entries((ix && ix.sessions) || {})) {
    const s = { id, ...s0 };
    if (s.archived || s.in_sidebar === false || !s.has_transcript) continue;
    if (s.age_days == null || s.age_days > activeDays) continue;
    out.push(s);
  }
  return out.sort((a, b) => (a.age_days || 0) - (b.age_days || 0));
}

/** Changed transcript == changed size or last timestamp (both in the index). An idle session costs nothing. */
const fingerprint = s => `${s.bytes || 0}:${s.last || ''}`;

function openGoalsBySession() {
  const by = {};
  try {
    for (const g of require('./goals').list()) {
      if (g && g.ownerSessionId) (by[g.ownerSessionId] = by[g.ownerSessionId] || []).push(g);
    }
  } catch {}
  return by;
}

function overviews() {
  try { return (JSON.parse(fs.readFileSync(require('./summarize').ALL(), 'utf8')).sessions) || {}; } catch { return {}; }
}

/** The numbered classification document: goals, overview, head prompts, tail turns (from the digest; index prompts when there is none). */
function buildDoc(s, goals = [], overview = null) {
  const L = [];
  const add = (kind, txt) => { const t = String(txt || '').replace(/\s+/g, ' ').trim(); if (t) L.push([kind, t.slice(0, CLIP)]); };
  for (const g of goals) add('goal', `${g.id} [${g.status || 'open'}] ${g.title || ''}`);
  if (overview) add('overview', ['goal', 'in_progress', 'done', 'blocked_on'].map(k => `${k}: ${overview[k] || 'none'}`).join(' | '));
  let turns = [];
  try { turns = require('./digests').turns(s.id); } catch {}
  if (turns.length) {
    const head = turns.filter(t => t.kind === 'OWNER' || t.kind === 'OWNER_VIA_CONDUCTOR').slice(0, HEAD_PROMPTS);
    const tail = turns.slice(-TAIL_ENTRIES).filter(t => !head.includes(t));
    for (const t of head) add('head/user ' + t.ts, t.body);
    for (const t of tail) add(`tail/${t.kind === 'ASSISTANT' ? 'assistant' : t.kind === 'RELAY' ? 'relay' : 'user'} ${t.ts}`, t.body);
  } else {
    for (const p of (s.prompts || []).slice(0, HEAD_PROMPTS)) add('head/user', p);
    if (s.last_prompt) add('tail/user', s.last_prompt);
    if (s.final_text) add('tail/assistant', s.final_text);
  }
  const numbered = L.map(([k, t], i) => `[L${i + 1}] (${k}) ${t}`);
  const doc = [`SESSION ${s.id}`, `TITLE: ${s.title || ''}`, `PROJECT: ${s.project || '-'}    SIDEBAR GROUP: ${s.group || '-'}`, ''].concat(numbered).join('\n');
  return { doc, numbered };
}

function uniq(list) {
  const seen = new Set(), out = [];
  for (const x of list) { const v = String(x || '').trim(); const k = v.toLowerCase(); if (v && !seen.has(k)) { seen.add(k); out.push(v); } }
  return out;
}

/** Free record from what the index already knows: title + tags + project (+ the overview's goal when there is one). */
function heuristic(s, goals = [], overview = null) {
  const role = (overview && overview.goal && overview.goal !== 'none') ? overview.goal : (s.title || '(untitled)');
  return {
    id: s.id, title: s.title || null, project: s.project || null, group: s.group || null,
    role: String(role).slice(0, 240),
    owns_topics: uniq([s.title, s.project, ...(s.tags || [])]).slice(0, 8),
    owns_files: [], owns_goals: goals.map(g => g.id), not_owns: [],
    is_master: !!(s.is_master || s.baton_master),
    evidence: ['(heuristic) title, tags and project from the index'],
    engine: 'heuristic', served: null, fingerprint: fingerprint(s), classified_at: iso(), last_active: s.last || null,
  };
}

function record(s, rec, r, numbered) {
  const cited = [];
  for (const ev of rec.evidence || []) {
    for (const tok of String(ev).replace(/,/g, ' ').split(/\s+/)) {
      const m = /^\[?\(?L(\d+)\]?\)?$/i.exec(tok);
      if (!m) continue;
      const i = Number(m[1]) - 1;
      if (i >= 0 && i < numbered.length && !cited.includes(numbered[i])) cited.push(numbered[i]);
    }
  }
  return {
    id: s.id, title: s.title || null, project: s.project || null, group: s.group || null,
    role: String(rec.role).trim().slice(0, 240),
    owns_topics: uniq(rec.owns_topics || []).slice(0, 8), owns_files: uniq(rec.owns_files || []), owns_goals: uniq(rec.owns_goals || []),
    not_owns: uniq(rec.not_owns || []),
    is_master: !!rec.is_master || !!(s.is_master || s.baton_master),
    evidence: (cited.length ? cited : numbered.slice(-3)).slice(0, 8),
    engine: r.engine, served: r.served || null, fingerprint: fingerprint(s), classified_at: iso(), last_active: s.last || null,
  };
}

/** Classify one session with the engine (or `over`). -> { rec|null, r } */
async function classify(s, goals, overview, { deadline = Infinity, over = null } = {}) {
  const { doc, numbered } = buildDoc(s, goals, overview);
  const r = await engine.run({ prompt: PROMPT, input: doc, schema: SCHEMA, title: 'ROLE: ' + String(s.title || s.id).slice(0, 50), deadline, over, tag: TAG });
  if (!r.ok) return { rec: null, r };
  if (!String(r.json.role || '').trim()) return { rec: null, r: { ...r, ok: false, code: 'SCHEMA_INVALID', error: 'role is blank' } };
  return { rec: record(s, r.json, r, numbered), r };
}

function lock() {
  fs.mkdirSync(path.dirname(DB()), { recursive: true });
  try { if (Date.now() - fs.statSync(LOCK()).mtimeMs > LOCK_STALE_MS) fs.unlinkSync(LOCK()); } catch {}
  try { const fd = fs.openSync(LOCK(), 'wx'); fs.writeSync(fd, String(process.pid)); fs.closeSync(fd); return true; } catch { return false; }
}
function unlock() { try { fs.unlinkSync(LOCK()); } catch {} }

/**
 * Bring roles.json up to date. opts: index (default: the on-disk index), budget, budgetMin, only (id
 * prefix: reclassify that one now), dry, log, over (engine override). -> the run record.
 */
async function build(opts = {}) {
  if (!lock()) { (opts.log || log0)('roles: another build holds ' + LOCK() + '; skipping'); return { skipped: 'locked' }; }
  try { return await buildLocked(opts); } finally { unlock(); }
}

async function buildLocked(opts) {
  const st = settings();
  const log = opts.log || log0;
  const t0 = Date.now();
  const budget = opts.budget != null ? Number(opts.budget) : Number(st.budget);
  const deadline = t0 + (opts.budgetMin != null ? Number(opts.budgetMin) : Number(st.budgetMin)) * 60000;
  const ix = opts.index || require('./projects').read();
  if (!ix) return { error: 'no project index yet' };
  const live = population(ix, Number(st.activeDays) || 30);
  const liveIds = new Set(live.map(s => s.id));
  let pop = live;
  if (opts.only) {
    const pre = String(opts.only).toLowerCase().replace(/^(local_|cli_)/, '');
    pop = Object.entries(ix.sessions || {}).map(([id, s]) => ({ id, ...s }))
      .filter(s => s.id.toLowerCase().replace(/^(local_|cli_)/, '').startsWith(pre) || String(s.cli || '').toLowerCase().startsWith(pre));
  }
  const db = loadDb();
  const sessions = db.sessions = db.sessions || {};
  const pending = db.pending = db.pending || {};
  const goals = openGoalsBySession();
  const ovs = overviews();
  const eng = engine.effective(opts.over);
  const engineOn = eng.kind !== 'none' && !eng.code;

  const run = { started: iso(), engine: eng.kind, classified: 0, heuristic: 0, failed: 0, kept_stale: 0, fallback_used: 0, cost_usd: 0, secs: 0 };
  // Who needs work: no record, a changed transcript, or a free heuristic record an engine could now improve.
  const todo = [];
  for (const s of pop) {
    const old = sessions[s.id];
    const changed = !old || old.fingerprint !== fingerprint(s);
    if (opts.only || changed || (engineOn && old && old.engine === 'heuristic')) todo.push(s);
  }
  log(`roles: ${pop.length} live sessions, ${todo.length} need (re)classifying (engine ${eng.kind}${engineOn ? ', budget ' + budget : ''})`);
  if (opts.dry) return { dry: true, live: pop.length, todo: todo.map(s => ({ id: s.id, title: s.title })), engine: engine.describe(opts.over) };

  const setHeuristic = (s) => {
    const old = sessions[s.id];
    // an engine record beats a heuristic one even when a little stale: keep it, flagged
    if (old && old.engine !== 'heuristic') { if (old.fingerprint !== fingerprint(s)) { old.stale = true; run.kept_stale++; } return; }
    sessions[s.id] = heuristic(s, goals[s.id] || [], (ovs[s.id] || {}).summary || null);
    run.heuristic++;
  };

  let probe = null;
  if (engineOn && todo.length) {
    probe = await engine.probe(opts.over);
    if (!probe.ok) { run.error = 'route unavailable: ' + probe.reason; log('roles: engine route unavailable — heuristic only: ' + probe.reason); }
  }
  if (!engineOn || !probe || !probe.ok) {
    for (const s of todo) setHeuristic(s);
  } else {
    const fb = { kind: (config.get().engine || {}).fallbackKind || 'none', model: (config.get().engine || {}).fallbackModel || '' };
    const fbOn = fb.kind !== 'none' && fb.kind !== eng.kind;
    const fbCap = Number(st.fallbackCap) || 0;
    let authDead = false, n = 0, stop = null;
    for (const s of todo) {
      if (stop || n >= budget || deadline - Date.now() < 2000) { if (!stop) stop = n >= budget ? 'budget' : 'time'; setHeuristic(s); continue; }
      n++;
      let { rec, r } = await classify(s, goals[s.id] || [], (ovs[s.id] || {}).summary || null, { deadline, over: opts.over });
      run.cost_usd += r.costUsd || 0;
      if (!rec && engine.ROUTE_CODES.has(r.code)) { stop = 'route: ' + r.code; run.error = `route failed mid-run: ${r.code}: ${r.error}`; }
      if (!rec && !stop && fbOn && !authDead && run.fallback_used < fbCap && r.code !== 'BUDGET') {
        const r1 = r;
        ({ rec, r } = await classify(s, goals[s.id] || [], (ovs[s.id] || {}).summary || null, { deadline, over: { ...(opts.over || {}), ...fb } }));
        run.fallback_used++; run.cost_usd += r.costUsd || 0;
        if (!rec && r.code === 'AUTH') authDead = true;
        if (!rec) r = { ...r, error: `${eng.kind}: ${r1.code} ${String(r1.error).slice(0, 100)}; ${fb.kind}: ${r.code} ${String(r.error).slice(0, 100)}` };
      }
      if (rec) { sessions[s.id] = rec; delete pending[s.id]; run.classified++; continue; }
      run.failed++;
      pending[s.id] = { why: `${r.code}: ${String(r.error).slice(0, 200)}`, at: run.started };
      log(`roles: FAILED ${s.id} "${String(s.title || '').slice(0, 40)}": ${r.code} ${String(r.error).slice(0, 120)}`);
      setHeuristic(s);   // routing still gets a signal; the engine retries it next run
    }
    if (stop) run.stopped = stop;
  }

  // Open goals come from the register, not the model, and are refreshed for every record every run:
  // a goal re-homed to another session moves at once, with nothing spent.
  for (const [sid, rec] of Object.entries(sessions)) {
    rec.open_goals = Object.fromEntries((goals[sid] || []).filter(g => g.id).map(g => [g.id, String(g.title || '').slice(0, 200)]));
  }
  // The DB describes who can receive work NOW: a stale role is worse than none.
  if (!opts.only) for (const sid of Object.keys(sessions)) if (!liveIds.has(sid)) delete sessions[sid];
  for (const sid of Object.keys(pending)) if (!liveIds.has(sid)) delete pending[sid];

  run.secs = +((Date.now() - t0) / 1000).toFixed(1);
  run.cost_usd = +run.cost_usd.toFixed(4);
  const stats = db.stats = db.stats || {};
  stats.last_run = run;
  const tot = stats.total = stats.total || { classified: 0, heuristic: 0, failed: 0, fallback_used: 0, cost_usd: 0, secs: 0 };
  for (const k of Object.keys(tot)) tot[k] = +(tot[k] + (run[k] || 0)).toFixed(4);
  stats.records = Object.keys(sessions).length;
  db.built_at = iso();
  saveDb(db);
  log(`roles: ${run.classified} classified, ${run.heuristic} heuristic, ${run.failed} failed · $${run.cost_usd} · ${run.secs}s · ${stats.records} records`);
  return run;
}

/** `baton roles [--budget N] [--one <id>] [--stats] [--dry-run]` */
async function cli(argv = []) {
  const opt = f => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
  if (argv[0] === 'help' || argv.includes('--help')) return console.log('baton roles [--budget N] [--one <id>] [--stats] [--dry-run]   the roles DB owner routing reads (' + DB() + ')');
  if (argv.includes('--stats')) {
    const db = loadDb();
    return console.log(JSON.stringify({ file: DB(), built_at: db.built_at || null, records: Object.keys(db.sessions || {}).length, pending: Object.keys(db.pending || {}).length, stats: db.stats || {} }, null, 2));
  }
  const ix = await require('./projects').build(require('./summarize').buildOpts());
  const r = await build({ index: ix, budget: opt('--budget'), only: opt('--one'), dry: argv.includes('--dry-run'), log: m => console.error(m) });
  if (opt('--one')) {
    const db = loadDb();
    const pre = String(opt('--one')).toLowerCase().replace(/^(local_|cli_)/, '');
    for (const [sid, rec] of Object.entries(db.sessions)) if (sid.toLowerCase().replace(/^(local_|cli_)/, '').startsWith(pre)) console.log(JSON.stringify(rec, null, 1));
  }
  console.log(JSON.stringify(r, null, 2));
}

module.exports = { DB, LOCK, SCHEMA, PROMPT, population, fingerprint, buildDoc, heuristic, classify, build, loadDb, cli };
