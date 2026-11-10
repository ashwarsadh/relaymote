// hidden-quiet.js — 11-Nov-2026 (t1610). Ashwar: "check if there is any battery drain it is causing or maybe high processor
// usage it is causing and try to tame it." S24+ batterystats: Chrome 19% of all drain, 310 mAh of radio with the screen off,
// Relaymote its only web app. Measured on the live daemon: a hidden page's stream carried 396 KB in 2 min (11 full lists of
// ~36 KB + pings). Now: the list is sent once, then only changed rows; a page hidden for 30 s closes its stream; the
// running dot blinks by a 1 Hz class flip instead of an endless CSS animation.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const H = require('./mobile-harness');
const { check } = H;

const bin = [process.env.CHROME_BIN, 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(p => p && fs.existsSync(p));

(async () => {
  const w = H.world('hquiet');
  const d = await H.boot(w);
  try {
    // ---- 1. the stream sends the list once, then deltas
    const plain = d.stream('plain'), delta = d.stream('delta', { query: 'delta=1' });
    const firstD = await d.waitFor(delta, e => e.event === 'sessions');
    await d.waitFor(plain, e => e.event === 'sessions');
    check(firstD && Array.isArray(firstD.data.sessions) && !firstD.data.delta, 'a delta stream starts with the full list');
    // A rename in Desktop's session file changes one row of the list.
    const sf = fs.readdirSync(w.store).filter(f => f.endsWith('.json'))
      .map(f => [f, JSON.parse(fs.readFileSync(path.join(w.store, f), 'utf8'))]).sort((x, y) => (y[1].lastActivityAt || 0) - (x[1].lastActivityAt || 0))[0][0];
    const meta = JSON.parse(fs.readFileSync(path.join(w.store, sf), 'utf8'));   // the newest: re-read on every pass
    meta.title = 'Renamed for the delta check';
    const fresh = Date.now();
    fs.writeFileSync(path.join(w.store, sf + '.tmp'), JSON.stringify(meta));
    fs.renameSync(path.join(w.store, sf + '.tmp'), path.join(w.store, sf));   // as Desktop saves: the folder's mtime moves
    const p2 = await d.waitFor(plain, e => e.event === 'sessions' && e.at >= fresh, 20000);
    const d2 = await d.waitFor(delta, e => e.event === 'sessions' && e.at >= fresh, 20000);
    if (p2 && d2) {
      const full = JSON.stringify(p2.data).length, small = JSON.stringify(d2.data).length;
      check(d2.data.delta && d2.data.rows.length < p2.data.sessions.length && Array.isArray(d2.data.order) && d2.data.order.length === p2.data.sessions.length,
        'a change sends only the changed rows plus the order', { rows: d2.data.rows.length, of: p2.data.sessions.length });
      check(small < full, 'the delta is smaller than the full list', small + ' vs ' + full + ' bytes');
    } else check(false, 'a rename is pushed to both streams', { p2: !!p2, d2: !!d2 });

    // ---- 2. the page, hidden and back
    if (!bin) { console.log('skip browser part: no Edge/Chrome on this machine'); return; }
    const WebSocket = require('ws');
    const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'hquiet-'));
    const dbg = 30000 + Math.floor(Math.random() * 20000);
    const br = spawn(bin, ['--headless=new', '--remote-debugging-port=' + dbg, '--user-data-dir=' + prof, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
    try {
      let targets;
      for (let i = 0; i < 40 && !targets; i++) { await H.wait(250); try { targets = await (await fetch(`http://127.0.0.1:${dbg}/json`)).json(); } catch {} }
      const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
      await new Promise(r => ws.on('open', r));
      let n = 0; const waiting = new Map();
      ws.on('message', m => { const j = JSON.parse(m); if (j.id && waiting.has(j.id)) { waiting.get(j.id)(j); waiting.delete(j.id); } });
      const cdp = (method, params = {}) => new Promise(r => { const i = ++n; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
      const ev = async (expr) => { const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return r.result && r.result.result && r.result.result.value; };
      await cdp('Network.setCookie', { name: 'baton_m', value: encodeURIComponent(d.token), url: `http://127.0.0.1:${d.app}/` });
      await cdp('Page.navigate', { url: `http://127.0.0.1:${d.app}/` });
      for (let i = 0; i < 60 && !(await ev(`typeof openChat === 'function' && !!navigator.serviceWorker.controller`)); i++) await H.wait(250);
      await H.wait(1500);   // the first service-worker install reloads the page once
      for (let i = 0; i < 60 && !(await ev(`typeof state === 'object' && !!state.es && state.es.readyState === 1`)); i++) await H.wait(250);
      check(await ev(`state.es && state.es.url.includes('delta=1')`), 'the app asks for deltas');
      const anim = await ev(`(() => { const e = document.createElement('span'); e.className = 'dot running'; document.body.appendChild(e);
        const a = getComputedStyle(e).animationName; e.remove(); return a; })()`);
      check(anim === 'none', 'the running dot has no endless CSS animation', anim);
      const b0 = await ev(`document.body.classList.contains('blink')`); await H.wait(1100);
      check(b0 !== (await ev(`document.body.classList.contains('blink')`)), 'it blinks by a class flip once a second');

      const hid = await cdp('Runtime.evaluate', { returnByValue: true, expression: `state.sleepAfterMs = 800; Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get: () => true });
        Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get: () => 'hidden' });
        document.dispatchEvent(new Event('visibilitychange')); window.__mark = 1; document.hidden` });
      await H.wait(1500);
      const dbgS = await ev(`JSON.stringify({ es: !!state.es, slept: state.esSlept, hidden: document.hidden, t: typeof sleepStreamSoon })`);
      check(await ev(`state.es === null && state.esSlept === true`), 'hidden past the grace, the stream is closed', dbgS);
      const before = await ev(`performance.getEntriesByType('resource').length`);
      await H.wait(3000);
      const extra = await ev(`performance.getEntriesByType('resource').slice(${before}).map(e => e.name.replace(location.origin, ''))`);
      check(extra.length === 0, 'nothing is fetched while hidden', extra);

      await ev(`Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get: () => false });
        Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get: () => 'visible' });
        document.dispatchEvent(new Event('visibilitychange')); true`);
      let back = false;
      for (let i = 0; i < 20 && !back; i++) { await H.wait(250); back = await ev(`!!state.es && state.es.readyState !== 2`); }
      check(back, 'visible again, the stream reconnects');
      ws.close();
    } finally {
      br.kill();
      await H.wait(500);
      try { fs.rmSync(prof, { recursive: true, force: true }); } catch {}
    }
  } finally { await d.stop(); }
  H.finish(w);
})().catch(e => { console.error(e); process.exit(1); });
