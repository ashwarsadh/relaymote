// media-many.js — g2670, 14-Nov-2026, Ashwar: "V7 not playing relaymote". The Kannauji podcast session had sent him 14
// audio takes (7-8 min each) one after another; the newest, v7, would not play, while v6 had. Reproduced here: the real
// app in headless Edge at phone size, the real daemon serving real files from disk through /api/sent-file, a chat that
// holds many sent audio files, and the NEWEST one must load and play.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const crypto = require('crypto');
const H = require('./mobile-harness');
const { check } = H;
const row = (type, content) => JSON.stringify({ type, timestamp: new Date().toISOString(), uuid: crypto.randomUUID(), message: { role: type, content } }) + '\n';
const findJsonl = (dir, cli) => { for (const d of fs.readdirSync(dir)) { const p = path.join(dir, d, cli + '.jsonl'); if (fs.existsSync(p)) return p; } return null; };

const bin = [process.env.CHROME_BIN, 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(p => p && fs.existsSync(p));
if (!bin) { console.log('skip: no Edge/Chrome on this machine'); process.exit(0); }

// Android Chrome's cap on media players in a page (40), set on desktop Chrome with --max-web-media-player-count.
// Measured 14-Nov on the code before the fix: 25 takes + 20 s of a working session = 185 refusals, newest take error 4.
const TAKES = Number(process.env.MEDIA_TAKES || 25), MAX_PLAYERS = process.env.MEDIA_MAX_PLAYERS || '40';
// 8 minutes of a quiet tone, 8 kHz mono 8-bit WAV (3.8 MB): long files, as his takes were.
const WAV = (() => { const n = 8000 * 480, b = Buffer.alloc(44 + n); b.write('RIFF', 0); b.writeUInt32LE(36 + n, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24); b.writeUInt32LE(8000, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write('data', 36); b.writeUInt32LE(n, 40); for (let i = 0; i < n; i++) b[44 + i] = 128 + Math.round(8 * Math.sin(2 * Math.PI * 220 * i / 8000)); return b; })();

(async () => {
  const fake = await H.fakeDesktop();
  const w = H.world('mediamany', { settings: { cdpPort: fake.port } });
  const id = w.sessions().filter(s => !/^Migrate database/.test(s.title || '')).map(s => s.sessionId || s.id).filter(Boolean)[0];
  const sess = w.sessions().find(x => (x.sessionId || x.id) === id);
  const file = findJsonl(path.join(w.claude, 'projects'), sess.cliSessionId);
  // The takes are real files on disk; the session sends them one by one, the last one with its script, as v7 was.
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'mediamany-out-'));
  const takes = [];
  for (let k = 1; k <= TAKES; k++) { const f = path.join(out, `chinta_v${k}.wav`); fs.writeFileSync(f, WAV); takes.push(f); }
  fs.writeFileSync(path.join(out, 'chinta.txt'), 'script');
  for (let k = 0; k < TAKES - 1; k++) fs.appendFileSync(file, row('assistant', [{ type: 'tool_use', id: 'toolu_t' + k, name: 'SendUserFile', input: { files: [takes[k]], caption: 'take ' + (k + 1), status: 'normal', display: 'render' } }]) +
    row('user', [{ type: 'tool_result', tool_use_id: 'toolu_t' + k, content: '1 file delivered to user.' }]));
  const d = await H.boot(w);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'mediamany-'));
  const dbg = 30000 + Math.floor(Math.random() * 20000);
  const br = spawn(bin, ['--headless=new', '--remote-debugging-port=' + dbg, '--user-data-dir=' + prof, '--no-first-run', '--autoplay-policy=no-user-gesture-required', '--max-web-media-player-count=' + MAX_PLAYERS, 'about:blank'], { stdio: 'ignore' });
  try {
    let targets;
    for (let i = 0; i < 40 && !targets; i++) { await H.wait(250); try { targets = await (await fetch(`http://127.0.0.1:${dbg}/json`)).json(); } catch {} }
    const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
    await new Promise(r => ws.on('open', r));
    let n = 0, lastNav = 0; const waiting = new Map(); const logs = [];
    const reqs = new Map();   // requestId -> { url, done }
    ws.on('message', m => {
      const j = JSON.parse(m);
      if (j.id && waiting.has(j.id)) { waiting.get(j.id)(j); waiting.delete(j.id); return; }
      if (j.method === 'Page.frameNavigated' && !j.params.frame.parentId) lastNav = Date.now();
      if (j.method === 'Log.entryAdded') logs.push(j.params.entry.text);
      if (j.method === 'Runtime.consoleAPICalled') logs.push((j.params.args || []).map(a => a.value).join(' '));
      if (j.method === 'Network.requestWillBeSent') reqs.set(j.params.requestId, { url: j.params.request.url, done: false, at: Date.now() });
      if ((j.method === 'Network.loadingFinished' || j.method === 'Network.loadingFailed') && reqs.has(j.params.requestId)) reqs.get(j.params.requestId).done = true;
    });
    const cdp = (method, params = {}) => new Promise(r => { const i = ++n; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    const ev = async (expr) => { let r; for (let q = 0; q < 20; q++) { r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r && r.result) break; await H.wait(250); }
      return r && r.result && r.result.result && r.result.result.value; };

    await cdp('Emulation.setDeviceMetricsOverride', { width: 412, height: 860, deviceScaleFactor: 2, mobile: true });
    await cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await cdp('Network.enable');
    await cdp('Network.setCookie', { name: 'baton_m', value: encodeURIComponent(d.token), url: `http://127.0.0.1:${d.app}/` });
    await cdp('Page.enable');
    await cdp('Log.enable'); await cdp('Runtime.enable');
    await cdp('Page.navigate', { url: `http://127.0.0.1:${d.app}/` });
    // Headless Edge reloads a fresh profile's page once; wait for 3 s with no navigation and a booted app.
    for (let i = 0; i < 240 && !(Date.now() - lastNav > 3000 && await ev(`typeof openChat === 'function' && !!document.getElementById('btn-send')`)); i++) await H.wait(250);
    await ev(`openChat(${JSON.stringify(id)}).catch(() => {}); drawer(false)`);
    for (let i = 0; i < 40 && (await ev(`state.open`)) !== id; i++) await H.wait(250);
    for (let i = 0; i < 40 && (await ev(`document.querySelectorAll('#log audio').length`)) < TAKES - 1; i++) await H.wait(250);
    await H.wait(3000);   // every earlier take's player loads its metadata, as on his phone

    // The session is still working: a step lands every second and the log is rebuilt each time (as on his phone).
    const CHURN = Number(process.env.MEDIA_CHURN_S || 20);
    for (let k = 0; k < CHURN; k++) { fs.appendFileSync(file, row('assistant', [{ type: 'text', text: 'working, step ' + k }])); await H.wait(1000); }
    const players = await ev(`document.querySelectorAll('audio').length`);
    console.log('  audio elements in the page: ' + players + '; browser log lines about media players: ' + logs.filter(t => /WebMediaPlayer/i.test(t)).length);
    // The newest take arrives (with its script), as v7 did, while the chat is open.
    fs.appendFileSync(file, row('assistant', [{ type: 'tool_use', id: 'toolu_last', name: 'SendUserFile', input: { files: [takes[TAKES - 1], path.join(out, 'chinta.txt')], caption: 'v' + TAKES, status: 'normal', display: 'render' } }]));
    let shown = false;
    for (let i = 0; i < 60 && !shown; i++) { await H.wait(250); shown = await ev(`[...document.querySelectorAll('#log audio')].some(a => /chinta_v${TAKES}\\.wav/.test(decodeURIComponent(a.src)))`); }
    check(shown, `the newest take (v${TAKES}) shows as a player, after ${TAKES - 1} earlier ones`);
    const open = [...reqs.values()].filter(r => !r.done && /\/api\/sent-file/.test(r.url)).length;
    console.log(`  sent-file requests still open before playing: ${open}`);
    const played = await ev(`(async () => {
      const a = [...document.querySelectorAll('#log audio')].find(a => /chinta_v${TAKES}\\.wav/.test(decodeURIComponent(a.src)));
      if (!a) return 'no player';
      const t0 = performance.now();
      try { await Promise.race([a.play(), new Promise((_, rj) => setTimeout(() => rj(new Error('play() did not start in 8 s')), 8000))]); }
      catch (e) { return 'FAILED: ' + e.message + ' (readyState ' + a.readyState + ', networkState ' + a.networkState + ', error ' + (a.error && a.error.code) + ')'; }
      await new Promise(r => setTimeout(r, 1500));
      return { ms: Math.round(performance.now() - t0), t: +a.currentTime.toFixed(1), paused: a.paused };
    })()`);
    console.log('  newest take:', JSON.stringify(played));
    const wmp = logs.filter(t => /WebMediaPlayer/i.test(t));
    console.log('  media-player refusals: ' + wmp.length + (wmp[0] ? ' e.g. ' + wmp[0].slice(0, 160) : ''));
    check(!wmp.length, 'the browser never refused to create a media player', wmp.length);
    check(played && typeof played === 'object' && !played.paused && played.t > 0.5, 'the newest take plays (its time advances)', played);
    const first = await ev(`(async () => { const a = document.querySelector('#log audio'); a.pause();
      try { await Promise.race([a.play(), new Promise((_, rj) => setTimeout(() => rj(new Error('timeout')), 8000))]); } catch (e) { return 'FAILED: ' + e.message; }
      await new Promise(r => setTimeout(r, 1500)); return { t: +a.currentTime.toFixed(1), paused: a.paused }; })()`);
    check(first && typeof first === 'object' && !first.paused && first.t > 0.5, 'and the oldest take still plays after it', first);
    ws.close();
  } finally {
    br.kill();
    await d.stop(); fake.close();
    await H.wait(500);
    try { fs.rmSync(prof, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(out, { recursive: true, force: true }); } catch {}
  }
  H.finish(w);
})().catch(e => { console.error(e); process.exit(1); });
