// index-prime.js — 10-Nov: on restart the first read of the 15 MB index blocked the server 13.7 s on a busy disk.
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-prime-'));
process.env.RELAYMOTE_HOME = dir;
let fails = 0;
const check = (ok, what, got) => { console.log((ok ? 'ok   ' : 'FAIL ') + what + (got !== undefined ? '  ' + JSON.stringify(got) : '')); if (!ok) fails++; };
const P = require('../lib/projects');
fs.mkdirSync(path.dirname(P.INDEX_JSON), { recursive: true });
fs.writeFileSync(P.INDEX_JSON, JSON.stringify({ builtAt: new Date().toISOString(), sessions: { a: { id: 'a' } }, pad: 'x'.repeat(5e6) }));
(async () => {
  let sync = 0; const rf = fs.readFileSync;
  fs.readFileSync = function (f, ...a) { if (f === P.INDEX_JSON) sync++; return rf.call(fs, f, ...a); };
  const p = P.prime();
  check(P.read() === null && sync === 0, 'while it loads, read() answers at once (no index yet) without a sync read', sync);
  await p;
  const ix = P.read();
  check(ix && ix.sessions && ix.sessions.a && sync === 0, 'once loaded, read() has it, still with no sync read', sync);

  // 23-Nov: a REWRITE of the file (worker build, the Conductor's index task) made the next caller re-read 15 MB
  // synchronously (98.6 s in 10 stalls on 0.2.206). Now the old copy answers while the new one loads in the background.
  await new Promise(r => setTimeout(r, 30));
  fs.writeFileSync(P.INDEX_JSON, JSON.stringify({ builtAt: new Date().toISOString(), sessions: { b: { id: 'b' } }, pad: 'y'.repeat(5e6) }));
  const during = P.read();
  check(during === ix && sync === 0, 'after a rewrite, read() answers at once with the copy it has (no sync read)', sync);
  let nw = null;
  for (let i = 0; i < 100 && !(nw && nw.sessions.b); i++) { await new Promise(r => setTimeout(r, 20)); nw = P.read(); }
  check(nw && nw.sessions.b && !nw.sessions.a && sync === 0, 'the rewritten index replaces it once loaded, still with no sync read', sync);

  // fresh() must not rebuild over a stale copy: it waits for the background read of a newer file.
  await new Promise(r => setTimeout(r, 30));
  fs.writeFileSync(P.INDEX_JSON, JSON.stringify({ builtAt: new Date().toISOString(), sessions: { c: { id: 'c' } } }));
  const f = await P.fresh(60000);
  check(f && f.sessions && f.sessions.c && sync === 0, 'fresh() waits for the newer file instead of building', f && Object.keys(f.sessions || {}));

  // master-view recomputes when read() hands back a newer index (it used to key on mtime, which would pin the stale copy).
  const MV = require('../lib/master-view');
  await new Promise(r => setTimeout(r, 30));
  fs.writeFileSync(P.INDEX_JSON, JSON.stringify({ builtAt: new Date().toISOString(), sessions: { m: { id: 'm', is_master: true, children: ['k'] } } }));
  P.read();
  for (let i = 0; i < 100 && !(P.read().sessions.m); i++) await new Promise(r => setTimeout(r, 20));
  check(MV.fleetOf('m') && MV.fleetOf('m').has('k'), 'master-view sees the newer index once it has loaded');
  fs.readFileSync = rf;
  process.exit(fails ? 1 : 0);
})();
