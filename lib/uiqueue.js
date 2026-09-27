'use strict';

const fs = require('fs');
const path = require('path');

const STATE_DIR = require('./config').STATE;
const FILE = path.join(STATE_DIR, 'ui-queue.json');
const AUDIT = path.join(STATE_DIR, 'master-audit.log');

const ALLOWED = new Set(['setGroup', 'renameSession']);
const MAX_ATTEMPTS = Number(process.env.RELAYMOTE_UIQUEUE_ATTEMPTS ?? 3);
const MAX_AGE_MS = Number(process.env.RELAYMOTE_UIQUEUE_MAX_AGE_MS ?? 6 * 60 * 60 * 1000);

function load() {
  try { const j = JSON.parse(fs.readFileSync(FILE, 'utf8')); return Array.isArray(j.items) ? j : { items: [] }; }
  catch { return { items: [] }; }
}
function save(q) {
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(q, null, 2)); } catch {}
}
function audit(m) { try { fs.appendFileSync(AUDIT, `[${new Date().toISOString()}] ${m}\n`); } catch {} }

function enqueue(action, args, meta = {}) {
  if (!ALLOWED.has(action)) return null;
  const q = load();
  const key = action + ':' + JSON.stringify(args);
  const existing = q.items.find(i => i.key === key && !i.doneAt);
  if (existing) { existing.requestedAt = new Date().toISOString(); save(q); return existing; }
  const item = {
    id: 'q' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    key, action, args, by: meta.by || null,
    requestedAt: new Date().toISOString(), attempts: 0, doneAt: null, lastError: null,
  };
  q.items.push(item);
  save(q);
  audit(`UIQUEUE queued ${action} ${JSON.stringify(args).slice(0, 120)}${meta.by ? ' by ' + meta.by : ''}`);
  return item;
}

async function drain(opts = {}) {
  const desktop = require('./desktop');
  const idle = require('./idle');
  const min = opts.idleMinMs !== undefined ? opts.idleMinMs : Number(process.env.RELAYMOTE_IDLE_MIN_MS ?? (require('./config').get().idleGateSeconds * 1000));

  const q = load();
  const pending = q.items.filter(i => !i.doneAt);
  if (!pending.length) return { skipped: 'empty' };

  if (!opts.force && !idle.isIdle(min)) {
    return { skipped: 'user-active', pending: pending.length, idleMs: idle.idleMs() };
  }

  const done = [], failed = [], dropped = [];
  for (const item of pending) {
    if (Date.now() - Date.parse(item.requestedAt) > MAX_AGE_MS) {
      item.doneAt = new Date().toISOString(); item.lastError = 'expired';
      dropped.push({ id: item.id, action: item.action, reason: 'older than the replay window' });
      continue;
    }
    if (!opts.force && !idle.isIdle(min)) break;
    item.attempts += 1;
    let r;
    try {
      const fn = desktop[item.action];
      r = typeof fn === 'function' ? await fn(...item.args, { idle: false }) : { ok: false, error: 'NO_SUCH_ACTION' };
    } catch (e) { r = { ok: false, error: 'THREW', message: e.message }; }

    if (r && r.ok) {
      item.doneAt = new Date().toISOString();
      done.push({ id: item.id, action: item.action, args: item.args });
      audit(`UIQUEUE ran ${item.action} ${JSON.stringify(item.args).slice(0, 120)} -> ok`);
    } else {
      item.lastError = (r && (r.error || r.message)) || 'unknown';
      if (item.attempts >= MAX_ATTEMPTS) {
        item.doneAt = new Date().toISOString();
        dropped.push({ id: item.id, action: item.action, reason: item.lastError, attempts: item.attempts });
        audit(`UIQUEUE gave up on ${item.action}: ${item.lastError} after ${item.attempts} attempts`);
      } else {
        failed.push({ id: item.id, action: item.action, error: item.lastError, attempts: item.attempts });
      }
    }
    save(q);
  }
  q.items = q.items.filter(i => !i.doneAt || Date.now() - Date.parse(i.doneAt) < 60 * 60 * 1000);
  q.lastDrainAt = new Date().toISOString();
  save(q);
  return { done, failed, dropped, pending: q.items.filter(i => !i.doneAt).length };
}

function status() {
  const q = load();
  const pending = q.items.filter(i => !i.doneAt);
  return {
    pending: pending.length,
    lastDrainAt: q.lastDrainAt || null,
    replayable: [...ALLOWED],
    items: pending.slice(0, 10).map(i => ({ id: i.id, action: i.action, args: i.args, requestedAt: i.requestedAt, attempts: i.attempts, lastError: i.lastError })),
  };
}

function cancel(id) {
  const q = load();
  const item = q.items.find(i => i.id === id && !i.doneAt);
  if (!item) return { ok: false, error: 'NOT_FOUND', id };
  item.doneAt = new Date().toISOString(); item.lastError = 'cancelled';
  save(q);
  audit(`UIQUEUE cancelled ${id} (${item.action})`);
  return { ok: true, id, action: item.action };
}

module.exports = { enqueue, drain, status, cancel, ALLOWED };
