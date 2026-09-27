// import-ago.js — bring an AGO-format state folder into Relaymote (`relaymote import-ago [dir] [--apply]`).
//
// AGO is the private daemon Relaymote grew out of; its state folder has the same file formats. Switching
// over must not lose the task queue, the master claims, the parked watches or the undelivered
// notifications, so this imports:
//   registry.json       tasks (queued, running and finished) — merged; an id Relaymote already uses is
//                       renumbered, and every reference to it (dependsOn, watches, notify keys) follows
//   masters.json        master claims per project — expired claims skipped; Relaymote's own claim wins
//   awaits.json         open relaymote_await watches — Relaymote's own open watch for a master wins
//   notify-state.json   the notify queue (pending) and its dedupe memory, so nothing is sent twice
//   notify-config.json  copied only when Relaymote has none
// Dry run by default. --apply backs up every Relaymote file it will replace to
// state/import-backup-<ms>/ first. The SOURCE is only ever read, and a destination that resolves to
// the source folder is refused. Result and log files stay where they are; imported tasks keep their
// original paths.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { mergeTasks, writeAtomic } = require('./salvage');

const FILES = ['registry.json', 'masters.json', 'awaits.json', 'notify-state.json', 'notify-config.json'];

function defaultSource() { return process.env.AGO_HOME || path.join(os.homedir(), '.claude', 'ago'); }

/** The folder holding registry.json etc.: `dir` itself, or `dir/state`. */
function resolveSource(dir) {
  const base = path.resolve(dir || defaultSource());
  for (const d of [base, path.join(base, 'state')]) {
    if (FILES.some(f => fs.existsSync(path.join(d, f)))) return d;
  }
  return null;
}

function readJson(file) {
  try { return { ok: true, data: JSON.parse(fs.readFileSync(file, 'utf8')) }; }
  catch (e) { return { ok: false, missing: e.code === 'ENOENT', error: e.message }; }
}

const same = (a, b) => path.resolve(a).replace(/[\\/]+$/, '').toLowerCase() === path.resolve(b).replace(/[\\/]+$/, '').toLowerCase();
const remapTaskKey = (k, map) => String(k).replace(/^task:(t\d+):/, (m, id) => map[id] ? `task:${map[id]}:` : m);

function plan(srcDir, destDir, now = Date.now()) {
  const src = f => path.join(srcDir, f), dst = f => path.join(destDir, f);
  const out = { files: {}, writes: {}, warnings: [] };

  // --- tasks ---
  const reg = readJson(src('registry.json'));
  let renumbered = {};
  if (reg.ok && reg.data && reg.data.tasks) {
    const cur = readJson(dst('registry.json'));
    const live = cur.ok && cur.data && cur.data.tasks ? cur.data : { version: 1, tasks: {}, seq: 0 };
    const m = mergeTasks(live, reg.data, { tag: 'importedFrom', tagValue: 'ago' });
    renumbered = m.renumbered;
    const inc = Object.values(reg.data.tasks);
    out.files['registry.json'] = {
      incoming: inc.length, added: m.added.length, alreadyPresent: m.same.length, renumbered: Object.keys(m.renumbered).length,
      byStatus: inc.reduce((a, t) => (a[t.status] = (a[t.status] || 0) + 1, a), {}),
    };
    if (inc.some(t => t.status === 'running')) out.warnings.push('Some imported tasks are RUNNING under AGO. Stop AGO before Relaymote takes over, or both will poll the same workers.');
    if (m.added.length) out.writes['registry.json'] = m.merged;
  } else out.files['registry.json'] = reg.missing ? { missing: true } : { error: reg.error || 'no tasks' };

  // --- master claims ---
  const ms = readJson(src('masters.json'));
  if (ms.ok && ms.data && typeof ms.data === 'object') {
    const cur = readJson(dst('masters.json'));
    const mine = cur.ok && cur.data ? cur.data : {};
    const next = { ...mine };
    const r = { incoming: 0, added: 0, expired: 0, keptBaton: [] };
    for (const [project, m] of Object.entries(ms.data)) {
      if (!m || !m.sessionId) continue;
      r.incoming++;
      if (m.expiresAt && Date.parse(m.expiresAt) <= now) { r.expired++; continue; }
      if (mine[project] && mine[project].sessionId !== m.sessionId) { r.keptBaton.push(project); continue; }
      if (mine[project]) continue;
      next[project] = { ...m, importedFrom: 'ago' };
      r.added++;
    }
    out.files['masters.json'] = r;
    if (r.added) out.writes['masters.json'] = next;
  } else out.files['masters.json'] = ms.missing ? { missing: true } : { error: ms.error };

  // --- parked watches ---
  const aw = readJson(src('awaits.json'));
  if (aw.ok && aw.data && Array.isArray(aw.data.watches)) {
    const cur = readJson(dst('awaits.json'));
    const mine = cur.ok && cur.data && Array.isArray(cur.data.watches) ? cur.data : { version: 1, watches: [] };
    const openMasters = new Set(mine.watches.filter(w => !w.resolvedAt).map(w => w.masterSessionId));
    const ids = new Set(mine.watches.map(w => w.id));
    const r = { incoming: aw.data.watches.length, open: 0, added: 0, resolvedSkipped: 0, keptBaton: 0 };
    const add = [];
    for (const w of aw.data.watches) {
      if (w.resolvedAt) { r.resolvedSkipped++; continue; }
      r.open++;
      if (ids.has(w.id)) continue;
      if (openMasters.has(w.masterSessionId)) { r.keptBaton++; continue; }
      add.push({ ...w, waitingOn: (w.waitingOn || []).map(id => renumbered[id] || id), importedFrom: 'ago' });
    }
    r.added = add.length;
    out.files['awaits.json'] = r;
    if (add.length) out.writes['awaits.json'] = { ...mine, watches: [...add, ...mine.watches].slice(0, 200) };
  } else out.files['awaits.json'] = aw.missing ? { missing: true } : { error: aw.error };

  // --- notify queue + dedupe memory ---
  const ns = readJson(src('notify-state.json'));
  if (ns.ok && ns.data) {
    const cur = readJson(dst('notify-state.json'));
    const had = cur.ok && cur.data;
    const mine = had ? cur.data : {};
    const remapMap = obj => Object.fromEntries(Object.entries(obj || {}).map(([k, v]) => [remapTaskKey(k, renumbered), v]));
    const incoming = (ns.data.pending || []).map(e => ({ ...e, key: remapTaskKey(e.key, renumbered), ...(e.taskId && renumbered[e.taskId] ? { taskId: renumbered[e.taskId] } : {}) }));
    const keys = new Set((mine.pending || []).map(e => e.key));
    const addPending = incoming.filter(e => !keys.has(e.key));
    const next = had ? { ...mine } : { ...ns.data };
    next.pending = [...(mine.pending || []), ...addPending];
    for (const k of ['notified', 'notifiedAt']) next[k] = { ...remapMap(ns.data[k]), ...(mine[k] || {}) };
    if (had) for (const k of ['sessionState', 'ranSince', 'lastActivityAt', 'lastSeenAt']) next[k] = { ...(ns.data[k] || {}), ...(mine[k] || {}) };
    out.files['notify-state.json'] = { pendingIncoming: incoming.length, pendingAdded: addPending.length, dedupeKeys: Object.keys(ns.data.notified || {}).length, mergedInto: had ? 'existing' : 'new' };
    if (addPending.length || !had || Object.keys(ns.data.notified || {}).length) out.writes['notify-state.json'] = next;
  } else out.files['notify-state.json'] = ns.missing ? { missing: true } : { error: ns.error };

  const nc = readJson(src('notify-config.json'));
  if (nc.ok) {
    const exists = fs.existsSync(dst('notify-config.json'));
    out.files['notify-config.json'] = { copied: !exists, keptBaton: exists };
    if (!exists) out.writes['notify-config.json'] = nc.data;
  } else out.files['notify-config.json'] = nc.missing ? { missing: true } : { error: nc.error };

  out.renumbered = renumbered;
  return out;
}

/**
 * Import from `opts.dir` (an AGO folder or its state folder) into Relaymote's state folder.
 * Dry run unless opts.apply.
 */
function run(opts = {}) {
  const srcDir = resolveSource(opts.dir);
  if (!srcDir) return { ok: false, error: 'NO_AGO_STATE', message: `no AGO state found at ${path.resolve(opts.dir || defaultSource())} (looked for ${FILES.join(', ')} there and in its state folder)` };
  const destDir = opts.destDir || process.env.RELAYMOTE_STATE_DIR || require('./config').STATE;
  if (same(srcDir, destDir)) return { ok: false, error: 'SAME_FOLDER', message: `Relaymote's state folder IS the source (${srcDir}); refusing to import a folder into itself.` };
  const p = plan(srcDir, destDir, opts.now || Date.now());
  const res = { ok: true, source: srcDir, dest: destDir, applied: false, files: p.files, renumbered: p.renumbered, warnings: p.warnings, wouldWrite: Object.keys(p.writes) };
  if (!opts.apply || !Object.keys(p.writes).length) return res;

  const backup = path.join(destDir, 'import-backup-' + (opts.now || Date.now()));
  for (const f of Object.keys(p.writes)) {
    const d = path.join(destDir, f);
    if (fs.existsSync(d)) { fs.mkdirSync(backup, { recursive: true }); fs.copyFileSync(d, path.join(backup, f)); res.backup = backup; }
  }
  for (const [f, data] of Object.entries(p.writes)) writeAtomic(path.join(destDir, f), data);
  res.applied = true;
  res.wrote = Object.keys(p.writes);
  return res;
}

module.exports = { run, plan, resolveSource, defaultSource, remapTaskKey, FILES };
