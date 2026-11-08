// master-view.js — 09-Nov-2026 (Agent Teams hybrid): "a master must be able to see its own sessions and goals in
// RelayMote". The phone's master view narrows the list to master + fleet; the fleet is the claim's fleet, the
// index's children, and any session spawned_from the master. Archived masters are not masters; one level only.
'use strict';
const MV = require('../lib/master-view');

let failed = 0, passed = 0;
const check = (ok, name, extra) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && extra !== undefined ? '  ' + JSON.stringify(extra) : ''}`); if (ok) passed++; else failed++; };

const sessions = {
  M: { id: 'M', is_master: true, project: 'tally', children: ['A'] },
  A: { id: 'A', spawned_from: 'M' },
  B: { id: 'B', spawned_from: 'M' },            // started by M but not yet in children
  C: { id: 'C', spawned_from: 'A' },            // grandchild: not M's (one level)
  X: { id: 'X', is_master: true, archived: true, children: ['D'] },
  D: { id: 'D' },
  Q: { id: 'Q' },
};
const out = MV.compute({ claimList: [{ sessionId: 'K', project: 'web', fleet: ['Q'] }, { sessionId: 'M', project: 'tally', fleet: ['D'] }], sessions });
const ids = (k) => [...(out[k] ? out[k].fleet : [])].sort().join(',');
check(ids('M') === 'A,B,D,M', 'M: itself + children + spawned_from + claim fleet', ids('M'));
check(!ids('M').includes('C'), 'a grandchild is not pulled into the master view');
check(!out.X, 'an archived master is not a master');
check(ids('K') === 'K,Q' && out.K.project === 'web', 'a claim with no index row still gives a fleet', out.K);
check(MV.compute({}).constructor === Object && Object.keys(MV.compute({})).length === 0, 'empty input gives no masters');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
