// off-thread.js — 08-Nov: the periodic scans run in workers. The loop stays free during them, a dead or hung worker costs
// one answer and not the lane, and the real tasks do their real work from a worker.
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-off-'));
process.env.RELAYMOTE_HOME = path.join(dir, 'home');
process.env.APPDATA = path.join(dir, 'appdata');
process.env.CLAUDE_CONFIG_DIR = path.join(dir, 'claude');
process.env.RELAYMOTE_CONDUCTOR_DIR = path.join(dir, 'home', 'conductor');
process.env.RELAYMOTE_OFF_THREAD_TEST = '1';
process.env.RELAYMOTE_OFF_THREAD_TIMEOUT_MS = '3000';
for (const d of [process.env.RELAYMOTE_HOME, process.env.APPDATA, process.env.CLAUDE_CONFIG_DIR, process.env.RELAYMOTE_CONDUCTOR_DIR]) fs.mkdirSync(d, { recursive: true });
let fails = 0;
const check = (ok, what, got) => { console.log((ok ? 'ok   ' : 'FAIL ') + what + (got !== undefined ? '  ' + JSON.stringify(got) : '')); if (!ok) fails++; };
const failed = (p) => p.then(() => null, e => e);

(async () => {
  const off = require('../lib/off-thread');
  const { threadId } = require('worker_threads');

  const where = await off.run('a', 'test.where');
  check(where !== threadId && where > 0, 'a task runs on another thread', where);

  // The point of it: the loop is free for the whole of a 2 s task.
  let last = Date.now(), gap = 0;
  const beat = setInterval(() => { const n = Date.now(); gap = Math.max(gap, n - last); last = n; }, 20);
  const busy = off.run('a', 'test.busy', { ms: 2000 });
  await busy; clearInterval(beat);
  check(gap < 500, 'the event loop keeps running during a 2 s task', gap);

  // Lanes are independent; one lane runs in order.
  const t0 = Date.now();
  const slow = off.run('a', 'test.busy', { ms: 1500 });
  const quick = await off.run('b', 'test.where');
  check(Date.now() - t0 < 1400 && quick !== where, 'a slow lane does not delay another lane', Date.now() - t0);
  await slow;
  const order = [];
  await Promise.all([off.run('a', 'test.busy', { ms: 200 }).then(() => order.push(1)), off.run('a', 'test.busy', { ms: 1 }).then(() => order.push(2))]);
  check(order.join() === '1,2', 'one lane runs one task at a time, in order', order);

  // Failures.
  let e = await failed(off.run('a', 'test.throw'));
  check(e && e.name === 'RangeError' && e.message === 'thrown in the task', 'a task error reaches the caller by name', e && e.message);
  e = await failed(off.run('a', 'test.nosuch'));
  check(e && /no such off-thread task/.test(e.message), 'an unknown task is refused');
  const queued = off.run('a', 'test.where');
  const died = await failed(off.run('a', 'test.die'));
  await queued;
  check(died && /exited with code 7/.test(died.message), 'a dead worker rejects its task', died && died.message);
  check((await off.run('a', 'test.where')) > 0, 'and the next task gets a new worker');
  const t1 = Date.now();
  const after = off.run('a', 'test.where');
  e = await failed(off.run('b', 'test.hang'));
  check(e && /took longer than 3 s/.test(e.message) && Date.now() - t1 < 4500, 'a hung task times out', e && e.message);
  await after;
  check((await off.run('b', 'test.where')) > 0, 'and its lane works again');

  // RELAYMOTE_OFF_THREAD=0.
  process.env.RELAYMOTE_OFF_THREAD = '0';
  check((await off.run('a', 'test.where')) === threadId, 'RELAYMOTE_OFF_THREAD=0 runs it here');
  delete process.env.RELAYMOTE_OFF_THREAD;

  // The real tasks, from a worker.
  const t = path.join(dir, 't.jsonl');
  const launch = (id) => JSON.stringify({ timestamp: new Date().toISOString(), message: { content: [{ type: 'tool_use', id, name: 'Agent', input: { run_in_background: true, description: 'x' } }] } }) + '\n';
  fs.writeFileSync(t, launch('toolu_a'));
  let bg = await off.run('fast', 'bg.scan', { file: t });
  check(bg.length === 1 && bg[0].id === 'toolu_a', 'bg.scan reads a transcript', bg.length);
  fs.appendFileSync(t, launch('toolu_b'));
  bg = await off.run('fast', 'bg.scan', { file: t });
  check(bg.map(x => x.id).join() === 'toolu_a,toolu_b', 'and keeps its place between calls', bg.length);

  // backgroundTasksSoon: the list, and at most its wait, however long the scan takes.
  const sessions = require('../mobile/sessions');
  const cwd = path.join(dir, 'proj'), cli = '11111111-2222-3333-4444-555555555555';
  const slug = cwd.replace(/[^A-Za-z0-9]/g, '-');
  fs.mkdirSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', slug), { recursive: true });
  fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', slug, cli + '.jsonl'), launch('toolu_c'));
  const soon = await sessions.backgroundTasksSoon({ cwd, cliSessionId: cli });
  check(soon.length === 1 && soon[0].id === 'toolu_c', 'backgroundTasksSoon answers from the worker', soon.length);
  const held = off.run('fast', 'test.busy', { ms: 2500 });
  const t2 = Date.now();
  const waited = await sessions.backgroundTasksSoon({ cwd, cliSessionId: cli });
  check(Date.now() - t2 < 2200 && waited.length === 1, 'a busy worker: the phone waits ~1.5 s and gets the last list', Date.now() - t2);
  await held;

  const ix = await off.run('slow', 'index.build', { transcripts: false, digests: false });
  check(ix && ix.builtAt && fs.existsSync(require('../lib/projects').INDEX_JSON), 'index.build writes the index and hands it back', ix && ix.builtAt);
  const P = require('../lib/projects');
  check(P.adopt(ix), 'the main thread adopts the index the worker built');
  let reads = 0; const rf = fs.readFileSync;
  fs.readFileSync = function (f, ...x) { if (f === P.INDEX_JSON) reads++; return rf.call(fs, f, ...x); };
  const got = P.read(); fs.readFileSync = rf;
  check(reads === 0 && got === ix, 'and read() returns it without reading index.json', reads);
  check(JSON.stringify(got) === JSON.stringify(JSON.parse(rf.call(fs, P.INDEX_JSON, 'utf8'))), 'it is what the file holds');
  const later = new Date(Date.now() + 5000); fs.utimesSync(P.INDEX_JSON, later, later);
  reads = 0; fs.readFileSync = function (f, ...x) { if (f === P.INDEX_JSON) reads++; return rf.call(fs, f, ...x); };
  P.read(); fs.readFileSync = rf;
  check(reads === 1, 'a later write by anyone else is read again', reads);
  const hy = await off.run('slow', 'hygiene.cycle');
  check(hy && (hy.ok || hy.skipped || hy.error), 'hygiene.cycle answers', Object.keys(hy || {}).slice(0, 4));
  const bd = await off.run('slow', 'board.build');
  check(bd && typeof bd.written === 'boolean' && bd.board === undefined, 'board.build reports its outcome and not the board', bd);

  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
