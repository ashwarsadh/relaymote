// scope-count.js — 18-Nov-2026: lib/account-sync/core.js listScopes() re-listed every scope folder (thousands of
// local_*.json per account) only to count them. On the daemon's main thread it was the top loop-stall frame on 0.2.198
// (13.4 s in 3 stalls, leaf readdir; transferTick calls it every 5 min). Counts are now kept until the folder's mtime
// moves. Same scopes and counts; a repeat call lists no scope folder; an added or removed record is counted at once.
'use strict';
const fx = require('./accounts-fixture');
const fs = require('fs');
const path = require('path');
const { check } = fx;

(async () => {
  const core = require('../lib/account-sync/core');
  const A = fx.scopeDir('aaaaaaaa-0000-4000-8000-000000000001', '0a0a0a0a-0000-4000-8000-000000000001');
  const B = fx.scopeDir('bbbbbbbb-0000-4000-8000-000000000002', '0b0b0b0b-0000-4000-8000-000000000002');
  for (let i = 0; i < 2000; i++) fs.writeFileSync(path.join(A, fx.sid(i) + '.json'), '{}');
  for (let i = 0; i < 300; i++) fs.writeFileSync(path.join(B, fx.sid(5000 + i) + '.json'), '{}');
  fs.writeFileSync(path.join(A, 'scheduled-tasks.json'), '{"scheduledTasks":[]}');
  const count = () => Object.fromEntries(core.listScopes().map(s => [s.dir, s.recordCount]));

  const lists = [];
  const orig = fs.readdirSync;
  fs.readdirSync = function (p, ...rest) { lists.push(String(p)); return orig.call(this, p, ...rest); };
  let first, second;
  try { first = count(); lists.length = 0; second = count(); }
  finally { fs.readdirSync = orig; }
  check(first[A] === 2000 && first[B] === 300, 'every scope is found with its record count', JSON.stringify(first));
  check(JSON.stringify(first) === JSON.stringify(second), 'a repeat call gives the same scopes and counts');
  const scoped = lists.filter(p => p === A || p === B);
  check(scoped.length === 0, 'a repeat call lists no scope folder (its count is kept until the folder changes)', JSON.stringify(scoped));

  // Windows and some filesystems keep mtime to a coarse tick: move it explicitly, as a real add or delete does.
  const bump = (d, s) => { const t = new Date(Date.now() + s * 1000); fs.utimesSync(d, t, t); };
  fs.writeFileSync(path.join(A, fx.sid(9999) + '.json'), '{}'); bump(A, 5);
  check(count()[A] === 2001, 'an added record is counted at once');
  fs.rmSync(path.join(B, fx.sid(5000) + '.json')); bump(B, 10);
  check(count()[B] === 299, 'a removed record is counted at once');
  fx.done('scope-count');
})().catch(fx.fail);
