'use strict';
const registry = require('./registry');
const worker = require('./worker');
const gui = require('./gui-worker');
const desktop = require('./desktop');
const router = require('./router');

const CONFIG = {
  maxConcurrent: 3,
  maxConcurrentGui: 2,
  maxAttempts: 3,
  reuseWindowMs: 6 * 60 * 60 * 1000,
  guiGroup: 'Relaymote',
};

const TRANSIENT_RX = /overloaded|rate.?limit|429|502|503|504|timeout|ECONN|socket hang up|network|temporarily/i;
const ENVIRONMENT_RX = /exited without a result|spawn failed|ENOENT|EACCES|no such file|not recognized|cannot find/i;
const GUI_ENVIRONMENT_RX = /\bGUI_[A-Z_]+/;
const MAX_ENV_RETRIES = 1;
const CAPABILITY_RX = /max_turns|context|too (long|complex)|could not|unable to|incomplete|gave up|exceeded/i;

let _logLines = 0;
const LOG_MAX_BYTES = 8 * 1024 * 1024;
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    const fs = require('fs');
    const f = require('path').join(registry.STATE_DIR, 'relaymote.log');
    if (++_logLines % 500 === 0) {
      try {
        if (fs.statSync(f).size > LOG_MAX_BYTES) {
          try { fs.unlinkSync(f + '.1'); } catch {}
          fs.renameSync(f, f + '.1');
        }
      } catch {}
    }
    fs.appendFileSync(f, line + '\n');
  } catch {}
}

function pickReusableSession(decision, opts) {
  if (decision.isolate || opts.isolate || opts.noReuse) return null;
  if (opts.resumeSessionId) return opts.resumeSessionId;
  const cutoff = Date.now() - CONFIG.reuseWindowMs;
  const cands = registry.allTasks().filter(t =>
    t.status === 'done' && t.sessionId &&
    t.cwd === (opts.cwd || process.cwd()) &&
    t.type === decision.type &&
    Date.parse(t.endedAt || 0) >= cutoff
  );
  return cands.length ? cands[0].sessionId : null;
}

function enqueue(prompt, opts = {}) {
  const decision = router.route(prompt, opts);
  const resumeSessionId = pickReusableSession(decision, opts);
  const t = registry.createTask({
    title: opts.title || prompt.slice(0, 70),
    prompt,
    cwd: opts.cwd || process.cwd(),
    type: decision.type,
    complexity: decision.complexity,
    model: decision.model,
    effort: decision.effort,
    lean: decision.lean,
    mode: opts.mode || decision.mode,
    isolate: decision.isolate,
    maxAttempts: opts.maxAttempts || CONFIG.maxAttempts,
    dependsOn: opts.dependsOn || [],
    tags: opts.tags || [],
    dispatch: opts.dispatch || null,
    masterId: opts.masterId || null,
  });
  const route = gui.chooseDispatch({ dispatch: opts.dispatch });
  const patch = { routeReason: decision.reason, confidence: decision.confidence, dispatchPlan: route.dispatch, dispatchReason: route.reason };
  if (resumeSessionId) { patch.resumeSessionId = resumeSessionId; patch.reuseOf = resumeSessionId; }
  const out = registry.updateTask(t.id, patch);
  log(`enqueue ${t.id} "${t.title.slice(0, 48)}" -> ${decision.model}/${decision.effort}` +
      `${decision.lean ? ' lean' : ''} mode=${out.mode} via=${route.dispatch}` +
      `${resumeSessionId ? ' reuse=' + resumeSessionId.slice(0, 8) : ''}`);
  return out;
}

function planRetry(task) {
  const err = String(task.error || '');
  if (task.attempt >= task.maxAttempts) return { action: 'giveup', reason: `exhausted ${task.maxAttempts} attempts` };

  const tok = task.tokens || {};
  const zeroTokens = (tok.input || 0) === 0 && (tok.output || 0) === 0 && !(task.costUsd > 0);
  const ranAnyway = task.dispatch !== 'gui' && zeroTokens && worker.transcriptShowsActivity(task);
  const neverInvoked = task.dispatch === 'gui' ? !!task.launchFailed : (zeroTokens && !ranAnyway);
  if (neverInvoked && task.status === 'failed') {
    const why = task.dispatch === 'gui'
      ? 'the prompt never reached a Desktop session (launchFailed)'
      : 'the model was never invoked (0 input/output tokens, no cost)';
    if (task.attempt <= MAX_ENV_RETRIES) return { action: 'retry', reason: `${why} — launch failure, retrying in place, NOT escalating` };
    return {
      action: 'giveup',
      reason: task.dispatch === 'gui'
        ? `${why}: GUI dispatch failed before any work started. Check that Claude Desktop is running with its debugger on 9229 and that the task's folder is in Desktop's recent list — escalation cannot help.`
        : `${why}: the worker failed to launch. Check binary/cwd/permissions — escalation cannot help.`,
    };
  }

  if (ENVIRONMENT_RX.test(err) || GUI_ENVIRONMENT_RX.test(err)) {
    if (task.attempt <= MAX_ENV_RETRIES) return { action: 'retry', reason: 'environment failure (not a model problem) — retrying in place, NOT escalating' };
    return {
      action: 'giveup',
      reason: GUI_ENVIRONMENT_RX.test(err)
        ? 'GUI environment failure: the Desktop UI could not be driven to start this task. Check Desktop is running (debugger on 9229) and that the folder is in its recents — escalating the model would not help.'
        : 'environment failure: the worker never produced output. Check cwd/binary/permissions — escalating the model would not help.',
    };
  }
  if (TRANSIENT_RX.test(err)) return { action: 'retry', reason: 'transient infrastructure error' };
  const next = router.escalate(task.model, task.effort);
  if (!next) return { action: 'giveup', reason: 'already at strongest rung (opus/max)' };
  return {
    action: 'escalate', next,
    reason: CAPABILITY_RX.test(err) ? 'model capability exceeded' : 'failed; escalating',
  };
}

let pumping = false;
async function pump() {
  if (pumping) return { skipped: 'a pump cycle is already in flight' };
  pumping = true;
  try { return await pumpInner(); } finally { pumping = false; }
}

async function pumpInner() {
  const acted = { settled: 0, escalated: 0, retried: 0, started: 0, gaveUp: 0, startedGui: 0 };
  const _t0 = Date.now(); let _last = _t0; const _times = {};
  const _phase = (name) => { const n = Date.now(); _times[name] = n - _last; _last = n; };

  const running = registry.byStatus('running');
  let sidebar = null;
  if (running.some(t => t.dispatch === 'gui')) {
    try { sidebar = await desktop.scrapeSidebar(); }
    catch (e) { log(`sidebar scrape failed, GUI tasks will be re-checked next cycle: ${e.message}`); }
  }
  for (const t of running) {
    let after;
    try {
      after = t.dispatch === 'gui'
        ? await gui.poll(t.id, sidebar ? { sidebar } : {})
        : worker.poll(t.id);
    } catch (e) { log(`poll error ${t.id}: ${e.message}`); continue; }
    if (after && after.status !== 'running') {
      acted.settled++;
      log(`settle ${t.id} -> ${after.status}${after.status === 'failed' ? ' :: ' + String(after.error).slice(0, 160) : ''}`);
    } else if (after && after.guiAwaiting && !t.guiAwaiting) {
      log(`AWAITING INPUT ${t.id}: worker session ${after.guiSessionId} asked a question — read with list_events, reply with send_message`);
    }
  }

  _phase('settle');

  for (const t of registry.byStatus('failed')) {
    if (t.finalized) continue;
    const plan = planRetry(t);
    if (plan.action === 'giveup') {
      const base = String(t.error || '').split(' | ')[0];
      registry.updateTask(t.id, { status: 'failed', finalized: true, error: `${base} | ${plan.reason}` });
      if (!t.finalized) { acted.gaveUp++; log(`giveup ${t.id}: ${plan.reason}`); }
      continue;
    }
    if (plan.action === 'retry') {
      registry.updateTask(t.id, { status: 'queued', error: null });
      acted.retried++; log(`retry ${t.id} (same rung ${t.model}/${t.effort}): ${plan.reason}`);
      continue;
    }
    const esc = (t.escalations || []).concat([{
      from: { model: t.model, effort: t.effort },
      to: { model: plan.next.model, effort: plan.next.effort },
      reason: plan.reason, at: new Date().toISOString(),
    }]);
    registry.updateTask(t.id, {
      status: 'queued', error: null,
      model: plan.next.model, effort: plan.next.effort, lean: false,
      resumeSessionId: null,
      escalations: esc,
    });
    acted.escalated++;
    log(`ESCALATE ${t.id}: ${t.model}/${t.effort} -> ${plan.next.model}/${plan.next.effort} (${plan.reason})`);
  }

  _phase('retry');

  const nowRunning = registry.byStatus('running');
  let slots = Math.max(0, (Number(require('./config').get().workers.concurrency) || CONFIG.maxConcurrent) - nowRunning.filter(t => t.dispatch !== 'gui').length);
  let guiSlots = Math.max(0, (Number(require('./config').get().workers.guiConcurrency) || CONFIG.maxConcurrentGui) - nowRunning.filter(t => t.dispatch === 'gui').length);

  const queued = registry.byStatus('queued').slice().reverse();
  for (const t of queued) {
    if (slots <= 0 && guiSlots <= 0) break;
    if (t.mode === 'inline') continue;
    const deps = (t.dependsOn || []).map(id => registry.getTask(id));
    if (deps.some(d => !d || d.status !== 'done')) continue;

    const choice = gui.chooseDispatch(t);

    if (choice.dispatch === 'gui') {
      if (guiSlots <= 0) continue;
      try {
        const r = await gui.dispatch(t.id);
        if (r.ok) {
          guiSlots--; acted.started++; acted.startedGui++;
          log(`start ${t.id} attempt=${r.task.attempt} GUI session=${r.sessionId} ${r.task.model}/${r.task.effort} folder="${r.folder && r.folder.folder}" (${choice.reason})`);
          if (CONFIG.guiGroup) {
            const g = await gui.groupWorker(r.sessionId, CONFIG.guiGroup);
            if (!g.ok) log(`group ${t.id} -> "${CONFIG.guiGroup}" failed (not fatal): ${g.error || JSON.stringify(g).slice(0, 120)}`);
          }
        } else {
          log(`gui-dispatch-failed ${t.id}: ${String(r.error).slice(0, 220)}`);
        }
      } catch (e) {
        registry.updateTask(t.id, { status: 'failed', dispatch: 'gui', launchFailed: true, error: 'GUI_DISPATCH_THREW: ' + e.message });
        log(`gui-dispatch-threw ${t.id}: ${e.message}`);
      }
      continue;
    }

    if (slots <= 0) continue;
    try {
      const started = worker.spawnWorker(t.id);
      registry.updateTask(t.id, { dispatch: 'headless' });
      slots--; acted.started++;
      log(`start ${t.id} attempt=${started.attempt} ${started.model}/${started.effort} pid=${started.pid} (${choice.reason})`);
    } catch (e) {
      registry.updateTask(t.id, { status: 'failed', error: 'spawn failed: ' + e.message });
      log(`spawn-failed ${t.id}: ${e.message}`);
    }
  }
  _phase('start');
  const _total = Date.now() - _t0;
  if (_total > 1500) log(`pump took ${_total}ms — ` + Object.entries(_times).map(([k, v]) => k + ':' + v + 'ms').join(' '));
  return acted;
}

async function recover() {
  const r = worker.reconcile();
  log(`recover(headless): ${r.recovered} completed-while-down, ${r.failed} failed, ${r.stillRunning} still running`);
  let g = { recovered: 0, failed: 0, stillRunning: 0 };
  try { g = await gui.reconcile(); }
  catch (e) { log(`recover(gui) failed: ${e.message}`); }
  log(`recover(gui): ${g.recovered} completed-while-down, ${g.failed} failed, ${g.stillRunning} still running`);
  return { headless: r, gui: g, recovered: r.recovered + g.recovered, failed: r.failed + g.failed, stillRunning: r.stillRunning + g.stillRunning };
}

async function stopTask(id, opts = {}) {
  const t = registry.getTask(id);
  if (!t) return null;
  const ran = t.startedAt ? ', ran ' + Math.round((Date.now() - Date.parse(t.startedAt)) / 1000) + 's' : '';
  log(`stop ${id} "${String(t.title || '').slice(0, 60)}" by ${opts.by || 'unknown caller'}`
      + ` (was ${t.status}${t.pid ? ', pid ' + t.pid : ''}${ran}) -- actor also in master-audit.log`);
  return t.dispatch === 'gui' ? await gui.stop(id) : worker.stop(id);
}

function summary() {
  const all = registry.allTasks();
  const s = { total: all.length, queued: 0, running: 0, done: 0, failed: 0, cancelled: 0, costUsd: 0, escalations: 0 };
  for (const t of all) {
    if (s[t.status] != null) s[t.status]++;
    s.costUsd += t.costUsd || 0;
    s.escalations += (t.escalations || []).length;
  }
  s.costUsd = +s.costUsd.toFixed(4);
  return s;
}

module.exports = { enqueue, pump, recover, stopTask, summary, planRetry, pickReusableSession, CONFIG, log };
