// account-sync.js — keep several Claude accounts (or orgs) on one computer looking the same.
//
// Claude Desktop keeps session records, archive state, routines and sidebar groups per
// (account, org) scope, so switching account shows a different app. This plans and applies a
// two-way sync between the scopes. Dry run by default: run({ apply: true }) is the only writer.
//
// What may be written depends on Desktop, because it holds only the ACTIVE scope in memory:
//   Desktop closed (absent / orphans-only)  every scope, and the sidebar groups
//   Desktop running (live / launching)      every scope except the live ones; groups wait
//   presence unknown                        nothing
// Anything that has to wait is reported as pending and applied on a later run with Desktop
// closed: on every Desktop exit, and when Relaymote starts before Desktop does (the boot window).
//
// A presence measured earlier (a string handed down by a caller) may start a pass or refuse
// one, but it never permits a write to the active scope or to the group stores: those are
// re-checked FRESH inside the write lock, the groups immediately before the leveldb is opened.
'use strict';
const fs = require('fs');
const path = require('path');
const config = require('./config');
const core = require('./account-sync/core');
const pres = require('./account-sync/presence');
const records = require('./account-sync/records');
const routines = require('./account-sync/routines');
const groups = require('./account-sync/groups');
const verify = require('./account-sync/verify');

const MAX_SCOPES = 6;
const ROLES = ['keep', 'add', 'two-way'];
const ADDITIVE = new Set(['copyRecord', 'routineCopy', 'groups']);

// Each scope's role for this run. 'keep': never written. 'add' (default): receives what it
// lacks, plus - unless switched off - the archive state and session details (model, effort,
// error badge, unread), which change a value but never remove anything. 'two-way': also takes
// routine edits and group moves. Removals need two-way AND allowDelete. A 'keep' set in the
// settings always wins; a target given for one run makes every other scope 'keep'.
function makeRoles(opts, acfg) {
  const ok = r => ROLES.includes(r) ? r : null;
  const cfgRoles = acfg.roles || {}, runRoles = opts.roles || {};
  return key => {
    if (opts.target) return key === opts.target && ok(runRoles[key] || cfgRoles[key]) !== 'keep' ? (ok(opts.mode) || 'add') : 'keep';
    const r = ok(runRoles[key]) || ok(cfgRoles[key]);
    if (r === 'keep') return 'keep';
    return ok(opts.mode) || r || ok(acfg.mode) || 'add';
  };
}
function allowedFor(op, role, t) {
  if (role === 'keep') return false;
  if (role === 'two-way') return true;
  if (ADDITIVE.has(op)) return true;
  if (op === 'setArchived') return t.syncArchive;
  if (op === 'setFields') return t.syncState;
  return false;
}
const OP_FIELD = {
  copyRecord: 'records', setArchived: 'archive', setFields: 'state', deleteRecord: 'deletes',
  routineCopy: 'routines', routineUpdate: 'routines', routineDelete: 'deletes', groups: 'groups',
};

function pairsOf(scopes) {
  const out = [];
  for (let i = 0; i < scopes.length; i++) for (let j = i + 1; j < scopes.length; j++) out.push([scopes[i], scopes[j]]);
  return out;
}
const blank = () => ({ records: 0, archive: 0, state: 0, routines: 0, groups: 0, assignments: 0, deletes: 0 });

// Which scopes a presence state lets us write.
function writableFor(presence) {
  if (pres.safeToWriteAll(presence)) return { set: 'all', why: 'Desktop is ' + presence + ': every scope is writable' };
  if (presence === 'unknown' || !presence) return { set: 'none', why: 'presence could not be determined: nothing is writable' };
  return { set: 'inactive', why: 'Desktop is ' + presence + ': only the scopes it is not using are writable' };
}

function describeWritable(presence, active) {
  const w = writableFor(presence);
  if (w.set === 'all') return 'Claude Desktop is closed: every account and the sidebar groups can be written.';
  if (w.set === 'none') return 'Could not tell whether Claude Desktop is running, so nothing will be written.';
  if (!active) return 'Claude Desktop is running but the account it is using could not be identified, so nothing will be written.';
  return 'Claude Desktop is running: only the accounts it is not using are written now. The rest waits until Desktop is closed.';
}

function toggles(opts, acfg) {
  const pick = (o, c, d) => typeof o === 'boolean' ? o : typeof c === 'boolean' ? c : d;
  return {
    syncArchive: pick(opts.syncArchive, acfg.syncArchive, true),
    syncState: pick(opts.syncState, acfg.syncState, true),
    foldGroups: pick(opts.foldGroups, acfg.foldGroups, false),
    firstRunMode: records.FIRST_RUN_MODES.includes(opts.firstRunMode) ? opts.firstRunMode
      : records.FIRST_RUN_MODES.includes(acfg.firstRunMode) ? acfg.firstRunMode : 'baseline',
  };
}

async function run(opts = {}) {
  const apply = !!opts.apply;
  let save = opts.save !== false;
  const kinds = new Set(opts.kinds || ['records', 'routines', 'groups']);
  const getPresence = pres.resolver(opts.presence);
  const handedDown = typeof opts.presence === 'string';
  const p = await getPresence({ fresh: apply && !handedDown });
  const presence = p.state;
  const acfg = config.get().accounts || {};
  const t = toggles(opts, acfg);
  const all = core.realScopes();
  const pick = opts.scope || acfg.scope || 'all';
  const scopes = Array.isArray(pick) ? all.filter(s => pick.includes(s.key)) : all;
  const known = core.labels();
  const label = s => s ? core.labelFor(s, known) : '?';
  const lv = core.liveScopes(all);
  const closed = pres.safeToWriteAll(presence);
  const roleOf = makeRoles(opts, acfg);

  let writable = new Set();
  if (closed) writable = new Set(scopes.map(s => s.key));
  else if (presence !== 'unknown' && lv.active) writable = new Set(scopes.filter(s => !lv.live.has(s.key)).map(s => s.key));
  const judgeLive = closed ? new Set() : presence === 'unknown' ? new Set(scopes.map(s => s.key)) : lv.live;

  const out = {
    ok: true, dryRun: !apply, at: new Date().toISOString(), platform: process.platform,
    presence, presenceSource: handedDown ? 'handed down' : 'measured', desktopRunning: closed ? false : presence === 'unknown' ? null : true,
    active: lv.active, writableNote: describeWritable(presence, lv.active),
    groupsSupported: groups.available(), lines: [], scopes: [], totals: { now: blank(), pending: blank() },
    enabled: acfg.enabled !== false, mode: opts.target ? (opts.mode || 'add') : (opts.mode || acfg.mode || 'add'), target: opts.target || null,
    options: { ...t, hold: core.held(), allowDelete: !!opts.allowDelete }, trigger: opts.trigger || null,
  };
  if (apply && acfg.enabled === false && !opts.ignoreEnabled) {
    out.ok = false; out.error = 'SYNC_OFF'; out.lines.push('Account sync is switched off in the Accounts settings. Nothing was written.');
  }
  const state = core.loadState();
  out.firstRun = !state.firstRunAt;

  if (!out.ok) {
    // refused above
  } else if (scopes.length < 2) {
    out.lines.push(scopes.length ? 'Only one Claude account on this computer - nothing to sync.' : 'No Claude Desktop accounts found under ' + core.PROFILE);
  } else if (scopes.length > MAX_SCOPES) {
    out.ok = false; out.error = 'TOO_MANY_SCOPES';
    out.lines.push(scopes.length + ' account scopes found, more than the ' + MAX_SCOPES + ' this is built for. Nothing done.');
  }
  if (!closed && presence !== 'unknown' && lv.live.size > 1) {
    out.lines.push(lv.live.size + ' accounts were written in the last 10 minutes (two Desktops can run at once): all of them are treated as in use - ' +
                   [...lv.live].map(k => label(all.find(s => s.key === k))).join(', '));
  }

  let actions = [], groupsStatus = null, groupCounts = {}, gateway = null;
  if (out.ok && scopes.length >= 2) {
    // One clock per pass: every scope's observations carry the same time, so two scopes first seen
    // in the same pass can never look like one changed after the other.
    const ctx = { now: new Date().toISOString(), writable, live: judgeLive, groupsWritable: closed, pairs: pairsOf(scopes), label, roleOf,
                  allowDelete: !!opts.allowDelete, firstRunMode: t.firstRunMode, foldGroups: t.foldGroups };
    if (kinds.has('routines')) {
      const r = routines.plan(state, scopes, ctx);
      out.lines.push(...r.lines); actions = actions.concat(r.actions);
    }
    if (kinds.has('records')) {
      const r = records.plan(state, scopes, ctx);
      out.lines.push(...r.lines); actions = actions.concat(r.actions);
    }
    if (kinds.has('groups')) {
      try {
        const r = await groups.plan(state, scopes, ctx);
        out.lines.push(...r.lines); actions = actions.concat(r.actions);
        groupsStatus = r.status; groupCounts = r.counts; gateway = r.gateway;
      } catch (e) { groupsStatus = 'error'; out.lines.push('groups: ' + e.message); }
    }
  }
  out.groups = { status: groupsStatus, writable: closed && groups.available(), fold: t.foldGroups, gateway };
  actions = actions.filter(a => allowedFor(a.op, roleOf(a.to), t));

  const per = {};
  for (const s of scopes) per[s.key] = { now: blank(), pending: blank() };
  for (const a of actions) {
    const bucket = per[a.to] && per[a.to][a.pending ? 'pending' : 'now'];
    if (!bucket) continue;
    if (a.kind === 'groups') { bucket.groups += a.addGroups; bucket.assignments += a.addAssignments + (a.moved || 0); }
    else bucket[OP_FIELD[a.op]]++;
  }

  if (apply && out.ok) {
    let todo = actions.filter(a => !a.pending);
    const journal = [], applied = [];
    let wrote = [];
    try {
      await core.withLock(async () => {
        // The scope Desktop last used can only be written while Desktop is closed. Whatever the
        // caller measured before, ask again now, for real, inside the lock.
        const onLive = todo.filter(a => a.kind !== 'groups' && lv.live.has(a.to));
        if (onLive.length) {
          const again = await getPresence({ fresh: true });
          if (!pres.safeToWriteAll(again.state)) {
            todo = todo.filter(a => !(a.kind !== 'groups' && lv.live.has(a.to)));
            applied.push('Claude Desktop is ' + again.state + ' (checked just before writing): ' + onLive.length + ' change(s) to the account it uses were left for later.');
          }
        }
        const rt = todo.filter(a => a.kind === 'routines'), rc = todo.filter(a => a.kind === 'records'), gp = todo.filter(a => a.kind === 'groups');
        if (gp.length) {
          // groups.apply re-checks presence itself, fresh, immediately before opening the leveldb.
          try {
            const g = await groups.apply(state, gp, journal, { presence: typeof opts.presence === 'function' ? opts.presence : undefined });
            applied.push(...g.lines); wrote = g.wrote || [];
          } catch (e) { applied.push('groups: NOT written - ' + e.message); }
        }
        if (rt.length) applied.push(...routines.apply(state, scopes, rt, journal).lines);
        if (rc.length) applied.push(...records.apply(state, scopes, rc, journal).lines);
      });
    } catch (e) {
      out.ok = false; out.error = e.message; applied.push('apply stopped: ' + e.message);
      // Another writer holds the lock: it owns the sync state right now. Saving ours (read before
      // it wrote) would overwrite its synced ids and tombstones.
      if (e.code === 'LOCKED') save = false;
    }
    const jf = core.writeJournal(journal);
    core.pruneBackups(10);
    if (wrote.length) {
      verify.register(wrote);
      applied.push('groups: a check is armed - after Claude Desktop is next open for ' + verify.SETTLE_MS / 1000 + 's, both stores are counted again');
    }
    out.applied = { lines: applied.length ? applied : ['nothing to apply right now'], journal: jf, count: journal.filter(e => e.op !== 'stores' && e.op !== 'index').length + wrote.length };
    state.lastAppliedAt = out.at;
    core.log('APPLY presence=' + presence + (handedDown ? '(handed down)' : '') + (opts.trigger ? ' trigger=' + opts.trigger : '') + ' changes=' + journal.length + (jf ? ' journal=' + path.basename(jf) : ''));
    for (const l of applied) core.log('  ' + l);
  }

  for (const s of all) {
    const r = records.summary(s), rt = routines.summary(s), g = groupCounts[s.key] || null;
    const inc = !!per[s.key], c = per[s.key] || { now: blank(), pending: blank() };
    out.scopes.push({
      key: s.key, account: s.account, org: s.org, mode: s.mode, label: label(s), identity: core.identityFor(s, known),
      included: inc, role: inc ? roleOf(s.key) : null,
      records: r.records, archived: r.archived, routines: rt.routines, routinesEnabled: rt.routinesEnabled,
      groups: g ? g.groups : null, assignments: g ? g.assignments : null,
      active: s.key === lv.active, live: !closed && lv.live.has(s.key), writable: inc && writable.has(s.key),
      changes: c.now, pending: c.pending,
    });
    for (const k of Object.keys(out.totals.now)) { out.totals.now[k] += c.now[k]; out.totals.pending[k] += c.pending[k]; }
  }
  const sum = o => Object.values(o).reduce((a, b) => a + b, 0);
  out.changeCount = sum(out.totals.now); out.pendingCount = sum(out.totals.pending);
  out.lastSync = { appliedAt: state.lastAppliedAt || null, checkedAt: state.lastRunAt || null };
  out.verdict = verify.verdict();

  if (save) {
    state.firstRunAt = state.firstRunAt || out.at;
    state.runs = (state.runs || 0) + 1;
    state.lastRunAt = out.at;
    state.lastResult = { at: out.at, presence, applied: apply, changes: out.changeCount, pending: out.pendingCount };
    if (opts.auto) state.lastAutoAt = out.at;
    core.saveState(state);
  }
  core.saveCache();
  if (opts.actions) out.actions = actions;
  return out;
}

const status = opts => run({ ...(opts || {}), apply: false, save: false });

// Reverse one applied run from its journal. Desktop must be closed (checked fresh; a handed-down
// state can refuse but not permit). Group stores are restored from their backup after the
// current state is itself backed up, so an undo can be undone. Every scope's archive index is
// rebuilt afterwards.
async function undo(journalFile, opts = {}) {
  const p = await pres.resolver(opts.presence)({ fresh: true });
  if (!pres.safeToWriteAll(p.state)) return { ok: false, error: 'DESKTOP_RUNNING', message: 'Close Claude Desktop first (it is ' + p.state + ').' };
  const file = path.isAbsolute(journalFile || '') ? journalFile : path.join(core.JOURNAL_DIR, journalFile || '');
  const j = core.readJson(file, null);
  if (!j || !Array.isArray(j.entries)) return { ok: false, error: 'NO_JOURNAL', message: 'No journal at ' + file };
  const scopes = core.listScopes(), dirOf = k => (scopes.find(s => s.key === k) || {}).dir;
  let n = 0; const lines = [];
  await core.withLock(async () => {
    for (const e of j.entries.slice().reverse()) {
      try {
        if (e.kind === 'groups') {
          const r = await groups.restore(e, { presence: typeof opts.presence === 'function' ? opts.presence : undefined });
          lines.push('groups restored from ' + path.basename(r.restored) + '; what was there is kept in ' + path.basename(r.savedCurrentAs));
          n++; continue;
        }
        const d = dirOf(e.scope); if (!d) continue;
        const f = path.join(d, e.file);
        if (e.op === 'copyRecord') fs.rmSync(f, { force: true });
        else if (e.op === 'setArchived' || e.op === 'setFields') {
          const r = JSON.parse(fs.readFileSync(f, 'utf8'));
          if (e.op === 'setArchived') r.isArchived = e.was;
          else for (const k of records.STATE_FIELDS) { if (e.was[k] === undefined) delete r[k]; else r[k] = e.was[k]; }
          core.writeJsonAtomic(f, r);
          if (e.mtimeMs) fs.utimesSync(f, Date.now() / 1000, e.mtimeMs / 1000);
        } else if (e.backup && fs.existsSync(e.backup)) fs.copyFileSync(e.backup, f);
        else if (e.created) fs.rmSync(f, { force: true });
        else continue;
        n++;
      } catch (err) { lines.push('could not reverse ' + (e.file || e.kind) + ': ' + err.message); }
    }
    core.resetCache();
    for (const s of scopes) records.rebuildArchiveIndex(s, lines, null);
  });
  core.log('UNDO ' + path.basename(file) + ': ' + n + ' of ' + j.entries.length);
  return { ok: true, reversed: n, of: j.entries.length, journal: file, lines };
}

function journals() {
  try { return fs.readdirSync(core.JOURNAL_DIR).filter(f => f.endsWith('.json')).sort().reverse(); } catch { return []; }
}

// ---------------------------------------------------------------- advanced controls
function setHold(on) { const h = core.setHold(!!on, on ? 'paused from Relaymote' : ''); core.log('HOLD state sync ' + (h ? 'ON' : 'OFF')); return { ok: true, hold: h }; }
function freeze(id, why) { try { return { ok: true, frozen: core.freeze(id, why) }; } catch (e) { return { ok: false, error: e.message }; } }
function unfreeze(id) { return { ok: true, frozen: core.unfreeze(id) }; }
function groupBackups() { return groups.listBackups().map(b => ({ stamp: b.stamp, at: b.meta && b.meta.at, reason: b.meta && b.meta.reason, store: b.meta && b.meta.store })); }
async function restoreGroups(stamp, opts = {}) {
  try {
    return await core.withLock(() => groups.restoreBackup(stamp, { presence: typeof opts.presence === 'function' ? opts.presence : undefined }));
  } catch (e) { return { ok: false, error: e.message }; }
}
function forgetGroup(scope, groupId) { return groups.forget(scope, groupId); }
async function importMigrate(dir, opts = {}) {
  const im = require('./account-sync/import-migrate');
  if (!opts.apply) return im.importMigrate(dir, opts);
  try { return await core.withLock(async () => im.importMigrate(dir, opts)); }
  catch (e) { return { ok: false, error: e.message, lines: [e.message] }; }
}

// ---------------------------------------------------------------- unattended passes
// The boot window: Relaymote started and Desktop is not running (yet). Everything that waits for a
// closed Desktop can be done now, before Desktop's own autostart gets there. Only with auto-sync
// on, unless `force` (the opt-in launch hook, which the user set up for exactly this).
async function bootPass(opts = {}) {
  const cfg = config.get().accounts || {};
  if (!opts.force && (!config.mod('accounts') || !cfg.autoSync)) return null;
  if (cfg.enabled === false) return null;
  const probe = pres.resolver(opts.presence);
  const p = await probe({ fresh: true });
  if (!pres.safeToWriteAll(p.state)) return { skipped: true, presence: p.state };
  // Hand the measurement down so planning does not probe again; the write paths still do.
  return run({ apply: true, auto: true, trigger: opts.trigger || 'boot', presence: typeof opts.presence === 'function' ? opts.presence : p.state });
}

// An answered account-switch question ("bring my things to the account I switched to") is acted
// on here: a sync toward that account only, with every other account kept as it is. The account
// in use can only be written while Desktop is closed, so this repeats (at most every 5 minutes,
// and on every Desktop exit) until nothing is left pending, for up to 7 days. It never closes
// Desktop.
const TRANSFER_RETRY_MS = 5 * 60 * 1000, TRANSFER_TTL_MS = 7 * 86400000;
async function transferTick(opts = {}) {
  const scope = require('./account-scope');
  const q = scope.readPending();
  if (!q || q.answer !== 'transfer' || (q.transfer && q.transfer.done)) return null;
  const cfg = config.get().accounts || {};
  if (cfg.enabled === false) return null;
  const now = opts.now || Date.now(), tr = q.transfer || {};
  if (now - (q.answeredAt || now) > TRANSFER_TTL_MS) return scope.markTransfer({ ...tr, done: true, expired: true, at: new Date(now).toISOString() });
  if (tr.lastTryAt && now - Date.parse(tr.lastTryAt) < TRANSFER_RETRY_MS && !opts.exited) return null;
  const all = core.realScopes();
  const cands = all.filter(s => s.prefix === '' && (s.key === q.to || s.account === q.to));
  if (cands.length !== 1) {
    return scope.markTransfer({ ...tr, done: true, error: cands.length ? 'AMBIGUOUS_TARGET' : 'NO_TARGET', at: new Date(now).toISOString() });
  }
  const r = await run({ apply: true, auto: true, target: cands[0].key, mode: 'add', trigger: 'account-switch', presence: opts.presence });
  return scope.markTransfer({
    ...tr, target: cands[0].key, lastTryAt: new Date(now).toISOString(), tries: (tr.tries || 0) + 1,
    applied: (tr.applied || 0) + (r.applied ? r.applied.count : 0), pending: r.pendingCount, error: r.ok ? null : r.error,
    done: !!r.ok && r.pendingCount === 0,
  });
}

// ---------------------------------------------------------------- auto-sync
// Runs on the interval, on EVERY Desktop exit (the exit window), and at Relaymote start (boot
// window, see bootPass). Also drives the relaunch check and an answered account switch.
let busy = false, watchPid = null, lastAuto = null, lastPidProbe = 0;
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

async function autoTick(opts = {}) {
  if (busy || !config.mod('accounts')) return null;
  busy = true;
  try {
    const cfg = config.get().accounts || {};
    const exited = !!(watchPid && !alive(watchPid));
    let v = null, tr = null;
    try { v = await verify.tick(); } catch (e) { core.log('relaunch check failed: ' + e.message); }
    try { tr = await transferTick({ exited }); } catch (e) { core.log('account-switch transfer failed: ' + e.message); }
    if (exited) watchPid = null;
    const extra = { verdict: v && v.phase === 'AFTER RELAUNCH' ? v : null, transfer: tr };
    if (!cfg.autoSync) { watchPid = null; return extra.verdict || extra.transfer ? extra : null; }
    const st = core.loadState();
    const every = Math.max(5, Number(cfg.intervalMinutes) || 30) * 60000;
    const due = Date.now() - (Date.parse(st.lastAutoAt || '') || 0) >= every;
    if (!due && !exited) {
      // Learn Desktop's main pid (cheaply, once a minute) so its exit can be caught.
      if (!watchPid && Date.now() - lastPidProbe > 60000) {
        lastPidProbe = Date.now();
        const p = await pres.resolver(opts.presence)({});
        watchPid = pres.liveMainPid(p);
      }
      return extra.verdict || extra.transfer ? extra : null;
    }
    const r = await run({ apply: true, auto: true, trigger: exited ? 'desktop-exit' : 'interval', presence: opts.presence });
    watchPid = r.desktopRunning ? pres.liveMainPid(await pres.resolver(opts.presence)({})) : null;
    lastAuto = { at: r.at, trigger: exited ? 'desktop-exit' : 'interval', applied: r.applied ? r.applied.count : 0, pending: r.pendingCount, presence: r.presence, ...extra };
    return lastAuto;
  } catch (e) {
    lastAuto = { at: new Date().toISOString(), error: e.message };
    core.log('auto-sync failed: ' + e.message);
    return lastAuto;
  } finally { busy = false; }
}
const autoStatus = () => ({ ...(config.get().accounts || {}), watchingPid: watchPid, last: lastAuto });
const _testReset = () => { busy = false; watchPid = null; lastAuto = null; lastPidProbe = 0; };

module.exports = {
  run, status, undo, journals, autoTick, autoStatus, bootPass, transferTick, writableFor, allowedFor,
  setHold, freeze, unfreeze, groupBackups, restoreGroups, forgetGroup, importMigrate,
  setLabel: core.setLabel, labels: core.labels, core, presence: pres, verify, _testReset,
};
