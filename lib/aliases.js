// aliases.js — what routing LEARNS: keyword aliases, manual topic tags, and the dispatch log.
//
//   <data>/conductor/aliases.json   { "<keyword>": ["<project or group>", ...] }  — ships EMPTY; grows by learn()
//   <data>/conductor/tags.json      { "<session id>": ["tag", ...] }             — manual tags; auto tags are computed
//   <data>/conductor/dispatch.jsonl one routing decision per line; route() reads them back as learned routings,
//                                   and a decision the user CONFIRMED weighs twice a guess.
'use strict';
const fs = require('fs');
const path = require('path');
const config = require('./config');

const dir = () => path.join(config.DATA, 'conductor');
const ALIASES = () => path.join(dir(), 'aliases.json');
const TAGS = () => path.join(dir(), 'tags.json');
const DISPATCH = () => path.join(dir(), 'dispatch.jsonl');
const COMMENT = 'keyword -> project folder names or sidebar group names (case-insensitive, whole-word). Add with `relaymote index learn "<keyword>" "<project>"`.';

const { readJson, writeJsonAtomic } = require('./fsx');
const writeJson = (f, obj) => writeJsonAtomic(f, obj, 2);

// Tokeniser shared with tags and routing: generic English stop words only.
const WORD = /[a-z0-9][a-z0-9_\-.]{1,}/g;
const STOP = new Set(('the a an and or of to in on for with is are was be it this that my me i we you can please do does did fix make add new ' +
  'error issue problem bug from into about there here what which how when why some any not no yes also just like then than have has had ' +
  'will would should could need want get got session sessions').split(' '));
const tokens = t => (String(t || '').toLowerCase().match(WORD) || []).filter(w => !STOP.has(w));

function load() {
  const a = readJson(ALIASES(), null);
  return a && typeof a === 'object' ? a : { _comment: COMMENT };
}

/** Add a routing alias. Refuses an empty keyword or target. */
function learn(keyword, target) {
  const kw = String(keyword || '').trim().toLowerCase(), tg = String(target || '').trim();
  if (!kw || !tg) return { ok: false, error: 'REFUSED', message: 'learn needs a keyword and a project or group name' };
  if (kw.startsWith('_')) return { ok: false, error: 'REFUSED', message: 'keywords starting with "_" are reserved' };
  const a = load();
  const list = Array.isArray(a[kw]) ? a[kw] : [];
  if (!list.some(x => x.toLowerCase() === tg.toLowerCase())) list.unshift(tg);
  a[kw] = list;
  if (!a._comment) a._comment = COMMENT;
  writeJson(ALIASES(), a);
  return { ok: true, keyword: kw, targets: list };
}

/** Alias boosts for a query: Map(lowercased target -> weight) plus the keywords that fired. */
function boosts(query, weight = 1) {
  const ql = String(query || '').toLowerCase();
  const out = new Map(), fired = [];
  for (const [k, targets] of Object.entries(load())) {
    if (k.startsWith('_') || !Array.isArray(targets)) continue;
    const rx = new RegExp('(?<![a-z0-9])' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![a-z0-9])');
    if (!rx.test(ql)) continue;
    fired.push(k);
    for (const t of targets) out.set(String(t).toLowerCase(), (out.get(String(t).toLowerCase()) || 0) + weight);
  }
  return { byTarget: out, fired };
}

// ------------------------------------------------------------------ manual tags
function manualTags() { return readJson(TAGS(), {}); }

/** Add manual tags to exactly ONE session matched by id / prefix / cli uuid. Refuses zero or several matches. */
function tag(ix, ref, csv) {
  const hits = findSessions(ix, ref);
  if (hits.length !== 1) {
    return { ok: false, error: 'REFUSED', message: `need exactly one session matching "${ref}", got ${hits.length}`, matches: hits.slice(0, 8).map(s => s.id) };
  }
  const id = hits[0].id;
  const m = manualTags();
  const cur = Array.isArray(m[id]) ? m[id] : [];
  for (const t of String(csv || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean)) if (!cur.includes(t)) cur.push(t);
  if (!cur.length) return { ok: false, error: 'REFUSED', message: 'no tags given' };
  m[id] = cur;
  writeJson(TAGS(), m);
  return { ok: true, session: id, tags: cur, note: 'Applied to the index on the next build.' };
}

/** Sessions matching a reference: full id, local_/cli_ prefix-stripped prefix (>= 4 chars), or cli uuid prefix. */
function findSessions(ix, ref) {
  const r = String(ref || '').trim().toLowerCase().replace(/^(local_|cli_)/, '');
  if (r.length < 4 || !ix || !ix.sessions) return [];
  const exact = ix.sessions[ref];
  if (exact) return [exact];
  return Object.values(ix.sessions).filter(s => {
    const bare = String(s.id).toLowerCase().replace(/^(local_|cli_)/, '');
    return bare.startsWith(r) || String(s.cli || '').toLowerCase().startsWith(r)
      || (s.cli_chain || []).some(c => String(c).toLowerCase().startsWith(r));
  });
}

// ------------------------------------------------------------------ dispatch log
function logDispatch(query, target, reason, confirmed = false) {
  if (!String(query || '').trim() || !String(target || '').trim()) {
    return { ok: false, error: 'REFUSED', message: 'a dispatch needs the query and the target session id' };
  }
  const row = { ts: new Date().toISOString(), query: String(query).slice(0, 500), target: String(target),
    reason: String(reason || '').slice(0, 200), confirmed: !!confirmed };
  fs.mkdirSync(dir(), { recursive: true });
  fs.appendFileSync(DISPATCH(), JSON.stringify(row) + '\n');
  return { ok: true, logged: row };
}

function readDispatches() {
  let txt = '';
  try { txt = fs.readFileSync(DISPATCH(), 'utf8'); } catch { return []; }
  const out = [];
  for (const ln of txt.split('\n')) { if (!ln.trim()) continue; try { out.push(JSON.parse(ln)); } catch {} }
  return out;
}

/** The last n decisions, newest last, with the target's title/group from the index. */
function dispatches(n = 15, ix = null) {
  return readDispatches().slice(-n).map(d => {
    const s = (ix && ix.sessions && ix.sessions[d.target]) || {};
    return { ...d, title: s.title || null, group: s.group || null };
  });
}

/** Learned scores: target id -> sum(overlap tokens × (confirmed ? 2 : 1)) over past dispatches sharing >= 2 tokens. */
function learned(query) {
  const q = new Set(tokens(query));
  const out = new Map();
  for (const d of readDispatches()) {
    if (!d.target) continue;
    const ov = tokens(d.query).filter((t, i, a) => q.has(t) && a.indexOf(t) === i).length;
    if (ov >= 2) out.set(d.target, (out.get(d.target) || 0) + ov * (d.confirmed ? 2 : 1));
  }
  return out;
}

module.exports = { ALIASES, TAGS, DISPATCH, load, learn, boosts, manualTags, tag, findSessions, logDispatch, readDispatches, dispatches, learned, tokens, STOP };
