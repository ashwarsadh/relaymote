'use strict';
// Auto-starts suggested-task chips raised by a Conductor or a master. 26-Oct, Ashwar: "relaymote shud hv ability
// to also self start such tasks too". Starts go through desktop.startChipBackground (the bridge's own
// LocalSessions.start + spawnedFrom): nothing is clicked or fronted, so it runs while he types (0.2.139 rule).
// Only the sidebar grouping is a DOM action, and that waits for an idle PC. A chip whose title or summary says
// "optional" stays for him to decide.

const fs = require('fs');
const os = require('os');
const path = require('path');

const desktop = require('./desktop');
const idle = require('./idle');
const config = require('./config');

const STATE_DIR = config.STATE;
const STATE_FILE = path.join(STATE_DIR, 'chipwatch.json');
const AUDIT = path.join(STATE_DIR, 'master-audit.log');
const MASTERS = path.join(STATE_DIR, 'masters.json');
// The Conductor claims its master role through AGO, so the live claims are in AGO's file, not ours.
const AGO_MASTERS = () => process.env.RELAYMOTE_AGO_MASTERS || path.join(os.homedir(), '.claude', 'ago', 'state', 'masters.json');
const CONDUCTOR_DIR = () => (config.get().board && config.get().board.dir) || path.join(config.DATA, 'board');

const idleMinMs = () => Number(process.env.RELAYMOTE_CHIPWATCH_IDLE_MS ?? process.env.RELAYMOTE_IDLE_MIN_MS ?? (config.get().idleGateSeconds * 1000));
const MAX_ATTEMPTS = Number(process.env.RELAYMOTE_CHIPWATCH_ATTEMPTS ?? 3);
const MAX_PER_TICK = Number(process.env.RELAYMOTE_CHIPWATCH_MAX_PER_TICK ?? 2);
const DEFAULT_MODEL = process.env.RELAYMOTE_CHIPWATCH_MODEL || require('./router').MODEL;
const OPTIONAL = /\boptional\b/i;

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) || {}; } catch { return {}; }
}
function saveState(s) {
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch {}
}
function audit(msg) {
  try { fs.appendFileSync(AUDIT, `[${new Date().toISOString()}] ${msg}\n`); } catch {}
}
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) || {}; } catch { return {}; } };

/** Sessions whose own chips start by themselves: every live master claim (ours and AGO's) and every Conductor. */
function ownedSessions(now = Date.now()) {
  const out = new Map();
  const add = (id, meta) => { if (/^local_/.test(String(id)) && !out.has(id)) out.set(id, meta); };
  for (const file of [MASTERS, AGO_MASTERS()]) {
    for (const [project, m] of Object.entries(readJson(file))) {
      if (!m || !m.sessionId) continue;
      if (m.expiresAt && Date.parse(m.expiresAt) <= now) continue;
      add(m.sessionId, { project, masterSessionId: m.sessionId, mastersFile: file, role: 'master' });
    }
  }
  try {
    const cd = CONDUCTOR_DIR();
    const last = String(fs.readFileSync(path.join(cd, 'last-conductor.txt'), 'utf8')).trim().split(/\s+/)[0];
    add(last, { project: 'conductor', role: 'conductor' });
    for (const [key, p] of Object.entries(readJson(path.join(cd, 'principals.json')).principals || {})) {
      if (p && p.enabled !== false && p.conductor) add(p.conductor, { project: 'conductor:' + key, role: 'conductor' });
    }
  } catch {}
  return [...out.entries()].map(([sessionId, meta]) => ({ sessionId, ...meta }));
}

const isOptional = (chip) => OPTIONAL.test(String(chip.title || '')) || OPTIONAL.test(String(chip.description || chip.tldr || ''));

async function tick(opts = {}) {
  const state = loadState();
  state.chips = state.chips || {};
  const enabled = opts.force || String(process.env.RELAYMOTE_CHIPWATCH ?? '1') !== '0';
  if (!enabled) return { skipped: 'disabled' };

  const owned = ownedSessions();
  if (!owned.length) return { skipped: 'no-master-owns-anything' };

  let queues;
  try { queues = await desktop.allChipQueues(); } catch (e) { return { skipped: 'bridge-unavailable', detail: e.message }; }
  if (!queues || !queues.ok) return { skipped: 'bridge-unavailable', detail: queues && queues.error };
  if (!queues.total) return { started: [], failed: [], seen: [], held: [], ownedSessions: owned.length, note: 'no pending chips anywhere' };

  idle.start();
  for (let i = 0; i < 8 && idle.idleMs() === null; i++) await new Promise(r => setTimeout(r, 250));
  const pcIdle = () => opts.force || idle.isIdle(idleMinMs());
  const tier = require('./tier-policy').defaults();
  const started = [], failed = [], seen = [], held = [];
  for (const target of owned) {
    if (started.length + failed.length >= MAX_PER_TICK) break;

    const list = queues.sessions.get(target.sessionId);
    if (!list || !list.chips.length || list.archived) continue;

    for (const chip of list.chips) {
      if (isOptional(chip)) { held.push({ taskId: chip.taskId, title: chip.title, why: 'marked optional' }); continue; }
      if (started.length + failed.length >= MAX_PER_TICK) break;
      const rec = state.chips[chip.taskId] || { attempts: 0 };
      if (rec.startedSessionId) continue;
      if (rec.attempts >= MAX_ATTEMPTS) continue;
      seen.push(chip.taskId);

      rec.attempts += 1;
      rec.lastAttemptAt = new Date().toISOString();
      rec.title = chip.title;
      rec.ownerSessionId = target.sessionId;
      rec.project = target.project;

      let r;
      try {
        r = await desktop.startChipBackground({ sessionId: target.sessionId, taskId: chip.taskId,
          model: tier.model || DEFAULT_MODEL, effort: tier.effort || undefined });
      } catch (e) { r = { ok: false, error: 'THREW', message: e.message }; }

      if (r && r.ok && r.startedSessionId) {
        rec.startedSessionId = r.startedSessionId;
        rec.startedAt = new Date().toISOString();
        rec.transport = r.transport || 'background';
        started.push({ taskId: chip.taskId, title: chip.title, sessionId: r.startedSessionId, owner: target.sessionId });
        try { require('./tier-policy').recordRelaymote(r.startedSessionId, { model: r.model, effort: r.effort }); } catch {}

        // Grouping is a sidebar (DOM) action: only on an idle PC, never while he types.
        const want = groupFor(chip, target);
        if (want && pcIdle()) {
          try {
            const g = await desktop.setGroup(r.startedSessionId, want, { idle: false });
            rec.group = g && g.ok ? want : null;
          } catch {}
        } else if (want) rec.groupPending = want;

        if (target.mastersFile) {
          try {
            const all = readJson(target.mastersFile);
            const m = all[target.project];
            if (m && m.sessionId === target.sessionId) {
              m.fleet = [...new Set([...(m.fleet || []), r.startedSessionId])];
              fs.writeFileSync(target.mastersFile, JSON.stringify(all, null, 2));
            }
          } catch {}
        }

        audit(`CHIPWATCH started ${chip.taskId} "${String(chip.title).slice(0, 60)}" in ${target.sessionId} -> ${r.startedSessionId} (${target.role || 'master'} ${target.project}, background, model ${r.model || '-'})`);
      } else {
        rec.lastError = (r && (r.error || r.message)) || 'unknown';
        failed.push({ taskId: chip.taskId, title: chip.title, error: rec.lastError, attempts: rec.attempts });
        audit(`CHIPWATCH failed ${chip.taskId} in ${target.sessionId}: ${rec.lastError} (attempt ${rec.attempts}/${MAX_ATTEMPTS})`);
      }
      state.chips[chip.taskId] = rec;
      saveState(state);
    }
  }

  // Started while he was busy: group them once the PC is idle.
  if (pcIdle()) {
    for (const [, rec] of Object.entries(state.chips)) {
      if (!rec.groupPending || !rec.startedSessionId) continue;
      try { const g = await desktop.setGroup(rec.startedSessionId, rec.groupPending, { idle: false }); if (g && g.ok) rec.group = rec.groupPending; } catch {}
      delete rec.groupPending;
      if (!pcIdle()) break;
    }
  }

  state.lastTickAt = new Date().toISOString();
  saveState(state);
  return { started, failed, seen, held, ownedSessions: owned.length };
}

// The new session's sidebar group: the group named after its folder, else the group most of that folder's
// sessions sit in, else the owner's own group.
function groupFor(chip, target) {
  try {
    const snap = desktop.loadSnapshot();
    const rows = (snap && snap.sessions) || [];
    const cwd = chip.cwd || (rows.find(x => x.sessionId === target.sessionId) || {}).cwd || '';
    if (cwd) {
      const base = String(cwd).replace(/[\/]+$/, '').split(/[\/]/).pop().toLowerCase();
      const names = [...new Set(rows.map(x => x.group).filter(g => g && g !== '(none)'))];
      const named = names.find(g => g.toLowerCase() === base);
      if (named) return named;
      const norm = (p) => String(p || '').replace(/[\/]+$/, '').toLowerCase();
      const tally = new Map();
      for (const row of rows) {
        if (!row.group || row.group === '(none)' || norm(row.cwd) !== norm(cwd)) continue;
        tally.set(row.group, (tally.get(row.group) || 0) + 1);
      }
      let best = 0, want = null;
      for (const [g, n] of tally) if (n > best) { best = n; want = g; }
      if (want) return want;
    }
    const ownerRow = rows.find(x => x.sessionId === target.sessionId);
    if (ownerRow && ownerRow.group && ownerRow.group !== '(none)') return ownerRow.group;
  } catch {}
  return null;
}

function status() {
  const s = loadState();
  const chips = Object.entries(s.chips || {});
  return {
    enabled: String(process.env.RELAYMOTE_CHIPWATCH ?? '1') !== '0',
    requiredIdleMs: idleMinMs(),
    idleMs: idle.idleMs(),
    lastTickAt: s.lastTickAt || null,
    startedCount: chips.filter(([, c]) => c.startedSessionId).length,
    givenUp: chips.filter(([, c]) => !c.startedSessionId && c.attempts >= MAX_ATTEMPTS)
      .map(([id, c]) => ({ taskId: id, title: c.title, lastError: c.lastError, attempts: c.attempts })),
    recent: chips.filter(([, c]) => c.startedSessionId)
      .sort((a, b) => String(b[1].startedAt).localeCompare(String(a[1].startedAt)))
      .slice(0, 8)
      .map(([id, c]) => ({ taskId: id, title: c.title, sessionId: c.startedSessionId, at: c.startedAt, group: c.group || null })),
  };
}

module.exports = { tick, status, ownedSessions, isOptional, get IDLE_MIN_MS() { return idleMinMs(); } };
