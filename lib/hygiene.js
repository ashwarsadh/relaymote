// hygiene.js — what each live session's context NEEDS DONE, not how big it is.
//
// The data already exists: the project index (lib/projects.js) carries est_ctx_tokens, compactions,
// pending state, running/awaiting flags and last activity for every session, and lib/wakes.js says
// whether a session's prompt cache is still warm. What this adds is the RULE that decides when to
// compact — and, far more important, when NOT.
//
// COMPACTION IS LOSSY. Most sessions over the threshold must NOT be compacted:
//   * a DORMANT one wants archiving (summarising a session nobody reopens buys nothing, destroys the record);
//   * a finished task wants a NEW SESSION, not a summary of the old one;
//   * one already compacted twice wants ROTATING (a third summary of a summary keeps almost nothing).
// Compaction is right only MID-TASK, where continuity is genuinely at stake.
//
// Three guards outrank every threshold:
//   (a) never mid-turn — the checkable superset of mid-payment / mid-send / mid-deploy;
//   (b) never while awaiting the user — the question is short and recent, exactly what a summary drops;
//   (c) never before the session's state is on disk — "idle tells you the compaction will not INTERRUPT
//       work; only state-on-disk tells you it will not DESTROY any". Such a session gets WRITE-STATE-FIRST.
// And a fourth, on cost: compact only in the session's LAST WARM CYCLE (idle compactFrom..compactUntil
// minutes). A cold session's summarising call re-reads the whole context uncached — the cost it was
// meant to avoid — so cold sessions wait for the end of their next warm window.
//
// THE ROUTE IS NOT INTERCHANGEABLE: /compact must be TYPED into the composer (lib/goal.js
// typeSlashCommand, which proves the app recognised it as a command). Sent as a message
// (bridge.sendMessage) it arrives as prose, does nothing, and nothing errors.
//
// It is ASYNCHRONOUS: the command runs after the session's current turn. Verification is deferred —
// a later cycle must see the compaction count rise; after verifyAfterHours without one, the send is
// reported as a SILENT FAILURE and never re-sent blindly.
//
// Only COMPACT is ever acted on automatically (module autoCompact, off by default). ARCHIVE is never
// executed here — lib/archive.js lists candidates for the user to approve.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('./config');

const DIR = () => path.join(config.DATA, 'conductor');
const REPORT_MD = () => path.join(DIR(), 'HYGIENE.md');
const REPORT_JSON = () => path.join(DIR(), 'hygiene.json');
const STATE = () => path.join(DIR(), 'hygiene-state.json');
const EVENTS = () => path.join(DIR(), 'hygiene-events.jsonl');
const H = 3600000, M = 60000, DAY = 86400000;
const WIN = process.platform === 'win32';

const ACTIONABLE = 'COMPACT';
const ORDER = ['COMPACT', 'WRITE-STATE-FIRST', 'ROTATE', 'NEW-SESSION', 'ARCHIVE', 'HOLD-AWAITING', 'HOLD-ASK-PENDING', 'HOLD-RUNNING', 'OK'];
// The route. Anything else is prose. Tests assert this and that the default compactor never sends a message.
const COMPACT_ROUTE = 'composer';

class IndexUnreadable extends Error {}

function settings(over = {}) {
  const c = config.get() || {};
  const h = { ...config.DEFAULTS.hygiene, ...(c.hygiene || {}), ...over };
  const ix = c.index || {};
  h.fullTokens = Number(h.fullTokens) || Number(ix.ctxFull) || 400000;
  h.tightTokens = Number(h.tightTokens) || Number(ix.ctxTight) || 250000;
  h.windowMinutes = Number(((c.cacheKeeper || {}).windowMinutes)) || 60;
  h.stateFiles = Array.isArray(h.stateFiles) && h.stateFiles.length ? h.stateFiles : config.DEFAULTS.hygiene.stateFiles;
  h.autoCompact = over.autoCompact !== undefined ? !!over.autoCompact : config.mod('autoCompact');
  return h;
}

const ms = s => { const t = typeof s === 'number' ? s : Date.parse(s || ''); return isNaN(t) ? 0 : t; };
const iso = t => new Date(t).toISOString();
const k = n => Math.floor((n || 0) / 1000);
function readJson(f, d) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } }
function writeAtomic(f, text) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, f);
}
const norm = p => { const r = path.resolve(String(p || '')); return WIN ? r.toLowerCase() : r; };

// ---------------------------------------------------------------- state on disk
// A shell command that WRITES its target. Read commands (wc, ls, cat) name files too; crediting them is
// how a `wc -c STATE.md` once became "authorship".
const WRITE_OPS = [
  /(?:^|[^<>0-9])>>?\s*(?<p>[^\s|;&>]+)/g,
  /\btee\s+(?:-a\s+)?(?<p>[^\s|;&]+)/g,
  /\bsed\s+-i\S*\s+.*?(?<p>[^\s|;&]+)$/gm,
  /\b(?:cp|mv|install)\s+\S+\s+(?<p>[^\s|;&]+)/g,
];
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const DOC_EXT = /\.(md|txt|rst)$/i;

/** Paths ONE tool call actually wrote, from the SHAPE of the call — never from a filename in text or a tool result. */
function writtenPaths(block) {
  const name = block && block.name, inp = (block && block.input) || {};
  const out = [];
  if (WRITE_TOOLS.has(name)) {
    for (const key of ['file_path', 'notebook_path', 'path']) if (inp[key]) out.push(String(inp[key]));
  } else if (name === 'Bash' || name === 'PowerShell') {
    const cmd = String(inp.command || '');
    for (const rx of WRITE_OPS) {
      rx.lastIndex = 0;
      for (const m of cmd.matchAll(rx)) {
        const t = String((m.groups && m.groups.p) || '').replace(/^["']|["']$/g, '');
        if (t && !t.startsWith('/dev/') && t !== '$null' && t.toUpperCase() !== 'NUL' && !/^&?\d$/.test(t)) out.push(t);
      }
    }
  }
  return out;
}

function transcriptFiles(s) {
  const T = require('./transcripts');
  const out = [];
  for (const c of (s.cli_chain && s.cli_chain.length ? s.cli_chain : [s.cli]).filter(Boolean)) {
    const f = T.findTranscript(c, c === s.cli ? s.slug : null);
    if (f && !out.includes(f)) out.push(f);
  }
  return out;
}

function eachLine(file, fn) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    let pos = 0, carry = '';
    const CH = 4 << 20;
    while (pos < size) {
      const b = Buffer.allocUnsafe(Math.min(CH, size - pos));
      const got = fs.readSync(fd, b, 0, b.length, pos);
      if (got <= 0) break;
      pos += got;
      const text = carry + b.toString('utf8', 0, got);
      const lines = text.split('\n');
      carry = lines.pop();
      for (const ln of lines) fn(ln);
    }
    if (carry) fn(carry);
  } finally { fs.closeSync(fd); }
}

const authorshipCache = new Map();
/**
 * Did THIS SESSION write a real state document into its project since it started? -> { ok, why }.
 * MATERIAL, not nominal: a document it wrote (Write/Edit or a shell write operator — the shape of the
 * call), inside its project, still on disk, at least minStateBytes. Conservative: what it cannot
 * positively see reads as NOT written, which HOLDS the session. A false hold costs one cycle; a false
 * pass destroys context that existed nowhere else.
 */
function sessionWroteState(s, cfg, opts = {}) {
  const files = opts.files || transcriptFiles(s);
  const key = s.id + '|' + files.map(f => { try { return f + ':' + fs.statSync(f).size; } catch { return f; } }).join(',');
  if (!opts.fresh && authorshipCache.has(key)) return authorshipCache.get(key);
  const done = r => { authorshipCache.set(key, r); return r; };
  if (!files.length) return done({ ok: false, why: 'no transcript to check authorship against' });
  const root = s.projectPath || s.cwd;
  if (!root) return done({ ok: false, why: 'no project folder known' });
  const rootN = norm(root);
  const created = ms(s.createdAt) || 0;
  const found = new Map();
  try {
    for (const f of files) {
      eachLine(f, (ln) => {
        if (ln.indexOf('"tool_use"') < 0) return;
        let r; try { r = JSON.parse(ln); } catch { return; }
        if (r.type !== 'assistant') return;
        const ts = ms(r.timestamp);
        if (created && ts && ts < created) return;
        const content = (r.message && r.message.content) || [];
        if (!Array.isArray(content)) return;
        for (const b of content) {
          if (!b || b.type !== 'tool_use') continue;
          for (let w of writtenPaths(b)) {
            if (w.startsWith('~')) w = path.join(os.homedir(), w.slice(1));
            const ap = path.isAbsolute(w) ? path.resolve(w) : path.resolve(root, w);
            const apN = norm(ap);
            if (apN !== rootN && !apN.startsWith(rootN + path.sep)) continue;   // outside the project: not its state
            if (!DOC_EXT.test(ap)) continue;
            let sz = -1;
            try { sz = fs.statSync(ap).size; } catch {}                          // -1 = NOT FOUND, not empty
            const prev = found.get(ap);
            if (!prev || sz >= prev.sz) found.set(ap, { sz, when: ts ? iso(ts).slice(0, 16) : '?' });
          }
        }
      });
    }
  } catch (e) { return done({ ok: false, why: 'could not read transcript: ' + e.message }); }
  const big = [...found.entries()].map(([p, v]) => ({ p, ...v })).sort((a, b) => b.sz - a.sz);
  if (big.length && big[0].sz >= cfg.minStateBytes) return done({ ok: true, why: `wrote ${path.basename(big[0].p)} (${big[0].sz} bytes, still on disk) at ${big[0].when}`, file: big[0].p });
  if (big.length && big[0].sz < 0) return done({ ok: false, why: `the doc it wrote (${path.basename(big[0].p)}) is not on disk — cannot confirm its state survives` });
  if (big.length) return done({ ok: false, why: `the only doc it wrote is ${path.basename(big[0].p)} at ${big[0].sz} bytes — too small to be this session's state` });
  return done({ ok: false, why: 'this session has written no document into its project since it started' });
}

/** The newest named state file in the project root, and whether it changed after the session started. */
function stateFreshness(root, createdMs, names) {
  let newest = 0, name = null;
  for (const f of names) {
    try { const m = fs.statSync(path.join(root || '', f)).mtimeMs; if (m > newest) { newest = m; name = f; } } catch {}
  }
  return { name, mtime: newest || null, fresh: !!(name && createdMs && newest > createdMs) };
}

const stateDirCache = new Map();
function hasStateOnDisk(root, names) {
  if (!root) return false;
  if (stateDirCache.has(root)) return stateDirCache.get(root);
  const hit = names.some(f => { try { return fs.statSync(path.join(root, f)).isFile(); } catch { return false; } });
  stateDirCache.set(root, hit);
  return hit;
}

/**
 * THE PRECONDITION, three parts, all required: a named state/handoff file exists in the project; THIS
 * session authored a doc there >= minStateBytes (mtime is not authorship: a neighbour sharing the repo
 * would pass it); and a named state file changed after this session started. -> { ok, why }.
 */
function stateGate(s, cfg, opts = {}) {
  const root = s.projectPath || s.cwd;
  const f = stateFreshness(root, ms(s.createdAt), cfg.stateFiles);
  if (!f.name) return { ok: false, why: `no ${cfg.stateFiles.join('/')} in ${path.basename(root || '?')} at all — everything this session knows exists only in the conversation` };
  // the cheap mtime test first; the transcript scan (authorship) only when it could still pass
  if (!f.fresh) return { ok: false, why: `${f.name} predates this session (${f.mtime ? iso(f.mtime).slice(0, 16) : '?'}) — this session's work is not on disk, so a summary would be the only copy` };
  const w = sessionWroteState(s, cfg, opts);
  if (!w.ok) return { ok: false, why: `${f.name} changed, but THIS session did not write its state — ${w.why} (a shared repo makes a neighbour look like authorship)` };
  return { ok: true, why: w.why };
}

// ---------------------------------------------------------------- classification
/**
 * NARROW vs BROAD awaiting, never conflated: 'narrow' = the session's own flags (the app's awaiting dot or an
 * unanswered AskUserQuestion); 'broad' = only how its last turn ended. Flags ABSENT (not false) read as narrow:
 * unknown must not read as "not waiting".
 */
function awaitingSignal(s) {
  if (s.awaiting === undefined && s.pending === undefined) return 'narrow';
  if (s.awaiting || s.asked_user_question) return 'narrow';
  if (['asks', 'unanswered', 'buried'].includes(s.pending)) return 'broad';
  return null;
}

/** Has the transcript GROWN since the index recorded it? Movement is the tell — a stale awaiting flag is overridden only by it. */
function movedSinceIndex(s) {
  try {
    if (!s.bytes || !s.cli) return { moved: false, grew: 0 };
    const f = require('./transcripts').findTranscript(s.cli, s.slug);
    const now = f ? fs.statSync(f).size : 0;
    return { moved: now > s.bytes, grew: now - s.bytes };
  } catch { return { moved: false, grew: 0 }; }
}

const lastMs = s => ms(s.last) || ms(s.last_user_ts) || 0;

/** One verdict per session. Guards first: being over the threshold is a cost, being mid-send is a loss. */
function classify(s, cfg, now, opts = {}) {
  const tok = s.est_ctx_tokens || 0, comp = s.compactions || 0;
  const last = lastMs(s);
  const idleD = last ? (now - last) / DAY : 1e9;
  if (s.running || s.pending === 'running') return { verdict: 'HOLD-RUNNING', why: 'mid-turn; never compact a session that may be mid-send or mid-deploy' };
  const sig = awaitingSignal(s);
  if (sig && !opts.moved) {
    return sig === 'narrow'
      ? { verdict: 'HOLD-AWAITING', why: 'its own flag says it asked you something; compaction could summarise the question away' }
      : { verdict: 'HOLD-ASK-PENDING', why: 'its last turn ENDED on an ask (weaker than its own flag); held, and counted apart from HOLD-AWAITING' };
  }
  if (tok < cfg.tightTokens) return { verdict: 'OK', why: `under ${k(cfg.tightTokens)}k` };
  if (idleD >= cfg.dormantDays) return { verdict: 'ARCHIVE', why: `dormant ${Math.floor(idleD)}d with ${k(tok)}k tokens — archive it; compacting a session nobody reopens buys nothing` };
  if (tok < cfg.fullTokens) return { verdict: 'OK', why: `${k(tok)}k, under the ${k(cfg.fullTokens)}k threshold and active` };
  if (s.pending === 'ended') return { verdict: 'NEW-SESSION', why: `task ended at ${k(tok)}k — the next task starts a NEW session, not a summary of this one` };
  const g = (opts.stateGate || stateGate)(s, cfg);
  if (!g.ok) return { verdict: 'WRITE-STATE-FIRST', why: g.why };
  if (comp >= cfg.maxCompactions) return { verdict: 'ROTATE', why: `already compacted ${comp} times — rotate to a fresh session with a written handover` };
  return { verdict: 'COMPACT', why: `mid-task at ${k(tok)}k, ${comp} prior compaction(s), state on disk (${g.why})` };
}

/** Where a COMPACT session sits in its cache window: ready | too-early | cold | unknown. */
function compactWindow(w, cfg) {
  if (!w || !w.known) return { window: 'unknown', why: 'cache state unknown (no model reply found) — never compacted on a guess' };
  if (!w.warm || w.ageMin >= cfg.compactUntilMinutes) return { window: 'cold', why: `cold (${w.ageMin} min since its last reply) — compacting now re-reads the whole context uncached; compact at the end of its next warm window` };
  if (w.ageMin < cfg.compactFromMinutes) return { window: 'too-early', why: `warm, idle ${w.ageMin} min — compacted in its last warm cycle (${cfg.compactFromMinutes}–${cfg.compactUntilMinutes} min)` };
  return { window: 'ready', why: `warm, idle ${w.ageMin} min — its last warm cycle` };
}

function defaultWarmth(s, cfg) {
  const wakes = require('./wakes');
  const f = s.cli ? require('./transcripts').findTranscript(s.cli, s.slug) : null;
  return f ? wakes.warmthOfFile(f, { windowMin: cfg.windowMinutes }) : { known: false, warm: false };
}

/**
 * scan(deps) -> h. deps: index, now, settings, stateGate(s, cfg), warmth(s, cfg), moved(s).
 * Throws IndexUnreadable rather than reporting zeros: "0 sessions, COMPACT 0" from a failed read looks
 * exactly like a healthy empty estate.
 */
function scan(deps = {}) {
  const cfg = deps.cfg || settings(deps.settings || {});
  const now = deps.now || Date.now();
  const ix = deps.index !== undefined ? deps.index : require('./projects').read();
  if (!ix || !ix.sessions || !Object.keys(ix.sessions).length) {
    throw new IndexUnreadable('the project index is missing, unreadable or holds no sessions — refusing to report zeros that would look like a healthy empty estate');
  }
  const items = [];
  for (const s of Object.values(ix.sessions)) {
    if (!s || s.archived || !s.in_sidebar) continue;          // Desktop sessions only: the ones that can be compacted or archived
    const sig = awaitingSignal(s);
    const mv = sig ? (deps.moved || movedSinceIndex)(s) : { moved: false, grew: 0 };
    const v = classify(s, cfg, now, { moved: mv.moved, stateGate: deps.stateGate });
    const last = lastMs(s);
    const it = { id: s.id, title: String(s.title || '').slice(0, 90), project: s.project || '', group: s.group || '',
      tokens: s.est_ctx_tokens || 0, compactions: s.compactions || 0, pending: s.pending || null,
      idle_days: last ? +((now - last) / DAY).toFixed(1) : null, verdict: v.verdict, why: v.why,
      awaiting_signal: sig, awaiting_stale: !!(mv.moved && sig), grew_bytes: mv.grew || 0 };
    if (v.verdict === ACTIONABLE) {
      let w; try { w = (deps.warmth || defaultWarmth)(s, cfg); } catch { w = { known: false }; }
      it.warmth = { known: !!w.known, warm: !!w.warm, ageMin: w.ageMin != null ? w.ageMin : null, minutesLeft: w.minutesLeft != null ? w.minutesLeft : null };
      Object.assign(it, (({ window, why }) => ({ compact_window: window, compact_window_why: why }))(compactWindow(w, cfg)));
    }
    items.push(it);
  }
  items.sort((a, b) => (ORDER.indexOf(a.verdict) - ORDER.indexOf(b.verdict)) || (b.tokens - a.tokens));
  const counts = {}, tokens = {};
  for (const i of items) { counts[i.verdict] = (counts[i.verdict] || 0) + 1; tokens[i.verdict] = (tokens[i.verdict] || 0) + i.tokens; }
  return { at: iso(now), now, cfg, index_at: ix.builtAt || null, items, counts, tokens, live: items.length,
    total_tokens: items.reduce((n, i) => n + i.tokens, 0), sessions: ix.sessions };
}

/**
 * WHICH gate produced the COMPACT number. "0 because nothing is over threshold and idle" is healthy;
 * "0 because the state check rejects everything" is the feature switched off. From outside they are the
 * same number, so the report prints the funnel, never a bare count.
 */
function funnel(h) {
  const c = {};
  for (const v of ORDER) c[v] = 0;
  for (const i of h.items) c[i.verdict] = (c[i.verdict] || 0) + 1;
  const reached = c['WRITE-STATE-FIRST'] + c.ROTATE + c.COMPACT;
  h.funnel = { gates: c, reached_state_gate: reached, rejected_by_state: c['WRITE-STATE-FIRST'], eliminated_upstream: h.live - reached,
    verdict: reached === 0 ? 'nothing reached the state gate — upstream conditions are doing the zeroing'
      : c.COMPACT === 0 ? `the STATE CHECK is doing the zeroing: ${c['WRITE-STATE-FIRST']} of ${reached} that reached it were rejected`
      : `${c.COMPACT} passed every gate` };
  return h.funnel;
}

/** Over the threshold and the project holds NO state file at all: they can neither be compacted nor lost safely. */
function nothingWrittenDown(h) {
  const out = [];
  for (const s of Object.values(h.sessions || {})) {
    if (!s || s.archived || !s.in_sidebar || (s.est_ctx_tokens || 0) < h.cfg.fullTokens) continue;
    if (!hasStateOnDisk(s.projectPath || s.cwd, h.cfg.stateFiles)) {
      out.push({ id: s.id, tokens: s.est_ctx_tokens || 0, title: String(s.title || '').slice(0, 70), project: s.project || '?' });
    }
  }
  out.sort((a, b) => b.tokens - a.tokens);
  h.no_state = out;
  return out;
}

// ---------------------------------------------------------------- memory: events, verification
function loadState() { return readJson(STATE(), {}) || {}; }
function saveState(st) { try { writeAtomic(STATE(), JSON.stringify(st, null, 1)); } catch {} }
function appendEvents(evs) {
  if (!evs.length) return;
  try { fs.mkdirSync(DIR(), { recursive: true }); fs.appendFileSync(EVENTS(), evs.map(e => JSON.stringify(e)).join('\n') + '\n'); } catch {}
}

/**
 * What CHANGED since the last scan (verdict moves, compactions), and the deferred verification of our own
 * /compact sends: a send is VERIFIED when the compaction count rose, and a SILENT FAILURE when it has not
 * after verifyAfterHours. Keeps every other key in the state file.
 */
function diffAndRecord(h) {
  const st = loadState();
  const prev = st.sessions || {};
  const seeded = !st.sessions;
  const t = h.at, events = [], cur = {};
  st.compacted = st.compacted || {}; st.verified = st.verified || {};
  for (const i of h.items) {
    cur[i.id] = { verdict: i.verdict, tokens: i.tokens, compactions: i.compactions };
    const p = prev[i.id];
    if (!seeded && p) {
      if (p.verdict !== i.verdict) events.push({ ts: t, id: i.id, kind: 'verdict', what: `${p.verdict} -> ${i.verdict}  ${i.title.slice(0, 60)}` });
      if ((i.compactions || 0) > (p.compactions || 0)) events.push({ ts: t, id: i.id, kind: 'compacted', what: `${k(p.tokens)}k -> ${k(i.tokens)}k  ${i.title.slice(0, 60)}` });
    }
    const sent = st.compacted[i.id];
    if (sent && !st.verified[i.id] && (i.compactions || 0) > (sent.compactionsBefore || 0)) {
      st.verified[i.id] = t;
      events.push({ ts: t, id: i.id, kind: 'compact-verified', what: `our /compact of ${String(sent.at).slice(0, 16)} took: ${k(sent.tokensBefore)}k -> ${k(i.tokens)}k` });
    }
  }
  if (seeded) events.push({ ts: t, id: '-', kind: 'seeded', what: `first scan: ${h.live} live, ${(h.total_tokens / 1e6).toFixed(1)}M tokens, `
    + Object.entries(h.counts).sort().map(([a, b]) => `${a} ${b}`).join(', ') });
  // silent failures, reported once each
  const byId = new Map(h.items.map(i => [i.id, i]));
  const cut = h.now - h.cfg.verifyAfterHours * H;
  h.unverified = [];
  for (const [sid, sent] of Object.entries(st.compacted)) {
    if (st.verified[sid] || ms(sent.at) > cut) continue;          // verified, or too early to judge
    const i = byId.get(sid);
    const row = { id: sid, sent: sent.at, tokens: i ? i.tokens : sent.tokensBefore, title: i ? i.title : sent.title || '', compactions: i ? i.compactions : null };
    h.unverified.push(row);
    if (!sent.reported) {
      sent.reported = t;
      events.push({ ts: t, id: sid, kind: 'compact-unverified', what: `/compact sent ${String(sent.at).slice(0, 16)}, no compaction after ${h.cfg.verifyAfterHours}h — a send that did not take; do not re-send blindly` });
    }
  }
  st.at = t; st.sessions = cur;
  saveState(st);
  appendEvents(events);
  h.events_now = events;
  return events;
}

function recentEvents(now, hours = 24) {
  const cut = now - hours * H, out = [];
  let text = '';
  try { text = fs.readFileSync(EVENTS(), 'utf8'); } catch { return out; }
  for (const ln of text.split('\n')) {
    if (!ln.trim()) continue;
    try { const e = JSON.parse(ln); if (ms(e.ts) >= cut) out.push(e); } catch {}
  }
  return out;
}

// ---------------------------------------------------------------- auto-compact
/** Which COMPACT sessions may be compacted THIS cycle, and why each other one is held. Pure. */
function compactPlan(h, st = loadState()) {
  const cfg = h.cfg;
  const ready = [], held = [];
  const sent = st.compacted || {}, failed = st.failed || {};
  for (const i of h.items) {
    if (i.verdict !== ACTIONABLE) continue;
    const s = sent[i.id];
    if (s && h.now - ms(s.at) < cfg.recompactHours * H) { held.push({ id: i.id, why: `compacted ${Math.round((h.now - ms(s.at)) / M)} min ago — never twice inside ${cfg.recompactHours}h` }); continue; }
    const f = failed[i.id];
    if (f && h.now - ms(f.at) < cfg.retryFailedMinutes * M) { held.push({ id: i.id, why: `last attempt failed (${f.result}) ${Math.round((h.now - ms(f.at)) / M)} min ago` }); continue; }
    if (!String(i.id).startsWith('local_')) { held.push({ id: i.id, why: 'not a Desktop session; there is no composer to type into' }); continue; }
    if (i.compact_window !== 'ready') { held.push({ id: i.id, why: i.compact_window_why || 'cache window unknown' }); continue; }
    ready.push(i);
  }
  ready.sort((a, b) => b.tokens - a.tokens);
  return { ready, held };
}

/** The app's own answer: { state: idle | running | awaiting | archived | gone | unknown, confirmed }. */
async function defaultConfirm(sessionId) {
  try {
    const st = await require('./bridge').listStates([sessionId]);
    const s = st && st[sessionId];
    if (!s) return { state: 'gone', confirmed: true };
    if (s.isArchived) return { state: 'archived', confirmed: true };
    if (s.isRunning) return { state: 'running', confirmed: true };
    if (s.pendingUserInput) return { state: 'awaiting', confirmed: true };
    return { state: 'idle', confirmed: true };
  } catch (e) { return { state: 'unknown', confirmed: false, reason: e.message }; }
}

/**
 * Type /compact into the session's composer and press Send. The composer, never a message: typeSlashCommand
 * proves the app offered and anchored it as a COMMAND. Refuses a session that is mid-turn or already has a
 * queued message — /compact is never queued behind live work.
 */
async function composerCompact(sessionId) {
  const desktop = require('./desktop');
  const goal = require('./goal');
  const conn = await desktop.connect(await desktop.wsUrl(), { evalTimeout: 20000 });
  let CID = null, original = null;
  const giveBack = async () => {
    await desktop.releaseComposer(conn, CID).catch(() => {});
    if (original) await desktop.restoreActive(conn, CID, original).catch(() => {});
  };
  const wipe = () => conn.evaluate(desktop.rEval(CID, '(function(){ try{ window.__batonComposer.editor.commands.clearContent(); }catch(e){} return 1; })()')).catch(() => {});
  try {
    CID = await desktop.pickChat(conn);
    const open = await desktop.ensureSessionOpen(conn, CID, sessionId, {});
    if (!open || !open.ok) return { ok: false, result: (open && open.error) || 'nav-failed', route: COMPACT_ROUTE };
    original = open.restore || null;
    await desktop.dismissStrayMenus(conn, CID);
    const park = await desktop.parkComposer(conn, CID, sessionId);
    if (park !== 'ok') {
      const cover = desktop.classifyCover(park);
      await giveBack();
      return { ok: false, result: cover ? cover.result : String(park), route: COMPACT_ROUTE };
    }
    const busy = await conn.evaluate(desktop.rEval(CID, `(function(){
      if(window.__batonLiveBtn('Remove queued message')) return 'queued';
      return window.__batonLiveBtn('Stop') ? 'busy' : 'idle';
    })()`));
    if (busy !== 'idle') { await giveBack(); return { ok: false, result: busy === 'busy' ? 'running' : 'queue-occupied', route: COMPACT_ROUTE }; }
    const typed = await goal.typeSlashCommand(conn, CID, sessionId, 'compact', '');
    if (!typed.ok) { await wipe(); await giveBack(); return { ok: false, result: typed.result, typed, route: COMPACT_ROUTE }; }
    const sent = await goal.pressSend(conn, CID, sessionId);
    if (!sent.ok) { await wipe(); await giveBack(); return { ok: false, result: sent.result, route: COMPACT_ROUTE }; }
    await giveBack();
    return { ok: true, result: 'sent', route: COMPACT_ROUTE };
  } finally { try { conn.close(); } catch {} }
}

function defaultIsIdle() {
  const secs = Number((config.get() || {}).idleGateSeconds);
  if (!(secs > 0)) return true;
  try { return require('./desktop').isIdle(secs * 1000); } catch { return false; }
}

/**
 * Send /compact to this cycle's ready sessions, at most compactPerCycle. Live re-checks at the moment of
 * sending, in this order (the order is the point): user idle; STATE ON DISK re-read fresh (the index can be
 * 30 min old); the APP confirms idle (running / awaiting / unknown all refuse — silence is never consent).
 * deps: send (default true), cap, confirm(id), compact(id), isIdle(), stateGate(s, cfg, {fresh}), logWake(rec).
 */
async function doCompact(h, deps = {}) {
  const cfg = h.cfg;
  const cap = deps.cap != null ? deps.cap : cfg.compactPerCycle;
  const st = loadState();
  const plan = compactPlan(h, st);
  const out = { ready: plan.ready.length, held: plan.held.slice(), sent: [], failed: [], dryRun: deps.send === false };
  const confirm = deps.confirm || defaultConfirm;
  const compact = deps.compact || composerCompact;
  const isIdle = deps.isIdle || defaultIsIdle;
  const gate = deps.stateGate || stateGate;
  const log = deps.logWake || require('./wakes').logWake;
  const events = [];
  for (const i of plan.ready.slice(0, Math.max(0, cap))) {
    const s = (h.sessions || {})[i.id] || { id: i.id };
    if (deps.send === false) { out.held.push({ id: i.id, why: 'dry run — would send /compact' }); continue; }
    if (!isIdle()) { out.held.push({ id: i.id, why: 'you are using the computer; typing into the Desktop waits for an idle moment' }); continue; }
    const g = gate(s, cfg, { fresh: true });
    if (!g.ok) { out.held.push({ id: i.id, why: 'state not on disk at send time — ' + g.why }); continue; }
    let c;
    try { c = await confirm(i.id); } catch (e) { c = { state: 'unknown', confirmed: false, reason: e.message }; }
    if (!c || !c.confirmed) { out.held.push({ id: i.id, why: 'the app did not confirm it is idle — assumed, not observed; refusing to compact' }); continue; }
    if (c.state !== 'idle') { out.held.push({ id: i.id, why: `live state is ${c.state} — not compacted` }); continue; }
    let r;
    try { r = await compact(i.id); } catch (e) { r = { ok: false, result: 'threw: ' + e.message }; }
    if (r && r.ok) {
      st.compacted = st.compacted || {};
      st.compacted[i.id] = { at: iso(h.now), compactionsBefore: i.compactions || 0, tokensBefore: i.tokens, title: i.title };
      if (st.failed) delete st.failed[i.id];
      if (st.verified) delete st.verified[i.id];
      out.sent.push({ id: i.id, tokens: i.tokens });
      events.push({ ts: h.at, id: i.id, kind: 'compact-sent', what: `/compact typed at ${k(i.tokens)}k (${i.compact_window_why}); verified when the compaction count rises` });
      try { log({ to: i.id, kind: 'compact', sender: 'relaymote:compact', warmth: { known: i.warmth && i.warmth.known, warm: i.warmth && i.warmth.warm, ageMin: i.warmth && i.warmth.ageMin }, what: '/compact' }); } catch {}
    } else {
      const res = (r && r.result) || 'failed';
      st.failed = st.failed || {};
      st.failed[i.id] = { at: iso(h.now), result: res };
      out.failed.push({ id: i.id, result: res });
      events.push({ ts: h.at, id: i.id, kind: 'compact-failed', what: `/compact NOT sent: ${res}` });
    }
  }
  for (const i of plan.ready.slice(Math.max(0, cap))) out.held.push({ id: i.id, why: `over the cap of ${cap} per cycle` });
  if (deps.send !== false) saveState(st);
  appendEvents(events);
  return out;
}

// ---------------------------------------------------------------- report
const EXPLAIN = {
  COMPACT: 'Mid-task, over the threshold, state authored on disk, under the compaction limit. THE ONLY VERDICT EVER ACTED ON AUTOMATICALLY — and only in its last warm cycle.',
  'WRITE-STATE-FIRST': 'Over the threshold, but this session\'s state is not written down (or not by it, or not since it started). Compaction summarises — write the state BEFORE, never after.',
  ROTATE: 'Already compacted the maximum number of times. A summary of a summary keeps almost nothing: start a fresh session with a written handover.',
  'NEW-SESSION': 'The task ENDED. Nothing here needs carrying forward; the next task starts clean rather than inheriting a summary.',
  ARCHIVE: 'Dormant past the limit. NOT to be compacted — summarising a session nobody reopens destroys the record and buys nothing. Archived only with your approval (ARCHIVE-CANDIDATES.md).',
  'HOLD-AWAITING': 'Its OWN flags say it asked you something (the NARROW definition). The question is short and recent, exactly what a summary drops. Answer it, then reconsider.',
  'HOLD-ASK-PENDING': 'Its last turn merely ENDED on an ask (the BROAD definition — much weaker; a turn that happened to end on the assistant looks identical). Held, but never added to HOLD-AWAITING.',
  'HOLD-RUNNING': 'Mid-turn, so possibly mid-send or mid-deploy. Never compacted.',
  OK: 'Under the threshold.',
};

function wakesSummary(now) {
  try {
    const W = require('./wakes');
    const fwd = W.forwardLog({ hours: 24, now });
    const last = W.lastRollup();
    return { baton24: fwd.total, byKind: fwd.byKind,
      lastDay: last ? { at: last.at, wakes: last.wakes, warm: last.warm, cold: last.cold, coldBySender: Object.fromEntries(Object.entries(last.coldBySender || {}).slice(0, 5)),
        cacheTokens: last.cacheTokens || null } : null };
  } catch (e) { return { error: e.message }; }
}

function writeReport(h, events24, extra = {}) {
  const cfg = h.cfg;
  const by = {};
  for (const i of h.items) (by[i.verdict] = by[i.verdict] || []).push(i);
  const L = [`# Context hygiene — ${h.at.slice(0, 16)} UTC`, ''];
  L.push(`${h.live} live Desktop sessions holding **${(h.total_tokens / 1e6).toFixed(1)}M** estimated tokens. Threshold ${k(cfg.fullTokens)}k; dormant past ${cfg.dormantDays}d.`
    + (h.index_at ? ` Index built ${h.index_at.slice(0, 16)} UTC.` : ''));
  L.push('Token counts are a byte ESTIMATE (a hint, not a liveness signal); compactions are the ground truth.', '');
  const nN = h.items.filter(i => i.awaiting_signal === 'narrow').length, nB = h.items.filter(i => i.awaiting_signal === 'broad').length;
  L.push('AWAITING IS COUNTED TWO WAYS — never quote the union:', `- NARROW (the session's own flags): **${nN}**`, `- BROAD (the last turn merely ended on an ask): **${nB}** more`, '');
  const f = h.funnel || {};
  L.push('WHY THAT COMPACT NUMBER — a bare count cannot tell "healthy" from "switched off":',
    `- eliminated before the state gate (running / awaiting / under threshold / dormant / ended): **${f.eliminated_upstream || 0}**`,
    `- REACHED the state gate: **${f.reached_state_gate || 0}**, of which the state check rejected **${f.rejected_by_state || 0}**`,
    `- so: ${f.verdict || ''}`, '');
  L.push('Compaction is LOSSY, so most of what is over the threshold must NOT be compacted:');
  for (const v of ORDER) if (by[v]) L.push(`- **${v.padEnd(17)} ${String(by[v].length).padStart(3)} sessions, ${((h.tokens[v] || 0) / 1e6).toFixed(1).padStart(6)}M tokens**`);
  L.push('');
  const c = extra.compact;
  L.push(`## Auto-compact this cycle — ${cfg.autoCompact ? 'ON' : 'off (module autoCompact)'}`);
  if (c) {
    L.push(`${c.ready} ready in their last warm cycle; sent ${c.sent.length}, failed ${c.failed.length}, held ${c.held.length}.`);
    for (const s of c.sent) L.push(`- sent /compact to ${s.id} (${k(s.tokens)}k)`);
    for (const s of c.failed) L.push(`- FAILED ${s.id}: ${s.result}`);
    for (const s of c.held.slice(0, 15)) L.push(`- held ${s.id}: ${s.why}`);
  } else L.push('No sends. COMPACT sessions and where each sits in its cache window are listed below.');
  L.push('');
  const ns = h.no_state || [];
  if (ns.length) {
    L.push(`## NOTHING WRITTEN DOWN (${ns.length} sessions, ${(ns.reduce((n, i) => n + i.tokens, 0) / 1e6).toFixed(1)}M tokens)`,
      'Over the threshold and their project carries NO state file at all. Everything they know exists only in the conversation, so they can '
      + 'neither be compacted safely nor lost safely. The answer is not a looser guard — it is writing the state down, which is cheap.');
    for (const i of ns.slice(0, 25)) L.push(`- ${i.id.slice(0, 20)} ${String(k(i.tokens)).padStart(6)}k  ${i.project.slice(0, 16).padEnd(16)} ${i.title.slice(0, 56)}`);
    if (ns.length > 25) L.push(`- … and ${ns.length - 25} more`);
    L.push('');
  }
  const stale = h.items.filter(i => i.awaiting_stale);
  L.push(`## Awaiting flags overridden by movement (${stale.length})`,
    'The flag said "waiting on you" and the transcript has GROWN since the index recorded it, so the session has taken turns. Movement is the tell — never merely being open.');
  for (const i of stale) L.push(`- ${i.id.slice(0, 20)} grew ${i.grew_bytes} bytes · signal was ${i.awaiting_signal} · now ${i.verdict} · ${i.title.slice(0, 50)}`);
  L.push('');
  if ((h.unverified || []).length) {
    L.push(`## SENT BUT NEVER COMPACTED (${h.unverified.length}) — a send that did not take`,
      `/compact was typed more than ${cfg.verifyAfterHours}h ago and no compaction is recorded. Do NOT re-send blindly; find out why.`);
    for (const u of h.unverified) L.push(`- ${u.id.slice(0, 20)} ${String(k(u.tokens)).padStart(6)}k  sent ${String(u.sent).slice(0, 16)}  ${u.title.slice(0, 56)}`);
    L.push('');
  }
  L.push(`## Changed in the last 24 h (${events24.length})`);
  if (!events24.length) L.push('nothing moved — every session is in the same condition as the last scan');
  for (const e of events24.slice().sort((a, b) => String(b.ts).localeCompare(String(a.ts))).slice(0, 40)) {
    L.push(`- ${String(e.ts).slice(5, 16).replace('T', ' ')} ${String(e.kind).padEnd(18)} ${String(e.what || '').slice(0, 130)}`);
  }
  L.push('');
  for (const v of ORDER) {
    const rows = by[v] || [];
    if (!rows.length && v === 'OK') continue;
    L.push(`## ${v} (${rows.length}, ${((h.tokens[v] || 0) / 1e6).toFixed(1)}M tokens)`, EXPLAIN[v] || '');
    if (v !== 'OK') {
      for (const i of rows.slice(0, 40)) {
        L.push(`- ${i.id.slice(0, 20)} ${String(k(i.tokens)).padStart(6)}k  idle ${(i.idle_days != null ? i.idle_days + 'd' : '?').padEnd(6)} ${(i.project || '').slice(0, 16).padEnd(16)} ${i.title.slice(0, 64)}`);
        L.push(`    ${i.why}${i.compact_window_why ? ' · ' + i.compact_window_why : ''}`);
      }
      if (rows.length > 40) L.push(`- … and ${rows.length - 40} more`);
    }
    L.push('');
  }
  const slimItems = h.items;
  const json = { generator: 'relaymote', at: h.at, index_at: h.index_at, counts: h.counts, tokens: h.tokens, live: h.live, total_tokens: h.total_tokens,
    awaiting: { narrow: nN, broad: nB }, no_state: ns, funnel: h.funnel || {}, unverified: h.unverified || [], compact: c || null,
    events24, wakes: extra.wakes || null, archive: extra.archive || null, items: slimItems,
    cfg: { fullTokens: cfg.fullTokens, tightTokens: cfg.tightTokens, dormantDays: cfg.dormantDays, maxCompactions: cfg.maxCompactions,
      compactPerCycle: cfg.compactPerCycle, compactFromMinutes: cfg.compactFromMinutes, compactUntilMinutes: cfg.compactUntilMinutes,
      verifyAfterHours: cfg.verifyAfterHours, recompactHours: cfg.recompactHours, minStateBytes: cfg.minStateBytes, stateFiles: cfg.stateFiles, autoCompact: cfg.autoCompact } };
  const md = L.join('\n') + '\n';
  writeAtomic(REPORT_MD(), md);
  writeAtomic(REPORT_JSON(), JSON.stringify(json, null, 1));
  // The board reads hygiene.json from its own folder first, so a copy goes there when the board is on.
  if (config.mod('board') || extra.boardDir) {
    try {
      const bdir = extra.boardDir || (((config.get() || {}).board || {}).dir) || path.join(config.DATA, 'board');
      writeAtomic(path.join(bdir, 'hygiene.json'), JSON.stringify(json, null, 1));
    } catch {}
  }
  return { md, json };
}

// ---------------------------------------------------------------- the cycle
let lastRunAt = 0;
/**
 * One hygiene pass: scan, funnel, nothing-written-down, diff + verification, auto-compact (when the module
 * is on), the daily wake roll-up, archive candidates, then HYGIENE.md / hygiene.json. deps pass through to
 * scan() and doCompact(); deps.force ignores the interval. Returns a small result for the daemon log.
 */
async function cycle(deps = {}) {
  const now = deps.now || Date.now();
  if (!deps.force && deps.module !== true && !config.mod('hygiene')) return { skipped: 'module off' };
  const cfg = settings(deps.settings || {});
  if (!deps.force && lastRunAt && now - lastRunAt < (Number(cfg.intervalMinutes) || 30) * M - 30000) return { skipped: 'interval' };
  lastRunAt = now;
  let h;
  try { h = scan({ ...deps, cfg, now }); }
  catch (e) { if (e instanceof IndexUnreadable) return { ok: false, error: 'HYGIENE DID NOT RUN: ' + e.message }; throw e; }
  funnel(h);
  nothingWrittenDown(h);
  diffAndRecord(h);
  let compact = null;
  if (cfg.autoCompact) {
    const indexAgeMin = h.index_at ? (now - ms(h.index_at)) / M : Infinity;
    if (indexAgeMin > 3 * (Number(cfg.intervalMinutes) || 30)) compact = { ready: 0, sent: [], failed: [], held: [{ id: '-', why: `the index is ${Math.round(indexAgeMin)} min old — no compaction on a stale picture` }] };
    else compact = await doCompact(h, deps);
  }
  let rollup = null;
  if (deps.rollup !== false) { try { rollup = require('./wakes').rollup({ now }); } catch {} }
  let archive = null;
  if (deps.archive !== false) {
    try {
      const a = require('./archive').report({ index: deps.index, now });
      archive = { count: a.count, byReason: (a.readyCalls || []).reduce((o, c) => (o[c.reason] = c.session_ids.length, o), {}), report: a.report };
    } catch (e) { archive = { error: e.message }; }
  }
  const wakes = deps.rollup === false ? null : wakesSummary(now);
  writeReport(h, recentEvents(now, 24), { compact, wakes, archive, boardDir: deps.boardDir });
  return { ok: true, at: h.at, live: h.live, counts: h.counts, compact: compact && { sent: compact.sent.length, failed: compact.failed.length, held: compact.held.length },
    failures: compact ? compact.failed : [], unverified: (h.unverified || []).length, newUnverified: (h.events_now || []).filter(e => e.kind === 'compact-unverified').map(e => e.id),
    rollup: !!rollup, archive: archive && archive.count };
}

function read() { return readJson(REPORT_JSON(), null); }

// ---------------------------------------------------------------- command line (`relaymote hygiene …`)
const USAGE = `relaymote hygiene                       write HYGIENE.md + hygiene.json now and print the summary
relaymote hygiene compact [--send] [--cap N]   which COMPACT sessions are in their last warm cycle; --send types /compact
relaymote hygiene show                  print the last HYGIENE.md
relaymote archive-candidates [days]     write ARCHIVE-CANDIDATES.md (never archives; default ${config.DEFAULTS.archive.idleDays} days)
relaymote wakes [hours]                 wakes measured in the transcripts: warm vs cold, cold ones by sender
relaymote wakes log [hours]             wakes Relaymote itself sent, by kind, and the warmth each went at
relaymote wakes rollup [--force]        append today's line to wakes-daily.jsonl`;

async function cli(argv, io = {}) {
  const say = io.log || console.log;
  const sub = argv[0] || '';
  if (sub === 'help' || sub === '-h') return say(USAGE);
  if (sub === 'show') { try { return say(fs.readFileSync(REPORT_MD(), 'utf8')); } catch { return say('no HYGIENE.md yet — run `relaymote hygiene`'); } }
  if (sub === 'compact') {
    const cap = argv.includes('--cap') ? Number(argv[argv.indexOf('--cap') + 1]) : undefined;
    let h;
    try { h = scan(); } catch (e) { return say('HYGIENE DID NOT RUN: ' + e.message); }
    const r = await doCompact(h, { send: argv.includes('--send'), cap });
    say(`${r.ready} ready in their last warm cycle; ${r.dryRun ? 'dry run (add --send)' : `sent ${r.sent.length}, failed ${r.failed.length}`}`);
    for (const s of r.sent) say(`  sent /compact to ${s.id} (${k(s.tokens)}k)`);
    for (const s of r.failed) say(`  FAILED ${s.id}: ${s.result}`);
    for (const s of r.held.slice(0, 20)) say(`  held ${s.id}: ${s.why}`);
    return r;
  }
  const r = await cycle({ force: true, module: true });
  if (!r.ok) return say(r.error || JSON.stringify(r));
  say(`hygiene: ${r.live} live; ${Object.entries(r.counts).sort().map(([a, b]) => `${a} ${b}`).join(', ')}`);
  say(`written: ${REPORT_MD()}`);
  return r;
}

module.exports = {
  ACTIONABLE, ORDER, COMPACT_ROUTE, EXPLAIN, IndexUnreadable, REPORT_MD, REPORT_JSON, STATE, EVENTS,
  settings, writtenPaths, sessionWroteState, stateFreshness, stateGate, hasStateOnDisk, awaitingSignal, movedSinceIndex,
  classify, compactWindow, scan, funnel, nothingWrittenDown, diffAndRecord, recentEvents, compactPlan, doCompact,
  composerCompact, defaultConfirm, writeReport, cycle, read, cli, USAGE, loadState,
};
