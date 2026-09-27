// tunnel.js — reach the app from your phone anywhere, through Cloudflare.
//
// Two modes, both driven by the `cloudflared` binary (https://github.com/cloudflare/cloudflared):
//
//   cloudflare-quick   No account needed. `cloudflared tunnel --url` hands out a random
//                      https://<words>.trycloudflare.com address. It changes every time the tunnel
//                      restarts, so the phone has to re-scan the QR code after a reboot.
//
//   cloudflare-named   A fixed hostname on a domain in YOUR Cloudflare account. One-time setup:
//                      `relaymote tunnel login` (opens the Cloudflare login in a browser), then
//                      `relaymote tunnel setup <hostname>` creates the tunnel and its DNS record.
//                      After that the address never changes.
//
// Either way the app still requires its access token (carried in the pairing link and kept as a
// cookie), so an address that leaks is not a way in. Optional Cloudflare Access verification is in
// mobile/access.js.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const config = require('./config');

const STATE_FILE = path.join(config.STATE, 'tunnel.json');
const LOG_FILE = path.join(config.STATE, 'cloudflared.log');

let child = null;
let current = { mode: 'off', url: null, status: 'stopped', error: null, since: null };
let restartTimer = null;
let backoff = 5000;

const log = m => { try { require('./orchestrator').log('[tunnel] ' + m); } catch { console.log('[tunnel] ' + m); } };

function save() { try { fs.writeFileSync(STATE_FILE, JSON.stringify(current, null, 2)); } catch {} }

/** Locate cloudflared: the configured path, then PATH, then the usual install locations. */
function binary() {
  const cfg = config.get().remote || {};
  const exe = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  const candidates = [];
  if (cfg.cloudflaredPath) candidates.push(cfg.cloudflaredPath);
  for (const d of String(process.env.PATH || '').split(path.delimiter)) if (d) candidates.push(path.join(d, exe));
  if (process.platform === 'win32') {
    candidates.push(path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'cloudflared', exe));
    candidates.push(path.join(process.env.ProgramFiles || 'C:\\Program Files', 'cloudflared', exe));
    candidates.push(path.join(config.DATA, 'bin', exe));
  } else {
    candidates.push('/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared', '/usr/bin/cloudflared');
  }
  return candidates.find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
}

function certPath() { return path.join(os.homedir(), '.cloudflared', 'cert.pem'); }
const loggedIn = () => fs.existsSync(certPath());

function run(args, timeoutMs = 60000) {
  return new Promise(resolve => {
    const bin = binary();
    if (!bin) return resolve({ ok: false, error: 'cloudflared not found' });
    execFile(bin, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err && err.code, out: String(stdout || '') + String(stderr || '') });
    });
  });
}

function status() {
  const cfg = config.get().remote || {};
  return {
    ...current,
    configuredMode: cfg.mode || 'off',
    hostname: cfg.hostname || '',
    cloudflared: binary(),
    loggedIn: loggedIn(),
  };
}

/** The address a phone should open, or null when the tunnel is not up. */
function publicUrl() {
  const cfg = config.get().remote || {};
  if (cfg.mode === 'cloudflare-named' && cfg.hostname && current.status === 'running') return 'https://' + cfg.hostname;
  if (cfg.mode === 'cloudflare-quick' && current.url) return current.url;
  return null;
}

function stop() {
  clearTimeout(restartTimer); restartTimer = null;
  if (child) { try { child.kill(); } catch {} child = null; }
  current = { ...current, status: 'stopped', url: null };
  save();
}

function launch(args, mode) {
  const bin = binary();
  if (!bin) {
    current = { mode, url: null, status: 'error', error: 'cloudflared is not installed. Install it (winget install Cloudflare.cloudflared, or brew install cloudflared) or set its path in Settings.', since: new Date().toISOString() };
    save(); log(current.error); return;
  }
  const out = fs.openSync(LOG_FILE, 'a');
  current = { mode, url: null, status: 'starting', error: null, since: new Date().toISOString() };
  save();
  log(`starting cloudflared (${mode})`);
  const me = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child = me;
  const onData = buf => {
    const s = buf.toString();
    try { fs.writeSync(out, s); } catch {}
    const m = s.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (child !== me) return;
    if (m && current.url !== m[0]) { current.url = m[0]; current.status = 'running'; save(); log('public address ' + m[0]); backoff = 5000; }
    if (/Registered tunnel connection|Connection [a-f0-9-]+ registered/i.test(s) && current.status !== 'running') {
      current.status = 'running'; save(); backoff = 5000;
    }
  };
  me.stdout.on('data', onData);
  me.stderr.on('data', onData);
  me.on('exit', code => {
    try { fs.closeSync(out); } catch {}
    if (child !== me) return; // stopped on purpose
    child = null;
    current = { ...current, status: 'error', url: null, error: `cloudflared exited (${code}); retrying in ${Math.round(backoff / 1000)}s` };
    save(); log(current.error);
    restartTimer = setTimeout(apply, backoff);
    backoff = Math.min(backoff * 2, 5 * 60000);
  });
}

/** Bring the tunnel in line with the current settings. Safe to call repeatedly. */
function apply() {
  const cfg = config.get();
  const r = cfg.remote || {};
  const target = `http://127.0.0.1:${cfg.appPort}`;
  const want = r.mode === 'cloudflare-quick' ? ['quick', target]
    : r.mode === 'cloudflare-named' && r.hostname ? ['named', target, r.tunnelName || 'relaymote']
    : null;
  const key = want ? want.join('|') : 'off';
  if (apply._key === key && (child || !want)) return status();
  apply._key = key;
  stop();
  if (!want) { current = { mode: r.mode || 'off', url: null, status: 'stopped', error: null, since: null }; save(); return status(); }
  if (want[0] === 'quick') launch(['tunnel', '--no-autoupdate', '--url', target], 'cloudflare-quick');
  else launch(['tunnel', '--no-autoupdate', 'run', '--url', target, want[2]], 'cloudflare-named');
  return status();
}

/** Start the browser login that authorises this machine for your Cloudflare account. */
function login() {
  const bin = binary();
  if (!bin) return Promise.resolve({ ok: false, error: 'cloudflared not found' });
  if (loggedIn()) return Promise.resolve({ ok: true, already: true });
  return new Promise(resolve => {
    const p = spawn(bin, ['tunnel', 'login'], { windowsHide: true });
    let buf = '', sent = false;
    const onData = d => {
      buf += d.toString();
      const m = buf.match(/https:\/\/dash\.cloudflare\.com\/argotunnel\?[^\s]+/);
      if (m && !sent) { sent = true; resolve({ ok: true, loginUrl: m[0], note: 'Open this link, pick the domain, and authorise. Relaymote notices when it is done.' }); }
    };
    p.stdout.on('data', onData); p.stderr.on('data', onData);
    p.on('exit', code => { if (!sent) resolve({ ok: code === 0 && loggedIn(), out: buf.slice(-800) }); });
  });
}

/** Create (or reuse) the named tunnel and point `hostname` at it. */
async function setupNamed(hostname, name) {
  hostname = String(hostname || '').trim().toLowerCase();
  name = String(name || config.get().remote.tunnelName || 'relaymote').trim();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(hostname)) return { ok: false, error: 'enter a hostname like relaymote.example.com' };
  if (!loggedIn()) return { ok: false, error: 'not logged in to Cloudflare yet — run the login step first' };
  const list = await run(['tunnel', 'list', '--output', 'json']);
  let exists = false;
  try { exists = JSON.parse(list.out.slice(list.out.indexOf('['))).some(t => t.name === name && !t.deleted_at); } catch {}
  if (!exists) {
    const c = await run(['tunnel', 'create', name]);
    if (!c.ok) return { ok: false, error: 'tunnel create failed', detail: c.out.slice(-600) };
  }
  const d = await run(['tunnel', 'route', 'dns', '--overwrite-dns', name, hostname]);
  if (!d.ok) return { ok: false, error: 'DNS route failed', detail: d.out.slice(-600) };
  config.set({ remote: { mode: 'cloudflare-named', hostname, tunnelName: name } });
  apply._key = null;
  apply();
  return { ok: true, hostname, tunnel: name };
}

module.exports = { apply, stop, status, publicUrl, login, setupNamed, binary, loggedIn };
