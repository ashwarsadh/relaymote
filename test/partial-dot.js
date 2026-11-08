// partial-dot.js — 08-Nov-2026, Ashwar: "a session who has another background session working, maybe should not show a
// simple gray dot, but some other dot ... this session is not working itself, but partially working."
// The Nirvaan Gyaan session was idle while its ffmpeg render (task b0rv704jr) ran, and its dot was plain grey.
// backgroundFromFile(file, { all: true }) lists every unfinished run_in_background job; a job ends by its notification
// (by tool-use id or task id) or by TaskStop {task_id}, which writes no notification (19 such stops in that transcript).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const H = require('./mobile-harness');
const { check } = H;
const w = H.world('pdot', { env: true });
const S = require('../mobile/sessions');

const now = Date.now();
const iso = (msAgo) => new Date(now - msAgo).toISOString();
const launch = (id, name, desc, msAgo) => JSON.stringify({ type: 'assistant', timestamp: iso(msAgo),
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input: { command: 'x', description: desc, run_in_background: true } }] } });
const started = (id, taskId) => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id,
  content: `Command running in background with ID: ${taskId}. Output is being written to: C:\\tmp\\${taskId}.output` }] } });
const notify = (inner) => JSON.stringify({ type: 'user', message: { role: 'user', content: `<task-notification>\n${inner}\n<status>completed</status>\n</task-notification>` } });
const stop = (taskId) => JSON.stringify({ type: 'assistant', timestamp: iso(1000),
  message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_stop' + taskId, name: 'TaskStop', input: { task_id: taskId } }] } });

const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pdot-')), 't.jsonl');
fs.writeFileSync(file, [
  launch('toolu_RENDER', 'Bash', 'Render final 9x16 and 16x9', 60000), started('toolu_RENDER', 'b0rv704jr'),
  launch('toolu_DONE', 'Bash', 'finished by tool-use id', 50000), started('toolu_DONE', 'bdone1'),
  notify('<task-id>bdone1</task-id>\n<tool-use-id>toolu_DONE</tool-use-id>'),
  launch('toolu_TONLY', 'Bash', 'finished by task id only', 40000), started('toolu_TONLY', 'btonly'),
  notify('<task-id>btonly</task-id>'),
  launch('toolu_STOP', 'Bash', 'stopped by TaskStop', 30000), started('toolu_STOP', 'bstop1'), stop('bstop1'),
  launch('toolu_OLD', 'Bash', 'started 13 h ago', 13 * 3600000), started('toolu_OLD', 'bold1'),
  launch('toolu_AGENT', 'Agent', 'a background agent', 20000),
].join('\n') + '\n');

const all = S.backgroundFromFile(file, { all: true }).map(j => j.id).sort();
check(JSON.stringify(all) === JSON.stringify(['toolu_AGENT', 'toolu_RENDER']), 'live jobs: the render and the agent only', all);
check(S.backgroundFromFile(file).map(j => j.id).join() === 'toolu_AGENT', 'the chips list (default) still counts Agent/Task only');

// The render ends: a notification by tool-use id appended later is read incrementally.
fs.appendFileSync(file, notify('<task-id>b0rv704jr</task-id>\n<tool-use-id>toolu_RENDER</tool-use-id>') + '\n');
check(S.backgroundFromFile(file, { all: true }).map(j => j.id).join() === 'toolu_AGENT', 'after its notification the render is no longer live');
fs.appendFileSync(file, stop('agentX') + '\n');
check(S.backgroundFromFile(file, { all: true }).length === 1, 'a stop of an unrelated task id changes nothing');

// The list and the dot.
const app = H.src('mobile/public/app.js'), css = H.src('mobile/public/style.css'), idx = H.src('mobile/index.js');
check(/s\.awaiting \? 'awaiting' : s\.bgJobs \? 'partial' : 'idle'/.test(app), 'an idle session with a live job gets the "partial" dot; running and awaiting win');
check(/\.dot\.partial\{[^}]*linear-gradient\(90deg,var\(--run\) 50%,transparent 50%\)/.test(css), 'the partial dot is half a blue dot, not amber (amber = needs you)');
check(/bgJobs: d && d\.running \? 0/.test(H.src('mobile/sessions.js')), 'a running session never also shows background jobs');
check(/sessions\.refreshLiveJobs\(all\)/.test(idx) && /bgJobs: s\.bgJobs \|\| undefined/.test(idx), '/api/sessions refreshes and sends bgJobs');

// 09-Nov: the panel said "0 running" while the dot was half-blue (it read only the PC's task button). The panel now
// gets the same jobs the dot reads, and shows them when the PC lists none.
check(/backgroundTasksSoon\(sess, \{ all: true \}\)/.test(idx) && /running, jobs, offered/.test(idx), '/api/chips sends the live jobs the dot reads');
check(/const extra = running\.length \? \[\] : cj;/.test(app) && /!running\.length && !extra\.length && !chips\.length/.test(app),
  'the panel lists transcript jobs when the PC shows none, so it never says "Nothing running" under a half-blue dot');

try { fs.rmSync(path.dirname(file), { recursive: true, force: true }); } catch {}
w.cleanup();
if (H.failures()) { console.error(H.failures() + ' failed'); process.exit(1); }
console.log('partial-dot: all checks passed');
