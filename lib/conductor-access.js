// conductor-access.js — which control tools the Conductor may use, and on whom.
//
// The Conductor role (settings.conductorSession) is not a master claim: it holds no project and no
// fleet in state/masters.json. Before this module, every tool that began with "load my claim" returned
// NO_CLAIM to the Conductor, relaymote_goal refused any session outside the caller's own fleet (the
// Conductor has none), relaymote_start_task adopted nothing, and changing fast mode was master-only.
//
// The rules here:
//   SLAVE      refused, as before.
//   MASTER     unchanged: goals only inside its own fleet (force:true overrides), adopts into its fleet.
//   CONDUCTOR  may goal ANY session, including one in a master's fleet, reads every master's fleet,
//              and keeps its own list of the sessions it started or goaled (state/conductor-fleet.json)
//              so master-notify and the goal cap have something to count.
// A session that is both the Conductor and a project master keeps using its master fleet for adoption.
'use strict';
const fs = require('fs');
const path = require('path');
const config = require('./config');

const fleetFile = () => path.join(config.STATE, 'conductor-fleet.json');

/** 'CONDUCTOR' | 'MASTER' | 'SLAVE'. The Conductor role wins when a session holds both. */
function role({ me, claim, conductor }) {
  if (me && conductor && String(me) === String(conductor)) return 'CONDUCTOR';
  return claim ? 'MASTER' : 'SLAVE';
}

function loadConductorFleet() {
  try { const j = JSON.parse(fs.readFileSync(fleetFile(), 'utf8')); return Array.isArray(j.fleet) ? j.fleet : []; } catch { return []; }
}
function saveConductorFleet(list) {
  const f = fleetFile();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ fleet: [...new Set(list)], updatedAt: new Date().toISOString() }, null, 2));
  fs.renameSync(tmp, f);
}

/** The fleet the caller's goal cap and adoption apply to. */
function fleetOf({ role: r, claim }) {
  if (claim) return claim.fleet || [];
  if (r === 'CONDUCTOR') return loadConductorFleet();
  return [];
}

/**
 * Guard for relaymote_goal. Returns null when allowed, or the refusal object.
 * A master may goal only its own fleet; the Conductor may goal any session.
 */
function goalGuard({ role: r, fleet, sessionId, action, force }) {
  if (r === 'SLAVE') return { error: 'NO_CLAIM', message: 'Setting goals needs the master claim or the Conductor role.' };
  if (action !== 'set' || force || r === 'CONDUCTOR') return null;
  const set = fleet instanceof Set ? fleet : new Set(fleet || []);
  if (set.has(sessionId)) return null;
  return { error: 'NOT_IN_YOUR_FLEET', sessionId, fleetSize: set.size,
           message: 'That session is not in your fleet, and a goal makes it work unsupervised. Adopt it first with relaymote_fleet adopt:["' + sessionId + '"] if it is yours, or ask the master that owns it. force:true overrides.' };
}

/** Which master (if any) already has this session in its fleet — the Conductor tells that master. */
function ownerMasterOf(sessionId, allMasters) {
  for (const [project, m] of Object.entries(allMasters || {})) {
    if (m && (m.fleet || []).includes(sessionId)) return { project, sessionId: m.sessionId };
  }
  return null;
}

function canChangeFastMode(r) { return r === 'MASTER' || r === 'CONDUCTOR'; }

/**
 * Record ids in the caller's fleet. `saveMaster` persists a master claim. Returns the ids adopted,
 * or null when the caller has nowhere to put them (a slave).
 */
function adopt(ids, { role: r, claim, saveMaster }) {
  const list = (ids || []).filter(Boolean);
  if (!list.length) return [];
  if (claim) {
    claim.fleet = [...new Set([...(claim.fleet || []), ...list])];
    if (saveMaster) saveMaster(claim);
    return list;
  }
  if (r === 'CONDUCTOR') { saveConductorFleet([...loadConductorFleet(), ...list]); return list; }
  return null;
}
function drop(ids, { role: r, claim, saveMaster }) {
  const out = new Set(ids || []);
  if (claim) { claim.fleet = (claim.fleet || []).filter(x => !out.has(x)); if (saveMaster) saveMaster(claim); return; }
  if (r === 'CONDUCTOR') saveConductorFleet(loadConductorFleet().filter(x => !out.has(x)));
}

module.exports = { role, loadConductorFleet, saveConductorFleet, fleetOf, goalGuard, ownerMasterOf, canChangeFastMode, adopt, drop, fleetFile };
