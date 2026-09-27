'use strict';
const fs = require('fs');
const path = require('path');

const registry = require('./registry');
const desktop = require('./desktop');
let bridge = null; try { bridge = require('./bridge'); } catch {}

// Re-read per call (not once at load) so a test or a service manager can point it elsewhere.
function stateDir() { return process.env.RELAYMOTE_STATE_DIR || require('./config').STATE; }
const f = name => path.join(stateDir(), name);

const DEFAULTS = {
  enabled: true,
  notifyTasks: true,
  notifySessions: true,
  debounceMs: 45000,
  maxBatch: 12,
  maxEventsInMessage: 12,
  coldStartBacklog: true,
  coldStartTaskLookbackMs: 30 * 60 * 1000,
  restateAfterMs: 6 * 60 * 60 * 1000,
  maxDeliveryAttempts: 20,
  retryBackoffMs: 90000,
  snapshotMaxAgeMs: 5 * 60 * 1000,
  resultChars: 240,
  errorChars: 240,
  logKeep: 60,
};

const PER_PROJECT_KEYS = ['notifySessions'];

function readFile() {
  try { return JSON.parse(fs.readFileSync(f('notify-config.json'), 'utf8')) || {}; } catch { return {}; }
}

function config() {
  const file = readFile();
  const cfg = { ...DEFAULTS, ...file };
  delete cfg.byProject; delete cfg.lastChange;
  const env = process.env.RELAYMOTE_NOTIFY_MASTER;
  if (env != null && env !== '') cfg.enabled = !/^(0|false|off|no)$/i.test(String(env));
  return cfg;
}

function configFor(project, base = config()) {
  const by = readFile().byProject || {};
  const mine = (project && by[project]) || null;
  return mine ? { ...base, ...mine } : base;
}

function setConfig(patch, opts = {}) {
  const file = readFile();
  const project = opts.project || null;
  const applied = {};
  for (const [k, v] of Object.entries(patch || {})) {
    if (!(k in DEFAULTS)) throw new Error(`unknown notify config key: ${k}`);
    applied[k] = v;
    if (project && PER_PROJECT_KEYS.includes(k)) {
      file.byProject = file.byProject || {};
      const mine = file.byProject[project] = file.byProject[project] || {};
      if (v === null) delete mine[k]; else mine[k] = v;
      if (!Object.keys(mine).length) delete file.byProject[project];
    } else {
      if (v === null) delete file[k]; else file[k] = v;
    }
  }
  if (Object.keys(applied).length) {
    file.lastChange = { at: new Date().toISOString(), by: opts.by || null, project,
                        scope: project ? 'project' : 'global', patch: applied };
  }
  writeAtomic(f('notify-config.json'), file);
  return project ? configFor(project) : config();
}

function blank() {
  return {
    version: 1,
    initialisedAt: null,
    notified: {},
    sessionState: {},
    ranSince: {},
    lastActivityAt: {},
    notifiedAt: {},
    pending: [],
    delivery: {},
    log: [],
  };
}

function writeAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(f('notify-state.json'), 'utf8'));
    return { ...blank(), ...s };
  } catch { return blank(); }
}
function saveState(s) { try { writeAtomic(f('notify-state.json'), s); } catch {} }

function activeMasters(now = Date.now()) {
  let all = {};
  try { all = JSON.parse(fs.readFileSync(f('masters.json'), 'utf8')) || {}; } catch { return []; }
  return Object.entries(all)
    .filter(([, m]) => m && m.sessionId && (!m.expiresAt || Date.parse(m.expiresAt) > now))
    .map(([project, m]) => ({ project, sessionId: m.sessionId, title: m.sessionTitle || '', fleet: m.fleet || [] }));
}

function ownerOf(id, masters) {
  const own = masters.find(m => m.sessionId === id);
  if (own) return own;
  const claimants = masters.filter(m => m.fleet.includes(id));
  if (claimants.length <= 1) return claimants[0] || null;
  const nested = claimants.find(m => claimants.some(o => o !== m && o.fleet.includes(m.sessionId)));
  return nested || claimants[0];
}

const oneLine = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };
const decode = s => String(s == null ? '' : s).replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, m => ENTITIES[m]);
const clip = (s, n) => { const t = oneLine(decode(s)); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const shortId = id => (String(id).length > 20 ? String(id).slice(0, 14) + '…' : String(id));

function duration(task) {
  const a = Date.parse(task.startedAt || 0), b = Date.parse(task.endedAt || 0);
  if (!a || !b || b < a) return '';
  const s = Math.round((b - a) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

function taskLine(t, cfg) {
  const meta = [
    `${t.model || '?'}/${t.effort || '?'}`,
    duration(t),
    t.costUsd ? `$${(+t.costUsd).toFixed(2)}` : '',
    (t.escalations || []).length ? `${t.escalations.length} escalation(s)` : '',
  ].filter(Boolean).join(', ');
  if (t.status === 'done') {
    return `DONE   ${t.id} "${clip(t.title, 60)}" (${meta})\n       -> ${clip(t.result, cfg.resultChars) || '(empty result)'}`;
  }
  return `FAILED ${t.id} "${clip(t.title, 60)}" (${meta}, gave up after ${t.attempt || 0}/${t.maxAttempts || 0} attempts)\n       -> ${clip(t.error, cfg.errorChars) || '(no error text)'}`;
}

function sessionLine(s) {
  const dot = s.state === 'awaiting_input' ? 'YELLOW' : 'BLUE  ';
  const what = s.state === 'awaiting_input'
    ? 'asking a question — blocked until someone answers'
    : 'finished work, unread';
  return `${dot} ${shortId(s.sessionId)} "${clip(s.title, 60)}" — ${what}\n       id: ${s.sessionId}`;
}

const MESSAGE_BUDGET = 2000;

function composeMessage(master, events, cfg) {
  const taskIds = [...new Set(events.filter(e => e.taskId).map(e => e.taskId))];
  const sessIds = [...new Set(events.filter(e => e.sessionId).map(e => e.sessionId))];

  const head = `[Relaymote] Fleet update for project "${master.project}" — ${events.length} event${events.length === 1 ? '' : 's'}. You were not going to see these otherwise.`;
  const shown = [];
  let used = head.length;
  for (const e of events) {
    if (shown.length >= cfg.maxEventsInMessage) break;
    if (used + e.line.length + 1 > MESSAGE_BUDGET) break;
    shown.push(e); used += e.line.length + 1;
  }
  const extra = events.length - shown.length;

  const L = [];
  L.push(head);
  L.push('');
  shown.forEach(e => L.push(e.line));
  if (extra > 0) L.push(`... and ${extra} more event${extra === 1 ? '' : 's'} (see relaymote_tasks / relaymote_list_sessions).`);
  L.push('');
  const how = [];
  if (taskIds.length) how.push(`relaymote_tasks id:"${taskIds[0]}" for a full result${taskIds.length > 1 ? ` (also: ${taskIds.slice(1).join(', ')})` : ''}`);
  if (sessIds.length) how.push('ccd_session_mgmt list_events to read a session (lossless — it does NOT clear the dot)');
  L.push('To act: ' + (how.join(' · ') || 'relaymote_tasks / relaymote_list_sessions'));
  L.push('Chain of command: answer and verify these yourself; report to the Conductor session (if one exists) only when the whole brief is done or a decision needs the user — one line either way.');
  L.push('Sent automatically by the Relaymote daemon. Turn it off with relaymote_notify enabled:false.');
  return L.join('\n');
}

function terminalStatus(t) {
  if (t.status === 'done') return 'done';
  if (t.status === 'failed' && t.finalized) return 'failed';
  return null;
}

let TASKS = () => registry.allTasks();
function _setTaskSource(fn) { const prev = TASKS; TASKS = fn || (() => registry.allTasks()); return prev; }

function scanTasks(state, masters, cfg, firstRun, now = Date.now()) {
  const events = [];
  for (const t of TASKS()) {
    const term = terminalStatus(t);
    if (!term) continue;
    const key = `task:${t.id}:${term}`;
    if (state.notified[key]) continue;

    const master = ownerOf(t.id, masters);
    const stale = firstRun && !(cfg.coldStartBacklog && Date.parse(t.endedAt || 0) >= now - cfg.coldStartTaskLookbackMs);
    state.notified[key] = new Date(now).toISOString();
    if (!master || stale) continue;

    events.push({
      key, kind: term === 'done' ? 'task-done' : 'task-failed',
      project: master.project, masterSessionId: master.sessionId,
      taskId: t.id, at: new Date(now).toISOString(),
      line: taskLine(t, cfg),
    });
  }
  return events;
}

function conductorSessionId(masters) {
  try {
    const set = require('./config').get().conductorSession;
    if (set) return String(set);
    const list = Array.isArray(masters)
      ? masters.map(m => [m && m.project, m])
      : Object.entries(masters || {}).map(([k, m]) => [(m && m.project) || k, m]);
    for (const [proj, m] of list) {
      if (m && m.sessionId && String(proj || '').toLowerCase().includes('conductor')) return m.sessionId;
    }
  } catch {}
  return null;
}

// ---------- the collected ledger: do not re-announce work the Conductor already banked ----------------
// The Conductor reads a finished session losslessly (which deliberately does not clear its unread dot),
// acts on it and banks it (lib/goals.js collected.jsonl). Only OPENING a session clears the dot, so
// without this the restate cycle would announce the same finished session again and again, each time
// costing the Conductor a turn. The ledger records WHEN it was banked; a session that has written
// anything since is 'moved-since' and is announced as usual.
// FAILS OPEN, on purpose: an unreadable ledger, a transcript that cannot be found ('cannot-verify'),
// a session never banked, or any error -> announce. A missed announcement is unread work nobody sees;
// a spurious one costs a glance. Only a BLUE (unread, finished) raise to the Conductor is suppressed;
// a YELLOW awaiting_input is a live question and is never suppressed. The app's dot is never touched.
let BANKED = (sessionId) => {
  try { return require('./goals').collectedStatus(sessionId).state === 'banked'; } catch { return false; }
};
function _setBankedCheck(fn) { const prev = BANKED; BANKED = fn || ((sid) => { try { return require('./goals').collectedStatus(sid).state === 'banked'; } catch { return false; } }); return prev; }
/** true only when it can be PROVED that this session was banked and has been silent since. */
function alreadyBanked(sessionId) {
  try { return BANKED(sessionId) === true; } catch { return false; }
}

function scanSessions(state, masters, cfg, sessions, firstRun, now = Date.now()) {
  const events = [];
  const seen = new Set();
  // Resolved once per scan: the ledger guard applies only to what reaches the Conductor.
  const conductorId = conductorSessionId(masters);
  for (const s of sessions || []) {
    if (!s || !s.sessionId) continue;
    seen.add(s.sessionId);
    const prev = state.sessionState[s.sessionId];
    state.sessionState[s.sessionId] = s.state;

    const master = ownerOf(s.sessionId, masters);
    if (!master) continue;
    if (s.sessionId === master.sessionId) continue;
    if (s.state !== 'unread' && s.state !== 'awaiting_input') continue;

    if (prev === undefined) {
      if (master && master.project) {
        state.pendingHistory = state.pendingHistory || {};
        const seenP = state.pendingHistory[s.sessionId] || [];
        if (!seenP.includes(master.project)) seenP.push(master.project);
        state.pendingHistory[s.sessionId] = seenP;
      }
      continue;
    }
    if (prev === s.state) continue;

    const key = `sess:${s.sessionId}:${s.state}:${firstRun ? 'coldstart' : Math.floor(now / 1000)}`;
    const dedupe = `sess:${s.sessionId}:${s.state}`;
    if (state.notified[dedupe]) continue;
    const lastAt = state.notifiedAt && state.notifiedAt[dedupe];
    const ranAgain = !!state.ranSince[s.sessionId];
    const aged = lastAt ? (now - Date.parse(lastAt)) >= cfg.restateAfterMs : true;
    if (lastAt && !ranAgain && !aged) continue;
    const restating = !!(lastAt && !ranAgain && aged);
    state.notified[dedupe] = new Date(now).toISOString();
    state.notifiedAt = state.notifiedAt || {};
    state.notifiedAt[dedupe] = new Date(now).toISOString();
    state.ranSince[s.sessionId] = false;

    // THE LEDGER GUARD, after the bookkeeping above on purpose: the dedupe stamps must be written even
    // when we suppress, or this session (which never leaves 'unread') could never fire again. Both ways
    // back stay open — it runs again (ranSince) or the restate age passes — and each re-checks a fresh ledger.
    if (s.state === 'unread' && conductorId && master.sessionId === conductorId && alreadyBanked(s.sessionId)) continue;

    events.push({
      key, kind: s.state === 'unread' ? 'session-unread' : 'session-awaiting',
      project: master.project, masterSessionId: master.sessionId,
      sessionId: s.sessionId, at: new Date(now).toISOString(),
      restating,
      line: (restating ? 'STILL UNATTENDED — ' : '') + sessionLine(s),
    });
  }
  for (const s of sessions || []) {
    if (!s || !s.sessionId) continue;
    if (s.state === 'running') state.ranSince[s.sessionId] = true;
    if (s.lastActivityAt) {
      const prev = state.lastActivityAt[s.sessionId];
      if (prev && prev !== s.lastActivityAt) state.ranSince[s.sessionId] = true;
      state.lastActivityAt[s.sessionId] = s.lastActivityAt;
    }
    for (const st of ['unread', 'awaiting_input']) {
      if (s.state !== st) delete state.notified[`sess:${s.sessionId}:${st}`];
    }
  }
  state.lastSeenAt = state.lastSeenAt || {};
  for (const id of seen) state.lastSeenAt[id] = now;
  const FORGET_AFTER_MS = 24 * 60 * 60 * 1000;
  for (const id of Object.keys(state.sessionState)) {
    const last = state.lastSeenAt[id];
    if (!last) { state.lastSeenAt[id] = now; continue; }
    if (now - last > FORGET_AFTER_MS) { delete state.sessionState[id]; delete state.lastSeenAt[id]; }
  }
  return events;
}

let SEND = async (sessionId, message, opts) => {
  if (bridge) {
    try { const b = await bridge.sendMessage(sessionId, message, { initiator: 'baton-notify' }); if (b && b.ok) return { ok: true, result: 'sent', delivery: b.queued ? 'queued' : 'accepted', via: 'bridge', markerCleared: undefined }; }
    catch {}
  }
  return desktop.sendMessage(sessionId, message, opts);
};
function _setSender(fn) { const prev = SEND; SEND = fn || ((s, m, o) => desktop.sendMessage(s, m, o)); return prev; }

function resolveTarget(project, live) {
  const claim = live.find(m => m.project === project) || null;
  return claim
    ? { sessionId: claim.sessionId, key: claim.sessionId }
    : { sessionId: null, key: `project:${project}` };
}

function dueBatches(state, cfg, now = Date.now(), force = false, live = activeMasters(now)) {
  const byProject = new Map();
  for (const e of state.pending) {
    if (!byProject.has(e.project)) byProject.set(e.project, []);
    byProject.get(e.project).push(e);
  }
  const out = [];
  for (const [project, events] of byProject) {
    const { sessionId, key } = resolveTarget(project, live);
    const d = state.delivery[key] || {};
    if (d.nextAttemptAt && now < Date.parse(d.nextAttemptAt)) continue;
    const oldest = Math.min(...events.map(e => Date.parse(e.at) || now));
    const ripe = force || events.length >= cfg.maxBatch || (now - oldest) >= cfg.debounceMs;
    if (ripe) out.push({ masterSessionId: sessionId, deliveryKey: key, scannedMasterSessionId: events[0].masterSessionId, project, events });
  }
  return out;
}

let flushing = false;

async function flush(cfg = config(), opts = {}) {
  if (flushing) return { skipped: 'already-flushing' };
  const now = Date.now();
  let state = loadState();
  const live0 = activeMasters(now);
  const batches = dueBatches(state, cfg, now, !!opts.force, live0);
  if (!batches.length) return { delivered: 0, pending: state.pending.length };

  flushing = true;
  const results = [];
  try {
    const live = activeMasters(now);
    for (const b of batches) {
      const { sessionId: target, key: dkey } = resolveTarget(b.project, live);
      const retargeted = target && target !== b.scannedMasterSessionId ? b.scannedMasterSessionId : null;
      const keys0 = new Set(b.events.map(e => e.key));

      if (!target) {
        state = loadState();
        const dh = state.delivery[dkey] || { attempts: 0 };
        dh.attempts = (dh.attempts || 0) + 1;
        dh.lastAt = new Date().toISOString();
        dh.lastResult = 'no-live-master-claim';
        if (dh.attempts >= cfg.maxDeliveryAttempts) {
          state.pending = state.pending.filter(e => !keys0.has(e.key));
          dh.attempts = 0; dh.nextAttemptAt = null;
          state.log.unshift({ at: new Date().toISOString(), project: b.project, master: null, events: b.events.length, result: 'dropped', reason: `no session held the "${b.project}" master claim across ${cfg.maxDeliveryAttempts} attempts; refusing to guess a recipient` });
        } else {
          dh.nextAttemptAt = new Date(Date.now() + cfg.retryBackoffMs * Math.min(dh.attempts, 5)).toISOString();
          state.log.unshift({ at: new Date().toISOString(), project: b.project, master: null, events: b.events.length, result: 'held', reason: `no live master claim for "${b.project}"`, nextAttemptAt: dh.nextAttemptAt });
        }
        state.delivery[dkey] = dh;
        state.log = state.log.slice(0, cfg.logKeep);
        saveState(state);
        results.push({ project: b.project, master: null, events: b.events.length, result: 'held', ok: false });
        continue;
      }

      const master = { project: b.project, sessionId: target };
      const message = composeMessage(master, b.events, cfg);
      let r;
      try { r = await SEND(target, message, { protect: false }); }
      catch (e) { r = { ok: false, result: 'error', error: e.message }; }

      state = loadState();
      const d = state.delivery[dkey] || { attempts: 0 };
      const keys = new Set(b.events.map(e => e.key));

      if (r && r.ok) {
        state.pending = state.pending.filter(e => !keys.has(e.key));
        state.delivery[dkey] = { attempts: 0, lastAt: new Date().toISOString(), lastResult: 'sent', nextAttemptAt: null };
        state.log.unshift({ at: new Date().toISOString(), project: b.project, master: target, retargetedFrom: retargeted, events: b.events.length, result: 'sent', markerCleared: r.markerCleared || null });
      } else {
        d.attempts = (d.attempts || 0) + 1;
        d.lastAt = new Date().toISOString();
        d.lastResult = (r && (r.result || r.error)) || 'unknown';
        if (d.attempts >= cfg.maxDeliveryAttempts) {
          state.pending = state.pending.filter(e => !keys.has(e.key));
          d.attempts = 0; d.nextAttemptAt = null;
          state.log.unshift({ at: new Date().toISOString(), project: b.project, master: target, retargetedFrom: retargeted, events: b.events.length, result: 'dropped', reason: `undeliverable after ${cfg.maxDeliveryAttempts} attempts: ${d.lastResult}` });
        } else {
          d.nextAttemptAt = new Date(Date.now() + cfg.retryBackoffMs * Math.min(d.attempts, 5)).toISOString();
          state.log.unshift({ at: new Date().toISOString(), project: b.project, master: target, retargetedFrom: retargeted, events: b.events.length, result: 'retry', reason: d.lastResult, nextAttemptAt: d.nextAttemptAt });
        }
        state.delivery[dkey] = d;
      }
      state.log = state.log.slice(0, cfg.logKeep);
      saveState(state);
      results.push({ project: b.project, master: target, retargetedFrom: retargeted, events: b.events.length, result: (r && (r.result || (r.ok ? 'sent' : 'failed'))) || 'failed', ok: !!(r && r.ok) });
    }
  } finally { flushing = false; }

  return { delivered: results.filter(x => x.ok).length, batches: results, pending: loadState().pending.length };
}

async function tick(opts = {}) {
  const cfg = config();
  if (!cfg.enabled) return { enabled: false };
  const now = opts.now || Date.now();

  let state = loadState();
  const firstRun = !state.initialisedAt;
  const masters = activeMasters(now);

  let sessions = opts.sessions;
  if (sessions === undefined) {
    const snap = desktop.loadSnapshot();
    const fresh = snap && snap.at && (now - Date.parse(snap.at)) <= cfg.snapshotMaxAgeMs;
    sessions = fresh ? snap.sessions : null;
  }

  const events = [];
  if (cfg.notifyTasks) events.push(...scanTasks(state, masters, cfg, firstRun, now));
  if (sessions) {
    const scanned = scanSessions(state, masters, cfg, sessions, firstRun, now);
    const wants = p => configFor(p, cfg).notifySessions;

    events.push(...scanned.filter(e => wants(e.project)));

    state.mutedMissed = state.mutedMissed || {};
    for (const e of scanned) {
      if (!e.sessionId || wants(e.project)) continue;
      const seen = state.mutedMissed[e.sessionId] || [];
      if (e.project && !seen.includes(e.project)) seen.push(e.project);
      state.mutedMissed[e.sessionId] = seen;
    }

    const missed = Object.assign({}, state.pendingHistory || {}, state.mutedMissed || {});
    const ids = Object.keys(missed);
    if (ids.length) {
      for (const m of masters) {
        if (!wants(m.project)) continue;
        const mine = ids.filter(id => (missed[id] || []).includes(m.project));
        if (!mine.length) continue;
        const body = mine.length <= 5
          ? mine.join(', ')
          : `${mine.length} sessions — see the daemon log`;
        events.push({
          key: `muted:${m.sessionId}:${now}`, kind: 'muted-summary',
          project: m.project, masterSessionId: m.sessionId,
          at: new Date(now).toISOString(),
          line: `(history, no action implied) while Relaymote was not reporting, ${mine.length} session${mine.length === 1 ? '' : 's'} in your fleet changed state: ${body}`,
        });
        for (const id of mine) {
          for (const map of [state.mutedMissed, state.pendingHistory]) {
            if (!map || !map[id]) continue;
            const rest = map[id].filter(pr => pr !== m.project);
            if (rest.length) map[id] = rest; else delete map[id];
          }
        }
      }
    }
  }
  if (events.length) state.pending.push(...events);
  state.initialisedAt = state.initialisedAt || new Date(now).toISOString();
  saveState(state);

  const out = await flush(cfg, opts);
  return { enabled: true, firstRun, masters: masters.length, newEvents: events.length, ...out };
}

function pushEvent(evt, now = Date.now()) {
  if (!evt || !evt.key || !evt.line) return { queued: 0, reason: 'bad-event' };
  const masters = activeMasters(now);
  const owner = evt.sessionId ? ownerOf(evt.sessionId, masters) : null;
  const targets = evt.project ? masters.filter(m => m.project === evt.project)
    : owner ? [owner] : masters;
  if (!targets.length) return { queued: 0, reason: 'no-live-master' };
  const state = loadState();
  let queued = 0;
  for (const m of targets) {
    const key = `${evt.key}:${m.project}`;
    if (state.notified[key]) continue;
    state.notified[key] = new Date(now).toISOString();
    state.pending.push({ ...evt, key, project: m.project, masterSessionId: m.sessionId, at: new Date(now).toISOString() });
    queued++;
  }
  state.initialisedAt = state.initialisedAt || new Date(now).toISOString();
  saveState(state);
  return { queued, projects: targets.map(t => t.project) };
}

function status(opts = {}) {
  const state = loadState();
  const file = readFile();
  const project = opts.project || null;
  return {
    config: config(),
    ...(project ? { project, yourConfig: configFor(project) } : {}),
    perProject: file.byProject || {},
    lastChange: file.lastChange || null,
    initialisedAt: state.initialisedAt,
    pending: state.pending.map(e => ({ kind: e.kind, project: e.project, id: e.taskId || e.sessionId, at: e.at })),
    delivery: state.delivery,
    recent: state.log.slice(0, 10),
    masters: activeMasters().map(m => ({ project: m.project, sessionId: m.sessionId, fleetSize: m.fleet.length })),
  };
}

module.exports = {
  DEFAULTS, config, configFor, setConfig, status, PER_PROJECT_KEYS,
  loadState, saveState, activeMasters, ownerOf,
  scanTasks, scanSessions, composeMessage, taskLine, sessionLine, dueBatches, resolveTarget,
  flush, tick, pushEvent, _setSender, _setTaskSource, blank, conductorSessionId,
  alreadyBanked, _setBankedCheck,
};
