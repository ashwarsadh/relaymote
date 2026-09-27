// accounts-groups.js — sidebar groups, on throwaway copies of both stores:
//   * folding groups across accounts is OFF by default (healing each account's own stores is on);
//   * groups.apply refuses BY ITSELF unless a fresh probe confirms Desktop is absent;
//   * `forget` accepts a deliberate deletion, so it is never restored or folded back;
//   * restore/undo backs up the current state first (an undo is undoable), restore-by-stamp,
//     and every scope's archive index is rebuilt after an undo;
//   * Gateway mode (3p): origin discovered, scope named, seeded once, mirror created, own snapshots;
//   * the relaunch check: counts both stores after Desktop has been back for 180 s, records a
//     verdict, and reports a write that was clobbered.
'use strict';
const fx = require('./accounts-fixture');
const fs = require('fs');
const path = require('path');
const { check } = fx;

(async () => {
  if (!fx.Level()) { console.log('skip: classic-level is not installed, groups are report-only'); fx.done('groups'); }
  fx.installProbe();
  const sync = require('../lib/account-sync');
  const groups = require('../lib/account-sync/groups');
  const verify = require('../lib/account-sync/verify');
  const core = require('../lib/account-sync/core');
  const AK = { acct: '11111111-1111-4111-8111-111111111111', org: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
  const BK = { acct: '22222222-2222-4222-8222-222222222222', org: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };
  const keyA = AK.acct + '/' + AK.org, keyB = BK.acct + '/' + BK.org;
  const ORIGIN = 'https://claude.ai', O3 = 'app://localhost';
  const GROUPS = () => ({
    [keyA]: { groups: [{ id: 'g-a1', name: 'Work' }], assignments: { [fx.skey(1)]: 'g-a1' }, order: { 'g-a1': [fx.skey(1)] } },
    [keyB]: { groups: [{ id: 'g-b1', name: 'Work' }, { id: 'g-b2', name: 'Only in B' }], assignments: { [fx.skey(2)]: 'g-b2' }, order: { 'g-b2': [fx.skey(2)] } },
  });
  async function build() {
    fx.reset([fx.PROFILE, fx.GW, fx.RELAYMOTE_ACCOUNTS]);
    const now = Date.now();
    for (const [k, n, t] of [[AK, 1, now - 60000], [BK, 2, now - 3600000]]) {
      const d = fx.scopeDir(k.acct, k.org);
      fx.writeRec(d, fx.sid(n), { sessionId: fx.sid(n), isArchived: false, title: 's' + n }, t);
      fx.writeTasks(d, []);
    }
    fx.writeMirror(fx.PROFILE, GROUPS());
    await fx.putGroups(fx.LEVELDB, [[ORIGIN, GROUPS()]]);
  }
  const run = (extra = {}) => { fx.desk('absent'); return sync.run({ apply: true, presence: 'absent', kinds: ['groups'], ...extra }); };
  const all = r => r.lines.concat((r.applied && r.applied.lines) || []).join('\n');
  const names = s => (s.groups || []).map(g => g.name).sort().join(',');

  console.log('-- folding across accounts is opt-in');
  await build();
  let out = await run();
  let ls = await fx.getGroups(fx.LEVELDB);
  check(names(ls[keyA]) === 'Work' && names(ls[keyB]) === 'Only in B,Work', 'default: no group from another account is added', names(ls[keyA]));
  check(/1 group\(s\) and 1 placement\(s\) exist only in other accounts - not added, because folding sidebar groups across accounts is off/.test(all(out)), 'the preview says what folding would add', all(out));
  check(out.groups.fold === false && out.options.foldGroups === false, 'the run reports folding off');
  // healing is still on: a group only the mirror remembers comes back into localStorage
  const mir = fx.readMirror(fx.PROFILE); mir[keyA].groups.push({ id: 'g-a2', name: 'Healed' }); fx.writeMirror(fx.PROFILE, mir);
  await run();
  ls = await fx.getGroups(fx.LEVELDB);
  check(names(ls[keyA]) === 'Healed,Work', 'healing (localStorage > mirror > snapshot) still runs with folding off', names(ls[keyA]));
  out = await run({ foldGroups: true });
  ls = await fx.getGroups(fx.LEVELDB);
  check(names(ls[keyA]) === 'Healed,Only in B,Work' && ls[keyA].assignments[fx.skey(2)] === 'g-b2', 'foldGroups on: the other account\'s group and placement are folded in', names(ls[keyA]));

  console.log('-- groups.apply refuses by itself');
  await build();
  const before = fx.hashTree(fx.PROFILE, fx.lsNoise);
  const act = { kind: 'groups', op: 'groups', to: keyA, groupKey: keyA, value: { groups: [{ id: 'x', name: 'X' }], assignments: {}, order: {} } };
  for (const st of ['live', 'launching', 'unknown']) {
    let err = null;
    try { await groups.apply(core.loadState(), [act], [], { presence: async () => st }); } catch (e) { err = e.message; }
    check(err && new RegExp('Claude Desktop is ' + st).test(err) && fx.hashTree(fx.PROFILE, fx.lsNoise) === before, 'probe says ' + st + ': refused, both stores untouched', err);
  }
  fx.desk('live');
  let err2 = null;
  try { await groups.apply(core.loadState(), [act], [], { presence: 'absent' }); } catch (e) { err2 = e.message; }
  check(err2 && fx.hashTree(fx.PROFILE, fx.lsNoise) === before, 'a handed-down "absent" is ignored: the real probe says live, refused', err2);
  fx.desk('absent');

  console.log('-- forget a deliberate deletion');
  await build();
  const m2 = fx.readMirror(fx.PROFILE); m2[keyA].groups.push({ id: 'g-gone', name: 'Deleted on purpose' }); fx.writeMirror(fx.PROFILE, m2);
  const f = sync.forgetGroup(keyA, 'g-gone');
  check(f.ok && f.forgotten.includes('g-gone'), 'forget records the group');
  await run();
  ls = await fx.getGroups(fx.LEVELDB);
  check(!ls[keyA].groups.some(g => g.id === 'g-gone') && !fx.readMirror(fx.PROFILE)[keyA].groups.some(g => g.id === 'g-gone'), 'a forgotten group is not restored by the heal, and leaves the mirror too');
  const m3 = fx.readMirror(fx.PROFILE); m3[keyB].groups.push({ id: 'g-b9', name: 'Deleted on purpose' }); fx.writeMirror(fx.PROFILE, m3);
  await run({ foldGroups: true });
  ls = await fx.getGroups(fx.LEVELDB);
  check(!ls[keyA].groups.some(g => /deleted on purpose/i.test(g.name)), 'nor brought back by a fold from another account (same name)', names(ls[keyA]));

  console.log('-- restore / undo');
  await build();
  const h0 = fx.hashTree(fx.PROFILE, fx.lsNoise);
  const w = await run({ foldGroups: true });
  const h1 = fx.hashTree(fx.PROFILE, fx.lsNoise);
  check(h1 !== h0 && sync.groupBackups().length === 1 && sync.groupBackups()[0].reason === 'before-sync', 'a write keeps one backup of both stores', JSON.stringify(sync.groupBackups()));
  fx.desk('live');
  check(!(await sync.restoreGroups('latest')).ok && fx.hashTree(fx.PROFILE, fx.lsNoise) === h1, 'restore refuses while Desktop runs');
  fx.desk('absent');
  const r1 = await sync.restoreGroups('latest');
  check(r1.ok && fx.hashTree(fx.PROFILE, fx.lsNoise) === h0, 'restore puts both stores back as they were before the write', JSON.stringify(r1));
  const bl = sync.groupBackups();
  check(bl.length === 2 && bl[1].reason === 'before-restore', 'the state being replaced was backed up first');
  const r2 = await sync.restoreGroups(bl[1].stamp);
  check(r2.ok && fx.hashTree(fx.PROFILE, fx.lsNoise) === h1, 'restore by stamp: the undo is itself undoable');
  // journal undo rebuilds every scope's archive index
  const dB = path.join(fx.SESS, BK.acct, BK.org);
  fs.writeFileSync(path.join(dB, 'archived-sessions.idx'), JSON.stringify({ v: 1, archived: ['local_stale-entry'] }));
  const u = await sync.undo(w.applied.journal, { presence: async () => 'absent' });
  check(u.ok && fx.hashTree(fx.PROFILE, fx.lsNoise, ) !== h1, 'journal undo restores the group stores', JSON.stringify(u.lines));
  check(JSON.parse(fs.readFileSync(path.join(dB, 'archived-sessions.idx'), 'utf8')).archived.length === 0, 'after an undo every scope\'s archive index is rebuilt (even one the journal did not touch)');

  console.log('-- Gateway mode (3p) groups');
  await build();
  out = await sync.status({ presence: 'absent' });
  check(out.groups.gateway && out.groups.gateway.status === 'absent' && !fs.existsSync(fx.GW), 'no Gateway folder: nothing to do, nothing created');
  await fx.putGroups(fx.GW_LEVELDB, []);
  out = await run();
  check(out.groups.gateway.status === 'waiting' && /Gateway mode has not stored any groups yet/.test(all(out)), 'key absent: waiting, the origin is not guessed', all(out));
  fs.rmSync(fx.GW, { recursive: true, force: true });
  await fx.putGroups(fx.GW_LEVELDB, [[O3, {}], [ORIGIN, {}]]);
  out = await run();
  check(/more than one origin holds the group key/.test(all(out)), 'two origins: waiting');
  fs.rmSync(fx.GW, { recursive: true, force: true });
  await fx.putGroups(fx.GW_LEVELDB, [[O3, {}]]);
  out = await run();
  check(/cannot name the Gateway scope/.test(all(out)), 'one origin, no scope anywhere: waiting');
  const G = { acct: 'dddddddd-0000-4000-8000-00000000dead', org: '00000000-0000-4000-8000-000000000000' }, key3 = G.acct + '/' + G.org;
  fx.scopeDir(G.acct, G.org, fx.GW_SESS);
  const gwBefore = fx.hashTree(fx.GW, fx.lsNoise);
  out = await sync.status({ presence: 'absent' });
  check(out.groups.gateway.origin === O3 && out.groups.gateway.scope === key3 && /seeded once from/.test(all(out)), 'one Gateway scope: origin discovered, scope named, a one-time seed from the signed-in account planned', all(out));
  check(fx.hashTree(fx.GW, fx.lsNoise) === gwBefore && !fs.existsSync(path.join(fx.GW, 'claude_desktop_config.json')) && !fs.existsSync(path.join(fx.RELAYMOTE_ACCOUNTS, 'group-snapshots-3p')), 'the dry run wrote nothing');
  out = await run();
  const g3 = await fx.getGroups(fx.GW_LEVELDB, O3);
  check(g3 && g3[key3] && names(g3[key3]) === 'Work' && /\(verified in both stores\)/.test(all(out)), 'apply: the Gateway leveldb holds the seed from the account used last, verified', all(out));
  const mirror3 = fx.readMirror(fx.GW);
  check(mirror3[key3] && mirror3[key3].groups.length === 1, 'the Gateway config mirror was created');
  check(sync.groupBackups().some(b => b.store === '3p') && fs.existsSync(path.join(fx.RELAYMOTE_ACCOUNTS, 'group-snapshots-3p')), 'its own backup and its own snapshots');
  check(JSON.stringify(await groups.discoverOrigins(fx.GW_LEVELDB)) === JSON.stringify([O3]), 'no other origin was written');
  const lsA = (await fx.getGroups(fx.LEVELDB))[keyA];
  check(names(lsA) === 'Work', 'the subscription store was not changed by the Gateway pass');
  out = await run();
  check(!out.lines.some(l => /seeded once/.test(l)) && !(out.applied.lines.some(l => /Gateway/.test(l))), 'a second pass: nothing to do, no re-seed', all(out));
  await fx.putGroups(fx.GW_LEVELDB, [[O3, { [key3]: { groups: [], assignments: {}, order: {} } }]]);
  fs.rmSync(path.join(fx.RELAYMOTE_ACCOUNTS, 'group-snapshots-3p'), { recursive: true, force: true });
  fx.writeMirror(fx.GW, { [key3]: { groups: [], assignments: {}, order: {} } });
  out = await run();
  check(names((await fx.getGroups(fx.GW_LEVELDB, O3))[key3]) === '', 'emptied after the seed: seeded only once, never again', all(out));
  await fx.putGroups(fx.GW_LEVELDB, [[O3, { [key3]: { groups: [{ id: 'g-mine', name: 'Mine' }], assignments: {}, order: {} } }]]);
  out = await sync.status({ presence: 'absent' });
  check(!/seeded once/.test(all(out)), 'a Gateway scope with groups of its own is healed on its own, never seeded');

  console.log('-- the relaunch check');
  await build();
  const t0 = Date.now();
  await run({ foldGroups: true });
  check(!!verify.pending(), 'a group write arms the relaunch check');
  let v = await verify.tick({ now: () => t0 + 1000, presence: async () => 'absent' });
  check(v.phase === 'waiting', 'while Desktop is closed it waits');
  v = await verify.tick({ now: () => t0 + 2000, presence: async () => 'live' });
  check(v.phase === 'settling', 'Desktop back: it lets the web app settle');
  v = await verify.tick({ now: () => t0 + 2000 + 179000, presence: async () => 'live' });
  check(v.phase === 'settling', 'not counted before 180 s');
  v = await verify.tick({ now: () => t0 + 2000 + 181000, presence: async () => 'live' });
  check(v.phase === 'AFTER RELAUNCH' && v.ok === true && !verify.pending(), 'after 180 s both stores are counted: the write survived', JSON.stringify(v.entries));
  await run({ foldGroups: true });   // nothing to write: no new check
  const lsNow = await fx.getGroups(fx.LEVELDB);
  const bigger = JSON.parse(JSON.stringify(lsNow)); bigger[keyA].groups.push({ id: 'g-new', name: 'New' });
  fx.writeMirror(fx.PROFILE, bigger);
  await run();
  check(!!verify.pending(), 'a new write arms a new check');
  await fx.putGroups(fx.LEVELDB, [[ORIGIN, GROUPS()]]);   // Desktop starts and pushes a stale copy over it
  await verify.tick({ now: () => t0 + 10000, presence: async () => 'live' });
  v = await verify.tick({ now: () => t0 + 10000 + 181000, presence: async () => 'live' });
  check(v.ok === false && v.entries.some(e => !e.ok && e.got.localStorage.groups < e.want.groups), 'a write clobbered after the relaunch is reported as FAILED', JSON.stringify(v.entries));
  const st = await sync.status({ presence: 'absent' });
  check(st.verdict && st.verdict.ok === false, 'the failed verdict is surfaced to the app');

  fx.done('groups');
})().catch(fx.fail);
