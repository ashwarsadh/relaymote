'use strict';
const fs = require('fs');
const path = require('path');

const config = require('./config');
const STORE = path.join(config.APPDATA, 'Claude', 'claude-code-sessions');
const STATE_DIR = require('./config').STATE;
const STATE_FILE = path.join(STATE_DIR, 'account-scope.json');

function scopesOnDisk() {
  const out = [];
  let accounts = [];
  try { accounts = fs.readdirSync(STORE); } catch { return out; }
  for (const accountId of accounts) {
    let orgs = [];
    try { orgs = fs.readdirSync(path.join(STORE, accountId)); } catch { continue; }
    for (const orgId of orgs) {
      const dir = path.join(STORE, accountId, orgId);
      let names = [];
      try { names = fs.readdirSync(dir); } catch { continue; }
      const ids = new Set();
      // 09-Nov: no stat per record. The phone's poll runs this every pass, and a stat of each of ~3,700 session files
      // (for a "newest" nobody read) held the event loop ~360 ms each time. readdir alone gives the ids and the count.
      for (const n of names) {
        if (!n.startsWith('local_') || !n.endsWith('.json')) continue;
        ids.add(n.slice(0, -5));
      }
      out.push({ accountId, orgId, dir, ids, records: ids.size });
    }
  }
  return out;
}

const DESKTOP_CONFIG = path.join(config.APPDATA, 'Claude', 'config.json');

function labelFor(accountId, orgId) {
  try {
    const core = require('./account-sync/core');
    const scope = { account: accountId, org: orgId || '', key: accountId + '/' + (orgId || ''), prefix: '' };
    return core.labelFor(scope);
  } catch { return null; }
}

function activeScope() {
  const scopes = scopesOnDisk();
  const summary = scopes.map(s => ({ accountId: s.accountId, orgId: s.orgId, records: s.records }));
  let accountId = null;
  try { accountId = JSON.parse(fs.readFileSync(DESKTOP_CONFIG, 'utf8')).lastKnownAccountUuid || null; } catch {}
  if (!accountId) {
    return { ok: true, state: 'unknown',
             reason: 'Claude Desktop\'s config does not name an account (lastKnownAccountUuid missing or unreadable).',
             scopes: summary };
  }
  const mine = scopes.filter(s => s.accountId === accountId && s.records > 0);
  const base = { ok: true, state: 'known', accountId, account: labelFor(accountId, mine.length === 1 ? mine[0].orgId : null), scopes: summary,
                 evidence: 'Claude Desktop config: lastKnownAccountUuid' };
  if (mine.length === 1) {
    return Object.assign(base, { orgId: mine[0].orgId, scope: accountId + '/' + mine[0].orgId, records: mine[0].records });
  }
  return Object.assign(base, { scope: accountId, orgId: null,
    orgNote: mine.length ? `${mine.length} org scopes under this account hold records; the org is not named by the config.`
                         : 'No scope directory under this account holds any records yet.' });
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return null; }
}
function writeState(v) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(v, null, 1));
    fs.renameSync(tmp, STATE_FILE);
  } catch {}
}

function note(reading, now = Date.now()) {
  const prev = readState();
  if (!reading || reading.state !== 'known') {
    return { changed: false, state: reading ? reading.state : 'unknown', known: prev && prev.scope ? prev.scope : null };
  }
  const scope = reading.scope;
  if (!prev || !prev.scope) {
    writeState({ scope, accountId: reading.accountId, orgId: reading.orgId, since: now, firstSeen: now });
    return { changed: false, baseline: true, state: 'known', scope };
  }
  if (prev.scope === scope) {
    writeState(Object.assign({}, prev, { lastSeen: now }));
    return { changed: false, state: 'known', scope, since: prev.since };
  }
  writeState({ scope, accountId: reading.accountId, orgId: reading.orgId,
               since: now, firstSeen: prev.firstSeen || now, previous: prev.scope, switchedAt: now });
  return { changed: true, state: 'known', from: prev.scope, to: scope, at: now };
}

const PENDING_FILE = path.join(STATE_DIR, 'account-switch.json');

function readPending() {
  try { return JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8')); } catch { return null; }
}
function writePending(v) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const tmp = PENDING_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(v, null, 1));
    fs.renameSync(tmp, PENDING_FILE);
  } catch {}
}

const REASK_MS = 10 * 60 * 1000;
function raise(change, now = Date.now()) {
  if (!change || !change.changed) return null;
  const prev = readPending();
  const key = change.from + ' -> ' + change.to;
  if (prev && prev.key === key && !prev.answer) return prev;
  if (prev && prev.key === key && prev.answer && prev.answeredAt && (now - prev.answeredAt) < REASK_MS) return null;
  const q = {
    key, from: change.from, to: change.to,
    fromAccount: labelFor(...String(change.from).split('/')),
    toAccount: labelFor(...String(change.to).split('/')),
    askedAt: now, answer: null, answeredAt: null,
  };
  writePending(q);
  return q;
}

function pending() {
  const p = readPending();
  return p && !p.answer ? p : null;
}

function answer(value, now = Date.now()) {
  const p = readPending();
  if (!p) return { ok: false, error: 'NO_PENDING_QUESTION' };
  if (p.answer) return { ok: true, already: true, question: p };
  const v = String(value || '').toLowerCase();
  if (v !== 'transfer' && v !== 'dismiss') {
    return { ok: false, error: 'BAD_ANSWER', message: 'answer must be "transfer" or "dismiss"' };
  }
  const q = Object.assign({}, p, { answer: v, answeredAt: now });
  writePending(q);
  const back = readPending();
  if (!back || back.answer !== v) {
    return { ok: false, error: 'NOT_PERSISTED', message: 'the decision could not be written to disk, so nothing will act on it' };
  }
  return { ok: true, question: back };
}

// A "transfer" answer is acted on by lib/account-sync (transferTick): a sync toward the account
// switched to. Its progress is kept on the question itself, so it survives a restart and is not
// repeated once done.
function markTransfer(progress) {
  const p = readPending();
  if (!p || p.answer !== 'transfer') return null;
  const q = Object.assign({}, p, { transfer: Object.assign({}, progress || {}) });
  writePending(q);
  return q.transfer;
}

module.exports = { scopesOnDisk, activeScope, note, readState, labelFor,
                   raise, pending, answer, readPending, markTransfer,
                   STATE_FILE, PENDING_FILE, DESKTOP_CONFIG };
