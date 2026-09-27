// salvage.js — recover tasks from a registry.json that was quarantined as corrupt (`relaymote salvage`).
//
// When the registry cannot be parsed, lib/registry.js renames it to registry.json.corrupt-<ms> and
// starts empty, so the daemon keeps running. The usual damage is a ZERO-FILLED TAIL: the file's size
// was updated but the data never reached the disk (an unclean shutdown), so the last stretch is NUL
// or space padding while the prefix is intact. Every task up to the cut is recoverable:
//   1. trim the padding and parse;
//   2. otherwise close the JSON after the last COMPLETE task object;
//   3. otherwise scan for individual task objects, so a mangled middle costs only the tasks it hit.
// The recovered tasks are MERGED into the live registry (dry run by default). A salvaged task whose id
// is already taken by a newer live task is renumbered, never dropped, and the renumbering is reported.
'use strict';
const fs = require('fs');
const path = require('path');

const TRAIL = /[\u0000\s]+$/;

function corruptFiles(stateDir) {
  let names = [];
  try { names = fs.readdirSync(stateDir); } catch { return []; }
  return names.filter(f => f.startsWith('registry.json.corrupt-'))
    .sort((a, b) => (Number(a.split('-').pop()) || 0) - (Number(b.split('-').pop()) || 0))
    .map(f => path.join(stateDir, f));
}
const newestCorrupt = stateDir => corruptFiles(stateDir).pop() || null;

/** Parse what can be parsed. Returns { data, method } or null. Pure (tests call it directly). */
function salvage(raw) {
  const s = String(raw || '').replace(/^﻿/, '').replace(TRAIL, '');
  try {
    const j = JSON.parse(s);
    if (j && typeof j === 'object' && j.tasks) return { data: j, method: 'trimmed padding only' };
  } catch {}

  // Tasks are written by JSON.stringify(state, null, 2): each task closes with "\n    }".
  const lastComplete = s.lastIndexOf('\n    },');
  const lastAny = s.lastIndexOf('\n    }');
  for (const cut of [lastComplete, lastAny]) {
    if (cut <= 0) continue;
    try {
      const j = JSON.parse(s.slice(0, cut + '\n    }'.length) + '\n  }\n}');
      if (j && j.tasks) {
        j.seq = Math.max(j.seq || 0, maxSeq(Object.keys(j.tasks)));
        return { data: j, method: 'closed at the last complete task' };
      }
    } catch {}
  }

  const tasks = {};
  const re = /"(t\d+)":\s*\{/g;
  let m;
  while ((m = re.exec(s))) {
    const id = m[1];
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let i = m.index + m[0].length - 1; i < s.length; i++) {
      const c = s[i];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end < 0) break;
    try { const t = JSON.parse(s.slice(m.index + m[0].length - 1, end + 1)); if (t && typeof t === 'object') tasks[id] = t; } catch {}
    re.lastIndex = end + 1;
  }
  if (Object.keys(tasks).length) {
    return { data: { version: 1, tasks, seq: maxSeq(Object.keys(tasks)), updatedAt: new Date().toISOString() }, method: 'per-task scan' };
  }
  return null;
}

function maxSeq(ids) { return Math.max(0, ...ids.map(k => parseInt(String(k).replace(/^t/, ''), 10) || 0)); }
const idFor = n => 't' + String(n).padStart(4, '0');

/**
 * Merge `incoming` tasks into `live`. Live tasks always win their id; an incoming task whose id is
 * taken (by a DIFFERENT task) gets the next free id. Returns { merged, added, renumbered, same }.
 */
function mergeTasks(live, incoming, opts = {}) {
  const merged = { version: live.version || 1, ...live, tasks: { ...(live.tasks || {}) } };
  let seq = Math.max(live.seq || 0, incoming.seq || 0, maxSeq(Object.keys(merged.tasks)), maxSeq(Object.keys(incoming.tasks || {})));
  const renumbered = {}, added = [], same = [];
  // The same task (same creation time and prompt) already present under ANY id — e.g. from an earlier
  // import that renumbered it — is not added again, so running an import or salvage twice is harmless.
  const fp = t => (t && t.createdAt ? t.createdAt + '\u0000' + String(t.prompt || t.title || '') : null);
  const seen = new Map();
  for (const [id, t] of Object.entries(merged.tasks)) { const k = fp(t); if (k) seen.set(k, id); }
  for (const [id, t] of Object.entries(incoming.tasks || {})) {
    const k = fp(t);
    if (k && seen.has(k)) { same.push(id); if (seen.get(k) !== id) renumbered[id] = seen.get(k); continue; }
    const cur = merged.tasks[id];
    let nid = id;
    if (cur) { nid = idFor(++seq); renumbered[id] = nid; }
    merged.tasks[nid] = { ...t, id: nid, ...(opts.tag ? { [opts.tag]: opts.tagValue || true } : {}), ...(nid !== id ? { originalId: id } : {}) };
    added.push(nid);
  }
  // References between the incoming tasks follow their renumbering.
  for (const nid of added) {
    const t = merged.tasks[nid];
    if (Array.isArray(t.dependsOn)) t.dependsOn = t.dependsOn.map(d => renumbered[d] || d);
  }
  merged.seq = seq;
  return { merged, added, renumbered, same };
}

function writeAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeSync(fd, JSON.stringify(obj, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}

/**
 * Salvage `src` (default: the newest registry.json.corrupt-* in the state dir) into the live
 * registry. Dry run unless opts.apply. Never modifies the corrupt file.
 */
function run(opts = {}) {
  const registry = require('./registry');
  const stateDir = opts.stateDir || registry.STATE_DIR;
  const live = opts.liveFile || registry.FILE;
  const src = opts.src || newestCorrupt(stateDir);
  if (!src) return { ok: false, error: 'NO_CORRUPT_FILE', message: `no registry.json.corrupt-* in ${stateDir}` };
  let raw;
  try { raw = fs.readFileSync(src, 'utf8'); } catch (e) { return { ok: false, error: 'UNREADABLE', src, message: e.message }; }
  const padding = raw.length - raw.replace(TRAIL, '').length;
  const out = salvage(raw);
  if (!out) return { ok: false, error: 'NOTHING_RECOVERABLE', src, chars: raw.length, padding };

  let cur = { version: 1, tasks: {}, seq: 0 };
  try { cur = JSON.parse(fs.readFileSync(live, 'utf8')); } catch {}
  const before = Object.keys(cur.tasks || {}).length;
  const m = mergeTasks(cur, out.data, { tag: 'salvagedFrom', tagValue: path.basename(src) });
  const res = {
    ok: true, src, method: out.method, chars: raw.length, padding,
    recovered: Object.keys(out.data.tasks || {}).length, liveBefore: before,
    added: m.added.length, alreadyPresent: m.same.length, renumbered: m.renumbered,
    total: Object.keys(m.merged.tasks).length, applied: false,
  };
  if (opts.apply) { writeAtomic(live, m.merged); res.applied = true; res.wrote = live; }
  return res;
}

module.exports = { salvage, mergeTasks, run, corruptFiles, newestCorrupt, maxSeq, writeAtomic };
