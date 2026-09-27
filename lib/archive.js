// archive.js — which sessions are safe to ARCHIVE, and why. It never archives anything.
//
// The list is for the user: a master or the Conductor shows it, and archives (baton_archive) only
// what the user approves. Writes <data>/conductor/ARCHIVE-CANDIDATES.md with per-reason sections,
// ready calls split per reason (so the user can approve one group at a time) and a held-back list.
//
// SAFETY GATE — a session must pass ALL of these to be listed at all:
//   * a Desktop sidebar row, not already archived          (only those can be archived)
//   * not running, not unread, not awaiting input          (unseen work is never archived away; live
//                                                            state UNKNOWN holds it back too)
//   * its last turn ENDED (pending === 'ended')            (asks / open / unanswered / buried all mean
//                                                            somebody still owes an answer)
//   * not a master with a live (non-archived) child        (its fleet still reports to it)
//   * idle more than idleDays (default 14)
//
// REASONS (a listed session has at least one; every one that applies is shown):
//   SUPERSEDED   a NEWER live session in the same project whose title(+tags) overlap >= 0.6 (Jaccard)
//                AND whose digest names this one (id prefix or title) or repeats its deliverable
//                (>= 3 distinctive title words).
//   WORKER-DONE  spawned by a master that is archived, gone or long ended — or its own last message is
//                a completion report.
//   DISPOSABLE   a throwaway title (probe / test / scratch / "old …" / "resume: …"); patterns in config.
//   CONTEXT-FULL-AND-ENDED  context full (estimate or recorded overflow) and the turn ended.
'use strict';
const fs = require('fs');
const path = require('path');
const config = require('./config');

const OUT_MD = () => path.join(config.DATA, 'conductor', 'ARCHIVE-CANDIDATES.md');
const DAY = 86400000;
const DIGEST_TAIL = 200000;

const DEFAULT_DISPOSABLE = [
  '^\\s*old[\\s\\-–—:]+(?=\\w)', '^\\s*resume:', '^\\s*resuming\\b', '^\\s*probe\\b', '^\\s*test\\b', '^\\s*testing\\b',
  '^\\s*tmp\\b', '^\\s*temp\\b', '^\\s*scratch\\b', '^\\s*trial\\b', '^\\s*experiment\\b', '^\\s*delete me\\b', '^\\s*untitled\\b',
  '^\\s*\\(untitled\\)', '^\\s*check\\b.{0,12}$', '^\\s*ping\\b',
];
const DEFAULT_COMPLETION = [
  '\\breported (back )?to (the )?master\\b', '\\breport(ed)? to local_', '\\btask (is )?complete\\b', '\\bwork (is )?(complete|done|finished)\\b',
  '\\ball (four|three|two|\\d+) (parts|items|tasks) (are )?(done|complete)\\b', '\\bnothing (further|else) (to do|remains|is pending)\\b',
  '\\bhanded (it )?(over|back)\\b', '\\bverified and (done|complete)\\b', '\\bdone and verified\\b', '\\bno further action\\b',
  '\\bclosing out\\b', '\\bsigning off\\b',
];
const STOP = new Set(('the a an and or of to in on for with is are was be it this that my me we you can please do does did fix make add new '
  + 'error issue problem bug from into about there here what which how when why some any not no yes also just like then than have has had '
  + 'will would should could need want get got session sessions master slave worker conductor claude build update check work task '
  + 'project part parts step steps chip lane agent report v2 v3 final draft old').split(' '));

const LABEL = { superseded: 'SUPERSEDED', 'worker-done': 'WORKER-DONE', disposable: 'DISPOSABLE', 'context-full': 'CONTEXT-FULL-AND-ENDED' };
const ORDER = ['superseded', 'worker-done', 'disposable', 'context-full'];

function settings(over = {}) {
  const a = { ...config.DEFAULTS.archive, ...((config.get() || {}).archive || {}), ...over };
  const rx = (list, dflt) => (Array.isArray(list) ? list : dflt).map(s => { try { return new RegExp(s, 'i'); } catch { return null; } }).filter(Boolean);
  return { ...a, idleDays: Number(a.idleDays) > 0 ? Number(a.idleDays) : 14, disposable: rx(a.disposablePatterns, DEFAULT_DISPOSABLE),
    completion: rx(a.completionPatterns, DEFAULT_COMPLETION) };
}

function words(text) { return String(text || '').toLowerCase().match(/[a-z0-9][a-z0-9_.\-]+/g) || []; }
function tokens(text) { return new Set(words(text).filter(t => t.length >= 3 && !STOP.has(t))); }
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}
const ms = s => { const t = Date.parse(s || ''); return isNaN(t) ? 0 : t; };
const short = id => String(id || '').replace(/^local_/, '').slice(0, 8);

function defaultDigestText(s) {
  try { const t = require('./digests').read(s.id, DIGEST_TAIL); if (t) return { text: t.toLowerCase(), source: 'digest' }; } catch {}
  return { text: '', source: null };
}

/** Live flags: the Desktop snapshot row wins over the index copy (which can be 30 minutes old). */
function liveOf(s, snapById) {
  const row = snapById && snapById.get(s.id);
  if (row) return { running: !!row.running, awaiting: !!row.awaiting, unread: !!row.unread, archived: !!(row.isArchived || s.archived), known: true };
  const known = s.running != null && s.awaiting != null && s.unread != null;
  return { running: !!s.running, awaiting: !!s.awaiting, unread: !!s.unread, archived: !!s.archived, known };
}

function liveChildren(s, S) { return (s.children || []).filter(c => S[c] && !S[c].archived); }

/** Why this session may NOT be listed — '' when it passes the gate. */
function blocked(s, S, live, cfg, now) {
  if (!s.in_sidebar || live.archived) return 'not an archivable sidebar row';
  if (!live.known) return 'live state unknown (no Desktop snapshot row) — never archived on a guess';
  if (live.running) return 'running';
  if (live.unread) return 'unread';
  if (live.awaiting) return 'awaiting input';
  if (s.pending !== 'ended') {
    return { buried: 'has a buried question', asks: 'still asking', open: 'ended stating work still to do',
      unanswered: 'a prompt sits unanswered', running: 'running' }[s.pending] || `state ${s.pending || 'unknown'}`;
  }
  const kids = liveChildren(s, S);
  if (kids.length) return `master with ${kids.length} live child${kids.length === 1 ? '' : 'ren'}`;
  const idle = s.last ? (now - ms(s.last)) / DAY : s.age_days;
  if (idle == null || idle <= cfg.idleDays) return `active ${idle == null ? '?' : Math.floor(idle)} d ago`;
  return '';
}

function supersededBy(s, S, cfg, digestText) {
  const mine = new Set([...tokens(s.title), ...(s.tags || []).filter(t => !STOP.has(t))]);
  if (!mine.size) return null;
  const sid = short(s.id), head = String(s.title || '').slice(0, 40).toLowerCase();
  let best = null;
  for (const o of Object.values(S)) {
    if (o.id === s.id || o.archived || !o.in_sidebar) continue;
    if ((o.project || '') !== (s.project || '') || !o.last || !s.last) continue;
    if (ms(o.last) <= ms(s.last)) continue;                  // only a NEWER session can supersede
    const theirs = new Set([...tokens(o.title), ...(o.tags || []).filter(t => !STOP.has(t))]);
    const j = jaccard(mine, theirs);
    if (j < cfg.supersedeJaccard) continue;
    const d = digestText(o);
    if (!d.text) continue;
    let why = '';
    if ((sid && d.text.includes(sid)) || (head.length >= 8 && d.text.includes(head))) why = 'names it';
    else {
      const seen = new Set(words(d.text));
      let n = 0;
      for (const t of tokens(s.title)) if (seen.has(t)) n++;
      if (n >= cfg.mentionMinTokens) why = 'repeats the same deliverable';
    }
    if (!why) continue;
    if (!best || ms(o.last) > ms(best.o.last)) best = { o, j, why: `its ${d.source} ${why}` };
  }
  return best;
}

function masterState(s, S, cfg, now) {
  const p = s.spawned_from;
  if (!p) return null;
  const m = S[p];
  if (!m) return 'its master no longer exists';
  if (m.archived) return `its master ${short(m.id)} is archived`;
  const age = m.last ? (now - ms(m.last)) / DAY : m.age_days;
  if (m.pending === 'ended' && (age || 0) > cfg.masterEndedDays) return `its master ${short(m.id)} ended ${Math.floor(age)} d ago`;
  return null;
}

function reasonsFor(s, S, cfg, digestText, now) {
  const out = [];
  const sup = supersededBy(s, S, cfg, digestText);
  if (sup) out.push({ code: 'superseded', why: `superseded by ${sup.o.id} "${String(sup.o.title).slice(0, 50)}" (overlap ${sup.j.toFixed(2)}, ${sup.why}, last ${String(sup.o.last).slice(0, 16)})` });
  if (s.spawned_from) {
    const ms_ = masterState(s, S, cfg, now);
    const tail = String(s.final_text || '').slice(-400);
    if (ms_) out.push({ code: 'worker-done', why: `worker — ${ms_}` });
    else if (cfg.completion.some(rx => rx.test(tail))) out.push({ code: 'worker-done', why: 'worker whose last message is a completion report' });
  }
  if (cfg.disposable.some(rx => rx.test(s.title || ''))) out.push({ code: 'disposable', why: `disposable title "${String(s.title).slice(0, 60)}"` });
  if ((s.ctx_flag === 'FULL' || (s.context_exceeded || 0) > 0) && s.pending === 'ended') {
    out.push({ code: 'context-full', why: `context full (~${Math.floor((s.est_ctx_tokens || 0) / 1000)}k${s.context_exceeded ? `, overflowed ×${s.context_exceeded}` : ''}`
      + `${s.ctx_verified ? '' : ', estimate only'}) and ended` });
  }
  out.sort((a, b) => ORDER.indexOf(a.code) - ORDER.indexOf(b.code));
  return out;
}

/**
 * collect({ index, snapshot, days, now, digestText, settings }) -> { rows: [{ s, reasons }], held: [{ s, why }], cfg }.
 * Pure given its inputs; index defaults to the on-disk project index, snapshot to the Desktop snapshot.
 */
function collect(deps = {}) {
  const now = deps.now || Date.now();
  const cfg = settings({ ...(deps.settings || {}), ...(deps.days != null ? { idleDays: deps.days } : {}) });
  const ix = deps.index !== undefined ? deps.index : (() => { try { return require('./projects').read(); } catch { return null; } })();
  if (!ix || !ix.sessions) return { rows: [], held: [], cfg, error: 'NO_INDEX' };
  let snap = deps.snapshot;
  if (snap === undefined) { try { snap = require('./desktop').loadSnapshot(); } catch { snap = null; } }
  const snapById = snap && Array.isArray(snap.sessions) ? new Map(snap.sessions.map(r => [r.sessionId, r])) : null;
  const digestText = deps.digestText || defaultDigestText;
  const S = ix.sessions;
  const rows = [], held = [];
  for (const s of Object.values(S)) {
    if (!s || !s.in_sidebar || s.archived) continue;
    const live = liveOf(s, snapById);
    const b = blocked(s, S, live, cfg, now);
    if (b) {
      if (!b.startsWith('active ') && b !== 'not an archivable sidebar row') held.push({ s, why: b });
      continue;
    }
    const reasons = reasonsFor(s, S, cfg, digestText, now);
    if (reasons.length) rows.push({ s, reasons });
  }
  const idle = s => (s.last ? (now - ms(s.last)) / DAY : s.age_days || 0);
  rows.sort((a, b) => ORDER.indexOf(a.reasons[0].code) - ORDER.indexOf(b.reasons[0].code) || idle(b.s) - idle(a.s));
  held.sort((a, b) => idle(b.s) - idle(a.s));
  const protectedCount = snapById ? [...snapById.values()].filter(r => !r.isArchived && (r.unread || r.awaiting)).length
    : Object.values(S).filter(s => s.in_sidebar && !s.archived && (s.unread || s.awaiting)).length;
  return { rows, held, cfg, now, protectedCount, live: Object.values(S).filter(s => s.in_sidebar && !s.archived).length };
}

function readyCalls(rows, now) {
  const day = new Date(now).toISOString().slice(0, 10);
  const by = {};
  for (const r of rows) (by[r.reasons[0].code] = by[r.reasons[0].code] || []).push(r.s.id);
  return ORDER.filter(k => by[k]).map(k => ({ reason: LABEL[k], session_ids: by[k],
    call: `baton_archive(session_ids=[${by[k].map(i => JSON.stringify(i)).join(', ')}], reason="${LABEL[k].toLowerCase()} — approved by the user ${day}")` }));
}

function markdown(res) {
  const { rows, held, cfg, now } = res;
  const by = {};
  for (const r of rows) (by[r.reasons[0].code] = by[r.reasons[0].code] || []).push(r);
  const L = [`# Archive candidates — ${rows.length} of ${res.live} live sidebar sessions, idle > ${cfg.idleDays} days`,
    `built ${new Date(now).toISOString().slice(0, 16)} UTC by Relaymote (lib/archive.js).`, '',
    '**Show the user the list first; archive only what they approve.** Nothing here has been archived. '
    + 'Archiving stops the session and cleans its worktree; it can be reopened from Archived.', '',
    'Counts by primary reason: ' + (ORDER.filter(k => by[k]).map(k => `${LABEL[k]} ${by[k].length}`).join(' · ') || 'none'), ''];
  for (const k of ORDER) {
    if (!by[k]) continue;
    L.push(`## ${LABEL[k]} (${by[k].length})`);
    for (const { s, reasons } of by[k]) {
      const idle = s.last ? Math.floor((now - ms(s.last)) / DAY) : s.age_days;
      L.push(`- **${s.id}** "${String(s.title).slice(0, 64)}" [${s.group || '-'} / ${s.project || '-'}] idle ${idle} d, `
        + `${s.turns || 0} turns, ~${Math.floor((s.est_ctx_tokens || 0) / 1000)}k ${s.ctx_flag || ''}, state ${s.pending}`);
      for (const r of reasons) L.push(`    - ${LABEL[r.code]}: ${r.why}`);
      if (s.final_text) L.push(`    - ended with: ${String(s.final_text).replace(/\s+/g, ' ').slice(-150)}`);
    }
    L.push('');
  }
  L.push('## Ready calls (after the user approves — one per reason, so each group can be approved on its own)', '```');
  const calls = readyCalls(rows, now);
  for (const c of calls) L.push(c.call);
  if (!calls.length) L.push('(nothing to archive)');
  L.push('```', '');
  if (held.length) {
    L.push(`## Held back (${held.length}) — old enough, but not safe to archive`);
    for (const { s, why } of held.slice(0, 40)) L.push(`- ${s.id} "${String(s.title).slice(0, 56)}" — ${why}`);
    if (held.length > 40) L.push(`- … and ${held.length - 40} more`);
  }
  return L.join('\n') + '\n';
}

/**
 * The tool/CLI entry: collect, write ARCHIVE-CANDIDATES.md, and return the JSON shape baton_archive_candidates
 * has always returned ({ count, candidates:[{ sessionId, title, group, idleDays, reason }], protectedFromArchiving, note })
 * plus reasons, the held-back list, the ready calls and the report path.
 */
function report(deps = {}) {
  const res = collect(deps);
  if (res.error) return { error: res.error, count: 0, candidates: [] };
  const md = markdown(res);
  const file = deps.file || OUT_MD();
  if (deps.write !== false) {
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file + '.tmp', md); fs.renameSync(file + '.tmp', file); } catch {}
  }
  const idleOf = s => s.last ? +((res.now - ms(s.last)) / DAY).toFixed(1) : s.age_days;
  return {
    count: res.rows.length, idleDays: res.cfg.idleDays,
    candidates: res.rows.map(({ s, reasons }) => ({ sessionId: s.id, title: s.title, group: s.group || null, project: s.project || null,
      idleDays: idleOf(s), reason: reasons.map(r => LABEL[r.code]).join(', '), reasons: reasons.map(r => ({ code: LABEL[r.code], why: r.why })) })),
    protectedFromArchiving: res.protectedCount,
    heldBack: res.held.slice(0, 40).map(({ s, why }) => ({ sessionId: s.id, title: s.title, idleDays: idleOf(s), why })),
    readyCalls: readyCalls(res.rows, res.now),
    report: deps.write === false ? null : file,
    note: 'Nothing was archived. Show the user the list first; archive only what they approve (baton_archive with the ids they pick). '
      + 'Archiving stops the session and cleans its worktree.',
  };
}

module.exports = { collect, report, markdown, readyCalls, settings, tokens, jaccard, LABEL, ORDER, DEFAULT_DISPOSABLE, DEFAULT_COMPLETION, OUT_MD };
