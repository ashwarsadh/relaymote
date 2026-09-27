// mobile-steps.js — step labels and peer rows: the transcript reader speaks the desktop's words.
// Ported from the private tool's test-steps.js. From a fixture transcript in a temp
// CLAUDE_CONFIG_DIR, the reader must yield:
//   * a cross-session message as a `peer` row with the sender's title (from `origin` on the user row
//     and from the mid-turn `queued_command` attachment), shown once;
//   * each tool_use with the desktop's verb pair and meta ("Ran"/"Running" + description, ...);
//   * `done` per tool from the tool_use_id join, and `stop` + output tokens per assistant row.
'use strict';
const H = require('./mobile-harness');
const W = H.world('steps', { demo: false, env: true });
const fs = require('fs');
const path = require('path');
const { check } = H;

const CWD = process.platform === 'win32' ? 'C:\\scratch\\steps-fixture' : '/tmp/scratch/steps-fixture';
const CLI = 'aaaaaaaa-0000-0000-0000-000000000001';
const dir = path.join(W.claude, 'projects', CWD.replace(/[^A-Za-z0-9]/g, '-'));
fs.mkdirSync(dir, { recursive: true });

const T = (s) => `2026-09-16T09:00:${String(s).padStart(2, '0')}.000Z`;
const rows = [
  { type: 'user', timestamp: T(1), origin: { kind: 'peer', from: 'local_conductor', name: 'Conductor — 10 Sep', msg_id: 'm1', body: 'Please do X.' },
    message: { role: 'user', content: 'Another Claude session sent a message:\n<cross-session-message from="local_conductor" name="Conductor — 10 Sep">\nPlease do X.\n</cross-session-message>' } },
  { type: 'assistant', timestamp: T(2), message: { role: 'assistant', model: 'claude-opus-5', stop_reason: 'tool_use', usage: { output_tokens: 40 },
    content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ping -n 5 127.0.0.1', description: 'Ping localhost five times' } }] } },
  { type: 'user', timestamp: T(3), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'Reply from 127.0.0.1' }] } },
  { type: 'attachment', timestamp: T(4), attachment: { type: 'queued_command', origin: { kind: 'peer', from: 'local_redesign', hostInjected: true },
    prompt: '<cross-session-message from="local_redesign" name="Redesign lane">\nNo conflict from me.\n</cross-session-message>' } },
  { type: 'user', timestamp: T(5), origin: { kind: 'peer', from: 'local_redesign', hostInjected: true },
    message: { role: 'user', content: '<cross-session-message from="local_redesign" name="Redesign lane">\nNo conflict from me.\n</cross-session-message>' } },
  { type: 'assistant', timestamp: T(6), message: { role: 'assistant', model: 'claude-opus-5', stop_reason: 'tool_use', usage: { output_tokens: 60 },
    content: [{ type: 'tool_use', id: 'tu2', name: 'Read', input: { file_path: 'C:\\Users\\x\\projects\\app\\mobile\\outbox.js' } },
              { type: 'tool_use', id: 'tu3', name: 'mcp__ccd_session_mgmt__send_message', input: { session_id: 'local_conductor', message: 'Done with X.' } },
              { type: 'tool_use', id: 'tu4', name: 'mcp__relaymote__relaymote_status', input: {} }] } },
  { type: 'user', timestamp: T(7), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu2', content: 'file text' }] } },
  // tu3 and tu4 have NO result yet: the turn is still running those
];
fs.writeFileSync(path.join(dir, CLI + '.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');

const sessions = require('../mobile/sessions');
const t = sessions.transcript({ id: 'local_fixture', cliSessionId: CLI, cwd: CWD }, { limit: 60 });
check(t.ok && t.messages.length > 0, 'the fixture transcript is read', t.error);
const msgs = t.messages || [];

console.log('--- peer rows ---');
const peers = msgs.filter(m => m.role === 'peer');
check(peers.length === 2, 'two DISTINCT peer messages -> two peer rows (the mid-turn one is not shown twice)', peers.map(p => p.name));
check(peers[0] && peers[0].name === 'Conductor — 10 Sep', 'the first names its sender from origin.name', peers[0] && peers[0].name);
check(peers[0] && peers[0].text === 'Please do X.', '...and carries the body, not the tag', peers[0] && peers[0].text);
check(peers[1] && peers[1].name === 'Redesign lane', 'the host-injected one names its sender from the tag', peers[1] && peers[1].name);
check(peers[1] && peers[1].text === 'No conflict from me.', '...and its body is the tag contents', peers[1] && peers[1].text);
check(!msgs.some(m => (m.role === 'system' || m.role === 'user') && /cross-session-message/.test(m.text || '')), 'a peer row is never rendered as a system note or a user bubble');

console.log('\n--- step labels, the desktop\'s words ---');
const by = Object.fromEntries(msgs.flatMap(m => m.tools || []).map(x => [x.id, x]));
const L = id => by[id] && by[id].label;
check(L('tu1') && L('tu1').done === 'Ran' && L('tu1').running === 'Running' && L('tu1').meta === 'Ping localhost five times', 'Bash -> "Ran"/"Running" + the description', L('tu1'));
check(L('tu2') && L('tu2').done === 'Read' && L('tu2').running === 'Reading' && L('tu2').meta === 'outbox.js', 'Read -> "Read"/"Reading" + the file name', L('tu2'));
check(L('tu3') && L('tu3').done === 'Messaged teammate' && L('tu3').running === 'Messaging teammate' && L('tu3').meta === 'Done with X.', 'session send_message -> "Messaged teammate" + the message', L('tu3'));
check(L('tu4') && L('tu4').done === 'Used relaymote status' && L('tu4').running === 'Using relaymote status', 'an unknown MCP tool -> "Used <label>"/"Using <label>"', L('tu4'));

console.log('\n--- done / running, from the recorded tool_use_id join ---');
check(by.tu1 && by.tu1.done === true && by.tu2 && by.tu2.done === true, 'a tool with its result back is done');
check(by.tu3 && by.tu3.done === false && by.tu4 && by.tu4.done === false, 'the two calls still awaiting a result are NOT done (they render present-tense)');
const asst = msgs.filter(m => m.role === 'assistant');
check(asst.length === 2 && asst.every(m => m.stop === 'tool_use'), 'assistant rows carry stop_reason for the live line', asst.map(m => m.stop));
check(asst.every(m => m.usage && m.usage.out > 0), 'assistant rows carry output tokens for the live line', asst.map(m => m.usage && m.usage.out));

H.finish(W);
