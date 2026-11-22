// scope-no-stat.js — 09-Nov: the phone's poll reads the account scopes every pass; it must not stat each session record.
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-scope-'));
process.env.APPDATA = path.join(dir, 'appdata');
process.env.RELAYMOTE_HOME = path.join(dir, 'home');
const store = path.join(process.env.APPDATA, 'Claude', 'claude-code-sessions', 'acct-1', 'org-1');
fs.mkdirSync(store, { recursive: true }); fs.mkdirSync(process.env.RELAYMOTE_HOME, { recursive: true });
for (let i = 0; i < 500; i++) fs.writeFileSync(path.join(store, `local_${i}.json`), '{}');
fs.writeFileSync(path.join(store, 'notes.txt'), 'x');
fs.writeFileSync(path.join(process.env.APPDATA, 'Claude', 'config.json'), JSON.stringify({ lastKnownAccountUuid: 'acct-1' }));
let fails = 0;
const check = (ok, what, got) => { console.log((ok ? 'ok   ' : 'FAIL ') + what + (got !== undefined ? '  ' + JSON.stringify(got) : '')); if (!ok) fails++; };
const S = require('../lib/account-scope');
let stats = 0; const real = fs.statSync;
fs.statSync = function (p, ...a) { if (String(p).startsWith(store)) stats++; return real.call(fs, p, ...a); };
const sc = S.scopesOnDisk(), act = S.activeScope();
fs.statSync = real;
check(sc.length === 1 && sc[0].records === 500 && sc[0].ids.has('local_7'), 'scopes still count the records and their ids', sc[0] && sc[0].records);
check(act.state === 'known' && act.scope === 'acct-1/org-1' && act.records === 500, 'the active scope is still found', act.scope);
check(stats === 0, 'without a stat per record', stats);

// 22-Nov: the daemon's poll uses the async form, which must give the same answer with no synchronous readdir.
(async () => {
  let syncDirs = 0; const rd0 = fs.readdirSync;
  fs.readdirSync = function (p, ...a) { syncDirs++; return rd0.call(fs, p, ...a); };
  const [scA, actA] = await Promise.all([S.scopesOnDiskAsync(), S.activeScopeAsync()]);
  fs.readdirSync = rd0;
  check(scA.length === 1 && scA[0].records === 500 && scA[0].ids.has('local_7'), 'the async scopes match the sync ones', scA[0] && scA[0].records);
  check(actA.scope === act.scope && actA.records === act.records, 'and so does the async active scope', actA.scope);
  check(syncDirs === 0, 'with no synchronous readdir', syncDirs);
  const src = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'index.js'), 'utf8');
  check(!src.includes('accountScope.activeScope()') && src.split('await accountScope.activeScopeAsync()').length === 3, 'the daemon calls only the async form');
  process.exit(fails ? 1 : 0);
})();
