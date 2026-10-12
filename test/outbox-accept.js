'use strict';
// g1783: Ashwar's message went over the bridge 157 ms before the Conductor's turn ended (a Stop-hook
// continuation). Desktop wrote no queue row and no user row: the message was gone, yet the phone said
// "delivered, waiting for a reply" for 73 minutes. A bridge send must now show up within a minute, else
// it is re-sent once under the same uuid, and if that is lost too it reads NOT delivered.
// Replayed here with the real outbox code and a transcript in the exact shape of that morning.
const fs = require('fs'), os = require('os'), path = require('path');
process.env.RELAYMOTE_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-obacc-'));
const ob = require('../mobile/outbox.js');
let fails = 0;
const check = (ok, what, got) => { console.log((ok ? 'ok   ' : 'FAIL ') + what + (ok || got === undefined ? '' : '  ' + JSON.stringify(got))); if (!ok) fails++; };
const NL = '\n';
const T0 = Date.parse('2026-10-12T05:50:47.384Z');
const text = 'So I also wanted to process the promotional buyers as separate buyer list.';
const uuid = 'e7e44aeb-8665-48c0-bf08-57dca9445a8c';

// The Conductor's transcript at that moment: a Stop-hook continuation, then its next turn. No trace of him.
const transcript = [
  { type: 'system', subtype: 'stop_hook_summary', timestamp: '2026-10-12T05:50:47.541Z' },
  { type: 'user', timestamp: '2026-10-12T05:50:47.600Z', message: { role: 'user', content: 'Stop hook feedback: keep going' } },
  { type: 'assistant', timestamp: '2026-10-12T05:50:52.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Continuing g1782.' }] } },
].map(r => JSON.stringify(r));
const read = () => transcript.join(NL);

const e = ob.add({ session: 'local_aaaaaaaa', text, delivery: 'held', uuid });
e.at = T0; ob.markSent(e.id, { ok: true, delivery: 'held' });
const all = ob.load(); all[0].at = T0; fs.writeFileSync(ob.FILE, JSON.stringify({ entries: all }));

let r = ob.checkAccepted(read, T0 + 30 * 1000);
check(!r.resend.length && !r.failed.length, 'within the first minute nothing is re-sent');
r = ob.checkAccepted(read, T0 + 61 * 1000);
check(r.resend.length === 1 && r.resend[0].uuid === uuid, 'after a minute with no queue or user row it is re-sent once, under the SAME uuid', r);
ob.markResent(e.id, { ok: true, now: T0 + 61 * 1000 });

// The re-send lands: Desktop writes the enqueue and later the queued_command attachment carrying the uuid.
transcript.push(JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: '2026-10-12T05:51:49Z', content: text }));
r = ob.checkAccepted(read, T0 + 70 * 1000);
check(!r.resend.length && !r.failed.length && ob.get(e.id).acceptedAt, 'the re-send is seen arriving (its enqueue row) and the message counts as taken');
r = ob.checkAccepted(read, T0 + 10 * 60 * 1000);
check(!r.resend.length && ob.get(e.id).state === 'pending', 'once taken it is never re-sent again (no duplicate)');

// Dropped twice: NOT delivered, never "delivered".
const e2 = ob.add({ session: 'local_b', text: 'second message that Desktop also loses', delivery: 'held', uuid: 'aaaaaaaa-0000-0000-0000-000000000002' });
const at2 = ob.get(e2.id).at;
const empty = () => '';
r = ob.checkAccepted(empty, at2 + 61 * 1000);
check(r.resend.length === 1, 'second case: re-sent once');
ob.markResent(e2.id, { ok: true, now: at2 + 61 * 1000 });
r = ob.checkAccepted(empty, at2 + 90 * 1000);
check(!r.resend.length && !r.failed.length, 'no second re-send while the first is still within its minute');
r = ob.checkAccepted(empty, at2 + 125 * 1000);
check(r.failed.length === 1 && ob.get(e2.id).state === 'failed' && ob.get(e2.id).notDelivered, 'lost again: marked NOT delivered', ob.get(e2.id));
r = ob.checkAccepted(empty, at2 + 300 * 1000);
check(!r.resend.length, 'and it is never re-sent a third time');

// A uuid row alone (queued_command attachment) also counts; an old message is never re-sent late.
const e3 = ob.add({ session: 'local_c', text: 'third', delivery: 'held', uuid: 'cccccccc-0000-0000-0000-000000000003' });
r = ob.checkAccepted(() => JSON.stringify({ type: 'attachment', attachment: { type: 'queued_command', prompt: 'x' }, uuid: 'cccccccc-0000-0000-0000-000000000003' }), ob.get(e3.id).at + 61 * 1000);
check(!r.resend.length && ob.get(e3.id).acceptedAt, 'a row carrying the uuid counts as arrived');
const e4 = ob.add({ session: 'local_d', text: 'sent long before this check existed', delivery: 'held', uuid: 'dddddddd-0000-0000-0000-000000000004' });
r = ob.checkAccepted(empty, ob.get(e4.id).at + 6 * 60 * 1000);
check(!r.resend.length, 'a message older than the re-send window is not re-sent late');
check(!ob.get(ob.add({ session: 'x', text: 'composer send' }).id).uuid && !ob.checkAccepted(empty, Date.now() + 120000).resend.some(x => x.text === 'composer send'),
      'a composer send (no uuid) is not re-sent by this path');

// The phone wording.
const app = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'public', 'app.js'), 'utf8');
check(/NOT delivered/.test(app) && /if \(e\.accepted\) return 'delivered, waiting for a reply'/.test(app), 'the phone says "delivered" only once the session took it, else NOT delivered');
const idx = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'index.js'), 'utf8');
check(/sendQueued\(e\.session, e\.text, \{ uuid: e\.uuid \}\)/.test(idx), 'the daemon re-sends with the original uuid');

if (fails) { console.error(fails + ' failed'); process.exit(1); }
console.log('outbox-accept: all checks passed');
