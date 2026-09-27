// accounts-ops.js — the unattended and administrative paths, all on a throwaway sandbox:
//   * import from another sync tool's folder (dry run by default, source never changed, refuses
//     over existing history unless merge, forgotten groups stay forgotten);
//   * the shared lock file (a second writer is refused and does not overwrite the state);
//   * the boot window, the Desktop-exit pass and the account-switch transfer;
//   * launching Claude through Relaymote (repair capped, lock waited for, Store fallback) and its
//     logon hook against a FAKE registry - the real one is never touched;
//   * close-sync-reopen: nothing is closed without the confirm token; Store (MSIX) reopen fallback;
//   * the Advanced API actions.
'use strict';
const fx = require('./accounts-fixture');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { check } = fx;

(async () => {
  const pres = require('../lib/account-sync/presence');
  let deskState = 'absent', mainPid = 4242;
  pres.setProbe(async () => ({ state: deskState, procs: deskState === 'live' ? [{ pid: mainPid, age: 5, main: true, kids: true }] : [] }));
  const desk = s => { deskState = s; };
  const config = require('../lib/config');
  const sync = require('../lib/account-sync');
  const core = require('../lib/account-sync/core');
  const scope = require('../lib/account-scope');
  const launch = require('../lib/account-sync/launch');
  const cycle = require('../lib/account-sync/desktop-cycle');
  const api = require('../mobile/accounts');
  config.set({ modules: { accounts: true } });

  const AA = 'aaaaaaaa-0000-4000-8000-000000000001', AO = '0a0a0a0a-0000-4000-8000-000000000001', AO2 = '0a0a0a0a-0000-4000-8000-000000000009';
  const BA = 'bbbbbbbb-0000-4000-8000-000000000002', BO = '0b0b0b0b-0000-4000-8000-000000000002';
  const keyA = AA + '/' + AO, keyB = BA + '/' + BO;
  const A = fx.scopeDir(AA, AO), A2 = fx.scopeDir(AA, AO2), B = fx.scopeDir(BA, BO);
  const NOW = Date.now(), D = 86400000;
  const rec = (dir, n, when) => fx.writeRec(dir, fx.sid(n), { sessionId: fx.sid(n), isArchived: false, createdAt: 1, lastActivityAt: 1, title: 't' + n }, when);
  const has = (dir, n) => fs.existsSync(path.join(dir, fx.sid(n) + '.json'));
  rec(A, 1, NOW - 1000); rec(A2, 2, NOW - 2 * D); rec(B, 3, NOW - D);
  for (const d of [A, A2, B]) fx.writeTasks(d, []);
  const lines = r => (r.lines || []).concat((r.applied && r.applied.lines) || []).join('\n');

  // ---------------------------------------------------------------- import
  console.log('-- import from another sync tool');
  const SRC = path.join(fx.ROOT, 'other-tool');
  const iso = t => new Date(t).toISOString();
  const srcState = {
    version: 1, firstRunAt: iso(NOW - 30 * D), lastRunAt: iso(NOW - D), runs: 412,
    observed: { [keyA]: { records: { [fx.sid(1)]: { value: 'imported', changedAt: iso(NOW - 9 * D), firstSeenAt: iso(NOW - 30 * D), present: true } } } },
    tombstones: { [keyB]: { records: { [fx.sid(9)]: { deletedAt: iso(NOW - 5 * D), lastValue: 'x' } } } },
    syncedRecordIds: { [fx.sid(9)]: iso(NOW - 20 * D) }, syncedRoutineIds: { 'r-one': iso(NOW - 20 * D) },
    fileStamps: { 'some/file': 1 },
  };
  fs.mkdirSync(path.join(SRC, 'scope-snapshots'), { recursive: true });
  fs.writeFileSync(path.join(SRC, 'sync-state.json'), '\ufeff' + JSON.stringify(srcState));
  fs.writeFileSync(path.join(SRC, 'account-labels.json'), JSON.stringify({ [AA]: 'Work', 'cccccccc-0000-4000-8000-00000000000c': 'Elsewhere' }));
  fs.writeFileSync(path.join(SRC, 'state-sync-freeze.json'), JSON.stringify({ [fx.sid(3)]: 'keeps its own model', 'not-a-record': 'x' }));
  fs.writeFileSync(path.join(SRC, 'HOLD-STATE-SYNC'), '');
  const snapName = AA + '__' + AO + '.json';
  fs.writeFileSync(path.join(SRC, 'scope-snapshots', snapName), JSON.stringify({ scope: keyA, groups: [{ id: 'g1', name: 'Kept' }], assignments: {}, order: {}, forgotten: ['g-dead'], forgottenNames: ['old stuff'] }));
  fs.writeFileSync(path.join(SRC, 'scope-snapshots', AA + '__' + AO + '-before-restore.json'), JSON.stringify({ groups: [] }));
  const srcHash = fx.hashTree(SRC), batonHash0 = fx.hashTree(fx.BATON_ACCOUNTS);

  let im = await sync.importMigrate(SRC);
  check(im.ok && im.dryRun && /Preview only/.test(lines(im)) && fx.hashTree(fx.BATON_ACCOUNTS) === batonHash0, 'dry run by default: a preview, nothing written', lines(im));
  check(/412|1 dated fact\(s\), 1 tombstone\(s\), 1 synced record id\(s\), 1 synced routine id\(s\)/.test(lines(im)), 'the preview counts the history it would bring');
  check(/labels: 2 scope\(s\) named, 1 account\(s\) not on this computer/.test(lines(im)), 'an account label maps to every scope of that account; an unknown account is reported', lines(im));
  im = await sync.importMigrate(SRC, { apply: true });
  const st = core.loadState();
  check(im.ok && st.runs === 412 && st.observed[keyA].records[fx.sid(1)].value === 'imported' && st.tombstones[keyB].records[fx.sid(9)] && st.syncedRecordIds[fx.sid(9)], 'apply: dated facts, tombstones and synced ids imported as they were', lines(im));
  check(!st.fileStamps && st.importedFrom && st.importedFrom.runs === 412, 'the other tool\'s scan cache is left behind; the import is recorded');
  const lab = core.labels().user;
  check(lab[keyA] === 'Work' && lab[AA + '/' + AO2] === 'Work' && !lab[keyB], 'labels keyed by scope');
  check(core.frozenIds()[fx.sid(3)] === 'keeps its own model' && !core.frozenIds()['not-a-record'], 'the freeze list is imported (malformed ids dropped)');
  check(core.held(), 'a HOLD in the source holds Relaymote too');
  const snap = JSON.parse(fs.readFileSync(path.join(core.SNAP_DIR, snapName), 'utf8'));
  check(snap.forgotten.includes('g-dead') && snap.forgottenNames.includes('old stuff'), 'group snapshots imported with their forgotten lists');
  check(!fs.existsSync(path.join(core.SNAP_DIR, AA + '__' + AO + '-before-restore.json')), 'the other tool\'s own restore backups are not imported');
  check(fx.hashTree(SRC) === srcHash, 'the source folder is unchanged');
  const hNow = fx.hashTree(fx.BATON_ACCOUNTS);
  im = await sync.importMigrate(SRC, { apply: true });
  check(!im.ok && im.error === 'HAS_HISTORY' && fx.hashTree(fx.BATON_ACCOUNTS) === hNow, 'a second import over existing history is refused, nothing written');
  const st2 = core.loadState();
  st2.observed[keyA].records[fx.sid(1)].value = 'baton-own';
  core.saveState(st2);
  srcState.observed[keyA].records[fx.sid(7)] = { value: 'new-from-source', changedAt: iso(NOW - D), firstSeenAt: iso(NOW - D), present: true };
  fs.writeFileSync(path.join(SRC, 'sync-state.json'), JSON.stringify(srcState));
  const snap2 = JSON.parse(fs.readFileSync(path.join(SRC, 'scope-snapshots', snapName), 'utf8')); snap2.forgotten.push('g-dead-2');
  fs.writeFileSync(path.join(SRC, 'scope-snapshots', snapName), JSON.stringify(snap2));
  const srcHash2 = fx.hashTree(SRC);
  im = await sync.importMigrate(SRC, { apply: true, merge: true });
  const st3 = core.loadState();
  check(im.ok && st3.observed[keyA].records[fx.sid(1)].value === 'baton-own' && st3.observed[keyA].records[fx.sid(7)].value === 'new-from-source', '--merge: Relaymote\'s own fact wins, a new one is added', lines(im));
  check(JSON.parse(fs.readFileSync(path.join(core.SNAP_DIR, snapName), 'utf8')).forgotten.join() === 'g-dead,g-dead-2', 'forgotten lists are unioned');
  check(fs.readdirSync(core.BACKUP_DIR).filter(n => /^import-/.test(n)).length >= 1 && fx.hashTree(SRC) === srcHash2, 'what Relaymote had is backed up first; the source still unchanged');
  fs.writeFileSync(path.join(SRC, 'sync-state.json'), JSON.stringify({ ...srcState, version: 2 }));
  im = await sync.importMigrate(SRC, { merge: true });
  check(im.errors.some(e => /not a version 1 state file/.test(e)), 'a state file of another version is refused, not guessed at');
  sync.setHold(false);

  // ---------------------------------------------------------------- shared lock
  console.log('-- the shared lock file');
  const LOCK = path.join(fx.ROOT, 'shared', 'sync.lock');
  config.set({ accounts: { lockFile: LOCK } });
  fs.mkdirSync(path.dirname(LOCK), { recursive: true }); fs.writeFileSync(LOCK, '999');
  const runsBefore = core.loadState().runs;
  rec(B, 4, NOW - D);
  desk('absent');
  let r = await sync.run({ apply: true, presence: 'absent' });
  check(!r.ok && /another account sync is already running/.test(r.error) && !has(A, 4), 'a lock held by another tool: nothing written', r.error);
  check(core.loadState().runs === runsBefore, 'and the refused run does not overwrite the sync state the lock holder owns');
  check(core.lockHeld() && !fs.existsSync(core.LOCK_FILE), 'the configured lock is the one consulted');
  fs.rmSync(LOCK);
  r = await sync.run({ apply: true, presence: 'absent' });
  check(r.ok && has(A, 4) && !fs.existsSync(LOCK), 'lock released: the pass runs and releases it after');
  config.set({ accounts: { lockFile: '' } });

  // ---------------------------------------------------------------- boot window
  console.log('-- the boot window');
  rec(B, 5, NOW - D);
  config.set({ accounts: { autoSync: false } });
  check(await sync.bootPass() === null, 'auto-sync off: no boot pass');
  config.set({ accounts: { autoSync: true } });
  desk('live');
  r = await sync.bootPass();
  check(r && r.skipped && r.presence === 'live' && !has(A, 5), 'Desktop already up: skipped');
  desk('absent');
  r = await sync.bootPass();
  check(r && r.ok && r.trigger === 'boot' && has(A, 5), 'Desktop absent at Relaymote start: the pass runs and fills the account in use', JSON.stringify(r && r.trigger));

  // ---------------------------------------------------------------- the exit pass
  console.log('-- a pass on every Desktop exit');
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { stdio: 'ignore' });
  mainPid = child.pid;
  sync._testReset();
  desk('live');
  rec(B, 6, NOW - D);
  await new Promise(res => setTimeout(res, pres.CACHE_TTL_MS + 100));   // let the 2 s presence cache from the boot pass expire
  r = await sync.autoTick();
  check(sync.autoStatus().watchingPid === child.pid && !has(A, 6), 'Desktop running: its main process is watched, nothing written', JSON.stringify(r));
  child.kill();
  await new Promise(res => child.on('exit', res));
  desk('absent');
  r = await sync.autoTick();
  check(r && r.trigger === 'desktop-exit' && has(A, 6), 'Desktop exits: a pass runs at once (not waiting for the interval)', JSON.stringify(r));
  check(sync.autoStatus().watchingPid === null, 'nothing left to watch');
  config.set({ accounts: { autoSync: false } });

  // ---------------------------------------------------------------- account-switch transfer
  console.log('-- the account-switch "transfer" answer');
  rec(B, 10, NOW - D); rec(A, 11, NOW - 500);
  scope.raise({ changed: true, from: keyB, to: keyA });
  check(scope.answer('transfer').ok, 'setup: the question is answered "transfer"');
  desk('live');
  let t = await sync.transferTick({ presence: 'live' });
  check(t && !t.done && t.tries === 1 && t.pending > 0 && !has(A, 10), 'Desktop runs on the chosen account: kept pending, Desktop is not closed', JSON.stringify(t));
  check(await sync.transferTick({ presence: 'live' }) === null, 'not retried more than every 5 minutes');
  desk('absent');
  t = await sync.transferTick({ exited: true, presence: 'absent' });
  check(t && t.done && has(A, 10) && t.target === keyA, 'on Desktop exit: the chosen account receives the other account\'s work', JSON.stringify(t));
  check(!has(B, 11), 'only toward the chosen account: the other account is kept as it is');
  check(await sync.transferTick({ exited: true }) === null, 'done once, never repeated');
  rec(B, 12, NOW - D);
  scope.raise({ changed: true, from: keyA, to: keyB }); scope.answer('transfer');
  scope.raise({ changed: true, from: keyB, to: keyA }); scope.answer('transfer');
  r = await sync.autoTick();
  check(r && r.transfer && r.transfer.done && has(A, 12), 'the auto-sync tick acts on it even with auto-sync off', JSON.stringify(r));
  scope.raise({ changed: true, from: keyA, to: 'eeeeeeee-0000-4000-8000-00000000000e/x' }); scope.answer('transfer');
  t = await sync.transferTick({ exited: true });
  check(t && t.done && t.error === 'NO_TARGET', 'an account that is not on this computer: recorded, nothing written');

  // ---------------------------------------------------------------- launching through Relaymote
  console.log('-- launch Claude through Relaymote');
  const spawned = [];
  let clock = 0, lockTurns = 0;
  const deps = over => ({
    platform: 'win32', exists: () => false, aumid: async () => 'Vendor.Claude_abc123xyz!Claude',
    spawnDetached: (cmd, args) => { spawned.push([cmd, ...args].join(' ')); return true; },
    sleep: async ms => { clock += ms; }, now: () => clock, lockHeld: () => lockTurns-- > 0, presence: async () => 'absent', ...over,
  });
  let passes = 0;
  let L = await launch.launchThroughBaton({ pass: async () => { passes++; return { applied: { count: 3 } }; } }, deps());
  check(L.ok && passes === 1 && /pass done: 3 change/.test(L.log.join()) && L.started.how === 'msix', 'Desktop absent: repair first, then start', L.log.join(' | '));
  check(spawned.pop() === 'explorer.exe shell:AppsFolder\\Vendor.Claude_abc123xyz!Claude', 'no exe installed: the Store app is started by its AppsFolder id');
  L = await launch.launchThroughBaton({ pass: async () => { passes++; } }, deps({ presence: async () => 'live' }));
  check(L.ok && passes === 1 && /no pass: Desktop is live/.test(L.log.join()), 'Desktop already running: no pass, never closed, just started (a no-op for a running app)');
  lockTurns = 3;
  L = await launch.launchThroughBaton({ pass: async () => ({}) }, deps());
  check(L.ok && /waited 1\.5s for another writer/.test(L.log.join()), 'Desktop is started only after another writer releases the lock', L.log.join(' | '));
  L = await launch.launchThroughBaton({ pass: () => new Promise(() => {}), capMs: 40 }, deps({ now: () => Date.now(), sleep: ms => new Promise(res => setTimeout(res, ms)) }));
  check(L.ok && /hit the 0s cap/.test(L.log.join()), 'a pass that hangs is capped; Desktop still starts', L.log.join(' | '));
  L = await launch.launchThroughBaton({ pass: async () => { throw new Error('boom'); } }, deps());
  check(L.ok && /pass failed: boom/.test(L.log.join()), 'a failing pass still starts Desktop');
  L = await launch.launchThroughBaton({}, deps({ aumid: async () => null }));
  check(!L.ok && /could not start/.test(L.log.join()), 'nothing to start: reported, not claimed');

  console.log('-- the logon hook (fake registry)');
  const REG = new Map();
  const fakeReg = { platform: 'win32', reg: async args => {
    const [op] = args, name = args[args.indexOf('/v') + 1];
    if (op === 'query') { if (!REG.has(name)) throw new Error('not found'); return '\r\n' + launch.RUN_KEY + '\r\n    ' + name + '    REG_SZ    ' + REG.get(name) + '\r\n'; }
    if (op === 'add') { REG.set(name, args[args.indexOf('/d') + 1]); return 'ok'; }
    if (op === 'delete') { REG.delete(name); return 'ok'; }
    throw new Error('unexpected ' + op);
  } };
  let h = await launch.hookInstall(fakeReg);
  check(!h.ok && h.error === 'NO_RUN_ENTRY' && !fs.existsSync(launch.VBS_FILE), 'no startup entry to take over: refused, nothing written');
  const ORIGINAL = '"C:\\Users\\someone\\AppData\\Local\\AnthropicClaude\\claude.exe" --startup';
  REG.set('Claude', ORIGINAL);
  h = await launch.hookInstall(fakeReg);
  check(h.ok && /wscript\.exe .*launch-claude\.vbs/.test(REG.get('Claude')) && fs.existsSync(launch.VBS_FILE) && h.undo === 'baton accounts launch-hook remove', 'install: the startup entry now goes through Relaymote, with a one-command undo', REG.get('Claude'));
  const orig = core.readJson(launch.ORIG_FILE, null);
  check(orig && orig.value === ORIGINAL && /claude\.exe$/.test(orig.exe) && orig.args.join() === '--startup', 'the original entry is saved first');
  check(/accounts launch/.test(fs.readFileSync(launch.VBS_FILE, 'utf8')), 'the launcher runs "baton accounts launch" hidden');
  check((await launch.hookStatus(fakeReg)).installed && (await launch.hookInstall(fakeReg)).already, 'status says installed; installing twice changes nothing');
  h = await launch.hookRemove(fakeReg);
  check(h.ok && REG.get('Claude') === ORIGINAL && !fs.existsSync(launch.VBS_FILE) && !fs.existsSync(launch.ORIG_FILE), 'remove: the original entry is back byte for byte, our files are gone');
  REG.set('Claude', ORIGINAL);
  const deaf = { platform: 'win32', reg: async args => (args[0] === 'add' ? 'ok' : fakeReg.reg(args)) };
  h = await launch.hookInstall(deaf);
  check(!h.ok && h.error === 'NOT_WRITTEN' && REG.get('Claude') === ORIGINAL, 'a registry write that did not land is reported, not assumed');
  check(!(await launch.hookInstall({ platform: 'linux' })).ok, 'other platforms: unsupported, nothing done');

  // ---------------------------------------------------------------- close, sync, reopen
  console.log('-- close-sync-reopen: confirm first, Store fallback');
  const calls = [];
  let seq = ['live', 'absent'];
  const cyc = over => ({
    platform: 'win32', presence: async () => ({ state: seq.length > 1 ? seq.shift() : seq[0], procs: [{ pid: 77, age: 1, main: true, kids: true }] }),
    running: async () => [{ id: 's1', title: 'a running session' }], quit: async () => { calls.push('quit'); return 'app.quit'; },
    forceQuit: async () => { calls.push('force'); }, exePath: async () => null, sleep: async () => {},
    sync: async () => { calls.push('sync'); return { ok: true, applied: { count: 2 } }; },
    launch: () => calls.push('launch-exe'), aumid: async () => 'Vendor.Claude_abc123xyz!Claude', launchMsix: id => calls.push('msix ' + id), ...over,
  });
  let c = await cycle.closeSyncReopen({}, cyc());
  check(!c.ok && c.needsConfirm && c.running.length === 1 && calls.length === 0, 'without the confirm token nothing is closed: the running session is listed first');
  seq = ['live', 'absent'];
  c = await cycle.closeSyncReopen({ confirm: 'wrong' }, cyc());
  check(c.needsConfirm && calls.length === 0, 'a stale or wrong token closes nothing');
  seq = ['live', 'absent'];
  c = await cycle.closeSyncReopen({ confirm: cycle.tokenFor([{ id: 's1' }]) }, cyc());
  check(c.ok && c.reopened && calls.join() === 'quit,sync,msix Vendor.Claude_abc123xyz!Claude', 'confirmed: quit gracefully, sync, reopen the Store app by its AppsFolder id', calls.join());

  // ---------------------------------------------------------------- Advanced API
  console.log('-- the Advanced API');
  let a = await api.handle('/api/accounts/hold', { on: true });
  check(a.status === 200 && core.held(), 'hold on');
  a = await api.handle('/api/accounts/hold', { on: false });
  check(!core.held(), 'hold off');
  a = await api.handle('/api/accounts/freeze', { id: 'bad id' });
  check(a.status === 409 && !a.body.ok, 'freeze refuses something that is not a record id');
  a = await api.handle('/api/accounts/freeze', { id: fx.sid(5), why: 'test' });
  check(a.status === 200 && core.frozenIds()[fx.sid(5)] === 'test', 'freeze a record');
  a = await api.handle('/api/accounts/freeze', { id: fx.sid(5), on: false });
  check(!core.frozenIds()[fx.sid(5)], 'unfreeze it');
  a = await api.handle('/api/accounts/forget', { scope: keyA, group: 'g-x' });
  check(a.status === 200 && a.body.forgotten.includes('g-x'), 'forget a group');
  a = await api.handle('/api/accounts/groups-restore', { stamp: 'no-such-stamp' });
  check(a.status === 409 && a.body.error === 'NO_BACKUP', 'restore of a backup that does not exist: refused');
  check(await api.handle('/api/accounts/nope', {}) === null, 'an unknown action falls through');
  const s = api.saveSettings({ foldGroups: true, syncState: false, firstRunMode: 'archived-wins', lockFile: ' ' + LOCK + ' ', autoSync: 'yes' });
  check(s.foldGroups === true && s.syncState === false && s.firstRunMode === 'archived-wins' && s.lockFile === LOCK && s.autoSync === false, 'settings: the new toggles are saved; a non-boolean is ignored');

  fx.done('ops');
})().catch(fx.fail);
