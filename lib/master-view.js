// master-view.js — "a master must be able to see its own sessions and goals" (Ashwar 09-Nov, g: Agent Teams hybrid).
//
// A master's FLEET here = the master itself + the sessions in its claim (state/masters.json `fleet`, what
// relaymote_fleet adopts) + the sessions it started (the project index: `children`, and any session whose
// `spawned_from` is the master). One level only: the Conductor's view does not pull in every master's fleet.
// Native Agent Teams teammates (in-process) are NOT Desktop sessions and never appear here; the master
// reports them through its own goals (see STATE.md 09-Nov "Agent Teams hybrid").
//
// The index is 15 MB; it is parsed at most once per index rebuild (cached by mtime) and reduced to a small map.
'use strict';
const fs = require('fs');

let cache = { mtime: 0, map: null };

function claims() { try { return require('./notify').activeMasters(); } catch { return []; } }

/** Pure: { masterId: {project, fleet: Set} } from claims and index sessions. */
function compute({ claimList = [], sessions = {} }) {
  const out = {};
  const add = (mid, project) => (out[mid] = out[mid] || { project: project || null, fleet: new Set([mid]) });
  for (const c of claimList) { const m = add(c.sessionId, c.project); for (const id of c.fleet || []) m.fleet.add(id); }
  for (const s of Object.values(sessions)) {
    if (!s || s.archived) continue;
    if (s.is_master) { const m = add(s.id, s.project); for (const id of s.children || []) m.fleet.add(id); }
  }
  for (const s of Object.values(sessions)) {
    if (s && s.spawned_from && out[s.spawned_from]) out[s.spawned_from].fleet.add(s.id);
  }
  return out;
}

function map() {
  let ix = null, mtime = 0;
  try { const p = require('./projects'); mtime = fs.statSync(p.INDEX_JSON).mtimeMs; if (mtime !== cache.mtime || !cache.map) ix = p.read(); } catch {}
  if (ix) cache = { mtime, map: compute({ claimList: [], sessions: ix.sessions || {} }) };
  // claims change between index builds (a master claims, adopts): merge them live, they are tiny.
  const live = compute({ claimList: claims(), sessions: {} });
  const base = cache.map || {};
  const merged = {};
  for (const [k, v] of Object.entries(base)) merged[k] = { project: v.project, fleet: new Set(v.fleet) };
  for (const [k, v] of Object.entries(live)) {
    const m = merged[k] = merged[k] || { project: v.project, fleet: new Set([k]) };
    if (v.project) m.project = v.project;
    for (const id of v.fleet) m.fleet.add(id);
  }
  return merged;
}

/** Set of session ids in this master's fleet (including itself), or null if it is not a master. */
function fleetOf(masterId) { const m = map()[masterId]; return m ? m.fleet : null; }

/** id -> {fleet: n, project} for every master, to tag rows on the phone. */
function badges() {
  const out = {};
  for (const [k, v] of Object.entries(map())) out[k] = { fleet: v.fleet.size - 1, project: v.project };
  return out;
}

module.exports = { compute, map, fleetOf, badges };
