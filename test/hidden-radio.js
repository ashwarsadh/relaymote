// hidden-radio.js — 11-Nov-2026, battery: batterystats on Ashwar's S24+ put Chrome (the RelayMote PWA) top, 710 mAh in
// 7h16m, 499 of it on the mobile radio. The app kept /api/stream open while in the background: a ping every 20 s plus
// the whole session list on nearly every 2.5 s poll (lastActivityAt changes with ~30 lanes working), each one waking the
// radio. And a stream that broke on a weak signal was retried by the browser every ~3 s, forever.
// Measured here, headless, against the real daemon with sessions changing every 2 s:
//   - traffic (HTTP requests + stream messages) per hour while the page is HIDDEN, past the 30 s grace: ~0;
//   - reconnects while the stream cannot connect: exponential backoff, not a storm;
//   - back to visible: the stream and the list come straight back.
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
const SECS = Number(process.env.HIDDEN_RADIO_SECS || 60);

const jsonls = (dir) => { const out = []; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.jsonl')) out.push(p); } }; try { walk(dir); } catch {} return out; };

(async () => {
  const fake = await H.fakeDesktop();
  const w = H.world('hiddenradio', { settings: { cdpPort: fake.port } });
  const d = await H.boot(w);
  const files = jsonls(w.claude);
  // Lanes at work: a transcript grows every 2 s, so the session list keeps changing as it does on his PC.
  let k = 0;
  const churn = setInterval(() => { const f = files[k++ % files.length]; if (f) fs.appendFileSync(f, JSON.stringify({ type: 'user', uuid: 'c' + k, timestamp: new Date().toISOString(), message: { role: 'user', content: 'tick ' + k } }) + '\n'); }, 2000);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'hiddenradio-'));
  const dbg = 30000 + Math.floor(Math.random() * 20000);
  const br = spawn(bin, ['--headless=new', '--remote-debugging-port=' + dbg, '--user-data-dir=' + prof, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  try {
    let targets;
    for (let i = 0; i < 40 && !targets; i++) { await H.wait(250); try { targets = await (await fetch(`http://127.0.0.1:${dbg}/json`)).json(); } catch {} }
    const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
    await new Promise(r => ws.on('open', r));
    let n = 0; const waiting = new Map(), errors = [];
    const traffic = [];          // { at, kind, what }
    let blockStream = false, streamTries = [];
    ws.on('message', m => {
      const j = JSON.parse(m);
      if (j.id && waiting.has(j.id)) { waiting.get(j.id)(j); waiting.delete(j.id); return; }
      if (j.method === 'Runtime.exceptionThrown') errors.push(j.params.exceptionDetails.text + ' ' + ((j.params.exceptionDetails.exception || {}).description || ''));
      if (j.method === 'Network.requestWillBeSent' && /^http/.test(j.params.request.url)) traffic.push({ at: Date.now(), kind: 'req', what: new URL(j.params.request.url).pathname });
      if (j.method === 'Network.eventSourceMessageReceived') traffic.push({ at: Date.now(), kind: 'sse', what: j.params.eventName });
      if (j.method === 'Fetch.requestPaused') {
        const u = new URL(j.params.request.url);
        if (u.pathname === '/api/stream') streamTries.push(Date.now());
        if (blockStream && u.pathname === '/api/stream') ws.send(JSON.stringify({ id: ++n, method: 'Fetch.failRequest', params: { requestId: j.params.requestId, errorReason: 'InternetDisconnected' } }));
        else ws.send(JSON.stringify({ id: ++n, method: 'Fetch.continueRequest', params: { requestId: j.params.requestId } }));
      }
    });
    const cdp = (method, params = {}) => new Promise(r => { const i = ++n; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    const ev = async (expr) => { let r; for (let q = 0; q < 20; q++) { r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r && r.result) break; await H.wait(250); }
      if (!r || !r.result || r.result.exceptionDetails) throw new Error('evaluate failed: ' + JSON.stringify(r).slice(0, 300)); return r.result.result.value; };

    await cdp('Emulation.setDeviceMetricsOverride', { width: 412, height: 860, deviceScaleFactor: 2, mobile: true });
    await cdp('Runtime.enable');
    await cdp('Network.enable');
    await cdp('Fetch.enable', { patterns: [{ urlPattern: '*/api/stream*' }] });
    await cdp('Network.setCookie', { name: 'baton_m', value: encodeURIComponent(d.token), url: `http://127.0.0.1:${d.app}/` });
    await cdp('Page.enable');
    // The page's visibility is ours to set: a phone app going to the background is document.hidden + visibilitychange.
    await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `
      window.__hid = false;
      Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get() { return window.__hid; } });
      Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get() { return window.__hid ? 'hidden' : 'visible'; } });
      window.__setHidden = (h) => { window.__hid = h; document.dispatchEvent(new Event('visibilitychange')); if (!h) window.dispatchEvent(new Event('pageshow')); };` });
    await cdp('Page.navigate', { url: `http://127.0.0.1:${d.app}/` });
    for (let i = 0; i < 160 && !(await ev(`typeof connectStream === 'function' && !!state.es`).catch(() => false)); i++) await H.wait(250);
    await H.wait(3000);

    const count = (from, to) => traffic.filter(t => t.at >= from && t.at < to);
    const perHour = (list, secs) => Math.round(list.length * 3600 / secs);

    // 1. Visible, for reference.
    let t0 = Date.now(); await H.wait(20000);
    const vis = count(t0, Date.now());
    console.log(`       visible: ${vis.length} in 20 s (${perHour(vis, 20)}/h): ${[...new Set(vis.map(x => x.kind + ':' + x.what))].join(', ')}`);

    // 2. Hidden: after a short grace nothing should reach the radio.
    await ev('__setHidden(true)');
    await H.wait(35000);   // the stream sleeps 30 s after the page is hidden (0.2.176)
    t0 = Date.now(); await H.wait(SECS * 1000);
    const hid = count(t0, Date.now());
    const kinds = {}; for (const x of hid) kinds[x.kind + ':' + x.what] = (kinds[x.kind + ':' + x.what] || 0) + 1;
    console.log(`       hidden:  ${hid.length} in ${SECS} s (${perHour(hid, SECS)}/h): ${JSON.stringify(kinds)}`);
    check(perHour(hid, SECS) <= 60, `hidden: at most one wake a minute (${perHour(hid, SECS)}/h)`, kinds);
    check(!(await ev('!!(state.es && state.es.readyState !== 2)')), 'hidden: the stream is closed');

    // 3. Visible again: stream and list are back at once.
    const back = Date.now();
    await ev('__setHidden(false)');
    for (let i = 0; i < 40 && !(await ev('!!(state.es && state.es.readyState === 1)')); i++) await H.wait(250);
    check(await ev('!!(state.es && state.es.readyState === 1)'), `visible again: the stream reconnects (${Date.now() - back} ms)`);
    for (let i = 0; i < 40 && !count(back, Date.now()).some(x => (x.kind === 'sse' && x.what === 'sessions') || (x.kind === 'req' && x.what === '/api/sessions')); i++) await H.wait(250);
    check(count(back, Date.now()).some(x => (x.kind === 'sse' && x.what === 'sessions') || (x.kind === 'req' && x.what === '/api/sessions')), 'and the session list is fetched fresh');

    // 4. A stream that cannot connect (weak signal): exponential backoff, not a retry every 3 s.
    blockStream = true; streamTries = [];
    await ev('state.es && state.es.close(), connectStream(state.esWatch || undefined)');
    await H.wait(60000);
    const tries = streamTries.length, gaps = streamTries.slice(1).map((t, i) => Math.round((t - streamTries[i]) / 1000));
    console.log(`       unreachable 60 s: ${tries} connect attempts, gaps ${gaps.join(',')} s`);
    check(tries <= 7, `unreachable: backs off (${tries} attempts in 60 s)`, gaps);
    check(gaps.length >= 2 && gaps[gaps.length - 1] > gaps[0], 'each wait longer than the last', gaps);
    // Hidden while unreachable: no attempts at all.
    await ev('__setHidden(true)'); streamTries = []; await H.wait(30000);
    check(streamTries.length === 0, `unreachable and hidden: no attempts (${streamTries.length})`);
    blockStream = false;
    await ev('__setHidden(false)');
    for (let i = 0; i < 40 && !(await ev('!!(state.es && state.es.readyState === 1)')); i++) await H.wait(250);
    check(await ev('!!(state.es && state.es.readyState === 1)'), 'signal back + visible: connected straight away');
    check(!errors.length, 'no page errors', errors);
  } catch (e) {
    check(false, 'the run finished', String(e && e.stack || e).slice(0, 400));
  } finally {
    clearInterval(churn);
    try { br.kill(); } catch {}
    try { d.child.kill(); } catch {}
    try { fake.close && fake.close(); } catch {}
    await H.wait(500);
    try { fs.rmSync(prof, { recursive: true, force: true }); } catch {}
    w.cleanup();
  }
  console.log(H.failures() ? `\n${H.failures()} check(s) failed` : '\nall checks passed');
  process.exit(H.failures() ? 1 : 0);
})();
