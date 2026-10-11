'use strict';
// g1719: "/goal …" sent from the phone was received (the session ran it for minutes) but the phone kept
// "queued · waiting to be picked up" with a live "send now" — a second tap would run the /goal again.
// Claude Code writes every `dequeue` WITHOUT content, and a slash command lands as a <command-name> turn,
// so neither the queue op nor the text match cleared it. Here: that exact transcript shape.
const fs = require('fs'), os = require('os'), path = require('path');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-qcmd-'));
process.env.CLAUDE_CONFIG_DIR = home;
process.env.RELAYMOTE_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-qcmd-state-'));
const sessions = require('../mobile/sessions.js');
let fails = 0;
const check = (ok, what, got) => { console.log((ok ? 'ok   ' : 'FAIL ') + what + (ok || got === undefined ? '' : '  ' + JSON.stringify(got))); if (!ok) fails++; };

const cwd = path.join(home, 'proj');
const dir = path.join(sessions.PROJECTS, sessions.slugFor(cwd));
fs.mkdirSync(dir, { recursive: true });
let t = Date.parse('2026-10-11T19:39:00Z');
const ts = () => new Date(t += 1000).toISOString();
const write = (cli, rows) => fs.writeFileSync(path.join(dir, cli + '.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
const queuedOf = (cli) => { const tr = sessions.transcript({ cwd, cliSessionId: cli }); return ((tr && tr.messages) || []).filter(m => m.queued).map(m => m.text.slice(0, 30)); };

const goal = '/goal Please chase all lanes, incomplete, pending.\nKeep working.';
const A = '11111111-2222-3333-4444-000000000001';
write(A, [
  { type: 'user', timestamp: ts(), message: { role: 'user', content: 'earlier task' } },
  { type: 'assistant', timestamp: ts(), message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
  { type: 'queue-operation', operation: 'enqueue', timestamp: ts(), content: goal },
  { type: 'queue-operation', operation: 'dequeue', timestamp: ts() },
  { type: 'user', timestamp: ts(), message: { role: 'user', content: '<command-name>/goal</command-name>\n            <command-message>goal</command-message>\n            <command-args>Please chase all lanes, incomplete, pending.\nKeep working.</command-args>' } },
  { type: 'assistant', timestamp: ts(), message: { role: 'assistant', content: [{ type: 'text', text: 'Goal set. Starting now.' }] } },
]);
check(queuedOf(A).length === 0, 'a /goal the session picked up is not shown as queued (no "send now")', queuedOf(A));

// Only the dequeue: the command turn is outside the window or not written yet.
const B = '11111111-2222-3333-4444-000000000002';
write(B, [
  { type: 'queue-operation', operation: 'enqueue', timestamp: ts(), content: '/compact' },
  { type: 'queue-operation', operation: 'dequeue', timestamp: ts() },
  { type: 'assistant', timestamp: ts(), message: { role: 'assistant', content: [{ type: 'text', text: 'Compacted.' }] } },
]);
check(queuedOf(B).length === 0, 'a content-less dequeue clears the message it took', queuedOf(B));

// Still genuinely waiting: two enqueued, one taken (oldest first), one left.
const C = '11111111-2222-3333-4444-000000000003';
write(C, [
  { type: 'user', timestamp: ts(), message: { role: 'user', content: 'start' } },
  { type: 'queue-operation', operation: 'enqueue', timestamp: ts(), content: 'first follow-up' },
  { type: 'queue-operation', operation: 'enqueue', timestamp: ts(), content: 'second follow-up' },
  { type: 'queue-operation', operation: 'dequeue', timestamp: ts() },
  { type: 'assistant', timestamp: ts(), message: { role: 'assistant', content: [{ type: 'text', text: 'working' }] } },
]);
const c = queuedOf(C);
check(c.length === 1 && c[0].startsWith('second'), 'a message still waiting keeps its "queued" and "send now"', c);

// A removed message (he deleted it from the queue) is not queued either.
const D = '11111111-2222-3333-4444-000000000004';
write(D, [
  { type: 'user', timestamp: ts(), message: { role: 'user', content: 'start' } },
  { type: 'queue-operation', operation: 'enqueue', timestamp: ts(), content: 'never mind this' },
  { type: 'queue-operation', operation: 'remove', timestamp: ts(), content: 'never mind this' },
]);
check(queuedOf(D).length === 0, 'a message removed from the queue is not shown as waiting', queuedOf(D));

fs.rmSync(home, { recursive: true, force: true });
if (fails) { console.error(fails + ' failed'); process.exit(1); }
console.log('queued-command: all checks passed');
