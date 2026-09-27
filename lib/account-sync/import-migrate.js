// import-migrate.js — take over the history of an earlier account-sync tool, so switching to
// Relaymote does not restart its tombstone history.
//
// Why it matters: a deletion is only ever propagated against a tombstone, and a tombstone is only
// earned by a record the sync itself copied (syncedRecordIds/...). A fresh start forgets which
// records were synced, and every archive/unarchive gets re-dated from "now". Importing keeps the
// dated facts, the tombstones and the synced-id lists exactly as the earlier tool left them.
//
// Reads (never writes) from the source dir:
//   sync-state.json          { version: 1, observed, tombstones, syncedRecordIds, syncedRoutineIds, ... }
//                            - the same format Relaymote uses; `fileStamps` (a scan cache) is skipped
//   account-labels.json      { "<account uuid>": "label" }  -> Relaymote labels keyed by scope
//   state-sync-freeze.json   { "local_<id>": "why" }        -> Relaymote freeze list
//   HOLD-STATE-SYNC          (file present = state sync paused) -> Relaymote HOLD
//   scope-snapshots/*.json   sidebar-group high-water snapshots incl. `forgotten` lists
//   scope-snapshots-3p/*.json  the same for Gateway mode
// Dry run by default. apply: writes into Relaymote's accounts dir after backing up what is there.
// Refuses when Relaymote already has sync history, unless merge is set (then: Relaymote's own facts
// win where both hold one, tombstones and synced ids are unioned, forgotten lists are unioned).
'use strict';
const fs = require('fs');
const path = require('path');
const core = require('./core');

const SNAP_RE = /^[^\\/]+__[^\\/]+\.json$/;
const isFile = p => { try { return fs.statSync(p).isFile(); } catch { return false; } };
function readStrict(f) {
  const txt = fs.readFileSync(f, 'utf8');
  return JSON.parse(txt.charCodeAt(0) === 0xfeff ? txt.slice(1) : txt);
}

function readSource(dir) {
  const src = { dir, errors: [], state: null, labels: null, freeze: null, hold: false, snaps: {}, snaps3p: {} };
  const f = n => path.join(dir, n);
  if (isFile(f('sync-state.json'))) {
    try {
      const s = readStrict(f('sync-state.json'));
      if (!s || s.version !== core.STATE_VERSION || typeof s.observed !== 'object') src.errors.push('sync-state.json: not a version ' + core.STATE_VERSION + ' state file');
      else src.state = s;
    } catch (e) { src.errors.push('sync-state.json: ' + e.message); }
  }
  for (const [name, key] of [['account-labels.json', 'labels'], ['state-sync-freeze.json', 'freeze']]) {
    if (!isFile(f(name))) continue;
    try { const v = readStrict(f(name)); if (v && typeof v === 'object' && !Array.isArray(v)) src[key] = v; else src.errors.push(name + ': not an object'); }
    catch (e) { src.errors.push(name + ': ' + e.message); }
  }
  src.hold = isFile(f('HOLD-STATE-SYNC'));
  for (const [sub, key] of [['scope-snapshots', 'snaps'], ['scope-snapshots-3p', 'snaps3p']]) {
    let names = []; try { names = fs.readdirSync(f(sub)); } catch { continue; }
    for (const n of names) {
      if (!SNAP_RE.test(n) || /-before-/.test(n) || !isFile(path.join(f(sub), n))) continue;
      try {
        const v = readStrict(path.join(f(sub), n));
        if (v && Array.isArray(v.groups)) src[key][n] = v; else src.errors.push(sub + '/' + n + ': not a group snapshot');
      } catch (e) { src.errors.push(sub + '/' + n + ': ' + e.message); }
    }
  }
  return src;
}

const hasHistory = s => !!(s && (s.firstRunAt || s.runs || Object.keys(s.observed || {}).length || Object.keys(s.tombstones || {}).length));
const minIso = (a, b) => (!a ? b : !b ? a : (Date.parse(a) <= Date.parse(b) ? a : b));
const maxIso = (a, b) => (!a ? b : !b ? a : (Date.parse(a) >= Date.parse(b) ? a : b));

// Deep-merge scope -> kind -> id maps; `mine` wins where both have an entry.
function mergeNested(mine, theirs) {
  const out = JSON.parse(JSON.stringify(mine || {}));
  let added = 0;
  for (const [scope, kinds] of Object.entries(theirs || {})) {
    out[scope] = out[scope] || {};
    for (const [kind, ids] of Object.entries(kinds || {})) {
      out[scope][kind] = out[scope][kind] || {};
      for (const [id, v] of Object.entries(ids || {})) if (!(id in out[scope][kind])) { out[scope][kind][id] = v; added++; }
    }
  }
  return { out, added };
}
const countNested = o => Object.values(o || {}).reduce((n, k) => n + Object.values(k || {}).reduce((m, ids) => m + Object.keys(ids || {}).length, 0), 0);

function mergeState(mine, theirs) {
  const base = mine && hasHistory(mine) ? mine : core.loadState();
  const obs = mergeNested(base.observed, theirs.observed), tomb = mergeNested(base.tombstones, theirs.tombstones);
  const out = { ...base, version: core.STATE_VERSION, observed: obs.out, tombstones: tomb.out };
  for (const k of ['syncedRecordIds', 'syncedRoutineIds', 'syncedGroupIds', 'syncedAssignIds']) {
    if (!theirs[k] && !base[k]) continue;
    out[k] = { ...(theirs[k] || {}), ...(base[k] || {}) };
  }
  out.firstRunAt = minIso(base.firstRunAt, theirs.firstRunAt);
  out.lastRunAt = maxIso(base.lastRunAt, theirs.lastRunAt);
  out.lastAppliedAt = maxIso(base.lastAppliedAt, theirs.lastAppliedAt);
  out.runs = (base.runs || 0) + (theirs.runs || 0);
  out.importedFrom = { at: new Date().toISOString(), runs: theirs.runs || 0, firstRunAt: theirs.firstRunAt || null };
  return { state: out, addedObserved: obs.added, addedTombstones: tomb.added };
}

function mergeSnap(mine, theirs) {
  if (!mine) return theirs;
  const gid = g => g.id || g.name;
  const seen = new Set((mine.groups || []).map(gid));
  return {
    ...mine,
    groups: (mine.groups || []).concat((theirs.groups || []).filter(g => !seen.has(gid(g)))),
    assignments: { ...(theirs.assignments || {}), ...(mine.assignments || {}) },
    order: { ...(theirs.order || {}), ...(mine.order || {}) },
    forgotten: Array.from(new Set([...(mine.forgotten || []), ...(theirs.forgotten || [])])),
    forgottenNames: Array.from(new Set([...(mine.forgottenNames || []), ...(theirs.forgottenNames || [])])),
  };
}

// opts: { apply, merge, scopes (for mapping labels; default: the scopes on disk) }
function importMigrate(dir, opts = {}) {
  const out = { ok: true, dryRun: !opts.apply, source: dir, lines: [], wrote: [] };
  if (!dir || !fs.existsSync(dir)) return { ...out, ok: false, error: 'NO_SOURCE', lines: ['No such folder: ' + dir] };
  const src = readSource(dir);
  out.errors = src.errors;
  if (!src.state && !src.labels && !src.freeze && !Object.keys(src.snaps).length && !Object.keys(src.snaps3p).length && !src.hold) {
    return { ...out, ok: false, error: 'NOTHING_TO_IMPORT', lines: ['Nothing importable in ' + dir + (src.errors.length ? ' (' + src.errors.join('; ') + ')' : '')] };
  }
  const mine = core.readJson(core.STATE_FILE, null);
  const history = hasHistory(mine) && mine.version === core.STATE_VERSION;
  const snapClash = [...Object.keys(src.snaps).filter(n => isFile(path.join(core.SNAP_DIR, n))),
                     ...Object.keys(src.snaps3p).filter(n => isFile(path.join(core.SNAP_DIR_3P, n)))];
  if ((history || snapClash.length) && !opts.merge) {
    return { ...out, ok: false, error: 'HAS_HISTORY',
      lines: ['Relaymote already has account-sync history' + (history ? ' (' + (mine.runs || 0) + ' run(s) since ' + mine.firstRunAt + ')' : '') +
              (snapClash.length ? ' and ' + snapClash.length + ' group snapshot(s)' : '') + '. Nothing imported. Add --merge to combine them (Relaymote\'s own facts win where both have one).'] };
  }

  // sync state
  let nextState = null;
  if (src.state) {
    if (history) {
      const m = mergeState(mine, src.state);
      nextState = m.state;
      out.lines.push('sync history: merge ' + m.addedObserved + ' dated fact(s) and ' + m.addedTombstones + ' tombstone(s) into Relaymote\'s own');
    } else {
      const { fileStamps, ...rest } = src.state;
      nextState = { ...rest, version: core.STATE_VERSION, observed: rest.observed || {}, tombstones: rest.tombstones || {},
                    importedFrom: { at: new Date().toISOString(), runs: rest.runs || 0, firstRunAt: rest.firstRunAt || null } };
      out.lines.push('sync history: ' + countNested(nextState.observed) + ' dated fact(s), ' + countNested(nextState.tombstones) + ' tombstone(s), ' +
        Object.keys(nextState.syncedRecordIds || {}).length + ' synced record id(s), ' + Object.keys(nextState.syncedRoutineIds || {}).length + ' synced routine id(s) since ' + (nextState.firstRunAt || '?'));
    }
  }

  // labels: account uuid -> every scope of that account on this computer
  let nextLabels = null;
  if (src.labels) {
    const scopes = opts.scopes || core.listScopes();
    const cur = core.readJson(core.LABELS_FILE, {}) || {};
    nextLabels = { ...cur };
    let mapped = 0, kept = 0; const unmatched = [];
    for (const [acct, label] of Object.entries(src.labels)) {
      if (typeof label !== 'string' || !label.trim()) continue;
      const mineScopes = scopes.filter(s => s.account === acct);
      if (!mineScopes.length) { unmatched.push(acct.slice(0, 8)); continue; }
      for (const s of mineScopes) { if (cur[s.key]) { kept++; continue; } nextLabels[s.key] = label.trim().slice(0, 60); mapped++; }
    }
    out.lines.push('labels: ' + mapped + ' scope(s) named' + (kept ? ', ' + kept + ' already named in Relaymote (kept)' : '') + (unmatched.length ? ', ' + unmatched.length + ' account(s) not on this computer (' + unmatched.join(', ') + ')' : ''));
  }

  // freeze list
  let nextFreeze = null;
  if (src.freeze) {
    const cur = core.frozenIds();
    const good = Object.entries(src.freeze).filter(([id]) => /^local_[0-9a-z-]+$/i.test(id));
    nextFreeze = { ...Object.fromEntries(good.map(([id, why]) => [id, String(why || '').slice(0, 200)])), ...cur };
    out.lines.push('freeze list: ' + good.length + ' record(s)');
  }
  if (src.hold) out.lines.push('state sync is ON HOLD in the source: Relaymote will hold too');

  // group snapshots
  const snapPlan = [];
  for (const [set, dest] of [[src.snaps, core.SNAP_DIR], [src.snaps3p, core.SNAP_DIR_3P]]) {
    for (const [n, v] of Object.entries(set)) {
      const f = path.join(dest, n), cur = core.readJson(f, null);
      snapPlan.push({ f, value: cur ? mergeSnap(cur, v) : { ...v, forgotten: v.forgotten || [] } });
    }
  }
  if (snapPlan.length) {
    const forgot = snapPlan.reduce((n, s) => n + (s.value.forgotten || []).length, 0);
    out.lines.push('group snapshots: ' + snapPlan.length + ' (' + forgot + ' deliberately deleted group(s) stay forgotten)');
  }
  if (src.errors.length) out.lines.push('skipped: ' + src.errors.join('; '));

  if (!opts.apply) { out.lines.push('Preview only - nothing written. Add --apply to import. The source folder is never changed.'); return out; }

  // back up what Relaymote has, then write
  const bdir = path.join(core.BACKUP_DIR, 'import-' + core.stamp());
  core.ensureDir(bdir);
  for (const f of [core.STATE_FILE, core.LABELS_FILE, core.FREEZE_FILE]) if (isFile(f)) fs.copyFileSync(f, path.join(bdir, path.basename(f)));
  for (const d of [core.SNAP_DIR, core.SNAP_DIR_3P]) {
    let names = []; try { names = fs.readdirSync(d); } catch {}
    for (const n of names) { core.ensureDir(path.join(bdir, path.basename(d))); fs.copyFileSync(path.join(d, n), path.join(bdir, path.basename(d), n)); }
  }
  core.ensureDir(core.DIR);
  if (nextState) { core.saveState(nextState); out.wrote.push(core.STATE_FILE); }
  if (nextLabels) { core.writeJsonAtomic(core.LABELS_FILE, nextLabels); out.wrote.push(core.LABELS_FILE); }
  if (nextFreeze) { core.writeJsonAtomic(core.FREEZE_FILE, nextFreeze); out.wrote.push(core.FREEZE_FILE); }
  if (src.hold) { core.setHold(true, 'imported'); out.wrote.push(core.HOLD_FILE); }
  for (const s of snapPlan) { core.ensureDir(path.dirname(s.f)); core.writeJsonAtomic(s.f, s.value); out.wrote.push(s.f); }
  core.resetCache();
  out.backup = bdir;
  out.lines.push('Imported. What Relaymote had before is kept in ' + bdir + '.');
  core.log('IMPORT from ' + dir + ': ' + out.lines.join(' | '));
  return out;
}

module.exports = { importMigrate, readSource, mergeState, hasHistory };
