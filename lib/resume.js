'use strict';
const fs = require('fs');
const path = require('path');

const registry = require('./registry');
const desktop = require('./desktop');
const bridge = require('./bridge');

const sleep = ms => new Promise(r => setTimeout(r, ms));

function registryRoot() {
  return process.env.RELAYMOTE_DESKTOP_REGISTRY ||
    path.join(require('./config').APPDATA, 'Claude', 'claude-code-sessions');
}
function stateDir() { return process.env.RELAYMOTE_STATE_DIR || registry.STATE_DIR; }
const stateFile = () => path.join(stateDir(), 'resume-state.json');
const auditFile = () => path.join(stateDir(), 'master-audit.log');

const DEFAULTS = Object.freeze({
  enabled: true,
  graceMs: 30 * 1000,
  maxAgeMs: 24 * 60 * 60 * 1000,
  rateLimitRetryMs: 10 * 60 * 1000,
  unparsedResetMs: 5 * 60 * 60 * 1000,
  maxAttempts: 3,
  retryBackoffMs: 10 * 60 * 1000,
  selfResumeGraceMs: 2 * 60 * 1000,
  verifyMs: 20 * 1000,

  probeLeadMs: 120 * 60 * 1000,
  maxProbes: 6,
  probeStaggerMs: 5 * 1000,
  probeMinGapMs: 60 * 1000,
  defaultTz: 'Asia/Kolkata',
  continueMessage: 'continue where you left off',
  logKeep: 100,
});
let CFG = { ...DEFAULTS };
function config(patch) {
  if (patch && typeof patch === 'object') CFG = { ...CFG, ...patch };
  if (process.env.RELAYMOTE_RESUME === '0') return { ...CFG, enabled: false };
  return { ...CFG };
}

const LIMIT_RX = /(?:hit|reached) your (?:session|weekly|usage|plan(?:'s)?|5-?hour|[a-z]+ )?\s*(?:usage )?limit|usage limit reached|session limit resets|out of usage credits|out of extra usage/i;
const RATE_RX = /temporarily limiting requests|rate.?limited|\b429\b|overloaded/i;

function classify(error) {
  const e = String(error || '');
  if (!e) return null;
  if (LIMIT_RX.test(e)) return 'session-limit';
  if (RATE_RX.test(e)) return 'rate-limited';
  return null;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

function tzValid(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}
function tzParts(ms, tz) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
  const o = {};
  for (const p of f.formatToParts(new Date(ms))) if (p.type !== 'literal') o[p.type] = Number(p.value);
  if (o.hour === 24) o.hour = 0;
  return o;
}
function zonedToUtc(y, m, d, hh, mm, tz) {
  const want = Date.UTC(y, m - 1, d, hh, mm, 0);
  let guess = want;
  for (let i = 0; i < 3; i++) {
    const p = tzParts(guess, tz);
    const got = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    const diff = want - got;
    if (!diff) break;
    guess += diff;
  }
  return guess;
}

function parseReset(error, errorAt, defaultTz = CFG.defaultTz) {
  const text = String(error || '');
  const m = text.match(/resets?\s*(?:on|at|in)?\s*(?:([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s*(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?(?:\s*\(([^)]+)\))?/i);
  if (!m) return null;
  const [, monName, dayStr, hStr, minStr, ampmRaw, tzRaw] = m;
  let hh = Number(hStr), mm = Number(minStr || 0);
  const ampm = ampmRaw ? ampmRaw.replace(/\./g, '').toLowerCase() : null;
  if (ampm === 'pm' && hh < 12) hh += 12;
  if (ampm === 'am' && hh === 12) hh = 0;
  if (!(hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59)) return null;
  if (!ampm && !minStr) return null;

  let tz = tzRaw && tzValid(tzRaw.trim()) ? tzRaw.trim() : (tzValid(defaultTz) ? defaultTz : 'UTC');
  const base = Number(errorAt) || Date.now();
  const p = tzParts(base, tz);

  let y = p.year, mo = p.month, d = p.day;
  const month = monName ? MONTHS[monName.toLowerCase().slice(0, 4)] || MONTHS[monName.toLowerCase().slice(0, 3)] : null;
  if (month && dayStr) { mo = month; d = Number(dayStr); }
  let at = zonedToUtc(y, mo, d, hh, mm, tz);
  if (month && dayStr) {
    if (at < base - 24 * 3600 * 1000) at = zonedToUtc(y + 1, mo, d, hh, mm, tz);
  } else if (at <= base) {
    at = zonedToUtc(y, mo, d + 1, hh, mm, tz);
  }
  return { resetAt: at, tz, source: m[0].trim() };
}

let ROWS = null;
function _setRowSource(fn) { const prev = ROWS; ROWS = fn || null; return prev; }

function scanRegistry() {
  if (ROWS) return ROWS();
  const root = registryRoot();
  const best = new Map();
  let dirs;
  try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  const walk = (dir) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) { walk(fp); continue; }
      if (!/^local_.*\.json$/.test(e.name)) continue;
      let j;
      try { j = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { continue; }
      if (!j || !j.sessionId) continue;
      const row = {
        sessionId: j.sessionId, cliSessionId: j.cliSessionId || null, title: j.title || '', cwd: j.cwd || null,
        error: j.error || null, errorAt: Number(j.errorAt) || null,
        isArchived: !!j.isArchived, lastActivityAt: Number(j.lastActivityAt) || 0, file: fp,
      };
      const prev = best.get(j.sessionId);
      if (!prev || row.lastActivityAt > prev.lastActivityAt ||
          (row.lastActivityAt === prev.lastActivityAt && (row.errorAt || 0) > (prev.errorAt || 0))) best.set(j.sessionId, row);
    }
  };
  for (const d of dirs) if (d.isDirectory()) walk(path.join(root, d.name));
  return [...best.values()];
}

function readRow(sessionId) {
  return scanRegistry().find(r => r.sessionId === sessionId) || null;
}

function blank() {
  return {
    version: 2,
    sessions: {},
    lastRunAt: null,
    log: [],
    desktop: null,
    crashes: {},
    tickFailures: 0,
    lastTickError: null,
  };
}
function loadState() {
  try { return { ...blank(), ...JSON.parse(fs.readFileSync(stateFile(), 'utf8')) }; } catch { return blank(); }
}
function saveState(s) {
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    const tmp = stateFile() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
    fs.renameSync(tmp, stateFile());
  } catch {}
}
function audit(msg) {
  try { fs.appendFileSync(auditFile(), `[${new Date().toISOString()}] ${msg}\n`); } catch {}
}
const shortId = id => (String(id).length > 20 ? String(id).slice(0, 14) + '…' : String(id));
const clip = (s, n) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

function probeKey(c) {
  return c.sessionId + ':' + (c.kind || 'limit') + ':' + (c.resetAt || c.errorAt || 0);
}

function probePlan(c, now, cfg, state) {
  const rec = (state.probes || {})[probeKey(c)] || { count: 0, lastAt: 0 };
  const used = rec.count || 0;
  const out = { probesUsed: used, nextProbeAt: null, probeDue: false };
  if (c.kind !== 'session-limit') return out;
  if (now >= c.dueAt) return out;
  if (used >= cfg.maxProbes) return out;
  const window = cfg.probeLeadMs / Math.pow(2, used);
  const fireAt = c.dueAt - window;
  out.nextProbeAt = fireAt;
  if (now < fireAt) return out;
  if (rec.lastAt && now - rec.lastAt < cfg.probeMinGapMs) return out;
  out.probeDue = true;
  return out;
}

function noteProbe(c, now = Date.now()) {
  const st = loadState();
  st.probes = st.probes || {};
  const k = probeKey(c);
  const rec = st.probes[k] || { count: 0 };
  rec.count = (rec.count || 0) + 1;
  rec.lastAt = now;
  rec.sessionId = c.sessionId;
  rec.resetAt = c.resetAt || null;
  st.probes[k] = rec;
  for (const [key, r] of Object.entries(st.probes)) {
    if (r.lastAt && now - r.lastAt > 24 * 3600 * 1000) delete st.probes[key];
  }
  saveState(st);
  return rec.count;
}

function candidates(now = Date.now(), opts = {}) {
  const cfg = config();
  const state = loadState();
  const out = [];
  let tIdx = null;
  const TRANSCRIPT_WINDOW_MS = 8 * 24 * 3600 * 1000;
  for (let r of scanRegistry()) {
    if (r.isArchived) continue;
    let source = 'registry';
    if (!classify(r.error) && r.cliSessionId && !opts.registryOnly) {
      if (!tIdx) tIdx = transcriptIndex();
      const tr = tIdx.get(r.cliSessionId);
      if (tr && now - tr.mtime <= TRANSCRIPT_WINDOW_MS) {
        const t = transcriptLimitStop(tr.file);
        if (t && t.errorAt) { r = { ...r, error: t.error, errorAt: t.errorAt }; source = 'transcript'; }
      }
    }
    const kind = classify(r.error);
    if (!kind || !r.errorAt) continue;

    let resetAt = null, tz = null, resetSource = null;
    if (kind === 'session-limit') {
      const p = parseReset(r.error, r.errorAt, cfg.defaultTz);
      if (p) { resetAt = p.resetAt; tz = p.tz; resetSource = p.source; }
      else resetAt = r.errorAt + cfg.unparsedResetMs;
    } else {
      resetAt = r.errorAt + cfg.rateLimitRetryMs;
    }
    if (now - Math.max(r.errorAt, resetAt || 0) > cfg.maxAgeMs && !opts.force) continue;
    const dueAt = resetAt + cfg.graceMs;
    const st = state.sessions[r.sessionId];
    const sameStop = st && st.errorAt === r.errorAt;
    const attempts = sameStop ? (st.attempts || 0) : 0;
    const lastAttemptAt = sameStop ? Date.parse(st.lastAttemptAt || 0) || 0 : 0;

    let skip = null;
    if (!opts.force) {
      if (attempts >= cfg.maxAttempts) skip = `gave up after ${attempts} attempts on this stop`;
      else if (lastAttemptAt && now - lastAttemptAt < cfg.retryBackoffMs) skip = `retried ${Math.round((now - lastAttemptAt) / 60000)} min ago; backing off`;
    }
    out.push({
      sessionId: r.sessionId, title: r.title, cwd: r.cwd, kind, error: r.error, errorAt: r.errorAt, source,
      resetAt, tz, resetSource, resetParsed: kind !== 'session-limit' || !!resetSource,
      dueAt, due: now >= dueAt, attempts, lastResult: sameStop ? st.lastResult : undefined, skip,
    });
    const c0 = out[out.length - 1];
    const plan = probePlan(c0, now, cfg, state);
    c0.probesUsed = plan.probesUsed;
    c0.nextProbeAt = plan.nextProbeAt;
    c0.probeDue = !opts.force && !skip && plan.probeDue;
    c0.waitingReason = c0.due ? null
      : skip ? skip
      : plan.nextProbeAt ? `waiting for the limit to lift; probing early at ${new Date(plan.nextProbeAt).toISOString()} (${plan.probesUsed}/${cfg.maxProbes} probes used), giving up and waiting for ${new Date(dueAt).toISOString()} after that`
      : `waiting for the parsed reset ${new Date(dueAt).toISOString()} (early probes exhausted: ${plan.probesUsed}/${cfg.maxProbes})`;
  }
  out.sort((a, b) => a.dueAt - b.dueAt);
  return out;
}
function hasDue(now = Date.now()) {
  return config().enabled && candidates(now).some(c => (c.due || c.probeDue) && !c.skip);
}

async function resumeOne(sessionId, opts = {}) {
  const cfg = config();
  if (!sessionId) return { ok: false, result: 'not-found', error: 'NO_SESSION_ID' };
  const conn = await desktop.connect(await desktop.wsUrl(), { evalTimeout: 60000 });
  const marks = [];
  let step = 'connect';
  const at = async (name, fn) => { step = name; const t = Date.now(); try { return await fn(); } finally { marks.push(`${name} ${Date.now() - t}ms`); } };
  let original = null;
  const CIDp = desktop.pickChat(conn);
  try {
    const CID = await at('pick-window', () => CIDp);
    const open = await at('open-session', () => desktop.ensureSessionOpen(conn, CID, sessionId, {}));
    if (!open.ok) return { ok: false, result: open.error || 'nav-failed', sessionId, detail: open, marks };
    original = open.restore || null;

    await at('dismiss-menus', () => desktop.dismissStrayMenus(conn, CID));
    let park = await at('park-composer', () => desktop.parkComposer(conn, CID, sessionId));
    const cover = desktop.classifyCover(park);
    if (park !== 'ok') {
      const out = { ok: false, result: cover ? cover.result : park, sessionId, marks };
      if (cover) out.blockerText = cover.blockerText;
      return out;
    }

    const decision = await at('decide', () => conn.evaluate(desktop.rEval(CID, `
      (async function(){
        var el=window.__batonComposer;
        if(!el || !el.isConnected || !el.editor) return JSON.stringify({mode:'no-editor'});
        if(location.href.split('/').pop() !== ${JSON.stringify(sessionId)}) return JSON.stringify({mode:'nav-lost'});
        if(window.__batonLiveBtn('Stop')) return JSON.stringify({mode:'already-running'});
        if(window.__batonLiveBtn('Remove queued message')) return JSON.stringify({mode:'already-queued'});
        var draft=(el.textContent||'').trim();
        var hits=function(b){ var r=b.getBoundingClientRect(); if(!r.width||!r.height) return false;
          var h=document.elementFromPoint(r.left+r.width/2, r.top+r.height/2); return !!(h && b.contains(h)); };
        if(draft){
          el.editor.commands.focus();
          var b=null;
          for(var i=0;i<15;i++){ await new Promise(function(r){setTimeout(r,100);}); b=window.__batonLiveBtn('Send'); if(b && !b.disabled) break; }
          if(location.href.split('/').pop() !== ${JSON.stringify(sessionId)}) return JSON.stringify({mode:'nav-lost'});
          if(b && !b.disabled){ window.__batonSendBtn=b; return JSON.stringify({mode:'draft', preview:draft.slice(0,80), len:draft.length}); }
          return JSON.stringify({mode:'draft-blocked', preview:draft.slice(0,80), len:draft.length});
        }
        var btns=Array.from(document.querySelectorAll('button'));
        for(var k=0;k<btns.length;k++){
          var bt=btns[k]; var t=(bt.textContent||'').trim().toLowerCase();
          if(!/^(retry|try again)$/.test(t)) continue;
          if(bt.closest('[data-row-key]')) continue;
          if(!hits(bt)) continue;
          window.__batonRetryBtn=bt; return JSON.stringify({mode:'retry', label:t});
        }
        return JSON.stringify({mode:'empty'});
      })()`)));
    let d; try { d = JSON.parse(decision); } catch { d = { mode: String(decision) }; }

    if (opts.probe) {
      await conn.evaluate(desktop.rEval(CID, `(function(){ window.__batonSendBtn=null; window.__batonRetryBtn=null; return 1; })()`)).catch(() => {});
      await desktop.releaseComposer(conn, CID);
      if (original) await desktop.restoreActive(conn, CID, original);
      return { ok: true, probe: true, result: 'probe', wouldDo: d.mode === 'draft' ? 'resend-draft' : d.mode === 'retry' ? 'retry' : d.mode === 'empty' ? 'send-continue' : 'nothing',
               decision: d, sessionId, restored: original, marks, note: 'Nothing was clicked or sent.' };
    }

    if (d.mode === 'already-running' || d.mode === 'already-queued') {
      return { ok: true, result: d.mode, mode: d.mode, verified: 'running', sessionId, restored: original, marks,
               note: 'The session was already moving again; nothing was sent.' };
    }
    if (d.mode === 'no-editor' || d.mode === 'nav-lost' || d.mode === 'draft-blocked') {
      return { ok: false, result: d.mode, mode: d.mode, sessionId, draftPreview: d.preview, restored: original, marks };
    }

    let mode = d.mode;
    if (d.mode === 'draft' || d.mode === 'retry') {
      const which = d.mode === 'draft' ? '__batonSendBtn' : '__batonRetryBtn';
      const fired = await at('click', () => conn.evaluate(desktop.rEval(CID, `
        (function(){ var b=window.${which}; window.${which}=null;
          if(!b || !b.isConnected) return 'gone';
          if(location.href.split('/').pop() !== ${JSON.stringify(sessionId)}) return 'nav-lost';
          setTimeout(function(){ try{ b.click(); }catch(e){} }, 0); return 'fired'; })()`)));
      if (fired !== 'fired') return { ok: false, result: fired, mode, sessionId, restored: original, marks };
      mode = d.mode === 'draft' ? 'resent-draft' : 'retried';
    } else {
      await desktop.releaseComposer(conn, CID);
      const s = await at('send-continue', () => desktop.sendMessageNow(sessionId, opts.message || cfg.continueMessage, { idle: false, protect: false }));
      if (!s || !s.ok) return { ok: false, result: (s && (s.result || s.error)) || 'send-failed', mode: 'continue', sessionId, restored: original, marks, detail: s };
      mode = 'sent-continue';
    }

    let verified = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 6000 && !verified) {
      await sleep(300);
      try {
        const g = await conn.evaluate(desktop.rEval(CID, `(function(){ var f=window.__batonLiveBtn; return (f && f('Stop')) ? '1' : (document.querySelector('button[aria-label="Stop"]') ? '1' : ''); })()`));
        if (g === '1') verified = 'running';
      } catch {}
    }
    await desktop.releaseComposer(conn, CID);
    if (original) { await desktop.restoreActive(conn, CID, original); }
    const deadline = t0 + Math.max(cfg.verifyMs, 6000);
    while (!verified && Date.now() < deadline) {
      await sleep(1000);
      const row = readRow(sessionId);
      if (row && !row.error) { verified = 'error-cleared'; break; }
      try {
        const snap = JSON.parse(await conn.evaluate(desktop.rEval(CID, desktop.SCRAPE_JS)));
        const s = snap.sessions.find(x => x.id === sessionId);
        if (s && s.running) { verified = 'running'; break; }
      } catch {}
    }
    return { ok: !!verified, result: verified ? 'resumed' : 'unverified', mode, verified, sessionId,
             draftPreview: d.preview, restored: original, marks };
  } catch (e) {
    throw new Error(`${e.message} at step "${step}" (${marks.join(', ') || 'no step completed'})`);
  } finally { conn.close(); }
}
const resumeSession = desktop.gated('resumeSession', resumeOne);

function emit(kind, c, r, source) {
  let notify;
  try { notify = require('./notify'); } catch { return { queued: 0 }; }
  if (typeof notify.pushEvent !== 'function') return { queued: 0 };
  const id = c.sessionId;
  const why = c.kind === 'crash' ? `was mid-turn when Claude Desktop crashed (${c.reason})` : `was stopped by "${clip(c.error, 60)}"`;
  const tag = r.mode === 'self-resume' ? 'SELF-RESUMED' : 'RESUMED';
  const line = r.ok
    ? `${tag} ${shortId(id)} "${clip(c.title, 60)}" — ${why}; ${r.mode === 'self-resume' ? 'came back on its own' : (r.mode || 'resumed') + ' via ' + (r.via || '?') + ', verified ' + r.verified}\n       id: ${id}`
    : `STILL STUCK ${shortId(id)} "${clip(c.title, 60)}" — ${why}; resume ${r.result}${r.blockerText ? ' (' + clip(r.blockerText, 60) + ')' : ''} · relaymote_resume session_ids:["${id}"] force:true\n       id: ${id}`;
  return notify.pushEvent({
    key: `resume:${id}:${c.errorAt || c.crashKey || 0}:${kind}:${r.attempt || 0}`,
    kind, sessionId: id, line, source,
  });
}

async function deliver(sessionId, text, opts = {}) {
  if (opts.via === 'composer') {
    if (opts.allowUi === false) {
      return { ok: false, via: 'composer', result: 'composer-forced-but-ui-disabled',
               detail: { message: 'via:"composer" and ui:false contradict each other.' } };
    }
    let r;
    try { r = await resumeSession(sessionId, { idle: opts.idle, idleMaxWaitMs: opts.idleMaxWaitMs, message: text }); }
    catch (e) { r = { ok: false, result: 'error', error: e.message }; }
    return { ...r, via: 'composer', forced: true };
  }
  let b;
  try { b = await bridge.sendMessage(sessionId, text, { initiator: opts.initiator || 'baton-resume' }); }
  catch (e) { b = { ok: false, error: 'BRIDGE_THREW', reason: e.message }; }
  if (b.ok) return { ok: true, via: 'bridge', mode: b.queued ? 'bridge-queued' : 'bridge-sent', result: 'delivered', detail: { queued: b.queued, pending: b.pending } };
  if (b.error === 'NO_SUCH_SESSION' || b.error === 'ARCHIVED') return { ok: false, via: 'bridge', result: b.error, detail: b };
  if (opts.allowUi === false) return { ok: false, via: 'bridge', result: b.error || b.reason || 'bridge-failed', detail: b };
  let r;
  try { r = await resumeSession(sessionId, { idle: opts.idle, idleMaxWaitMs: opts.idleMaxWaitMs, message: text }); }
  catch (e) { r = { ok: false, result: 'error', error: e.message }; }
  return { ...r, via: 'composer', bridgeError: b.error || b.reason || null };
}

async function verifyResumed(sessionId, { kind, deadlineMs }) {
  const t0 = Date.now();
  while (Date.now() - t0 < deadlineMs) {
    try {
      const s = await bridge.sessionState(sessionId);
      if (s && s.ok && s.session && s.session.isRunning) return 'running';
      if (kind === 'limit' && s && s.ok && s.session && !s.session.error) {
        const row = readRow(sessionId);
        if (row && !row.error) return 'error-cleared';
      }
    } catch {}
    if (kind === 'limit') { const row = readRow(sessionId); if (row && !row.error) return 'error-cleared'; }
    await sleep(1000);
  }
  return null;
}

async function attempt(sessionId, text, { kind, initiator, allowUi, via, idle, idleMaxWaitMs, verifyMs }) {
  const d = await deliver(sessionId, text, { initiator, allowUi, via, idle, idleMaxWaitMs });
  if (!d.ok) return d;
  if (d.via === 'composer') return d;
  const verified = await verifyResumed(sessionId, { kind, deadlineMs: verifyMs });
  return { ...d, ok: !!verified, result: verified ? 'resumed' : 'unverified', verified };
}

let running = false;
async function run(opts = {}) {
  const cfg = config();
  const now = Date.now();
  const source = opts.source || 'manual';
  const wanted = Array.isArray(opts.sessionIds) && opts.sessionIds.length ? new Set(opts.sessionIds) : null;

  let cands = candidates(now, { force: !!opts.force });
  if (wanted) {
    const have = new Set(cands.map(c => c.sessionId));
    for (const id of wanted) {
      if (have.has(id)) continue;
      const row = readRow(id);
      cands.push(row
        ? { sessionId: id, title: row.title, kind: classify(row.error) || 'none', error: row.error, errorAt: row.errorAt, resetAt: null, dueAt: now, due: true, attempts: 0,
            skip: opts.force ? null : (row.error ? 'error is not a usage/rate limit' : 'no error recorded on this session — it is not stuck') }
        : { sessionId: id, title: '', kind: 'none', error: null, errorAt: null, resetAt: null, dueAt: now, due: true, attempts: 0, skip: 'no registry row for this id' });
    }
    cands = cands.filter(c => wanted.has(c.sessionId));
  }

  const todo = cands.filter(c => (opts.force || ((c.due || c.probeDue) && !c.skip)));
  const waiting = cands.filter(c => !todo.includes(c));
  const out = { ok: true, source, at: new Date(now).toISOString(), enabled: cfg.enabled, dryRun: !!opts.dryRun,
                attempted: [], waiting: waiting.map(w => ({ sessionId: w.sessionId, title: w.title, dueAt: new Date(w.dueAt).toISOString(), due: w.due, skip: w.skip, attempts: w.attempts })) };
  if (!cfg.enabled && !opts.force) { out.ok = false; out.error = 'DISABLED'; return out; }
  if (opts.dryRun || !todo.length) { out.wouldResume = todo.map(t => ({ sessionId: t.sessionId, title: t.title, error: t.error, dueAt: new Date(t.dueAt).toISOString() })); return out; }
  if (running) { out.ok = false; out.error = 'ALREADY_RUNNING'; return out; }
  running = true;
  out.deferredToApp = [];
  let live = {};
  try { live = await bridge.listStates(todo.map(c => c.sessionId)); } catch {}
  try {
    for (const c of todo) {
      const l = live[c.sessionId] || null;
      const resetAt = c.resetAt || c.errorAt || now;

      const row0 = readRow(c.sessionId);
      const cameBack = (l && l.isRunning) || (row0 && !row0.error && (!c.errorAt || (row0.errorAt || 0) !== c.errorAt));
      if (cameBack && !opts.force) {
        const fresh = loadState();
        fresh.sessions[c.sessionId] = { errorAt: c.errorAt, title: c.title, error: c.error, attempts: (loadState().sessions[c.sessionId] || {}).attempts || 0, lastAttemptAt: new Date().toISOString(), lastResult: 'self-resumed', resumedAt: new Date().toISOString() };
        fresh.lastRunAt = new Date().toISOString();
        fresh.log.unshift({ at: new Date().toISOString(), sessionId: c.sessionId, title: c.title, source, ok: true, result: 'self-resumed', via: 'app' });
        fresh.log = fresh.log.slice(0, cfg.logKeep);
        saveState(fresh);
        audit(`RESUME (${source}) ${c.sessionId} "${clip(c.title, 60)}": SELF-RESUMED — the app/session came back on its own`);
        const notified = emit('session-self-resumed', c, { ok: true, mode: 'self-resume', via: 'app', verified: 'running' }, source);
        out.attempted.push({ sessionId: c.sessionId, title: c.title, verdict: 'SELF-RESUMED', ok: true, result: 'self-resumed', via: 'app', notified: notified.queued });
        continue;
      }

      if (l && l.willSelfResume && !opts.force && now < resetAt + cfg.selfResumeGraceMs) {
        out.deferredToApp.push({ sessionId: c.sessionId, title: c.title, reason: l.selfResumeReason || 'app will self-resume', forceAt: new Date(resetAt + cfg.selfResumeGraceMs).toISOString() });
        continue;
      }

      if (c.probeDue && !c.due && !opts.force) {
        const n = noteProbe(c, Date.now());
        const pr = await attempt(c.sessionId, opts.message || cfg.continueMessage,
          { kind: 'limit', initiator: 'baton-limit-probe', allowUi: false, via: opts.via,
            idle: opts.idle, idleMaxWaitMs: opts.idleMaxWaitMs, verifyMs: cfg.verifyMs });
        const early = Math.round((c.dueAt - Date.now()) / 60000);
        if (pr.ok) {
          const fresh = loadState();
          fresh.sessions[c.sessionId] = { errorAt: c.errorAt, title: c.title, error: c.error,
            attempts: (fresh.sessions[c.sessionId] || {}).attempts || 0,
            lastAttemptAt: new Date().toISOString(), lastResult: pr.result, lastMode: pr.mode || null,
            resumedAt: new Date().toISOString() };
          fresh.lastRunAt = new Date().toISOString();
          fresh.log.unshift({ at: new Date().toISOString(), sessionId: c.sessionId, title: c.title,
            source, probe: n, ok: true, result: pr.result, mode: pr.mode || null, via: pr.via || null,
            verified: pr.verified || null, earlyByMin: early });
          fresh.log = fresh.log.slice(0, cfg.logKeep);
          saveState(fresh);
          audit(`RESUME (${source}) ${c.sessionId} "${clip(c.title, 60)}" PROBE ${n}/${cfg.maxProbes}: RESUMED ${early} min BEFORE the parsed reset — the reset time was conservative`);
          const notified = emit('session-resumed', c, pr, source);
          out.attempted.push({ sessionId: c.sessionId, title: c.title, probe: n, earlyByMin: early,
            verdict: 'RESUMED', ok: true, result: pr.result, mode: pr.mode || null, via: pr.via || null,
            verified: pr.verified || null, notified: notified.queued });
        } else if (pr.result === 'USER_ACTIVE') {
          out.attempted.push({ sessionId: c.sessionId, title: c.title, probe: n, verdict: 'DEFERRED', ok: false, result: pr.result });
          out.deferred = true;
          break;
        } else {
          audit(`RESUME (${source}) ${c.sessionId} "${clip(c.title, 60)}" PROBE ${n}/${cfg.maxProbes}: still limited (${pr.result}) — ${early} min before parsed reset; no attempt spent`);
          out.attempted.push({ sessionId: c.sessionId, title: c.title, probe: n, earlyByMin: early,
            verdict: 'STILL LIMITED (probe)', ok: false, result: pr.result, notified: 0 });
        }
        await sleep(cfg.probeStaggerMs);
        continue;
      }

      const state = loadState();
      const prev = state.sessions[c.sessionId];
      const same = prev && prev.errorAt === c.errorAt;
      const attemptNo = (same ? prev.attempts || 0 : 0) + 1;
      const r = await attempt(c.sessionId, opts.message || cfg.continueMessage,
        { kind: 'limit', initiator: 'baton-limit-resume', allowUi: opts.ui !== false, via: opts.via, idle: opts.idle, idleMaxWaitMs: opts.idleMaxWaitMs, verifyMs: cfg.verifyMs });
      r.attempt = attemptNo;
      const rec = { errorAt: c.errorAt, title: c.title, error: c.error, attempts: attemptNo,
                    lastAttemptAt: new Date().toISOString(), lastResult: r.result, lastMode: r.mode || null,
                    resumedAt: r.ok ? new Date().toISOString() : (same ? prev.resumedAt : null) };
      const fresh = loadState();
      fresh.sessions[c.sessionId] = rec;
      fresh.lastRunAt = new Date().toISOString();
      fresh.log.unshift({ at: rec.lastAttemptAt, sessionId: c.sessionId, title: c.title, source, attempt: attemptNo, ok: !!r.ok, result: r.result, mode: r.mode || null, via: r.via || null, verified: r.verified || null, error: r.error || null });
      fresh.log = fresh.log.slice(0, cfg.logKeep);
      for (const [id, s] of Object.entries(fresh.sessions)) if (s.errorAt && now - s.errorAt > 7 * 24 * 3600 * 1000) delete fresh.sessions[id];
      saveState(fresh);

      const verdict = r.ok ? 'RESUMED' : (r.result === 'USER_ACTIVE' ? 'DEFERRED' : 'STILL STUCK');
      audit(`RESUME (${source}) ${c.sessionId} "${clip(c.title, 60)}" attempt ${attemptNo}: ${verdict} — ${r.mode || ''} ${r.result} via ${r.via || '?'}${r.verified ? ' verified=' + r.verified : ''}${r.error ? ' ' + clip(r.error, 120) : ''}`);
      let notified = { queued: 0 };
      if (verdict !== 'DEFERRED') notified = emit(r.ok ? 'session-resumed' : 'session-stuck', c, r, source);
      out.attempted.push({ sessionId: c.sessionId, title: c.title, error: c.error, attempt: attemptNo, verdict, ok: !!r.ok, result: r.result, mode: r.mode || null, via: r.via || null,
                           verified: r.verified || null, draftPreview: r.draftPreview, error_detail: r.error || r.blockerText || (r.detail && (r.detail.reason || r.detail.error)) || null,
                           idleWaitedMs: r.idleWaitedMs, notified: notified.queued });
      if (verdict === 'DEFERRED') { out.deferred = true; break; }
      await sleep(1200);
    }
  } finally { running = false; }
  out.resumed = out.attempted.filter(a => a.ok && a.verdict === 'RESUMED').map(a => a.sessionId);
  out.selfResumed = out.attempted.filter(a => a.verdict === 'SELF-RESUMED').map(a => a.sessionId);
  out.stuck = out.attempted.filter(a => !a.ok && a.verdict !== 'DEFERRED').map(a => a.sessionId);
  return out;
}

const CRASH_DEFAULTS = Object.freeze({
  crashMessage: 'Claude Desktop crashed and restarted — continue exactly where you stopped.',
  crashWindowMs: 60 * 60 * 1000,
  crashSettleMs: 60 * 1000,
  crashGraceMs: 15 * 1000,
});
Object.assign(CFG, CRASH_DEFAULTS);

let PROC = () => bridge.desktopProcess();
function _setProcSource(fn) { const prev = PROC; PROC = fn || (() => bridge.desktopProcess()); return prev; }
let TRANSCRIPT_ROOT = null;
function transcriptRoot() { return TRANSCRIPT_ROOT || process.env.RELAYMOTE_TRANSCRIPTS || path.join(require('./config').CLAUDE_HOME, 'projects'); }
function _setTranscriptRoot(p) { const prev = TRANSCRIPT_ROOT; TRANSCRIPT_ROOT = p || null; return prev; }

function transcriptIndex() {
  const out = new Map();
  let dirs = [];
  try { dirs = fs.readdirSync(transcriptRoot()); } catch { return out; }
  for (const d of dirs) {
    let files = [];
    try { files = fs.readdirSync(path.join(transcriptRoot(), d)); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const fp = path.join(transcriptRoot(), d, f);
      let mtime = 0; try { mtime = fs.statSync(fp).mtimeMs; } catch {}
      out.set(f.slice(0, -6), { file: fp, mtime });
    }
  }
  return out;
}

function transcriptTail(file, tailBytes = 96 * 1024) {
  let buf;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, tailBytes);
      buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
    } finally { fs.closeSync(fd); }
  } catch { return { state: 'empty', lastAt: null }; }
  const lines = buf.toString('utf8').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (r.type !== 'user' && r.type !== 'assistant') continue;
    if (r.isMeta) continue;
    const at = Date.parse(r.timestamp || '') || null;
    const content = r.message && r.message.content;
    const blocks = Array.isArray(content) ? content : [];
    if (r.type === 'assistant') {
      if (blocks.some(b => b && b.type === 'tool_use')) return { state: 'tool_use_pending', lastAt: at, lastType: 'assistant/tool_use' };
      return { state: 'complete', lastAt: at, lastType: 'assistant/text' };
    }
    const text = typeof content === 'string' ? content : blocks.map(b => (b && (b.text || '')) || '').join(' ');
    if (/\[Request interrupted by user/i.test(text)) return { state: 'complete', lastAt: at, lastType: 'user/interrupted' };
    const isToolResult = blocks.some(b => b && b.type === 'tool_result');
    return { state: 'unanswered', lastAt: at, lastType: isToolResult ? 'user/tool_result' : 'user/text' };
  }
  return { state: 'empty', lastAt: null };
}

function isHarnessNoise(r, text) {
  if (r.type === 'user') {
    if (r.isMeta) return true;
    if (r.origin && r.origin.kind === 'task-notification') return true;
    if (/^\s*<task-notification>/.test(text)) return true;
    return false;
  }
  if (r.type === 'assistant') {
    const m = r.message || {};
    return m.model === '<synthetic>' && !r.isApiErrorMessage && !(LIMIT_RX.test(text) || RATE_RX.test(text));
  }
  return false;
}
function entryText(r) {
  const c = r.message && r.message.content;
  if (typeof c === 'string') return c;
  return (Array.isArray(c) ? c : []).map(b => (b && (b.text || (typeof b.content === 'string' ? b.content : ''))) || '').join(' ');
}
function transcriptLimitStop(file, tailBytes = 256 * 1024) {
  let buf;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, tailBytes);
      buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
    } finally { fs.closeSync(fd); }
  } catch { return null; }
  const lines = buf.toString('utf8').split('\n');
  let noise = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (r.type !== 'user' && r.type !== 'assistant') continue;
    const text = entryText(r);
    if (isHarnessNoise(r, text)) { noise++; continue; }
    if (r.type === 'assistant') {
      const m = r.message || {};
      const flagged = m.model === '<synthetic>' || r.isApiErrorMessage === true;
      if (flagged && text.length <= 400 && (LIMIT_RX.test(text) || RATE_RX.test(text))) {
        return { error: text.trim(), errorAt: Date.parse(r.timestamp || '') || null, noise };
      }
    }
    return null;
  }
  return null;
}

async function noteDesktop(now = Date.now()) {
  const st = loadState();
  let proc = null;
  try { proc = await PROC(); } catch {}
  if (!proc || !proc.pid) {
    if (st.desktop && !st.desktop.downSince) { st.desktop.downSince = new Date(now).toISOString(); saveState(st); }
    return { pid: null, crashDetected: false, downSince: st.desktop && st.desktop.downSince };
  }
  let crashDetected = false;
  const prev = st.desktop;
  if (prev && prev.pid && prev.pid !== proc.pid && !st.crashes[proc.pid]) {
    st.crashes[proc.pid] = {
      detectedAt: new Date(now).toISOString(), prevPid: prev.pid, desktopStartedAt: proc.startedAt,
      prevRunning: prev.running || [], prevRunningAt: prev.runningAt || null, handledAt: null, results: null,
    };
    const keys = Object.keys(st.crashes); if (keys.length > 5) for (const k of keys.slice(0, keys.length - 5)) delete st.crashes[k];
    crashDetected = true;
  }
  const snap = desktop.loadSnapshot();
  let running = prev && prev.pid === proc.pid ? (prev.running || []) : [];
  let runningAt = prev && prev.pid === proc.pid ? (prev.runningAt || null) : null;
  if (snap && snap.at && Date.parse(snap.at) >= (proc.startedAt || 0)) {
    running = (snap.sessions || []).filter(s => s && (s.running || s.state === 'running')).map(s => s.sessionId);
    runningAt = snap.at;
  }
  st.desktop = { pid: proc.pid, startedAt: proc.startedAt, lastSeenAt: new Date(now).toISOString(), running, runningAt };
  saveState(st);
  return { pid: proc.pid, crashDetected, startedAt: proc.startedAt };
}

async function crashCandidates(crash, now = Date.now(), opts = {}) {
  const cfg = config();
  const crashAt = crash.desktopStartedAt || Date.parse(crash.detectedAt) || now;
  const from = crashAt - cfg.crashWindowMs, until = crashAt + cfg.crashGraceMs;
  const idx = transcriptIndex();
  const rows = scanRegistry();
  let live = {};
  try { live = await bridge.listStates(); } catch {}
  const prevRunning = new Set(crash.prevRunning || []);
  const out = [];
  for (const r of rows) {
    if (r.isArchived) continue;
    if (classify(r.error)) continue;
    const tr = r.cliSessionId ? idx.get(r.cliSessionId) : null;
    const wasRunning = prevRunning.has(r.sessionId);
    if (!wasRunning && !(tr && tr.mtime >= from)) continue;
    const tail = tr ? transcriptTail(tr.file) : { state: 'empty', lastAt: null };
    const lastAt = tail.lastAt || (tr ? tr.mtime : null) || r.lastActivityAt || 0;
    let reason = null, skip = null;
    if (tail.state === 'tool_use_pending') reason = 'tool call never answered';
    else if (tail.state === 'unanswered') reason = tail.lastType === 'user/text' ? 'user prompt never answered' : 'tool result never processed';
    else if (wasRunning) reason = 'was Running in the last snapshot before the crash';
    if (!reason) continue;
    if (lastAt && lastAt < from) skip = `last activity ${Math.round((crashAt - lastAt) / 60000)} min before the crash — outside the window`;
    else if (lastAt && lastAt > until) skip = 'active again after the restart — already handled';
    const l = live[r.sessionId];
    if (!skip && l && l.isRunning) skip = 'already Running';
    if (!skip && l && l.willSelfResume) skip = `the app will resume it itself (${l.selfResumeReason || 'willSelfResume'})`;
    if (!skip && l && l.isArchived) skip = 'archived';
    if (!skip && opts.exclude && opts.exclude.includes(r.sessionId)) skip = 'excluded';
    out.push({ sessionId: r.sessionId, title: r.title, cwd: r.cwd, kind: 'crash', reason, tail: tail.lastType || tail.state,
               lastAt: lastAt ? new Date(lastAt).toISOString() : null, wasRunning, skip, crashKey: crash.desktopStartedAt || crash.detectedAt });
  }
  out.sort((a, b) => (a.lastAt || '').localeCompare(b.lastAt || ''));
  return out;
}

let crashRunning = false;
async function runCrash(opts = {}) {
  const cfg = config();
  const now = Date.now();
  const source = opts.source || 'manual';
  let st = loadState();
  let crash = null, key = null;
  if (opts.crash === true || opts.force) {
    let proc = null; try { proc = await PROC(); } catch {}
    if (!proc) return { ok: false, error: 'DESKTOP_DOWN', message: 'Claude Desktop is not reachable on the debugger port.' };
    key = String(proc.pid);
    crash = st.crashes[key] || { detectedAt: new Date(now).toISOString(), prevPid: null, desktopStartedAt: proc.startedAt, prevRunning: [], handledAt: null, results: null, synthesized: true };
  } else {
    const pending = Object.entries(st.crashes).filter(([, c]) => c && !c.handledAt).sort((a, b) => Date.parse(a[1].detectedAt) - Date.parse(b[1].detectedAt));
    if (!pending.length) return { ok: true, nothing: true, note: 'no unhandled Desktop restart on record' };
    [key, crash] = pending[pending.length - 1];
  }
  const sinceStart = now - (crash.desktopStartedAt || now);
  if (sinceStart < cfg.crashSettleMs && !opts.force) return { ok: true, waiting: true, settleInMs: cfg.crashSettleMs - sinceStart, crash: key };

  const cands = await crashCandidates(crash, now, opts);
  const wanted = Array.isArray(opts.sessionIds) && opts.sessionIds.length ? new Set(opts.sessionIds) : null;
  const todo = cands.filter(c => (wanted ? wanted.has(c.sessionId) : true) && (!c.skip || opts.force));
  const out = { ok: true, source, crash: { pid: key, prevPid: crash.prevPid, desktopStartedAt: new Date(crash.desktopStartedAt || 0).toISOString(), detectedAt: crash.detectedAt, prevRunning: (crash.prevRunning || []).length, synthesized: !!crash.synthesized },
                dryRun: !!opts.dryRun, candidates: cands.map(c => ({ sessionId: c.sessionId, title: c.title, reason: c.reason, tail: c.tail, lastAt: c.lastAt, wasRunning: c.wasRunning, skip: c.skip })), attempted: [] };
  if (opts.dryRun) { out.wouldResume = todo.map(t => t.sessionId); return out; }
  if (crashRunning) { out.ok = false; out.error = 'ALREADY_RUNNING'; return out; }
  crashRunning = true;
  try {
    for (const c of todo) {
      const r = await attempt(c.sessionId, opts.message || cfg.crashMessage,
        { kind: 'crash', initiator: 'baton-crash-resume', allowUi: opts.ui !== false, via: opts.via, idle: opts.idle, idleMaxWaitMs: opts.idleMaxWaitMs, verifyMs: cfg.verifyMs });
      r.attempt = 1;
      const verdict = r.ok ? 'RESUMED' : (r.result === 'USER_ACTIVE' ? 'DEFERRED' : 'STILL STUCK');
      audit(`CRASH-RESUME (${source}) ${c.sessionId} "${clip(c.title, 60)}" [${c.reason}]: ${verdict} — ${r.mode || ''} ${r.result} via ${r.via || '?'}${r.verified ? ' verified=' + r.verified : ''}${r.error ? ' ' + clip(r.error, 120) : ''}`);
      let notified = { queued: 0 };
      if (verdict !== 'DEFERRED') notified = emit(r.ok ? 'session-crash-resumed' : 'session-crash-stuck', c, r, source);
      out.attempted.push({ sessionId: c.sessionId, title: c.title, reason: c.reason, verdict, ok: !!r.ok, result: r.result, mode: r.mode || null, via: r.via || null,
                           verified: r.verified || null, error_detail: r.error || r.blockerText || (r.detail && (r.detail.reason || r.detail.error)) || null, notified: notified.queued });
      st = loadState();
      st.log.unshift({ at: new Date().toISOString(), sessionId: c.sessionId, title: c.title, source, attempt: 1, ok: !!r.ok, result: r.result, mode: r.mode || null, via: r.via || null, verified: r.verified || null, error: r.error || null, crash: key });
      st.log = st.log.slice(0, cfg.logKeep);
      saveState(st);
      if (verdict === 'DEFERRED') { out.deferred = true; break; }
      await sleep(800);
    }
  } finally { crashRunning = false; }
  st = loadState();
  if (!out.deferred) {
    st.crashes[key] = { ...crash, handledAt: new Date().toISOString(), results: out.attempted.map(a => ({ sessionId: a.sessionId, verdict: a.verdict, via: a.via })) };
    st.lastRunAt = new Date().toISOString();
    saveState(st);
  }
  out.resumed = out.attempted.filter(a => a.ok).map(a => a.sessionId);
  out.stuck = out.attempted.filter(a => !a.ok && a.verdict !== 'DEFERRED').map(a => a.sessionId);
  return out;
}

const TICK_ALARM_THRESHOLD = 2;
function raiseAlarm(errText, now = Date.now()) {
  let notify; try { notify = require('./notify'); } catch { return { queued: 0 }; }
  if (typeof notify.pushEvent !== 'function') return { queued: 0 };
  let stuck = [];
  try { stuck = candidates(now).filter(c => c.due && !c.skip); } catch {}
  let queued = 0;
  const head = notify.pushEvent({ key: `resume-alarm:${Math.floor(now / 60000)}`, kind: 'resume-loop-failing',
    line: `RESUME LOOP FAILING — the Relaymote daemon's resume tick has thrown ${TICK_ALARM_THRESHOLD}+ times in a row and is resuming nothing.\n       error: ${clip(errText, 200)}\n       ${stuck.length} session(s) are stuck right now. Fix the daemon (relaymote_heal) then: relaymote_resume force:true` });
  queued += head.queued || 0;
  for (const c of stuck) {
    const r = notify.pushEvent({ key: `resume-alarm:${c.sessionId}:${c.errorAt}:${Math.floor(now / 300000)}`, kind: 'session-stuck', sessionId: c.sessionId,
      line: `STILL STUCK ${shortId(c.sessionId)} "${clip(c.title, 60)}" — "${clip(c.error, 50)}"; the resume loop is broken · relaymote_resume session_ids:["${c.sessionId}"] force:true\n       id: ${c.sessionId}` });
    queued += r.queued || 0;
  }
  return { queued, stuck: stuck.length };
}

async function tick(opts = {}) {
  const cfg = config();
  if (!cfg.enabled) return { enabled: false };
  const out = { enabled: true };
  try { out.desktop = await noteDesktop(); } catch (e) { out.desktopError = e.message; }
  try {
    const c = await runCrash({ source: 'daemon', idleMaxWaitMs: opts.idleMaxWaitMs });
    if (!c.nothing) out.crash = c;
  } catch (e) { out.crashError = e.message; }
  let due = false;
  try { due = hasDue(); } catch (e) { out.limitError = e.message; }
  if (due) {
    try { out.limit = await run({ source: 'daemon', idleMaxWaitMs: opts.idleMaxWaitMs }); } catch (e) { out.limitError = e.message; }
  }
  const failed = out.limitError || out.crashError || out.desktopError;
  const st = loadState();
  if (failed) {
    st.tickFailures = (st.tickFailures || 0) + 1;
    st.lastTickError = String(failed);
    if (st.tickFailures >= TICK_ALARM_THRESHOLD) {
      out.alarm = raiseAlarm(failed);
      audit(`RESUME TICK FAILING x${st.tickFailures}: ${clip(failed, 160)} — paged masters (${out.alarm.queued} event(s), ${out.alarm.stuck} stuck)`);
    }
    saveState(st);
  } else if (st.tickFailures) {
    st.tickFailures = 0; st.lastTickError = null; saveState(st);
  }
  return out;
}

function status(now = Date.now()) {
  const cfg = config();
  const state = loadState();
  const cands = candidates(now);
  const next = cands.filter(c => !c.due && !c.skip).map(c => c.dueAt);
  return {
    enabled: cfg.enabled,
    registry: registryRoot(),
    config: { graceMs: cfg.graceMs, maxAgeMs: cfg.maxAgeMs, maxAttempts: cfg.maxAttempts, retryBackoffMs: cfg.retryBackoffMs, selfResumeGraceMs: cfg.selfResumeGraceMs, continueMessage: cfg.continueMessage, defaultTz: cfg.defaultTz, probeLeadMs: cfg.probeLeadMs, maxProbes: cfg.maxProbes, probeStaggerMs: cfg.probeStaggerMs },
    stuck: cands.map(c => ({ sessionId: c.sessionId, title: c.title, kind: c.kind, error: c.error,
      errorAt: new Date(c.errorAt).toISOString(), resetAt: c.resetAt ? new Date(c.resetAt).toISOString() : null, resetParsed: c.resetParsed,
      dueAt: new Date(c.dueAt).toISOString(), due: c.due, attempts: c.attempts, lastResult: c.lastResult, skip: c.skip,
      probesUsed: c.probesUsed || 0, nextProbeAt: c.nextProbeAt ? new Date(c.nextProbeAt).toISOString() : null,
      probeDue: !!c.probeDue, waitingReason: c.waitingReason || null })),
    nextDueAt: next.length ? new Date(Math.min(...next)).toISOString() : null,
    parked: (() => {
      const w = cands.filter(c => !c.due && !c.skip);
      if (!w.length) return null;
      const nextAt = [...w.map(c => c.nextProbeAt).filter(Boolean), ...w.map(c => c.dueAt)].sort((a, b) => a - b)[0];
      return {
        count: w.length,
        sessionIds: w.map(c => c.sessionId),
        nextActionAt: nextAt ? new Date(nextAt).toISOString() : null,
        summary: `${w.length} session(s) stopped by a usage limit are waiting. Next action ${nextAt ? new Date(nextAt).toISOString() : 'unknown'}` +
                 ` — Relaymote probes BEFORE the parsed reset because that time has been wrong by 70 minutes.`,
      };
    })(),
    nextProbeAt: (() => {
      const ps = cands.map(c => c.nextProbeAt).filter(Boolean);
      return ps.length ? new Date(Math.min(...ps)).toISOString() : null;
    })(),
    lastRunAt: state.lastRunAt,
    desktop: state.desktop ? { pid: state.desktop.pid, startedAt: state.desktop.startedAt ? new Date(state.desktop.startedAt).toISOString() : null, lastSeenAt: state.desktop.lastSeenAt, running: (state.desktop.running || []).length, runningAt: state.desktop.runningAt } : null,
    crashes: Object.entries(state.crashes || {}).map(([pid, c]) => ({ pid, prevPid: c.prevPid, detectedAt: c.detectedAt, desktopStartedAt: c.desktopStartedAt ? new Date(c.desktopStartedAt).toISOString() : null, prevRunning: (c.prevRunning || []).length, handledAt: c.handledAt, results: c.results })),
    recent: state.log.slice(0, 15),
    delivery: 'bridge first (main-process LocalSessionManager.sendMessage via lib/bridge.js — no UI touched), composer click as fallback',
    desktopAutoContinue: 'Claude Desktop has its own "Auto-continue when limits reset" (on by default, account-wide, localStorage key autoResumeRateLimitOptIn.<account>); it only covers sessions whose view is mounted at reset time. Relaymote is the backstop for the rest.',
  };
}

module.exports = {
  DEFAULTS, CRASH_DEFAULTS, config, LIMIT_RX, RATE_RX, classify, parseReset, zonedToUtc, tzParts,
  registryRoot, scanRegistry, readRow, candidates, hasDue,
  resumeOne, resumeSession, deliver, verifyResumed, attempt, run, status, loadState, saveState, _setRowSource,
  transcriptRoot, transcriptIndex, transcriptTail, transcriptLimitStop, noteDesktop, crashCandidates, runCrash, tick,
  _setProcSource, _setTranscriptRoot,
};
