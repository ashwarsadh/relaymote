// shape-cache.js — 18-Nov-2026: the live session store holds ~6,700 records (715 MB). mobile/sessions.js scan() read and
// parsed every one after each daemon start, so the phone's first /api/bootstrap waited 10-17 s after every update or
// restart (measured in smoke.js: refresh 16.8 s). The shaped records now persist in STATE/sessions-shape.json with
// each file's mtime and size; a restart stats each record and reads only the ones that changed.
// Each "restart" here is a fresh node process on the same sandbox.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shapec-'));
const env = { ...process.env, APPDATA: path.join(root, 'appdata'), RELAYMOTE_HOME: path.join(root, 'rm') };
delete env.RELAYMOTE_STATE_DIR;
const store = path.join(env.APPDATA, 'Claude', 'claude-code-sessions', 'aaaaaaaa-0000-4000-8000-000000000001', '0a0a0a0a-0000-4000-8000-000000000001');
fs.mkdirSync(store, { recursive: true });
const N = 200, pad = 'x'.repeat(50000);
const sid = n => 'local_' + String(n).padStart(8, '0') + '-0000-4000-8000-000000000000';
const write = (n, title) => fs.writeFileSync(path.join(store, sid(n) + '.json'),
  JSON.stringify({ sessionId: sid(n), title, cwd: 'D:/p' + n, lastActivityAt: 1000 + n, createdAt: 1, pad }));
for (let i = 0; i < N; i++) write(i, 't' + i);

let fails = 0;
const check = (ok, what, extra) => { console.log((ok ? 'ok   ' : 'FAIL ') + what + (extra != null ? '  ' + extra : '')); if (!ok) fails++; };

// One daemon start: count the record files read, refresh, optionally save the cache, report.
const START = `
const fs = require('fs'), path = require('path');
const store = ${JSON.stringify(store)};
let reads = 0; const o = fs.promises.readFile;
fs.promises.readFile = function (p, ...a) { if (String(p).startsWith(store)) reads++; return o.call(this, p, ...a); };
const s = require(${JSON.stringify(path.join(__dirname, '..', 'mobile', 'sessions.js'))});
(async () => {
  const t = Date.now(); const c = await s.refresh({ force: true }); const ms = Date.now() - t;
  if (process.argv[1] === 'save') await s.saveShapesForTest();
  console.log(JSON.stringify({ reads, n: c.list.length, t5: (c.byId.get(${JSON.stringify(sid(5))}) || {}).title, ms }));
})().catch(e => { console.log(JSON.stringify({ error: e.message })); });`;
const start = (arg) => JSON.parse(execFileSync(process.execPath, ['-e', START, arg || ''], { env, encoding: 'utf8' }).trim().split('\n').pop());

const a = start('save');
check(a.n === N && a.reads === N, 'the first start ever reads every record', JSON.stringify(a));
let file = null;
try { file = JSON.parse(fs.readFileSync(path.join(env.RELAYMOTE_HOME, 'state', 'sessions-shape.json'), 'utf8')); } catch {}
check(file && file.entries.length === N && file.entries.every(([, e]) => e.rec && !('pad' in e.rec)), 'the shaped records are kept, without the record bodies',
  file ? JSON.stringify(fs.statSync(path.join(env.RELAYMOTE_HOME, 'state', 'sessions-shape.json')).size) + ' bytes' : 'no file');

const b = start();
check(b.n === N && b.reads === 0 && b.t5 === 't5', 'a restart reads no unchanged record, and lists the same sessions', JSON.stringify(b));

write(5, 'renamed'); const later = new Date(Date.now() + 5000); fs.utimesSync(path.join(store, sid(5) + '.json'), later, later);
fs.rmSync(path.join(store, sid(7) + '.json'));
const c = start();
check(c.n === N - 1 && c.reads === 1 && c.t5 === 'renamed', 'a restart re-reads only a changed record and drops a removed one', JSON.stringify(c));

// A cache written by another version is not trusted.
const sf = path.join(env.RELAYMOTE_HOME, 'state', 'sessions-shape.json');
const j = JSON.parse(fs.readFileSync(sf, 'utf8')); j.v = '0.0.0'; fs.writeFileSync(sf, JSON.stringify(j));
const d = start();
check(d.reads === N - 1, 'a cache from another app version is ignored (every record read again)', JSON.stringify(d));

try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
process.exit(fails ? 1 : 0);
