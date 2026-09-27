// core.js — scopes, the dated-fact store, backups and the write lock.
//
// A scope is one (account, org) pair. Claude Desktop keeps session records, archive state and
// routines per scope under <profile>/claude-code-sessions/<account>/<org>, and sidebar groups per
// scope inside its localStorage. Desktop holds ONLY the active scope in memory: an inactive scope
// is re-read from disk when you switch to it, so it may be written while Desktop runs; the active
// one only while Desktop is closed.
//
// THE ONE RULE: absence in one scope is not a deletion instruction. A record is removed only
// against a tombstone this sync wrote after watching a record it had previously synced vanish,
// and only when deletion is explicitly enabled. So the first run is purely additive.
//
// The app does not date an archive (records carry isArchived but no archivedAt), so the sync
// dates changes by observing them: each run records the value it saw per record per scope and
// when it first saw that value. A file's mtime is never used to decide who won; it is only a hint
// for "is this file worth re-reading".
'use strict';
const fs = require('fs');
const path = require('path');
const config = require('../config');

const PROFILE = path.join(config.APPDATA, 'Claude');
// Windows keeps Local beside Roaming; derive it from APPDATA so a relocated APPDATA (tests) can
// never reach the real Local folder.
const LOCALAPPDATA = process.env.BATON_LOCALAPPDATA ||
  (process.platform === 'win32' ? path.join(path.dirname(config.APPDATA), 'Local') : config.APPDATA);
const MSIX_PKGS = ['Claude_pzs8sxrjxfjjc', 'AnthropicPBC.Claude_fnn82j28hfe8t'];

const DIR = path.join(config.DATA, 'accounts');
const STATE_FILE = path.join(DIR, 'sync-state.json');
const CACHE_FILE = path.join(DIR, 'scan-cache.json');
const LABELS_FILE = path.join(DIR, 'labels.json');
const FREEZE_FILE = path.join(DIR, 'freeze.json');
const HOLD_FILE = path.join(DIR, 'HOLD-STATE-SYNC');
const BACKUP_DIR = path.join(DIR, 'backups');
const JOURNAL_DIR = path.join(DIR, 'journals');
const SNAP_DIR = path.join(DIR, 'group-snapshots');
const SNAP_DIR_3P = path.join(DIR, 'group-snapshots-3p');   // Gateway mode keeps its own history
const VERIFY_FILE = path.join(DIR, 'verify-pending.json');    // a group write waiting for its relaunch check
const VERDICT_FILE = path.join(DIR, 'scope-verdict.json');   // the latest relaunch verdict
const LOG_FILE = path.join(DIR, 'sync.log');
const LOCK_FILE = path.join(DIR, '.sync.lock');
const STATE_VERSION = 1;

function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); return d; }

function log(line) {
  try {
    ensureDir(DIR);
    fs.appendFileSync(LOG_FILE, new Date().toISOString().replace('T', ' ').slice(0, 19) + '  ' + line + '\n');
    if (fs.statSync(LOG_FILE).size > 512 * 1024) {
      fs.writeFileSync(LOG_FILE, fs.readFileSync(LOG_FILE, 'utf8').split('\n').slice(-400).join('\n'));
    }
  } catch {}
  return line;
}

const readJson = (f, dflt) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return dflt; } };
function writeJsonAtomic(file, obj, pretty = 2) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, pretty));
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------- where the stores are
const isDir = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const mtime = p => { try { return fs.statSync(p).mtimeMs; } catch { return -1; } };

function newestIn(dir) {
  let best = -1;
  try { for (const f of fs.readdirSync(dir)) { const m = mtime(path.join(dir, f)); if (m > best) best = m; } } catch {}
  return best;
}

// Windows only: the packaged (MSIX/Store) build redirects the profile under the package's
// LocalCache. A Packages folder can outlive an uninstall, so it counts only when its config.json
// is at least as new as the classic profile's.
function msixProfiles() {
  if (process.platform !== 'win32') return [];
  const out = [];
  for (const pkg of MSIX_PKGS) {
    const cache = path.join(LOCALAPPDATA, 'Packages', pkg, 'LocalCache');
    for (const [sub, classic, prefix] of [[['Roaming', 'Claude'], PROFILE, 'msix:'],
                                          [['Local', 'Claude-3p'], path.join(LOCALAPPDATA, 'Claude-3p'), 'msix3p:']]) {
      const dir = path.join(cache, ...sub);
      if (!isDir(path.join(dir, 'claude-code-sessions'))) continue;
      const pkgMs = mtime(path.join(dir, 'config.json'));
      if (pkgMs >= 0 && pkgMs >= mtime(path.join(classic, 'config.json'))) out.push({ dir, prefix, mode: /3p/.test(prefix) ? '3p' : '1p' });
    }
  }
  return out;
}

// Gateway / API-key mode keeps its own userData dir. Windows: %LOCALAPPDATA%\Claude-3p.
// macOS location is assumed to sit beside the 1p profile (UNTESTED).
function gatewayProfile() {
  const cands = process.platform === 'win32'
    ? [path.join(LOCALAPPDATA, 'Claude-3p'), path.join(config.APPDATA, 'Claude-3p')]
    : [path.join(config.APPDATA, 'Claude-3p')];
  const dir = cands.find(d => isDir(path.join(d, 'claude-code-sessions')));
  return dir ? { dir, prefix: '3p:', mode: '3p' } : null;
}

function profiles() {
  const out = [{ dir: PROFILE, prefix: '', mode: '1p' }];
  const gw = gatewayProfile(); if (gw) out.push(gw);
  return out.concat(msixProfiles());
}

// The 1p profile whose localStorage is newest: that is the one Desktop is running from.
function groupsProfile() {
  let best = { dir: PROFILE, prefix: '' }, bestMs = newestIn(path.join(PROFILE, 'Local Storage', 'leveldb'));
  for (const p of msixProfiles().filter(p => p.mode === '1p')) {
    const ms = newestIn(path.join(p.dir, 'Local Storage', 'leveldb'));
    if (ms > bestMs) { best = p; bestMs = ms; }
  }
  return best;
}

// ---------------------------------------------------------------- scopes
// Only REAL scopes count: Desktop creates empty stub dirs for account/org combinations that were
// never used, and syncing into them would invent data. A Gateway or MSIX scope counts even when
// empty: it has one account, so an empty dir is a fresh setup waiting to be filled.
function listScopes() {
  const out = [];
  for (const prof of profiles()) {
    const root = path.join(prof.dir, 'claude-code-sessions');
    let accounts = [];
    try { accounts = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()); } catch { continue; }
    for (const a of accounts) {
      let orgs = [];
      try { orgs = fs.readdirSync(path.join(root, a.name), { withFileTypes: true }).filter(d => d.isDirectory()); } catch { continue; }
      for (const o of orgs) {
        const dir = path.join(root, a.name, o.name);
        let records = 0;
        try { records = fs.readdirSync(dir).filter(f => /^local_.*\.json$/.test(f)).length; } catch {}
        const reg = readJson(path.join(dir, 'scheduled-tasks.json'), null);
        const routineCount = reg && Array.isArray(reg.scheduledTasks) ? reg.scheduledTasks.length : 0;
        out.push({
          key: prof.prefix + a.name + '/' + o.name, groupKey: a.name + '/' + o.name,
          account: a.name, org: o.name, dir, profile: prof.dir, mode: prof.mode, prefix: prof.prefix,
          recordCount: records, routineCount,
          empty: records === 0 && routineCount === 0,
          real: prof.mode === '3p' || prof.prefix !== '' || records > 0 || routineCount > 0,
        });
      }
    }
  }
  // An empty scope whose org belongs to another account's real scope is a cross-product stub.
  // Any other empty scope is a newly added account that has not been used yet: keep it.
  const usedOrgs = new Map();
  for (const s of out) if (!s.empty) usedOrgs.set(s.org, s.account);
  for (const s of out) if (!s.real && !(usedOrgs.has(s.org) && usedOrgs.get(s.org) !== s.account)) s.real = true;
  return out;
}
const realScopes = () => listScopes().filter(s => s.real);

function newestWriteMs(s) {
  let newest = 0;
  try {
    for (const f of fs.readdirSync(s.dir)) {
      if (!/^local_.*\.json$/.test(f)) continue;
      const m = mtime(path.join(s.dir, f)); if (m > newest) newest = m;
    }
  } catch {}
  return newest;
}

function lastKnownAccount() {
  const c = readJson(path.join(PROFILE, 'config.json'), null);
  return c && typeof c.lastKnownAccountUuid === 'string' ? c.lastKnownAccountUuid : null;
}

// Desktop writes one record file per session as it works, only in the scope it has loaded, so
// the scope with the newest record is the active one. The 1p and Gateway profiles are separate
// apps that can both run, so every scope written within `windowMs` of the newest counts as live
// too, and so does every scope of the account Desktop's own config names.
function liveScopes(scopes, windowMs = 10 * 60 * 1000) {
  const all = scopes.map(s => ({ s, ms: newestWriteMs(s) }));
  const top = Math.max(0, ...all.map(x => x.ms));
  const live = new Set(all.filter(x => x.ms > 0 && top - x.ms <= windowMs).map(x => x.s.key));
  const acct = lastKnownAccount();
  if (acct) for (const s of scopes) if (s.mode === '1p' && s.account === acct) live.add(s.key);
  const tied = all.filter(x => x.ms === top && top > 0).map(x => x.s);
  const active = ((acct && tied.find(s => s.account === acct)) || tied[0] || {}).key || null;
  return { active, activeAt: top ? new Date(top).toISOString() : null, live };
}

// ---------------------------------------------------------------- who each account is
// Claude Desktop keeps no readable email per account. The Claude Code CLI login does
// (.claude.json -> oauthAccount), so every login seen there is remembered in identities.json and
// shown for the matching scope. Anything else can be labelled by the user.
const IDS_FILE = path.join(DIR, 'identities.json');
function claudeJsonFiles() {
  const out = [path.join(process.env.CLAUDE_CONFIG_DIR || config.HOME, '.claude.json'), path.join(config.AUTH, '.claude.json')];
  return [...new Set(out)];
}
function identities() {
  const ids = readJson(IDS_FILE, {}) || {};
  let changed = false;
  for (const f of claudeJsonFiles()) {
    const o = (readJson(f, null) || {}).oauthAccount;
    if (!o || !o.accountUuid) continue;
    const cur = ids[o.accountUuid] || { orgs: {} };
    const next = { ...cur, email: o.emailAddress || cur.email || null, name: o.displayName || o.fullName || cur.name || null, orgs: { ...cur.orgs } };
    if (o.organizationUuid) next.orgs[o.organizationUuid] = o.organizationName || next.orgs[o.organizationUuid] || null;
    if (JSON.stringify(next) !== JSON.stringify(cur)) { ids[o.accountUuid] = next; changed = true; }
  }
  if (changed) { try { ensureDir(DIR); writeJsonAtomic(IDS_FILE, ids); } catch {} }
  return ids;
}
function labels() { return { user: readJson(LABELS_FILE, {}) || {}, ids: identities() }; }
function setLabel(scopeKey, label) {
  ensureDir(DIR);
  const cur = readJson(LABELS_FILE, {}) || {};
  if (label) cur[scopeKey] = String(label).trim().slice(0, 60); else delete cur[scopeKey];
  writeJsonAtomic(LABELS_FILE, cur);
  return cur;
}
function identityFor(scope, known) {
  const k = known || labels();
  const id = k.ids[scope.account] || {};
  return { userLabel: k.user[scope.key] || null, email: id.email || null, name: id.name || null,
           orgName: (id.orgs || {})[scope.org] || null };
}
function labelFor(scope, known) {
  const i = identityFor(scope, known);
  const base = i.userLabel || i.name || i.email || ('Account ' + scope.account.slice(0, 8));
  const pre = { '3p:': 'Gateway mode · ', 'msix:': 'Store app · ', 'msix3p:': 'Store app Gateway · ' }[scope.prefix] || '';
  return pre + base;
}

// ---------------------------------------------------------------- the dated-fact store
function loadState() {
  let s = readJson(STATE_FILE, null);
  if (!s || s.version !== STATE_VERSION) s = { version: STATE_VERSION, firstRunAt: null, runs: 0, observed: {}, tombstones: {} };
  s.observed = s.observed || {}; s.tombstones = s.tombstones || {};
  return s;
}
function saveState(state) { ensureDir(DIR); writeJsonAtomic(STATE_FILE, state, 0); }

function bucket(state, key, kind) {
  state.observed[key] = state.observed[key] || {};
  return (state.observed[key][kind] = state.observed[key][kind] || {});
}
function tombBucket(state, key, kind) {
  state.tombstones[key] = state.tombstones[key] || {};
  return (state.tombstones[key][kind] = state.tombstones[key][kind] || {});
}

// Compare what is on disk with the last observation and turn differences into dated facts.
//   new             -> changedAt = now
//   same value      -> changedAt KEPT (refreshing it would make last-write-wins meaningless)
//   other value     -> changedAt = now
//   gone            -> tombstone, but only for a record this sync previously synced, never in a
//                      scope Desktop is rewriting from memory, and never for a mass vanish
//                      (more than 3 and at least 25%: a replaced file, not a person deleting).
function observe(state, key, kind, values, opts = {}) {
  const now = opts.now || new Date().toISOString();
  const seen = bucket(state, key, kind), tombs = tombBucket(state, key, kind);
  const ch = { added: [], changed: [], vanished: [], tombstoned: [] };
  for (const id of Object.keys(values)) {
    const v = values[id], sig = JSON.stringify(v), prior = seen[id];
    if (!prior) { seen[id] = { value: v, sig, changedAt: now, firstSeenAt: now, present: true }; ch.added.push(id); }
    else if (prior.sig !== sig || prior.present === false) {
      seen[id] = { value: v, sig, changedAt: now, firstSeenAt: prior.firstSeenAt || now, present: true };
      ch.changed.push(id);
      delete tombs[id];
    } else prior.present = true;
  }
  const gone = [];
  for (const id of Object.keys(seen)) {
    if (values[id] !== undefined || seen[id].present === false) continue;
    seen[id].present = false; seen[id].goneNoticedAt = now;
    ch.vanished.push(id); gone.push(id);
  }
  const known = Object.keys(seen).length;
  const mass = gone.length > 3 && gone.length >= Math.max(1, Math.floor(known * 0.25));
  if (opts.noTombstones) {
    if (gone.length) ch.tombstonesRefused = { reason: opts.noTombstonesReason || 'unsafe to judge', ids: gone };
  } else if (mass) {
    ch.tombstonesRefused = { reason: gone.length + ' of ' + known + ' vanished at once (a replaced file, not a person deleting)', ids: gone };
  } else {
    for (const id of gone) {
      if (opts.syncedIds && opts.syncedIds.has(id)) { tombs[id] = { goneAt: now, lastValue: seen[id].value }; ch.tombstoned.push(id); }
    }
  }
  return ch;
}

function deletedHere(state, key, kind, id, competingChangedAt) {
  const t = tombBucket(state, key, kind)[id];
  if (!t) return null;
  if (competingChangedAt && Date.parse(competingChangedAt) > Date.parse(t.goneAt)) return null;
  return t;
}
function changedAtOf(state, key, kind, id) { const e = bucket(state, key, kind)[id]; return e ? e.changedAt : null; }

// The scan cache: "is this file worth re-reading?" Kept apart from the observations on purpose.
let scanCache = null;
function cacheFor(key) {
  if (!scanCache) scanCache = readJson(CACHE_FILE, {}) || {};
  return (scanCache[key] = scanCache[key] || {});
}
function resetCache() { scanCache = null; }
function invalidate(key, id) { if (scanCache && scanCache[key]) delete scanCache[key][id]; }
function saveCache() { if (!scanCache) return; try { ensureDir(DIR); writeJsonAtomic(CACHE_FILE, scanCache, 0); } catch {} }

// ---------------------------------------------------------------- backups, journal, lock
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
function backup(file, tag) {
  if (!fs.existsSync(file)) return null;
  ensureDir(BACKUP_DIR);
  const dest = path.join(BACKUP_DIR, path.basename(file) + '.' + (tag || 'sync') + '.' + stamp());
  fs.copyFileSync(file, dest);
  return dest;
}
function pruneBackups(keep = 10) {
  let entries; try { entries = fs.readdirSync(BACKUP_DIR); } catch { return; }
  const groups = {};
  for (const e of entries) (groups[e.replace(/\.[0-9TZ\-]+$/, '')] = groups[e.replace(/\.[0-9TZ\-]+$/, '')] || []).push(e);
  for (const g of Object.values(groups)) {
    for (const old of g.sort().slice(0, Math.max(0, g.length - keep))) {
      try { fs.rmSync(path.join(BACKUP_DIR, old), { recursive: true, force: true }); } catch {}
    }
  }
}
function writeJournal(entries) {
  if (!entries.length) return null;
  ensureDir(JOURNAL_DIR);
  const f = path.join(JOURNAL_DIR, 'sync-' + stamp() + '.json');
  fs.writeFileSync(f, JSON.stringify({ at: new Date().toISOString(), entries }, null, 1));
  const all = fs.readdirSync(JOURNAL_DIR).filter(x => x.endsWith('.json')).sort();
  for (const old of all.slice(0, Math.max(0, all.length - 50))) { try { fs.rmSync(path.join(JOURNAL_DIR, old), { force: true }); } catch {} }
  return f;
}

// ONE WRITER. Two programs must never open the same leveldb or rewrite the same record at once,
// so every write happens under one lock file. `accounts.lockFile` lets Relaymote share the lock of
// another sync tool that uses the same create-exclusive convention; still, only one tool should
// sync automatically (docs/ACCOUNTS.md).
function lockFile() {
  const f = ((config.get().accounts || {}).lockFile || '').trim();
  return f ? path.resolve(f) : LOCK_FILE;
}
const LOCK_STALE_MS = 10 * 60 * 1000;
function lockHeld() {
  const f = lockFile(), m = mtime(f);
  return m >= 0 && Date.now() - m < LOCK_STALE_MS;
}
async function withLock(fn) {
  ensureDir(DIR);
  const file = lockFile();
  ensureDir(path.dirname(file));
  let fd;
  try { fd = fs.openSync(file, 'wx'); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    if (Date.now() - mtime(file) < LOCK_STALE_MS) throw Object.assign(new Error('another account sync is already running (' + file + ')'), { code: 'LOCKED' });
    fs.rmSync(file, { force: true });
    fd = fs.openSync(file, 'wx');
  }
  try { fs.writeSync(fd, String(process.pid)); return await fn(); }
  finally { try { fs.closeSync(fd); } catch {} fs.rmSync(file, { force: true }); }
}

// Records listed here keep their own model/effort/error; only the time fields (max) move.
const frozenIds = () => readJson(FREEZE_FILE, {}) || {};
function freeze(id, why) {
  if (!/^local_[0-9a-z-]+$/i.test(String(id || ''))) throw new Error('a session record id looks like local_<uuid>');
  ensureDir(DIR);
  const cur = frozenIds(); cur[id] = String(why || 'frozen by hand ' + new Date().toISOString().slice(0, 10)).slice(0, 200);
  writeJsonAtomic(FREEZE_FILE, cur);
  return cur;
}
function unfreeze(id) {
  const cur = frozenIds(); delete cur[id];
  ensureDir(DIR); writeJsonAtomic(FREEZE_FILE, cur);
  return cur;
}
// HOLD: while this file exists no session state (model/effort/error/unread) is written anywhere.
const held = () => fs.existsSync(HOLD_FILE);
function setHold(on, why) {
  ensureDir(DIR);
  if (on) fs.writeFileSync(HOLD_FILE, (why ? String(why).slice(0, 200) + '\n' : '') + new Date().toISOString() + '\n');
  else fs.rmSync(HOLD_FILE, { force: true });
  return held();
}

module.exports = {
  PROFILE, LOCALAPPDATA, DIR, STATE_FILE, LABELS_FILE, FREEZE_FILE, HOLD_FILE, BACKUP_DIR, JOURNAL_DIR, SNAP_DIR, SNAP_DIR_3P, LOG_FILE,
  VERIFY_FILE, VERDICT_FILE, LOCK_FILE, STATE_VERSION,
  log, readJson, writeJsonAtomic, ensureDir, stamp,
  profiles, groupsProfile, gatewayProfile, msixProfiles, listScopes, realScopes, liveScopes, newestWriteMs, lastKnownAccount,
  labels, setLabel, labelFor, identityFor, identities,
  loadState, saveState, bucket, tombBucket, observe, deletedHere, changedAtOf,
  cacheFor, invalidate, saveCache, resetCache,
  backup, pruneBackups, writeJournal, withLock, lockFile, lockHeld, frozenIds, freeze, unfreeze, held, setHold,
};
