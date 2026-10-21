'use strict';
// 21-Oct-2026: a message typed during a turn is written after rows stamped later than it; it must show at
// its own time, not under replies to other things. Tool rows and attachments keep file order.
const assert = require('assert');
const { byTypedTimeForTest: order } = require('../mobile/sessions');
const T = (s) => '2026-10-21T15:17:' + s + 'Z';
const ids = (a) => a.map(m => m.id).join(',');

// The 04:49 case from a real Conductor transcript: his message (ts 08) lands in the file after a reply stamped 40.
let r = order([
  { id: 'a1', role: 'assistant', ts: T('05.000') },
  { id: 'a2', role: 'assistant', ts: T('40.000') },
  { id: 'u', role: 'user', ts: T('08.000') },
  { id: 'a3', role: 'assistant', ts: T('45.000') },
]);
assert.strictEqual(ids(r), 'a1,u,a2,a3');

// ms jitter (attachment 17.552 after user 17.553) and in-order rows are untouched.
r = order([
  { id: 'u', role: 'user', ts: T('17.553') },
  { id: 'at', role: 'attachment', ts: T('17.552') },
  { id: 'u2', role: 'user', ts: T('16.000') },
  { id: 'x', role: 'assistant', ts: null },
  { id: 'p', role: 'peer', ts: T('30.000') },
]);
assert.strictEqual(ids(r), 'u,at,u2,x,p');

// A non-typed row out of order stays where the file put it.
r = order([{ id: 'a', role: 'assistant', ts: T('40.000') }, { id: 't', role: 'tool', ts: T('01.000') }]);
assert.strictEqual(ids(r), 'a,t');
console.log('typed-order: 3 checks passed');
