'use strict';
// 15-Nov: pendingChips / pendingQuestion read a transcript incrementally. They used to read the newest 2 MB and JSON.parse
// every line on every change of the watched session; the log showed readWindow stalls up to 13 s and one of 231 s in
// pendingChips (14-Nov 08:39Z). This replays a growing transcript against the OLD full-window code (copied here) and
// checks the new code gives the same answers after every append while reading only what was appended.
const fs = require('fs'), os = require('os'), path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-tail-'));
process.env.CLAUDE_CONFIG_DIR = dir;
const S = require('../mobile/sessions.js');
let fails = 0;
const check = (ok, what, got) => { console.log((ok ? 'ok   ' : 'FAIL ') + what + (ok || got === undefined ? '' : '  ' + JSON.stringify(got).slice(0, 400))); if (!ok) fails++; };

// ---- the old code, verbatim in behaviour
function oldWindow(file, size) { const t = fs.readFileSync(file); return t.slice(Math.max(0, t.length - size)).toString('utf8'); }
function oldChips(file, maxBytes) {
  const norm = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const seen = new Map();
  for (const line of oldWindow(file, maxBytes).split('\n')) {
    const t = line.trim(); if (!t) continue;
    let row; try { row = JSON.parse(t); } catch { continue; }
    const content = row.message && row.message.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (!b || b.type !== 'tool_use') continue;
      const nm = String(b.name || '');
      if (/dismiss_task$/i.test(nm)) { const dt = String((b.input || {}).title || '').trim(); if (dt) seen.delete(norm(dt)); continue; }
      if (!/spawn_task$/i.test(nm)) continue;
      const title = String((b.input || {}).title || '').trim(); if (!title) continue;
      seen.set(norm(title), { title, ts: row.timestamp || null });
    }
  }
  return [...seen.values()];
}
function oldQuestion(file, maxBytes) {
  const asks = new Map(), answered = new Set();
  for (const line of oldWindow(file, maxBytes).split('\n')) {
    const t = line.trim(); if (!t) continue;
    let row; try { row = JSON.parse(t); } catch { continue; }
    const content = row.message && row.message.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'tool_use' && b.name === 'AskUserQuestion' && b.id) asks.set(b.id, b.input || {});
      if (b.type === 'tool_result' && b.tool_use_id) answered.add(b.tool_use_id);
    }
  }
  let out = null;
  for (const [id, input] of asks) { if (answered.has(id)) continue; const qs = Array.isArray(input.questions) ? input.questions : []; if (qs.length) out = { id, questions: qs }; }
  return out;
}

// ---- a transcript that grows the way a working session's does
const file = path.join(dir, 't.jsonl');
fs.writeFileSync(file, '');
let n = 0;
const ts = () => new Date(Date.UTC(2026, 10, 15, 0, 0, n)).toISOString();
const asst = (blocks) => JSON.stringify({ type: 'assistant', timestamp: ts(), message: { role: 'assistant', content: blocks } });
const user = (blocks) => JSON.stringify({ type: 'user', timestamp: ts(), message: { role: 'user', content: blocks } });
const filler = () => asst([{ type: 'text', text: 'working on it '.repeat(40) + n + ' ünïcødé ✓' }]);
function rowFor(i) {
  const k = i % 23;
  if (k === 3) return asst([{ type: 'tool_use', id: 'toolu_q' + i, name: 'AskUserQuestion', input: { questions: [{ question: 'Pick ' + i, options: [] }] } }]);
  if (k === 7) return user([{ type: 'tool_result', tool_use_id: 'toolu_q' + (i - 4), content: 'answered' }]);
  if (k === 11) return asst([{ type: 'tool_use', id: 'toolu_s' + i, name: 'mcp__ccd_session__spawn_task', input: { title: 'Task ' + (i % 5) } }]);
  if (k === 17) return asst([{ type: 'tool_use', id: 'toolu_d' + i, name: 'mcp__ccd_session__dismiss_task', input: { title: 'Task ' + ((i + 1) % 5) } }]);
  if (k === 19) return user([{ type: 'tool_result', tool_use_id: 'toolu_x' + i, content: 'quoted text "tool_use_id":"toolu_q' + (i - 1) + '" inside' }]);
  return filler();
}
const MAX = 64 * 1024;   // a small window so it moves many times during the run
let mismatches = 0, steps = 0, pending = '';
for (let i = 0; i < 1400; i++) {
  n++;
  let chunk = pending + rowFor(i) + '\n';
  pending = '';
  // Every 9th append stops mid-line, as a write in progress does; the rest of the line lands with the next append.
  if (i % 9 === 4) { const cut = Math.floor(chunk.length / 2); pending = chunk.slice(cut); chunk = chunk.slice(0, cut); }
  fs.appendFileSync(file, chunk);
  if (i % 3) continue;
  steps++;
  const a = S.chipsInFile(file, { maxBytes: MAX }).map(({ title, ts }) => ({ title, ts }));
  const b = oldChips(file, MAX);
  const q1 = S.questionInFile(file, { maxBytes: MAX }), q2 = oldQuestion(file, MAX);
  if (JSON.stringify(a) !== JSON.stringify(b) || JSON.stringify(q1) !== JSON.stringify(q2)) {
    if (!mismatches++) console.log('first mismatch at row ' + i, JSON.stringify({ a, b, q1, q2 }).slice(0, 600));
  }
}
check(mismatches === 0, `same chips and question as the old full-window code at all ${steps} looks (window moved, mid-line writes)`, mismatches);
const size = fs.statSync(file).size;
check(S.tailStats.bytesRead < size * 2 + 2 * MAX, `bytes read stay ~1x the file per reader (${S.tailStats.bytesRead} for a ${size}-byte file; the old code read ${steps * 2} windows)`, S.tailStats.bytesRead);
S.chipsInFile(file, { maxBytes: MAX }); S.questionInFile(file, { maxBytes: MAX });   // catch up on the last append
const before = S.tailStats.bytesRead, parsedBefore = S.tailStats.parsed;
S.chipsInFile(file, { maxBytes: MAX }); S.questionInFile(file, { maxBytes: MAX });
check(S.tailStats.bytesRead === before && S.tailStats.parsed === parsedBefore, 'an unchanged transcript is not read or parsed again');

// A rewritten (shorter) transcript starts over.
fs.writeFileSync(file, asst([{ type: 'tool_use', id: 'toolu_new', name: 'AskUserQuestion', input: { questions: [{ question: 'fresh', options: [] }] } }]) + '\n');
const q = S.questionInFile(file, { maxBytes: MAX });
check(q && q.id === 'toolu_new' && JSON.stringify(S.chipsInFile(file, { maxBytes: MAX })) === '[]', 'a rewritten transcript is read from scratch', q);

// Only rows that can matter are parsed.
const big = path.join(dir, 'big.jsonl');
fs.writeFileSync(big, Array.from({ length: 3000 }, (_, i) => (n = i, filler())).join('\n') + '\n');
const p0 = S.tailStats.parsed;
S.chipsInFile(big); S.questionInFile(big);
check(S.tailStats.parsed - p0 === 0, 'plain text rows are never JSON-parsed', S.tailStats.parsed - p0);

fs.rmSync(dir, { recursive: true, force: true });
if (fails) { console.error(fails + ' failed'); process.exit(1); }
console.log('tail-incremental: all checks passed');
