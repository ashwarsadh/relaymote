// phone-wake.js — 24-Nov-2026. Ashwar: "Msgs stuck ... I force stopped the relaymote and reopen then it worked". The app said
// "waiting to send — your PC can't be reached" while the PC was up; only a restart of the app sent the message, and an image upload
// sat at "failed — tap to retry". The real app in a real browser (phone-sized) against the daemon in a test world, with the
// network cut and restored WITHOUT restarting the page: waiting messages and failed uploads must go by themselves the moment the
// phone may have a network again, ignoring the long retry wait they were given.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const H = require('./mobile-harness');
const { check } = H;

const bin = [process.env.CHROME_BIN, 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(p => p && fs.existsSync(p));
if (!bin) { console.log('skip: no Edge/Chrome on this machine'); process.exit(H.failures() ? 1 : 0); }

(async () => {
  const fake = await H.fakeDesktop();
  const w = H.world('phonewake', { settings: { cdpPort: fake.port } });
  const id = w.sessions().filter(s => !/^Migrate database/.test(s.title || '')).map(s => s.sessionId || s.id).filter(Boolean)[0];
  const d = await H.boot(w);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'phonewake-'));
  const dbg = 30000 + Math.floor(Math.random() * 20000);
  const br = spawn(bin, ['--headless=new', '--remote-debugging-port=' + dbg, '--user-data-dir=' + prof, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  try {
    let targets;
    for (let i = 0; i < 40 && !targets; i++) { await H.wait(250); try { targets = await (await fetch(`http://127.0.0.1:${dbg}/json`)).json(); } catch {} }
    const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
    await new Promise(r => ws.on('open', r));
    let n = 0, lastNav = 0; const waiting = new Map(), sends = [], uploads = [], errors = [];
    let netUp = false;   // the "network": false = every send/upload/probe fails to connect
    const json = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64');
    ws.on('message', m => {
      const j = JSON.parse(m);
      if (j.id && waiting.has(j.id)) { waiting.get(j.id)(j); waiting.delete(j.id); return; }
      if (j.method === 'Page.frameNavigated' && !j.params.frame.parentId) lastNav = Date.now();
      if (j.method === 'Runtime.exceptionThrown') errors.push(j.params.exceptionDetails.text + ' ' + ((j.params.exceptionDetails.exception || {}).description || ''));
      if (j.method === 'Fetch.requestPaused') {
        const r = j.params.request, p = new URL(r.url).pathname, rid = j.params.requestId;
        const send = (method, params) => ws.send(JSON.stringify({ id: ++n, method, params }));
        const isSend = r.method === 'POST' && p === '/api/send', isUp = r.method === 'POST' && p === '/api/upload', isProbe = /generate_204/.test(r.url);
        if (!(isSend || isUp || isProbe)) return send('Fetch.continueRequest', { requestId: rid });
        if (!netUp) return send('Fetch.failRequest', { requestId: rid, errorReason: 'ConnectionFailed' });
        const body = isSend ? (sends.push(JSON.parse(r.postData || '{}').text), { ok: true, already: true, result: { ok: true, confirmed: true } })
          : isUp ? (uploads.push(r.headers['X-Filename'] || '?'), { ok: true, path: 'C:\\\\up\\\\' + (r.headers['X-Filename'] || 'f') })
          : {};
        send('Fetch.fulfillRequest', { requestId: rid, responseCode: isProbe ? 204 : 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Access-Control-Allow-Origin', value: '*' }], body: isProbe ? '' : json(body) });
      }
    });
    const cdp = (method, params = {}) => new Promise(r => { const i = ++n; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    const ev = async (expr) => { let r; for (let k = 0; k < 20; k++) { r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r && r.result) break; await H.wait(250); }
      if (!r || !r.result) throw new Error('CDP evaluate failed: ' + JSON.stringify(r).slice(0, 200)); if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400)); return r.result.result.value; };
    const until = async (fn, ms = 6000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await H.wait(150); } return false; };

    await cdp('Emulation.setDeviceMetricsOverride', { width: 412, height: 860, deviceScaleFactor: 2, mobile: true });
    await cdp('Runtime.enable'); await cdp('Network.enable');
    await cdp('Fetch.enable', { patterns: [{ urlPattern: '*/api/send*' }, { urlPattern: '*/api/upload*' }, { urlPattern: '*generate_204*' }] });
    await cdp('Network.setCookie', { name: 'baton_m', value: encodeURIComponent(d.token), url: `http://127.0.0.1:${d.app}/` });
    await cdp('Page.enable');
    await cdp('Page.navigate', { url: `http://127.0.0.1:${d.app}/` });
    for (let i = 0; i < 60 && !(await ev(`typeof openChat === 'function' && !!document.getElementById('btn-send') && !!navigator.serviceWorker.controller`).catch(() => false)); i++) await H.wait(250);
    await H.wait(1500);
    for (let i = 0; i < 80 && Date.now() - lastNav < 3000; i++) await H.wait(250);   // the first-install reload
    for (let i = 0; i < 60 && !(await ev(`typeof openChat === 'function' && !!document.getElementById('btn-send')`).catch(() => false)); i++) await H.wait(250);
    await ev(`openChat(${JSON.stringify(id)}).catch(() => {})`);
    for (let i = 0; i < 40 && (await ev(`state.open`)) !== id; i++) await H.wait(250);
    await H.wait(800);
    const items = () => ev(`obItems.map(i => ({ state: i.state, text: i.text, next: i.next }))`);

    // 1. Network cut: the message waits, with a retry far in the future (the long backoff he sat behind).
    netUp = false;
    await ev(`(() => { obAdd(state.open, 'wake test: first message', []); obFlush(); })()`);
    check(await until(async () => (await items())[0] && (await items())[0].state === 'waiting'), 'with the network cut the message waits on the phone', await items());
    check(sends.length === 0, 'and nothing reached the PC');
    await ev(`(() => { obItems[0].next = Date.now() + 55000; obSave(); })()`);
    check((await items())[0].next - Date.now() > 50000, 'its next try is a long way off (the backoff)');

    // 2. Network back, page NOT restarted: the online event alone must send it, ignoring that wait.
    netUp = true;
    await ev(`window.dispatchEvent(new Event('online'))`);
    check(await until(() => sends.includes('wake test: first message'), 6000), 'back online: the message goes by itself, without restarting the app', sends);
    check(await until(async () => (await items()).length === 0), 'and leaves the phone queue', await items());
    check(sends.filter(t => t === 'wake test: first message').length === 1, 'exactly once');

    // 3. The same through the app being brought back to the front (visible / focus) instead of the online event.
    netUp = false;
    await ev(`(() => { obAdd(state.open, 'wake test: second message', []); obFlush(); })()`);
    check(await until(async () => (await items())[0] && (await items())[0].state === 'waiting'), 'a second message waits');
    await ev(`(() => { obItems[0].next = Date.now() + 55000; obSave(); })()`);
    netUp = true;
    await ev(`window.dispatchEvent(new Event('focus'))`);
    check(await until(() => sends.includes('wake test: second message'), 6000), 'the app coming back to the front sends it too', sends);
    await until(async () => (await items()).length === 0);

    // 4. A failed upload retries by itself when the network is back (he had to tap it).
    netUp = false;
    await ev(`(() => { window.__up = uploadOne(new File(['hello'], 'wake.png', { type: 'image/png' }), null); })()`);
    check(await until(() => ev(`state.uploads.length === 1 && state.uploads[0].failed === true`), 15000), 'with the network cut an upload ends as "failed"');
    netUp = true;
    await ev(`window.dispatchEvent(new Event('online'))`);
    check(await until(() => uploads.includes('wake.png'), 8000), 'back online: the failed upload goes again by itself', uploads);
    check(await until(() => ev(`state.uploads.length === 0 && state.attachments.some(a => a.name === 'wake.png')`), 5000), 'and is attached, with no tap');

    // 5. The 20-second check exists while anything waits.
    const src = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'public', 'app.js'), 'utf8');
    check(/setInterval\(\(\) => \{ if \(!document\.hidden && \(obItems\.some/.test(src) && /obBackoff\(it\.tries, 20000\)/.test(src), 'a waiting message is also tried every 20 s at the latest');
    check(/obFlush\(true\)/.test(src) && /force && Date\.now\(\) - obRunAt > 20000/.test(src), 'his Send now tap takes over a send that has been stuck');

    const real = errors.filter(e => !/Failed to fetch/.test(e));
    check(real.length === 0, 'no page errors', real.slice(0, 3));
  } catch (e) {
    check(false, 'the run finished', String(e && e.stack || e).slice(0, 600));
  } finally {
    try { br.kill(); } catch {}
    await H.wait(300);
    try { fs.rmSync(prof, { recursive: true, force: true }); } catch {}
    try { await d.stop(); } catch {}
    H.finish(w);
  }
})().catch(e => { console.error(e); process.exit(1); });
