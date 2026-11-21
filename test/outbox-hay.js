'use strict';
// outbox-hay.js — 21-Nov-2026. While a message sat pending (an hour, in a long turn) the outbox re-read a 2 MB transcript
// tail every 5 s and rebuilt its search text twice: 3-4 s loop stalls in norm / unescapeTranscript / withoutQueueOps /
// transcriptTail (21-Nov 22:30 IST). Now the tail is read incrementally and only new lines are processed.
// Checked: the incremental text equals the old full rebuild; the work per tick is the new lines only; transcriptTail reads
// only the appended bytes and returns the same string when nothing changed.
const fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-hay-'));
process.env.RELAYMOTE_STATE_DIR = tmp;
process.env.RELAYMOTE_HOME = tmp;   // always a temp home: loading mobile/index.js makes an access token
delete process.env.RELAYMOTE_MOBILE_SECRET;
const ob = require('../mobile/outbox.js');
let fails = 0;
const check = (ok, what, got) => { console.log((ok ? 'ok   ' : 'FAIL ') + what + (ok || got === undefined ? '' : '  ' + JSON.stringify(got).slice(0, 300))); if (!ok) fails++; };
const NL = '\n';
const full = (raw, dq) => ob.norm(ob.unescapeTranscript(dq ? ob.withoutQueueOps(raw) : raw));

// A transcript with the awkward bits: escapes, \u sequences, quotes, backslashes, blank lines, queue rows, Hindi.
let seed = 7; const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
const bits = ['hello  world', 'line\\nbreak', 'tab\\there', 'quote \\"x\\"', 'back\\\\slash', '\\u0041\\u00e9', 'नमस्ते  दुनिया', '   ', '@C:\\\\up\\\\a.jpg'];
function row(i) {
  if (i % 7 === 3) return JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: 'queued ' + i });
  if (i % 11 === 5) return '';
  const words = []; for (let k = 0; k < 3 + rnd(6); k++) words.push(bits[rnd(bits.length)]);
  return '{"type":"user","uuid":"u' + i + '","message":{"content":"' + words.join(' ') + ' #' + i + '"}}';
}
const lines = []; for (let i = 0; i < 3000; i++) lines.push(row(i));
const all = lines.join(NL) + NL;

// 1. Growing in uneven chunks (often mid-line, as a live write is): equal to the full rebuild at every step.
for (const dq of [true, false]) {
  ob._resetHay();
  let bad = null;
  for (let at = 1; at <= all.length && !bad; at += 1 + rnd(900)) {
    const raw = all.slice(0, at);
    if (ob.hayFor('g' + dq, raw, dq) !== full(raw, dq)) bad = at;
  }
  if (!bad && ob.hayFor('g' + dq, all, dq) !== full(all, dq)) bad = all.length;
  check(!bad, 'incremental text equals the full rebuild at every growth step' + (dq ? ' (queue rows dropped)' : ''), bad);
}

// 2. A sliding tail window (front cut, end grows): every recent message is still found, none is invented.
{
  ob._resetHay();
  const W = 60000; let miss = null, ghost = null;
  for (let end = W; end <= all.length && !miss; end += 3000 + rnd(2000)) {
    const raw = all.slice(end - W, end), hay = ob.hayFor('w', raw, true);
    const recent = raw.split(NL).slice(-40, -1).filter(l => l && l.indexOf('queue-operation') < 0);
    for (const l of recent) { const n = ob.norm(ob.unescapeTranscript(l)); if (n && !hay.includes(n)) { miss = l; break; } }
    if (hay.includes('queued ')) ghost = 'a queue row leaked into the reconcile text';
  }
  check(!miss && !ghost, 'a sliding tail window keeps every recent line and no queue row', miss || ghost);
}

// 3. The work: a 2 MB tail growing 5 KB per tick for 20 ticks. The old way processed 2 MB x 20 (x2 for checkAccepted).
{
  ob._resetHay();
  let big = ''; let i = 0; while (big.length < 2 * 1024 * 1024) big += row(i++) + NL;
  ob.hayFor('b', big, true);
  const first = ob.hayWork();
  let t = Date.now();
  for (let k = 0; k < 20; k++) { let add = ''; while (add.length < 5000) add += row(i++) + NL; big = big.slice(add.length) + add; ob.hayFor('b', big, true); }
  const later = ob.hayWork() - first, ms = Date.now() - t;
  check(later < 20 * 8000, '20 ticks process only their new lines (' + later + ' chars, was ' + 20 * big.length + ')', later);
  const same = Date.now(); for (let k = 0; k < 50; k++) ob.hayFor('b', big, true);
  check(ob.hayWork() - first === later && Date.now() - same < 200, 'an unchanged tail costs nothing (' + (Date.now() - same) + ' ms for 50)');
  console.log('     (20 growing ticks took ' + ms + ' ms)');
}

// 4. transcriptTail: reads only appended bytes, whole lines, and hands back the very same string when unchanged.
{
  const sessions = require('../mobile/sessions.js');
  const file = path.join(tmp, 'cli-x.jsonl');
  fs.writeFileSync(file, lines.slice(0, 500).join(NL) + NL);
  const g0 = sessions.get, p0 = sessions.transcriptPath;
  sessions.get = (id) => id === 'local_hay' ? { id, cwd: tmp, cliSessionId: 'cli-x' } : g0(id);
  sessions.transcriptPath = (s) => s && s.cliSessionId === 'cli-x' ? file : p0(s);
  const mob = require('../mobile/index.js');
  const reads = []; const r0 = fs.readSync;
  fs.readSync = function (fd, buf, off, len, pos) { reads.push(len); return r0.apply(this, arguments); };
  try {
    const a = mob.transcriptTail('local_hay');
    check(a === lines.slice(0, 500).join(NL) + NL, 'the first read returns the whole (small) transcript');
    reads.length = 0;
    const b = mob.transcriptTail('local_hay');
    check(b === a && reads.length === 0, 'unchanged: the same string and no read');
    fs.appendFileSync(file, lines[500] + NL + lines[501].slice(0, 20));   // one whole line + a write in progress
    const c = mob.transcriptTail('local_hay');
    check(c === a + lines[500] + NL && reads.length === 1 && reads[0] === Buffer.byteLength(lines[500] + NL + lines[501].slice(0, 20)),
      'growth: only the appended bytes are read, and a half-written line waits', reads);
    fs.appendFileSync(file, lines[501].slice(20) + NL);
    check(mob.transcriptTail('local_hay') === a + lines[500] + NL + lines[501] + NL, 'the finished line then arrives whole');
    fs.writeFileSync(file, lines[2] + NL);
    check(mob.transcriptTail('local_hay') === lines[2] + NL, 'a shrunk (rewritten) file is read afresh');
    const src = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'index.js'), 'utf8');
    check(/outbox\.checkAccepted\(transcriptTail, Date\.now\(\), held\)/.test(src) && /outbox\.reconcile\(transcriptTail, Date\.now\(\), busy\)/.test(src), 'both outbox checks read through it');
  } finally { fs.readSync = r0; sessions.get = g0; sessions.transcriptPath = p0; }
}

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
if (fails) { console.error(fails + ' failed'); process.exit(1); }
console.log('outbox-hay: all checks passed');
process.exit(0);
