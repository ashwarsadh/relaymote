// smoke.js — boot Relaymote in a throwaway data folder on spare ports and check the basics.
// It never talks to Claude Desktop: the debugger port points at nothing and every module that
// drives the desktop is switched off.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-smoke-'));
const PORT = 18000 + Math.floor(Math.random() * 1000), APP = PORT + 1000;
fs.writeFileSync(path.join(HOME, 'settings.json'), JSON.stringify({
  cdpPort: 9, onboarded: true, autoEnableDebugger: false,
  modules: { autoResume: false, orchestrator: false, chipAutostart: false, masterNotify: false, organizer: false },
}));
const env = { ...process.env, RELAYMOTE_HOME: HOME, RELAYMOTE_PORT: String(PORT), RELAYMOTE_APP_PORT: String(APP) };

let failed = 0;
const check = (ok, name, extra) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };
function req(port, p, { method = 'GET', body, headers = {} } = {}) {
  return new Promise(resolve => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port, path: p, method, timeout: 15000,
      headers: { ...headers, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) } },
      res => { let s = ''; res.on('data', c => s += c); res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch {} resolve({ status: res.statusCode, text: s, json: j, headers: res.headers }); }); });
    r.on('error', e => resolve({ status: 0, text: e.message })); r.on('timeout', () => r.destroy());
    if (data) r.write(data); r.end();
  });
}
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', d => out += d); child.stderr.on('data', d => out += d);
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { await wait(250); up = (await req(PORT, '/api/health')).status === 200; }
  check(up, 'daemon answers /api/health');
  let appUp = false;
  for (let i = 0; i < 40 && !appUp; i++) { await wait(250); appUp = (await req(APP, '/manifest.webmanifest')).status === 200; }
  check(appUp, 'app port serves the manifest');

  const token = JSON.parse(fs.readFileSync(path.join(HOME, 'mobile', 'secret.json'), 'utf8')).token;
  check(!!token && token.length >= 24, 'access token generated in the data folder');
  const auth = { Authorization: 'Bearer ' + token };

  check((await req(APP, '/api/settings')).status === 401, 'settings refused without the token');
  const s = await req(APP, '/api/settings', { headers: auth });
  check(s.status === 200 && s.json && s.json.settings && s.json.settings.appPort === APP, 'settings readable with the token');
  const w = await req(APP, '/api/settings', { method: 'POST', headers: auth, body: { idleGateSeconds: 7 } });
  check(w.status === 200 && w.json.settings.idleGateSeconds === 7, 'settings writable');
  check(JSON.parse(fs.readFileSync(path.join(HOME, 'settings.json'), 'utf8')).idleGateSeconds === 7, 'settings persisted to disk');

  const p = await req(APP, '/api/pair', { headers: auth });
  const links = (p.json && p.json.links) || [];
  check(links.length >= 1 && links.every(l => l.url.includes('k=')), 'pairing links carry the key', links.map(l => l.kind).join(','));
  check(links.some(l => /^<svg|^<\?xml/.test(String(l.qr || '').trim())), 'pairing QR rendered as SVG');

  const home = await req(APP, '/?k=' + encodeURIComponent(token));
  check(home.status === 302 && /baton_m=/.test(String(home.headers['set-cookie'] || '')), 'pairing link sets the sign-in cookie');
  const idx = await req(APP, '/', { headers: { Cookie: 'baton_m=' + encodeURIComponent(token) } });
  check(idx.status === 200 && idx.text.includes('settings-ui.js'), 'app shell served with settings screen');
  const boot = await req(APP, '/api/bootstrap', { headers: auth });
  check(boot.status === 200, 'bootstrap answers');
  const list = await req(APP, '/api/sessions', { headers: auth });
  check(list.status === 200 && Array.isArray(list.json.sessions), 'session list answers', 'sessions on this machine=' + (list.json ? list.json.total : '?'));
  const proj = await req(APP, '/api/projects', { headers: auth });
  check(proj.status === 200 && proj.json && proj.json.projects && proj.json.counts, 'project index answers', 'projects=' + (proj.json && proj.json.counts ? proj.json.counts.projects : '?'));

  // Remote mode "off" (the default) means loopback only: no Tailscale / LAN listener and no such pairing link.
  check(!/\((Tailscale|LAN)\)/.test(out), 'mode off listens on loopback only', (out.match(/listening on \S+/g) || []).join(' '));
  check(!links.some(l => l.kind === 'tailscale' || l.kind === 'lan'), 'mode off offers no Tailscale/LAN pairing link', links.map(l => l.kind).join(','));

  await req(PORT, '/api/shutdown', { method: 'POST' });
  for (let i = 0; i < 40 && child.exitCode === null; i++) await wait(250);
  check(child.exitCode === 0, 'clean shutdown', 'exit=' + child.exitCode);
  if (child.exitCode === null) child.kill();
  if (failed) console.log('\n--- daemon output ---\n' + out.slice(-4000));
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {}
  console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
})();
