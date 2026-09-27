'use strict';

const fs = require('fs');
const path = require('path');

const desktop = require('./desktop');
const idle = require('./idle');

const STATE_DIR = require('./config').STATE;
const STATE_FILE = path.join(STATE_DIR, 'chipwatch.json');
const AUDIT = path.join(STATE_DIR, 'master-audit.log');
const MASTERS = path.join(STATE_DIR, 'masters.json');

const idleMinMs = () => Number(process.env.RELAYMOTE_CHIPWATCH_IDLE_MS ?? process.env.RELAYMOTE_IDLE_MIN_MS ?? (require('./config').get().idleGateSeconds * 1000));
const MAX_ATTEMPTS = Number(process.env.RELAYMOTE_CHIPWATCH_ATTEMPTS ?? 3);
const MAX_PER_TICK = Number(process.env.RELAYMOTE_CHIPWATCH_MAX_PER_TICK ?? 2);
const DEFAULT_MODEL = process.env.RELAYMOTE_CHIPWATCH_MODEL || require('./router').MODEL;

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) || {}; } catch { return {}; }
}
function saveState(s) {
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch {}
}
function audit(msg) {
  try { fs.appendFileSync(AUDIT, `[${new Date().toISOString()}] ${msg}\n`); } catch {}
}

function ownedSessions(now = Date.now()) {
  let all = {};
  try { all = JSON.parse(fs.readFileSync(MASTERS, 'utf8')) || {}; } catch { return []; }
  const out = new Map();
  for (const [project, m] of Object.entries(all)) {
    if (!m || !m.sessionId) continue;
    if (m.expiresAt && Date.parse(m.expiresAt) <= now) continue;
    const add = (id) => { if (/^local_/.test(String(id)) && !out.has(id)) out.set(id, { project, masterSessionId: m.sessionId }); };
    add(m.sessionId);
    (m.fleet || []).forEach(add);
  }
  return [...out.entries()].map(([sessionId, meta]) => ({ sessionId, ...meta }));
}

async function tick(opts = {}) {
  const state = loadState();
  state.chips = state.chips || {};
  const enabled = opts.force || String(process.env.RELAYMOTE_CHIPWATCH ?? '1') !== '0';
  if (!enabled) return { skipped: 'disabled' };

  idle.start();
  for (let i = 0; i < 8 && idle.idleMs() === null; i++) await new Promise(r => setTimeout(r, 250));

  if (!opts.force && !idle.isIdle(idleMinMs())) {
    return { skipped: 'user-active', idleMs: idle.idleMs(), requiredIdleMs: idleMinMs() };
  }

  const owned = ownedSessions();
  if (!owned.length) return { skipped: 'no-master-owns-anything' };

  let queues;
  try { queues = await desktop.allChipQueues(); } catch (e) { return { skipped: 'bridge-unavailable', detail: e.message }; }
  if (!queues || !queues.ok) return { skipped: 'bridge-unavailable', detail: queues && queues.error };
  if (!queues.total) return { started: [], failed: [], seen: [], ownedSessions: owned.length, note: 'no pending chips anywhere' };

  const started = [], failed = [], seen = [];
  for (const target of owned) {
    if (started.length + failed.length >= MAX_PER_TICK) break;

    const list = queues.sessions.get(target.sessionId);
    if (!list || !list.chips.length) continue;

    for (const chip of list.chips) {
      if (started.length + failed.length >= MAX_PER_TICK) break;
      const rec = state.chips[chip.taskId] || { attempts: 0 };
      if (rec.startedSessionId) continue;
      if (rec.attempts >= MAX_ATTEMPTS) continue;
      seen.push(chip.taskId);

      if (!opts.force && !idle.isIdle(idleMinMs())) {
        return { skipped: 'user-active-mid-tick', started, failed, seen };
      }

      rec.attempts += 1;
      rec.lastAttemptAt = new Date().toISOString();
      rec.title = chip.title;
      rec.ownerSessionId = target.sessionId;
      rec.project = target.project;

      let r;
      try {
        r = await desktop.startTask({ taskId: chip.taskId, sessionId: target.sessionId, mode: 'local', idle: false });
      } catch (e) { r = { ok: false, error: 'THREW', message: e.message }; }

      if (r && r.ok && r.startedSessionId) {
        rec.startedSessionId = r.startedSessionId;
        rec.startedAt = new Date().toISOString();
        started.push({ taskId: chip.taskId, title: chip.title, sessionId: r.startedSessionId, owner: target.sessionId });

        try {
          const snap = desktop.loadSnapshot();
          const rows = (snap && snap.sessions) || [];
          let want = null;
          if (chip.cwd) {
            const base = String(chip.cwd).replace(/[\\/]+$/, '').split(/[\\/]/).pop().toLowerCase();
            const names = [...new Set(rows.map(x => x.group).filter(g => g && g !== '(none)'))];
            want = names.find(g => g.toLowerCase() === base) || null;
          }
          if (!want && chip.cwd) {
            const norm = (p) => String(p || '').replace(/[\\/]+$/, '').toLowerCase();
            const tally = new Map();
            for (const row of rows) {
              if (!row.group || row.group === '(none)' || norm(row.cwd) !== norm(chip.cwd)) continue;
              tally.set(row.group, (tally.get(row.group) || 0) + 1);
            }
            let best = 0;
            for (const [g, n] of tally) if (n > best) { best = n; want = g; }
          }
          if (!want) {
            const ownerRow = rows.find(x => x.sessionId === target.sessionId);
            if (ownerRow && ownerRow.group && ownerRow.group !== '(none)') want = ownerRow.group;
          }
          if (want) {
            const g = await desktop.setGroup(r.startedSessionId, want, { idle: false });
            rec.group = g && g.ok ? want : null;
            rec.groupedBy = chip.cwd && rec.group === want ? 'cwd' : 'owner';
          }
        } catch {}

        if (!require('./tier-policy').defaults().model) { try { await desktop.setModel(r.startedSessionId, DEFAULT_MODEL, { idle: false }); } catch {} }

        try {
          const all = JSON.parse(fs.readFileSync(MASTERS, 'utf8'));
          const m = all[target.project];
          if (m) { m.fleet = [...new Set([...(m.fleet || []), r.startedSessionId])]; fs.writeFileSync(MASTERS, JSON.stringify(all, null, 2)); }
        } catch {}

        audit(`CHIPWATCH started ${chip.taskId} "${String(chip.title).slice(0, 60)}" in ${target.sessionId} -> ${r.startedSessionId} (project ${target.project}, model ${DEFAULT_MODEL})`);
      } else {
        rec.lastError = (r && (r.error || r.message)) || 'unknown';
        failed.push({ taskId: chip.taskId, title: chip.title, error: rec.lastError, attempts: rec.attempts });
        audit(`CHIPWATCH failed ${chip.taskId} in ${target.sessionId}: ${rec.lastError} (attempt ${rec.attempts}/${MAX_ATTEMPTS})`);
      }
      state.chips[chip.taskId] = rec;
      saveState(state);
    }
  }

  state.lastTickAt = new Date().toISOString();
  saveState(state);
  return { started, failed, seen, ownedSessions: owned.length };
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

module.exports = { tick, status, ownedSessions, get IDLE_MIN_MS() { return idleMinMs(); } };
