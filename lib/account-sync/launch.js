// launch.js — starting Claude Desktop, and (opt-in) letting Relaymote start it at logon.
//
// WHY: the account Desktop is signed in to, and the sidebar groups, can only be written while
// Desktop is closed. At logon Desktop's own autostart starts it within seconds, and a repair
// pass that starts at the same moment loses that race. With the launch hook on, Desktop's
// startup entry runs Relaymote instead:
//   1. if Desktop is confirmed absent, run the pending account pass (only what is needed),
//      capped at CAP_MS so Desktop is never held back for long;
//   2. wait for any other writer's lock to clear (bounded by the same cap);
//   3. start Desktop exactly as its entry did (same exe, same arguments), or, when that exe is
//      gone (a Store/MSIX install), through its AppsFolder id.
// Desktop ALWAYS starts, whatever the pass does. `baton accounts launch-hook remove` puts the
// original entry back (it is saved in autostart-original.json).
//
// Windows only. The Store version registers its own startup task instead of a Run entry; the
// hook then reports that it cannot take over, and the pass Relaymote runs when IT starts remains.
// This never closes Desktop.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const core = require('./core');
const pres = require('./presence');

const CAP_MS = 150 * 1000;
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_NAME = 'Claude';
const ORIG_FILE = path.join(core.DIR, 'autostart-original.json');
const VBS_FILE = path.join(core.DIR, 'launch-claude.vbs');
const BATON_JS = path.join(__dirname, '..', '..', 'bin', 'baton.js');

const isFile = p => { try { return fs.statSync(p).isFile(); } catch { return false; } };
function squirrelExe() {
  const local = core.LOCALAPPDATA;
  return [path.join(local, 'AnthropicClaude', 'claude.exe'), path.join(local, 'Programs', 'Claude', 'Claude.exe')].find(isFile) || null;
}

const run = (cmd, args, timeout = 20000) => new Promise(resolve =>
  execFile(cmd, args, { encoding: 'utf8', windowsHide: true, timeout }, (e, out) => resolve(e ? null : String(out || ''))));

// The Store build's AppsFolder id: <PackageFamilyName>!<AppId>.
const AUMID_PS = `
$pkg = Get-AppxPackage -Name 'Claude*' -ErrorAction SilentlyContinue | Where-Object { $_.Publisher -like '*Anthropic*' } | Select-Object -First 1
if (-not $pkg) { $pkg = Get-AppxPackage -Name 'Claude*' -ErrorAction SilentlyContinue | Select-Object -First 1 }
if ($pkg) {
  $appId = 'Claude'
  try { $mf = [xml](Get-Content -LiteralPath (Join-Path $pkg.InstallLocation 'AppxManifest.xml') -Raw); $a = @($mf.Package.Applications.Application)[0]; if ($a.Id) { $appId = $a.Id } } catch { }
  "$($pkg.PackageFamilyName)!$appId"
}`;
async function msixAumid() {
  if (process.platform !== 'win32') return null;
  const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', AUMID_PS]);
  const line = String(out || '').trim().split(/\r?\n/).pop() || '';
  return /^[\w.-]+_[a-z0-9]+![\w.-]+$/i.test(line) ? line : null;
}

function realDeps() {
  return {
    platform: process.platform,
    exists: isFile,
    spawnDetached: (cmd, args) => { const c = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false }); c.unref(); return true; },
    aumid: msixAumid,
    reg: args => new Promise((resolve, reject) => execFile('reg.exe', args, { encoding: 'utf8', windowsHide: true, timeout: 20000 },
      (e, out) => e ? reject(e) : resolve(String(out || '')))),
    sleep: ms => new Promise(r => setTimeout(r, ms)),
    now: () => Date.now(),
    lockHeld: () => core.lockHeld(),
  };
}

// Start Desktop: the recorded/known exe first, the Store (MSIX) AppsFolder id as the fallback.
async function startDesktop(opts = {}, injected = {}) {
  const d = { ...realDeps(), ...injected };
  const orig = core.readJson(ORIG_FILE, null) || {};
  const exe = opts.exe || orig.exe || squirrelExe();
  const args = opts.args || (opts.atLogon ? (orig.args || ['--startup']) : []);
  if (exe && d.exists(exe)) { d.spawnDetached(exe, args); return { ok: true, how: 'exe', exe, args }; }
  const id = await d.aumid();
  if (id) { d.spawnDetached('explorer.exe', ['shell:AppsFolder\\' + id]); return { ok: true, how: 'msix', aumid: id }; }
  return { ok: false, how: null, message: 'Claude Desktop was not found (no installed exe and no Store package)' };
}

// The logon launcher. opts.pass: async () => result of the repair pass (account-sync bootPass).
async function launchThroughBaton(opts = {}, injected = {}) {
  const d = { ...realDeps(), ...injected };
  const cap = opts.capMs || CAP_MS, t0 = d.now(), log = [];
  const left = () => cap - (d.now() - t0);
  const probe = injected.presence ? pres.resolver(injected.presence) : o => pres.presence(o);
  try {
    const p = await probe({ fresh: true });
    log.push('presence ' + p.state);
    if (pres.safeToWriteAll(p.state) && opts.pass) {
      let timer;
      const r = await Promise.race([
        Promise.resolve().then(opts.pass),
        new Promise(res => { timer = setTimeout(() => res({ capped: true }), Math.max(0, left())); }),
      ]);
      clearTimeout(timer);
      log.push(r && r.capped ? 'pass hit the ' + Math.round(cap / 1000) + 's cap - starting Desktop anyway' : 'pass done: ' + ((r && r.applied && r.applied.count) || 0) + ' change(s)');
    } else log.push('no pass: Desktop is ' + p.state);
  } catch (e) {
    log.push('pass failed: ' + e.message);
  } finally {
    let waited = 0;
    while (d.lockHeld() && left() > 0) { await d.sleep(500); waited += 500; }
    if (waited) log.push('waited ' + waited / 1000 + 's for another writer to release the lock');
    let started;
    try { started = await startDesktop({ atLogon: true }, d); } catch (e) { started = { ok: false, message: e.message }; }
    log.push(started.ok ? 'started Claude Desktop (' + started.how + ') at +' + Math.round((d.now() - t0) / 1000) + 's' : 'could not start Claude Desktop: ' + started.message);
    core.log('LAUNCH ' + log.join(' | '));
    return { ok: !!started.ok, log, started };
  }
}

// ---------------------------------------------------------------- the logon hook (opt-in)
function parseRunValue(v) {
  const s = String(v || '').trim();
  const m = /^"([^"]+)"\s*(.*)$/.exec(s) || /^(\S+)\s*(.*)$/.exec(s);
  if (!m) return { exe: null, args: [] };
  return { exe: m[1], args: m[2] ? m[2].split(/\s+/).filter(Boolean) : [] };
}
async function readRun(d) {
  try {
    const out = await d.reg(['query', RUN_KEY, '/v', RUN_NAME]);
    const m = new RegExp('^\\s*' + RUN_NAME + '\\s+REG_(?:EXPAND_)?SZ\\s+(.*)$', 'mi').exec(out);
    return m ? m[1].trim() : null;
  } catch { return null; }
}
const ourValue = () => 'wscript.exe "' + VBS_FILE + '"';
const isOurs = v => !!v && v.toLowerCase().includes(path.basename(VBS_FILE).toLowerCase());

async function hookStatus(injected = {}) {
  const d = { ...realDeps(), ...injected };
  if (d.platform !== 'win32') return { ok: true, supported: false, installed: false, message: 'Launching Claude through Relaymote is Windows only.' };
  const cur = await readRun(d);
  return { ok: true, supported: true, installed: isOurs(cur), entry: cur, original: core.readJson(ORIG_FILE, null) };
}

async function hookInstall(injected = {}) {
  const d = { ...realDeps(), ...injected };
  if (d.platform !== 'win32') return { ok: false, error: 'UNSUPPORTED', message: 'Launching Claude through Relaymote is Windows only.' };
  const cur = await readRun(d);
  if (isOurs(cur)) return { ok: true, already: true, message: 'Claude Desktop already starts through Relaymote.' };
  if (!cur) return { ok: false, error: 'NO_RUN_ENTRY', message: 'Claude Desktop has no startup entry to take over (the Store version uses its own startup task). Relaymote still runs the pass when Relaymote itself starts before Claude.' };
  const { exe, args } = parseRunValue(cur);
  core.ensureDir(core.DIR);
  core.writeJsonAtomic(ORIG_FILE, { name: RUN_NAME, key: RUN_KEY, value: cur, exe, args, savedAt: new Date().toISOString() });
  const env = process.env.BATON_HOME ? 'sh.Environment("PROCESS")("BATON_HOME") = "' + process.env.BATON_HOME.replace(/"/g, '""') + '"\r\n' : '';
  fs.writeFileSync(VBS_FILE, 'Set sh = CreateObject("WScript.Shell")\r\n' + env +
    'sh.Run """' + process.execPath.replace(/"/g, '""') + '"" ""' + BATON_JS.replace(/"/g, '""') + '"" accounts launch", 0, False\r\n');
  await d.reg(['add', RUN_KEY, '/v', RUN_NAME, '/t', 'REG_SZ', '/d', ourValue(), '/f']);
  const back = await readRun(d);
  if (!isOurs(back)) return { ok: false, error: 'NOT_WRITTEN', message: 'The startup entry could not be changed; nothing else was done.' };
  core.log('LAUNCH-HOOK installed (original: ' + cur + ')');
  return { ok: true, installed: true, original: cur, undo: 'baton accounts launch-hook remove' };
}

async function hookRemove(injected = {}) {
  const d = { ...realDeps(), ...injected };
  if (d.platform !== 'win32') return { ok: true, installed: false };
  const cur = await readRun(d), orig = core.readJson(ORIG_FILE, null);
  if (!isOurs(cur)) return { ok: true, installed: false, message: 'Claude Desktop does not start through Relaymote; nothing changed.' };
  if (orig && orig.value) await d.reg(['add', RUN_KEY, '/v', RUN_NAME, '/t', 'REG_SZ', '/d', orig.value, '/f']);
  else await d.reg(['delete', RUN_KEY, '/v', RUN_NAME, '/f']);
  const back = await readRun(d);
  if (isOurs(back)) return { ok: false, error: 'NOT_RESTORED', message: 'The startup entry could not be put back.' };
  fs.rmSync(ORIG_FILE, { force: true }); fs.rmSync(VBS_FILE, { force: true });
  core.log('LAUNCH-HOOK removed (restored: ' + (orig && orig.value) + ')');
  return { ok: true, installed: false, restored: orig ? orig.value : null };
}

module.exports = { startDesktop, launchThroughBaton, msixAumid, squirrelExe, hookStatus, hookInstall, hookRemove, parseRunValue,
                   CAP_MS, RUN_KEY, RUN_NAME, ORIG_FILE, VBS_FILE };
