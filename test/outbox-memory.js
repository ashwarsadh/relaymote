// outbox-memory.js — 10-Nov 01:45 IST: with the disk saturated, reading outbox.json on every poll held the event loop
// 34-83 s. The file is read once; saves go to memory at once and to disk in the background.
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-obm-'));
process.env.RELAYMOTE_HOME = dir;
let fails = 0;
const check = (ok, what, got) => { console.log((ok ? 'ok   ' : 'FAIL ') + what + (got !== undefined ? '  ' + JSON.stringify(got) : '')); if (!ok) fails++; };
const outbox = require('../mobile/outbox');
fs.mkdirSync(path.dirname(outbox.FILE), { recursive: true });
fs.writeFileSync(outbox.FILE, JSON.stringify({ entries: [{ id: 'old1', session: 's', text: 'from disk', state: 'pending', at: Date.now() }] }));
(async () => {
  let reads = 0, writes = 0; const rf = fs.readFileSync, wf = fs.writeFileSync;
  fs.readFileSync = function (p, ...a) { if (String(p).startsWith(outbox.FILE)) reads++; return rf.call(fs, p, ...a); };
  fs.writeFileSync = function (p, ...a) { if (String(p).startsWith(outbox.FILE)) writes++; return wf.call(fs, p, ...a); };
  check(outbox.get('old1') && outbox.get('old1').text === 'from disk', 'what is on disk is read');
  for (let i = 0; i < 200; i++) outbox.pending();
  const e = outbox.add({ session: 's', text: 'a new message for the session' });
  check(reads === 1, 'read once, not per call (201 calls)', reads);
  check(writes === 0, 'a save does not write on the request path', writes);
  check(outbox.get(e.id) && outbox.pending().length === 2, 'and is seen at once from memory');
  const list = outbox.pending(); list.length = 0;
  check(outbox.pending().length === 2, 'a caller changing its copy of the list changes nothing');
  await new Promise(r => setTimeout(r, 700));
  const disk = JSON.parse(rf.call(fs, outbox.FILE, 'utf8')).entries;
  check(disk.length === 2 && disk.some(x => x.id === e.id), 'the file follows in the background', disk.length);
  fs.readFileSync = rf; fs.writeFileSync = wf;
  outbox.add({ session: 's', text: 'written just before exit' });
  outbox.flush();
  check(JSON.parse(rf.call(fs, outbox.FILE, 'utf8')).entries.length === 3, 'flush writes it at once (also run on exit)');
  process.exit(fails ? 1 : 0);
})();
