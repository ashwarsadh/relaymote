// updater.js — self-update (lib/updater.js, scripts/sign-release.js). No network: the release is served
// by a stubbed request layer. What must hold: only a release whose SHA256SUMS.txt carries a valid
// signature by the embedded key, and whose installer matches its signed line, is ever handed to apply();
// a source checkout never replaces itself; a running task holds the update back.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-updater-'));
process.env.RELAYMOTE_HOME = path.join(TMP, 'home');
const U = require('../lib/updater');

let failed = 0;
const check = (ok, name, extra) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra !== undefined && !ok ? '  ' + JSON.stringify(extra).slice(0, 300) : ''}`); if (!ok) failed++; };

(async () => {
  // Versions
  check(U.cmpVersion('0.2.10', '0.2.9') === 1 && U.cmpVersion('0.2.9', '0.2.10') === -1, '0.2.10 is newer than 0.2.9 (numeric, not string order)');
  check(U.cmpVersion('v1.0.0', '1.0.0') === 0 && U.cmpVersion('1.0.0-rc.1', '1.0.0') === -1 && U.cmpVersion('1.0.0', '0.9.9-rc.9') === 1, 'a "v" prefix is ignored; a pre-release sorts below its release');

  // Install kinds
  const mk = (files) => { const d = fs.mkdtempSync(path.join(TMP, 'kind-')); for (const f of files) fs.mkdirSync(path.join(d, f), { recursive: true }); return d; };
  check(U.installKind(mk(['.git']), 'win32') === 'source', 'a git checkout is "source" (never replaces itself)');
  const inst = mk([]); fs.writeFileSync(path.join(inst, 'unins000.exe'), '');
  check(U.installKind(inst, 'win32') === 'windows-installer' && U.installKind(inst, 'linux') === 'portable', 'unins000.exe on Windows = an installer copy; elsewhere portable');
  check(U.installKind(path.join(TMP, 'Relaymote.app', 'Contents', 'Resources', 'app'), 'darwin') === 'macos-app', 'inside Relaymote.app = macos-app');
  check(U.assetName('windows-installer', '0.3.0') === 'Relaymote-Setup-0.3.0-x64.exe' && U.assetName('portable', '0.3.0') === null, 'only the installer copy has an asset to install');
  check(U.installKind() === 'source', 'this test runs from a checkout, so the daemon here would only report');

  // Signatures: a throwaway key signs; the embedded key must NOT accept it (and does accept a real one in CI).
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'pem' });
  const sums = 'a'.repeat(64) + '  Relaymote-Setup-9.9.9-x64.exe\n' + 'b'.repeat(64) + '  SHA256SUMS-other.txt\n';
  const sig = crypto.sign(null, Buffer.from(sums), privateKey).toString('base64');
  check(U.verifySums(sums, sig, pub), 'a signature verifies with its own key');
  check(!U.verifySums(sums.replace('a', 'c'), sig, pub), 'one changed character in SHA256SUMS.txt breaks it');
  check(!U.verifySums(sums, sig), 'a signature by any other key is refused by the embedded release key');
  check(!U.verifySums(sums, 'not-base64!!'), 'garbage is refused, not thrown');
  check(U.listedHash(sums, 'Relaymote-Setup-9.9.9-x64.exe') === 'a'.repeat(64) && U.listedHash(sums, 'Relaymote-Setup-9.9.9') === null, 'the hash is looked up by exact file name');
  check(/-----BEGIN PUBLIC KEY-----\nMCowBQYDK2Vw/.test(U.PUBLIC_KEY), 'the embedded key is an Ed25519 SPKI key');

  // sign-release.js: refuses a key that does not match the embedded one; no key + required = error.
  const sumsFile = path.join(TMP, 'SHA256SUMS.txt');
  fs.writeFileSync(sumsFile, sums);
  const run = (env) => spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'sign-release.js'), sumsFile], { encoding: 'utf8', env: { ...process.env, ...env } });
  const r1 = run({ RELAYMOTE_SIGNING_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }), RELAYMOTE_REQUIRE_SIGNATURE: '1' });
  check(r1.status === 1 && /does not match/.test(r1.stderr) && !fs.existsSync(sumsFile + '.sig'), 'sign-release refuses a key that the embedded public key would reject', r1.stderr);
  const r2 = run({ RELAYMOTE_SIGNING_KEY: '', RELAYMOTE_REQUIRE_SIGNATURE: '1' });
  check(r2.status === 1 && /not set/.test(r2.stderr), 'sign-release fails the release when the key is missing and required');
  const r3 = run({ RELAYMOTE_SIGNING_KEY: '', RELAYMOTE_REQUIRE_SIGNATURE: '' });
  check(r3.status === 0 && !fs.existsSync(sumsFile + '.sig'), 'a fork without a key gets an unsigned release (no copy will auto-install it)');
  const local = path.join(os.homedir(), '.relaymote-signing', 'update-signing-key.pem');
  if (fs.existsSync(local)) {
    const r4 = run({ RELAYMOTE_SIGNING_KEY: fs.readFileSync(local, 'utf8'), RELAYMOTE_REQUIRE_SIGNATURE: '1' });
    check(r4.status === 0 && U.verifySums(sums, fs.readFileSync(sumsFile + '.sig', 'utf8')), 'the release key on this machine signs, and the embedded key accepts it');
    fs.unlinkSync(sumsFile + '.sig');
  } else console.log('skip  (no release key on this machine: the embedded-key round trip is checked by the release workflow)');

  // fetchVerified against a stubbed release: only the fully verified path returns a file.
  const https = require('https');
  const realGet = https.get;
  const serve = (files) => {
    https.get = (url, opts, cb) => {
      const { PassThrough } = require('stream');
      const res = new PassThrough(); const req = new (require('events'))();
      req.destroy = (e) => req.emit('error', e);
      const name = String(url).split('/').pop();
      res.statusCode = name in files ? 200 : 404; res.headers = {};
      process.nextTick(() => { cb(res); res.end(files[name] == null ? '' : files[name]); });
      return req;
    };
  };
  const exe = Buffer.from('MZ fake installer');
  const exeHash = crypto.createHash('sha256').update(exe).digest('hex');
  const assets = n => Object.fromEntries(n.map(x => [x, 'https://example.invalid/dl/' + x]));
  const c = { kind: 'windows-installer', latest: '9.9.9', assets: assets(['Relaymote-Setup-9.9.9-x64.exe', 'SHA256SUMS.txt', 'SHA256SUMS.txt.sig']) };
  const goodSums = exeHash + '  Relaymote-Setup-9.9.9-x64.exe\n';
  const goodSig = crypto.sign(null, Buffer.from(goodSums), privateKey).toString('base64');
  try {
    // The throwaway key is not the release key, so even a consistent release is refused.
    serve({ 'Relaymote-Setup-9.9.9-x64.exe': exe, 'SHA256SUMS.txt': goodSums, 'SHA256SUMS.txt.sig': goodSig });
    let f = await U.fetchVerified(c);
    check(!f.ok && /signature does not verify/.test(f.error), 'a release signed by a different key is refused before any download', f);
    check(!fs.existsSync(path.join(process.env.RELAYMOTE_HOME, 'updates', 'Relaymote-Setup-9.9.9-x64.exe')), 'and nothing was saved');
    f = await U.fetchVerified(c, { key: pub });
    const saved = path.join(process.env.RELAYMOTE_HOME, 'updates', 'Relaymote-Setup-9.9.9-x64.exe');
    check(f.ok && f.sha256 === exeHash && fs.readFileSync(saved).equals(exe), 'signed by the trusted key and matching its line: downloaded and kept', f);
    fs.unlinkSync(saved);
    serve({ 'Relaymote-Setup-9.9.9-x64.exe': Buffer.from('MZ tampered'), 'SHA256SUMS.txt': goodSums, 'SHA256SUMS.txt.sig': goodSig });
    f = await U.fetchVerified(c, { key: pub });
    check(!f.ok && /does not match the signed/.test(f.error) && !fs.existsSync(saved) && !fs.existsSync(saved + '.part'), 'an installer that differs from its signed hash is refused and deleted', f);
    f = await U.fetchVerified({ ...c, assets: assets(['Relaymote-Setup-9.9.9-x64.exe', 'SHA256SUMS.txt']) });
    check(!f.ok && /not signed/.test(f.error), 'a release without SHA256SUMS.txt.sig is refused', f);
    f = await U.fetchVerified({ ...c, kind: 'source' });
    check(!f.ok && /does not update itself/.test(f.error), 'a source copy never fetches an installer');
  } finally { https.get = realGet; }

  // A running task holds the update back.
  const reg = require('../lib/registry');
  const realBy = reg.byStatus;
  reg.byStatus = s => s === 'running' ? [{ id: 't1' }] : [];
  check(/1 Relaymote task\(s\) running/.test(U.busyReason() || ''), 'a running task holds the update back');
  reg.byStatus = () => [];
  check(U.busyReason() === null, 'and nothing running lets it through');
  reg.byStatus = realBy;

  // The apply script (written, not run): silent install over THIS folder, then start.
  const a = U.apply(path.join(TMP, 'Relaymote-Setup-9.9.9-x64.exe'), '9.9.9', { dry: true });
  const script = fs.readFileSync(a.script, 'utf8');
  check(a.dry && /\/VERYSILENT \/SUPPRESSMSGBOXES \/NORESTART \/DIR="/.test(script) && /bin\\relaymote\.js" start|bin\/relaymote\.js" start/.test(script), 'the apply script installs silently over this folder, then starts Relaymote', script);

  // Who starts the apply script. WMI first; refused (ReturnValue 2, as measured for a standard user on
  // Windows Server) it goes to a one-shot scheduled task; both refused, a detached child.
  const plan = U.launchPlan('C:\\x\\apply-update.cmd');
  check(plan.map(p => p.via).join() === 'wmi,task' && plan[1].args[0].includes('/IT') && plan[1].args[0][plan[1].args[0].indexOf('/TN') + 1] === U.UPDATE_TASK
    && plan[1].args[1].join(' ') === '/Run /TN ' + U.UPDATE_TASK, 'launch order: WMI, then a one-shot interactive task that is created and run', plan);
  check(U.launchPlan('C:\\' + 'x'.repeat(260) + '\\a.cmd')[1].args === null, 'a /TR over 261 characters skips the task route');
  const runs = [];
  const fake = (answers) => (exe, args) => { runs.push(exe + ' ' + args[0]); return answers[exe + ' ' + args[0]] || { status: 0, stdout: '' }; };
  let L = U.launch('C:\\x\\a.cmd', { run: fake({ 'powershell.exe -NoProfile': { status: 0, stdout: '2 \r\n' } }), detached: () => 99 });
  check(L.via === 'task' && runs.join('|') === 'powershell.exe -NoProfile|schtasks.exe /Create|schtasks.exe /Run', 'WMI refused (2): the task route starts it', { L, runs });
  runs.length = 0;
  L = U.launch('C:\\x\\a.cmd', { run: fake({ 'powershell.exe -NoProfile': { status: 0, stdout: '0 4242' } }), detached: () => 99 });
  check(L.via === 'wmi' && runs.length === 1, 'WMI accepted (0): nothing else is tried', { L, runs });
  runs.length = 0;
  L = U.launch('C:\\x\\a.cmd', { run: fake({ 'powershell.exe -NoProfile': { status: 0, stdout: '2' }, 'schtasks.exe /Create': { status: 1, stderr: 'Access is denied.' } }), detached: () => 99 });
  check(L.via === 'detached' && L.pid === 99 && !runs.includes('schtasks.exe /Run') && /task: Access is denied/.test(L.tried.join()), 'task not created: never run, the detached child is the last resort', { L, runs });

  // After the restart into the new version: recorded once, task removed, tray back only if it was on.
  const stFile = path.join(process.env.RELAYMOTE_HOME, 'state', 'update.json');
  const cur = require('../package.json').version;
  const land = (st, trayUp) => {
    fs.mkdirSync(path.dirname(stFile), { recursive: true });
    fs.writeFileSync(stFile, JSON.stringify(st));
    const did = [];
    const r = U.landed({ isTrayRunning: () => trayUp, openTray: () => did.push('tray'), run: (exe, a) => { did.push(exe + ' ' + a.join(' ')); return { status: 0 }; } });
    return { r, did, after: JSON.parse(fs.readFileSync(stFile, 'utf8')) };
  };
  let x = land({ trayRunning: true, installing: { from: '0.0.1', to: cur } }, false);
  check(x.r && x.r.landedAt && x.r.trayRestarted === true && x.did.includes('tray') && !x.after.installing && x.after.lastInstalled.to === cur,
    'landed: recorded, installing cleared, and the tray that was running is started again', x);
  check(process.platform !== 'win32' || x.did.includes('schtasks.exe /Delete /TN ' + U.UPDATE_TASK + ' /F'), 'landed: the one-shot task is deleted', x.did);
  x = land({ trayRunning: true, installing: { from: '0.0.1', to: cur } }, true);
  check(!x.did.includes('tray') && !x.r.trayRestarted, 'a tray already back is not started twice', x);
  x = land({ trayRunning: false, installing: { from: '0.0.1', to: cur } }, false);
  check(!x.did.includes('tray'), 'no tray before the update: none after', x);
  x = land({ trayRunning: true, installing: { from: cur, to: '99.0.0' } }, false);
  check(x.r === null && x.did.length === 0 && x.after.installing, 'still on the old version (install failed): nothing recorded, nothing started', x);
  x = land({ trayRunning: true, lastInstalled: { to: cur } }, false);
  check(x.r === null && x.did.length === 0, 'nothing being installed: landed() does nothing (it runs at every start)', x);

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  console.log(failed ? `\n${failed} check(s) failed` : '\nall updater checks passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
