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

// 09-Nov (0.2.167 kept): /api/chips still sends `jobs` for a phone holding the older app.js.
check(/running, jobs, offered/.test(idx), '/api/chips still sends jobs (= running) for an older phone');
// 09-Nov, Ashwar: "the half blue dot is only in the session list but not inside when I open the session". NG's render
// (b4wnqw1g3, a background Bash) made the list half-blue, but the sheet read 'bg.scan' (Agent/Task only) and the header
// ignored bgJobs, so inside it was grey with "0 running ... Nothing running or offered here".
(async () => {
  const cwd = path.join(w.dir, 'ng'), cli = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', id = 'local_ngtest';
  const dir = path.join(S.PROJECTS, S.slugFor(cwd));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, cli + '.jsonl'), [
    launch('toolu_NGR', 'Bash', 'Render portrait final (x264, 1 thread)', 5 * 60000), started('toolu_NGR', 'b4wnqw1g3'),
    launch('toolu_NGD', 'Bash', 'an earlier probe', 9 * 60000), started('toolu_NGD', 'bprobe'), notify('<task-id>bprobe</task-id>'),
  ].join('\n') + '\n');
  const sess = { id, cwd, cliSessionId: cli };
  const sheet = await S.backgroundTasksSoon(sess);
  check(sheet.length === 1 && sheet[0].id === 'toolu_NGR' && /Render/.test(sheet[0].description), 'the sheet (session open, /api/chips) lists the live background Bash render', sheet.map(j => j.description));
  const list = S.liveJobs(id);
  check(list && list.n === sheet.length && /Render/.test(list.what), 'the list dot reads the same jobs: the open feeds its cache', list);

  // The phone side, from the shipped app.js: the header dot and the sheet's merge with the Desktop's own (empty) list.
  const vm = require('vm');
  const grab = (name) => { const i = app.indexOf('function ' + name + '('); let d = 0, j = app.indexOf('{', i);
    for (; j < app.length; j++) { if (app[j] === '{') d++; else if (app[j] === '}' && --d === 0) break; } return app.slice(i, j + 1); };
  const ctx = {}; vm.runInNewContext(grab('headDotClass') + '\n' + grab('mergeRunning') + '\nthis.h = headDotClass; this.m = mergeRunning;', ctx);
  check(ctx.h({ running: false, bgJobs: list.n }, false) === 'partial', 'the header dot is half-blue for an idle session with a live job');
  check(ctx.h({ running: true, bgJobs: 1 }, false) === 'running' && ctx.h({ bgJobs: 1 }, true) === 'awaiting' && ctx.h({}, false) === '', 'running and awaiting still win; nothing is grey');
  let m = ctx.m(sheet, [], 0);
  check(m.count === 1 && m.list.length === 1 && m.list[0].fromTranscript, 'Desktop says 0: the sheet still shows 1 running, the render (no Stop: the Desktop list cannot press it)', m.count);
  m = ctx.m(sheet, [{ label: 'Render portrait final (x264, 1 thread)', index: 0 }], 1);
  check(m.count === 1 && !m.list[0].fromTranscript, 'Desktop names the same job: it is shown once, with its Stop', m.count);
  m = ctx.m(sheet, [{ label: 'some other agent', index: 0 }], 1);
  check(m.count === 2, 'Desktop names a different job: both are shown', m.count);
  check(/renderChips\(m\.list, c\.offered/.test(app) && !/renderChips\(c\.liveTasks/.test(app) && !/renderChips\(d\.liveTasks/.test(app), 'no render path swaps the transcript list for the Desktop list');
  check(/sseSend\(c, 'chips', \{ id, running,/.test(idx), 'the chips SSE carries the transcript list too');
  check(/backgroundTasksSoon\(sess\) : \[\];\s*\n\s*\/\/[^\n]*\n\s*const dec = sessions\.decorate/.test(idx), '/api/session decorates after the scan, so its meta has bgJobs');

  try { fs.rmSync(path.dirname(file), { recursive: true, force: true }); } catch {}
  w.cleanup();
  if (H.failures()) { console.error(H.failures() + ' failed'); process.exit(1); }
  console.log('partial-dot: all checks passed');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
