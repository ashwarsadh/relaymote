// off-thread-clone.js — 09-Nov review R3, fixed 24-Nov: a task whose argument cannot be cloned (postMessage throws
// DataCloneError) left its timeout armed; when it fired it dropped the lane, ending the worker and rejecting whatever job
// was running then, in the failed task's name. Timeout shortened to 1.5 s to see it.
'use strict';
process.env.RELAYMOTE_OFF_THREAD_TEST = '1';
process.env.RELAYMOTE_OFF_THREAD_TIMEOUT_MS = '1500';
const off = require('../lib/off-thread');
let fails = 0;
const check = (ok, what, got) => { console.log((ok ? 'ok   ' : 'FAIL ') + what + (!ok && got !== undefined ? '  ' + JSON.stringify(got) : '')); if (!ok) fails++; };
const wait = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
  let err = null;
  try { await off.run('t', 'test.where', { f: () => 1 }); } catch (e) { err = e; }
  check(err && /clone/i.test(err.name + err.message), 'an argument that cannot be cloned rejects at once', err && err.message);
  await wait(800);
  // Runs across the moment the failed task's timer would have fired (1.5 s), and ends before its own (2.3 s).
  let r = null, e2 = null;
  try { r = await off.run('t', 'test.busy', { ms: 1000 }); } catch (e) { e2 = e; }
  check(r === 1000 && !e2, 'a later job on that lane is not killed by the failed task\'s timer', e2 && e2.message);
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
