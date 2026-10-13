'use strict';
// g1875 — which sessions each non-default principal (Sagar) has touched, and when. Ashwar 13-Oct-2026:
// "he sees only his conductor session initially. Then whenever he sends a prompt and another session needs
// to work ... those sessions start looking up in his side menu, whichever is started by him or his conductor
// ... for one week, if a session is not again invoked by his conductor, then again it starts hiding ...
// And for my own interface ... whatever sessions Sagar is working on, those maybe can get marked as Sagar,
// and in the session list I can just tick or untick view other user's sessions".
//
// A TOUCH is an ACTION on a session, never a read:
//   - his Conductor's own transcript: a send_message / SendMessage / start_session / spawn / start_task /
//     hand-off tool call naming the session (by its target field, not ids quoted in the message text), and
//     the id a start-type call (or a Bash/PowerShell `/api/new`) returned  -> started
//   - his phone (X-Relaymote-As: sagar): /api/send to a session, /api/new  -> started
// Only one transcript is read (his Conductor's), incrementally from a saved offset, so this costs a few KB a
// refresh. The ledger lives in Relaymote's state folder; losing it only re-reads the Conductor transcript.
const fs = require('fs');
const path = require('path');
const config = require('../lib/config');
const Principals = require('./principals');

const WEEK_MS = 7 * 24 * 3600 * 1000;
const ID_RX = /local_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const ACT_TOOL = /send_message|SendMessage|start_session|spawn|start_task|hand_off|resume|unstick/i;
const START_TOOL = /start_session|spawn|start_task|hand_off/i;
const TARGET_KEYS = ['session_id', 'sessionId', 'to', 'target', 'session', 'id', 'proposal_id'];

let FILE = path.join(config.STATE, 'principal-touch.json');
let ledger = null;

function load() {
  if (ledger) return ledger;
  try { ledger = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { ledger = null; }
  if (!ledger || typeof ledger !== 'object') ledger = {};
  ledger.touch = ledger.touch || {};
  ledger.files = ledger.files || {};
  return ledger;
}
function save() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(ledger));
    fs.renameSync(tmp, FILE);
  } catch {}
}

/** Record that principal p acted on session sid at time at (ms). started = p (or his Conductor) began it. */
function note(sid, p, { at = Date.now(), started = false } = {}) {
  if (!sid || !p) return false;
  const L = load();
  const row = (L.touch[sid] = L.touch[sid] || {});
  const t = (row[p] = row[p] || { first: at, last: at, started: false });
  const before = JSON.stringify(t);
  t.first = Math.min(t.first || at, at);
  t.last = Math.max(t.last || 0, at);
  if (started) t.started = true;
  return JSON.stringify(t) !== before;
}

/** Ids a tool call ACTS on: only its target fields (a send's message text may quote other sessions). */
function targetsOf(input) {
  const out = [];
  if (!input || typeof input !== 'object') return out;
  for (const k of TARGET_KEYS) {
    const v = input[k];
    if (typeof v === 'string') for (const m of v.match(ID_RX) || []) out.push(m);
  }
  return out;
}

const textOf = (c) => typeof c === 'string' ? c : Array.isArray(c) ? c.map(x => (x && (x.text || x.content)) ? textOf(x.text || x.content) : '').join('\n') : '';

/** Parse a chunk of a principal's Conductor transcript; returns how many touches it recorded. */
function scanLines(lines, p, selfIds, pending) {
  let n = 0;
  for (const ln of lines) {
    if (!ln || ln.indexOf('tool_') < 0) continue;
    let d; try { d = JSON.parse(ln); } catch { continue; }
    const at = Date.parse(d.timestamp) || Date.now();
    const content = d.message && Array.isArray(d.message.content) ? d.message.content : [];
    for (const c of content) {
      if (c && c.type === 'tool_use') {
        const name = String(c.name || '');
        const cmd = c.input && typeof c.input.command === 'string' ? c.input.command : '';
        const start = START_TOOL.test(name) || (/\/api\/new\b/.test(cmd));
        if (start) pending.set(c.id, { name, at });
        if (ACT_TOOL.test(name)) for (const sid of targetsOf(c.input)) if (!selfIds.has(sid) && note(sid, p, { at })) n++;
      } else if (c && c.type === 'tool_result' && pending.has(c.tool_use_id)) {
        const st = pending.get(c.tool_use_id);
        pending.delete(c.tool_use_id);
        if (c.is_error) continue;
        for (const sid of new Set(textOf(c.content).match(ID_RX) || [])) if (!selfIds.has(sid) && note(sid, p, { at: st.at, started: true })) n++;
      }
    }
  }
  return n;
}

let lastScan = 0;
/**
 * Bring the ledger up to date from each non-default principal's Conductor transcript.
 * transcriptOf(sessionId) -> file path or null (mobile/sessions.js transcriptPath(get(id))).
 */
function refresh(dir, transcriptOf, { force = false, maxBytes = 8 * 1024 * 1024 } = {}) {
  if (!force && Date.now() - lastScan < 15000) return 0;
  lastScan = Date.now();
  const L = load();
  const J = Principals.load(dir);
  const conductors = new Set(Object.values(J.principals).map(r => r && r.conductor).filter(Boolean));
  let n = 0, moved = false;
  for (const [key, r] of Object.entries(J.principals)) {
    if (key === J.default || !r || !r.conductor) continue;
    if (note(r.conductor, key, { at: Date.now(), started: true })) moved = true;   // his Conductor is always his
    let file = null;
    try { file = transcriptOf(r.conductor); } catch {}
    if (!file) continue;
    let size = 0;
    try { size = fs.statSync(file).size; } catch { continue; }
    let from = L.files[file] || 0;
    if (from > size) from = 0;                       // replaced or truncated: read again
    if (size - from > maxBytes) from = size - maxBytes;
    if (from === size) continue;
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(size - from);
      fs.readSync(fd, buf, 0, buf.length, from);
      const text = buf.toString('utf8');
      const cut = text.lastIndexOf('\n');            // a half-written last line is read next time
      if (cut < 0) continue;
      // Other principals' Conductors (Ashwar's included) are never "his" sessions, even when he escalates to them.
      const self = new Set([...conductors].filter(id => id !== r.conductor));
      const def = defaultConductor(dir);
      if (def) self.add(def);
      self.add(r.conductor);
      n += scanLines(text.slice(0, cut).split('\n'), key, self, new Map());
      L.files[file] = from + Buffer.byteLength(text.slice(0, cut + 1), 'utf8');
      moved = true;
    } finally { fs.closeSync(fd); }
  }
  if (moved || n) save();
  return n;
}

function defaultConductor(dir) {
  try {
    const first = fs.readFileSync(path.join(dir, 'INDEX.md'), 'utf8').split(/\r?\n/, 1)[0] || '';
    const m = first.match(/^Conductor id:\s*(\S+)/);
    if (m && m[1] !== 'unknown') return m[1];
  } catch {}
  try { return fs.readFileSync(path.join(dir, 'last-conductor.txt'), 'utf8').trim() || null; } catch { return null; }
}

/**
 * The session list as principal `p` sees it (Principals.resolve result).
 *  - own principal (Sagar): his Conductor + sessions he touched in the last 7 days; everything else hidden.
 *  - default (Ashwar): everything, each row carrying `by` [{key,name,last,started}] and `othersOnly`
 *    (started by another principal = uniquely theirs; the phone's "Other users' sessions" toggle hides/folds those).
 */
function view(list, p, dir, { now = Date.now() } = {}) {
  const L = load();
  const J = Principals.load(dir);
  const name = (k) => ((J.principals[k] || {}).name || k);
  if (p && p.own) {
    return list.filter(s => s.id === p.conductor ||
      ((L.touch[s.id] || {})[p.key] && now - L.touch[s.id][p.key].last <= WEEK_MS));
  }
  return list.map(s => {
    const row = L.touch[s.id];
    if (!row) return s;
    const by = Object.entries(row).filter(([k]) => k !== J.default && J.principals[k])
      .map(([k, t]) => ({ key: k, name: name(k), last: t.last, started: !!t.started }));
    if (!by.length) return s;
    return Object.assign({}, s, { by, othersOnly: by.some(b => b.started) });
  });
}

function _reset(file) { FILE = file || FILE; ledger = null; lastScan = 0; }

module.exports = { note, save, refresh, view, scanLines, targetsOf, WEEK_MS, _reset, get file() { return FILE; } };
