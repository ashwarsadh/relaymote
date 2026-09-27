// summaries.js — the model engine (lib/engine.js), session overviews (lib/summarize.js) and the roles DB
// (lib/roles.js), against a stub OpenAI-compatible server, a fake `claude` CLI and a stub Relaymote daemon.
// Never calls a real model, never touches real data: APPDATA / CLAUDE_CONFIG_DIR / BATON_HOME point into a
// temp folder and the "daemon" is a stub on a random port.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-summaries-'));
process.env.APPDATA = path.join(TMP, 'appdata');
process.env.CLAUDE_CONFIG_DIR = path.join(TMP, 'claude');
process.env.BATON_HOME = path.join(TMP, 'baton');
delete process.env.BATON_STATE_DIR;
delete process.env.BATON_ROLES_JSON;
delete process.env.BATON_CLAUDE_BIN;

let failed = 0;
const check = (ok, name, extra) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const listen = srv => new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const readBody = req => new Promise(r => { let b = ''; req.on('data', d => { b += d; }); req.on('end', () => r(b)); });

// ------------------------------------------------------------------ stub OpenAI-compatible server
const ai = { mode: 'ok', delayMs: 0, requests: 0, auth: [], roleReplies: {} };
const OVERVIEW = { goal: 'ship the thing', done: 'wrote the parser', in_progress: 'tests', blocked_on: 'none', last_ask: 'none' };
const aiServer = http.createServer(async (req, res) => {
  const body = await readBody(req);
  if (req.method === 'GET' && req.url.endsWith('/models')) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"data":[]}'); }
  ai.requests++;
  ai.auth.push(req.headers.authorization || null);
  let j = {}; try { j = JSON.parse(body); } catch {}
  const sys = ((j.messages || [])[0] || {}).content || '', user = ((j.messages || [])[1] || {}).content || '';
  let content = JSON.stringify(OVERVIEW), model = j.model;
  if (/Classify the ROLE/.test(sys)) {
    const sid = (/^SESSION (\S+)/m.exec(user) || [])[1];
    content = JSON.stringify(ai.roleReplies[sid] || { role: 'generic', owns_topics: ['generic'], owns_files: [], owns_goals: [], not_owns: [], is_master: false, evidence: ['L1'] });
  }
  if (ai.mode === 'empty') content = '';
  if (ai.mode === 'invalid') content = '{"goal":"only one key"}';
  if (ai.mode === 'refuse') content = "I'm sorry, I can't help with that.";
  if (ai.mode === 'swap') model = 'other-model-9';
  if (ai.delayMs) await sleep(ai.delayMs);
  try { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ model, choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } })); } catch {}
});

// ------------------------------------------------------------------ stub Relaymote daemon (/api/health, /api/task)
const daemon = { healthDelay: 0, posts: [] };
const daemonServer = http.createServer(async (req, res) => {
  const body = await readBody(req);
  const send = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (req.url.startsWith('/api/health')) { if (daemon.healthDelay) await sleep(daemon.healthDelay); return send({ ok: true, app: 'baton' }); }
  if (req.method === 'POST' && req.url === '/api/task') {
    const b = JSON.parse(body); daemon.posts.push(b);
    const reg = require('../lib/registry');
    const t = reg.createTask({ title: b.title, prompt: b.prompt, tags: b.tags, model: b.model, maxAttempts: b.maxAttempts, dispatch: b.dispatch });
    const rf = path.join(TMP, 'result-' + t.id + '.json');
    fs.writeFileSync(rf, JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-haiku-4-5-20251001' }) + '\n' +
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(OVERVIEW), modelUsage: { 'claude-haiku-4-5-20251001': { outputTokens: 5 } } }) + '\n');
    setTimeout(() => reg.updateTask(t.id, { status: 'done', result: JSON.stringify(OVERVIEW), costUsd: 0.002, resultFile: rf, endedAt: new Date().toISOString() }), 200);
    return send({ ok: true, task: t });
  }
  if (req.method === 'POST' && /\/stop/.test(req.url)) return send({ ok: true });
  res.writeHead(404); res.end('{}');
});

// ------------------------------------------------------------------ fake claude CLI
const FAKE = path.join(TMP, 'fake-claude.js');
const FAKE_LOG = path.join(TMP, 'fake-claude.log');
fs.writeFileSync(FAKE, `
let inp = ''; process.stdin.on('data', d => { inp += d; });
process.stdin.on('end', () => {
  const mode = process.env.FAKE_CLAUDE_MODE || 'ok', args = process.argv.slice(2), model = args[args.indexOf('--model') + 1];
  require('fs').writeFileSync(${JSON.stringify(FAKE_LOG)}, JSON.stringify({ args, hasKey: !!process.env.ANTHROPIC_API_KEY, inputLen: inp.length }));
  const served = mode === 'swap' ? 'claude-sonnet-9-9' : 'claude-' + model + '-4-5-20251001';
  const role = { role: 'fallback role', owns_topics: ['fallback topic'], owns_files: [], owns_goals: [], not_owns: [], is_master: false, evidence: ['L1'] };
  const result = mode === 'empty' ? '' : mode === 'auth' ? 'OAuth token has expired. Please run /login' : /Classify the ROLE/.test(inp) ? JSON.stringify(role) : ${JSON.stringify(JSON.stringify(OVERVIEW))};
  process.stdout.write(JSON.stringify({ type: 'result', subtype: mode === 'auth' ? 'error_during_execution' : 'success', is_error: mode === 'auth', result, total_cost_usd: 0.001,
    usage: { input_tokens: 10, output_tokens: 5 }, modelUsage: { [served]: { outputTokens: 5 } } }));
});`);

(async () => {
  const aiPort = await listen(aiServer);
  const dPort = await listen(daemonServer);
  process.env.BATON_PORT = String(dPort);
  const config = require('../lib/config');
  const E = require('../lib/engine');
  const S = require('../lib/summarize');
  const R = require('../lib/roles');
  const D = require('../lib/digests');
  const P = require('../lib/projects');
  const owner = require('../lib/owner');
  const BASE = `http://127.0.0.1:${aiPort}/v1`;
  const SCHEMA = S.SCHEMA;
  const setEngine = (e) => config.set({ engine: e });

  // ---------------------------------------------------------------- engine: defaults and guards
  check(config.get().engine.kind === 'none' && config.get().modules.summaries === false && config.get().modules.roles === true, 'defaults: engine none, summaries off, roles on (heuristic)');
  let r = await E.run({ prompt: 'x', input: 'y' });
  check(!r.ok && r.code === 'ENGINE_OFF', 'engine none: nothing is sent', r.code);
  check(!(await E.probe()).ok, 'engine none: probe says no');
  setEngine({ kind: 'openai', model: 'm-small', openai: { baseUrl: BASE, apiKey: 'sk-in-clear' } });
  r = await E.run({ prompt: 'x', input: 'y' });
  check(!r.ok && r.code === 'KEY_IN_SETTINGS' && ai.requests === 0, 'a key stored in settings.json is refused, not used', r.code);
  setEngine({ openai: { apiKey: '', apiKeyEnv: 'BATON_TEST_LLM_KEY' } });
  delete process.env.BATON_TEST_LLM_KEY;
  r = await E.run({ prompt: 'x', input: 'y' });
  check(!r.ok && r.code === 'NO_API_KEY' && ai.requests === 0, 'apiKeyEnv names an unset variable: refused before sending', r.code);
  process.env.BATON_TEST_LLM_KEY = 'sk-from-env';

  // ---------------------------------------------------------------- engine: openai
  r = await E.run({ prompt: 'Summarise', input: 'hello', schema: SCHEMA });
  check(r.ok && r.json && r.json.goal === OVERVIEW.goal && r.served === 'm-small' && ai.auth.pop() === 'Bearer sk-from-env', 'openai: success, strict JSON, served model reported, key from env', r.code);
  ai.mode = 'empty';
  r = await E.run({ prompt: 'Summarise', input: 'hello', schema: SCHEMA });
  check(!r.ok && r.code === 'EMPTY', 'openai: empty answer = failure', r.code);
  r = await E.run({ prompt: 'Summarise', input: 'hello' });
  check(!r.ok && r.code === 'EMPTY', 'openai: empty answer = failure (text mode too)', r.code);
  ai.mode = 'invalid';
  r = await E.run({ prompt: 'Summarise', input: 'hello', schema: SCHEMA });
  check(!r.ok && r.code === 'SCHEMA_INVALID', 'openai: schema-invalid JSON = failure', r.code + ' ' + r.error);
  ai.mode = 'refuse';
  r = await E.run({ prompt: 'Summarise', input: 'hello' });
  check(!r.ok && r.code === 'REFUSED', 'openai: a refusal = failure', r.code);
  ai.mode = 'swap';
  r = await E.run({ prompt: 'Summarise', input: 'hello', schema: SCHEMA });
  check(r.ok && r.served === 'other-model-9', 'openai: substitution reported when requireModel is off', r.served);
  setEngine({ requireModel: true });
  r = await E.run({ prompt: 'Summarise', input: 'hello', schema: SCHEMA });
  check(!r.ok && r.code === 'MODEL_SUBSTITUTED', 'openai: served-model mismatch refused with requireModel', r.code);
  ai.mode = 'ok';
  r = await E.run({ prompt: 'Summarise', input: 'hello', schema: SCHEMA });
  check(r.ok, 'openai: matching model passes requireModel', r.code);
  setEngine({ requireModel: false });
  check(E.modelMatches('haiku', 'claude-haiku-4-5-20251001') && E.modelMatches('gpt-4o', 'gpt-4o-2024-08-06') && !E.modelMatches('gpt-4o', 'gemini-2.5-flash') && !E.modelMatches('haiku', 'claude-sonnet-4'), 'modelMatches: alias and dated ids, rejects others');
  check(E.validate({ type: 'object', additionalProperties: false, required: ['a'], properties: { a: { type: 'string' } } }, { a: 'x', b: 1 }).length === 1, 'validate: additionalProperties:false fires');

  // ---------------------------------------------------------------- engine: claude-cli (fake binary)
  process.env.ANTHROPIC_API_KEY = 'sk-must-not-reach-the-cli';
  setEngine({ kind: 'claude-cli', model: '', claudeCli: { bin: FAKE } });
  r = await E.run({ prompt: 'Summarise', input: 'hello', schema: SCHEMA });
  const fl = JSON.parse(fs.readFileSync(FAKE_LOG, 'utf8'));
  check(r.ok && /haiku/.test(r.served) && r.costUsd === 0.001, 'claude-cli: success, default model haiku, served model from modelUsage', r.code + ' ' + r.served);
  check(fl.args.includes('--no-session-persistence') && fl.args.includes('--strict-mcp-config') && fl.args[fl.args.indexOf('--tools') + 1] === '' && !fl.args.includes('--bare') && fl.inputLen > 0,
    'claude-cli: headless, no tools, no MCP, no session file, never --bare, prompt on stdin');
  check(fl.hasKey === false, 'claude-cli: ANTHROPIC_API_KEY stripped — runs on the plan, never a silently billed key');
  delete process.env.ANTHROPIC_API_KEY;
  process.env.FAKE_CLAUDE_MODE = 'empty';
  r = await E.run({ prompt: 'Summarise', input: 'hello', schema: SCHEMA });
  check(!r.ok && r.code === 'EMPTY', 'claude-cli: empty answer = failure', r.code);
  process.env.FAKE_CLAUDE_MODE = 'swap';
  setEngine({ requireModel: true });
  r = await E.run({ prompt: 'Summarise', input: 'hello', schema: SCHEMA });
  check(!r.ok && r.code === 'MODEL_SUBSTITUTED', 'claude-cli: served-model mismatch refused', r.code + ' ' + r.served);
  setEngine({ requireModel: false });
  delete process.env.FAKE_CLAUDE_MODE;
  setEngine({ claudeCli: { bin: path.join(TMP, 'no-such-claude.exe') } });
  r = await E.run({ prompt: 'x', input: 'y' });
  check(!r.ok && E.ROUTE_CODES.has(r.code), 'claude-cli: a missing binary is a route failure', r.code);

  // ---------------------------------------------------------------- engine: baton-worker (stub daemon)
  setEngine({ kind: 'baton-worker', model: '' });
  r = await E.run({ prompt: 'Summarise', input: 'hello', schema: SCHEMA, title: 't' });
  const post = daemon.posts[daemon.posts.length - 1] || {};
  check(r.ok && r.served === 'claude-haiku-4-5-20251001' && r.costUsd === 0.002, 'baton-worker: success, served model read from the worker result', r.code);
  check(post.dispatch === 'headless' && post.noReuse === true && post.maxAttempts === 1 && (post.tags || []).includes(E.TAG) && post.model === 'haiku', 'baton-worker: headless, no reuse, one attempt, tagged');
  daemon.healthDelay = 1300;
  r = await E.run({ prompt: 'Summarise', input: 'hello', schema: SCHEMA });
  const pr0 = await E.probe();
  check(!r.ok && r.code === 'ROUTE_BUSY' && !pr0.ok, 'baton-worker: a slow daemon (/api/health > 1 s) gets nothing', r.code);
  daemon.healthDelay = 0;
  const reg = require('../lib/registry');
  for (let i = 0; i < 8; i++) { const t = reg.createTask({ title: 'ENGINE: x', tags: [E.TAG] }); reg.updateTask(t.id, { status: 'failed', error: 'spawn failed', endedAt: new Date().toISOString() }); }
  const pr1 = await E.probe();
  check(!pr1.ok && pr1.code === 'ROUTE_DOWN', 'baton-worker: 8 recent workers that never reached the model = route down', pr1.reason);

  // ---------------------------------------------------------------- route history for the other engines
  setEngine({ kind: 'openai', model: 'm-small', openai: { baseUrl: BASE, apiKeyEnv: 'BATON_TEST_LLM_KEY' } });
  const H = path.join(config.STATE, 'engine-history.json');
  const hist = at => ({ calls: Array.from({ length: 8 }, () => ({ at, kind: 'openai', ok: false, code: 'UNREACHABLE', route: true })) });
  fs.writeFileSync(H, JSON.stringify(hist(new Date().toISOString())));
  check((await E.probe()).code === 'ROUTE_DOWN', 'openai: 8 recent route failures = route down, even with the server up');
  fs.writeFileSync(H, JSON.stringify(hist(new Date(Date.now() - 7 * 3600000).toISOString())));
  const pc = await E.probe();
  check(pc.ok && /canary/.test(pc.reason), 'route down for 6 h+: one canary call allowed', pc.reason);
  fs.writeFileSync(H, '{"calls":[]}');

  // ---------------------------------------------------------------- summaries
  const now = Date.now(), iso = ms => new Date(ms).toISOString();
  const sess = (id, o = {}) => ({ id, cli: id.slice(-8), title: 'Session ' + id, project: 'alpha', group: 'Alpha', in_sidebar: true, archived: false,
    has_transcript: true, age_days: 1, last: iso(now - 3600000), bytes: 5000, tags: [], prompts: [], ...o });
  const writeDigest = (sid, n, word, append) => {
    let t = append ? '' : `# ${sid}\nsession: ${sid}\n\n`;
    for (let i = 0; i < n; i++) t += `## 2026-09-20 10:${String(i % 60).padStart(2, '0')} USER\nplease work on ${word} step ${i} ${'x'.repeat(40)}\n\n## 2026-09-20 10:${String(i % 60).padStart(2, '0')} ASSISTANT\ndone ${word} step ${i}\n\n`;
    fs.mkdirSync(path.dirname(D.digestPath(sid)), { recursive: true });
    if (append) fs.appendFileSync(D.digestPath(sid), t); else fs.writeFileSync(D.digestPath(sid), t);
  };
  const ix = { sessions: {} };
  for (const [id, o] of [['local_a', { last: iso(now - 1000) }], ['local_b', {}], ['local_c', { archived: true }], ['local_d', { age_days: 30 }], ['local_e', { in_sidebar: false }]]) {
    ix.sessions[id] = sess(id, o); writeDigest(id, 6, 'feature-' + id);
  }
  ai.requests = 0;
  let run = await S.run({ index: ix, cap: 5, budgetMin: 5 });
  check(run.done === 2 && run.failed === 0 && ai.requests === 2, 'summaries: live sessions only (archived, stale, headless skipped)', JSON.stringify({ done: run.done, req: ai.requests }));
  const all = JSON.parse(fs.readFileSync(S.ALL(), 'utf8'));
  check(all.n === 2 && all.sessions.local_a.summary.goal === OVERVIEW.goal && all.sessions.local_a.doffset > 0, 'summaries: consolidated store with digest offsets');
  check(fs.existsSync(S.LAST_RUN()) && JSON.parse(fs.readFileSync(S.LAST_RUN(), 'utf8')).done === 2, 'summaries: last-run log');
  run = await S.run({ index: ix, cap: 5 });
  check(run.picked === 0 && ai.requests === 2, 'summaries: nothing grew = nothing sent');
  writeDigest('local_a', 1, 'tiny', true);
  check(S.pick(ix, {}).picks.length === 0, 'summaries: growth under 400 B is not worth a call');
  writeDigest('local_a', 6, 'more-work', true);
  const p1 = S.pick(ix, {}).picks;
  const inp = S.buildInput(p1[0].s, p1[0].prev);
  check(p1.length === 1 && /PREVIOUS OVERVIEW/.test(inp.text) && !/feature-local_a step 0/.test(inp.text) && /more-work/.test(inp.text), 'summaries: incremental — previous overview + the digest delta only');
  writeDigest('local_big', 200, 'bulk');
  const bi = S.buildInput({ ...sess('local_big') }, null);
  check(/turns omitted/.test(bi.text) && bi.text.length < 24000, 'summaries: first 10 / last 60 turn blocks, 22k cap', String(bi.text.length));
  const ix2 = { sessions: JSON.parse(JSON.stringify(ix.sessions)) };
  check(S.attach(ix2) === 2 && /ship the thing/.test(ix2.sessions.local_a.summary) && ix2.sessions.local_a.overview.in_progress === 'tests', 'summaries: attached to the index as s.summary / s.overview');

  // failure -> cool-off, doubling
  ai.mode = 'invalid';
  run = await S.run({ index: ix, cap: 5 });
  const fails = S.loadFailures();
  check(run.failed === 1 && fails.local_a && fails.local_a.n === 1, 'summaries: schema-invalid answer recorded as a failure');
  ai.mode = 'ok';
  const before = ai.requests;
  run = await S.run({ index: ix, cap: 5 });
  check(run.picked === 0 && run.cooling_off === 1 && ai.requests === before, 'summaries: a failed session cools off instead of retrying');
  check(S.cooloffHours({ n: 1 }) === 6 && S.cooloffHours({ n: 2 }) === 12 && S.cooloffHours({ n: 3 }) === 24 && S.cooloffHours({ n: 9 }) === 168, 'cool-off: 6 h doubling, capped at a week');
  const at = h => new Date(now - h * 3600000).toISOString();
  check(!S.inCooloff('x', { x: { n: 1, at: at(7) } }, now) && S.inCooloff('x', { x: { n: 2, at: at(7) } }, now) && !S.inCooloff('x', { x: { n: 2, at: at(13) } }, now) && S.inCooloff('x', { x: { n: 20, at: at(160) } }, now),
    'cool-off: 7 h after 1 failure = eligible, after 2 = not; capped at 168 h');
  fs.writeFileSync(S.FAILURES(), JSON.stringify({ local_a: { n: 1, at: at(7), error: 'x' } }));
  run = await S.run({ index: ix, cap: 5 });
  check(run.done === 1 && !S.loadFailures().local_a, 'summaries: after the cool-off it runs, and a success clears the failure');

  // budget stop
  writeDigest('local_a', 6, 'budget-a', true); writeDigest('local_b', 6, 'budget-b', true);
  ai.delayMs = 5000; const b0 = ai.requests;
  const tb = Date.now();
  run = await S.run({ index: ix, cap: 5, budgetMin: 0.05 });
  check(run.budget_hit === true && run.done === 0 && ai.requests - b0 === 1 && run.skipped === 1 && Date.now() - tb < 5000, 'summaries: time budget stops the pass (call cut, rest not sent)', JSON.stringify({ hit: run.budget_hit, req: ai.requests - b0, ms: Date.now() - tb }));
  ai.delayMs = 0;
  fs.writeFileSync(S.FAILURES(), '{}');

  // route unavailable
  setEngine({ openai: { baseUrl: 'http://127.0.0.1:9/v1' } });
  const r0 = ai.requests;
  run = await S.run({ index: ix, cap: 5 });
  check(/route unavailable/.test(run.error || '') && run.done === 0 && ai.requests === r0, 'summaries: dead route = stop and report "route unavailable", nothing spent', run.error);
  setEngine({ openai: { baseUrl: BASE } });

  // lock
  fs.writeFileSync(path.join(S.DIR(), '.lock'), 'x');
  run = await S.run({ index: ix, cap: 5 });
  check(run.skipped === 'locked', 'summaries: one pass at a time (lock file)');
  fs.unlinkSync(path.join(S.DIR(), '.lock'));

  // ---------------------------------------------------------------- roles: heuristic (engine none)
  setEngine({ kind: 'none' });
  const rix = { sessions: {} };
  const mk = (id, title, o) => { rix.sessions[id] = sess(id, { title, project: 'imgsvc', group: 'Images', ...o }); };
  mk('local_x', 'Thumbnail cache prototype', { tags: ['thumbnail', 'cache', 'prototype'], first_prompt: 'build thumbnail cache eviction' });
  mk('local_y', 'Misc fixes', { tags: ['misc'] });
  mk('local_z1', 'Upload api', { tags: ['upload'] });
  mk('local_z2', 'Docs site', { tags: ['docs'] });
  mk('local_z3', 'Release notes', { tags: ['release'] });
  mk('local_old', 'Old thing', { age_days: 90 });
  const r1 = await R.build({ index: rix });
  const db1 = R.loadDb();
  check(r1.heuristic === 5 && db1.sessions.local_x.engine === 'heuristic' && db1.sessions.local_x.owns_topics.includes('imgsvc') && db1.sessions.local_x.owns_topics.includes('thumbnail') && !db1.sessions.local_old,
    'roles: engine none = free heuristic (title + tags + project), live sessions only');
  check(R.DB() === path.join(config.DATA, 'conductor', 'roles.json') && Object.keys(owner.readRoles()).length === 5, 'owner.js reads Relaymote\'s own roles.json by default');
  fs.writeFileSync(R.LOCK(), 'x');
  check((await R.build({ index: rix })).skipped === 'locked', 'roles: one builder at a time (lock file)');
  fs.unlinkSync(R.LOCK());

  // ---------------------------------------------------------------- owner routing with and without roles
  fs.mkdirSync(P.DIR, { recursive: true });
  fs.writeFileSync(P.INDEX_JSON, JSON.stringify({ sessions: rix.sessions, projects: {} }));
  fs.unlinkSync(R.DB());
  const topic = 'thumbnail cache eviction is broken';
  const before1 = owner.resolve(topic);
  check(before1.ok && before1.owner === 'local_x', 'routing without roles: the title decides (the stale "Thumbnail cache prototype")', JSON.stringify({ o: before1.owner, s: before1.score }));
  ai.roleReplies = {
    local_x: { role: 'upload API endpoints', owns_topics: ['upload api'], owns_files: [], owns_goals: [], not_owns: ['thumbnail cache'], is_master: false, evidence: ['L1'] },
    local_y: { role: 'thumbnail cache maintenance', owns_topics: ['thumbnail cache eviction'], owns_files: [], owns_goals: [], not_owns: [], is_master: false, evidence: ['[L2]', 'L99'] },
  };
  setEngine({ kind: 'openai', model: 'm-small', openai: { baseUrl: BASE } });
  writeDigest('local_y', 3, 'thumbnail cache eviction');
  const q0 = ai.requests;
  const r2 = await R.build({ index: rix });
  const db2 = R.loadDb();
  check(r2.classified === 5 && ai.requests - q0 === 5 && db2.sessions.local_y.engine === 'openai' && db2.sessions.local_x.not_owns[0] === 'thumbnail cache', 'roles: engine classifies each live session (schema-validated)');
  check(db2.sessions.local_y.evidence.length === 1 && /^\[L2\]/.test(db2.sessions.local_y.evidence[0]), 'roles: evidence keeps cited lines it was shown, drops invented ones');
  const after1 = owner.resolve(topic);
  check(after1.ok && after1.owner === 'local_y', 'routing WITH roles: the drifted owner wins, the "does NOT own" session loses', JSON.stringify({ o: after1.owner, s: after1.score, why: after1.why }));
  const q1 = ai.requests;
  const r3 = await R.build({ index: rix });
  check(r3.classified === 0 && ai.requests === q1, 'roles: incremental — unchanged transcripts cost nothing');
  rix.sessions.local_y.bytes = 9999;
  ai.mode = 'invalid';
  const r4 = await R.build({ index: rix });
  const db4 = R.loadDb();
  check(r4.failed === 1 && db4.pending.local_y && db4.sessions.local_y.engine === 'openai' && db4.sessions.local_y.stale === true, 'roles: schema-invalid = failure; pending recorded, the older engine record kept (flagged stale)');
  ai.mode = 'ok';
  const r5 = await R.build({ index: rix, budget: 0 });
  check(r5.classified === 0 && r5.stopped === 'budget', 'roles: per-run budget respected');

  // fallback engine: primary answers junk, the fallback (fake claude CLI) classifies; a dead login parks the rest
  mk('local_f1', 'Fresh one', {}); mk('local_f2', 'Fresh two', {}); mk('local_f3', 'Fresh three', {});
  ai.mode = 'invalid';
  config.set({ engine: { fallbackKind: 'claude-cli', fallbackModel: 'haiku', claudeCli: { bin: FAKE } }, roles: { fallbackCap: 12 } });
  const r6 = await R.build({ index: rix, budget: 1 });
  check(r6.classified === 1 && r6.fallback_used === 1 && R.loadDb().sessions[Object.keys(rix.sessions).find(k => R.loadDb().sessions[k] && R.loadDb().sessions[k].engine === 'claude-cli')], 'roles: a failed classification retries once on the fallback engine', JSON.stringify(r6));
  process.env.FAKE_CLAUDE_MODE = 'auth';
  const r7 = await R.build({ index: rix, budget: 5 });
  const db7 = R.loadDb();
  check(r7.fallback_used === 1 && r7.failed >= 2 && Object.values(db7.pending).some(p => /AUTH/.test(p.why)) && ['local_f1', 'local_f2', 'local_f3'].every(k => db7.sessions[k]),
    'roles: a dead fallback login stops further fallback calls; failed sessions get a heuristic record + pending', JSON.stringify({ fb: r7.fallback_used, failed: r7.failed }));
  delete process.env.FAKE_CLAUDE_MODE;
  ai.mode = 'ok';
  config.set({ engine: { fallbackKind: 'none' } });

  // ---------------------------------------------------------------- daemon cycle + build options
  config.set({ modules: { summaries: false }, engine: { kind: 'none' } });
  check(JSON.stringify(S.buildOpts()) === '{}', 'buildOpts: no digests forced when nothing will read them');
  config.set({ modules: { summaries: true } });
  check(S.buildOpts().digests === true, 'buildOpts: digests built when overviews are on');
  fs.writeFileSync(P.INDEX_JSON, JSON.stringify({ sessions: rix.sessions, projects: {} }));
  const cyc = await S.cycle({ force: true });
  check(/engine off/.test((cyc.summaries || {}).skipped || '') && cyc.roles && cyc.roles.engine === 'none', 'cycle: summaries skip without an engine, roles still run (heuristic)', JSON.stringify(cyc).slice(0, 200));

  aiServer.close(); daemonServer.close();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  console.log(failed ? `\n${failed} FAILED` : '\nall summaries/engine/roles checks passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
