'use strict';
// transcript-index.js — a fast local full-text index over EVERY Claude session transcript (main, subagent, archived).
// Ashwar 27-Nov: "You should have used GREP or look into the archive session ... Relay Mode should have ability to search
// into transcripts and a bulk search ... search through the entire database of the transcripts and return the text fast."
// A plain grep over ~/.claude/projects (24,000 files, 38 GB on 27-Nov) times out. This reads each file ONCE, keeps the text
// that matters in SQLite FTS5 (Unicode-aware: Devanagari/Nepali/Tibetan tokenise as words), and afterwards reads only the bytes a
// transcript has gained. Search is a single indexed query.
//
//   indexed:  user text, assistant text, tool results (capped), tool calls (their command / prompt / message), and the messages
//             sent from the phone that are still in Desktop's queue.  <system-reminder> blocks are stripped (they repeat the
//             whole CLAUDE.md on every turn).  Blob / snapshot / telemetry lines are skipped without being decoded.
//   archived: Desktop's "archive" hides a session; its transcript file stays, so it is indexed like any other. Rows are kept
//             even if Claude later deletes the file.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const HOME = os.homedir();
const PROJECTS = process.env.CRT_PROJECTS || path.join(HOME, '.claude', 'projects');
const SESSIONS = process.env.CRT_SESSIONS || path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'Claude', 'claude-code-sessions');
const DIR = process.env.CRT_DIR || path.join(process.env.RELAYMOTE_HOME || path.join(HOME, '.relaymote'), 'transcript-index');
const DB_FILE = process.env.CRT_DB || path.join(DIR, 'index.db');
const LOCK_FILE = path.join(path.dirname(DB_FILE), 'index.lock');

const CHUNK = 16 * 1024 * 1024;        // bytes read at a time
const MAX_LINE = 64 * 1024 * 1024;     // a longer line is skipped, never decoded
const MAX_PARSE = 6 * 1024 * 1024;     // a line longer than this is not parsed
const CAP = { user: 8000, assistant: 8000, tool: 6000, call: 1500, queued: 8000 };
const COMMIT_BYTES = 24 * 1024 * 1024; // commit about every this many bytes read
// Combining marks (vowel signs, virama, anusvara) are not word characters to unicode61, which would cut Devanagari / Tibetan / Thai
// words into single letters; listing them as tokenchars keeps a word whole.
const MARKS = (() => { let s = ''; for (const [a, b] of [[0x900, 0x903], [0x93A, 0x94F], [0x951, 0x957], [0x962, 0x963], [0xF71, 0xF84], [0xF86, 0xF87], [0xF8D, 0xFBC], [0xE31, 0xE31], [0xE34, 0xE3A], [0xE47, 0xE4E]]) for (let c = a; c <= b; c++) s += String.fromCodePoint(c); return s; })();
const SESS_REFRESH_MS = 30 * 60 * 1000;

function openDb(file = DB_FILE, readonly = false) {
  const { DatabaseSync } = require('node:sqlite');
  if (!readonly) fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file, readonly ? { readOnly: true } : {});
  db.exec('PRAGMA busy_timeout=30000');
  if (!readonly) {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;');
    db.exec(`
      CREATE TABLE IF NOT EXISTS files (id INTEGER PRIMARY KEY, path TEXT UNIQUE, cli TEXT, kind TEXT, slug TEXT, size INTEGER, off INTEGER DEFAULT 0, mtime REAL, title TEXT, gone INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS sess (cli TEXT PRIMARY KEY, local TEXT, title TEXT, cwd TEXT, archived INTEGER, created REAL, last REAL);
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
      CREATE VIRTUAL TABLE IF NOT EXISTS m USING fts5(text, cli UNINDEXED, role UNINDEXED, ts UNINDEXED, fid UNINDEXED, ln UNINDEXED, tokenize="unicode61 remove_diacritics 0 tokenchars '${MARKS}'");
    `);
  }
  return db;
}

// ---- reading one transcript -----------------------------------------------------------------------------------------------
// Calls onLine(buf, start, end, absOffset) for every COMPLETE line from `from`; returns the offset just past the last newline.
function scanLines(fd, from, size, onLine) {
  let pos = from, base = from, buf = Buffer.alloc(0), skipping = false;
  for (;;) {
    const nl = buf.indexOf(10);
    if (nl < 0) {
      if (pos >= size) break;                           // a trailing partial line: left for the next run
      const n = Math.min(CHUNK, size - pos);
      const chunk = Buffer.allocUnsafe(n);
      const got = fs.readSync(fd, chunk, 0, n, pos);
      if (got <= 0) break;
      pos += got;
      const piece = got < n ? chunk.subarray(0, got) : chunk;
      if (skipping) {                                   // inside a line too long to keep: look for its end
        const k = piece.indexOf(10);
        if (k >= 0) { skipping = false; base = pos - piece.length + k + 1; buf = piece.subarray(k + 1); } else { base = pos; }
        continue;
      }
      buf = buf.length ? Buffer.concat([buf, piece]) : piece;
      if (buf.length > MAX_LINE) { skipping = true; buf = Buffer.alloc(0); base = pos; }
      continue;
    }
    onLine(buf, 0, nl, base);
    base += nl + 1;
    buf = buf.subarray(nl + 1);
  }
  return skipping ? from : base;                         // a skipped over-long line is never resumed mid-way
}

const SYS_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const clean = (t) => String(t).replace(SYS_REMINDER, ' ').replace(/\s+/g, ' ').trim();

function parse(s) { try { return JSON.parse(s); } catch { return null; } }
const toolText = (c) => typeof c === 'string' ? c : Array.isArray(c) ? c.filter(x => x && x.type === 'text' && x.text).map(x => x.text).join('\n') : '';

// One transcript line -> 0..n { role, text, ts }.
function extract(buf, start, end) {
  const len = end - start;
  if (len < 20 || len > MAX_PARSE) return [];
  const head = buf.latin1Slice(start, start + Math.min(len, 1600));
  let kind = null;
  if (head.startsWith('{"type":"queue-operation"')) kind = head.includes('"operation":"enqueue"') ? 'queue' : null;
  else if (head.startsWith('{"type":"custom-title"')) kind = 'title';
  else if (head.includes('"role":"user"') || head.includes('"role":"assistant"')) kind = 'msg';
  if (!kind) return [];
  const r = parse(buf.utf8Slice(start, end));
  if (!r) return [];
  if (kind === 'title') return r.customTitle ? [{ role: 'title', text: String(r.customTitle), ts: '' }] : [];
  if (kind === 'queue') return typeof r.content === 'string' && r.content ? [{ role: 'queued', text: r.content, ts: r.timestamp || '' }] : [];
  const msg = r.message;
  if (!msg || !msg.role) return [];
  const role = msg.role === 'assistant' ? 'assistant' : 'user', ts = r.timestamp || '', c = msg.content, out = [];
  if (typeof c === 'string') out.push({ role, text: c, ts });
  else if (Array.isArray(c)) {
    for (const b of c) {
      if (!b) continue;
      if (b.type === 'text' && b.text) out.push({ role, text: b.text, ts });
      else if (b.type === 'tool_result') { const t = toolText(b.content); if (t) out.push({ role: 'tool', text: t, ts }); }
      else if (b.type === 'tool_use' && b.input && typeof b.input === 'object') {
        const t = b.input.command || b.input.prompt || b.input.message || b.input.description || '';
        if (typeof t === 'string' && t) out.push({ role: 'call', text: (b.name ? b.name + ': ' : '') + t, ts });
      }
    }
  }
  return out;
}

function fileIdentity(file) {
  const rel = path.relative(PROJECTS, file).split(path.sep);
  const slug = rel[0] || '';
  const i = rel.indexOf('subagents');
  if (i > 0) return { cli: rel[i - 1], kind: 'sub', slug };
  return { cli: path.basename(file, '.jsonl'), kind: 'main', slug };
}

function walk(dir, out) {
  let es; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of es) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

// ---- the lock (one updater at a time) ---------------------------------------------------------------------------------------
function takeLock() {
  try {
    const l = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
    let alive = true; try { process.kill(l.pid, 0); } catch { alive = false; }
    if (alive && Date.now() - l.at < 6 * 3600 * 1000) return false;
  } catch {}
  fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
  fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, at: Date.now() }));
  return true;
}
function dropLock() { try { const l = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')); if (l.pid === process.pid) fs.unlinkSync(LOCK_FILE); } catch {} }

// ---- Desktop's session store -> lane titles, archived flag ------------------------------------------------------------------
function refreshSessions(db, force) {
  const last = Number((db.prepare("SELECT v FROM meta WHERE k='sessAt'").get() || {}).v || 0);
  if (!force && Date.now() - last < SESS_REFRESH_MS) return 0;
  const best = new Map();
  let accounts = []; try { accounts = fs.readdirSync(SESSIONS); } catch { return 0; }
  for (const a of accounts) {
    let orgs = []; try { orgs = fs.readdirSync(path.join(SESSIONS, a)); } catch { continue; }
    for (const o of orgs) {
      const dir = path.join(SESSIONS, a, o);
      let names = []; try { names = fs.readdirSync(dir); } catch { continue; }
      for (const n of names) {
        if (!n.startsWith('local_') || !n.endsWith('.json')) continue;
        const j = parse((() => { try { return fs.readFileSync(path.join(dir, n), 'utf8'); } catch { return ''; } })());
        if (!j || !j.cliSessionId) continue;
        const cur = best.get(j.cliSessionId);
        if (!cur || (j.lastActivityAt || 0) >= (cur.lastActivityAt || 0)) best.set(j.cliSessionId, j);
      }
    }
  }
  const ins = db.prepare('INSERT OR REPLACE INTO sess (cli, local, title, cwd, archived, created, last) VALUES (?,?,?,?,?,?,?)');
  db.exec('BEGIN');
  for (const [cli, j] of best) ins.run(cli, j.sessionId || '', j.title || '', j.cwd || j.originCwd || '', j.isArchived ? 1 : 0, Number(j.createdAt) || 0, Number(j.lastActivityAt) || 0);
  db.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('sessAt', ?)").run(String(Date.now()));
  db.exec('COMMIT');
  return best.size;
}

// ---- the updater -------------------------------------------------------------------------------------------------------------
// opts: { quiet, full, log }. Returns counters. Safe to run while searches are in progress (WAL).
function update(opts = {}) {
  const log = opts.log || (() => {});
  if (!opts.noLock && !takeLock()) { log('another updater is running'); return { skipped: 'locked' }; }
  const t0 = Date.now();
  const db = openDb();
  const st = { files: 0, changed: 0, rows: 0, bytes: 0, sessions: 0, ms: 0 };
  try {
    try { os.setPriority(0, os.constants.priority.PRIORITY_LOW); } catch {}
    st.sessions = refreshSessions(db, !!opts.full);
    const known = new Map(db.prepare('SELECT id, path, size, off FROM files').all().map(r => [r.path, r]));
    const all = walk(PROJECTS, []);
    st.files = all.length;
    const insFile = db.prepare('INSERT INTO files (path, cli, kind, slug, size, off, mtime) VALUES (?,?,?,?,?,?,?)');
    const getId = db.prepare('SELECT id FROM files WHERE path=?');
    const setOff = db.prepare('UPDATE files SET size=?, off=?, mtime=?, gone=0 WHERE id=?');
    const setTitle = db.prepare('UPDATE files SET title=? WHERE id=?');
    const delRows = db.prepare('DELETE FROM m WHERE fid=?');
    const insRow = db.prepare('INSERT INTO m (text, cli, role, ts, fid, ln) VALUES (?,?,?,?,?,?)');

    const todo = [];
    for (const f of all) {
      let s; try { s = fs.statSync(f); } catch { continue; }
      const k = known.get(f);
      if (k && k.size === s.size && !opts.full) continue;
      todo.push({ f, s, k });
    }
    todo.sort((a, b) => b.s.mtimeMs - a.s.mtimeMs);      // the newest transcripts become searchable first
    for (const { f, s, k } of todo) {
      const id0 = fileIdentity(f);
      let fid, from = 0;
      if (!k) { insFile.run(f, id0.cli, id0.kind, id0.slug, 0, 0, s.mtimeMs); fid = getId.get(f).id; }
      else { fid = k.id; from = (s.size < k.off || opts.full) ? 0 : k.off; if (from === 0) delRows.run(fid); }
      let fd; try { fd = fs.openSync(f, 'r'); } catch { continue; }
      const seen = new Set();                            // a repeated text in one session is stored once
      let title = null, sinceCommit = 0, off = from;
      db.exec('BEGIN');
      try {
        off = scanLines(fd, from, s.size, (buf, a, b, abs) => {
          sinceCommit += b - a;
          const rows = extract(buf, a, b);
          for (const r of rows) {
            let t = clean(r.text);
            if (!t) continue;
            if (r.role === 'title') { title = t; continue; }
            const cap = CAP[r.role] || 6000;
            if (t.length > cap) t = t.slice(0, cap);
            const h = crypto.createHash('md5').update(r.role + t).digest('hex');
            if (seen.has(h)) continue;
            seen.add(h);
            insRow.run(t, id0.cli, r.role, r.ts, fid, abs);
            st.rows++;
          }
          if (sinceCommit > COMMIT_BYTES) { db.exec('COMMIT'); db.exec('BEGIN'); sinceCommit = 0; }
        });
        if (title) setTitle.run(title, fid);
        setOff.run(s.size, off, s.mtimeMs, fid);
        db.exec('COMMIT');
      } catch (e) { try { db.exec('ROLLBACK'); } catch {} log('error in ' + f + ': ' + e.message); }
      finally { try { fs.closeSync(fd); } catch {} }
      st.changed++; st.bytes += Math.max(0, s.size - from);
      if (opts.progress && st.changed % 200 === 0) opts.progress(st, todo.length);
    }
    // a transcript Claude has deleted keeps its rows (the index remembers); it is only marked.
    const present = new Set(all);
    const mark = db.prepare('UPDATE files SET gone=1 WHERE id=?');
    for (const [p, k] of known) if (!present.has(p)) mark.run(k.id);
    db.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('updatedAt', ?)").run(String(Date.now()));
  } finally { st.ms = Date.now() - t0; try { db.close(); } catch {} if (!opts.noLock) dropLock(); }
  return st;
}

// ---- search ------------------------------------------------------------------------------------------------------------------
// "dolma voice" -> "dolma" "voice" (all words); "a phrase in quotes" kept whole; word* is a prefix.
function toMatch(q) {
  const parts = [], rx = /"([^"]+)"|(\S+)/g; let m;
  while ((m = rx.exec(String(q || '')))) {
    const w = m[1] || m[2], pre = !m[1] && w.endsWith('*');
    const bare = (pre ? w.slice(0, -1) : w).replace(/"/g, '""');
    if (bare) parts.push('"' + bare + '"' + (pre ? '*' : ''));
  }
  return parts.join(' ');
}

// opts: { limit (sessions), per (snippets per session), role, since, until (ISO date), lane, project, archived: true|false|undefined, raw, perSessionRows }
function search(q, opts = {}) {
  const db = openDb(DB_FILE, true);
  const t0 = Date.now();
  try {
    const match = opts.raw ? String(q) : toMatch(q);
    if (!match) return { hits: [], ms: 0, error: 'empty query' };
    const where = ['m MATCH ?'], args = [match];
    if (opts.role) { where.push('m.role = ?'); args.push(opts.role); }
    if (opts.since) { where.push('m.ts >= ?'); args.push(String(opts.since)); }
    if (opts.until) { where.push('m.ts < ?'); args.push(String(opts.until) + (String(opts.until).length === 10 ? 'T99' : '')); }
    const rows = db.prepare(`SELECT m.rowid AS rid, m.cli, m.role, m.ts, m.ln, m.fid, snippet(m, 0, '[', ']', ' … ', 24) AS snip, rank
                             FROM m WHERE ${where.join(' AND ')} ORDER BY rank LIMIT ?`).all(...args, opts.rows || 600);
    const sessOf = db.prepare('SELECT local, title, cwd, archived, last FROM sess WHERE cli=?');
    const fileOf = db.prepare('SELECT path, slug, title FROM files WHERE id=?');
    const groups = new Map();
    for (const r of rows) {
      let g = groups.get(r.cli);
      if (!g) {
        const s = sessOf.get(r.cli) || {}, f = fileOf.get(r.fid) || {};
        g = { cli: r.cli, local: s.local || '', lane: s.title || f.title || '', project: s.cwd || f.slug || '', archived: s.archived === 1, last: s.last || 0, best: r.rank, count: 0, snippets: [] };
        groups.set(r.cli, g);
      }
      g.count++;
      if (g.snippets.length < (opts.per || 2)) g.snippets.push({ role: r.role, ts: r.ts, text: r.snip, file: (fileOf.get(r.fid) || {}).path, ln: r.ln });
    }
    let hits = [...groups.values()];
    if (opts.archived === true) hits = hits.filter(h => h.archived);
    if (opts.archived === false) hits = hits.filter(h => !h.archived);
    const has = (a, b) => String(a || '').toLowerCase().includes(String(b).toLowerCase());
    if (opts.lane) hits = hits.filter(h => has(h.lane, opts.lane));
    if (opts.project) hits = hits.filter(h => has(h.project, opts.project));
    hits.sort(opts.recent ? (a, b) => b.last - a.last : (a, b) => a.best - b.best);
    return { hits: hits.slice(0, opts.limit || 15), matched: rows.length, ms: Date.now() - t0 };
  } finally { try { db.close(); } catch {} }
}

function status() {
  if (!fs.existsSync(DB_FILE)) return { built: false, db: DB_FILE };
  const db = openDb(DB_FILE, true);
  try {
    const n = (sql) => (db.prepare(sql).get() || {}).c;
    const meta = (k) => (db.prepare('SELECT v FROM meta WHERE k=?').get(k) || {}).v;
    return { built: true, db: DB_FILE, dbMB: Math.round(fs.statSync(DB_FILE).size / 1048576), files: n('SELECT count(*) c FROM files'), indexedSessions: n('SELECT count(DISTINCT cli) c FROM files'),
      rows: n('SELECT max(rowid) c FROM m'), archivedSessions: n('SELECT count(*) c FROM sess WHERE archived=1'), knownSessions: n('SELECT count(*) c FROM sess'),
      updatedAt: meta('updatedAt') ? new Date(Number(meta('updatedAt'))).toISOString() : null,
      pending: (() => { try { return JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')); } catch { return null; } })() };
  } finally { try { db.close(); } catch {} }
}

// The original transcript line behind a hit (by the file and byte offset the hit carries).
function rawLine(file, ln, max = 20000) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(Math.min(max, 4 * 1024 * 1024));
    const n = fs.readSync(fd, buf, 0, buf.length, ln);
    const k = buf.subarray(0, n).indexOf(10);
    return buf.subarray(0, k < 0 ? n : k).toString('utf8');
  } finally { fs.closeSync(fd); }
}

module.exports = { update, search, status, rawLine, toMatch, openDb, extract, scanLines, DB_FILE, PROJECTS, SESSIONS, LOCK_FILE };
