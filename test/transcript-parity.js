// Transcript parity (g1050, g1069): what Desktop shows is in the reading view, once -- every user
// message, peer message and assistant text. Thinking is NOT shown: Desktop does not show it (g1069
// reversed 0.2.65, which drew it as grey prose). This builds a turn with a held message, thinking, a
// tool step, text and a peer message, and checks the reader and the client agree.
const fs = require('fs'), os = require('os'), path = require('path');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-parity-'));
process.env.CLAUDE_CONFIG_DIR = TMP;
const sessions = require('../mobile/sessions.js');
let fails = 0;
const check = (ok, what, got) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) { fails++; if (got !== undefined) console.log('     ', JSON.stringify(got).slice(0, 300)); } };

const cwd = path.join(TMP, 'work', 'proj');
const cli = '11111111-2222-3333-4444-555555555555';
const dir = path.join(TMP, 'projects', sessions.slugFor(cwd));
fs.mkdirSync(dir, { recursive: true });
const t = (s) => '2026-10-02T21:' + s + 'Z';
const A = (ts, content) => ({ type: 'assistant', timestamp: t(ts), message: { role: 'assistant', content } });
const rows = [
  { type: 'user', timestamp: t('04:00.000'), message: { role: 'user', content: 'check the meter bills' } },
  A('05:00.000', [{ type: 'thinking', thinking: 'Found a bug: the two meter checks re-read the earlier reply.' }]),
  A('05:10.000', [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'run.sh', description: 'Redeploy and rerun the two meter checks' } }]),
  { type: 'user', timestamp: t('05:20.000'), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'done' }] } },
  A('05:30.000', [{ type: 'thinking', thinking: 'I found the issue: checks were resuming the old conversation.' }, { type: 'text', text: 'Fixed: each check now starts fresh.' }]),
  // a reply he sent mid-turn: queued at once, delivered when the turn ended
  { type: 'queue-operation', operation: 'enqueue', timestamp: t('24:44.000'), content: 'only alert after the due date' },
  { type: 'queue-operation', operation: 'dequeue', timestamp: t('24:44.100') },
  { type: 'user', timestamp: t('24:44.200'), message: { role: 'user', content: 'only alert after the due date' } },
  A('25:00.000', [{ type: 'text', text: 'Understood, alerts move to after the due date.' }]),
  { type: 'user', timestamp: t('26:00.000'), origin: { kind: 'peer', from: 'local_x' }, message: { role: 'user', content: 'Another Claude session sent a message:\n<cross-session-message from="local_x" name="Lead">status?</cross-session-message>' } },
];
fs.writeFileSync(path.join(dir, cli + '.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');

const tr = sessions.transcript({ cwd, cliSessionId: cli }, { limit: 500 });
const ms = tr.messages || [];
const users = ms.filter(m => m.role === 'user' && !m.queued).map(m => m.text);
const count = (arr, x) => arr.filter(v => String(v || '').includes(x)).length;
check(tr.ok !== false && ms.length > 0, 'the reader returns the turn', tr.error);
check(count(users, 'check the meter bills') === 1, 'his first message, once', users);
check(count(users, 'only alert after the due date') === 1, 'the held reply, once (delivered copy only)', users);
check(!ms.some(m => m.queued), 'no queued leftover once the reply was delivered', ms.filter(m => m.queued));
const thinking = ms.filter(m => m.role === 'assistant').map(m => m.thinking).join('\n');
const text = ms.filter(m => m.role === 'assistant').map(m => m.text).join('\n');
check(thinking.includes('Found a bug') && thinking.includes('I found the issue'), 'the reader keeps thinking (search only; never drawn)');
check(text.includes('Fixed: each check') && text.includes('Understood, alerts'), 'both text replies are present');
check(ms.some(m => (m.tools || []).some(x => /Redeploy and rerun/.test(JSON.stringify(x)))), 'the tool step carries its description');
check(ms.filter(m => m.role === 'peer').length === 1, 'the peer message, once, as a peer row');

// Client: thinking is drawn nowhere -- not in the flow, not inside the collapsed "Working" group.
const app = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'public', 'app.js'), 'utf8');
check(!/msg thought/.test(app), 'app.js draws no thought row in the flow');
check(!/class="think"/.test(app), 'and no thinking section inside Working');
check(!/m\.thinking\)\s*out \+=/.test(app) && !/\$\{esc\(m\.thinking\)\}/.test(app), 'and never writes m.thinking into the page');

fs.rmSync(TMP, { recursive: true, force: true });
if (fails) { console.error(fails + ' failed'); process.exit(1); }
console.log('transcript-parity: all checks passed');
