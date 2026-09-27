// transcripts.js — what each Claude Code transcript says, read incrementally and cheaply.
//
// One record per transcript (~/.claude/projects/<slug>/<cli uuid>.jsonl): title, first/last prompts,
// compactions, skills used, API errors, model, the final answer of the last turn, who spoke last,
// the live-context byte count, and the BURIED-question bookkeeping (the assistant asked, no human
// answered, and a relay/notice landed after it so the ask scrolled out of sight).
//
// Cheap by construction: the parser is RESUMABLE. Its state is saved with the byte offset it reached,
// so a transcript that grew is read only from that offset on (a fingerprint of the bytes just before
// the offset proves the file was appended to, not rewritten). A file that shrank or whose fingerprint
// moved is re-read from zero. Most lines are classified from their first 800 bytes without a JSON
// parse; only human turns, titles and the final assistant text are parsed.
//
// The byte-derived context estimate is a HINT, never a liveness signal: image and attachment traffic
// inflates it by orders of magnitude. The compaction count is the ground truth that a session really
// filled its window; both are exposed and labelled.
'use strict';
const fs = require('fs');
const path = require('path');
const config = require('./config');

// ------------------------------------------------------------------ configurable vocab
// Generic defaults. Personal / business vocabulary never goes here: add it in settings.index.*.
const DEFAULT_CRITICAL = ['delete', 'deleting', 'archive', 'drop table', 'wipe', 'pay', 'payment', 'paid', 'money',
  'price', 'pricing', 'refund', 'purchase', 'buy', 'publish', 'go live', 'deploy to prod', 'deploy to production',
  'password', 'credential', 'api key', 'secret', 'irreversible', 'cannot be undone', 'overwrite', 'reset',
  'uninstall', 'format', 'send it to', 'send this to', 'send them to', 'email it to', 'email this to'];

// A user turn that no human typed: relays from other sessions, Relaymote's own notices, subagent
// completions, Desktop notices. When one lands after an ask, the ask is BURIED.
const DEFAULT_NOTICES = ['<cross-session-message', 'Another Claude session sent a message', '<task-notification>',
  '\\[(?:Relaymote|Baton)\\b', '<local-command-caveat>', '<local-command-stdout>', 'The user started your suggested background task',
  '<ci-monitor-event', 'From [^\\n(]{1,80}\\(session '];
const NEUTRAL_RX = /^\s*<command-(name|message)>/;
const ASK_STRICT_RX = /\b(shall i|should i|should we|do you want|would you like|want me to|say the word|say go|your call|which (one|option|of these)( do you)?|pick one|choose one|waiting for (you|your)|awaiting your|i'll wait for your|once you (confirm|approve|decide)|ready when you are|please confirm|let me know (if|which|whether|what|when)|tell me (if|whether|which|what)|ok to proceed|okay to proceed)\b/i;
const ASK_RX = /\b(shall i|should i|should we|do you want|would you like|want me to|let me know|say the word|tell me (if|whether|which|what)|please confirm|confirm (and|before|if|that|whether)|your call|which (one|option|of these)|pick one|choose one|waiting for (you|your)|awaiting your|once you (confirm|approve|decide)|if you (want|prefer|agree|approve)|ready when you are|go ahead\?|proceed\?|ok to proceed|okay to proceed|approve\b|approval)\b/i;
const OPEN_RX = /\b(next step|next steps|remaining|still (to do|left|pending)|todo|to-do|blocked|cannot|can't|unable|failed|not yet)\b/i;
const ASK_TAIL_RX = /\?\s*$/;
const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function settings() { return (config.get().index) || {}; }

let _vocab = { key: null };
/** Compiled regexes from settings (cached on the settings object identity). */
function vocab() {
  const ix = settings();
  const key = JSON.stringify([ix.criticalWords, ix.noticePatterns]);
  if (_vocab.key === key) return _vocab;
  const words = Array.isArray(ix.criticalWords) ? ix.criticalWords : DEFAULT_CRITICAL;
  const extra = [];
  for (const p of Array.isArray(ix.noticePatterns) ? ix.noticePatterns : []) {
    try { new RegExp(p); extra.push(p); } catch { /* an invalid pattern is ignored, not fatal */ }
  }
  _vocab = {
    key,
    critical: words.length ? new RegExp('\\b(' + words.map(esc).join('|') + ')\\b', 'i') : null,
    notice: new RegExp('^\\s*(' + DEFAULT_NOTICES.concat(extra).join('|') + ')', 's'),
  };
  return _vocab;
}

const NOTICE_LABEL_RX = /<cross-session-message[^>]*\bname="([^"]{1,60})"|^\s*(Another Claude session sent a message)|^\s*(<task-notification>)|^\s*(\[(?:Relaymote|Baton)\][^\n]{0,30}?update)|^\s*From ([^\n(]{1,60})\(session /s;
function noticeLabel(raw) {
  const m = NOTICE_LABEL_RX.exec(String(raw).slice(0, 600));
  if (!m) return 'a notice';
  if (m[1]) return `message from "${m[1]}"`;
  if (m[2]) return 'a message from another session';
  if (m[3]) return 'a subagent task-notification';
  if (m[4]) return 'a Relaymote fleet update';
  return `a relay from "${(m[5] || '').trim()}"`;
}

// ------------------------------------------------------------------ text helpers
function cleanPrompt(text, limit) {
  if (typeof text !== 'string') return '';
  let t = text;
  const m = /^\s*<command-message>[^<]*<\/command-message>\s*<command-name>([^<]+)<\/command-name>\s*(?:<command-args>([^<]*)<\/command-args>)?/.exec(t);
  if (m) t = (m[1] + ' ' + (m[2] || '')).trim();
  if (t.startsWith('Base directory for this skill:')) return '';
  t = t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ');
  t = t.replace(/<[^>]{1,40}>/g, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  return t.slice(0, limit);
}

function userText(msg) {
  const c = msg && msg.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter(b => b && b.type === 'text' && b.text).map(b => b.text).join('\n');
  return '';
}
const stripReminders = t => String(t || '').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ');

/** Text blocks and AskUserQuestion questions of one assistant line. */
function assistantParts(rawLine) {
  let d; try { d = JSON.parse(rawLine); } catch { return null; }
  const parts = [], qs = [];
  for (const b of (d.message && d.message.content) || []) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text' && b.text) parts.push(b.text);
    else if (b.type === 'tool_use' && b.name === 'AskUserQuestion') {
      for (const q of ((b.input || {}).questions) || []) if (q && q.question) qs.push(q.question);
    }
  }
  return { parts, qs };
}

/** If this assistant line ends its turn on a question/offer, the ask text; else null (strict). */
function assistantAsk(rawLine) {
  const p = assistantParts(rawLine);
  if (!p) return null;
  if (p.qs.length) return p.qs.join(' / ').replace(/\s+/g, ' ').slice(0, 260);
  const ft = p.parts.join(' ').replace(/\s+/g, ' ').trim();
  const tail = ft.slice(-500);
  if (!tail) return null;
  const sents = tail.split(/(?<=[.?!])\s+/);
  const ask = sents.slice(-2).join(' ').slice(-260);
  if (!(ASK_TAIL_RX.test(ask) || ASK_STRICT_RX.test(ask))) return null;
  return ask;
}

function finalText(rawLine) {
  const p = assistantParts(rawLine);
  if (!p) return '';
  return p.parts.join(' ').replace(/\s+/g, ' ').trim().slice(-900);
}

// ------------------------------------------------------------------ the resumable parser
const B = s => Buffer.from(s);
const N = { text: B('"type":"text"'), ask: B('"name":"AskUserQuestion"'), agent: B('"name":"Agent"'), skill: B('"name":"Skill"'),
  ts: B('"timestamp":"') };
const TYPE_RX = /"type":"([a-z_-]+)"/;
const ROLE_RX = /"role":"(user|assistant)"/;
const KNOWN = new Set(['ai-title', 'custom-title', 'last-prompt', 'system', 'user', 'assistant']);
const PARSER_VERSION = 1;

function newState() {
  return {
    v: PARSER_VERSION, offset: 0, size: 0, mtime: 0, fp: '',
    rec: { ai_title: null, custom_title: null, last_prompt: null, cwd: null, branch: null, first_ts: null, last_ts: null,
      last_user_ts: null, model: null, prompts: [], n_user: 0, n_assistant: 0, compactions: 0, api_errors: 0,
      agent_started: 0, skills: {}, last_role: null, n_notices: 0 },
    st: { line_no: 0, ctx: 0, last_prompt_no: -1, last_text_no: -1, last_text_final: '', last_ask_no: -1,
      pending_ask: null, open_ask: null },
  };
}

function tsOf(buf, s, e) {
  const i = buf.subarray(s, e).indexOf(N.ts);
  if (i < 0) return null;
  const a = s + i + N.ts.length;
  const z = buf.indexOf(34, a); // '"'
  return z > a && z < e ? buf.toString('utf8', a, z) : null;
}

/** Process complete lines buf[0..len). Mutates state; raw lines are kept in `live` until resolve(). */
function processLines(state, buf, live) {
  const R = state.rec, S = state.st, V = vocab();
  let i = 0;
  while (i < buf.length) {
    let e = buf.indexOf(10, i);
    if (e < 0) e = buf.length;
    const s = i; i = e + 1;
    if (e - s < 2) continue;
    const head = buf.toString('utf8', s, Math.min(e, s + 800));
    const tm = TYPE_RX.exec(head.slice(0, 200));
    let t = tm ? tm[1] : null;
    if (t === 'message' || t === null || !KNOWN.has(t)) { const rm = ROLE_RX.exec(head); t = rm ? rm[1] : t; }
    if (t === 'ai-title' || t === 'custom-title' || t === 'last-prompt') {
      try {
        const d = JSON.parse(buf.toString('utf8', s, e));
        if (t === 'ai-title') R.ai_title = d.aiTitle || R.ai_title;
        else if (t === 'custom-title') R.custom_title = d.customTitle || R.custom_title;
        else R.last_prompt = cleanPrompt(d.lastPrompt, 200) || R.last_prompt;
      } catch {}
      continue;
    }
    if (t === 'system') {
      const h = head.slice(0, 400);
      if (h.includes('"compact_boundary"')) { R.compactions++; S.ctx = 0; }
      else if (h.includes('"api_error"')) R.api_errors++;
      continue;
    }
    if (t !== 'user' && t !== 'assistant') continue;
    S.ctx += e - s + 1;
    S.line_no++;
    const ts = tsOf(buf, s, e);
    if (ts) { R.first_ts = R.first_ts || ts; R.last_ts = ts; }
    const line = buf.subarray(s, e);
    const side = head.slice(0, 120).includes('"isSidechain":true');
    if (t === 'assistant') {
      R.n_assistant++;
      if (!side) {
        R.last_role = 'assistant';
        const hasText = line.indexOf(N.text) >= 0, hasAsk = line.indexOf(N.ask) >= 0;
        if (hasText || hasAsk) {
          const raw = buf.toString('utf8', s, e);
          if (hasText) { S.last_text_no = S.line_no; live.lastText = raw; }
          if (hasAsk) S.last_ask_no = S.line_no;
          S.pending_ask = { raw, ts };
        }
      }
      if (R.model === null || R.n_assistant % 50 === 0) { const m = /"model":"([^"]+)"/.exec(head.slice(0, 600)); if (m) R.model = m[1]; }
      if (line.indexOf(N.agent) >= 0) R.agent_started++;
      if (line.indexOf(N.skill) >= 0) {
        const rx = /"name":"Skill"[^}]{0,200}?"skill":"([^"]+)"/g;
        const full = buf.toString('utf8', s, e);
        for (let m; (m = rx.exec(full));) R.skills[m[1]] = (R.skills[m[1]] || 0) + 1;
      }
      continue;
    }
    if (side) continue;
    if (R.cwd === null) {
      const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(head);
      if (m) R.cwd = m[1].replace(/\\\\/g, '\\');
      const b = /"gitBranch":"([^"]*)"/.exec(head);
      if (b) R.branch = b[1];
    }
    const h3 = head.slice(0, 300);
    if (h3.includes('"tool_result"') && !h3.includes('"text"')) continue;
    let d; try { d = JSON.parse(buf.toString('utf8', s, e)); } catch { continue; }
    const raw = userText(d.message || {});
    let txt = cleanPrompt(raw, 220);
    if (!txt) continue;
    const rawS = stripReminders(raw).replace(/^\s+/, '');
    if (S.pending_ask) {
      const a = S.pending_ask.resolved ? S.pending_ask.text : assistantAsk(S.pending_ask.raw);
      // A new ask replaces the open one. A plain reply (typically the assistant answering the relay)
      // does NOT un-bury an ask no human has answered — only a human turn clears it (below).
      if (a) S.open_ask = { text: a, ts: S.pending_ask.ts, notices: 0, by: '' };
      else if (!(S.open_ask && S.open_ask.notices > 0)) S.open_ask = null;
      S.pending_ask = null;
    }
    const isNotice = V.notice.test(rawS);
    if (isNotice) {
      R.n_notices++;
      if (S.open_ask) { S.open_ask.notices++; S.open_ask.by = S.open_ask.by || noticeLabel(rawS); }
    } else if (!NEUTRAL_RX.test(rawS)) {
      S.open_ask = null; // a human (or a standing answer) spoke
    }
    if (txt.startsWith('From ') && txt.slice(0, 80).includes('session')) txt = '[relay] ' + txt;
    if (/^\[(?:Relaymote|Baton)\b/.test(txt)) txt = txt.slice(0, 120);
    R.n_user++;
    R.last_role = 'user';
    const low = txt.toLowerCase();
    const machine = isNotice || txt.startsWith('[relay]') || txt.startsWith('[Conductor') || low.includes('stop hook feedback')
      || low.startsWith('<system-reminder') || low.startsWith('<task-notification');
    if (!machine && ts) R.last_user_ts = ts;
    S.last_prompt_no = S.line_no;
    R.prompts.push(txt);
    if (R.prompts.length > 16) R.prompts.splice(8, 1); // first 8 + rolling last 8
  }
}

/** Resolve the raw lines held during a pass so the state is serialisable. */
function resolveLive(state, live) {
  const S = state.st;
  if (live.lastText != null) { S.last_text_final = finalText(live.lastText); live.lastText = null; }
  if (S.pending_ask && !S.pending_ask.resolved) {
    S.pending_ask = { resolved: true, text: assistantAsk(S.pending_ask.raw), ts: S.pending_ask.ts };
  }
}

function fingerprint(fd, offset) {
  if (!offset) return '';
  const n = Math.min(64, offset);
  const b = Buffer.allocUnsafe(n);
  fs.readSync(fd, b, 0, n, offset - n);
  return b.toString('base64');
}

function headPrint(fd, size) {
  const n = Math.min(256, size);
  if (!n) return '';
  const b = Buffer.allocUnsafe(n);
  fs.readSync(fd, b, 0, n, 0);
  return b.toString('base64');
}

/**
 * Advance a parser state over `file` from state.offset. Stops at EOF (a trailing partial line is left
 * for next time), at `deadline` (ms epoch) or after `maxBytes`. Returns { state, done }.
 */
function advance(state, file, { deadline = Infinity, maxBytes = Infinity, chunk = 4 << 20 } = {}) {
  const fd = fs.openSync(file, 'r');
  const live = { lastText: null };
  let done = false;
  try {
    const st = fs.fstatSync(fd);
    // append-only proof: the bytes just before the offset AND the first bytes of the file are unchanged
    if (state.offset > st.size || (state.offset && (fingerprint(fd, state.offset) !== state.fp || headPrint(fd, st.size) !== state.hp))) state = newState();
    let pos = state.offset, readPos = pos, consumed = 0, carry = [];
    while (true) {
      if (readPos >= st.size) { done = true; break; }
      if (Date.now() > deadline || consumed >= maxBytes) break;
      const want = Math.min(chunk, st.size - readPos);
      const b = Buffer.allocUnsafe(want);
      const n = fs.readSync(fd, b, 0, want, readPos);
      if (n <= 0) { done = true; break; }
      readPos += n;
      const blk = n < want ? b.subarray(0, n) : b;
      const nl = blk.lastIndexOf(10);
      if (nl < 0) { carry.push(blk); continue; }
      const buf = carry.length ? Buffer.concat([...carry, blk.subarray(0, nl + 1)]) : blk.subarray(0, nl + 1);
      processLines(state, buf, live);
      pos += buf.length; consumed += buf.length;
      carry = nl + 1 < blk.length ? [blk.subarray(nl + 1)] : [];
    }
    resolveLive(state, live);
    state.offset = pos;
    state.fp = fingerprint(fd, pos);
    state.hp = headPrint(fd, st.size);
    state.size = st.size; state.mtime = st.mtimeMs; state.done = done;
  } finally { fs.closeSync(fd); }
  return { state, done };
}

/** The public record derived from a parser state. */
function recordOf(state) {
  const R = state.rec, S = state.st;
  const oa = S.open_ask;
  const buried = !!(oa && oa.notices > 0 && oa.text);
  const skills = Object.fromEntries(Object.entries(R.skills).sort((a, b) => b[1] - a[1]).slice(0, 6));
  return {
    ...R, skills, errors: R.api_errors, bytes: state.size, ctx_bytes: S.ctx,
    final_text: S.last_text_no > S.last_prompt_no ? S.last_text_final : '',
    asked_user_question: S.last_ask_no > S.last_prompt_no,
    buried, buried_ask: buried ? oa.text : '', buried_ts: buried ? oa.ts : null,
    buried_by: buried ? oa.by : '', buried_notices: buried ? oa.notices : 0,
    complete: !!state.done,
  };
}

/** Parse a whole transcript in one go (tests, one-off tools). */
function parseFile(file) {
  const { state } = advance(newState(), file);
  return recordOf(state);
}

// ------------------------------------------------------------------ scan every transcript
const projectsDir = () => path.join(config.CLAUDE_HOME, 'projects');
const cacheFile = () => path.join(config.DATA, 'conductor', 'transcripts-cache.json');
// Transcript folders (slugs) never indexed: sessions run in a temp folder are throwaway probes.
// settings.index.skipSlugs: null = these defaults; an array REPLACES them ([] = index everything).
const DEFAULT_SKIP = ['AppData-Local-Temp', '^-tmp-', '^-var-folders-', '^-private-var-folders-'];

function skipRx() {
  const list = Array.isArray(settings().skipSlugs) ? settings().skipSlugs : DEFAULT_SKIP;
  const parts = [];
  for (const p of list) { try { new RegExp(p); parts.push(p); } catch {} }
  return parts.length ? new RegExp(parts.join('|')) : /(?!)/;
}

function readCache() {
  try {
    const c = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
    return c && c.v === PARSER_VERSION ? c : { v: PARSER_VERSION, files: {} };
  } catch { return { v: PARSER_VERSION, files: {} }; }
}
function writeCache(c) {
  const f = cacheFile();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(c));
  fs.renameSync(tmp, f);
}

/** Every main transcript: [{ path, slug, uuid, size, mtime }] newest first. Nested subagent files are skipped. */
function listFiles(dir = projectsDir()) {
  const out = [], skip = skipRx();
  let slugs = [];
  try { slugs = fs.readdirSync(dir); } catch { return out; }
  for (const slug of slugs) {
    if (skip.test(slug)) continue;
    const pd = path.join(dir, slug);
    let names = [];
    try { names = fs.readdirSync(pd); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue;
      const p = path.join(pd, n);
      let st; try { st = fs.statSync(p); } catch { continue; }
      if (!st.isFile()) continue;
      out.push({ path: p, slug, uuid: n.slice(0, -6), size: st.size, mtime: st.mtimeMs });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/**
 * Bring every transcript record up to date. Unchanged files come from the cache; grown files resume
 * from their offset; the whole pass stops starting new work after budgetMs (the rest keeps its last
 * record and is picked up next time — newest files first, so live sessions stay fresh).
 * Returns { byCli: Map(uuid -> rec), stats }.
 */
async function scan({ budgetMs = Infinity, dir, write = true } = {}) {
  const t0 = Date.now();
  const deadline = budgetMs === Infinity ? Infinity : t0 + budgetMs;
  const cache = readCache();
  const files = listFiles(dir);
  const seen = new Set();
  const stats = { files: files.length, cached: 0, resumed: 0, parsed: 0, pending: 0, bytesRead: 0, ms: 0 };
  const byCli = new Map();
  for (const f of files) {
    seen.add(f.path);
    let c = cache.files[f.path];
    const unchanged = c && c.size === f.size && c.mtime === f.mtime && c.done;
    if (!unchanged) {
      if (Date.now() >= deadline) { stats.pending++; }
      else {
        // transcripts are append-only: a smaller file, or the same size with a new mtime, was rewritten
        const fromZero = !c || f.size < (c.offset || 0) || (f.size === c.size && f.mtime !== c.mtime);
        const start = fromZero ? 0 : c.offset;
        try {
          const r = advance(fromZero ? newState() : c, f.path, { deadline });
          c = r.state;
          stats.bytesRead += c.offset - start;
          if (fromZero || start === 0) stats.parsed++; else stats.resumed++;
          if (!r.done) stats.pending++;
          cache.files[f.path] = c;
        } catch { stats.pending++; }
        await new Promise(r => setImmediate(r));
      }
    } else stats.cached++;
    if (!c) continue;
    const rec = { ...recordOf(c), slug: f.slug, path: f.path, uuid: f.uuid };
    const prev = byCli.get(f.uuid);
    if (!prev || (rec.last_ts || '') > (prev.last_ts || '')) byCli.set(f.uuid, rec);
  }
  for (const k of Object.keys(cache.files)) if (!seen.has(k)) delete cache.files[k];
  if (write) { try { writeCache(cache); } catch {} }
  stats.ms = Date.now() - t0;
  return { byCli, stats };
}

/** Locate a transcript by cli uuid (optionally trying one slug first). */
function findTranscript(cli, slug) {
  if (!cli) return null;
  const dir = projectsDir();
  if (slug) { const p = path.join(dir, slug, cli + '.jsonl'); if (fs.existsSync(p)) return p; }
  let slugs = [];
  try { slugs = fs.readdirSync(dir); } catch { return null; }
  let best = null, bestM = -1;
  for (const s of slugs) {
    const p = path.join(dir, s, cli + '.jsonl');
    try { const st = fs.statSync(p); if (st.mtimeMs > bestM) { best = p; bestM = st.mtimeMs; } } catch {}
  }
  return best;
}

// ------------------------------------------------------------------ pending-state classifier
/**
 * How did the session end its last turn? 'running' | 'buried' | 'asks' | 'unanswered' | 'open' | 'ended',
 * plus the ask text. `critical` says the ask touches money / deletion / an outside party / secrets.
 */
function classifyPending(s) {
  const ft = s.final_text || '';
  const tail = ft.slice(-500);
  if (s.running) return { pending: 'running', ask: '' };
  if (s.buried) return { pending: 'buried', ask: s.buried_ask || '' };
  let kind;
  if (s.awaiting || s.asked_user_question) kind = 'asks';
  else if (s.last_role === 'user' && !ft) return { pending: 'unanswered', ask: '' };
  else if (/\?\s*$/.test(tail.trimEnd()) || ASK_RX.test(tail)) kind = 'asks';
  else if (OPEN_RX.test(tail)) kind = 'open';
  else return { pending: 'ended', ask: '' };
  const sents = tail.split(/(?<=[.?!])\s+/);
  return { pending: kind, ask: sents.slice(-2).join(' ').slice(-260) };
}
function isCritical(text) { const c = vocab().critical; return !!(text && c && c.test(text)); }

/**
 * NARROW vs BROAD awaiting, kept distinct on purpose: 'narrow' = the session's OWN flags (Desktop's
 * awaiting dot, or an unanswered AskUserQuestion); 'broad' = only the index's reading of how the last
 * turn ended. Broad is far weaker and far more numerous — never quote the union as "waiting on you".
 */
function awaitingSignal(s) {
  if (s.awaiting || s.asked_user_question) return 'narrow';
  if (['asks', 'unanswered', 'buried'].includes(s.pending)) return 'broad';
  return null;
}

/** Context estimate + flag. Thresholds from settings.index; FULL is only VERIFIED by a compaction or overflow. */
function contextOf(ctxBytes, compactions, exceeded) {
  const ix = settings();
  const bpt = Number(ix.bytesPerToken) || 4, full = Number(ix.ctxFull) || 400000, tight = Number(ix.ctxTight) || 250000;
  const est = Math.floor((ctxBytes || 0) / bpt);
  const flag = (exceeded || est >= full) ? 'FULL' : est >= tight ? 'tight' : 'ok';
  return { est_ctx_tokens: est, ctx_flag: flag, ctx_verified: !!(compactions || exceeded),
    ctx_note: flag === 'ok' ? '' : (exceeded ? `Desktop recorded ${exceeded} overflow(s)` : compactions ? `compacted ×${compactions} — coping, not dead`
      : 'byte estimate only, 0 compactions — NOT verified full; not a liveness signal') };
}

// ------------------------------------------------------------------ transcript grep (who touched this?)
/**
 * Count the lines matching `pattern` (a regex source; case-insensitive unless flags given) in every
 * transcript. Ranked by HIT COUNT — a hit is evidence a session touched the thing; recency only says
 * who spoke last. A miss is a fact about the PATTERN: it proves presence, never absence.
 * Returns { ok, hits: [{ path, uuid, slug, hits }], scanned, truncated, ms }.
 */
async function grep(pattern, { flags = 'i', deadlineMs = 20000, dir, files } = {}) {
  let rx;
  try { rx = new RegExp(pattern, flags.replace(/g/g, '')); } catch (e) { return { ok: false, error: 'bad pattern: ' + e.message, hits: [] }; }
  if (!String(pattern || '').trim() || String(pattern).length < 3) return { ok: false, error: 'pattern must be at least 3 characters', hits: [] };
  const t0 = Date.now();
  const list = files || listFiles(dir);
  const hits = [];
  let scanned = 0, truncated = false;
  for (const f of list) {
    if (Date.now() - t0 > deadlineMs) { truncated = true; break; }
    let n = 0;
    try {
      const fd = fs.openSync(f.path, 'r');
      try {
        const size = fs.fstatSync(fd).size;
        let pos = 0, carry = '';
        const CH = 4 << 20;
        while (pos < size) {
          const b = Buffer.allocUnsafe(Math.min(CH, size - pos));
          const got = fs.readSync(fd, b, 0, b.length, pos);
          if (got <= 0) break;
          pos += got;
          let text = carry + b.toString('utf8', 0, got);
          const nl = text.lastIndexOf('\n');
          carry = nl < 0 ? text : text.slice(nl + 1);
          text = nl < 0 ? '' : text.slice(0, nl);
          if (text && rx.test(text)) for (const ln of text.split('\n')) if (rx.test(ln)) n++;
        }
        if (carry && rx.test(carry)) n++;
      } finally { fs.closeSync(fd); }
    } catch { continue; }
    scanned++;
    if (n) hits.push({ path: f.path, uuid: f.uuid, slug: f.slug, hits: n });
    await new Promise(r => setImmediate(r));
  }
  hits.sort((a, b) => b.hits - a.hits);
  return { ok: true, pattern: String(pattern), hits, scanned, of: list.length, truncated, ms: Date.now() - t0,
    note: 'Ranked by hit count. A miss is a fact about the pattern — it proves presence, never absence. Use a distinctive string (an id, an error code, a filename).' };
}

module.exports = {
  PARSER_VERSION, DEFAULT_CRITICAL, DEFAULT_NOTICES,
  newState, advance, recordOf, parseFile, scan, listFiles, findTranscript, readCache, cacheFile, projectsDir,
  classifyPending, isCritical, awaitingSignal, contextOf, grep,
  cleanPrompt, userText, assistantAsk, noticeLabel, vocab, stripReminders, NEUTRAL_RX,
};
