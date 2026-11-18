// boot-reads.js — 19-Nov-2026. After a PC reboot (18-Nov 10:41 IST) the daemon's first seconds held the event loop on
// three synchronous reads from a cold disk: seedShapes sessions.js:74 (5.0 s, the 6 MB shape cache), loadSnapshot
// desktop.js:3301 (1.6 s) and transcriptPath sessions.js:298 (one existsSync, 2.0 s). Each is now read without blocking
// (or once, then trusted for 30 s). Each check below counts SYNCHRONOUS calls in a fresh process; all three FAIL on 0.2.199.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bootreads-'));
const env = { ...process.env, APPDATA: path.join(root, 'appdata'), RELAYMOTE_HOME: path.join(root, 'rm'), CLAUDE_CONFIG_DIR: path.join(root, 'claude') };
delete env.RELAYMOTE_STATE_DIR;
const store = path.join(env.APPDATA, 'Claude', 'claude-code-sessions', 'aaaaaaaa-0000-4000-8000-000000000001', '0a0a0a0a-0000-4000-8000-000000000001');
fs.mkdirSync(store, { recursive: true });
const sid = n => 'local_' + String(n).padStart(8, '0') + '-0000-4000-8000-000000000000';
for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(store, sid(i) + '.json'),
  JSON.stringify({ sessionId: sid(i), title: 't' + i, cwd: 'D:/p' + i, cliSessionId: 'cli-' + i, lastActivityAt: 1000 + i, createdAt: 1 }));

let fails = 0;
const check = (ok, what, extra) => { console.log((ok ? 'ok   ' : 'FAIL ') + what + (extra != null ? '  ' + JSON.stringify(extra) : '')); if (!ok) fails++; };
const ROOT = path.join(__dirname, '..');
const run = (code) => JSON.parse(execFileSync(process.execPath, ['-e', code], { env, encoding: 'utf8' }).trim().split('\n').pop());
const SPY = `
const fs = require('fs');
const sync = { read: [], exists: [] };
const r0 = fs.readFileSync, e0 = fs.existsSync;
fs.readFileSync = function (p, ...a) { sync.read.push(String(p)); return r0.call(this, p, ...a); };
fs.existsSync = function (p) { sync.exists.push(String(p)); return e0.call(this, p); };
`;

try {
  // 1. The shape cache: a first start writes it; the next start seeds from it with no synchronous read.
  run(`const s = require(${JSON.stringify(path.join(ROOT, 'mobile/sessions.js'))});
    s.refresh({ force: true }).then(() => s.saveShapesForTest()).then(() => console.log('{}'));`);
  const a = run(SPY + `const s = require(${JSON.stringify(path.join(ROOT, 'mobile/sessions.js'))});
    s.refresh({ force: true }).then(c => console.log(JSON.stringify({ n: c.list.length,
      shapeSync: sync.read.filter(p => p === s.SHAPE_FILE).length, file: require('fs').existsSync(s.SHAPE_FILE) })));`);
  check(a.file && a.n === 40, 'a restart finds the saved shape cache and all 40 sessions', a);
  check(a.shapeSync === 0, 'the 6 MB shape cache is read without blocking the event loop', a);

  // 2. The Desktop snapshot: primed at start without a synchronous read; later callers get it from memory.
  const b = run(SPY + `const cfg = require(${JSON.stringify(path.join(ROOT, 'lib/config.js'))});
    const path = require('path'); const f = path.join(cfg.STATE, 'desktop-snapshot.json');
    fs.mkdirSync(cfg.STATE, { recursive: true }); fs.writeFileSync(f, JSON.stringify({ at: 7, sessions: [{ id: 'x' }] }));
    const d = require(${JSON.stringify(path.join(ROOT, 'lib/desktop.js'))});
    sync.read.length = 0;
    d.primeSnapshot().then(primed => { const snap = d.loadSnapshot();
      console.log(JSON.stringify({ primed, at: snap && snap.at, snapSync: sync.read.filter(p => p === f).length })); });`);
  check(b.primed === true && b.at === 7, 'the daemon primes the Desktop snapshot at start, and loadSnapshot returns it', b);
  check(b.snapSync === 0, 'with no synchronous read of the snapshot file', b);

  // 3. transcriptPath: a found path is trusted for 30 s, so repeat reads do not stat the disk each time; a miss is not kept.
  const c = run(SPY + `const s = require(${JSON.stringify(path.join(ROOT, 'mobile/sessions.js'))});
    const path = require('path'); const dir = path.join(s.PROJECTS, s.slugFor('D:/p3')); fs.mkdirSync(dir, { recursive: true });
    const sess = { cwd: 'D:/p3', cliSessionId: 'cli-3' };
    const before = s.transcriptPath(sess);
    fs.writeFileSync(path.join(dir, 'cli-3.jsonl'), '{}\\n');
    sync.exists.length = 0;
    const found = []; for (let i = 0; i < 20; i++) found.push(s.transcriptPath(sess));
    console.log(JSON.stringify({ before, ok: found.every(f => f && f.endsWith('cli-3.jsonl')), stats: sync.exists.length }));`);
  check(c.before === null && c.ok, 'a transcript that appears after a miss is found at once', c);
  check(c.stats <= 1, '20 reads of one session stat its transcript once, not 20 times', c);

  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  check(/desktop\.primeSnapshot\(\)/.test(src), 'the daemon calls primeSnapshot at start');
} finally {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
}
if (fails) { console.error(fails + ' failed'); process.exit(1); }
console.log('boot-reads: all checks passed');
