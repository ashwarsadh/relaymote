// summarize.js — a 5-line overview per live session: goal · done · in progress · blocked on · last ask.
//
// The only session content a model ever sees is the session's lean DIGEST (lib/digests.js: the
// person's turns + each turn's final answer; no tool calls, tool output, images or file lists), and
// only the part it has not summarised yet: the previous overview + the digest bytes after `doffset`
// ("anchored" summarisation — update the card, do not start over). Trimmed to the first HEAD_BLOCKS
// and last TAIL_BLOCKS turn blocks and DELTA_CAP characters.
//
// Module `summaries` (default off) + an engine (lib/engine.js, default off). Safety, carried over from
// a daemon that was taken down twice by this step:
//   * probe the route BEFORE sending anything: unreachable, busy, or "the last N calls never reached a
//     model" stops the pass and records "route unavailable: <why>" — nothing is spent on a dead route;
//   * a hard cap per run and a time budget; calls one at a time; a route failure mid-pass aborts it;
//   * a failed overview is never retried in a loop: that session cools off 6 h, doubling per failure,
//     capped at a week (a success clears it).
//
// Files (<data>/conductor/summaries/): <session>.json one record · ALL.json consolidated (the index
// reads only this) · last-run.json · failures.json · work/<session>.txt the input the model was given.
'use strict';
const fs = require('fs');
const path = require('path');
const config = require('./config');
const engine = require('./engine');

const DIR = () => path.join(config.DATA, 'conductor', 'summaries');
const WORK = () => path.join(DIR(), 'work');
const ALL = () => path.join(DIR(), 'ALL.json');
const LAST_RUN = () => path.join(DIR(), 'last-run.json');
const FAILURES = () => path.join(DIR(), 'failures.json');
const LOCK = () => path.join(DIR(), '.lock');
const KEYS = ['goal', 'done', 'in_progress', 'blocked_on', 'last_ask'];
const DELTA_CAP = 22000;       // chars of digest handed to the model (~5.5k tokens)
const HEAD_BLOCKS = 10, TAIL_BLOCKS = 60;
const MIN_DELTA = 400;         // fewer new digest bytes than this is a stray relay line — not worth a call
const FAIL_COOLOFF_H = 6, COOLOFF_CAP_H = 168;
const LOCK_STALE_MS = 2 * 3600000;
const BLOCK_RX = /^## /gm;
const TAG = 'baton-summary';

const SCHEMA = {
  type: 'object', required: KEYS,
  properties: Object.fromEntries(KEYS.map(k => [k, { type: ['string', 'array'] }])),
};

const settings = () => ({ cap: 6, budgetMin: 20, days: 14, intervalMinutes: 30, ...(config.get().summaries || {}) });
const owner = () => String(((config.get().index || {}).ownerLabel) || 'USER').trim() || 'USER';
const now = () => new Date().toISOString();
const safe = sid => String(sid).replace(/[^A-Za-z0-9._-]+/g, '_');
function readJson(f, d) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } }
function writeJson(f, v, pretty) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(v, null, pretty ? 1 : 0));
  fs.renameSync(tmp, f);
}

function prompt() {
  const who = owner();
  return 'You are writing the 5-line overview card of ONE Claude Code session for a dashboard. ' +
    'The SOURCE holds a header, the previous overview if there is one, then the session\'s recent turns taken from its lean digest: ' +
    `a block headed "${who}" is what the person typed, "ASSISTANT" is that turn's final answer, "RELAY" is a one-line marker for a message from another session or tool, "COMMAND" is a slash command. ` +
    'The digest is the whole record you get. Each key is ONE line of at most 200 characters in plain English, the string "none" when nothing applies: ' +
    '"goal" (what the session is for overall), "done" (what it has completed, most recent first), ' +
    '"in_progress" (what it was doing when it last stopped), "blocked_on" (what it needs from the person or another session, else none), ' +
    '"last_ask" (the last question or offer it put to a human, short and close to verbatim, else none). ' +
    'If a previous overview is present, update it with the new turns: keep what is still true, replace what changed, never drop the goal.';
}

// ------------------------------------------------------------------------------------------ failures
function loadFailures() { const d = readJson(FAILURES(), {}); return d && typeof d === 'object' && !Array.isArray(d) ? d : {}; }
function noteFailure(sid, err, at = Date.now()) {
  const d = loadFailures();
  const e = d[sid] || { n: 0 };
  d[sid] = { n: (Number(e.n) || 0) + 1, at: new Date(at).toISOString(), error: String(err).slice(0, 200) };
  writeJson(FAILURES(), d, true);
  return d[sid];
}
function clearFailure(sid) { const d = loadFailures(); if (d[sid]) { delete d[sid]; writeJson(FAILURES(), d, true); } }
/** Hours a session with this failure entry stays out: 6, 12, 24 … capped at a week. */
function cooloffHours(e) { return Math.min(FAIL_COOLOFF_H * 2 ** Math.max(0, (Number(e && e.n) || 1) - 1), COOLOFF_CAP_H); }
function inCooloff(sid, failures, t = Date.now()) {
  const e = failures[sid];
  if (!e || !e.at) return false;
  const at = Date.parse(e.at);
  if (!at) return false;
  return (t - at) / 3600000 < cooloffHours(e);
}

// ------------------------------------------------------------------------------------------ picking
function recordPath(sid) { return path.join(DIR(), safe(sid) + '.json'); }
function digestSize(sid) { try { return fs.statSync(require('./digests').digestPath(sid)).size; } catch { return -1; } }

/**
 * Live sessions whose digest grew >= MIN_DELTA bytes since their last overview, active within `days`,
 * not cooling off, newest first, at most `cap`. -> { picks: [{ s, dsize, prev }], coolingOff, noDigest }
 */
function pick(ix, { cap = 6, days = 14, t = Date.now() } = {}) {
  const failures = loadFailures();
  const out = [];
  let coolingOff = 0, noDigest = 0;
  for (const [sid, s0] of Object.entries((ix && ix.sessions) || {})) {
    const s = { id: sid, ...s0 };
    if (s.in_sidebar === false || s.archived || !s.has_transcript) continue;
    if (s.age_days != null && s.age_days > days) continue;
    const dsize = digestSize(sid);
    if (dsize < 0) { noDigest++; continue; }
    if (inCooloff(sid, failures, t)) { coolingOff++; continue; }
    const prev = readJson(recordPath(sid), null);
    if (prev && prev.doffset != null && (prev.doffset >= dsize || dsize - prev.doffset < MIN_DELTA)) continue;
    out.push({ s, dsize, prev });
  }
  out.sort((a, b) => String(b.s.last || '').localeCompare(String(a.s.last || '')));
  return { picks: out.slice(0, Math.max(0, cap)), candidates: out.length, coolingOff, noDigest };
}

function trimBlocks(body) {
  const idx = [...body.matchAll(BLOCK_RX)].map(m => m.index);
  if (idx.length <= HEAD_BLOCKS + TAIL_BLOCKS) return { body, n: idx.length };
  return { body: body.slice(0, idx[HEAD_BLOCKS]) + `\n… ${idx.length - HEAD_BLOCKS - TAIL_BLOCKS} turns omitted …\n\n` + body.slice(idx[idx.length - TAIL_BLOCKS]), n: idx.length };
}

/** The digest bytes after the last overview, trimmed, under a header — the ONLY session content the model sees. */
function buildInput(s, prev) {
  const doffset = (prev && prev.doffset) || 0;
  const d = require('./digests').readDelta(s.id, doffset);
  let { body, n } = trimBlocks(d.text);
  if (body.length > DELTA_CAP) body = body.slice(0, DELTA_CAP / 4) + '\n… middle trimmed …\n' + body.slice(-(DELTA_CAP - DELTA_CAP / 4));
  const head = [`SESSION: ${s.title || s.id}`,
    `project: ${s.project || '-'} · group: ${s.group || '-'} · cwd: ${s.cwd || '-'}`,
    `last active: ${String(s.last || '-').slice(0, 16).replace('T', ' ')} · turns: ${s.turns == null ? '-' : s.turns} · pending state: ${s.pending || '-'}`];
  if (s.buried) head.push(`NOTE: the session's question at ${String(s.buried_ts || '').slice(0, 16)} was never answered — a relay hid it: ${s.buried_ask || ''}`);
  if (prev && prev.summary && typeof prev.summary === 'object') {
    head.push('PREVIOUS OVERVIEW (update this, do not start over): ' + JSON.stringify(prev.summary));
    head.push(`DIGEST TURNS SINCE THAT OVERVIEW (${n} blocks):`);
  } else head.push(`DIGEST — every turn of the session (${n} blocks):`);
  return { text: head.join('\n') + '\n\n' + body + '\n', dsize: d.offset };
}

function normalise(json) {
  const out = {};
  for (const k of KEYS) {
    let v = json[k];
    if (Array.isArray(v)) v = v.map(String).join('; ');
    v = String(v == null ? 'none' : v).replace(/\s+/g, ' ').trim() || 'none';
    out[k] = v.slice(0, 240);
  }
  return out;
}

function consolidate() {
  const recs = {};
  let names = [];
  try { names = fs.readdirSync(DIR()); } catch {}
  for (const f of names) {
    if (!f.endsWith('.json') || ['ALL.json', 'last-run.json', 'failures.json'].includes(f)) continue;
    const d = readJson(path.join(DIR(), f), null);
    if (d && d.session && d.summary && typeof d.summary === 'object') recs[d.session] = d;
  }
  writeJson(ALL(), { at: now(), n: Object.keys(recs).length, sessions: recs });
  return Object.keys(recs).length;
}

function lastRun(t0, fields) {
  const d = { at: now(), seconds: +((Date.now() - t0) / 1000).toFixed(1), ...fields };
  for (const k of Object.keys(d)) if (d[k] === undefined) delete d[k];
  writeJson(LAST_RUN(), d, true);
  return d;
}

function lock() {
  fs.mkdirSync(DIR(), { recursive: true });
  try { if (Date.now() - fs.statSync(LOCK()).mtimeMs > LOCK_STALE_MS) fs.unlinkSync(LOCK()); } catch {}
  try { const fd = fs.openSync(LOCK(), 'wx'); fs.writeSync(fd, String(process.pid)); fs.closeSync(fd); return true; } catch { return false; }
}
function unlock() { try { fs.unlinkSync(LOCK()); } catch {} }

// ------------------------------------------------------------------------------------------ run
/**
 * One pass. opts: cap, budgetMin, days, dry, index (default: the on-disk index), log, over (engine override).
 * -> the last-run record { picked, done, failed, skipped, cost_usd, budget_hit, error?, … }.
 */
async function run(opts = {}) {
  const st = settings();
  const cap = opts.cap != null ? Number(opts.cap) : Number(st.cap);
  const budgetMin = opts.budgetMin != null ? Number(opts.budgetMin) : Number(st.budgetMin);
  const days = opts.days != null ? Number(opts.days) : Number(st.days);
  const log = opts.log || (() => {});
  const t0 = Date.now(), deadline = t0 + budgetMin * 60000;
  if (!lock()) return { skipped: 'locked', message: 'another overview pass holds ' + LOCK() };
  try {
    fs.mkdirSync(WORK(), { recursive: true });
    const ix = opts.index || require('./projects').read();
    if (!ix) return lastRun(t0, { picked: 0, done: 0, failed: 0, skipped: 0, cost_usd: 0, budget_hit: false, error: 'no project index yet' });
    const p = pick(ix, { cap, days });
    log(`summaries: ${p.picks.length} to summarise (cap ${cap}, window ${days} d; ${p.coolingOff} cooling off, ${p.noDigest} without a digest)`);
    const common = { engine: engine.describe(opts.over).kind, cooling_off: p.coolingOff, candidates: p.candidates };
    if (!p.picks.length) { consolidate(); return lastRun(t0, { ...common, picked: 0, done: 0, failed: 0, skipped: 0, cost_usd: 0, budget_hit: false }); }

    if (opts.dry) {
      const plan = p.picks.map(({ s, prev }) => {
        const inp = buildInput(s, prev);
        fs.writeFileSync(path.join(WORK(), safe(s.id) + '.txt'), inp.text);
        return { session: s.id, title: s.title, delta_bytes: inp.dsize - ((prev && prev.doffset) || 0), input_chars: inp.text.length };
      });
      return { dry: true, picked: plan.length, plan, engine: engine.describe(opts.over) };
    }

    // (1) PROBE BEFORE SENDING ANYTHING: a dead or busy route gets nothing, and says so once.
    const pr = await engine.probe(opts.over);
    if (!pr.ok) {
      log('summaries: SKIPPED, nothing sent — route unavailable: ' + pr.reason);
      consolidate();
      return lastRun(t0, { ...common, picked: p.picks.length, done: 0, failed: 0, skipped: p.picks.length, cost_usd: 0, budget_hit: false, error: 'route unavailable: ' + pr.reason });
    }
    let done = 0, failed = 0, cost = 0, budgetHit = false, aborted = null;
    const served = {};
    for (const { s, prev } of p.picks) {
      if (deadline - Date.now() < 2000) { budgetHit = true; break; }   // not started: no failure, no cool-off
      const inp = buildInput(s, prev);
      fs.writeFileSync(path.join(WORK(), safe(s.id) + '.txt'), inp.text);
      const r = await engine.run({ prompt: prompt(), input: inp.text, schema: SCHEMA, title: 'OVERVIEW: ' + String(s.title || s.id).slice(0, 50), deadline, tag: TAG, over: opts.over });
      cost += r.costUsd || 0;
      if (r.served) served[r.served] = (served[r.served] || 0) + 1;
      if (r.ok) {
        writeJson(recordPath(s.id), {
          session: s.id, cli: s.cli || null, title: s.title || null, project: s.project || null,
          doffset: inp.dsize, dsize: inp.dsize, bytes: s.bytes || 0, last_ts: s.last || null, updated: now(),
          summary: normalise(r.json), engine: r.engine, model: r.model, served: r.served || null,
          cost_usd: r.costUsd || 0, runs: ((prev && prev.runs) || 0) + 1,
        }, true);
        clearFailure(s.id);
        done++;
        continue;
      }
      if (r.code === 'BUDGET') { budgetHit = true; failed++; noteFailure(s.id, 'stopped at budget'); break; }
      if (engine.ROUTE_CODES.has(r.code)) {   // the ROUTE broke mid-pass: stop; do not cool the session off for it
        aborted = `${r.code}: ${r.error}`;
        log('summaries: ABORTING the pass — ' + aborted);
        break;
      }
      failed++;
      const e = noteFailure(s.id, `${r.code}: ${r.error}`);
      log(`summaries: ${s.id} failed (${r.code}) — cooling off ${cooloffHours(e)} h: ${String(r.error).slice(0, 140)}`);
    }
    const n = consolidate();
    const rec = lastRun(t0, { ...common, picked: p.picks.length, done, failed, skipped: p.picks.length - done - failed, cost_usd: +cost.toFixed(4),
      budget_hit: budgetHit, error: aborted ? 'route failed mid-pass: ' + aborted : undefined, served: Object.keys(served).length ? served : undefined, on_disk: n });
    log(`summaries: ${done} written, ${failed} failed, ${rec.skipped} not reached · $${cost.toFixed(3)} · ${rec.seconds}s${budgetHit ? ' · BUDGET HIT' : ''}`);
    return rec;
  } finally { unlock(); }
}

// ------------------------------------------------------------------------------------------ index + daemon
/** Attach each session's overview to an index object (lib/projects.js build): s.summary (one line for routing), s.overview. */
function attach(ix) {
  const all = readJson(ALL(), null);
  if (!all || !all.sessions || !ix || !ix.sessions) return 0;
  let n = 0;
  for (const [sid, rec] of Object.entries(all.sessions)) {
    const s = ix.sessions[sid];
    if (!s || !rec.summary) continue;
    const o = rec.summary;
    s.overview = o;
    s.summary = [o.goal, o.in_progress, o.done].filter(x => x && x !== 'none').join(' · ');
    s.summary_at = rec.updated || null;
    const ds = digestSize(sid);
    s.summary_stale = ds >= 0 && rec.dsize != null ? ds - rec.dsize >= MIN_DELTA : undefined;
    n++;
  }
  return n;
}

/** Which session overview to show for one id: { overview, updated, stale } or null. */
function get(sid) {
  const all = readJson(ALL(), null);
  const rec = all && all.sessions && all.sessions[sid];
  return rec ? { overview: rec.summary, updated: rec.updated, served: rec.served, runs: rec.runs } : null;
}

/** Options for projects.build(): the digests the intel steps read are built only when one of them will use them. */
function buildOpts() {
  const e = engine.effective();
  return (config.mod('summaries') || (config.mod('roles') && e.kind !== 'none')) ? { digests: true } : {};
}

let cycling = false, lastCycle = 0;
/**
 * Daemon step, after the index build: summaries, then roles, then (if an overview changed) the index is
 * rebuilt so routing sees it. Throttled to summaries.intervalMinutes; never overlaps itself.
 */
async function cycle({ log = () => {}, rebuild = null, force = false } = {}) {
  if (cycling) return { skipped: 'a cycle is already running' };
  const every = Math.max(1, Number(settings().intervalMinutes) || 30) * 60000;
  if (!force && Date.now() - lastCycle < every) return { skipped: 'interval' };
  if (!config.mod('summaries') && !config.mod('roles')) return { skipped: 'modules off' };
  cycling = true; lastCycle = Date.now();
  const out = {};
  try {
    if (config.mod('summaries')) {
      if (engine.effective().kind === 'none') out.summaries = { skipped: 'engine off — set Settings › Model engine' };
      else out.summaries = await run({ log });
    }
    if (config.mod('roles')) out.roles = await require('./roles').build({ log });
    if (rebuild && out.summaries && out.summaries.done > 0) { try { await rebuild(); } catch (e) { log('summaries: index rebuild failed: ' + e.message); } }
  } catch (e) { out.error = e.message; log('intel cycle error: ' + e.message); }
  finally { cycling = false; }
  return out;
}

/** `relaymote summarize [--cap N] [--budget-min M] [--days D] [--dry-run]` */
async function cli(argv = []) {
  const opt = f => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
  if (argv[0] === 'help' || argv.includes('--help')) return console.log('relaymote summarize [--cap N] [--budget-min M] [--days D] [--dry-run]   5-line overview per changed session (engine: Settings › Model engine)');
  const ix = await require('./projects').build({ digests: true });
  const r = await run({ index: ix, cap: opt('--cap'), budgetMin: opt('--budget-min'), days: opt('--days'), dry: argv.includes('--dry-run'),
    log: m => console.error(m) });
  if (!argv.includes('--dry-run') && r && r.done > 0) { try { await require('./projects').build({}); } catch {} }
  console.log(JSON.stringify(r, null, 2));
  if (r && r.error) process.exitCode = 2;
}

module.exports = { DIR, ALL, LAST_RUN, FAILURES, KEYS, SCHEMA, MIN_DELTA, pick, buildInput, trimBlocks, run, attach, get, consolidate,
  loadFailures, noteFailure, clearFailure, inCooloff, cooloffHours, buildOpts, cycle, cli, prompt };
