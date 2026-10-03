// g1132: the daemon's heap held 1-2 GB that a full collection could not free. A heap snapshot showed
// whole transcripts (272, 163, 132 MB ...) each kept alive by a few tiny "sliced strings": backgroundTasks
// read a whole transcript into one string on first look, and the task ids it cached were regex matches
// into that string, which V8 keeps as views of the WHOLE string. Here: a 60 MB transcript, scanned, then
// dropped -- what survives a full collection must be small, and the scan must still find its tasks.
const fs = require('fs'), os = require('os'), path = require('path'), v8 = require('v8');
v8.setFlagsFromString('--expose-gc');
const gc = require('vm').runInNewContext('gc');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-retain-'));
process.env.CLAUDE_CONFIG_DIR = home;
process.env.RELAYMOTE_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-retain-state-'));
const sessions = require('../mobile/sessions.js');
let fails = 0;
const check = (ok, what, got) => { console.log((ok ? 'ok   ' : 'FAIL ') + what + (got !== undefined ? '  ' + JSON.stringify(got) : '')); if (!ok) fails++; };

const cwd = path.join(home, 'proj');
const cli = '11111111-2222-3333-4444-555555555555';
const dir = path.join(sessions.PROJECTS, sessions.slugFor(cwd));
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, cli + '.jsonl');
const filler = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(4000) }] } }) + '\n';
const fd = fs.openSync(file, 'w');
for (let i = 0; i < 40; i++) {
  fs.writeSync(fd, filler.repeat(370));   // ~1.5 MB per block, ~60 MB in all
  const id = 'toolu_' + String(i).padStart(4, '0') + 'abc';
  fs.writeSync(fd, JSON.stringify({ type: 'assistant', timestamp: '2026-10-04T00:00:00Z', message: { content: [{ type: 'tool_use', id, name: 'Agent', input: { prompt: 'job ' + i, run_in_background: true, description: 'job ' + i } }] } }) + '\n');
  if (i % 2) fs.writeSync(fd, JSON.stringify({ type: 'user', message: { content: '<task-notification><tool-use-id>' + id + '</tool-use-id><status>completed</status></task-notification>' } }) + '\n');
}
fs.closeSync(fd);
const mb = fs.statSync(file).size / 1048576;

gc(); const before = process.memoryUsage().heapUsed;
const tasks = sessions.backgroundTasks({ cwd, cliSessionId: cli });
gc(); gc(); const after = process.memoryUsage().heapUsed;
const kept = (after - before) / 1048576;
check(mb > 50, `the transcript is large (${mb.toFixed(0)} MB)`);
check(tasks.length === 20 && tasks[0].description === 'job 0', 'the scan still finds the 20 agents still running (of 40 launched)', tasks.length);
check(kept < 4, `after a full collection the scan keeps almost nothing, not the transcript (${kept.toFixed(1)} of ${mb.toFixed(0)} MB)`);

fs.rmSync(home, { recursive: true, force: true });
if (fails) { console.error(fails + ' failed'); process.exit(1); }
console.log('transcript-retention: all checks passed');
