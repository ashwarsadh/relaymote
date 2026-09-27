// accounts.js — the account sync against throwaway fake Claude profiles.
// It never reads or writes the real Claude folders: APPDATA, LOCALAPPDATA, CLAUDE_CONFIG_DIR and
// RELAYMOTE_HOME all point into a temp dir before anything is loaded, and every phase rebuilds the
// fake profile from scratch, so each mode is proven on its own fresh copy.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-accounts-'));
const APPDATA = path.join(ROOT, 'appdata');
Object.assign(process.env, {
  APPDATA, LOCALAPPDATA: path.join(ROOT, 'Local'), RELAYMOTE_LOCALAPPDATA: path.join(ROOT, 'Local'),
  CLAUDE_CONFIG_DIR: path.join(ROOT, 'claude'), RELAYMOTE_HOME: path.join(ROOT, 'relaymote'),
});

const A = { acct: '11111111-1111-4111-8111-111111111111', org: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
const B = { acct: '22222222-2222-4222-8222-222222222222', org: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };
const C = { acct: '33333333-3333-4333-8333-333333333333', org: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' };
const PROFILE = path.join(APPDATA, 'Claude');
const SESS = path.join(PROFILE, 'claude-code-sessions');
const LEVELDB = path.join(PROFILE, 'Local Storage', 'leveldb');
const dirOf = s => path.join(SESS, s.acct, s.org);
const keyOf = s => s.acct + '/' + s.org;
const sid = n => 'local_' + String(n).padStart(8, '0') + '-0000-4000-8000-000000000000';
const skey = n => 'code:' + sid(n);

let failed = 0;
const check = (ok, name, extra) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };

function record(n, o = {}) {
  return { sessionId: sid(n), cliSessionId: 'cli-' + n, cwd: '/tmp/project', createdAt: 1700000000000 + n,
    lastActivityAt: o.la || 1700000000000 + n, lastFocusedAt: o.lf || 1700000000000 + n, model: o.model || 'model-a',
    effort: 'medium', isArchived: !!o.archived, title: 'Session ' + n, completedTurns: 1, ...(o.error ? { error: o.error } : {}) };
}
function writeScope(s, recs, tasks, mtimeMs) {
  fs.mkdirSync(dirOf(s), { recursive: true });
  for (const [n, o] of recs) {
    const f = path.join(dirOf(s), sid(n) + '.json');
    fs.writeFileSync(f, JSON.stringify(record(n, o)));
    fs.utimesSync(f, new Date(mtimeMs), new Date(mtimeMs));
  }
  fs.writeFileSync(path.join(dirOf(s), 'scheduled-tasks.json'), JSON.stringify({ scheduledTasks: tasks, recordedSkips: [] }));
  if (recs.length) fs.writeFileSync(path.join(dirOf(s), 'archived-sessions.idx'), JSON.stringify({ v: 1, archived: recs.filter(([, o]) => o.archived).map(([n]) => sid(n)) }));
}
const task = (id, enabled, t) => ({ id, displayName: id, enabled, createdAt: 1700000000000, lastRunAt: new Date(t).toISOString(), cwd: '/tmp/project', filePath: '/tmp/tasks/' + id });

const GROUPS = {
  [keyOf(A)]: { groups: [{ id: 'cg-a1', name: 'Work' }], assignments: { [skey(1)]: 'cg-a1', [skey(3)]: 'cg-a1' }, order: { 'cg-a1': [skey(1), skey(3)] } },
  [keyOf(B)]: { groups: [{ id: 'cg-b1', name: 'Work ' }, { id: 'cg-b2', name: 'Personal' }],
    assignments: { [skey(5)]: 'cg-b1', [skey(2)]: 'cg-b2' }, order: { 'cg-b1': [skey(5)], 'cg-b2': [skey(2)] } },
};

let hasLevel = false;
async function build() {
  for (const d of ['appdata', 'claude', path.join('relaymote', 'accounts')]) fs.rmSync(path.join(ROOT, d), { recursive: true, force: true });
  const now = Date.now();
  writeScope(A, [[1, { la: 1800000000000, model: 'model-b' }], [2, {}], [3, { archived: true }], [4, {}]],
    [task('daily-report', true, now - 86400000), task('weekly-cleanup', false, now - 86400000 * 7)], now - 60000);
  writeScope(B, [[1, { error: "You've hit your weekly limit" }], [2, {}], [5, {}]], [task('inbox-digest', true, now - 3600000)], now - 3 * 3600000);
  fs.mkdirSync(path.join(SESS, A.acct, B.org), { recursive: true });
  fs.writeFileSync(path.join(SESS, A.acct, B.org, 'scheduled-tasks.json'), JSON.stringify({ scheduledTasks: [] }));
  fs.writeFileSync(path.join(PROFILE, 'config.json'), JSON.stringify({ lastKnownAccountUuid: A.acct }));
  fs.writeFileSync(path.join(PROFILE, 'claude_desktop_config.json'), JSON.stringify({ preferences: { epitaxyPrefs: { 'dframe-group-scopes': GROUPS } } }));
  fs.mkdirSync(path.join(ROOT, 'claude'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'claude', '.claude.json'), JSON.stringify({ oauthAccount: {
    accountUuid: A.acct, organizationUuid: A.org, emailAddress: 'work@example.com', displayName: 'Work', organizationName: 'Example Org' } }));
  let level = null; try { level = require('classic-level').ClassicLevel; } catch {}
  if (level) {
    const g = require('../lib/account-sync/groups');
    const db = new level(LEVELDB, { keyEncoding: 'buffer', valueEncoding: 'buffer' });
    await db.open();
    await db.put(g.lsKey(), g.encode(JSON.stringify({ value: GROUPS, version: 1 })));
    await db.put(Buffer.from('_https://claude.ai\x00\x01other-key'), g.encode('"untouched"'));
    await db.close();
  }
  try { require('../lib/account-sync/core').resetCache(); } catch {}
  hasLevel = !!level;
}

function hashTree(dir, skip) {
  const h = crypto.createHash('sha256');
  const walk = d => {
    let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); } catch { return; }
    for (const e of ents) {
      const f = path.join(d, e.name);
      if (skip && skip(f)) continue;
      if (e.isDirectory()) walk(f);
      else { h.update(path.relative(dir, f)); h.update(fs.readFileSync(f)); }
    }
  };
  walk(dir);
  return h.digest('hex');
}
const lsLog = f => /[\\/]leveldb[\\/](LOG|LOG\.old|LOCK)$/.test(f);
const ids = s => fs.readdirSync(dirOf(s)).filter(f => f.startsWith('local_')).sort();
const tasksOf = s => JSON.parse(fs.readFileSync(path.join(dirOf(s), 'scheduled-tasks.json'), 'utf8')).scheduledTasks;
const rec = (s, n) => JSON.parse(fs.readFileSync(path.join(dirOf(s), sid(n) + '.json'), 'utf8'));
const notBaton = f => f.startsWith(path.join(ROOT, 'relaymote'));

(async () => {
  await build();
  const config = require('../lib/config');
  const sync = require('../lib/account-sync');
  const groups = require('../lib/account-sync/groups');
  const cycle = require('../lib/account-sync/desktop-cycle');
  // Every write path re-probes Desktop for real; here the probe itself is the stub.
  let desk = 'absent';
  require('../lib/account-sync/presence').setProbe(async () => ({ state: desk, procs: desk === 'live' ? [{ pid: 4242, age: 999, main: true, kids: true }] : [] }));

  console.log('-- discovery and dry run');
  const before = hashTree(ROOT, notBaton);
  const dry = await sync.run({ presence: 'absent', mode: 'two-way' });
  const sa = dry.scopes.find(s => s.account === A.acct), keyA = sa.key, keyB = dry.scopes.find(s => s.account === B.acct).key;
  check(dry.ok && dry.dryRun && dry.scopes.length === 2, 'dry run sees the two real scopes, cross-account stub ignored', dry.scopes.map(s => s.records).join('/'));
  check(sa.label === 'Work' && sa.identity.email === 'work@example.com' && sa.identity.orgName === 'Example Org', 'account identity read from the CLI login');
  sync.setLabel(keyB, 'Personal');
  check((await sync.status({ presence: 'absent' })).scopes.find(s => s.key === keyB).label === 'Personal', 'a scope can be labelled by the user');
  check(dry.changeCount > 0, 'dry run plans changes', JSON.stringify(dry.totals.now));
  check(hashTree(ROOT, notBaton) === before, 'dry run changed no Claude file (hash before = after)');
  check(dry.active === keyA, 'active scope = the one with the newest record');

  console.log('-- two-way, Desktop running then closed');
  const aBefore = hashTree(dirOf(A));
  const cfgBefore = hashTree(PROFILE, f => f.startsWith(SESS) || lsLog(f));
  desk = 'live';
  const live = await sync.run({ apply: true, presence: 'live', mode: 'two-way' });
  desk = 'absent';
  check(live.ok && live.applied, 'apply while Desktop is running');
  check(hashTree(dirOf(A)) === aBefore, 'the ACTIVE scope was not written while Desktop runs');
  check(hashTree(PROFILE, f => f.startsWith(SESS) || lsLog(f)) === cfgBefore, 'groups (config + localStorage) not written while Desktop runs');
  check(ids(B).includes(sid(3) + '.json') && ids(B).includes(sid(4) + '.json'), 'inactive scope received the missing records');
  const tb = tasksOf(B);
  check(tb.length === 3 && tb.find(t => t.id === 'weekly-cleanup').enabled === false, 'routines copied, disabled one stays disabled');
  check(rec(B, 3).isArchived === true && JSON.parse(fs.readFileSync(path.join(dirOf(B), 'archived-sessions.idx'), 'utf8')).archived.includes(sid(3)), 'archived state copied and archive index rebuilt');
  check(rec(B, 1).model === 'model-b' && !rec(B, 1).error, 'two-way: newer model carried over, other account\'s limit error cleared');
  const pendA = live.scopes.find(s => s.key === keyA).pending;
  check(pendA.records >= 1 && pendA.routines >= 1, 'work for the active scope is reported pending', JSON.stringify(pendA));

  let probes = 0;
  const race = await sync.run({ apply: true, mode: 'two-way', foldGroups: true, presence: () => (++probes > 1 ? 'live' : 'absent') });
  check(probes >= 2 && race.applied.lines.some(l => /is live \(checked just before writing\)/.test(l)) && hashTree(dirOf(A)) === aBefore,
        'Desktop starting mid-apply: re-checked inside the lock, the active scope is still untouched', race.applied.lines.join(' | '));
  if (hasLevel) check(race.applied.lines.some(l => /groups: NOT written - Claude Desktop is live \(checked just before opening/.test(l)) &&
        hashTree(PROFILE, f => f.startsWith(SESS) || lsLog(f)) === cfgBefore, 'Desktop starting mid-apply: groups refused by the check right before the leveldb open');

  const closed = await sync.run({ apply: true, presence: 'absent', mode: 'two-way', foldGroups: true });
  check(closed.ok && closed.applied.count > 0, 'apply with Desktop closed', closed.applied.lines.join(' | '));
  check(JSON.stringify(ids(A)) === JSON.stringify(ids(B)), 'records match in both scopes', ids(A).length + ' each');
  check(JSON.stringify(tasksOf(A).map(t => t.id).sort()) === JSON.stringify(tasksOf(B).map(t => t.id).sort()), 'routines match in both scopes');
  if (hasLevel) {
    const st = await groups.readStores({ dir: PROFILE, prefix: '' });
    const ga = st.ls.scopes[keyOf(A)], gb = st.ls.scopes[keyOf(B)];
    const names = g => g.groups.map(x => groups.norm(x.name)).sort().join(',');
    check(names(ga) === 'personal,work' && names(gb) === 'personal,work', 'groups match, same-named group not duplicated', names(ga) + ' | ' + names(gb));
    check(ga.assignments[skey(5)] === 'cg-a1' && gb.assignments[skey(3)] === 'cg-b1', 'assignments mapped onto the existing group');
    check(JSON.stringify(st.cfg.scopes[keyOf(A)].groups) === JSON.stringify(ga.groups), 'config mirror written to match localStorage');
    const L = require('classic-level').ClassicLevel, db = new L(LEVELDB, { keyEncoding: 'buffer', valueEncoding: 'buffer', createIfMissing: false });
    await db.open(); const other = groups.decode(await db.get(Buffer.from('_https://claude.ai\x00\x01other-key'))); await db.close();
    check(other === '"untouched"', 'other localStorage keys untouched');
    check(fs.readdirSync(path.join(ROOT, 'relaymote', 'accounts', 'backups')).some(d => d.startsWith('groups-')), 'both group stores backed up before the write');
  } else console.log('skip groups checks: classic-level not installed');
  const again = await sync.run({ presence: 'absent', mode: 'two-way', foldGroups: true });
  check(again.changeCount === 0 && again.pendingCount === 0, 'second dry run: scopes already match', JSON.stringify(again.totals.now));

  const j = sync.journals()[0];
  const u = await sync.undo(j, { presence: 'absent' });
  check(u.ok && u.reversed > 0 && !ids(A).includes(sid(5) + '.json'), 'undo reverses the last applied run', u.reversed + '/' + u.of);
  check(!(await sync.undo(j, { presence: 'live' })).ok, 'undo refuses while Desktop runs');

  console.log('-- mode (a) keep this account as it is');
  await build();
  const keepA = hashTree(dirOf(A)), keepCfg = hashTree(PROFILE, f => f.startsWith(SESS) || lsLog(f));
  const kr = await sync.run({ apply: true, presence: 'absent', mode: 'two-way', roles: { [keyA]: 'keep' }, foldGroups: true });
  check(kr.ok && hashTree(dirOf(A)) === keepA, 'keep: nothing written to the kept account');
  check(ids(B).length === 5 && tasksOf(B).length === 3, 'keep: the other account still received everything');
  check(kr.scopes.find(s => s.key === keyA).role === 'keep' && kr.scopes.find(s => s.key === keyA).changes.records === 0, 'keep: plan shows no change for the kept account');
  if (hasLevel) {
    const st = await groups.readStores({ dir: PROFILE, prefix: '' });
    check(JSON.stringify(st.ls.scopes[keyOf(A)]) === JSON.stringify(GROUPS[keyOf(A)]) && st.ls.scopes[keyOf(B)].groups.length === 2,
          'keep: kept account\'s groups unchanged, the other got the additions');
  }

  console.log('-- mode (b) add the other account\'s data into this one');
  await build();
  const addA = hashTree(dirOf(A)), b1 = rec(B, 1);
  const ar = await sync.run({ apply: true, presence: 'absent', mode: 'add', target: keyB, foldGroups: true, syncState: false, syncArchive: false });
  check(ar.ok && hashTree(dirOf(A)) === addA, 'add: the source account is not written');
  check(ids(B).length === 5 && tasksOf(B).length === 3, 'add: target received the missing records and routines');
  check(JSON.stringify(rec(B, 1)) === JSON.stringify(b1), 'add with archive/details sync off: an existing record in the target is not overwritten');
  check(fs.readdirSync(path.join(ROOT, 'relaymote', 'accounts', 'backups')).length > 0, 'add: backups taken before writing');
  if (hasLevel) {
    const st = await groups.readStores({ dir: PROFILE, prefix: '' });
    const gb = st.ls.scopes[keyOf(B)];
    check(gb.groups.length === 2 && gb.assignments[skey(5)] === 'cg-b1' && gb.assignments[skey(1)] === 'cg-b1', 'add: groups filled in, existing assignments kept');
  }
  config.set({ accounts: { enabled: false } });
  const off = await sync.run({ apply: true, presence: 'absent' });
  check(!off.ok && off.error === 'SYNC_OFF', 'sync switched off: apply refused');
  config.set({ accounts: { enabled: true, scope: [keyA] } });
  check((await sync.status({ presence: 'absent' })).scopes.filter(s => s.included).length === 1, 'scope setting limits the sync to the chosen accounts');
  config.set({ accounts: { scope: 'all' } });

  console.log('-- mode (c) two-way on a fresh copy');
  await build();
  const tr = await sync.run({ apply: true, presence: 'absent', mode: 'two-way' });
  check(tr.ok && JSON.stringify(ids(A)) === JSON.stringify(ids(B)) && tasksOf(A).length === 3 && tasksOf(B).length === 3, 'two-way: both end with the union');
  check(rec(B, 1).model === 'model-b' && rec(A, 1).model === 'model-b', 'two-way: newer session state wins on both sides');

  console.log('-- add an account, then close/sync/reopen (stubs only)');
  writeScope(C, [], [], Date.now() - 86400000);
  const st3 = await sync.status({ presence: 'absent' });
  const keyC = keyOf(C), sc = st3.scopes.find(s => s.key === keyC);
  check(sc && sc.included && sc.records === 0, 'a newly signed-in, empty account shows up as a scope');
  const abHash = hashTree(dirOf(A)) + hashTree(dirOf(B));
  const exe = path.join(ROOT, 'fake-claude.exe'); fs.writeFileSync(exe, '');
  const calls = { quit: 0, force: 0, launch: [], sync: 0 };
  let state = 'live';
  const deps = {
    platform: 'win32',
    presence: async () => ({ state, procs: state === 'live' ? [{ pid: 4242, age: 999, main: true, kids: true }] : [] }),
    running: async () => [{ id: 'sess-1', title: 'Busy session', state: 'running' }],
    quit: async () => { calls.quit++; state = 'absent'; return 'app.quit'; },
    forceQuit: async () => { calls.force++; state = 'absent'; },
    launch: p => { calls.launch.push(p); return true; },
    exePath: async () => exe,
    sync: o => { calls.sync++; return sync.run({ ...o, presence: 'absent' }); },
    sleep: () => new Promise(r => setTimeout(r, 2)),
  };
  const runOpts = { mode: 'add', target: keyC };
  const ask = await cycle.closeSyncReopen({ runOpts }, deps);
  check(ask.needsConfirm && ask.running.length === 1 && calls.quit === 0 && calls.sync === 0, 'close: shows running sessions and waits for a confirm tap');
  const wrong = await cycle.closeSyncReopen({ runOpts, confirm: 'stale-token' }, deps);
  check(wrong.needsConfirm && calls.quit === 0, 'close: a stale confirmation is refused');
  const done = await cycle.closeSyncReopen({ runOpts, confirm: ask.confirm }, deps);
  check(done.ok && calls.quit === 1 && calls.force === 0 && calls.sync === 1 && calls.launch[0] === exe, 'close: graceful quit, sync, reopen', done.log.join(' | '));
  check(ids(C).length === 5 && hashTree(dirOf(A)) + hashTree(dirOf(B)) === abHash, 'new account received all sessions, the others untouched');

  state = 'live';
  const stuck = { ...deps, quit: async () => { calls.quit++; return 'app.quit'; } };
  const t1 = await cycle.closeSyncReopen({ runOpts, confirm: ask.confirm, timeoutMs: 30 }, stuck);
  check(!t1.ok && t1.needsForceConfirm && calls.force === 0, 'close: no force-kill without a second confirmation');
  const t2 = await cycle.closeSyncReopen({ runOpts, confirm: ask.confirm, force: true, forceConfirm: t1.forceConfirm }, stuck);
  check(t2.ok && calls.force === 1, 'close: force only after the second confirmation');
  const mac = await cycle.closeSyncReopen({}, { ...deps, platform: 'darwin' });
  check(mac.manual && mac.steps.length === 3, 'close: manual steps where it is not automated');

  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {}
  console.log(failed ? `\n${failed} check(s) failed` : '\nall account checks passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e.stack || e); try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {} process.exit(1); });
