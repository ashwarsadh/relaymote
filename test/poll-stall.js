// poll-stall.js — 09-Nov-2026 stall measurement (15:00-18:00 IST): two polls blocked 4.9 s and 2.3 s, the top frames a
// synchronous read of the 15 MB conductor index (lib/projects.js read) and a whole-transcript scan (mobile/sentfiles.js).
// No single poll may block the event loop for more than 500 ms: the index is parsed once per write, the scan yields.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { monitorEventLoopDelay } = require('perf_hooks');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pstall-'));
process.env.RELAYMOTE_HOME = home;
const P = require('../lib/projects');
const sentfiles = require('../mobile/sentfiles');

let fails = 0;
const check = (ok, what, extra) => { console.log((ok ? 'ok   ' : 'FAIL ') + what + (extra != null ? '  ' + extra : '')); if (!ok) fails++; };

(async () => {
  // A ~15 MB index, like the live one.
  const dir = path.join(home, 'conductor');
  fs.mkdirSync(dir, { recursive: true });
  const sessions = {};
  for (let i = 0; i < 30000; i++) sessions['s' + i] = { title: 'session ' + i + ' '.repeat(400), cli: 'c' + i, tags: ['a', 'b'] };
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ builtAt: new Date().toISOString(), sessions }));
  const a = P.read();
  const t = process.hrtime.bigint();
  const b = P.read();
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  check(a && a === b && ms < 20, 'a second read of an unchanged index is the cached parse', ms.toFixed(1) + ' ms');
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ builtAt: new Date().toISOString(), sessions: { x: {} } }));
  check(Object.keys(P.read().sessions).join() === 'x', 'a rewritten index is read again');

  // A 120 MB transcript with one SendUserFile call at the end.
  const tr = path.join(home, 't.jsonl');
  const filler = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(2000) }] } }) + '\n';
  const fd = fs.openSync(tr, 'w');
  const block = filler.repeat(500);
  for (let i = 0; i < Math.ceil(120 * 1048576 / block.length); i++) fs.writeSync(fd, block);
  fs.writeSync(fd, JSON.stringify({ cwd: home, message: { content: [{ type: 'tool_use', name: 'SendUserFile', input: { files: ['out.png'] } }] } }) + '\n');
  fs.closeSync(fd);

  const h = monitorEventLoopDelay({ resolution: 10 });
  h.enable();
  const files = await sentfiles.sentFiles(tr);
  h.disable();
  const maxMs = h.max / 1e6;
  check(files.size === 1, 'the SendUserFile at the end of a 120 MB transcript is found', [...files].join());
  check(maxMs < 500, 'the first scan never blocks the event loop for 500 ms', maxMs.toFixed(0) + ' ms max');
  // The one-buffer scan blocked 170 ms here on an idle PC (2.3 s live, under load); chunked it is ~10 ms.
  check(maxMs < 120, 'it yields between chunks (a one-buffer scan of 120 MB blocks ~170 ms even idle)', maxMs.toFixed(0) + ' ms max');

  try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  if (fails) { console.error(fails + ' failed'); process.exit(1); }
  console.log('poll-stall: all checks passed');
})();
