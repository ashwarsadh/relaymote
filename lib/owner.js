'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// The owner index lists which session owns which topic. settings.ownerIndex points at an external
// one; blank means Relaymote's own (lib/projects.js, <data>/conductor). A missing index makes every
// lookup below return a harmless "no index" result instead of throwing.
function ownerIndexDir() {
  return String(require('./config').get().ownerIndex || '').trim() || require('./projects').DIR;
}
function indexPaths() {
  const dir = ownerIndexDir();
  if (!dir) return null;
  return {
    dir,
    json: path.join(dir, 'index.json'),
    md: path.join(dir, 'INDEX.md'),
    roles: process.env.RELAYMOTE_ROLES_JSON || path.join(dir, 'roles.json'),
  };
}

const KEEPER_RE = /\bkeeper\b|\bkeeps?\b.{0,40}\b(skill|skills|true|current|accurate|honest)\b|\bkeep\b.{0,40}\bskills?\b|\bskills?\b.{0,20}\b(keeper|true|current|up to date)\b|master of masters|\bconductor\b.{0,20}(routing|index|master)|\bindex\b.{0,15}\bbuilder\b/i;

const SCRATCH_RE = /\bscratch\b|\btest session\b|\btooling test\b|\bregression test scratch\b/i;

const STOP = new Set(('the a an and or of to in on for with is are be was were it its this that they them'
  + ' i you we he she his her our your their not no yes do does did done shall should would could can'
  + ' will make made making use used using new old fix fixed fixing please also can t dont don why how'
  + ' what when where which who whom about from into over under again more most some any all each'
  + ' session sessions message messages send sending sent').split(/\s+/));

const tokens = (s) => String(s || '').toLowerCase().match(/[a-z0-9_.-]{2,}/g) || [];
const stem = (t) => (t.length > 4 && t.endsWith('s') && !t.endsWith('ss')) ? t.slice(0, -1) : t;
const contentTokens = (s) => tokens(s).flatMap(t => t.includes('-') ? [t, ...t.split('-')] : [t])
  .filter(t => !STOP.has(t) && t.length > 2).map(stem);

function readIndex() {
  const p = indexPaths();
  if (!p) return null;
  try { return JSON.parse(fs.readFileSync(p.json, 'utf8')); } catch {}
  try {
    const md = fs.readFileSync(p.md, 'utf8');
    const sessions = {};
    for (const line of md.split(/\r?\n/)) {
      const m = /^-\s+([0-9a-f]{8})\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/.exec(line);
      if (!m) continue;
      const id = (/#(local_[0-9a-f-]{36})/.exec(line) || [])[1];
      if (!id) continue;
      sessions[id] = { id, title: m[2], group: m[3], tags: (line.match(/#[a-z0-9_-]+/gi) || []).map(t => t.slice(1)) };
    }
    return { sessions, projects: {}, relaymote_masters: {}, _from: 'INDEX.md' };
  } catch {}
  return null;
}

const KEEPER_TOPIC_RE = /\b(skills?|skill file|SKILL\.md|documentation|docs?)\b[\s\S]{0,60}\b(update|updating|edit|correct|accurate|true|current|stale|wrong|add|maintain)\b|\b(update|edit|correct|fix|add to|maintain)\b[\s\S]{0,40}\b(skills?|SKILL\.md|docs?|documentation)\b|\bkeep\b[\s\S]{0,40}\b(skills?|docs?)\b/i;

let _roles = { mtime: 0, sessions: {}, idf: null };
function readRoles() {
  const p = indexPaths();
  if (!p) return {};
  try {
    const m = fs.statSync(p.roles).mtimeMs;
    if (m !== _roles.mtime) _roles = { mtime: m, sessions: JSON.parse(fs.readFileSync(p.roles, 'utf8')).sessions || {}, idf: null };
    return _roles.sessions;
  } catch { return {}; }
}

const strongText = (rec) => [...(rec.owns_topics || []), ...Object.values(rec.open_goals || {})].join(' ');

function idfFor(roles) {
  if (roles === _roles.sessions && _roles.idf) return _roles.idf;
  const df = new Map();
  const recs = Object.values(roles);
  for (const r of recs) for (const t of new Set(contentTokens(strongText(r) + ' ' + (r.role || '')))) df.set(t, (df.get(t) || 0) + 1);
  const N = recs.length || 1;
  const idf = (t) => Math.log((N + 1) / ((df.get(t) || 0) + 1)) / Math.log(N + 1);
  if (roles === _roles.sessions) _roles.idf = idf;
  return idf;
}

function phraseHit(phrase, want) {
  const w = [...new Set(contentTokens(phrase))];
  const n = w.filter(t => want.tokens.has(t)).length;
  return { n, len: w.length, full: w.length > 0 && n >= Math.max(1, Math.ceil(w.length / 2)) };
}

function scoreRole(rec, want, topic, roles) {
  const idf = idfFor(roles || readRoles());
  const why = [];
  const owns = new Set(contentTokens((rec.owns_topics || []).join(' ')));
  const goals = new Set(contentTokens(Object.values(rec.open_goals || {}).join(' ')));
  const weak = new Set(contentTokens(rec.role));
  let s1 = 0, s3 = 0, s2 = 0, hits = 0;
  for (const t of want.tokens) {
    if (owns.has(t)) { s1 += 16 * idf(t); hits++; }
    else if (goals.has(t)) { s3 += 10 * idf(t); hits++; }
    else if (weak.has(t)) { s2 += 6 * idf(t); hits++; }
  }
  let score = Math.min(s1, 64) + Math.min(s3, 30) + Math.min(s2, 18);
  for (const ph of rec.owns_topics || []) if (phraseHit(ph, want).full) why.push(`DB owns "${ph}"`);
  for (const [g, title] of Object.entries(rec.open_goals || {})) if (phraseHit(title, want).n >= 2) why.push(`DB open goal ${g}`);
  if (s2) why.push('topic words in DB role');
  const topicLc = String(topic || '').toLowerCase();
  for (const g of [...new Set([...(rec.owns_goals || []), ...Object.keys(rec.open_goals || {})])]) {
    if (g && new RegExp('\\b' + String(g).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(topicLc)) { score += 40; hits++; why.push('DB owns goal ' + g); }
  }
  for (const f of rec.owns_files || []) {
    const base = String(f).toLowerCase().split(/[\/]/).pop();
    if (base && base.length > 3 && topicLc.includes(base)) { score += 20; hits++; why.push('DB owns file ' + base); }
  }
  const raw = new Set(tokens(topic).filter(t => !STOP.has(t) && t.length > 2).map(stem));
  for (const ph of rec.not_owns || []) {
    const w = [...new Set(tokens(ph).filter(t => !STOP.has(t) && t.length > 2).map(stem))];
    const h = { n: w.filter(t => raw.has(t)).length, len: w.length };
    if ((h.len === 1 && h.n === 1) || (h.n >= 2 && h.n >= Math.ceil(h.len * 2 / 3))) { score -= 40; why.push(`DB: does NOT own "${ph}"`); }
  }
  return { score: Math.round(score), hits, why };
}

function disqualify(s) {
  if (s.archived) return 'archived';
  if (s.in_sidebar === false) return 'no Desktop row (headless or deleted) — it cannot receive a message';
  if (s.conductor) return 'the Conductor — it routes, it owns no lane';
  if (KEEPER_RE.test(String(s.title || ''))) return 'keeper/skill-owner — owns a document, not a lane';
  if (s.skills && Object.keys(s.skills).length && /\b(skill|doc|documentation|memory|index)\b/i.test(String(s.title || ''))) {
    return 'maintains a skill/doc';
  }
  return null;
}

function scoreSession(s, want, rec, topic) {
  const proj = String(s.project || '').toLowerCase();
  const group = String(s.group || '').toLowerCase();
  let score = 0;
  const why = [];

  if (want.project && proj && proj === want.project) { score += 50; why.push('project=' + proj); }
  else if (want.project && proj && (proj.includes(want.project) || want.project.includes(proj))) { score += 30; why.push('project~' + proj); }

  if (want.group && group && group === want.group) { score += 12; why.push('group=' + s.group); }

  let hits = 0;
  if (rec) {
    const r = scoreRole(rec, want, topic, want.roles);
    score += r.score; hits += r.hits; why.push(...r.why);
  }
  const hay = new Set(contentTokens([s.title, (s.tags || []).join(' '), s.first_prompt, s.summary].join(' ')));
  let th = 0;
  for (const t of want.tokens) if (hay.has(t)) th++;
  if (th) { score += th * (rec ? 3 : 9); hits += th; why.push(th + ' topic word' + (th === 1 ? '' : 's') + ' in title/tags' + (rec ? ' (tie-break)' : '')); }

  if (score && !hits && !want.projectExplicit) score = Math.min(score, 18);

  // learned signals (lib/aliases.js): alias keywords, past dispatches, scheduled tasks, transcript hits
  const sig = want.signals;
  if (sig) {
    const a = Math.max(sig.alias.get(proj) || 0, sig.alias.get(group) || 0);
    if (a) { score += 25 * a; hits++; why.push('alias → ' + (sig.alias.get(proj) ? s.project : s.group)); }
    const l = sig.learned.get(s.id);
    if (l) { score += Math.min(40, 6 * l); hits++; why.push(`learned from past dispatches (+${Math.min(40, 6 * l)})`); }
    const t = sig.taskOwners.get(proj);
    if (t) { score += 10; hits++; why.push('its project owns scheduled task "' + t + '"'); }
    const g = sig.grep && sig.grep.get(s.id);
    if (g) { const b = Math.min(45, Math.round(12 * Math.log2(1 + g))); score += b; hits++; why.push(`${g} transcript hit${g === 1 ? '' : 's'} for the pattern (+${b})`); }
  }

  if (s.is_master || s.baton_master || (rec && rec.is_master)) { score += 8; why.push('master of its lane'); }
  if (SCRATCH_RE.test(String(s.title || ''))) { score -= 25; why.push('scratch/test session'); }

  const ageDays = Number(s.age_days);
  if (Number.isFinite(ageDays)) {
    if (ageDays <= 2) { score += 6; why.push('active in the last 2 days'); }
    else if (ageDays > 21) { score -= 6; why.push('quiet for ' + Math.round(ageDays) + ' days'); }
  }
  if (s.running) { score += 3; why.push('running'); }

  return { score, why };
}

function projectFromTopic(topic, ix) {
  const t = ' ' + String(topic || '').toLowerCase().replace(/[^a-z0-9_. -]+/g, ' ') + ' ';
  const names = [...new Set(Object.values(ix.sessions || {})
    .map(s => String(s.project || '').toLowerCase()).filter(Boolean))].sort((a, b) => b.length - a.length);
  for (const n of names) {
    const k = n.toLowerCase();
    if (k.length < 3) continue;
    if (t.includes(' ' + k + ' ') || t.includes(' ' + k + "'s ")) return k;
  }
  return null;
}

const bareId = id => String(id || '').toLowerCase().replace(/^(local_|cli_)/, '');

/** Sessions the topic NAMES by id (full uuid, local_/cli_ id, or an 8-hex prefix), in order of mention. */
function namedSessions(topic, ix, exclude) {
  const out = [];
  const all = Object.values(ix.sessions || {});
  for (const m of String(topic || '').matchAll(/(?:local_|cli_|(?<![0-9a-z_]))([0-9a-f]{8})(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?(?![0-9a-z])/gi)) {
    const pre = m[1].toLowerCase();
    for (const s of all) {
      if (s.id === exclude || out.includes(s)) continue;
      if (bareId(s.id).startsWith(pre) || String(s.cli || '').toLowerCase().startsWith(pre)) out.push(s);
    }
  }
  return out;
}

const TASK_GENERIC = new Set(['console', 'window', 'windows', 'popup', 'popups', 'flicker', 'flickering', 'flash', 'flashing', 'cmd', 'task',
  'tasks', 'scheduled', 'startup', 'logon', 'cron', 'crontab', 'launchd']);

/** Learned routing signals for a topic: alias boosts, past dispatches, scheduled-task owners, transcript hits. */
function signals(topic, ix, opts = {}) {
  const out = { alias: new Map(), aliasFired: [], learned: new Map(), taskOwners: new Map(), tasks: [], grep: opts.grepHits || null };
  let A = null;
  try { A = require('./aliases'); } catch { return out; }
  const b = A.boosts(topic);
  out.alias = b.byTarget; out.aliasFired = b.fired;
  out.learned = A.learned(topic);
  const q = new Set(A.tokens(topic));
  const generic = [...q].some(t => TASK_GENERIC.has(t));
  for (const t of ((ix.os_tasks && ix.os_tasks.rows) || [])) {
    if (!t || t.error) continue;
    const ov = new Set(A.tokens(`${t.name} ${t.action} ${t.owner || ''}`).filter(x => x.length >= 4 && q.has(x) && !TASK_GENERIC.has(x)));
    const score = ov.size + (t.console && generic ? 2 : 0);
    if (!score) continue;
    out.tasks.push({ score, name: t.name, status: t.status, fires: t.fires, console: !!t.console, owner: t.owner || null, action: String(t.action || '').slice(0, 160) });
    if (t.owner && ov.size) out.taskOwners.set(String(t.owner).toLowerCase(), t.name);
  }
  out.tasks.sort((x, y) => y.score - x.score);
  out.tasks = out.tasks.slice(0, 10);
  return out;
}

function resolve(topic, opts = {}) {
  const ix = readIndex();
  if (!ix) return { ok: false, noIndex: true, refusal: 'no owner index yet (Relaymote builds one every 30 minutes; relaymote_projects refresh:true builds it now) — cannot resolve an owner' };

  // A session the user NAMED always wins: no score can outrank "send it to <that id>".
  const named = opts.session ? namedSessions(String(opts.session), ix, opts.exclude) : namedSessions(topic, ix, opts.exclude);
  if (named.length) {
    const s = named[0];
    const bad = disqualify(s);
    return { ok: true, explicit: true, owner: s.id, title: s.title, project: s.project, group: s.group, score: null,
      why: ['named explicitly' + (opts.session ? '' : ' in the topic') + ' — an explicit id always wins'],
      warning: bad ? `the named session is ${bad}` : undefined, deliverable: s.in_sidebar !== false,
      alsoNamed: named.slice(1, 4).map(x => ({ id: x.id, title: x.title })), candidates: [] };
  }

  const explicit = String(opts.project || '').toLowerCase() || null;
  const want = {
    tokens: new Set(contentTokens(topic)),
    project: explicit || projectFromTopic(topic, ix),
    group: String(opts.group || '').toLowerCase() || null,
    projectExplicit: !!explicit,
    signals: signals(topic, ix, opts),
  };

  const keeperTopic = KEEPER_TOPIC_RE.test(String(topic || ''));

  const roles = opts.roles || readRoles();
  want.roles = roles;
  const rows = [];
  for (const s of Object.values(ix.sessions || {})) {
    if (opts.exclude && s.id === opts.exclude) continue;
    const bad = disqualify(s);
    if (bad && !(keeperTopic && bad !== 'archived')) { rows.push({ id: s.id, title: s.title, excluded: bad }); continue; }
    let { score, why } = scoreSession(s, want, roles[s.id] || null, topic);
    if (keeperTopic && bad) { score += 25; why = why.concat('keeper, and this topic IS skill/doc upkeep'); }
    if (score <= 0) continue;
    rows.push({ id: s.id, title: s.title, project: s.project, group: s.group, score, why, role: roles[s.id] ? roles[s.id].role : null });
  }

  const ranked = rows.filter(r => r.score > 0).sort((a, b) => b.score - a.score);
  const best = ranked[0] || null;
  const runnerUp = ranked[1] || null;

  const MIN = 30;
  if (!best || best.score < MIN) {
    return {
      ok: false,
      noOwner: true,
      project: want.project,
      spawn: {
        why: best ? `best candidate "${best.title}" scored ${best.score}, under the bar of ${MIN}`
                  : 'nothing in the index matched this topic at all',
        project: want.project || null,
        group: want.project ? groupForProject(ix, want.project) : null,
        hint: 'relaymote_spawn with this project/group, then send the topic verbatim to the new session',
      },
      candidates: ranked.slice(0, 5),
      excluded: rows.filter(r => r.excluded).slice(0, 5),
      ...learnedOut(want.signals),
    };
  }

  // AMBIGUOUS: the best sessions of two DIFFERENT projects score within 20% of each other and the
  // topic did not name a project. Refuse to guess — the caller decides from the wording, passes
  // `project`, names the session id, or asks the user one line.
  const perProject = new Map();
  for (const r of ranked) { const p = r.project || '(no folder)'; if (!perProject.has(p)) perProject.set(p, r); }
  const [p1, p2] = [...perProject.values()];
  if (!want.project && !want.group && !opts.allowAmbiguous && p1 && p2 && p2.score >= 0.8 * p1.score) {
    return {
      ok: false, ambiguous: true,
      between: [p1, p2].map(r => ({ project: r.project || '(no folder)', id: r.id, title: r.title, score: r.score })),
      refusal: `AMBIGUOUS between "${p1.project || '(no folder)'}" (${p1.score}) and "${p2.project || '(no folder)'}" (${p2.score}) — decide from the wording and call again with project:"…", name the session id, or ask the user one line.`,
      candidates: ranked.slice(0, 5),
      ...learnedOut(want.signals),
    };
  }

  return {
    ok: true,
    owner: best.id,
    title: best.title,
    role: best.role || null,
    project: best.project,
    group: best.group,
    score: best.score,
    why: best.why,
    runnerUp: runnerUp ? { id: runnerUp.id, title: runnerUp.title, score: runnerUp.score } : null,
    close: !!(runnerUp && best.score - runnerUp.score <= 8),
    candidates: ranked.slice(0, 5),
    ...learnedOut(want.signals),
  };
}

function learnedOut(sig) {
  if (!sig) return {};
  const o = {};
  if (sig.aliasFired.length) o.aliases = sig.aliasFired;
  if (sig.learned.size) o.learned = Object.fromEntries([...sig.learned].sort((a, b) => b[1] - a[1]).slice(0, 5));
  if (sig.tasks.length) o.scheduledTasks = sig.tasks;
  return o;
}

/**
 * WHO TOUCHED THIS? Grep every transcript for a distinctive pattern and rank sessions by HIT COUNT
 * (a resumed session sums its whole chain). A hit is evidence a session touched the thing; a miss is a
 * fact about the pattern — it proves presence, never absence.
 */
async function whoTouched(pattern, opts = {}) {
  const g = await require('./transcripts').grep(pattern, opts);
  if (!g.ok) return g;
  const ix = readIndex() || { sessions: {} };
  const byCli = new Map();
  for (const s of Object.values(ix.sessions || {})) for (const c of (s.cli_chain && s.cli_chain.length ? s.cli_chain : [s.cli])) if (c) byCli.set(String(c).toLowerCase(), s);
  const per = new Map(), unmapped = [];
  for (const h of g.hits) {
    const s = byCli.get(String(h.uuid).toLowerCase());
    if (!s) { unmapped.push({ file: h.path, hits: h.hits }); continue; }
    const e = per.get(s.id) || { id: s.id, title: s.title, project: s.project, group: s.group, in_sidebar: s.in_sidebar !== false, last_user_ts: s.last_user_ts || null, hits: 0 };
    e.hits += h.hits; per.set(s.id, e);
  }
  const ranked = [...per.values()].sort((a, b) => b.hits - a.hits);
  return { ok: true, pattern: g.pattern, sessions: ranked.slice(0, opts.limit || 25), unmapped: unmapped.slice(0, 10), scanned: g.scanned, of: g.of,
    truncated: g.truncated, ms: g.ms, hitsById: new Map(ranked.map(r => [r.id, r.hits])),
    note: ranked.length ? g.note : 'No transcript matches — that is a fact about the PATTERN, not proof that nobody touched it.' };
}

/** resolve(), plus a transcript-grep ranking signal when opts.grep (a distinctive pattern) is given. */
async function resolveWithGrep(topic, opts = {}) {
  if (!opts.grep) return resolve(topic, opts);
  const w = await whoTouched(opts.grep, { deadlineMs: opts.grepDeadlineMs || 20000 });
  const r = resolve(topic, { ...opts, grepHits: w.ok ? w.hitsById : null });
  r.grep = w.ok ? { pattern: w.pattern, top: w.sessions.slice(0, 8), scanned: w.scanned, of: w.of, truncated: w.truncated, note: w.note } : { error: w.error };
  return r;
}

function groupForProject(ix, project) {
  const counts = Object.create(null);
  for (const s of Object.values(ix.sessions || {})) {
    if (String(s.project || '').toLowerCase() !== project || !s.group || s.archived) continue;
    counts[s.group] = (counts[s.group] || 0) + 1;
  }
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return top ? top[0] : null;
}

function check(topic, targetId, opts = {}) {
  const r = opts.resolved || resolve(topic, opts);
  if (r.ok && r.owner === targetId) return { ok: true, allow: true, owner: r.owner, why: r.why, explicit: r.explicit || undefined };
  if (r.ambiguous) {
    const pick = r.between.find(b => b.id === targetId || String(b.project).toLowerCase() === String(((readIndex() || { sessions: {} }).sessions[targetId] || {}).project || '').toLowerCase());
    if (pick) return { ok: true, allow: true, owner: targetId, ambiguous: true, between: r.between, why: [`one of the two plausible lanes (${pick.project}); the topic was ambiguous, so this was the caller's call`] };
    return { ok: true, allow: false, ambiguous: true, refusal: r.refusal, between: r.between, candidates: r.candidates || [] };
  }

  const ix = readIndex() || { sessions: {} };
  const t = (ix.sessions || {})[targetId] || null;
  const bad = (t && !KEEPER_TOPIC_RE.test(String(topic || ''))) ? disqualify(t) : null;
  return {
    ok: true,
    allow: false,
    refusal: bad
      ? `${targetId} is a ${bad}. It can only decline and route the topic back — send project work to the actual owner instead.`
      : (r.ok ? `${targetId} is not the owner of this topic; ${r.owner} is ("${r.title}").`
              : 'no session owns this topic — start one rather than sending it to the nearest match'),
    owner: r.ok ? r.owner : null,
    ownerTitle: r.ok ? r.title : null,
    spawn: r.spawn || null,
    candidates: r.candidates || [],
  };
}

module.exports = { resolve, resolveWithGrep, whoTouched, check, disqualify, readIndex, readRoles, scoreRole, namedSessions, signals, KEEPER_RE };
