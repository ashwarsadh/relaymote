// accounts-fixture.js — throwaway fake Claude profiles for the accounts-* tests.
// Require it FIRST: it points APPDATA, LOCALAPPDATA, CLAUDE_CONFIG_DIR and BATON_HOME into a temp
// dir before any Relaymote module is loaded, so no test can reach the real Claude folders or ~/.baton.
// The Desktop presence probe is replaced by a stub (desk()): no test ever asks the real machine.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-acct-'));
const APPDATA = path.join(ROOT, 'appdata');
const LOCAL = path.join(ROOT, 'Local');
Object.assign(process.env, {
  APPDATA, LOCALAPPDATA: LOCAL, BATON_LOCALAPPDATA: LOCAL,
  CLAUDE_CONFIG_DIR: path.join(ROOT, 'claude'), BATON_HOME: path.join(ROOT, 'baton'),
});
delete process.env.BATON_STATE_DIR;

const PROFILE = path.join(APPDATA, 'Claude');
const SESS = path.join(PROFILE, 'claude-code-sessions');
const LEVELDB = path.join(PROFILE, 'Local Storage', 'leveldb');
const GW = process.platform === 'win32' ? path.join(LOCAL, 'Claude-3p') : path.join(APPDATA, 'Claude-3p');
const GW_SESS = path.join(GW, 'claude-code-sessions');
const GW_LEVELDB = path.join(GW, 'Local Storage', 'leveldb');
const BATON_ACCOUNTS = path.join(ROOT, 'baton', 'accounts');

const sid = n => 'local_' + String(n).padStart(8, '0') + '-0000-4000-8000-000000000000';
const skey = n => 'code:' + sid(n);

let failed = 0, passed = 0;
function check(ok, name, extra) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && extra ? '  ' + extra : ''}`);
  if (ok) passed++; else failed++;
}
function done(label) {
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {}
  console.log(failed ? `\n${failed} of ${passed + failed} ${label} check(s) failed` : `\nall ${passed} ${label} checks passed`);
  process.exit(failed ? 1 : 0);
}
function fail(e) { console.error(e && e.stack || e); try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {} process.exit(1); }

function scopeDir(acct, org, root = SESS) { const d = path.join(root, acct, org); fs.mkdirSync(d, { recursive: true }); return d; }
function writeRec(dir, id, obj, mtimeMs) {
  const f = path.join(dir, id + '.json');
  fs.writeFileSync(f, JSON.stringify(obj));
  if (mtimeMs) fs.utimesSync(f, new Date(mtimeMs), new Date(mtimeMs));
  return f;
}
const readRec = (dir, id) => JSON.parse(fs.readFileSync(path.join(dir, id + '.json'), 'utf8'));
const recIds = dir => fs.readdirSync(dir).filter(f => /^local_.*\.json$/.test(f)).sort();
function writeTasks(dir, tasks) { fs.writeFileSync(path.join(dir, 'scheduled-tasks.json'), JSON.stringify({ scheduledTasks: tasks, recordedSkips: {} }, null, 1)); }
const tasksOf = dir => JSON.parse(fs.readFileSync(path.join(dir, 'scheduled-tasks.json'), 'utf8')).scheduledTasks;
const mkTask = (id, enabled) => ({ id, cronExpression: '0 9 * * 1', enabled, createdAt: 1780000000000, filePath: '/tmp/tasks/' + id + '/SKILL.md', cwd: '/tmp/project' });

function Level() { try { return require('classic-level').ClassicLevel; } catch { return null; } }
const lsKeyFor = origin => Buffer.concat([Buffer.from('_' + origin), Buffer.from([0, 1]), Buffer.from('LSS-persisted.dframe-group-scopes')]);
async function putGroups(dir, entries) {
  const L = Level();
  fs.mkdirSync(dir, { recursive: true });
  const db = new L(dir, { keyEncoding: 'buffer', valueEncoding: 'buffer' });
  await db.open();
  for (const [origin, scopes] of entries) await db.put(lsKeyFor(origin), Buffer.concat([Buffer.from([1]), Buffer.from(JSON.stringify({ value: scopes, version: 1 }))]));
  await db.close();
}
async function getGroups(dir, origin = 'https://claude.ai') {
  const L = Level();
  const db = new L(dir, { keyEncoding: 'buffer', valueEncoding: 'buffer', createIfMissing: false });
  await db.open();
  try { const b = await db.get(lsKeyFor(origin)); return b ? JSON.parse(b.slice(1).toString('utf8')).value : null; }
  catch (e) { if (e.code === 'LEVEL_NOT_FOUND') return null; throw e; }
  finally { await db.close(); }
}
function writeMirror(profileDir, scopes) {
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(path.join(profileDir, 'claude_desktop_config.json'), JSON.stringify({ preferences: { epitaxyPrefs: { 'dframe-group-scopes': scopes } } }));
}
const readMirror = profileDir => JSON.parse(fs.readFileSync(path.join(profileDir, 'claude_desktop_config.json'), 'utf8')).preferences.epitaxyPrefs['dframe-group-scopes'];

function hashTree(dir, skip) {
  const h = crypto.createHash('sha256');
  const walk = d => {
    let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); } catch { return; }
    for (const e of ents) {
      const f = path.join(d, e.name);
      if (skip && skip(f)) continue;
      if (e.isDirectory()) walk(f); else { h.update(path.relative(dir, f)); h.update(fs.readFileSync(f)); }
    }
  };
  walk(dir);
  return h.digest('hex');
}
const lsNoise = f => /[\\/]leveldb[\\/](LOG|LOG\.old|LOCK)$/.test(f);

// The presence stub. desk('absent' | 'live' | ...) sets what the "real" probe answers.
let deskState = 'absent', probeCalls = 0;
function installProbe() {
  require('../lib/account-sync/presence').setProbe(async () => {
    probeCalls++;
    return { state: deskState, procs: deskState === 'live' ? [{ pid: 4242, age: 999, main: true, kids: true }] : [] };
  });
}
const desk = s => { deskState = s; };
const probes = () => probeCalls;

function reset(dirs) { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); try { require('../lib/account-sync/core').resetCache(); } catch {} }

module.exports = {
  ROOT, APPDATA, LOCAL, PROFILE, SESS, LEVELDB, GW, GW_SESS, GW_LEVELDB, BATON_ACCOUNTS,
  sid, skey, check, done, fail, scopeDir, writeRec, readRec, recIds, writeTasks, tasksOf, mkTask,
  Level, putGroups, getGroups, writeMirror, readMirror, hashTree, lsNoise, installProbe, desk, probes, reset,
};
