// updater.js — keep an installed Relaymote current from GitHub Releases (module `autoUpdate`).
//
// Every `update.checkHours` the daemon asks GitHub for the latest release. A newer one is fetched and
// verified before anything runs:
//   1. SHA256SUMS.txt.sig must be a valid Ed25519 signature over SHA256SUMS.txt by the key below. The
//      release workflow signs with the matching private key (the RELAYMOTE_SIGNING_KEY secret). A release
//      without a valid signature is refused, so a file swapped on the release page is never installed.
//   2. The downloaded installer's SHA-256 must equal its line in that signed file.
// Only then, and only when no Relaymote task is running, does the daemon hand over to a separate script
// that runs the new installer silently over this install (the installer stops Relaymote first, see
// installer/windows/stop-relaymote.ps1) and starts Relaymote again. Your data folder is never touched.
//
// What updates itself: the Windows install made by Relaymote-Setup-*.exe. A source checkout, the portable
// zip and macOS only REPORT a newer release (`relaymote update`, the log, state/update.json).
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const config = require('./config');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(config.DATA, 'updates');
const STATE_FILE = path.join(config.STATE, 'update.json');
const DEFAULTS = { checkHours: 6, repo: 'ashwarsadh/relaymote' };

// The release-signing public key (Ed25519, SPKI). Replacing it takes a release signed by the old key.
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEANTCFhVif3Jkd0W5qGrElCZEf48A0srGoBYZmkwfzFDc=
-----END PUBLIC KEY-----
`;

const log = m => { try { require('./orchestrator').log('[update] ' + m); } catch { console.log('[update] ' + m); } };
const settings = () => ({ ...DEFAULTS, ...((config.get() || {}).update || {}) });
const current = () => require('../package.json').version;

function state() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } }
function saveState(s) { try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch {} return s; }

/** a > b → 1, a < b → -1, equal → 0. "1.2.3-rc.1" sorts below "1.2.3". */
function cmpVersion(a, b) {
  const parse = v => { const [core, pre] = String(v).replace(/^v/, '').split('-'); return { n: core.split('.').map(x => Number(x) || 0), pre: pre || null }; };
  const A = parse(a), B = parse(b);
  for (let i = 0; i < 3; i++) if ((A.n[i] || 0) !== (B.n[i] || 0)) return (A.n[i] || 0) > (B.n[i] || 0) ? 1 : -1;
  if (A.pre === B.pre) return 0;
  if (!A.pre) return 1;
  if (!B.pre) return -1;
  return A.pre > B.pre ? 1 : -1;
}

/** How this copy was installed, which decides whether it may replace itself. */
function installKind(root = ROOT, platform = process.platform) {
  if (fs.existsSync(path.join(root, '.git'))) return 'source';
  if (platform === 'win32' && fs.existsSync(path.join(root, 'unins000.exe'))) return 'windows-installer';
  if (platform === 'darwin' && /\.app[\\/]Contents[\\/]/.test(root)) return 'macos-app';
  return 'portable';
}
const assetName = (kind, version) => kind === 'windows-installer' ? `Relaymote-Setup-${version}-x64.exe` : null;

/** True when `sig` (base64) is the release key's signature over `text`. */
function verifySums(text, sig, key = PUBLIC_KEY) {
  try { return crypto.verify(null, Buffer.from(text), key, Buffer.from(String(sig).trim(), 'base64')); } catch { return false; }
}
/** The SHA-256 a signed SHA256SUMS.txt lists for `name`, or null. */
function listedHash(text, name) {
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/i.exec(line);
    if (m && m[2] === name) return m[1].toLowerCase();
  }
  return null;
}

function request(url, { file, maxBytes = 2e6, redirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'baton-updater/' + current(), Accept: file ? 'application/octet-stream' : 'application/vnd.github+json' }, timeout: 60000 }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(request(new URL(res.headers.location, url).toString(), { file, maxBytes, redirects: redirects - 1 }));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} for ${url}`)); }
      if (file) {
        const hash = crypto.createHash('sha256');
        const out = fs.createWriteStream(file);
        res.on('data', d => hash.update(d));
        res.pipe(out);
        out.on('finish', () => resolve({ sha256: hash.digest('hex') }));
        out.on('error', reject);
        res.on('error', reject);
        return;
      }
      let body = '', n = 0;
      res.setEncoding('utf8');
      res.on('data', d => { n += d.length; if (n > maxBytes) { req.destroy(new Error('response too large')); return; } body += d; });
      res.on('end', () => resolve(body));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
  });
}

/** Ask GitHub for the latest release. Never throws; returns { ok, current, latest, newer, ... }. */
async function check() {
  const s = settings();
  const kind = installKind();
  const out = { ok: false, at: new Date().toISOString(), current: current(), kind, latest: null, newer: false };
  try {
    const rel = JSON.parse(await request(`https://api.github.com/repos/${s.repo}/releases/latest`));
    const latest = String(rel.tag_name || '').replace(/^v/, '');
    if (!latest) throw new Error('the latest release has no tag');
    const assets = Object.fromEntries((rel.assets || []).map(a => [a.name, a.browser_download_url]));
    Object.assign(out, { ok: true, latest, newer: cmpVersion(latest, out.current) > 0, page: rel.html_url, assets });
  } catch (e) { out.error = e.message; }
  return out;
}

/** Download the installer for `c` (a check() result) and verify it. Returns { ok, file } or { ok:false, error }.
 *  `key` exists for the tests; the daemon always uses the embedded release key. */
async function fetchVerified(c, { key = PUBLIC_KEY } = {}) {
  const a = c.assets || {};
  const primary = assetName(c.kind, c.latest);
  if (!primary) return { ok: false, error: `a ${c.kind} copy does not update itself` };
  const name = primary;
  if (!a[name]) return { ok: false, error: `the release has no ${name}` };
  if (!a['SHA256SUMS.txt'] || !a['SHA256SUMS.txt.sig']) return { ok: false, error: 'the release is not signed (no SHA256SUMS.txt.sig): refused' };
  const sums = await request(a['SHA256SUMS.txt']);
  const sig = await request(a['SHA256SUMS.txt.sig']);
  if (!verifySums(sums, sig, key)) return { ok: false, error: 'SHA256SUMS.txt signature does not verify with the release key: refused' };
  const want = listedHash(sums, name);
  if (!want) return { ok: false, error: `${name} is not listed in the signed SHA256SUMS.txt: refused` };
  fs.mkdirSync(DIR, { recursive: true });
  const file = path.join(DIR, name);
  const part = file + '.part';
  const got = await request(a[name], { file: part });
  if (got.sha256 !== want) { try { fs.unlinkSync(part); } catch {} return { ok: false, error: `${name} SHA-256 ${got.sha256.slice(0, 12)}… does not match the signed ${want.slice(0, 12)}…: refused` }; }
  fs.renameSync(part, file);
  return { ok: true, file, sha256: want };
}

/** Why an update must wait right now, or null. */
function busyReason() {
  try {
    const n = require('./registry').byStatus('running').length;
    if (n) return `${n} Relaymote task(s) running`;
  } catch {}
  return null;
}

/** Hand over to a detached script: silent install over ROOT, then start Relaymote (and its tray, if it ran). */
function apply(file, version, { dry = false } = {}) {
  const node = path.join(ROOT, 'runtime', 'node.exe');
  const cli = path.join(ROOT, 'bin', 'relaymote.js');
  const setupLog = path.join(DIR, `setup-${version}.log`);
  const cmd = path.join(DIR, 'apply-update.cmd');
  const trayWasOn = !!(state().trayRunning);
  const lines = [
    '@echo off',
    `rem Written by Relaymote ${current()} to install ${version}. Safe to delete.`,
    'ping -n 4 127.0.0.1 >nul',
    `"${file}" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /DIR="${ROOT}" /LOG="${setupLog}"`,
    `echo installer exit %ERRORLEVEL% >> "${path.join(DIR, 'apply.log')}"`,
    `"${node}" "${cli}" start >> "${path.join(DIR, 'apply.log')}" 2>&1`,
    trayWasOn ? `"${node}" "${cli}" tray >> "${path.join(DIR, 'apply.log')}" 2>&1` : 'rem tray was not running',
  ];
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(cmd, lines.join('\r\n') + '\r\n');
  if (dry) return { ok: true, dry: true, script: cmd };
  return launch(cmd);
}

// The script must not be a child of this daemon: a daemon started by a scheduled task (or a terminal)
// lives in a job object that can take its children down when it ends, and the installer ends it. So
// someone else starts it, tried in this order:
//   wmi       Win32_Process.Create. Refused (ReturnValue 2) for a standard user on some Windows Server
//             builds: measured on the first real self-update, 0.2.9 -> 0.2.10.
//   task      a one-shot scheduled task, "Relaymote Update", run at once in this signed-in session. The
//             new daemon deletes it when it starts (landed()).
//   detached  last resort: a detached child of this daemon.
// run-hidden.vbs keeps the console window away.
const UPDATE_TASK = 'Relaymote Update';
function launchPlan(cmd) {
  const vbs = path.join(ROOT, 'scripts', 'run-hidden.vbs');
  const line = `wscript.exe "${vbs}" cmd.exe /d /c "${cmd}"`;
  const q = v => v.replace(/'/g, "''");
  return [
    { via: 'wmi', exe: 'powershell.exe', args: [['-NoProfile', '-NonInteractive', '-Command',
      `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${q(line)}'; CurrentDirectory = '${q(DIR)}' }; "$($r.ReturnValue) $($r.ProcessId)"`]],
      ok: r => String((r && r.stdout) || '').trim().split(/\s+/)[0] === '0' },
    // schtasks takes at most 261 characters of /TR; a longer line goes to the next route.
    { via: 'task', exe: 'schtasks.exe', args: line.length > 261 ? null : [
      ['/Create', '/TN', UPDATE_TASK, '/TR', line, '/SC', 'ONCE', '/ST', '00:00', '/IT', '/F'],
      ['/Run', '/TN', UPDATE_TASK]],
      ok: r => !!r && r.status === 0 },
  ];
}
const runSync = (exe, args) => require('child_process').spawnSync(exe, args, { encoding: 'utf8', windowsHide: true, timeout: 60000 });
function launch(cmd, { run = runSync, detached = null } = {}) {
  const tried = [];
  for (const step of launchPlan(cmd)) {
    if (!step.args) { tried.push(step.via + ': command line too long'); continue; }
    let r = null;
    for (const a of step.args) { r = run(step.exe, a); if (!step.ok(r)) break; }
    if (step.ok(r)) return { ok: true, script: cmd, via: step.via, tried };
    tried.push(step.via + ': ' + String((r && (r.stdout || r.stderr || r.error)) || 'no answer').trim().slice(0, 160));
  }
  log('launch routes refused (' + tried.join('; ') + '); falling back to a detached child');
  const pid = detached ? detached(cmd) : require('./launch').spawnHidden(process.env.ComSpec || 'cmd.exe', ['/d', '/c', cmd], { cwd: DIR }).pid;
  return { ok: true, script: cmd, pid, via: 'detached', tried };
}

function startTray() {
  const ps = path.join(ROOT, 'scripts', 'tray.ps1');
  require('./launch').spawnHidden('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', ps]);
}

/**
 * First thing after a restart into the version we installed: record that it landed, remove the
 * one-shot task, and bring the tray back if it was running. The installer stops the tray together with
 * the daemon and nothing else restarts it (the 10-minute watchdog restarts only the daemon): measured
 * on 0.2.9 -> 0.2.10, where the tray stayed gone. Called at daemon start and by every tick.
 */
function landed({ isTrayRunning = trayRunning, openTray = startTray, run = runSync } = {}) {
  const st = state();
  if (!st.installing || cmpVersion(current(), st.installing.to) < 0) return null;
  log(`updated ${st.installing.from} -> ${current()}`);
  st.lastInstalled = { ...st.installing, landedAt: new Date().toISOString() };
  delete st.installing;
  if (process.platform === 'win32') { try { run('schtasks.exe', ['/Delete', '/TN', UPDATE_TASK, '/F']); } catch {} }
  if (st.trayRunning && !isTrayRunning()) {
    try { openTray(); st.lastInstalled.trayRestarted = true; log('tray restarted (it was running before the update)'); }
    catch (e) { log('tray restart failed: ' + e.message); }
  }
  saveState(st);
  return st.lastInstalled;
}

/** Is Relaymote's tray running from this folder? Asked once, just before an update, so it can come back. */
function trayRunning() {
  if (process.platform !== 'win32') return false;
  try {
    const tray = path.join(ROOT, 'scripts', 'tray.ps1').toLowerCase().replace(/'/g, "''");
    const r = require('child_process').spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `@(Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains('${tray}') }).Count`],
    { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    return Number(String(r.stdout).trim()) > 0;
  } catch { return false; }
}

/**
 * One pass. Called by the daemon every few minutes; it only goes to GitHub once per checkHours unless
 * `force`. Returns what it did; the same record is kept in state/update.json.
 */
async function tick({ force = false, applyNow = true } = {}) {
  const s = settings();
  landed();
  const st = state();
  const due = force || !st.lastCheck || (Date.now() - Date.parse(st.lastCheck)) >= s.checkHours * 3600000;
  if (!due) return { ok: true, skipped: 'not due', next: new Date(Date.parse(st.lastCheck) + s.checkHours * 3600000).toISOString() };
  const c = await check();
  st.lastCheck = c.at;
  st.check = { ok: c.ok, current: c.current, latest: c.latest, newer: c.newer, kind: c.kind, error: c.error || null, page: c.page || null };
  if (!c.ok || !c.newer) { saveState(st); return { ...st.check }; }
  if (c.kind !== 'windows-installer' || !applyNow) {
    if (st.announced !== c.latest) { log(`Relaymote ${c.latest} is available (${c.page}); this ${c.kind} copy does not update itself`); st.announced = c.latest; }
    saveState(st);
    return { ...st.check, action: 'reported' };
  }
  const busy = busyReason();
  if (busy) { st.check.waiting = busy; saveState(st); log(`${c.latest} is ready to install; waiting: ${busy}`); return { ...st.check, action: 'waiting', why: busy }; }
  let f;
  try { f = await fetchVerified(c); } catch (e) { f = { ok: false, error: e.message }; }
  if (!f.ok) { st.check.error = f.error; saveState(st); log(`${c.latest} not installed: ${f.error}`); return { ...st.check, action: 'refused', error: f.error }; }
  st.trayRunning = trayRunning();
  st.installing = { from: c.current, to: c.latest, at: new Date().toISOString(), sha256: f.sha256 };
  saveState(st);
  log(`${c.latest} downloaded and verified (sha256 ${f.sha256.slice(0, 16)}…, signature ok); installing and restarting`);
  const r = apply(f.file, c.latest);
  return { ...st.check, action: 'installing', script: r.script, via: r.via };
}

async function cli(args) {
  const say = o => console.log(typeof o === 'string' ? o : JSON.stringify(o, null, 2));
  if (args.includes('--status')) return say(state());
  if (args.includes('--apply')) return say(await tick({ force: true, applyNow: true }));
  const c = await check();
  if (!c.ok) return say('Could not check for updates: ' + c.error);
  say(c.newer
    ? `Relaymote ${c.latest} is available (you have ${c.current}). ${c.kind === 'windows-installer' ? 'It installs itself when the daemon next checks, or now with `relaymote update --apply`.' : 'Download it from ' + c.page}`
    : `Relaymote ${c.current} is up to date (latest release ${c.latest}).`);
}

module.exports = { DEFAULTS, PUBLIC_KEY, UPDATE_TASK, cmpVersion, installKind, assetName, verifySums, listedHash, check, fetchVerified, busyReason, apply, launchPlan, launch, landed, tick, cli, state };
