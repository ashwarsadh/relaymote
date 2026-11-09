// mobile-media-play.js — 10-Nov, Ashwar: "Such play buttons inside the Relay Mode app, even for the audio and for the videos
// ... it plays for a few seconds and after that it stops playing." Each render rewrote the log and destroyed the playing
// <audio>. The real app in headless Edge/Chrome: a sent audio file plays while the log is rebuilt every 2 s for 62 s,
// and its currentTime must keep advancing. The file itself is served by the test (CDP Fetch).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const crypto = require('crypto');
const row = (type, content) => JSON.stringify({ type, timestamp: new Date().toISOString(), uuid: crypto.randomUUID(), message: { role: type, content } }) + String.fromCharCode(10);
const findJsonl = (dir, cli) => { for (const d of fs.readdirSync(dir)) { const p = path.join(dir, d, cli + '.jsonl'); if (fs.existsSync(p)) return p; } return null; };
const H = require('./mobile-harness');
const { check } = H;

const bin = [process.env.CHROME_BIN, 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(p => p && fs.existsSync(p));
if (!bin) { console.log('skip: no Edge/Chrome on this machine'); process.exit(0); }

const PAGE_HOOK_UNUSED = `(() => {
  // A phone keyboard closing: focus leaves the box and the column grows by the keyboard's height, so the
  // composer (pinned to the bottom) drops. Emulated by shrinking the column while the box has focus.
  window.__pe = []; ['pointerdown','pointerup','pointercancel','click','touchstart','touchend'].forEach(k => addEventListener(k, e => window.__pe.push(k + ':' + ((e.target && e.target.id) || (e.target && e.target.tagName)) + '@' + Math.round(e.clientX || (e.changedTouches && e.changedTouches[0] && e.changedTouches[0].clientX) || 0) + ',' + Math.round(e.clientY || (e.changedTouches && e.changedTouches[0] && e.changedTouches[0].clientY) || 0)), true));
  addEventListener('focusin', e => { if (e.target.id === 'input' && window.__kb) document.documentElement.style.setProperty('--app-h', (innerHeight - 300) + 'px'); }, true);
  addEventListener('focusout', e => { if (e.target.id === 'input' && window.__kb) document.documentElement.style.setProperty('--app-h', innerHeight + 'px'); }, true);
})();`;

// 70 s of a quiet 220 Hz tone, 8 kHz mono 8-bit.
const WAV = (() => { const n = 8000 * 70, b = Buffer.alloc(44 + n); b.write('RIFF', 0); b.writeUInt32LE(36 + n, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24); b.writeUInt32LE(8000, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write('data', 36); b.writeUInt32LE(n, 40); for (let i = 0; i < n; i++) b[44 + i] = 128 + Math.round(8 * Math.sin(2 * Math.PI * 220 * i / 8000)); return b; })();

(async () => {
  const fake = await H.fakeDesktop();
  const w = H.world('mediaplay', { settings: { cdpPort: fake.port } });
  // Not the demo session holding an open question ('Migrate database ...'): ids are random, so [0] was that one 1 run in 6.
  const id = w.sessions().filter(s => !/^Migrate database/.test(s.title || '')).map(s => s.sessionId || s.id).filter(Boolean)[0];
  const d = await H.boot(w);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'mediaplay-'));
  const dbg = 30000 + Math.floor(Math.random() * 20000);
  const br = spawn(bin, ['--headless=new', '--remote-debugging-port=' + dbg, '--user-data-dir=' + prof, '--no-first-run', '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' });
  try {
    let targets;
    for (let i = 0; i < 40 && !targets; i++) { await H.wait(250); try { targets = await (await fetch(`http://127.0.0.1:${dbg}/json`)).json(); } catch {} }
    const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
    await new Promise(r => ws.on('open', r));
    let n = 0; const waiting = new Map();
    // Every POST /api/send is caught at the network layer and answered here (ok, or the PC refusing).
    const sends = []; let sendMode = 'ok', served = 0;
    ws.on('message', m => {
      const j = JSON.parse(m);
      if (j.id && waiting.has(j.id)) { waiting.get(j.id)(j); waiting.delete(j.id); return; }
      if (j.method === 'Fetch.requestPaused') {
        const q = j.params.request, ok = sendMode === 'ok';
        if (new URL(q.url).pathname === '/api/sent-file') {
          served++;
          ws.send(JSON.stringify({ id: ++n, method: 'Fetch.fulfillRequest', params: { requestId: j.params.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'audio/wav' }, { name: 'Content-Length', value: String(WAV.length) }], body: WAV.toString('base64') } }));
        } else ws.send(JSON.stringify({ id: ++n, method: 'Fetch.continueRequest', params: { requestId: j.params.requestId } }));
      }
    });
    const cdp = (method, params = {}) => new Promise(r => { const i = ++n; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    const ev = async (expr) => { const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result && r.result.exceptionDetails) console.log('EVERR', JSON.stringify(r.result.exceptionDetails).slice(0, 300)); return r.result && r.result.result && r.result.result.value; };

    await cdp('Emulation.setDeviceMetricsOverride', { width: 412, height: 860, deviceScaleFactor: 2, mobile: true });
    await cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await cdp('Network.enable');
    await cdp('Fetch.enable', { patterns: [{ urlPattern: '*/api/sent-file*' }] });
    await cdp('Network.setCookie', { name: 'baton_m', value: encodeURIComponent(d.token), url: `http://127.0.0.1:${d.app}/` });
    await cdp('Page.enable');
        let navs = 0;
    ws.on('message', m => { const j = JSON.parse(m); if (j.method === 'Page.frameNavigated' && !j.params.frame.parentId) navs++; });
    await cdp('Page.navigate', { url: `http://127.0.0.1:${d.app}/` });
    // The first visit installs the service worker; wait until it controls the page (and any reload that brings) has settled.
    for (let i = 0; i < 60 && !(await ev(`typeof openChat === 'function' && !!document.getElementById('btn-send') && !!navigator.serviceWorker.controller`)); i++) await H.wait(250);
    await H.wait(1500);
    for (let i = 0; i < 60 && !(await ev(`typeof openChat === 'function' && !!document.getElementById('btn-send')`)); i++) await H.wait(250);
    await ev(`openChat(${JSON.stringify(id)}).catch(() => {}); drawer(false)`);
    for (let i = 0; i < 40 && (await ev(`state.open`)) !== id; i++) await H.wait(250);
    await H.wait(800);
    // The session SENDS an audio file (SendUserFile), as a working session would, into its own transcript.
    const sess = w.sessions().find(x => (x.sessionId || x.id) === id);
    const file = findJsonl(path.join(w.claude, 'projects'), sess.cliSessionId);
    fs.appendFileSync(file, row('assistant', [{ type: 'text', text: 'Here is the voice note.' }, { type: 'tool_use', id: 'toolu_sf1', name: 'SendUserFile', input: { files: ['C:/out/note.wav'], caption: 'voice note' } }]));
    let ready = false;
    for (let i = 0; i < 40 && !ready; i++) { await H.wait(250); ready = await ev(`!!document.querySelector('#log audio')`); }
    check(ready, 'the sent audio shows as a player in the chat');
    const started = await ev(`(async () => { const a = document.querySelector('#log audio'); a.dataset.probe = 'first'; try { await a.play(); } catch (e) { return 'play failed: ' + e.message; } return !a.paused; })()`);
    check(started === true, 'it plays', started);
    // The session keeps working: a new step lands every 2 s and the log is rebuilt each time, for 62 s.
    const t0 = Date.now(), samples = [];
    for (let k = 0; Date.now() - t0 < 62000; k++) {
      fs.appendFileSync(file, row('assistant', [{ type: 'text', text: 'Still working, step ' + k }]));
      await H.wait(2000);
      samples.push(await ev(`(() => { const a = document.querySelector('#log audio'); return a ? { t: +a.currentTime.toFixed(1), paused: a.paused, same: a.dataset.probe === 'first', n: document.querySelectorAll('#log audio').length } : null; })()`));
    }
    const last = samples[samples.length - 1] || {};
    const rose = samples.every((s, i) => s && (i === 0 || s.t > samples[i - 1].t));
    console.log('  samples', JSON.stringify(samples.filter((_, i) => i % 6 === 0 || i === samples.length - 1)));
    check(samples.length >= 28 && rose && served >= 1, 'over 60 s of re-renders currentTime advanced at every sample', samples.length);
    check(last.t >= 55 && !last.paused, 'and reached 55 s or more, still playing', last);
    check(samples.every(s => s && s.same && s.n === 1), 'one player throughout, the same element (never re-created)');
    console.log('  file requests', served);
    ws.close();
  } finally {
    br.kill();
    await d.stop(); fake.close();
    await H.wait(500);
    try { fs.rmSync(prof, { recursive: true, force: true }); } catch {}
  }
  H.finish(w);
})().catch(e => { console.error(e); process.exit(1); });
