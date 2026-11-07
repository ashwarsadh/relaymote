'use strict';
// off-thread.js — 08-Nov: the scans behind the remaining 2-5 s event-loop stalls run in worker threads, so the phone's
// requests are answered while they read. All of this is file work; anything that drives Claude Desktop stays on the main
// thread. Two lanes run one task at a time each: 'slow' for the periodic builds, 'fast' for what a phone is waiting on,
// so a 5 s hygiene pass never delays opening a session. RELAYMOTE_OFF_THREAD=0 runs everything inline.
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

const TIMEOUT_MS = Number(process.env.RELAYMOTE_OFF_THREAD_TIMEOUT_MS) || 10 * 60000;

const TASKS = {
  'index.build': (opts) => require('./projects').build(opts || {}),
  'hygiene.cycle': () => require('./hygiene').cycle({}),
  // The whole board object stays behind: the caller only logs the outcome, and the phone reads the file.
  'board.build': async () => { const r = await require('./board-build').build({}); return { written: r.written, file: r.file, reason: r.reason }; },
  'bg.scan': ({ file }) => require('../mobile/sessions').backgroundFromFile(file),
};
if (process.env.RELAYMOTE_OFF_THREAD_TEST) {
  TASKS['test.where'] = () => require('worker_threads').threadId;
  TASKS['test.busy'] = ({ ms }) => { const e = Date.now() + ms; while (Date.now() < e); return ms; };
  TASKS['test.hang'] = () => new Promise(() => {});
  TASKS['test.throw'] = () => { throw new RangeError('thrown in the task'); };
  TASKS['test.die'] = () => { process.exit(7); };
}

const lanes = new Map();   // name -> { worker, queue, current }

function settle(lane, fn) {
  const cur = lane.current;
  lane.current = null;
  if (cur) { clearTimeout(cur.timer); fn(cur); }
  next(lane);
}

function drop(lane, why) {
  const w = lane.worker;
  lane.worker = null;
  if (w) { w.removeAllListeners(); w.on('error', () => {}); w.terminate().catch(() => {}); }
  settle(lane, (cur) => cur.reject(new Error(why)));
}

function spawn(lane) {
  const w = new Worker(__filename, { workerData: { offThread: true } });
  w.unref();
  w.on('message', (m) => settle(lane, (cur) => {
    if (m.error) cur.reject(Object.assign(new Error(m.error.message), { name: m.error.name }));
    else cur.resolve(m.value);
  }));
  w.on('error', (e) => drop(lane, 'worker failed: ' + e.message));
  w.on('exit', (code) => { if (lane.worker === w) drop(lane, 'worker exited with code ' + code); });
  return w;
}

function next(lane) {
  if (lane.current || !lane.queue.length) return;
  const job = lane.queue.shift();
  try {
    if (!lane.worker) lane.worker = spawn(lane);
    lane.current = job;
    // A hung task must not hold the ticks that await it for ever; its worker goes with it. Not rerun inline: what hung
    // there would hang the phone's thread here.
    job.timer = setTimeout(() => drop(lane, `${job.task} took longer than ${Math.round(TIMEOUT_MS / 1000)} s`), TIMEOUT_MS);
    if (job.timer.unref) job.timer.unref();
    lane.worker.ref();     // the answer is awaited; unref again once nothing is
    lane.worker.postMessage({ task: job.task, arg: job.arg });
  } catch (e) { lane.current = null; job.reject(e); next(lane); }
}

/** Run a named task on a lane; resolves with its value (structured-cloned) and rejects with its error. */
function run(laneName, task, arg) {
  if (!TASKS[task]) return Promise.reject(new Error('no such off-thread task: ' + task));
  if (process.env.RELAYMOTE_OFF_THREAD === '0') return (async () => TASKS[task](arg))();
  let lane = lanes.get(laneName);
  if (!lane) lanes.set(laneName, lane = { worker: null, queue: [], current: null });
  return new Promise((resolve, reject) => {
    const done = (fn) => (v) => { if (lane.worker && !lane.current && !lane.queue.length) lane.worker.unref(); fn(v); };
    lane.queue.push({ task, arg, resolve: done(resolve), reject: done(reject) });
    next(lane);
  });
}

if (!isMainThread && workerData && workerData.offThread) {
  parentPort.on('message', async ({ task, arg }) => {
    try { parentPort.postMessage({ value: await TASKS[task](arg) }); }
    catch (e) { parentPort.postMessage({ error: { name: e && e.name, message: String((e && e.message) || e) } }); }
  });
}

module.exports = { run };
