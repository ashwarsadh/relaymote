// verify.js — did a sidebar-group write SURVIVE Claude Desktop starting again?
//
// Counting the groups straight after the write proves only the write. A write has been seen to
// read back correctly ("verified") and be gone 26 seconds later, when Desktop relaunched and its
// web app pushed a stale copy over it. The claim worth making is "it is still there after Desktop
// has been closed and opened again", and nobody is watching at that moment, because the write
// happens while Desktop is closed.
//
// So every group write registers a check here. The daemon's tick waits until Desktop is live
// again, lets it settle for SETTLE_MS, counts BOTH stores (from a copy of the leveldb) and records
// a verdict in scope-verdict.json. A verdict with fewer groups or placements than were written is
// a failure, shown on the Accounts screen. It never opens, closes or writes Desktop's files.
'use strict';
const core = require('./core');
const pres = require('./presence');

const SETTLE_MS = 180 * 1000;
const WAIT_MS = 8 * 60 * 60 * 1000;

function register(wrote, at = new Date().toISOString()) {
  const entries = (wrote || []).filter(w => w && w.store && w.groupKey);
  if (!entries.length) return null;
  const v = { at, entries, liveSince: null };
  core.ensureDir(core.DIR);
  core.writeJsonAtomic(core.VERIFY_FILE, v);
  return v;
}
const pending = () => core.readJson(core.VERIFY_FILE, null);
const verdict = () => core.readJson(core.VERDICT_FILE, null);

function record(v) {
  core.ensureDir(core.DIR);
  core.writeJsonAtomic(core.VERDICT_FILE, v);
  try { require('fs').rmSync(core.VERIFY_FILE, { force: true }); } catch {}
  core.log('VERIFY ' + v.phase + ' ' + (v.ok === true ? 'OK' : v.ok === false ? 'FAILED' : '') + ' ' +
    (v.entries || []).map(e => e.to + ' wrote ' + e.want.groups + '/' + e.want.assignments + ' found ' + (e.got ? e.got.localStorage.groups + '/' + e.got.localStorage.assignments : '?')).join('; '));
  return v;
}

// deps (tests): now(), presence() -> {state}, countStore(store) -> { groupKey: { localStorage, config } }
async function tick(deps = {}) {
  const p0 = pending();
  if (!p0) return null;
  const now = deps.now ? deps.now() : Date.now();
  // deps.offThread: the leveldb copy and parse run in the 'slow' worker lane (17-Nov: it was the last account-sync read
  // left on the daemon's main thread). countedOn records the thread that did it.
  let countedOn = 0;
  const countStore = deps.countStore || (deps.offThread
    ? async s => { const r = await require('../off-thread').run('slow', 'groups.countStore', s); countedOn = r.thread; return r.counts; }
    : s => require('./groups').countStore(s));
  if (now - Date.parse(p0.at) > WAIT_MS) {
    return record({ phase: 'NOT RELAUNCHED', ok: null, at: new Date(now).toISOString(), wroteAt: p0.at, entries: p0.entries.map(e => ({ to: e.to, want: e.want })) });
  }
  const probe = deps.presence ? pres.resolver(deps.presence) : () => pres.presence();
  const p = await probe({});
  if (p.state !== 'live') {
    if (p0.liveSince) { p0.liveSince = null; core.writeJsonAtomic(core.VERIFY_FILE, p0); }
    return { phase: 'waiting', presence: p.state };
  }
  if (!p0.liveSince) { p0.liveSince = now; core.writeJsonAtomic(core.VERIFY_FILE, p0); return { phase: 'settling' }; }
  if (now - p0.liveSince < SETTLE_MS) return { phase: 'settling' };

  const cache = new Map();
  const entries = [];
  for (const e of p0.entries) {
    const k = e.store.leveldb + '|' + e.store.origin;
    if (!cache.has(k)) cache.set(k, await countStore(e.store));
    const got = cache.get(k)[e.groupKey] || { localStorage: { groups: 0, assignments: 0 }, config: { groups: 0, assignments: 0 } };
    const ok = got.localStorage.groups >= e.want.groups && got.localStorage.assignments >= e.want.assignments &&
               got.config.groups >= e.want.groups && got.config.assignments >= e.want.assignments;
    entries.push({ to: e.to, groupKey: e.groupKey, store: e.store.id, want: e.want, got, ok });
  }
  return record({ phase: 'AFTER RELAUNCH', ok: entries.every(e => e.ok), at: new Date(now).toISOString(), wroteAt: p0.at,
                  settledSeconds: Math.round((now - p0.liveSince) / 1000), entries, ...(countedOn ? { countedOn } : {}) });
}

module.exports = { register, tick, pending, verdict, SETTLE_MS, WAIT_MS };
