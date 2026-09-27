// directions.js — the owner's own words per project, recovered from the session digests, and a
// DIRECTIVES.md generated from them into each project folder (module `directives`, default OFF
// because it writes into your project folders).
//
// WHY. Session notes and wiki pages are DERIVED: what sessions concluded. This is the other thing —
// what you actually said, verbatim, dated, per project. A direction restated in someone else's words
// invites agreement; your own sentence is the only thing that can contradict a session later.
//
// 1. RECOVERY (recover / writePages) reads <data>/conductor/digests (lib/digests.js) and keeps every
//    owner turn — INCLUDING turns the Conductor relayed verbatim ("<owner> via Conductor") — then:
//      * redacts LABELLED credentials, keeping their length (a label is what makes a credential; a
//        bare-token rule fires on ordinary long words). Redaction is not rotation.
//      * drops the FIRST owner turn of a spawned session (index `spawned_from`): that is the brief a
//        master or the Conductor wrote, not your words. Structural, so a brief phrased any way is caught.
//      * SPLIT, NOT MATCH: when an envelope (a cross-session block, a report line, a notification)
//        follows your words, cut at the envelope and keep the prefix if it has >= envelopePrefixMin
//        chars. A short instruction with a relay appended looks like a bare relay by position alone.
//      * drops acknowledgements (a closed list of whole strings — never a length rule), board replies,
//        machine-made blocks (matched in the HEAD only: a machine block declares itself at once; your
//        message that QUOTES one does not) and per-project duplicates.
//    EVERY drop and every cut is written to _excluded.md with what matched, so an over-eager filter is
//    findable instead of silent. Output: <data>/conductor/direction/<project>.md + INDEX.md; pages of
//    projects that vanished are deleted so nothing stale is served.
// 2. GENERATION (render) — newest first; an adaptive ACTIVE window; pinned timestamps; an optional
//    judged known-status table (<project>/.baton/known-status.json); an earlier index; short items; an
//    archive footer carrying a stable generator MARKER; and a hand-edit SENTINEL.
//    known-status.json (optional, in the project folder): a JSON list, or { "items": [...] }, of
//    { "ask": "<the request>", "date": "YYYY-MM-DD HH:MM", "status": "open|done|superseded|…",
//      "evidence": "<a path, a commit, a test>" }. Rows without "ask" are ignored. A timestamp in any
//    row PINS that directive in full, as does one cited in the hand edits.
// 3. SWEEP (regenProject) — only a file carrying the MARKER is ever deleted; hand edits below the
//    SENTINEL go to a sidecar BEFORE the delete and are re-attached after, and the sidecar is removed
//    only after the restore is read back and confirmed. A file without the marker is hand-written and
//    NEVER overwritten. A generated file edited ABOVE the sentinel (its body hash no longer matches) is
//    left alone too, rather than silently losing that edit.
// 4. A daily tick (tick) in the daemon and `baton directives [--dry-run] [project…]`.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

const MARKER = 'Generator: baton-directives';   // date-independent: a dated marker can never find last run's output
const SENTINEL = '<!-- baton-directives: hand edits below this line survive regeneration. Append corrections here, not above. -->';
const HASH_RX = /^<!-- baton-directives body-sha256: ([0-9a-f]{64}) -->$/m;
const TS_RX = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/g;
const BOARD_RX = /^\s*\[board\]\s/i;
const CONDUCTOR_LABEL_RX = /^\s*\[Conductor\b[^\]\n]{0,160}\]\s*/;
const SIDE_NAME = 'DIRECTIVES.hand-edits.md';

// Generic defaults. Personal vocabulary never goes here: settings.directives.* replaces or extends them.
const DEFAULT_ACKS = ['ok', 'okay', 'k', 'yes', 'y', 'no', 'n', 'done', 'thanks', 'thank you', 'ty', 'go ahead', 'do it',
  'yes do it', 'proceed', 'continue', 'go', 'sure', 'fine', 'good', 'great', 'nice', 'perfect', 'cool', 'yep', 'yeah', 'hmm',
  'stop', 'wait', 'ok do', 'ok done', 'yes please', 'no thanks', 'leave it', 'fix it', 'ok fix', 'fix all'];
// Machine-made blocks, matched in the first headChars only. Structural first (tags, ids, Relaymote's own
// notices); the wording-keyed tail is acceptable only because every hit lands in _excluded.md.
const DEFAULT_MACHINE = ['^\\s*local_[0-9a-f]{8}', '<cross-session-message', '<system-reminder', '<task-notification',
  '<scheduled-task', '^\\s*\\[(?:Relaymote|Baton)\\b', '^\\s*REPORTING: you ', 'Report to the Conductor', 'Report back to the master session',
  'This session is being continued from a previous conversation', 'Continue the conversation from where it left off',
  'This is an automated run of a scheduled task', '^Stop hook feedback:', 'A session-scoped Stop hook is now active',
  '^\\[Image: original \\d+x\\d+'];
// Where an appended machine artefact begins; the owner's words before it are kept.
const DEFAULT_ENVELOPES = ['<cross-session-message', '<system-reminder', '<task-notification', '<scheduled-task',
  'REPORTING: you were started by the Conductor', 'REPORTING: you work for '];
const DEFAULT_CRED_LABELS = ['client[ _-]?id', 'client[ _-]?secret', 'api[ _-]?key', 'access[ _-]?key', 'secret[ _-]?key',
  'private[ _-]?key', 'auth[ _-]?token', 'access[ _-]?token', 'refresh[ _-]?token', 'bearer', 'secret', 'token'];

const S_DEFAULTS = { runAt: '05:00', ownerName: '', include: [], exclude: [], substantialChars: 400, activeKb: 40, startDays: 30,
  minDays: 3, maxDays: 120, minItems: 5, staleHours: 24, headChars: 200, envelopePrefixMin: 15, acks: null,
  machinePatterns: null, extraMachinePatterns: [], envelopeTags: null, extraCredentialLabels: [], elsewhereFiles: [],
  knownStatusFile: '.baton/known-status.json' };

const DIR = () => path.join(config.DATA, 'conductor', 'direction');
const TICK_STATE = () => path.join(config.STATE, 'directives-tick.json');
const arr = v => Array.isArray(v) ? v : [];
const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function settings(over) {
  const s = { ...S_DEFAULTS, ...((config.get() || {}).directives || {}), ...(over || {}) };
  for (const k of ['substantialChars', 'activeKb', 'startDays', 'minDays', 'maxDays', 'minItems', 'staleHours', 'headChars', 'envelopePrefixMin']) {
    const n = Number(s[k]); s[k] = Number.isFinite(n) && n >= 0 ? n : S_DEFAULTS[k];
  }
  return s;
}
const who = s => String(s.ownerName || '').trim() || 'you';

// ------------------------------------------------------------------ credentials
/** Blank LABELLED secrets, keeping the length so the record shows something was there. */
function redact(text, extraLabels = []) {
  const labels = DEFAULT_CRED_LABELS.concat(arr(extraLabels).map(String).filter(Boolean)).join('|');
  const tok = new RegExp('\\b((?:' + labels + ')(?:\\s*[:=]\\s*|\\s+)[`"\']?)([A-Za-z0-9_\\-.+/=]{25,})', 'gi');
  const pw = new RegExp('\\b((?:password|passwd|passphrase|pwd)(?:\\s*[:=]\\s*|\\s+is\\s+)[`"\']?)([^\\s`"\']{6,})', 'gi');
  return String(text || '')
    .replace(tok, (m, a, v) => a + `[REDACTED-${v.length}-CHARS]`)
    .replace(pw, (m, a, v) => /^\[REDACTED-/.test(v) ? m : a + `[REDACTED-${v.length}-CHARS]`);
}

// ------------------------------------------------------------------ recovery
function filters(s) {
  const acks = new Set((Array.isArray(s.acks) ? s.acks : DEFAULT_ACKS).map(a => String(a).toLowerCase().trim()));
  const srcs = (Array.isArray(s.machinePatterns) ? s.machinePatterns : DEFAULT_MACHINE).concat(arr(s.extraMachinePatterns)).map(String).filter(Boolean);
  const valid = srcs.filter(p => { try { new RegExp(p); return true; } catch { return false; } });
  const machine = valid.length ? new RegExp(valid.map(p => '(?:' + p + ')').join('|'), 'im') : null;
  const envelopes = (Array.isArray(s.envelopeTags) ? s.envelopeTags : DEFAULT_ENVELOPES).map(String).filter(Boolean);
  return { acks, machine, envelopes, bad: srcs.filter(p => !valid.includes(p)) };
}

function digestFiles() {
  const dir = require('./digests').DIR();
  try { return fs.readdirSync(dir).filter(f => f.endsWith('.md') && !f.startsWith('_')).sort().map(f => path.join(dir, f)); } catch { return []; }
}
function digestMeta(file) {
  let head = '';
  try { const fd = fs.openSync(file, 'r'); try { const b = Buffer.alloc(4096); head = b.toString('utf8', 0, fs.readSync(fd, b, 0, 4096, 0)); } finally { fs.closeSync(fd); } } catch { return null; }
  const lines = head.split('\n');
  const title = lines[0] && lines[0].startsWith('# ') ? lines[0].slice(2).trim() : '';
  const m = /^session: (\S+) .*?project: (.*?) ·/.exec(lines[1] || '');
  return { title, sid: m ? m[1] : path.basename(file, '.md'), project: m ? m[2].trim() : null };
}
const flatOf = t => t.replace(/\s+/g, ' ').trim().toLowerCase().replace(/[.!]+$/, '');

/**
 * Every owner turn per project, filtered. index: the project index (sessions → project/spawned_from,
 * projects → path). Returns { projects: { name: { name, folder, items[] } }, excluded[], counts, corpus }.
 */
function recover({ index, settings: over } = {}) {
  const s = settings(over), F = filters(s), D = require('./digests');
  const ix = index || {}, sessions = ix.sessions || {}, projs = ix.projects || {};
  const out = {}, seen = {}, excluded = [];
  const counts = { digests: 0, owner_turns: 0, kept: 0, via_conductor: 0, envelope_split: 0, ack: 0, board: 0, machine: 0, duplicate: 0, brief: 0, redacted: 0 };
  let corpusFirst = null;
  const drop = (kind, why, when, proj, sid, text) => { counts[kind]++; excluded.push({ when: when || '', project: proj, sid, kind, why, text }); };
  for (const file of digestFiles()) {
    const meta = digestMeta(file);
    if (!meta) continue;
    counts.digests++;
    const sess = sessions[meta.sid] || {};
    const proj = sess.project || meta.project || '(unknown)';
    const p = out[proj] || (out[proj] = { name: proj, folder: (projs[proj] && projs[proj].path) || null, items: [] });
    const turns = D.turns(meta.sid).filter(t => t.kind === 'OWNER' || t.kind === 'OWNER_VIA_CONDUCTOR');
    counts.owner_turns += turns.length;
    turns.forEach((t, i) => {
      if (t.ts && (!corpusFirst || t.ts < corpusFirst)) corpusFirst = t.ts;
      const via = t.kind === 'OWNER_VIA_CONDUCTOR';
      let text = redact(t.body, s.extraCredentialLabels);
      if (text !== t.body) counts.redacted++;
      if (i === 0 && sess.spawned_from) return drop('brief', `spawned-session first turn (the brief; spawned_from ${sess.spawned_from})`, t.ts, proj, meta.sid, text);
      if (via) text = text.replace(CONDUCTOR_LABEL_RX, '');
      text = text.trim();
      if (!text) return;
      // SPLIT, DON'T MATCH: keep the owner's words when an envelope follows them.
      const cuts = F.envelopes.map(tag => [text.indexOf(tag), tag]).filter(([i2]) => i2 > 0).sort((a, b) => a[0] - b[0]);
      if (cuts.length) {
        const pre = text.slice(0, cuts[0][0]).trim();
        if (pre.length >= s.envelopePrefixMin) {
          excluded.push({ when: t.ts, project: proj, sid: meta.sid, kind: 'envelope-cut', why: `envelope cut at \`${cuts[0][1]}\` (kept the ${pre.length} chars before it)`, text: text.slice(cuts[0][0]) });
          counts.envelope_split++;
          text = pre;
        }
      }
      const flat = flatOf(text);
      if (F.acks.has(flat)) return drop('ack', 'acknowledgement', t.ts, proj, meta.sid, text);
      if (BOARD_RX.test(text)) return drop('board', 'board reply `[board] `', t.ts, proj, meta.sid, text);
      const m = F.machine && F.machine.exec(text.slice(0, s.headChars));
      if (m) return drop('machine', 'machine-made block, matched `' + m[0].slice(0, 40) + '`', t.ts, proj, meta.sid, text);
      const key = flat.slice(0, 400), sk = seen[proj] || (seen[proj] = new Map());
      if (sk.has(key)) return drop('duplicate', 'duplicate of ' + sk.get(key), t.ts, proj, meta.sid, text);
      sk.set(key, `${t.ts} in ${meta.sid}`);
      p.items.push({ ts: t.ts || '', text, sid: meta.sid, title: meta.title || meta.sid, via });
      counts.kept++;
      if (via) counts.via_conductor++;
    });
  }
  for (const p of Object.values(out)) p.items.sort((a, b) => b.ts.localeCompare(a.ts));
  return { projects: out, excluded, counts, corpus: { digests: counts.digests, first: corpusFirst }, badPatterns: F.bad };
}

const safeName = n => String(n).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
const pagePath = n => path.join(DIR(), safeName(n) + '.md');

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/** Existing files, from a list of paths relative to a project folder, that hold its history instead. */
function elsewhere(folder, s) {
  if (!folder) return [];
  return arr(s.elsewhereFiles).map(r => path.join(folder, String(r))).filter(f => { try { return fs.statSync(f).isFile(); } catch { return false; } });
}

/** Write the per-project direction pages, INDEX.md and _excluded.md; delete pages of vanished projects. */
function writePages(rec, { settings: over } = {}) {
  const s = settings(over), pos = s.ownerName ? `${s.ownerName}'s` : 'your';
  const dir = DIR(), keep = new Set(['INDEX.md', '_excluded.md']), index = [];
  for (const p of Object.values(rec.projects).sort((a, b) => a.name.localeCompare(b.name))) {
    const L = [`# ${p.name} — direction, in ${pos} own words`, '',
      `${p.items.length} messages, newest first. Verbatim, except labelled credentials (redacted, length kept). Acknowledgements, board replies, ` +
      'machine-made blocks, duplicates and the first turn of spawned sessions are excluded — each one is listed in `_excluded.md` with what matched.',
      'Rebuilt by `baton directives`. Do not edit by hand — it is regenerated.', ''];
    const other = p.items.length < 3 ? elsewhere(p.folder, s) : [];
    if (other.length) {
      L.push('> THIN HERE BY ORIGIN, NOT BY SILENCE. This project keeps its history in its own folder too. Read:');
      for (const f of other) L.push('> - `' + f + '`');
      L.push('');
    }
    for (const it of p.items) L.push(`## ${it.ts || '(undated)'} — ${String(it.title).slice(0, 80)}${it.via ? ' · via Conductor' : ''}`, '`' + it.sid + '`', '', it.text.replace(/\s+$/, ''), '', '---', '');
    const fn = safeName(p.name) + '.md';
    writeAtomic(path.join(dir, fn), L.join('\n'));
    keep.add(fn);
    index.push([p.name, p.items.length, fn]);
  }
  const removed = [];
  try {
    for (const fn of fs.readdirSync(dir)) {
      if (fn.endsWith('.md') && !keep.has(fn)) { try { fs.unlinkSync(path.join(dir, fn)); removed.push(fn); } catch {} }
    }
  } catch {}
  writeAtomic(path.join(dir, 'INDEX.md'), [`# Direction — every project, in ${pos} own words`, '',
    `Rebuilt from ${rec.corpus.digests} session digests. **These are quotes, not summaries.** Kept ${rec.counts.kept}; ` +
    `excluded ${rec.excluded.filter(e => e.kind !== 'envelope-cut').length} and cut ${rec.counts.envelope_split} (see \`_excluded.md\`).`, '',
    ...index.sort((a, b) => b[1] - a[1]).map(([n, c, fn]) => `- [${n}](${fn}) — ${c}`), ''].join('\n'));
  const X = ['# Excluded from the direction pages — with what matched', '',
    `${rec.excluded.length} entries. A digest labels a turn as yours because it is the USER role; briefs, relays and ` +
    'harness notices arrive the same way. Each entry names WHAT matched, so a wrong exclusion is findable rather than silent. ' +
    '`envelope-cut` entries show the part cut AWAY from a message whose words were kept.', ''];
  for (const e of rec.excluded.slice().sort((a, b) => b.when.localeCompare(a.when))) {
    X.push(`## ${e.when || '(undated)'} | ${e.project} | ${e.kind} | ${e.why}`, '`' + e.sid + '`', '', String(e.text).slice(0, 1200).replace(/\s+$/, ''), '', '---', '');
  }
  writeAtomic(path.join(dir, '_excluded.md'), X.join('\n'));
  return { dir, pages: index.length, removed };
}

// ------------------------------------------------------------------ generation
const dayMs = 86400000;
const dateOf = ts => String(ts || '').slice(0, 10);
const minusDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') - n * dayMs).toISOString().slice(0, 10);

/**
 * The adaptive ACTIVE window over the substantial items (newest first): start at startDays, shrink
 * while the section is over activeKb (never below minDays), then widen while it holds fewer than
 * minItems (never past maxDays, never past what exists).
 */
function chooseWindow(sub, s) {
  if (!sub.length) return { days: s.startDays, from: null, active: [], kb: 0 };
  const last = dateOf(sub[0].ts);
  const cut = w => { const from = minusDays(last, w); const a = sub.filter(m => dateOf(m.ts) >= from); return { days: w, from, active: a, kb: a.reduce((n, m) => n + Buffer.byteLength(m.text), 0) / 1024 }; };
  let w = s.startDays, r = cut(w);
  while (r.kb > s.activeKb && w > s.minDays) r = cut(--w);
  while (r.active.length < s.minItems && r.active.length < sub.length && w < s.maxDays) r = cut(++w);
  return r;
}

/** Known-status rows from <folder>/<knownStatusFile>: [{ ask, date, status, evidence }] or { items: [...] }. */
function readKnownStatus(folder, s) {
  if (!folder) return { rows: [], file: null };
  const file = path.join(folder, s.knownStatusFile);
  let raw; try { raw = fs.readFileSync(file, 'utf8'); } catch { return { rows: [], file }; }
  try {
    const d = JSON.parse(raw);
    const rows = (Array.isArray(d) ? d : arr(d && d.items)).filter(r => r && typeof r === 'object' && r.ask);
    return { rows, file };
  } catch (e) { return { rows: [], file, error: 'unreadable ' + s.knownStatusFile + ': ' + e.message }; }
}
const pinsFrom = (rows, edits) => {
  const pins = new Set();
  for (const r of rows) for (const k of ['date', 'evidence', 'ask']) for (const m of String(r[k] || '').match(TS_RX) || []) pins.add(m);
  for (const m of String(edits || '').match(TS_RX) || []) pins.add(m);
  return pins;
};
const cell = v => String(v == null ? '' : v).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
const bq = t => t.split('\n').map(l => l.trim() ? '> ' + l : '>').join('\n');
const sha = t => crypto.createHash('sha256').update(t, 'utf8').digest('hex');
const pad = n => String(n).padStart(2, '0');
const localStamp = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** The generated DIRECTIVES.md body, ending with the marker footer, the body hash and the SENTINEL line. */
function render(p, { corpus = {}, known = { rows: [] }, pins = new Set(), now = new Date(), settings: over } = {}) {
  const s = settings(over), W = who(s), SUB = s.substantialChars;
  const msgs = p.items, sub = msgs.filter(m => m.text.length >= SUB), short = msgs.filter(m => m.text.length < SUB);
  const win = chooseWindow(sub, s);
  const older = win.from ? sub.filter(m => dateOf(m.ts) < win.from) : [];
  const pinned = older.filter(m => pins.has(m.ts)), rest = older.filter(m => !pins.has(m.ts));
  const active = pinned.concat(win.active);
  const archive = pagePath(p.name), built = localStamp(now), q = JSON.stringify(p.name);
  const last = msgs.length ? dateOf(msgs[0].ts) : '(none)', first = msgs.length ? dateOf(msgs[msgs.length - 1].ts) : '(none)';
  const L = [];
  L.push(`# ${p.name} — directives, verbatim and dated`, '',
    `> ### AS AT ${built} · corpus ${corpus.digests || 0} digests · ${msgs.length} messages from ${W}`,
    `> **If that timestamp is more than ${s.staleHours}h old, re-run before quoting this file:** \`baton directives ${q}\``,
    '> This file is a SNAPSHOT. It goes stale silently, and in the direction of misrepresenting what was said last.',
    '> Nothing about a stale file looks stale — the AS AT line above is the only tell.', '',
    '**Read this file at the start of every session in this project, before planning anything.**', '',
    '## How this file works', '',
    `- **Every substantial instruction from ${W} is here verbatim, with a timestamp.** Not summarised — a summary is someone else's reading of what was wanted; the wording is the specification.`,
    '- **Later directions supersede earlier ones.** When that is established, record `SUPERSEDED by <date>` for the earlier one below the hand-edit line at the end — **never delete it.** The history is how a session understands why the current shape exists.',
    '- **If a new instruction seems to contradict an earlier one by mistake, ASK** rather than silently picking.',
    '- **Never mark an item done from intention.** Done means the artefact exists and was checked.',
    '- Progress belongs in the project\'s status file (e.g. `STATE.md`); this file holds WHAT WAS ASKED FOR, not what was done.',
    '- **Hand edits go BELOW the hand-edit line at the very end.** Everything above it is regenerated; everything below it survives. A timestamp (`YYYY-MM-DD HH:MM`) you cite there keeps that directive in full even after it ages out of ACTIVE.', '',
    '## Provenance and coverage — read this before trusting the file', '',
    `- **Built ${built} by \`baton directives\` from \`${archive}\`** — messages extracted verbatim from the session digests. **${msgs.length} messages** in this project, of which **${sub.length} are substantial** (≥${SUB} chars).`,
    `- **Earliest message here: ${first}. The digest corpus itself begins ${dateOf(corpus.first) || '(unknown)'}.** Anything said before that, or in sessions Relaymote never saw, is not here. Do not read this file as everything ever said about ${p.name}.`,
    '- **Supersession is NOT judged in the generated sections.** ACTIVE is a time window, not a verdict; an item in it may already be done or overruled. The only judged entries are under **Known status**, and each names its evidence.',
    win.from ? `- **ACTIVE window: substantial directives from the last ${win.days} days (${win.from} → ${last}), verbatim.** Sized so the section stays under ~${s.activeKb} KB and is actually read. Everything older is in **Earlier — index**, one line each, with the full text in the archive (grep the timestamp). Nothing is dropped.`
      : '- **No substantial directive yet** — see the shorter instructions below.',
    '- **A session needs only the sections down to the end of ACTIVE.** Everything after is reference for when you hunt for something specific.',
    '- Labelled credentials (client id/secret, api key, token, password) are redacted with their length kept. Redaction is not rotation.', '',
    '---', '');
  L.push('## Known status — judged, with evidence', '');
  if (known.rows.length) {
    L.push('| ask | date | status | evidence |', '|---|---|---|---|');
    for (const k of known.rows) L.push(`| ${cell(k.ask)} | ${cell(k.date)} | **${cell(k.status || '?')}** | ${cell(k.evidence)} |`);
    L.push('', `Source: \`${s.knownStatusFile}\` in this folder.`, '');
  } else {
    L.push(`*None recorded yet. Add rows to \`${s.knownStatusFile}\` in this folder — a JSON list of \`{ "ask", "date", "status", "evidence" }\` — and only with evidence: a file path, a commit, a test.*`, '');
  }
  if (known.error) L.push(`> Known-status file could not be read: ${known.error}`, '');
  L.push('---', '',
    `## ACTIVE — substantial directives, last ${win.days} days, verbatim, newest first (${active.length} items${pinned.length ? `, ${pinned.length} PINNED (cited by timestamp, older than the window)` : ''})`, '',
    'Some blocks are transcripts pasted to show what was seen — **the instruction is usually at the end of the block.** Read each block to its end.', '');
  if (!active.length) L.push('*No substantial directive in this window. See Earlier — index.*', '');
  for (const m of active) {
    const tag = pinned.includes(m) ? ' · PINNED — cited by timestamp in Known status or a hand edit; would otherwise be a one-line stub in Earlier' : '';
    L.push(`### ${m.ts} · ${m.title}${m.via ? ' · via Conductor' : ''}${tag}`, '', bq(m.text), '');
  }
  L.push('---', '', `## Earlier — index of substantial directives before ${win.from || '(none)'} (${rest.length} items, one line each; full text in the archive, grep the timestamp)`, '',
    '**Not judged.** Any of these may still be active, done, or overruled by something above. A session that establishes which should record it below the hand-edit line, not delete it.', '');
  for (const m of rest) L.push(`- \`${m.ts}\` · ${String(m.title).slice(0, 50)} — ${m.text.split(/\s+/).join(' ').slice(0, 160)}…`);
  L.push('', '---', '', `## Shorter instructions (under ${SUB} chars) — verbatim, newest first (${short.length} items)`, '',
    'Short is not unimportant — the sharpest rules are often one line. Acknowledgements and board replies were excluded upstream.', '');
  for (const m of short) L.push(`- \`${m.ts}\` — ${m.text.split(/\s+/).join(' ')}`);
  L.push('', '---', '', `*Archive (every message, verbatim): \`${archive}\` · Progress: the status file in this folder · ${MARKER} (\`baton directives\`).*`, '');
  const body = L.join('\n');
  return { text: body + `<!-- baton-directives body-sha256: ${sha(body)} -->\n` + SENTINEL, stats: { msgs: msgs.length, sub: sub.length, active: active.length, pinned: pinned.length, days: win.days, earlier: rest.length, short: short.length } };
}

/** Is a generated file's body (above the sentinel) exactly what was generated? false = someone edited above the line. */
function bodyIntact(text) {
  const t = String(text).replace(/\r\n/g, '\n');
  const above = t.split(SENTINEL)[0];
  const m = HASH_RX.exec(above);
  if (!m) return false;
  return sha(above.slice(0, m.index)) === m[1];
}

// ------------------------------------------------------------------ sweep
/**
 * Regenerate one project's DIRECTIVES.md. Never overwrites a file without the MARKER. Hand edits
 * below the SENTINEL go to <folder>/.baton/DIRECTIVES.hand-edits.md first, are re-attached, read back,
 * and only then is the sidecar removed. A sidecar left by an earlier failed run is re-attached too.
 * opts.writeFile (tests) replaces fs.writeFileSync for the regenerated file.
 */
function regenProject(p, { corpus, now = new Date(), dryRun = false, settings: over, writeFile = fs.writeFileSync } = {}) {
  const s = settings(over), r = { project: p.name, folder: p.folder || null, file: null };
  if (!p.folder || !fs.existsSync(p.folder)) return { ...r, status: 'no-folder' };
  const out = path.join(p.folder, 'DIRECTIVES.md'), side = path.join(p.folder, '.baton', SIDE_NAME);
  r.file = out;
  const leftover = fs.existsSync(side) ? fs.readFileSync(side, 'utf8') : null;
  let edits = leftover || '';
  const exists = fs.existsSync(out);
  if (exists) {
    const t = fs.readFileSync(out, 'utf8').replace(/\r\n/g, '\n');
    if (!t.includes(MARKER)) return { ...r, status: 'kept-hand-written', note: 'no generator marker — a hand-written file is never overwritten' };
    if (!bodyIntact(t)) return { ...r, status: 'kept-edited-above', warn: true, note: 'edited ABOVE the hand-edit line — not regenerated; move the edit below the line (or delete the file) to resume' };
    const cur = t.includes(SENTINEL) ? t.split(SENTINEL).slice(1).join(SENTINEL) : '';
    if (leftover != null && cur.trim() && !cur.includes(leftover.trim())) {
      return { ...r, status: 'conflict', fail: true, sidecar: side, note: 'a sidecar from an earlier failed run AND different hand edits in the file — merge them by hand, then delete the sidecar' };
    }
    if (cur.trim()) edits = cur;
  }
  if (!p.items.length) {
    // Nothing to generate from: an existing file is left exactly as it is (never deleted for want of a
    // replacement); a sidecar with no file to go back into is a failed restore, and it stays.
    if (exists) return { ...r, status: 'kept-no-messages', warn: true, note: 'no messages left to generate from — the existing file was not touched' };
    if (leftover != null && leftover.trim()) return { ...r, status: 'restore-failed', fail: true, sidecar: side, note: 'no messages to generate from — hand edits still in the sidecar' };
    return { ...r, status: 'no-messages' };
  }
  const known = readKnownStatus(p.folder, s);
  const g = render(p, { corpus, known, pins: pinsFrom(known.rows, edits), now, settings: over });
  const full = g.text + (edits.trim() ? edits : '\n');
  if (dryRun) return { ...r, status: exists ? 'would-regenerate' : 'would-write', stats: g.stats, bytes: Buffer.byteLength(full), hand_edits: edits.trim() ? Buffer.byteLength(edits) : 0 };
  if (edits.trim() && leftover !== edits) {
    writeAtomic(side, edits);
    if (fs.readFileSync(side, 'utf8') !== edits) return { ...r, status: 'restore-failed', fail: true, sidecar: side, note: 'sidecar did not read back — the old file was NOT touched' };
  }
  if (exists) fs.unlinkSync(out);   // only a MARKER file reaches this line
  let okWrite = true, err = null;
  try { writeFile(out, full); } catch (e) { okWrite = false; err = e.message; }
  let back = null; try { back = fs.readFileSync(out, 'utf8'); } catch {}
  if (!okWrite || back !== full) {
    return { ...r, status: 'restore-failed', fail: true, sidecar: edits.trim() ? side : null, note: 'the regenerated file did not read back' + (err ? ' (' + err + ')' : '') + (edits.trim() ? ' — hand edits kept in the sidecar' : '') };
  }
  if (edits.trim()) { try { fs.unlinkSync(side); } catch {} }
  return { ...r, status: 'written', stats: g.stats, bytes: Buffer.byteLength(full), restored: edits.trim() ? Buffer.byteLength(edits) : 0 };
}

// ------------------------------------------------------------------ run + tick
/**
 * Recover, write the direction pages, regenerate DIRECTIVES.md for every project with a folder (or
 * only those whose name contains one of `only`). dryRun writes nothing. requireModule refuses when
 * the directives module is off. ok is false when nothing was (or would be) written, or a restore failed.
 */
function run({ index, only = [], dryRun = false, requireModule = false, now = new Date(), settings: over, writeFile } = {}) {
  if (requireModule && !config.mod('directives')) {
    return { ok: false, error: 'MODULE_OFF', message: 'The directives module is off (it writes DIRECTIVES.md into your project folders). Turn on settings.modules.directives, or run `baton directives` from a terminal.' };
  }
  const s = settings(over);
  const ix = index || require('./projects').read();
  if (!ix) return { ok: false, error: 'NO_INDEX', message: 'no project index yet — run `baton index build --digests` first' };
  const rec = recover({ index: ix, settings: over });
  if (!rec.corpus.digests) return { ok: false, error: 'NO_DIGESTS', message: 'no session digests — turn on the digests module or run `baton index build --digests`' };
  const pages = dryRun ? null : writePages(rec, { settings: over });
  const inc = arr(s.include).map(x => String(x).toLowerCase()), exc = arr(s.exclude).map(x => String(x).toLowerCase());
  const want = arr(only).map(x => String(x).toLowerCase()).filter(Boolean);
  const results = [];
  for (const p of Object.values(rec.projects).sort((a, b) => a.name.localeCompare(b.name))) {
    const n = p.name.toLowerCase();
    if (want.length && !want.some(o => n.includes(o))) continue;
    if (inc.length && !inc.includes(n)) continue;
    if (exc.includes(n)) continue;
    try { results.push(regenProject(p, { corpus: rec.corpus, now, dryRun, settings: over, writeFile })); }
    catch (e) { results.push({ project: p.name, status: 'error', fail: true, note: e.message }); }
  }
  const written = results.filter(r => r.status === (dryRun ? 'would-write' : 'written') || (dryRun && r.status === 'would-regenerate')).length;
  const failed = results.filter(r => r.fail);
  const ok = written > 0 && !failed.length;
  const lines = results.map(r => `${String(r.project).padEnd(24)} ${r.status}${r.stats ? ` · ${r.stats.msgs} msgs · ${r.stats.sub} substantial · ACTIVE ${r.stats.active} (${r.stats.days}d${r.stats.pinned ? `, ${r.stats.pinned} pinned` : ''}) · earlier ${r.stats.earlier} · short ${r.stats.short}` : ''}${r.restored ? ` · hand edits restored (${r.restored} B)` : ''}${r.note ? ' · ' + r.note : ''}`);
  if (!written) lines.push(dryRun ? 'NOTHING WOULD BE WRITTEN' : 'NOTHING WRITTEN — a run that writes nothing is a failure, not a quiet success');
  if (rec.badPatterns.length) lines.push('ignored invalid machinePatterns: ' + rec.badPatterns.join(', '));
  return { ok, dryRun, written, failed: failed.length, recovery: rec.counts, corpus: rec.corpus, pages, results, lines };
}

const hhmm = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const localDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** Due once per local day, at or after runAt ("HH:MM"). */
function isDue(now, runAt, lastDate) {
  const at = /^\d{1,2}:\d{2}$/.test(String(runAt || '')) ? String(runAt).padStart(5, '0') : S_DEFAULTS.runAt;
  return lastDate !== localDate(now) && hhmm(now) >= at;
}
function readTick() { try { return JSON.parse(fs.readFileSync(TICK_STATE(), 'utf8')) || {}; } catch { return {}; } }

/** The daemon's daily pass. null when the module is off or it is not due. */
function tick({ now = new Date(), index, writeFile } = {}) {
  if (!config.mod('directives')) return null;
  const st = readTick();
  if (!isDue(now, settings().runAt, st.lastDate)) return null;
  let r;
  try { r = run({ index, now, writeFile }); } catch (e) { r = { ok: false, error: 'ERROR', message: e.message, lines: [] }; }
  try { writeAtomic(TICK_STATE(), JSON.stringify({ lastDate: localDate(now), at: now.toISOString(), ok: r.ok, written: r.written || 0, failed: r.failed || 0, error: r.error || null })); } catch {}
  return r;
}

module.exports = { MARKER, SENTINEL, SIDE_NAME, DIR, TICK_STATE, DEFAULT_ACKS, DEFAULT_MACHINE, DEFAULT_ENVELOPES, DEFAULT_CRED_LABELS,
  settings, redact, recover, writePages, chooseWindow, readKnownStatus, render, bodyIntact, regenProject, run, isDue, tick };
