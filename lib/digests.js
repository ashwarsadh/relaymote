// digests.js — the lean per-session transcript: what the person said and what each turn concluded.
//
// ONE markdown file per session, <data>/conductor/digests/<session id>.md. A resumed session carries
// several transcripts (the Desktop registry's priorCliSessionIds + the current cliSessionId); they are
// digested IN ORDER into that one file. It holds ONLY:
//   * the owner's messages — every real-text user turn, system-reminders stripped, capped at MSG_CAP.
//     A "[Conductor …]" turn is the owner's words relayed, labelled "<OWNER> via Conductor".
//     A slash command becomes one COMMAND line.
//   * the assistant's final answer per turn — the LAST assistant text before the next user turn (or
//     EOF), capped. An AskUserQuestion it raised is appended as "[asked: …]".
//   * relays from other sessions / Relaymote / subagents — ONE line each, so a buried question can still
//     be seen to have been buried.
// Never a tool call, tool output, thinking block, image, sidechain line or file list.
//
// Incremental by byte offset. _state.json remembers per session the offset consumed in each of its
// transcripts, the digest length BEFORE the trailing (provisional) answer — tail_pos — and that answer.
// Each run truncates back to tail_pos, re-emits the provisional answer if the turn is still open, and
// continues from the offsets, so an answer still being written is corrected, never duplicated. A
// transcript that shrank, a changed chain, or an EARLIER transcript of the chain that grew rebuilds
// that session's digest from zero.
//
// Stable API for later summaries/roles work: update(sid), read(sid, tail), readDelta(sid, since), stats().
// The owner label comes from settings.index.ownerLabel (default "USER").
'use strict';
const fs = require('fs');
const path = require('path');
const config = require('./config');
const T = require('./transcripts');

const DIR = () => path.join(config.DATA, 'conductor', 'digests');
const STATE = () => path.join(DIR(), '_state.json');
const MSG_CAP = 6000;
const RELAY_CAP = 200;
const CONDUCTOR_RX = /^\s*\[Conductor\b/;
const PLUMBING_RX = /^\s*(<local-command-stdout|<local-command-caveat|<ci-monitor-event|Caveat: The messages below were generated|\[Request interrupted|API Error:)/;
const ROLE_RX = /"role":"(user|assistant)"/;
const TS_RX = /"timestamp":"([^"]+)"/;

const owner = () => String(((config.get().index || {}).ownerLabel) || 'USER').replace(/[\r\n#]+/g, ' ').trim() || 'USER';
const iso = ts => String(ts || '').slice(0, 16).replace('T', ' ');

function digestPath(sid) { return path.join(DIR(), String(sid).replace(/[^A-Za-z0-9._-]+/g, '_') + '.md'); }
function loadState() { try { return JSON.parse(fs.readFileSync(STATE(), 'utf8')) || {}; } catch { return {}; } }
function saveState(state) {
  fs.mkdirSync(DIR(), { recursive: true });
  const tmp = STATE() + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, STATE());
}

function cleanText(text, cap = MSG_CAP) {
  if (typeof text !== 'string') return '';
  let t = text;
  const m = /^\s*<command-message>[^<]*<\/command-message>\s*<command-name>([^<]+)<\/command-name>\s*(?:<command-args>([^<]*)<\/command-args>)?/.exec(t);
  if (m) t = (m[1] + ' ' + (m[2] || '')).trim();
  if (t.startsWith('Base directory for this skill:')) return '';
  t = t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ');
  t = t.replace(/<local-command-(stdout|caveat)>[\s\S]*?<\/local-command-\1>/g, ' ');
  t = t.replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (t.length > cap) t = t.slice(0, cap) + ` …[${t.length - cap} more chars]`;
  return t;
}

function assistantText(line) {
  let d; try { d = JSON.parse(line); } catch { return ''; }
  const parts = [], qs = [];
  for (const b of (d.message && d.message.content) || []) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text' && b.text) parts.push(b.text);
    else if (b.type === 'tool_use' && b.name === 'AskUserQuestion') for (const q of ((b.input || {}).questions) || []) if (q && q.question) qs.push(q.question);
  }
  let txt = cleanText(parts.join('\n'));
  if (qs.length) txt = (txt ? txt + '\n' : '') + '[asked: ' + qs.join(' / ') + ']';
  return txt;
}

const entry = (ts, label, text) => `## ${ts} ${label}\n${text}\n\n`;

/** Append the digest of `file` after byte `start` via write(); returns [newOffset, pending]. Complete lines only. */
function scanFile(file, start, write, e, pending) {
  const fd = fs.openSync(file, 'r');
  let pos = start;
  try {
    const size = fs.fstatSync(fd).size;
    let readPos = start, carry = [];
    const V = T.vocab(), who = owner();
    while (readPos < size) {
      const b = Buffer.allocUnsafe(Math.min(4 << 20, size - readPos));
      const n = fs.readSync(fd, b, 0, b.length, readPos);
      if (n <= 0) break;
      readPos += n;
      const blk = b.subarray(0, n);
      const nl = blk.lastIndexOf(10);
      if (nl < 0) { carry.push(blk); continue; }
      const buf = carry.length ? Buffer.concat([...carry, blk.subarray(0, nl + 1)]) : blk.subarray(0, nl + 1);
      carry = nl + 1 < blk.length ? [blk.subarray(nl + 1)] : [];
      let i = 0;
      while (i < buf.length) {
        let z = buf.indexOf(10, i); if (z < 0) z = buf.length;
        const s = i; i = z + 1;
        if (z - s < 2) continue;
        const head = buf.toString('utf8', s, Math.min(z, s + 800));
        if (head.slice(0, 200).includes('"isSidechain":true')) continue;
        const rm = ROLE_RX.exec(head);
        if (!rm) continue;
        const line = buf.toString('utf8', s, z);
        const tm = TS_RX.exec(line);
        const ts = tm ? iso(tm[1]) : '?';
        if (rm[1] === 'assistant') {
          if (!line.includes('"type":"text"') && !line.includes('"name":"AskUserQuestion"')) continue;
          const txt = assistantText(line);
          if (txt) pending = { ts, text: txt }; // only the LAST one of the turn survives
          continue;
        }
        const h3 = head.slice(0, 300);
        if (h3.includes('"tool_result"') && !h3.includes('"text"')) continue;
        let d; try { d = JSON.parse(line); } catch { continue; }
        const raw = T.userText(d.message || {});
        const rawS = T.stripReminders(raw).replace(/^\s+/, '');
        if (!rawS.trim() || PLUMBING_RX.test(rawS)) continue;
        if (pending) { write(entry(pending.ts, 'ASSISTANT', pending.text)); e.n_answers++; pending = null; }
        e.first_ts = e.first_ts || ts; e.last_ts = ts;
        if (V.notice.test(rawS) && !CONDUCTOR_RX.test(rawS)) {
          const one = T.cleanPrompt(rawS, RELAY_CAP + 40).replace(/\s+/g, ' ').slice(0, RELAY_CAP);
          write(`## ${ts} RELAY — ${T.noticeLabel(rawS)}: ${one}\n\n`);
          e.n_relays++;
        } else if (T.NEUTRAL_RX.test(rawS)) {
          write(`## ${ts} COMMAND: ${cleanText(rawS, 300)}\n\n`);
          e.n_owner++;
        } else {
          const txt = cleanText(raw);
          if (!txt) continue;
          write(entry(ts, CONDUCTOR_RX.test(rawS) ? `${who} via Conductor` : who, txt));
          e.n_owner++;
        }
      }
      pos += buf.length;
    }
  } finally { fs.closeSync(fd); }
  return [pos, pending];
}

/** Bring one session's digest up to date with its transcript chain (paths in order). Returns its state entry. */
function updateSession(sid, s, paths, state, rebuild = false) {
  fs.mkdirSync(DIR(), { recursive: true });
  const dp = digestPath(sid);
  let e = state[sid] || null;
  const files = (e && e.files) || {};
  const now = {};
  for (const p of paths) now[p] = fs.statSync(p);
  let fresh = rebuild || !e || !fs.existsSync(dp) || JSON.stringify(Object.keys(files)) !== JSON.stringify(paths);
  if (!fresh) {
    paths.forEach((p, i) => {
      const f = files[p] || {};
      if (now[p].size < (f.offset || 0)) fresh = true;
      else if (i < paths.length - 1 && now[p].size !== f.size) fresh = true;
    });
  }
  if (!fresh && paths.every(p => (files[p] || {}).size === now[p].size && (files[p] || {}).mtime === now[p].mtimeMs)) return e;
  if (fresh) {
    e = { files: {}, tail_pos: 0, pending: null, n_owner: 0, n_answers: 0, n_relays: 0, first_ts: null, last_ts: null };
    fs.writeFileSync(dp, `# ${s.title || sid}\nsession: ${sid} · project: ${s.project || '?'} · group: ${s.group || '?'} · cli: ${s.cli || '?'}\n` +
      `kept: ${owner()}'s messages and the assistant's final answer per turn; relays one line. No tool calls, no tool output, no images, no file lists.\n\n`);
    e.tail_pos = fs.statSync(dp).size;
  }
  const fd = fs.openSync(dp, 'r+');
  try {
    fs.ftruncateSync(fd, e.tail_pos);
    let at = e.tail_pos;
    const write = str => { const b = Buffer.from(str, 'utf8'); fs.writeSync(fd, b, 0, b.length, at); at += b.length; };
    let pending = e.pending;
    for (const p of paths) {
      const st = now[p], f = e.files[p] || {};
      if (f.size === st.size && f.mtime === st.mtimeMs && (f.offset || 0) >= st.size) continue;
      const [off, pend] = scanFile(p, f.offset || 0, write, e, pending);
      pending = pend;
      e.files[p] = { offset: off, size: st.size, mtime: st.mtimeMs };
    }
    e.tail_pos = at;
    if (pending) { // the last turn has no user turn after it yet — provisional
      write(entry(pending.ts, 'ASSISTANT (latest)', pending.text));
      if ((e.last_ts || '') < pending.ts) e.last_ts = pending.ts;
    }
    e.pending = pending;
  } finally { fs.closeSync(fd); }
  Object.assign(e, { bytes: fs.statSync(dp).size, raw_bytes: paths.reduce((n, p) => n + now[p].size, 0),
    title: s.title || null, project: s.project || null, cli: s.cli || null, updated: new Date().toISOString() });
  state[sid] = e;
  return e;
}

/** Transcript paths of a session's chain, oldest first. `byCli` (Map or object uuid -> {path}) speeds lookup. */
function chainPaths(s, byCli) {
  const out = [];
  const get = c => byCli ? (byCli instanceof Map ? byCli.get(c) : byCli[c]) : null;
  for (const c of (s.cli_chain && s.cli_chain.length ? s.cli_chain : (s.cli ? [s.cli] : []))) {
    const r = get(c);
    const p = (r && r.path) || T.findTranscript(c, s.slug);
    if (p && fs.existsSync(p) && !out.includes(p)) out.push(p);
  }
  return out;
}

/** Digest every session of an index (build() calls this when the digests module is on). */
function updateAll(sessions, byCli, { rebuild = false, deadline = Infinity } = {}) {
  const state = rebuild ? {} : loadState();
  let n = 0, pending = 0;
  for (const [sid, s] of Object.entries(sessions || {})) {
    if (Date.now() > deadline) { pending++; continue; }
    const paths = chainPaths(s, byCli);
    if (!paths.length) continue;
    const before = (state[sid] || {}).bytes;
    try { if (updateSession(sid, s, paths, state, rebuild).bytes !== before) n++; } catch {}
  }
  saveState(state);
  return { updated: n, pending, ...stats(state) };
}

/** Update ONE session's digest, looking it up in the index (or pass { session, paths }). */
function update(sid, { session, paths, rebuild = false } = {}) {
  let s = session;
  if (!s) { const ix = require('./projects').read(); s = ix && ix.sessions && ix.sessions[sid]; }
  if (!s) return { ok: false, error: 'NO_SUCH_SESSION', message: `no session ${sid} in the index` };
  const ps = paths || chainPaths(s, null);
  if (!ps.length) return { ok: false, error: 'NO_TRANSCRIPT', message: `no transcript on disk for ${sid}` };
  const state = loadState();
  const e = updateSession(sid, s, ps, state, rebuild);
  saveState(state);
  return { ok: true, sid, path: digestPath(sid), bytes: e.bytes, owner_turns: e.n_owner, answers: e.n_answers, relays: e.n_relays };
}

/** Whole digest text (or its last `tail` chars). '' when none. */
function read(sid, tail) {
  let t = '';
  try { t = fs.readFileSync(digestPath(sid), 'utf8'); } catch { return ''; }
  return tail ? t.slice(-tail) : t;
}

/** Digest text from byte `since` to the end, and the new end offset — what a summariser has not seen yet. */
function readDelta(sid, since = 0) {
  const dp = digestPath(sid);
  let size; try { size = fs.statSync(dp).size; } catch { return { text: '', offset: 0 }; }
  const from = Math.min(Math.max(0, since | 0), size);
  const fd = fs.openSync(dp, 'r');
  try {
    const b = Buffer.allocUnsafe(size - from);
    fs.readSync(fd, b, 0, b.length, from);
    return { text: b.toString('utf8'), offset: size };
  } finally { fs.closeSync(fd); }
}

/** Parsed turns [{ ts, kind, body }] of a digest; kind is OWNER | OWNER_VIA_CONDUCTOR | ASSISTANT | RELAY | COMMAND. */
function turns(sid) {
  const txt = read(sid), who = owner().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rx = new RegExp(`^## (\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}) (${who} via Conductor|${who}|ASSISTANT \\(latest\\)|ASSISTANT|RELAY|COMMAND)\\b`, 'gm');
  const hs = [...txt.matchAll(rx)];
  return hs.map((m, i) => {
    const kind = m[2] === owner() ? 'OWNER' : m[2].endsWith('via Conductor') ? 'OWNER_VIA_CONDUCTOR' : m[2].startsWith('ASSISTANT') ? 'ASSISTANT' : m[2];
    return { ts: m[1], kind, body: txt.slice(m.index + m[0].length, i + 1 < hs.length ? hs[i + 1].index : txt.length).replace(/^[: —]+/, '').trim() };
  });
}

function stats(state = loadState()) {
  let raw = 0, dig = 0, n = 0;
  for (const e of Object.values(state)) { raw += e.raw_bytes || 0; dig += e.bytes || 0; n++; }
  return { n, raw_bytes: raw, digest_bytes: dig, ratio: raw ? dig / raw : 0 };
}

module.exports = { DIR, digestPath, update, updateAll, updateSession, chainPaths, read, readDelta, delta: readDelta, turns, stats, loadState, cleanText, MSG_CAP };
