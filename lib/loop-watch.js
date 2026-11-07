'use strict';
// loop-watch.js — 07-Nov: phone requests took up to 44 s and nothing could say why ("poll: TOTAL" counts awaited work
// too, so it does not measure a blocked event loop). A worker thread watches a heartbeat the main thread writes and
// keeps a rolling CPU profile of the main thread; when the heartbeat stops for STALL_MS it logs the code that held it.
// No port is opened (inspector.Session.connectToMainThread). RELAYMOTE_LOOP_WATCH=0 turns it off.
const path = require('path');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

const STALL_MS = Number(process.env.RELAYMOTE_LOOP_STALL_MS) || 2000;
const WINDOW_MS = Number(process.env.RELAYMOTE_LOOP_WINDOW_MS) || 30000;
const SAMPLE_US = 10000;

/** Pure: what ran in [t0, t1] (wall ms), from one CDP profile whose first sample is at wall time `wall0`. */
function attribute(profile, wall0, t0, t1, ourRoot) {
  const byId = new Map(profile.nodes.map(n => [n.id, n]));
  const parent = new Map();
  for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id);
  const name = (n) => n.callFrame.functionName || '(anonymous)';
  const short = (n) => {
    const u = n.callFrame.url || '';
    return name(n) + (u ? ' ' + u.replace(/^.*[\\/]/, '') + ':' + (n.callFrame.lineNumber + 1) : '');
  };
  const ours = (n) => (n.callFrame.url || '').replace(/\\/g, '/').toLowerCase().includes(ourRoot);
  const leaf = new Map(), app = new Map();
  let at = wall0, total = 0;
  for (let i = 0; i < profile.samples.length; i++) {
    at += (profile.timeDeltas[i] || 0) / 1000;
    if (at < t0 || at > t1) continue;
    const ms = (profile.timeDeltas[i] || 0) / 1000;
    total += ms;
    let n = byId.get(profile.samples[i]);
    if (!n) continue;
    leaf.set(short(n), (leaf.get(short(n)) || 0) + ms);
    // The nearest of OUR frames, and its caller: "readFileSync" alone does not say who asked.
    let id = n.id, frame = null;
    while (id !== undefined) {
      const f = byId.get(id);
      if (f && ours(f)) { frame = f; break; }
      id = parent.get(id);
    }
    const key = frame ? short(frame) : '(' + name(n).replace(/[()]/g, '') + ')';
    app.set(key, (app.get(key) || 0) + ms);
  }
  const top = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k} ${Math.round(v)}ms`);
  return { sampled: Math.round(total), ours: top(app), leaf: top(leaf) };
}

function workerMain() {
  const inspector = require('inspector');
  const beat = new Float64Array(workerData.sab);
  const session = new inspector.Session();
  session.connectToMainThread();
  const post = (m, p = {}) => new Promise((res, rej) => session.post(m, p, (e, r) => e ? rej(e) : res(r)));
  const stalls = [];
  let open = null;
  setInterval(() => {
    const last = beat[0], now = Date.now();
    if (now - last >= STALL_MS) { if (!open) open = { t0: last }; open.t1 = now; }
    else if (open) { open.t1 = last; stalls.push(open); open = null; }
  }, 200);
  (async () => {
    await post('Profiler.enable');
    await post('Profiler.setSamplingInterval', { interval: SAMPLE_US });
    for (;;) {
      const wall0 = Date.now();
      await post('Profiler.start');
      await new Promise(r => setTimeout(r, WINDOW_MS));
      // A stall still open ends in the next window, and is read there.
      while (open) await new Promise(r => setTimeout(r, 200));
      const { profile } = await post('Profiler.stop');
      const done = stalls.splice(0);
      for (const s of done) parentPort.postMessage({ ms: Math.round(s.t1 - s.t0), at: new Date(s.t0).toISOString(), ...attribute(profile, wall0, s.t0, s.t1, workerData.root) });
    }
  })().catch(e => parentPort.postMessage({ error: e.message }));
}

function start(log) {
  if (process.env.RELAYMOTE_LOOP_WATCH === '0') return null;
  const sab = new SharedArrayBuffer(8);
  const beat = new Float64Array(sab);
  beat[0] = Date.now();
  const hb = setInterval(() => { beat[0] = Date.now(); }, 100);
  if (hb.unref) hb.unref();
  const root = path.resolve(__dirname, '..').replace(/\\/g, '/').toLowerCase();
  const w = new Worker(__filename, { workerData: { sab, root } });
  w.unref();
  w.on('message', (m) => {
    if (m.error) return log('loop watch stopped: ' + m.error);
    log(`loop stall ${(m.ms / 1000).toFixed(1)} s from ${m.at} (${m.sampled} ms sampled) ours: ${m.ours.join(', ') || 'none'} | leaf: ${m.leaf.join(', ') || 'none'}`);
  });
  w.on('error', (e) => log('loop watch failed: ' + e.message));
  return w;
}

if (!isMainThread && workerData && workerData.sab) workerMain();
module.exports = { start, attribute };
