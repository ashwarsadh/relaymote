// link-grace.js — 07-Nov, Ashwar: "I also see such errors in [Relaymote], even though I did not even touch" Claude
// Desktop. Banner: "Claude is running, but its link to Relaymote is off ... (Claude's debugger is on.)".
// 1. Relaymote's own stall must not turn an answer already sent into "cdp probe timeout".
// 2. A debugger that truly never answers still times out.
// 3. A drop shows nothing until LINK_GRACE_MS, then the banner; a link never seen up is stated at once.
// 4. Real server.js + fake Desktop: the phone's own fields stay "ok" through the grace and turn after it.
'use strict';
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
if (process.argv[2] === '--server') {
  const srv = http.createServer((q, r) => setTimeout(() => r.end(JSON.stringify([{ webSocketDebuggerUrl: 'ws://x' }])), 200));
  srv.listen(0, '127.0.0.1', () => process.send(srv.address().port));
  return;
}
const H = require('./mobile-harness');
const { check, wait } = H;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-grace-'));
process.env.RELAYMOTE_HOME = path.join(tmp, 'home');
process.env.APPDATA = path.join(tmp, 'appdata');
fs.mkdirSync(process.env.RELAYMOTE_HOME, { recursive: true });
fs.mkdirSync(path.join(process.env.APPDATA, 'Claude'), { recursive: true });
fs.writeFileSync(path.join(process.env.APPDATA, 'Claude', 'developer_settings.json'), '{"allowDevTools":true}');

function listen(handler) { return new Promise(r => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => r(s)); }); }
function setPort(port) { fs.writeFileSync(path.join(process.env.RELAYMOTE_HOME, 'settings.json'), JSON.stringify({ cdpPort: port })); }

(async () => {
  const config = require('../lib/config');
  const desktop = require('../lib/desktop');
  const ds = require('../lib/desktop-state');
  const heal = require('../lib/heal');

  // The answer comes in 200 ms, while this process is blocked for 5 s: the old timer fired first.
  const answers = await new Promise(r => {
    const { fork } = require('child_process');
    const c = fork(path.join(__dirname, 'link-grace.js'), ['--server'], { stdio: 'ignore' });
    c.on('message', port => r({ port, kill: () => c.kill() }));
  });
  setPort(answers.port);
  if (config.reload) config.reload();
  const block = () => { const e = Date.now() + 5000; while (Date.now() < e); };
  const stalled = (p) => { setTimeout(() => setImmediate(block), 30); return p; };
  let got = await stalled(desktop.wsUrl().then(() => 'answered', e => e.message));
  check(got === 'answered', 'a 5 s stall of Relaymote itself: wsUrl reads the answer, no "cdp probe timeout"', got);
  got = await stalled(desktop.cdpAvailable());
  check(got === true, 'and the link reads as up', got);
  const cp = config.get().cdpPort;
  got = await stalled(heal.checkCdp());
  check(got.healthy === true, 'heal.checkCdp (/api/desktop) too', { got, cp });
  answers.kill();

  const silent = await listen(() => {});
  setPort(silent.address().port);
  if (config.reload) config.reload();
  const t0 = Date.now();
  got = await desktop.wsUrl().then(() => 'answered', e => e.message);
  const took = Date.now() - t0;
  check(got === 'cdp probe timeout' && took >= 3500 && took < 7000, 'a debugger that never answers still times out at about 4 s', { got, took });
  silent.closeAllConnections && silent.closeAllConnections(); silent.close();

  const seen = []; ds.onLink = (e) => seen.push(e);
  ds.note({ cdp: false, running: true });
  check(ds.get().state === 'link-off', 'never up since start: stated at once');
  ds.note({ cdp: true });
  check(seen.length === 0, 'that is not counted as a drop');
  ds.note({ cdp: false, running: true });
  check(ds.get().state === 'ok', 'up, then one failed look: no banner', ds.get().state);
  ds._s.debugger = { code: 0, message: "Claude's debugger is on." };
  check(ds.get().state === 'ok', 'nor with the debugger reported on');
  ds._s.linkDownSince = Date.now() - ds.LINK_GRACE_MS - 1000;
  check(ds.get().state === 'slow' && !ds.get().detail, 'past the grace with the port listening: "slow to answer", never "link off ... debugger is on"', ds.get());
  ds._s.debugger = { code: 5, message: 'port never opened' };
  check(ds.get().state === 'link-off', 'past the grace with the port closed: link off');
  ds._s.debugger = { code: 9, message: 'locked' };
  check(ds.get().state === 'locked', 'a state only he can act on is not hidden');
  ds._s.debugger = { code: 5, message: 'x' };
  ds.note({ cdp: true });
  check(seen.length === 1 && seen[0].shown === true && seen[0].ms >= ds.LINK_GRACE_MS, 'recovery is logged with its length', seen);
  ds.note({ cdp: false, running: false, exe: 'C:/x/claude.exe', launches: [] });
  check(ds.get().state === 'starting', 'Claude actually closed: shown at once');

  // The live fields, through the real server.
  const fake = await H.fakeDesktop();
  const w = H.world('link-grace', { settings: { cdpPort: fake.port } });
  fs.writeFileSync(path.join(w.appdata, 'Claude', 'developer_settings.json'), '{"allowDevTools":true}');
  const d = await H.boot(w, { RELAYMOTE_LINK_GRACE_MS: '15000', RELAYMOTE_NO_LAUNCH: '1' });
  try {
    const read = async () => { const r = await d.req('/api/sessions?limit=5'); return { cdp: r.json.cdp, state: r.json.desktop && r.json.desktop.state }; };
    let up = await read();
    for (let i = 0; i < 20 && !up.cdp; i++) { await wait(500); up = await read(); }
    check(up.cdp === true && up.state === 'ok', 'link up: cdp true, state ok', up);
    fake.close();
    await wait(5000);
    const during = await read();
    const raw = await d.req('/api/desktop');
    check(during.cdp === true && during.state === 'ok', 'port closed 5 s ago: the phone still sees no banner', during);
    check(raw.json.cdp === true && raw.json.desktop.state === 'ok', '/api/desktop agrees (the settings banner reads it)', raw.json.desktop);
    await wait(16000);
    const after = await read();
    check(after.cdp === false && after.state === 'link-off', 'past the grace: the banner shows', after);
  } finally { await d.stop(); w.cleanup(); }
  H.finish(null);
})().catch(e => { console.error(e); process.exit(1); });

