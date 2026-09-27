// engine.js — the ONE place Relaymote asks a language model for text (session overviews, the roles DB).
//
// OFF by default. settings.engine.kind picks the backend:
//   none          nothing is ever called (the default). Callers fall back to free heuristics.
//   openai        any OpenAI-compatible server: engine.openai.baseUrl + engine.model. The API key is read
//                 from the ENVIRONMENT VARIABLE named in engine.openai.apiKeyEnv — never from
//                 settings.json; a key found in settings is refused, not used.
//   claude-cli    `claude -p --model <engine.model>` headless, no tools, no MCP servers, no session
//                 file. Runs on YOUR Claude plan (ANTHROPIC_API_KEY is removed from its environment so
//                 it cannot silently bill an API key). Never `--bare`: that forces API-key billing.
//   baton-worker  Relaymote's own headless worker queue (POST /api/task on the daemon). Also YOUR plan.
//
// Every call is text in, text out (optionally strict JSON checked against a JSON Schema). A call
// refuses rather than lies:
//   * an empty answer, a refusal or a provider notice is a FAILURE, never a result;
//   * a reply that is not valid JSON for the schema is a FAILURE;
//   * the model that ACTUALLY served is reported, and with engine.requireModel a substitution — or a
//     server that will not say what served — is a FAILURE.
// Calls run one at a time (a burst of workers is what once saturated a daemon), each under a timeout
// that never outlives the caller's budget. Before a batch, probe() checks the route is healthy AND that
// it has recently worked (history of the last calls), so a broken route stops the batch instead of
// burning it.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const config = require('./config');

const KINDS = ['none', 'openai', 'claude-cli', 'baton-worker'];
const USES_CLAUDE_PLAN = new Set(['claude-cli', 'baton-worker']);
const DEFAULT_MODEL = { 'claude-cli': 'haiku', 'baton-worker': 'haiku' };
const ROUTE_SAMPLE = 8;              // most recent calls consulted to judge whether the route works
const CANARY_AFTER_H = 6;            // a route judged down is allowed ONE canary call after this long
const HEALTH_BUDGET_MS = 1000;       // baton-worker: a daemon slower than this is already busy
const HISTORY_KEEP = 40;
const TAG = 'baton-engine';
// failures meaning the model never produced output: these, and only these, judge the ROUTE
const ROUTE_CODES = new Set(['LAUNCH_FAILED', 'UNREACHABLE', 'HTTP_ERROR', 'AUTH', 'NO_API_KEY', 'TIMEOUT', 'ROUTE_BUSY']);
const MODEL_RX = /^[A-Za-z0-9._:\[\]\/-]{1,120}$/;

const HISTORY = () => path.join(config.STATE, 'engine-history.json');
const WORK = () => path.join(config.DATA, 'conductor', 'engine-work');

const DEFAULT_REFUSALS = [
  /^\s*(i'?m sorry|i am sorry|sorry,? (but )?i (can'?t|cannot)|i (can'?t|cannot|won'?t|am unable to) (help|assist|comply|do that|provide)|as an ai\b)/i,
];
// provider notices returned as an ordinary 200 answer; only judged on SHORT texts
const NOTICE_RX = [
  /\b(model|endpoint|deployment)\b.{0,60}\b(deprecated|retired|no longer (available|supported)|not found|does not exist|decommissioned)\b/i,
  /\b(rate.?limit(ed)?|quota exceeded|insufficient (credits?|balance|quota)|billing)\b/i,
  /\b(please (log ?in|sign ?in)|not logged in|authenticat(e|ion) (failed|required))\b/i,
];

// ------------------------------------------------------------------------------------------ config
/** The effective engine settings, with per-kind defaults applied. `over` overrides (fallback engine, tests). */
function effective(over) {
  const e = { ...(config.get().engine || {}), ...(over || {}) };
  const openai = { ...((config.get().engine || {}).openai || {}), ...((over || {}).openai || {}) };
  const cli = { ...((config.get().engine || {}).claudeCli || {}), ...((over || {}).claudeCli || {}) };
  const kind = String(e.kind || 'none');
  const out = {
    kind, model: String(e.model || DEFAULT_MODEL[kind] || '').trim(), requireModel: !!e.requireModel,
    timeoutSec: Math.max(5, Number(e.timeoutSec) || 180), openai, claudeCli: cli,
    refusalPatterns: Array.isArray(e.refusalPatterns) ? e.refusalPatterns : [],
    usesClaudePlan: USES_CLAUDE_PLAN.has(kind),
  };
  if (!KINDS.includes(kind)) { out.code = 'BAD_KIND'; out.error = `engine.kind "${kind}" is not one of ${KINDS.join(' | ')}`; }
  // A key typed into settings.json would sit there in clear text: refuse to use it, and say where it goes.
  const raw = config.get().engine || {};
  if (raw.apiKey || (raw.openai && (raw.openai.apiKey || raw.openai.key))) {
    out.code = 'KEY_IN_SETTINGS';
    out.error = 'an API key is stored in settings.json (engine.apiKey / engine.openai.apiKey). Relaymote will not use a key kept in clear: remove it, put the key in an environment variable and name that variable in engine.openai.apiKeyEnv.';
  }
  if (out.model && !MODEL_RX.test(out.model)) { out.code = 'BAD_MODEL'; out.error = `engine.model "${out.model}" has characters a model id never has`; }
  return out;
}

function describe(over) {
  const c = effective(over);
  return { kind: c.kind, model: c.model || null, requireModel: c.requireModel, timeoutSec: c.timeoutSec,
    usesClaudePlan: c.usesClaudePlan, on: c.kind !== 'none' && !c.code, error: c.error || undefined,
    note: c.kind === 'none' ? 'engine off: nothing is ever sent to a model'
      : c.usesClaudePlan ? 'runs on your own Claude plan (counts toward your usage limits)'
      : 'OpenAI-compatible server at ' + (c.openai.baseUrl || '(baseUrl not set)') + (c.openai.apiKeyEnv ? ', key from $' + c.openai.apiKeyEnv : ', no key') };
}

// ------------------------------------------------------------------------------------------ checks
/** Minimal JSON-Schema check: type, required, properties, additionalProperties:false, items, enum, maxLength, min/maxItems. Returns error strings. */
function validate(schema, v, at = '$') {
  const errs = [];
  if (!schema || typeof schema !== 'object') return errs;
  const t = schema.type;
  const typeOk = (ty) => ty === 'array' ? Array.isArray(v) : ty === 'object' ? (v && typeof v === 'object' && !Array.isArray(v))
    : ty === 'integer' ? Number.isInteger(v) : ty === 'null' ? v === null : typeof v === ty;
  if (t && !(Array.isArray(t) ? t.some(typeOk) : typeOk(t))) { errs.push(`${at}: expected ${[].concat(t).join('|')}`); return errs; }
  if (schema.enum && !schema.enum.some(x => JSON.stringify(x) === JSON.stringify(v))) errs.push(`${at}: not one of the allowed values`);
  if (typeof v === 'string' && schema.maxLength != null && v.length > schema.maxLength) errs.push(`${at}: longer than ${schema.maxLength}`);
  if (typeof v === 'string' && schema.minLength != null && v.length < schema.minLength) errs.push(`${at}: shorter than ${schema.minLength}`);
  if (Array.isArray(v)) {
    if (schema.minItems != null && v.length < schema.minItems) errs.push(`${at}: fewer than ${schema.minItems} items`);
    if (schema.maxItems != null && v.length > schema.maxItems) errs.push(`${at}: more than ${schema.maxItems} items`);
    if (schema.items) v.forEach((x, i) => errs.push(...validate(schema.items, x, `${at}[${i}]`)));
  }
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const k of schema.required || []) if (!(k in v)) errs.push(`${at}.${k}: required`);
    const props = schema.properties || {};
    for (const [k, x] of Object.entries(v)) {
      if (props[k]) errs.push(...validate(props[k], x, `${at}.${k}`));
      else if (schema.additionalProperties === false) errs.push(`${at}.${k}: not allowed`);
    }
  }
  return errs;
}

/** The JSON object in a reply (code fences and prose around it tolerated), or null. */
function extractJson(text) {
  const t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  try { const d = JSON.parse(t); if (d && typeof d === 'object') return d; } catch {}
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { const d = JSON.parse(t.slice(a, b + 1)); return d && typeof d === 'object' ? d : null; } catch { return null; }
}

function isRefusal(text, extra = []) {
  const t = String(text || '').trim();
  if (!t) return true;
  const rx = DEFAULT_REFUSALS.concat(extra.map(s => { try { return new RegExp(s, 'i'); } catch { return null; } }).filter(Boolean));
  if (rx.some(r => r.test(t))) return true;
  return t.length < 400 && NOTICE_RX.some(r => r.test(t));
}

/** Did `served` satisfy a request for `requested`? An alias ("haiku") matches a dated id that contains it. */
function modelMatches(requested, served) {
  const r = String(requested || '').toLowerCase().trim(), s = String(served || '').toLowerCase().trim();
  if (!r || !s) return false;
  return s === r || s.startsWith(r) || s.split(/[/:]/).pop().startsWith(r) || new RegExp('(^|[-_/.:])' + r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([-_/.:]|$)').test(s);
}

function withSchema(prompt, schema) {
  if (!schema) return prompt;
  return prompt + '\n\nReply with ONLY a JSON object that matches this JSON Schema — no prose, no code fence.\nSCHEMA:\n' + JSON.stringify(schema);
}

// ------------------------------------------------------------------------------------------ history
function loadHistory() { try { const h = JSON.parse(fs.readFileSync(HISTORY(), 'utf8')); return Array.isArray(h.calls) ? h : { calls: [] }; } catch { return { calls: [] }; } }
function noteCall(kind, r) {
  const h = loadHistory();
  h.calls.push({ at: new Date().toISOString(), kind, ok: !!r.ok, code: r.code || null, route: !r.ok && ROUTE_CODES.has(r.code) });
  h.calls = h.calls.slice(-HISTORY_KEEP);
  try { fs.mkdirSync(path.dirname(HISTORY()), { recursive: true }); fs.writeFileSync(HISTORY(), JSON.stringify(h)); } catch {}
}

/**
 * Has this route recently WORKED? Judged from what it did, never from whether a binary is on PATH.
 * { ok, n_ok, n_route_fail, detail }. Down = the last ROUTE_SAMPLE calls all failed before the model
 * produced anything; after CANARY_AFTER_H hours one canary call is allowed so a fixed route recovers.
 */
function routeHistory(kind, now = Date.now()) {
  let recent;
  if (kind === 'baton-worker') {
    let tasks = [];
    try { tasks = require('./registry').allTasks(); } catch {}
    recent = tasks.filter(t => (t.tags || []).includes(TAG) && ['done', 'failed', 'cancelled'].includes(t.status)).slice(0, ROUTE_SAMPLE)
      .map(t => {
        const ran = t.costUsd > 0 || ((t.tokens || {}).output || 0) > 0 || (t.status === 'done' && !!t.result);
        return { at: t.endedAt || t.createdAt, ok: t.status === 'done' && ran, route: !ran };
      });
  } else {
    recent = loadHistory().calls.filter(c => c.kind === kind).slice(-ROUTE_SAMPLE).reverse();
  }
  const n_ok = recent.filter(c => c.ok).length, n_route = recent.filter(c => !c.ok && c.route).length;
  const detail = recent.length ? `last ${recent.length} ${kind} calls: ${n_ok} produced an answer, ${n_route} never reached the model` : `no ${kind} call has run here yet`;
  if (recent.length >= ROUTE_SAMPLE && n_route === recent.length) {
    const newest = Date.parse((recent[0] || {}).at || 0) || 0;
    if (now - newest >= CANARY_AFTER_H * 3600000) return { ok: true, canary: true, n_ok, n_route_fail: n_route, detail: detail + ` — route looked down; ${CANARY_AFTER_H} h have passed, one canary call allowed` };
    return { ok: false, n_ok, n_route_fail: n_route, detail: detail + ' — the route is not reaching the model; fix it (see `baton engine test`) before spending budget on it' };
  }
  return { ok: true, n_ok, n_route_fail: n_route, detail };
}

// ------------------------------------------------------------------------------------------ drivers
function daemonBase() { return `http://127.0.0.1:${Number(config.get().port) || 8788}`; }
async function httpJson(method, url, body, timeoutMs, headers = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body == null ? undefined : JSON.stringify(body), signal: ac.signal });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, ok: r.ok, text, json, headers: r.headers };
  } finally { clearTimeout(timer); }
}
async function healthMs(timeoutMs = HEALTH_BUDGET_MS * 3) {
  const t = Date.now();
  try { const r = await httpJson('GET', daemonBase() + '/api/health', null, timeoutMs); return r.ok ? Date.now() - t : null; } catch { return null; }
}

async function openaiDriver(c, { prompt, input, schema, timeoutMs }) {
  const base = String(c.openai.baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) return { ok: false, code: 'NOT_CONFIGURED', error: 'engine.openai.baseUrl is blank' };
  if (!c.model) return { ok: false, code: 'NOT_CONFIGURED', error: 'engine.model is blank (the openai engine has no default model)' };
  const headers = {};
  const envName = String(c.openai.apiKeyEnv || '').trim();
  if (envName) {
    const k = process.env[envName];
    if (!k) return { ok: false, code: 'NO_API_KEY', error: `environment variable ${envName} (engine.openai.apiKeyEnv) is not set for the Relaymote process` };
    headers.Authorization = 'Bearer ' + k;
  }
  const body = { model: c.model, temperature: 0, messages: [{ role: 'system', content: withSchema(prompt, schema) }, { role: 'user', content: String(input || '') }] };
  if (schema && c.openai.responseFormat) body.response_format = { type: 'json_schema', json_schema: { name: 'reply', schema, strict: true } };
  let r;
  try { r = await httpJson('POST', base + '/chat/completions', body, timeoutMs, headers); }
  catch (e) { return e.name === 'AbortError' ? { ok: false, code: 'TIMEOUT', error: `no answer in ${Math.round(timeoutMs / 1000)} s` } : { ok: false, code: 'UNREACHABLE', error: e.message }; }
  if (!r.ok) return { ok: false, code: r.status === 401 || r.status === 403 ? 'AUTH' : 'HTTP_ERROR', error: `HTTP ${r.status}: ${r.text.slice(0, 200)}` };
  const j = r.json || {};
  const ch = (j.choices || [])[0] || {};
  const text = typeof (ch.message || {}).content === 'string' ? ch.message.content : (typeof ch.text === 'string' ? ch.text : '');
  // The response's `model` may just reflect the request back; a server that knows better can say so in
  // a header (engine.openai.servedHeader). Either way requireModel checks what we were told.
  const hdr = c.openai.servedHeader ? r.headers.get(String(c.openai.servedHeader)) : null;
  const u = j.usage || {};
  return { ok: true, text, served: hdr || j.model || null, servedFrom: hdr ? 'header' : (j.model ? 'response' : null),
    tokens: { input: u.prompt_tokens || 0, output: u.completion_tokens || 0 }, costUsd: 0 };
}

function claudeCliBin(c) {
  const b = String(c.claudeCli.bin || process.env.BATON_CLAUDE_BIN || '').trim();
  if (b) return b;
  try { return require('./worker').claudeBin(); } catch {}
  return process.platform === 'win32' ? 'claude.cmd' : 'claude';
}
function killTree(child) {
  try {
    if (process.platform === 'win32' && child.pid) execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else child.kill('SIGKILL');
  } catch { try { child.kill(); } catch {} }
}

function claudeCliDriver(c, { prompt, input, schema, timeoutMs }) {
  return new Promise(resolve => {
    const bin = claudeCliBin(c);
    const args = ['-p', '--model', c.model, '--output-format', 'json', '--tools', '', '--strict-mcp-config', '--no-session-persistence'];
    const env = { ...process.env };
    if (!c.claudeCli.allowApiKey) delete env.ANTHROPIC_API_KEY;   // your plan, never a silently billed key
    delete env.CLAUDECODE; delete env.CLAUDE_CODE_ENTRYPOINT;
    const viaNode = /\.(c|m)?js$/i.test(bin), viaShell = /\.(cmd|bat)$/i.test(bin);
    try { fs.mkdirSync(WORK(), { recursive: true }); } catch {}
    let child;
    try {
      child = viaNode ? spawn(process.execPath, [bin, ...args], { cwd: WORK(), env, windowsHide: true })
        : viaShell ? spawn([bin, ...args].map(a => '"' + String(a).replace(/"/g, '""') + '"').join(' '), { cwd: WORK(), env, windowsHide: true, shell: true })
        : spawn(bin, args, { cwd: WORK(), env, windowsHide: true });
    } catch (e) { return resolve({ ok: false, code: 'LAUNCH_FAILED', error: `could not start ${bin}: ${e.message}` }); }
    let out = '', err = '', done = false;
    const finish = r => { if (done) return; done = true; clearTimeout(timer); resolve(r); };
    const timer = setTimeout(() => { killTree(child); finish({ ok: false, code: 'TIMEOUT', error: `no answer in ${Math.round(timeoutMs / 1000)} s` }); }, timeoutMs);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => finish({ ok: false, code: 'LAUNCH_FAILED', error: `could not start ${bin}: ${e.message}` }));
    child.on('close', code => {
      let j = null;
      try { j = JSON.parse(out.trim()); } catch { const b = out.lastIndexOf('{"type":"result"'); if (b >= 0) { try { j = JSON.parse(out.slice(b)); } catch {} } }
      if (!j || typeof j !== 'object') {
        const why = (err || out).trim().slice(-300) || `exit ${code}, no output`;
        return finish({ ok: false, code: /authenticat|log ?in|oauth|credential/i.test(why) ? 'AUTH' : 'LAUNCH_FAILED', error: why });
      }
      const mu = j.modelUsage || {};
      const servedAll = Object.keys(mu);
      const served = servedAll.sort((a, b) => ((mu[b] || {}).outputTokens || 0) - ((mu[a] || {}).outputTokens || 0))[0] || j.model || null;
      const u = j.usage || {};
      const base = { served, servedAll, servedFrom: servedAll.length ? 'modelUsage' : (j.model ? 'result' : null), costUsd: Number(j.total_cost_usd || j.cost_usd || 0),
        tokens: { input: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), output: u.output_tokens || 0 } };
      if (j.is_error || (j.subtype && j.subtype !== 'success')) {
        const why = String(j.result || j.subtype || 'error').slice(0, 300);
        return finish({ ...base, ok: false, code: /authenticat|log ?in|oauth|expired/i.test(why) ? 'AUTH' : 'MODEL_ERROR', error: why });
      }
      finish({ ...base, ok: true, text: typeof j.result === 'string' ? j.result : JSON.stringify(j.result || '') });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(withSchema(prompt, schema) + '\n\nSOURCE:\n' + String(input || ''));
  });
}

/** Read the model a headless worker actually ran on from its stream-json result file. */
function workerServed(task) {
  let raw = '';
  try { raw = fs.readFileSync(task.resultFile, 'utf8'); } catch { return { served: null, servedAll: [] }; }
  let init = null, usage = {};
  for (const line of raw.split('\n')) {
    const L = line.trim(); if (!L || L[0] !== '{') continue;
    let o; try { o = JSON.parse(L); } catch { continue; }
    if (o.type === 'system' && o.subtype === 'init' && o.model) init = o.model;
    if (o.type === 'result' && o.modelUsage) usage = o.modelUsage;
  }
  const all = Object.keys(usage).sort((a, b) => ((usage[b] || {}).outputTokens || 0) - ((usage[a] || {}).outputTokens || 0));
  return { served: all[0] || init || null, servedAll: all.length ? all : (init ? [init] : []) };
}

async function batonWorkerDriver(c, { prompt, input, schema, title, timeoutMs, tag }) {
  const ms = await healthMs();
  if (ms == null) return { ok: false, code: 'UNREACHABLE', error: 'the Relaymote daemon did not answer /api/health (is it running? `baton start`)' };
  if (ms > HEALTH_BUDGET_MS) return { ok: false, code: 'ROUTE_BUSY', error: `the daemon took ${ms} ms to answer /api/health (budget ${HEALTH_BUDGET_MS} ms) — it is busy; adding workers now is how daemons get wedged` };
  fs.mkdirSync(WORK(), { recursive: true });
  const file = path.join(WORK(), `in-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(file, String(input || ''));
  const t0 = Date.now();
  let id = null;
  try {
    const body = { prompt: withSchema(prompt, schema) + `\n\nUse the Read tool ONCE to read the file ${file} — it is the SOURCE. Do not read or open anything else, and do not edit anything.`,
      title: 'ENGINE: ' + String(title || 'request').slice(0, 60), cwd: WORK(), model: c.model, effort: 'low', dispatch: 'headless',
      noReuse: true, maxAttempts: 1, tags: [TAG].concat(tag && tag !== TAG ? [tag] : []) };
    let r;
    try { r = await httpJson('POST', daemonBase() + '/api/task', body, 15000); }
    catch (e) { return { ok: false, code: 'UNREACHABLE', error: 'POST /api/task: ' + e.message }; }
    id = r.json && r.json.task && r.json.task.id;
    if (!id) return { ok: false, code: 'HTTP_ERROR', error: `POST /api/task: HTTP ${r.status} ${r.text.slice(0, 160)}` };
    const reg = require('./registry');
    for (;;) {
      const t = reg.getTask(id);
      if (t && ['done', 'failed', 'cancelled'].includes(t.status)) {
        const sv = workerServed(t);
        const ran = t.costUsd > 0 || ((t.tokens || {}).output || 0) > 0;
        const base = { task: id, served: sv.served || t.model || null, servedAll: sv.servedAll, servedFrom: sv.served ? 'worker transcript' : 'task (requested)',
          costUsd: Number(t.costUsd || 0), tokens: t.tokens || null };
        if (t.status !== 'done') return { ...base, ok: false, code: ran ? 'MODEL_ERROR' : 'LAUNCH_FAILED', error: String(t.error || t.status).slice(0, 300) };
        return { ...base, ok: true, text: String(t.result || '') };
      }
      if (Date.now() - t0 > timeoutMs) {
        try { await httpJson('POST', daemonBase() + `/api/task/${id}/stop?by=engine`, {}, 10000); } catch {}
        return { ok: false, code: 'TIMEOUT', task: id, error: `worker ${id} gave no answer in ${Math.round(timeoutMs / 1000)} s; stopped` };
      }
      await new Promise(res => setTimeout(res, 1500));
    }
  } finally { try { fs.unlinkSync(file); } catch {} }
}

const DRIVERS = { openai: openaiDriver, 'claude-cli': claudeCliDriver, 'baton-worker': batonWorkerDriver };

// ------------------------------------------------------------------------------------------ run
/**
 * Is it worth calling at all right now? { ok, reason, healthMs? }. Checks the route is reachable and
 * has recently worked. Callers stop the whole batch on !ok and record "route unavailable: <reason>".
 */
async function probe(over) {
  const c = effective(over);
  if (c.code) return { ok: false, reason: c.error, code: c.code };
  if (c.kind === 'none') return { ok: false, reason: 'engine is off (settings.engine.kind = none)', code: 'ENGINE_OFF' };
  const out = { ok: true, kind: c.kind, model: c.model };
  if (c.kind === 'baton-worker') {
    const ms = await healthMs();
    out.healthMs = ms;
    if (ms == null) return { ok: false, code: 'UNREACHABLE', reason: 'the Relaymote daemon did not answer /api/health' };
    if (ms > HEALTH_BUDGET_MS) return { ok: false, code: 'ROUTE_BUSY', reason: `daemon /api/health took ${ms} ms (budget ${HEALTH_BUDGET_MS} ms) — already busy` };
  } else if (c.kind === 'openai') {
    const base = String(c.openai.baseUrl || '').trim().replace(/\/+$/, '');
    if (!base || !c.model) return { ok: false, code: 'NOT_CONFIGURED', reason: 'engine.openai.baseUrl and engine.model must both be set' };
    if (c.openai.apiKeyEnv && !process.env[c.openai.apiKeyEnv]) return { ok: false, code: 'NO_API_KEY', reason: `environment variable ${c.openai.apiKeyEnv} is not set` };
    const t = Date.now();
    try {
      const r = await httpJson('GET', base + '/models', null, 5000, c.openai.apiKeyEnv ? { Authorization: 'Bearer ' + process.env[c.openai.apiKeyEnv] } : {});
      out.healthMs = Date.now() - t;
      if (r.status === 401 || r.status === 403) return { ok: false, code: 'AUTH', reason: `${base}/models answered HTTP ${r.status} — the key is refused` };
    } catch (e) { return { ok: false, code: 'UNREACHABLE', reason: `${base} did not answer: ${e.message}` }; }
  }
  const h = routeHistory(c.kind);
  out.history = h.detail;
  if (!h.ok) return { ok: false, code: 'ROUTE_DOWN', reason: h.detail };
  out.reason = h.detail + (out.healthMs != null ? `; health ${out.healthMs} ms` : '');
  return out;
}

let queue = Promise.resolve();
/**
 * One request. { prompt, input, schema?, title?, over?, deadline? (epoch ms: never run past it), tag? }
 * -> { ok, text, json?, engine, model, served, servedAll?, costUsd, tokens, secs, code?, error? }.
 * Serialised: a second call waits for the first.
 */
function run(req) {
  const p = queue.then(() => runNow(req || {}));
  queue = p.catch(() => {});
  return p;
}

async function runNow({ prompt, input = '', schema = null, title = '', over = null, deadline = Infinity, tag = TAG }) {
  const c = effective(over);
  const t0 = Date.now();
  const base = { engine: c.kind, model: c.model || null };
  const fail = (code, error, extra = {}) => ({ ...base, ...extra, ok: false, code, error, secs: +((Date.now() - t0) / 1000).toFixed(1) });
  if (c.code) return fail(c.code, c.error);
  if (c.kind === 'none') return fail('ENGINE_OFF', 'engine is off (settings.engine.kind = none)');
  const left = deadline - Date.now();
  if (left < 2000) return fail('BUDGET', 'no time left in the caller\'s budget');
  const byBudget = left < c.timeoutSec * 1000;
  const timeoutMs = Math.min(c.timeoutSec * 1000, left);
  let raw;
  try { raw = await DRIVERS[c.kind](c, { prompt: String(prompt || ''), input, schema, title, timeoutMs, tag }); }
  catch (e) { raw = { ok: false, code: 'LAUNCH_FAILED', error: e.message }; }
  if (!raw.ok && raw.code === 'TIMEOUT' && byBudget) raw = { ...raw, code: 'BUDGET', error: 'stopped at the caller\'s budget: ' + raw.error };
  const meta = { served: raw.served || null, servedAll: raw.servedAll, servedFrom: raw.servedFrom || null, costUsd: raw.costUsd || 0, tokens: raw.tokens || null, task: raw.task };
  let out;
  if (!raw.ok) out = fail(raw.code || 'FAILED', raw.error || 'failed', meta);
  else {
    const text = String(raw.text || '').trim();
    if (!text) out = fail('EMPTY', 'the model returned an empty answer — treated as a failure, never as a result', meta);
    else if (c.requireModel && !meta.served) out = fail('MODEL_UNVERIFIED', `requireModel is on and the ${c.kind} route did not say which model served`, { ...meta, text });
    else if (c.requireModel && !modelMatches(c.model, meta.served)) out = fail('MODEL_SUBSTITUTED', `asked for ${c.model}, ${meta.served} served — refused (requireModel)`, { ...meta, text });
    else if (schema) {
      const json = extractJson(text);
      if (!json) out = fail(isRefusal(text, c.refusalPatterns) ? 'REFUSED' : 'NOT_JSON', 'no JSON object in the answer: ' + text.slice(0, 160), { ...meta, text });
      else {
        const errs = validate(schema, json);
        out = errs.length ? fail('SCHEMA_INVALID', 'answer does not match the schema: ' + errs.slice(0, 4).join('; '), { ...meta, text, json })
          : { ...base, ...meta, ok: true, text, json, secs: +((Date.now() - t0) / 1000).toFixed(1) };
      }
    } else if (isRefusal(text, c.refusalPatterns)) out = fail('REFUSED', 'the answer is a refusal or provider notice: ' + text.slice(0, 160), { ...meta, text });
    else out = { ...base, ...meta, ok: true, text, secs: +((Date.now() - t0) / 1000).toFixed(1) };
  }
  if (c.kind !== 'baton-worker') noteCall(c.kind, out);   // baton-worker history is the task registry itself
  return out;
}

/** `baton engine [status|test]` */
async function cli(argv = []) {
  const verb = (argv[0] || 'status').toLowerCase();
  if (verb === 'test') {
    const pr = await probe();
    if (!pr.ok) { console.log(JSON.stringify({ ...describe(), probe: pr }, null, 2)); process.exitCode = 2; return; }
    const r = await run({ prompt: 'Reply with a JSON object {"ok": true}.', input: 'ping', schema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } }, title: 'engine test' });
    console.log(JSON.stringify({ ...describe(), probe: pr, result: { ok: r.ok, code: r.code, error: r.error, served: r.served, secs: r.secs, costUsd: r.costUsd } }, null, 2));
    if (!r.ok) process.exitCode = 3;
    return;
  }
  console.log(JSON.stringify({ ...describe(), history: routeHistory(effective().kind).detail }, null, 2));
}

module.exports = { KINDS, TAG, ROUTE_CODES, effective, describe, validate, extractJson, isRefusal, modelMatches, probe, run, routeHistory,
  loadHistory, workerServed, healthMs, cli, ROUTE_SAMPLE, CANARY_AFTER_H };
