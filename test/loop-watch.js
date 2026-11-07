// loop-watch.js — a blocked event loop is logged with the function that held it; a quiet one logs nothing.
'use strict';
process.env.RELAYMOTE_LOOP_WINDOW_MS = '4000';
const lw = require('../lib/loop-watch');
let fails = 0;
const check = (ok, what, got) => { console.log((ok ? 'ok   ' : 'FAIL ') + what + (got !== undefined ? '  ' + JSON.stringify(got) : '')); if (!ok) fails++; };
const wait = (ms) => new Promise(r => setTimeout(r, ms));

function holdTheLoopForTest() { const e = Date.now() + 3000; let x = 0; while (Date.now() < e) x += Math.sqrt(x + 1); return x; }

(async () => {
  const lines = [];
  const w = lw.start(l => lines.push(l));
  w.ref();
  await wait(1500);
  check(lines.length === 0, 'a quiet loop logs nothing', lines);
  holdTheLoopForTest();
  for (let i = 0; i < 80 && !lines.some(l => /loop stall/.test(l)); i++) await wait(250);
  const line = lines.find(l => /loop stall/.test(l)) || '';
  console.log('  ' + line);
  const ms = Number((/loop stall ([\d.]+) s/.exec(line) || [])[1]) * 1000;
  check(ms >= 2500 && ms < 5000, 'the stall is measured at about 3 s', ms);
  check(/ours: holdTheLoopForTest loop-watch\.js:9/.test(line), 'and names the function that held the loop, as our code', line);
  check(!lines.some(l => /stopped|failed/.test(l)), 'the watcher itself did not fail', lines);
  await w.terminate();
  process.exit(fails ? 1 : 0);
})();
