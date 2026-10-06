// g1384: "after being sent, it suddenly disappeared". A message sent while the session is busy is
// handed to the running turn, and the transcript records it ONLY as an attachment row of type
// queued_command (origin.kind "human"), never as a user message. That row was dropped, so the message
// vanished from the chat once delivered. Here: a transcript of that exact shape, read the real way.
const fs = require('fs'), os = require('os'), path = require('path');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-midturn-'));
process.env.CLAUDE_CONFIG_DIR = home;
process.env.RELAYMOTE_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-midturn-state-'));
const sessions = require('../mobile/sessions.js');
let fails = 0;
const check = (ok, what, got) => { console.log((ok ? 'ok   ' : 'FAIL ') + what + (got !== undefined ? '  ' + JSON.stringify(got) : '')); if (!ok) fails++; };

const cwd = path.join(home, 'proj'), cli = '11111111-2222-3333-4444-666666666666';
const dir = path.join(sessions.PROJECTS, sessions.slugFor(cwd));
fs.mkdirSync(dir, { recursive: true });
let t = Date.parse('2026-10-06T21:00:00Z');
const ts = () => new Date(t += 1000).toISOString();
const rows = [
  { type: 'user', timestamp: ts(), message: { role: 'user', content: 'Start the long job.' } },
  { type: 'assistant', timestamp: ts(), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'sleep 60' } }] } },
  // sent from the phone while that tool ran: a plain string prompt
  { type: 'attachment', timestamp: ts(), attachment: { type: 'queued_command', prompt: 'Also check the mirror while you are at it.', commandMode: 'prompt', origin: { kind: 'human' }, humanTurn: true } },
  // the other shape: blocks, with a reminder in front of his words
  { type: 'attachment', timestamp: ts(), attachment: { type: 'queued_command', commandMode: 'prompt', origin: { kind: 'human' }, humanTurn: true,
    prompt: [{ type: 'text', text: '<system-reminder>\nA background task started.\n</system-reminder>\n\n' }, { type: 'text', text: 'And send me the report after.' }] } },
  // not his: a peer's message, and a bare reminder with no origin
  { type: 'attachment', timestamp: ts(), attachment: { type: 'queued_command', prompt: '<cross-session-message from="local_x" name="Other">hello</cross-session-message>', commandMode: 'prompt', origin: { kind: 'peer', from: 'local_x', name: 'Other' } } },
  { type: 'attachment', timestamp: ts(), attachment: { type: 'queued_command', prompt: '<system-reminder>\nnoise\n</system-reminder>', commandMode: 'prompt' } },
  { type: 'user', timestamp: ts(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'done' }] } },
  { type: 'assistant', timestamp: ts(), message: { role: 'assistant', content: [{ type: 'text', text: 'Job done; mirror checked; report sent.' }] } },
];
fs.writeFileSync(path.join(dir, cli + '.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');

const tr = sessions.transcript({ cwd, cliSessionId: cli });
const msgs = (tr && tr.messages) || tr || [];
const mine = msgs.filter(m => m.role === 'user').map(m => m.text);
check(mine.includes('Also check the mirror while you are at it.'), 'a message sent mid-turn is shown as his message', mine);
check(mine.includes('And send me the report after.'), 'the block form is shown too, without the reminder in front of it');
check(mine.length === 3, 'exactly his three messages: no reminder or peer message shown as his', mine.length);
check(msgs.some(m => m.role === 'peer'), 'a peer message mid-turn is still a peer row');
const order = msgs.filter(m => m.role === 'user' || (m.role === 'assistant' && m.text)).map(m => m.text.slice(0, 12));
check(order.indexOf('Also check t') < order.indexOf('Job done; mi'), 'it sits where he sent it, before the reply that answered it', order);

fs.rmSync(home, { recursive: true, force: true });
if (fails) { console.error(fails + ' failed'); process.exit(1); }
console.log('midturn-message: all checks passed');
