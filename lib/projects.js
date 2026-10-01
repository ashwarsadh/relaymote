// projects.js — the project index the Conductor, relaymote_route_owner and the organizer read.
//
// A project is a session's working folder, lifted to the nearest parent that holds a .git (so every
// sub-folder of one repo is one project; a `.claude/worktrees/<x>` checkout belongs to its repo). The
// index is written to <data>/conductor/index.json in the shape lib/owner.js readIndex() expects, plus
// a human-readable INDEX.md (first line `Conductor id: <id>`), per-project wiki pages and map.html.
//
// With the transcriptIndex module on, each session also carries what its transcript says (lib/
// transcripts.js): prompts, final answer, pending state (running / buried / asks / unanswered / open /
// ended + critical), context estimate AND compaction count, skills, errors — and transcript-only
// sessions (no Desktop row: headless, deleted) appear as `cli_<uuid>`. Every Desktop session records
// BOTH ids: `id` (local_…) and `cli` (the CLI uuid) plus `cli_chain` (resumed transcripts, oldest first).
//
// Cheap on purpose: transcripts are read incrementally under a time budget (settings.index.budgetMs),
// newest first; whatever does not fit is picked up on the next tick.
'use strict';
const fs = require('fs');
const path = require('path');
const config = require('./config');

const DIR = path.join(config.DATA, 'conductor');
const INDEX_JSON = path.join(DIR, 'index.json');
const INDEX_MD = path.join(DIR, 'INDEX.md');
const WIKI_DIR = path.join(DIR, 'wiki');
const MAP_HTML = path.join(DIR, 'map.html');
const NO_GROUP = /^(\(none\)|\(unknown\)|ungrouped|none)?$/i;
const WIN = process.platform === 'win32';
const WORKTREE_RX = /[\\/]\.claude[\\/]worktrees[\\/].*$/i;

const keyOf = p => (WIN ? String(p).toLowerCase() : String(p));
function normPath(p) {
  if (!p) return null;
  let s = path.resolve(String(p));
  while (s.length > 1 && /[\\/]$/.test(s) && !/^[A-Za-z]:[\\/]$/.test(s)) s = s.slice(0, -1);
  return s;
}

const rootCache = new Map();
/** The nearest parent holding .git, else the folder itself. Never the home folder or a drive root. */
function projectRoot(cwd) {
  const start = normPath(cwd ? String(cwd).replace(WORKTREE_RX, '') : cwd);
  if (!start) return null;
  const k = keyOf(start);
  if (rootCache.has(k)) return rootCache.get(k);
  const home = keyOf(normPath(config.HOME));
  let root = start;
  for (let d = start, i = 0; i < 40; i++) {
    const up = path.dirname(d);
    if (keyOf(d) === home || up === d) break;
    if (fs.existsSync(path.join(d, '.git'))) { root = d; break; }
    d = up;
  }
  rootCache.set(k, root);
  return root;
}

function readMasters() {
  try {
    const all = JSON.parse(fs.readFileSync(path.join(config.STATE, 'masters.json'), 'utf8')) || {};
    const out = {};
    for (const [k, m] of Object.entries(all)) {
      if (!m || !m.sessionId) continue;
      if (m.expiresAt && Date.parse(m.expiresAt) < Date.now()) continue;
      out[k] = m;
    }
    return out;
  } catch { return {}; }
}

/** Group per session id: { byId: Map(id -> name|''), source } — '' means known to be ungrouped. */
function readGroups(snapshot) {
  const byId = new Map();
  let source = null;
  let cfg = null;
  try { cfg = require('./desktop').readGroupConfig(); } catch {}
  if (cfg) {
    source = 'desktop-config';
    for (const [id, g] of cfg.assign) byId.set(id, cfg.names.get(g) || g);
  }
  for (const s of (snapshot && snapshot.sessions) || []) {
    const g = String(s.group || '').trim();
    if (!NO_GROUP.test(g)) { byId.set(s.sessionId, g); source = source || 'snapshot'; }
    else if (!byId.has(s.sessionId) && /^(\(none\)|ungrouped)$/i.test(g)) byId.set(s.sessionId, '');
  }
  return { byId, source, authoritative: !!cfg };
}

function uniqueNames(roots) {
  const byBase = new Map();
  for (const r of roots) {
    const b = path.basename(r) || r;
    if (!byBase.has(b.toLowerCase())) byBase.set(b.toLowerCase(), []);
    byBase.get(b.toLowerCase()).push(r);
  }
  const names = new Map(), taken = new Set();
  for (const list of byBase.values()) {
    for (const r of list) {
      let n = path.basename(r) || r;
      if (list.length > 1) n += ' (' + (path.basename(path.dirname(r)) || 'root') + ')';
      let m = n, i = 2;
      while (taken.has(m.toLowerCase())) m = `${n} ${i++}`;
      taken.add(m.toLowerCase());
      names.set(keyOf(r), m);
    }
  }
  return names;
}

function masterFor(proj, masters) {
  const pk = keyOf(proj.path).toLowerCase();
  for (const [k, m] of Object.entries(masters)) {
    const kk = String(k).toLowerCase().replace(/[\\/]+$/, '');
    if (kk === pk || kk === proj.name.toLowerCase() || kk.startsWith(pk + path.sep.toLowerCase()) || kk.startsWith(pk + '/')) {
      return { sessionId: m.sessionId, key: k, scope: m.sessionTitle || null, claimedAt: m.claimedAt || null, fleetSize: (m.fleet || []).length };
    }
  }
  return null;
}

// ------------------------------------------------------------------ registry extras
// Fields the Desktop registry holds that mobile/sessions.js does not surface. Read from the record's
// own `file` (cached by mtime), or straight off the record when a caller passes raw registry rows.
const REG_KEYS = ['cliSessionId', 'priorCliSessionIds', 'spawnedFrom', 'forkedFromSessionId', 'scheduledTaskId',
  'contextExceededCount', 'completedTurns', 'error', 'worktreePath', 'branch', 'effort'];
// Persisted (<data>/conductor/registry-cache.json) so a fresh process — the MCP server — does not
// re-read every registry file: measured 2.2 s cold vs 48 ms warm on 714 sessions.
const REG_CACHE = path.join(DIR, 'registry-cache.json');
let regCache = null, regDirty = false;
function regLoad() {
  if (regCache) return regCache;
  try { regCache = new Map(Object.entries(JSON.parse(fs.readFileSync(REG_CACHE, 'utf8')))); } catch { regCache = new Map(); }
  return regCache;
}
function regSave(liveFiles) {
  if (!regCache || !regDirty) return;
  for (const k of [...regCache.keys()]) if (liveFiles && !liveFiles.has(k)) regCache.delete(k);
  try { writeAtomic(REG_CACHE, JSON.stringify(Object.fromEntries(regCache))); regDirty = false; } catch {}
}
function registryExtras(s) {
  const out = {};
  for (const k of REG_KEYS) if (s[k] !== undefined) out[k] = s[k];
  if (s.file) {
    try {
      const st = fs.statSync(s.file);
      let hit = regLoad().get(s.file);
      if (!hit || hit.m !== st.mtimeMs) {
        const d = JSON.parse(fs.readFileSync(s.file, 'utf8'));
        const x = {}; for (const k of REG_KEYS) if (d[k] !== undefined) x[k] = d[k];
        hit = { m: st.mtimeMs, x }; regCache.set(s.file, hit); regDirty = true;
      }
      for (const [k, v] of Object.entries(hit.x)) if (out[k] === undefined) out[k] = v;
    } catch {}
  }
  if (s.turns !== undefined && out.completedTurns === undefined) out.completedTurns = s.turns;
  return out;
}

// ------------------------------------------------------------------ tags
function computeTags(sessions, manual = {}) {
  const { tokens } = require('./aliases');
  const docs = new Map(), df = new Map();
  for (const s of Object.values(sessions)) {
    const toks = tokens((s.title || '') + ' ' + (s.prompts || []).join(' ')).filter(t => t.length >= 4 && !/^[\d.-]+$/.test(t));
    const tf = new Map(); for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    docs.set(s.id, tf);
    for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  }
  const N = Math.max(1, docs.size);
  for (const s of Object.values(sessions)) {
    const title = new Set(tokens(s.title || ''));
    const scored = [...docs.get(s.id)].map(([t, c]) => [c * (title.has(t) ? 2 : 1) * Math.log(N / (1 + df.get(t))), t])
      .filter(x => x[0] > 0).sort((a, b) => b[0] - a[0] || a[1].localeCompare(b[1]));
    const man = (manual[s.id] || []).map(t => String(t).toLowerCase());
    s.manual_tags = man;
    s.tags = man.concat(scored.slice(0, 6).map(x => x[1]).filter(t => !man.includes(t)));
  }
}

// ------------------------------------------------------------------ compose
const msIso = ms => { const n = Number(ms); return n ? new Date(n).toISOString() : null; };
const ageDays = (iso, now) => { const t = Date.parse(iso || ''); return t ? +((now - t) / 86400000).toFixed(2) : null; };

/** Transcript + registry + snapshot fields of one session record (shared by Desktop and cli-only rows). */
function intel(o, tr, reg, dot, T) {
  const exceeded = Number(reg.contextExceededCount) || 0;
  Object.assign(o, {
    has_transcript: !!tr, slug: (tr && tr.slug) || null,
    turns: Number(reg.completedTurns) || (tr ? tr.n_user : 0), prompts_seen: tr ? tr.n_user : 0,
    first_prompt: (tr && tr.prompts && tr.prompts[0]) || '', last_prompt: (tr && tr.last_prompt) || '',
    skills: (tr && tr.skills) || {}, subagents: tr ? tr.agent_started : 0, errors: tr ? tr.errors : 0,
    error: reg.error ? String(reg.error).slice(0, 160) : null,
    compactions: tr ? tr.compactions : 0, context_exceeded: exceeded, bytes: tr ? tr.bytes : 0,
    ...T.contextOf(tr ? tr.ctx_bytes : 0, tr ? tr.compactions : 0, exceeded),
    running: dot ? !!dot.running : null, awaiting: dot ? !!dot.awaiting : null, unread: dot ? !!dot.unread : null,
    last_user_ts: (tr && tr.last_user_ts) || null,
    final_text: (tr && tr.final_text) || '', last_role: (tr && tr.last_role) || null,
    asked_user_question: !!(tr && tr.asked_user_question),
    buried: !!(tr && tr.buried), buried_ask: (tr && tr.buried_ask) || '', buried_ts: (tr && tr.buried_ts) || null,
    buried_by: (tr && tr.buried_by) || '', buried_notices: (tr && tr.buried_notices) || 0, n_notices: (tr && tr.n_notices) || 0,
  });
  const p = T.classifyPending(o);
  o.pending = p.pending; o.ask = p.ask;
  o.critical = T.isCritical(p.ask);
  o.awaiting_signal = T.awaitingSignal(o);
}

/** Pure core: turn session records + group map + master claims (+ transcripts) into the index object. */
function compose({ sessions, groups, masters = {}, conductor = null, now = Date.now(), transcripts = null, snapshot = null, manualTags = {} }) {
  const T = require('./transcripts');
  const g = groups || { byId: new Map(), source: null, authoritative: false };
  const rows = (sessions || []).filter(s => s && s.id);
  const byCli = transcripts instanceof Map ? transcripts : new Map(Object.entries(transcripts || {}));
  const dots = new Map(((snapshot && snapshot.sessions) || []).map(s => [s.sessionId, s]));

  // which transcripts belong to a Desktop row (current + resumed chain)
  const regOf = new Map(), usedCli = new Set();
  for (const s of rows) {
    const reg = registryExtras(s);
    regOf.set(s.id, reg);
    if (reg.cliSessionId) usedCli.add(reg.cliSessionId);
    for (const c of reg.priorCliSessionIds || []) usedCli.add(c);
  }
  const cliOnly = [...byCli.entries()].filter(([c]) => !usedCli.has(c));

  const rootOf = new Map();
  for (const s of rows) rootOf.set(s.id, s.cwd ? projectRoot(s.cwd) : null);
  for (const [c, tr] of cliOnly) rootOf.set('cli_' + c, tr.cwd ? projectRoot(tr.cwd) : null);
  const roots = new Map();
  for (const r of rootOf.values()) if (r && !roots.has(keyOf(r))) roots.set(keyOf(r), r);
  const names = uniqueNames([...roots.values()]);

  const projects = {}, out = {};
  const masterIds = new Set(Object.values(masters).map(m => m.sessionId));
  const project = (name, root) => projects[name] || (projects[name] = { name, path: root, groups: {}, group: null, sessions: [], cli_sessions: [], master: null,
    counts: { total: 0, active: 0, archived: 0, ungrouped: 0, cli_only: 0 }, lastActivityAt: 0 });

  for (const s of rows) {
    const root = rootOf.get(s.id);
    const name = root ? names.get(keyOf(root)) : null;
    const grp = g.byId.has(s.id) ? (g.byId.get(s.id) || null) : (g.authoritative ? null : undefined);
    const lastMs = Number(s.lastActivityAt) || 0;
    const reg = regOf.get(s.id);
    const cli = reg.cliSessionId || null;
    const chain = [...(reg.priorCliSessionIds || []), ...(cli ? [cli] : [])].filter((c, i, a) => c && a.indexOf(c) === i);
    const tr = cli ? byCli.get(cli) || null : null;
    const prior = [];
    for (const pc of reg.priorCliSessionIds || []) prior.push(...(((byCli.get(pc) || {}).prompts) || []).slice(0, 4));
    // the registry's lastActivityAt is mass-bumped by Desktop restarts, so the transcript's last line wins
    const last = (tr && tr.last_ts) || msIso(lastMs);
    const o = out[s.id] = {
      id: s.id, cli, cli_chain: chain, title: s.title || (tr && (tr.custom_title || tr.ai_title)) || '(untitled)',
      project: name, projectPath: root, cwd: s.cwd || (tr && tr.cwd) || null,
      group: grp === undefined ? null : grp, groupKnown: grp !== undefined, in_sidebar: true,
      archived: !!s.archived, model: s.model || (tr && tr.model) || null, effort: s.effort || reg.effort || null,
      branch: reg.branch || (tr && tr.branch) || null, worktree: !!reg.worktreePath || WORKTREE_RX.test(s.cwd || ''),
      createdAt: Number(s.createdAt) || null, lastActivityAt: lastMs || null, last,
      age_days: ageDays(last, now),
      baton_master: masterIds.has(s.id) || undefined, conductor: (conductor && s.id === conductor) || undefined,
      spawned_from: (reg.spawnedFrom && (reg.spawnedFrom.sessionId || reg.spawnedFrom)) || null,
      forked_from: reg.forkedFromSessionId || null, scheduled_task: reg.scheduledTaskId || null,
      prompts: prior.concat((tr && tr.prompts) || []), tags: [],
    };
    if (typeof o.spawned_from !== 'string') o.spawned_from = null;
    intel(o, tr, reg, dots.get(s.id), T);
    if (!name) continue;
    const p = project(name, root);
    p.sessions.push(s.id);
    p.counts.total++;
    if (s.archived) p.counts.archived++; else p.counts.active++;
    if (!s.archived && grp) p.groups[grp] = (p.groups[grp] || 0) + 1;
    if (!s.archived && grp === null) p.counts.ungrouped++;
    if (lastMs > p.lastActivityAt) p.lastActivityAt = lastMs;
  }
  // transcripts with no Desktop row: plain CLI runs, headless workers, deleted sessions
  for (const [c, tr] of cliOnly) {
    const id = 'cli_' + c;
    const root = rootOf.get(id);
    const name = root ? names.get(keyOf(root)) : null;
    const o = out[id] = {
      id, cli: c, cli_chain: [c], title: tr.custom_title || tr.ai_title || ((tr.prompts || [])[0] || '').slice(0, 80) || '(untitled)',
      project: name, projectPath: root, cwd: tr.cwd || null, group: null, groupKnown: false, in_sidebar: false,
      archived: false, model: tr.model || null, effort: null, branch: tr.branch || null, worktree: WORKTREE_RX.test(tr.cwd || ''),
      createdAt: Date.parse(tr.first_ts || '') || null, lastActivityAt: Date.parse(tr.last_ts || '') || null, last: tr.last_ts || null,
      age_days: ageDays(tr.last_ts, now), spawned_from: null, forked_from: null, scheduled_task: null,
      prompts: tr.prompts || [], tags: [],
    };
    intel(o, tr, {}, null, T);
    if (!name) continue;
    const p = project(name, root);
    p.cli_sessions.push(id); p.counts.cli_only++;
  }

  // fleet tree + master heuristic: a Relaymote claim, a title that says master, or >= 3 children
  const kids = new Map();
  for (const s of Object.values(out)) if (s.spawned_from) { if (!kids.has(s.spawned_from)) kids.set(s.spawned_from, []); kids.get(s.spawned_from).push(s.id); }
  const byLast = (a, b) => String(out[b].last || '').localeCompare(String(out[a].last || ''));
  for (const s of Object.values(out)) {
    s.children = (kids.get(s.id) || []).filter(i => out[i]).sort(byLast);
    s.master_by_title = /\bmaster\b/i.test(s.title || '');
    s.is_master = !!s.baton_master || s.master_by_title || s.children.length >= 3;
  }
  computeTags(out, manualTags);

  for (const p of Object.values(projects)) {
    p.group = Object.entries(p.groups).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    p.master = masterFor(p, masters);
    p.sessions.sort((a, b) => (out[b].lastActivityAt || 0) - (out[a].lastActivityAt || 0));
    p.cli_sessions.sort(byLast);
    p.living_masters = p.sessions.filter(i => out[i].is_master && !out[i].archived);
  }
  // sidebar-group roll-up (live Desktop sessions only)
  const groupsOut = {};
  for (const s of Object.values(out)) {
    if (s.archived || !s.in_sidebar) continue;
    const gname = s.group || (s.groupKnown ? 'Ungrouped' : '(unknown)');
    const gg = groupsOut[gname] || (groupsOut[gname] = { sessions: [], projects: {}, last: null, living_masters: [] });
    gg.sessions.push(s.id);
    if (s.project) gg.projects[s.project] = (gg.projects[s.project] || 0) + 1;
    if (s.last && (!gg.last || s.last > gg.last)) gg.last = s.last;
  }
  for (const gg of Object.values(groupsOut)) {
    gg.sessions.sort(byLast);
    gg.living_masters = gg.sessions.filter(i => out[i].is_master);
  }
  const relaymote_masters = {};
  for (const [k, m] of Object.entries(masters)) {
    relaymote_masters[k] = { sessionId: m.sessionId, project: k, scope: m.sessionTitle || null, claimedAt: m.claimedAt || null, expiresAt: m.expiresAt || null };
  }
  const ixs = config.get().index || {};
  return {
    version: 2, builtAt: new Date(now).toISOString(), source: 'relaymote',
    conductor: conductor || null, groupSource: g.source, groupsAuthoritative: !!g.authoritative,
    counts: { projects: Object.keys(projects).length, sessions: rows.length, active: rows.filter(s => !s.archived).length,
      archived: rows.filter(s => s.archived).length, cli_only: cliOnly.length, groups: Object.keys(groupsOut).length },
    thresholds: { bytesPerToken: Number(ixs.bytesPerToken) || 4, ctxFull: Number(ixs.ctxFull) || 400000, ctxTight: Number(ixs.ctxTight) || 250000,
      note: 'est_ctx_tokens is a byte estimate (a HINT that over-counts image/attachment traffic), not a liveness signal; compactions is the ground truth.' },
    sessions: out, projects, groups: groupsOut, relaymote_masters,
  };
}

// ------------------------------------------------------------------ side inputs (disk reads)
const PLAN_NAME_RX = /(plan|status|todo|roadmap|backlog|progress|handoff|next[-_ ]?steps|tasks)/i;
const SKIP_DIRS = new Set(['node_modules', 'venv', '.venv', 'dist', 'build', '__pycache__']);

/** Plan/status markdown in a project (top two levels): open vs done checkboxes and the first open items. */
function scanPlanFiles(root) {
  const out = [];
  if (!root) return out;
  const cands = [];
  const walk = (d, depth) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents.slice(0, 400)) {
      if (e.isDirectory()) { if (depth < 1 && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name)) walk(path.join(d, e.name), depth + 1); }
      else if (e.isFile() && /\.md$/i.test(e.name) && PLAN_NAME_RX.test(e.name)) cands.push(path.join(d, e.name));
    }
  };
  walk(root, 0);
  for (const p of cands.sort().slice(0, 12)) {
    let st, txt;
    try { st = fs.statSync(p); if (st.size > 400000) continue; txt = fs.readFileSync(p, 'utf8'); } catch { continue; }
    const open = [...txt.matchAll(/^\s*[-*]\s*\[ \]\s*(.+)$/gm)].map(m => m[1].trim().slice(0, 140));
    const done = (txt.match(/^\s*[-*]\s*\[[xX]\]/gm) || []).length;
    const head = ((txt.split(/\r?\n/).find(l => l.startsWith('#')) || '').replace(/^#+\s*/, '')).trim().slice(0, 120);
    out.push({ path: p, rel: path.relative(root, p), mtime: new Date(st.mtimeMs).toISOString(), head, open: open.length, done, open_items: open.slice(0, 10) });
  }
  return out.sort((a, b) => b.mtime.localeCompare(a.mtime));
}

function slugFor(cwd) { return String(cwd || '').replace(/[^A-Za-z0-9]/g, '-'); }

/** `- ` lines of ~/.claude/projects/<slug>/memory/MEMORY.md. */
function memoryIndex(slug) {
  if (!slug) return [];
  try {
    return fs.readFileSync(path.join(config.CLAUDE_HOME, 'projects', slug, 'memory', 'MEMORY.md'), 'utf8')
      .split(/\r?\n/).map(l => l.trim()).filter(l => l.startsWith('- ')).map(l => l.slice(2, 222));
  } catch { return []; }
}

/** First six non-empty, non-fence lines of <root>/CLAUDE.md joined with ' | '. */
function claudeMdHead(root) {
  if (!root) return '';
  try {
    const out = [];
    for (const l of fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8').split(/\r?\n/)) {
      const t = l.trim();
      if (t && !t.startsWith('```')) out.push(t.slice(0, 200));
      if (out.length >= 6) break;
    }
    return out.join(' | ');
  } catch { return ''; }
}

/** Installed skills: ~/.claude/skills/<name>/SKILL.md with its description line. */
function listSkills() {
  const dir = path.join(config.CLAUDE_HOME, 'skills');
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const n of names) {
    let txt; try { txt = fs.readFileSync(path.join(dir, n, 'SKILL.md'), 'utf8'); } catch { continue; }
    const m = /^description:\s*(.*)$/m.exec(txt);
    out.push({ name: n, description: m ? m[1].trim().replace(/^["']|["']$/g, '').slice(0, 240) : '' });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function enrich(ix) {
  for (const p of Object.values(ix.projects)) {
    const ids = p.sessions.concat(p.cli_sessions || []);
    const slug = ids.map(i => ix.sessions[i]).find(s => s && s.slug && !s.worktree)?.slug || slugFor(p.path);
    p.slug = slug;
    p.plan_files = scanPlanFiles(p.path);
    p.memory = memoryIndex(slug);
    p.claude_md = claudeMdHead(p.path);
  }
  ix.skills = listSkills();
}

// ------------------------------------------------------------------ views
function ago(ms) {
  if (!ms) return '?';
  const m = Math.round((Date.now() - ms) / 60000);
  return m < 60 ? m + 'm' : m < 2880 ? Math.round(m / 60) + 'h' : Math.round(m / 1440) + 'd';
}
const cell = s => String(s == null ? '' : s).replace(/[|\r\n]+/g, '/').trim();
function markdown(ix) { return require('./index-views').indexMd(ix); }

const { writeAtomic } = require('./fsx');

function writeViews(ix) {
  const V = require('./index-views');
  writeAtomic(INDEX_MD, V.indexMd(ix));
  for (const [name, text] of V.wikiPages(ix)) writeAtomic(path.join(WIKI_DIR, name + '.md'), text);
  writeAtomic(MAP_HTML, V.mapHtml(ix));
}

let last = null;
/**
 * Read every source, compose the index and (unless write:false) write index.json, INDEX.md, wiki/ and
 * map.html. opts: sessions, snapshot, groups, masters (injectable); full (no time budget); budgetMs;
 * transcripts:false (skip transcript reading); osTasks ('force' to re-read the OS now); digests (bool).
 */
async function build(opts = {}) {
  const t0 = Date.now();
  const ixs = config.get().index || {};
  const sessions = opts.sessions || await (async () => {
    const s = require('../mobile/sessions');
    await s.refresh({ force: !!opts.force });
    return s.index().list;
  })();
  let snapshot = opts.snapshot;
  if (snapshot === undefined) { try { snapshot = require('./desktop').loadSnapshot(); } catch { snapshot = null; } }
  let conductor = null;
  try { conductor = require('./master-protocol').conductorId(); } catch {}
  const budgetMs = opts.full ? Infinity : (opts.budgetMs != null ? opts.budgetMs : (Number(ixs.budgetMs) || 4000));
  let tr = { byCli: new Map(), stats: null };
  if (opts.transcripts !== false && config.mod('transcriptIndex')) {
    try { tr = await require('./transcripts').scan({ budgetMs }); } catch (e) { tr.stats = { error: e.message }; }
  }
  let manualTags = {};
  try { manualTags = require('./aliases').manualTags(); } catch {}
  const ix = compose({
    sessions, groups: opts.groups || readGroups(snapshot), snapshot,
    masters: opts.masters || readMasters(), conductor, transcripts: tr.byCli, manualTags,
  });
  ix.transcripts = tr.stats;
  if (opts.write !== false) regSave(new Set(sessions.map(s => s.file).filter(Boolean)));
  enrich(ix);
  try { require('./summarize').attach(ix); } catch {}   // s.summary / s.overview from <data>/conductor/summaries (WP6)
  const roots = Object.values(ix.projects).map(p => ({ path: p.path, name: p.name }));
  try {
    const O = require('./ostasks');
    if (opts.osTasks || config.mod('osTasks')) {
      ix.os_tasks = await O.collect({ projectRoots: roots, force: opts.osTasks === 'force', reader: opts.osReader,
        maxAgeMs: (Number(ixs.osTasksMaxAgeMinutes) || 360) * 60000 });
    } else {
      const c = O.readCache();
      ix.os_tasks = c ? { at: c.at, rows: O.attribute((c.rows || []).filter(r => !r.error), roots), cached: true } : null;
    }
  } catch (e) { ix.os_tasks = { error: e.message, rows: [] }; }
  if (opts.digests || (opts.digests !== false && config.mod('digests'))) {
    try {
      const deadline = budgetMs === Infinity ? Infinity : Date.now() + Math.max(1000, budgetMs);
      ix.digests = require('./digests').updateAll(ix.sessions, tr.byCli, { deadline });
    } catch (e) { ix.digests = { error: e.message }; }
  }
  ix.buildMs = Date.now() - t0;
  if (opts.write !== false) {
    writeAtomic(INDEX_JSON, JSON.stringify(ix, null, 1));
    writeViews(ix);
  }
  last = ix;
  return ix;
}

function read() {
  try { return JSON.parse(fs.readFileSync(INDEX_JSON, 'utf8')); } catch { return null; }
}

/** The on-disk index if it is younger than maxAgeMs, else a fresh build. */
async function fresh(maxAgeMs = 2 * 60000) {
  const ix = read();
  if (ix && Date.now() - Date.parse(ix.builtAt || 0) < maxAgeMs) return ix;
  return build();
}

/** A compact per-project summary for tool replies. */
function summary(ix, { limit = 40 } = {}) {
  return Object.values((ix && ix.projects) || {})
    .filter(p => p.counts.active > 0)
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
    .slice(0, limit)
    .map(p => ({ project: p.name, path: p.path, active: p.counts.active, ungrouped: p.counts.ungrouped,
      group: p.group, master: p.master ? p.master.sessionId : null, lastActive: ago(p.lastActivityAt) + ' ago',
      masters: (p.living_masters || []).slice(0, 3), openPlanItems: (p.plan_files || []).reduce((n, f) => n + f.open, 0) || undefined }));
}

/** One project in detail, found by name, path or a sub-folder of it. */
function detail(ix, q) {
  const want = String(q || '').trim().toLowerCase();
  if (!want || !ix) return null;
  const list = Object.values(ix.projects || {});
  const p = list.find(x => x.name.toLowerCase() === want)
    || list.find(x => keyOf(x.path).toLowerCase() === keyOf(normPath(q) || '').toLowerCase())
    || list.find(x => x.name.toLowerCase().includes(want));
  if (!p) return null;
  return { ...p, lastActive: ago(p.lastActivityAt) + ' ago',
    sessions: p.sessions.map(id => {
      const s = ix.sessions[id];
      return { id, cli: s.cli || null, title: s.title, group: s.group, archived: s.archived, model: s.model, lastActive: ago(s.lastActivityAt) + ' ago',
        master: !!(s.baton_master || s.is_master) || undefined, pending: s.pending || undefined, ctx: s.ctx_flag ? `~${Math.round((s.est_ctx_tokens || 0) / 1000)}k ${s.ctx_flag}` : undefined,
        compactions: s.compactions || undefined, tags: (s.tags || []).slice(0, 4) };
    }) };
}

// ------------------------------------------------------------------ newproject
const BAD_NAME = /[\\/:*?"<>|\u0000-\u001f]|^\.+$|\.\./;
/**
 * Create <settings.index.projectsRoot>/<name> with a seed CLAUDE.md and routing aliases for its name.
 * REFUSES when the root is unset or missing, or the name is not a plain folder name. An existing
 * folder is reported, never overwritten.
 */
function newProject(name, purpose = '') {
  const root = String((config.get().index || {}).projectsRoot || '').trim();
  const n = String(name || '').trim();
  if (!root) return { ok: false, error: 'REFUSED', message: 'settings.index.projectsRoot is not set — set "index": { "projectsRoot": "<folder that holds your projects>" } in settings.json first.' };
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return { ok: false, error: 'REFUSED', message: `projectsRoot "${root}" does not exist` };
  if (!n || BAD_NAME.test(n) || n.length > 80) return { ok: false, error: 'REFUSED', message: `"${n}" is not a plain folder name` };
  const folder = path.join(root, n);
  let created = false;
  if (!fs.existsSync(folder)) {
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, 'CLAUDE.md'),
      `# ${n}\n\nCreated ${new Date().toISOString().slice(0, 10)} by the Conductor.\n\n## Purpose\n\n${String(purpose || 'TBD').trim()}\n\n` +
      '## Rules\n\n- Keep this file true: what runs where, what must not be touched, dead ends.\n' +
      '- Report to the Conductor session when a milestone lands or you are blocked.\n');
    created = true;
  }
  const A = require('./aliases');
  const learned = [];
  for (const kw of A.tokens(n).slice(0, 3)) { const r = A.learn(kw, n); if (r.ok) learned.push(kw); }
  return { ok: true, folder, created, existed: !created, aliases: learned,
    next: `Start the first session there: relaymote_spawn with cwd ${JSON.stringify(folder)}, then send the purpose verbatim.` };
}

module.exports = { DIR, INDEX_JSON, INDEX_MD, WIKI_DIR, MAP_HTML, build, read, fresh, compose, enrich, markdown, summary, detail,
  projectRoot, readGroups, readMasters, registryExtras, computeTags, scanPlanFiles, memoryIndex, claudeMdHead, listSkills, newProject,
  ago, cell, last: () => last };
