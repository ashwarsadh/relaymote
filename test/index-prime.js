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
  fs.readFileSync = rf;
  process.exit(fails ? 1 : 0);
})();
