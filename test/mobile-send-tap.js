// mobile-send-tap.js — 28-Oct, Ashwar: "when I type the entire message on Relay Mode and press the send button ...
// I open the Relay Mode again and notice that the message was never sent and was just sitting inside ... make it
// more responsive." The real app in a real browser (Edge/Chrome, phone-sized, touch input over CDP) against the
// daemon in a test world. /api/send is answered by the test (CDP Fetch), so this measures the TAP, not the desktop.
// Cases: a plain tap; a tap whose finger slides (cancels a click); a tap while the keyboard closing moves the
// composer (the jump is emulated on focusout); five fast taps; a question card open; a send the PC refuses.
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
if (!bin) { console.log('skip: no Edge/Chrome on this machine'); process.exit(0); }

const PAGE_HOOK = `(() => {
  // A phone keyboard closing: focus leaves the box and the column grows by the keyboard's height, so the
  // composer (pinned to the bottom) drops. Emulated by shrinking the column while the box has focus.
  window.__pe = []; ['pointerdown','pointerup','pointercancel','click','touchstart','touchend'].forEach(k => addEventListener(k, e => window.__pe.push(k + ':' + ((e.target && e.target.id) || (e.target && e.target.tagName)) + '@' + Math.round(e.clientX || (e.changedTouches && e.changedTouches[0] && e.changedTouches[0].clientX) || 0) + ',' + Math.round(e.clientY || (e.changedTouches && e.changedTouches[0] && e.changedTouches[0].clientY) || 0)), true));
  addEventListener('focusin', e => { if (e.target.id === 'input' && window.__kb) document.documentElement.style.setProperty('--app-h', (innerHeight - 300) + 'px'); }, true);
  addEventListener('focusout', e => { if (e.target.id === 'input' && window.__kb) document.documentElement.style.setProperty('--app-h', innerHeight + 'px'); }, true);
})();`;

(async () => {
  const fake = await H.fakeDesktop();
  const w = H.world('sendtap', { settings: { cdpPort: fake.port } });
  const id = w.sessions().map(s => s.sessionId || s.id).filter(Boolean)[0];
  const d = await H.boot(w);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'sendtap-'));
  const dbg = 30000 + Math.floor(Math.random() * 20000);
  const br = spawn(bin, ['--headless=new', '--remote-debugging-port=' + dbg, '--user-data-dir=' + prof, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  try {
    let targets;
    for (let i = 0; i < 40 && !targets; i++) { await H.wait(250); try { targets = await (await fetch(`http://127.0.0.1:${dbg}/json`)).json(); } catch {} }
    const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
    await new Promise(r => ws.on('open', r));
    let n = 0; const waiting = new Map();
    // Every POST /api/send is caught at the network layer and answered here (ok, or the PC refusing).
    const sends = []; let sendMode = 'ok';
    ws.on('message', m => {
      const j = JSON.parse(m);
      if (j.id && waiting.has(j.id)) { waiting.get(j.id)(j); waiting.delete(j.id); return; }
      if (j.method === 'Fetch.requestPaused') {
        const q = j.params.request, ok = sendMode === 'ok';
        if (q.method === 'POST' && new URL(q.url).pathname === '/api/send') {
          sends.push(JSON.parse(q.postData || '{}').text);
          const body = Buffer.from(JSON.stringify(ok ? { ok: true, already: true, result: { ok: true, confirmed: true } } : { ok: false, error: 'the desktop app did not respond' })).toString('base64');
          ws.send(JSON.stringify({ id: ++n, method: 'Fetch.fulfillRequest', params: { requestId: j.params.requestId, responseCode: ok ? 200 : 500, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body } }));
        } else ws.send(JSON.stringify({ id: ++n, method: 'Fetch.continueRequest', params: { requestId: j.params.requestId } }));
      }
    });
    const cdp = (method, params = {}) => new Promise(r => { const i = ++n; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    const ev = async (expr) => { const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result && r.result.exceptionDetails) console.log('EVERR', JSON.stringify(r.result.exceptionDetails).slice(0, 300)); return r.result && r.result.result && r.result.result.value; };

    await cdp('Emulation.setDeviceMetricsOverride', { width: 412, height: 860, deviceScaleFactor: 2, mobile: true });
    await cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await cdp('Network.enable');
    await cdp('Fetch.enable', { patterns: [{ urlPattern: '*/api/send*' }] });
    await cdp('Network.setCookie', { name: 'baton_m', value: encodeURIComponent(d.token), url: `http://127.0.0.1:${d.app}/` });
    await cdp('Page.enable');
    await cdp('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_HOOK });
    let navs = 0;
    ws.on('message', m => { const j = JSON.parse(m); if (j.method === 'Page.frameNavigated' && !j.params.frame.parentId) navs++; });
    await cdp('Page.navigate', { url: `http://127.0.0.1:${d.app}/` });
    // The first visit installs the service worker; wait until it controls the page (and any reload that brings) has settled.
    for (let i = 0; i < 60 && !(await ev(`typeof openChat === 'function' && !!document.getElementById('btn-send') && !!navigator.serviceWorker.controller`)); i++) await H.wait(250);
    await H.wait(1500);
    for (let i = 0; i < 60 && !(await ev(`typeof openChat === 'function' && !!document.getElementById('btn-send')`)); i++) await H.wait(250);
    await ev(`openChat(${JSON.stringify(id)}).catch(() => {})`);
    for (let i = 0; i < 40 && (await ev(`state.open`)) !== id; i++) await H.wait(250);
    await H.wait(800);
    await ev(`window.__toasts = []; { const t0 = toast; toast = function (m) { window.__toasts.push(String(m)); return t0.apply(this, arguments); }; }`);

    const btn = async () => ev(`(() => { const r = document.getElementById('btn-send').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width }; })()`);
    const touch = (type, x, y) => cdp('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
    const tap = async ({ slide = 0 } = {}) => {
      const b = await btn();
      await touch('touchStart', b.x, b.y);
      if (slide) { for (let s = 1; s <= 4; s++) { await touch('touchMove', b.x + slide * s / 4, b.y); await H.wait(10); } }
      await H.wait(40);
      await touch('touchEnd', b.x + slide, b.y);
    };
    const type = async (text) => { await ev(`(() => { const i = document.getElementById('input'); i.focus(); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input')); })()`); };
    const after = async (want) => { for (let i = 0; i < 40 && want && sends.length < want; i++) await H.wait(100); await H.wait(700); const dbg = await ev(`JSON.stringify({ pe: window.__pe.splice(0).join(' ').slice(-240), toasts: window.__toasts.splice(0), btn: document.getElementById('btn-send').disabled, sending: state.sending })`); return { dbg, sends: sends.length, last: sends[sends.length - 1], ...(await ev(`({ box: document.getElementById('input').value, focused: document.activeElement && document.activeElement.id, ob: JSON.parse(localStorage.getItem('relaymote.outbox.v1') || '[]').length, rows: document.querySelectorAll('.msg.ob').length, failedRow: !!document.querySelector('.msg.ob .obx-now') })`)) }; };

    // Warm-up: the first touch after load can be dropped before the page takes input (seen: no pointer event at all).
    for (let i = 0; i < 3; i++) { await touch('touchStart', 200, 300); await touch('touchEnd', 200, 300); await H.wait(200); }
    check((await btn()).w >= 40, 'the composer is open with a Send button', await btn());

    await type('plain tap'); await tap();
    let s = await after(1);
    check(s.sends === 1 && s.last === 'plain tap' && s.box === '', 'one tap sends and empties the box', s);
    check(s.focused === 'input', 'focus (and so the keyboard) stays in the box after Send', s.focused);

    await type('finger slid'); await tap({ slide: 22 });
    s = await after(2);
    check(s.sends === 2 && s.last === 'finger slid' && s.box === '', 'a tap whose finger slides 22 px still sends', s);
    check(s.focused === 'input', 'focus stays in the box on the next tap too', s.focused);

    await ev(`window.__kb = true; document.getElementById('input').blur()`); await type('keyboard closing'); await tap();
    s = await after(3);
    check(s.sends === 3 && s.last === 'keyboard closing' && s.box === '', 'a tap while the keyboard is up (composer would jump on blur) sends', s);
    await ev(`window.__kb = false`);

    await type('five fast taps'); for (let i = 0; i < 5; i++) await tap();
    s = await after(4); await H.wait(800); s = await after();
    check(s.sends === 4 && s.last === 'five fast taps', 'five fast taps send it exactly once', s);

    await ev(`state.question = { id: 'q1' }`); await type('over a question'); await tap();
    s = await after();
    const label = await ev(`document.getElementById('btn-send').textContent`);
    check(s.sends === 4 && s.box === 'over a question' && label === 'Send?', 'with a question open the first tap arms the button ("Send?")', { s, label });
    await tap(); s = await after(5);
    check(s.sends === 5 && s.last === 'over a question' && s.box === '' && (await ev(`document.getElementById('btn-send').textContent`)) === '↑', 'the second tap sends and the button returns to ↑', s);
    await ev(`state.question = null`);

    sendMode = 'fail'; await type('pc refuses'); await tap();
    s = await after(6);
    check(s.sends === 6 && s.box === '' && s.ob >= 1 && s.rows >= 1, 'a refused send leaves the box and sits in the outbox, shown in the log', s);
    await H.wait(2500);
    const row = await ev(`[...document.querySelectorAll('.msg.ob .tick')].map(e => e.textContent).join(' | ')`);
    check(/waiting to send|not sent/.test(row) && /Send now|Retry/.test(row), 'the outbox row says it is not sent and offers Send now / Retry', row);
    // An update arriving while he types must not reload the page under him (the tap would be lost and the
    // draft would come back unsent).
    sendMode = 'ok'; const navBefore = navs;
    await type('typed during an update'); await ev(`reloadForUpdate()`); await H.wait(2500);
    check(navs === navBefore && (await ev(`document.getElementById('input').value`)) === 'typed during an update', 'an update while typing waits: no reload, the text stays', { navs, navBefore });
    await tap(); s = await after();
    const queued = await ev(`JSON.parse(localStorage.getItem('relaymote.outbox.v1') || '[]').some(x => x.text === 'typed during an update')`);
    // It goes behind the refused message above (one session sends in order), so it is in the outbox, not lost.
    check(s.box === '' && queued && navs === navBefore, 'and the tap takes it (queued behind the refused one)', { s, queued });
    ws.close();
  } finally {
    br.kill();
    await d.stop(); fake.close();
    await H.wait(500);
    try { fs.rmSync(prof, { recursive: true, force: true }); } catch {}
  }
  H.finish(w);
})().catch(e => { console.error(e); process.exit(1); });
