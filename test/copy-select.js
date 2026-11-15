// copy-select.js — 15-Nov, Ashwar: "Relay mode does not have a feature to copy an entire message. And when I try to select
// a message and drag up and down, my starting cursor gets moved and it selects all."
//   1. ⧉ Copy on every message (his and Claude's) copies the whole message; "Copied" shows; the clipboard reads it back.
//   2. A selection begun in one bubble stays in that bubble when the drag runs past it (up or down, into other messages
//      or the gaps between them), and a reply landing mid-selection neither rebuilds the log nor drops the selection.
// The real app in a phone-sized headless browser against the daemon in a test world.
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

const T = (m) => '2026-11-10T09:' + String(m).padStart(2, '0') + ':00.000Z';
const LONG = 'First line of a long answer about the shipment and the courier.\n\nSecond paragraph: the invoice goes out tomorrow, the GST return is ready for review, and the bank line still does not match.\n\nThird paragraph: **bold words** and a list:\n- one item\n- another item';
const MSGS = [
  { role: 'user', ts: T(0), text: 'Status of everything?\nAnd the courier too.' },
  { role: 'assistant', ts: T(1), text: LONG },
  { role: 'user', ts: T(2), text: 'Please copy this whole message of mine, line one.\nLine two of mine.' },
  { role: 'assistant', ts: T(3), text: 'Also: the GST return is ready for review, and the bank line still does not match.' },
];
for (let i = 4; i < 12; i++) MSGS.push({ role: i % 2 ? 'assistant' : 'user', ts: T(i), text: 'Filler message number ' + i + '.' });

(async () => {
  const fake = await H.fakeDesktop();
  const w = H.world('copyselect', { settings: { cdpPort: fake.port } });
  const id = w.sessions().filter(s => !/^Migrate database/.test(s.title || '')).map(s => s.sessionId || s.id).filter(Boolean)[0];
  const d = await H.boot(w);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'copyselect-'));
  const dbg = 30000 + Math.floor(Math.random() * 20000);
  const br = spawn(bin, ['--headless=new', '--remote-debugging-port=' + dbg, '--user-data-dir=' + prof, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  try {
    let targets;
    for (let i = 0; i < 40 && !targets; i++) { await H.wait(250); try { targets = await (await fetch(`http://127.0.0.1:${dbg}/json`)).json(); } catch {} }
    const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
    await new Promise(r => ws.on('open', r));
    let n = 0, lastNav = 0; const waiting = new Map(), sends = [], errors = [];
    ws.on('message', m => {
      const j = JSON.parse(m);
      if (j.id && waiting.has(j.id)) { waiting.get(j.id)(j); waiting.delete(j.id); return; }
      // Headless Edge reloads the page once ~1.5 s after the first load (navigationType 'reload'; no app code path
      // fired: 11-Nov trace). Steps wait until the page has stood still for 3 s.
      if (j.method === 'Page.frameNavigated' && !j.params.frame.parentId) lastNav = Date.now();
      if (j.method === 'Runtime.exceptionThrown') errors.push(j.params.exceptionDetails.text + ' ' + ((j.params.exceptionDetails.exception || {}).description || ''));
      if (j.method === 'Fetch.requestPaused') {
        const r = j.params.request;
        if (r.method === 'POST' && new URL(r.url).pathname === '/api/send') {
          sends.push(JSON.parse(r.postData || '{}').text);
          ws.send(JSON.stringify({ id: ++n, method: 'Fetch.fulfillRequest', params: { requestId: j.params.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify({ ok: true, already: true, result: { ok: true, confirmed: true } })).toString('base64') } }));
        } else ws.send(JSON.stringify({ id: ++n, method: 'Fetch.continueRequest', params: { requestId: j.params.requestId } }));
      }
    });
    const cdp = (method, params = {}) => new Promise(r => { const i = ++n; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    // A CDP-level error (no .result: "Execution context was destroyed" while a navigation lands) is retried, not
    // read as undefined.result (10-Nov flake).
    const ev = async (expr) => { let r; for (let k = 0; k < 20; k++) { r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r && r.result) break; await H.wait(250); }
      if (!r || !r.result) throw new Error('CDP evaluate failed: ' + JSON.stringify(r && r.error || r).slice(0, 200) + ' | in: ' + expr.slice(0, 160)); if (r.result && r.result.exceptionDetails) throw new Error(((r.result.exceptionDetails.exception || {}).description || '').slice(0, 300) + ' | in: ' + expr.slice(0, 160)); return r.result.result.value; };

    await cdp('Emulation.setDeviceMetricsOverride', { width: 412, height: 860, deviceScaleFactor: 2, mobile: true });
    await cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await cdp('Runtime.enable');
    await cdp('Network.enable');
    await cdp('Fetch.enable', { patterns: [{ urlPattern: '*/api/send*' }] });
    await cdp('Network.setCookie', { name: 'baton_m', value: encodeURIComponent(d.token), url: `http://127.0.0.1:${d.app}/` });
    await cdp('Page.enable');
    const open = async () => {
      // A loaded machine can take >15 s to boot the page (10-Nov: 2 of 3 runs failed "openChat is not defined");
      // wait up to 30 s, reload once, then fail with a clear reason instead of a ReferenceError.
      const ready = async () => { for (let i = 0; i < 120; i++) { if (Date.now() - lastNav > 3000 && await ev(`!window.__stale && typeof openChat === 'function' && !!document.getElementById('btn-send')`).catch(() => false)) return true; await H.wait(250); } return false; };
      if (!(await ready())) { await ev('window.__stale = 1').catch(() => {}); await cdp('Page.reload', {}); if (!(await ready())) throw new Error('the app did not boot within 60 s'); }
      await H.wait(800);
      await ev(`openChat(${JSON.stringify(id)}).catch(() => {})`);
      for (let i = 0; i < 40 && (await ev(`state.open`).catch(() => null)) !== id; i++) await H.wait(250);
      await H.wait(800);
      await ev(`(() => { const real = renderLog; window.__msgs = ${JSON.stringify(MSGS)}; renderLog = (m, f) => real(window.__msgs, f); renderLog(0, true); })()`);
      await H.wait(200);
    };
    await cdp('Page.navigate', { url: `http://127.0.0.1:${d.app}/` });
    await open();

    const origin = `http://127.0.0.1:${d.app}`;
    await cdp('Browser.grantPermissions', { origin, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
    await cdp('Page.bringToFront');

    // ---- 1. Copy
    const nCopy = await ev(`document.querySelectorAll('#log .stamp .msg-copy').length`);
    const nStamp = await ev(`[...document.querySelectorAll('#log .stamp')].filter(s => s.querySelector('.msg-reply')).length`);
    check(nCopy > 0 && nCopy === nStamp, 'every message with a Reply button also has a Copy button', { nCopy, nStamp });
    const tap = async (sel) => {
      const r = await ev(`(() => { const b = document.querySelector(${JSON.stringify(sel)}); b.scrollIntoView({ block: 'center' }); const q = b.getBoundingClientRect(); return { x: q.left + q.width / 2, y: q.top + q.height / 2 }; })()`);
      await H.wait(150);
      await cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: r.x, y: r.y }] });
      await H.wait(60);
      await cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await H.wait(400);
    };
    const toastText = () => ev(`[...document.querySelectorAll('.toast, #toast')].map(t => t.textContent).join('|')`);
    for (const [ts, want, who] of [[T(1), MSGS[1].text, "Claude's"], [T(2), MSGS[2].text, 'his own']]) {
      await ev(`navigator.clipboard.writeText('-').catch(() => {})`);
      await tap(`#log .stamp .msg-copy[data-ts="${ts}"]`);
      const got = await ev(`navigator.clipboard.readText().catch(e => 'ERR ' + e.message)`);
      check(String(got).split('\r\n').join('\n') === want, 'a tap on Copy puts ' + who + ' whole message on the clipboard (read back)', got);
      const tt = await toastText();
      check(/Copied/.test(tt), 'and says "Copied"', tt);
    }

    // ---- 2. A drag that runs past the bubble stays inside it
    await ev(`getSelection().removeAllRanges()`);
    const pt = (ts, where) => ev(`(() => { const row = document.querySelector('#log [data-mts="${ts}"]'); row.scrollIntoView({ block: 'center' });
      const walk = document.createTreeWalker(row, NodeFilter.SHOW_TEXT); let n, first = null, last = null; while ((n = walk.nextNode())) { if (n.data.trim().length < 12) continue; first = first || n; last = n; }
      const rg = document.createRange(); const start = ${JSON.stringify(where)} === 'start'; const node = start ? first : last;
      if (start) { rg.setStart(node, 6); rg.setEnd(node, 7); } else { rg.setStart(node, Math.max(0, node.data.length - 4)); rg.setEnd(node, Math.max(1, node.data.length - 3)); }
      const q = rg.getBoundingClientRect(); return { x: q.left + 1, y: q.top + q.height / 2 }; })()`);
    const dragFrom = async (ts, to) => {
      await ev(`getSelection().removeAllRanges()`);
      const a = await pt(ts, 'start');
      await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: a.x, y: a.y, button: 'left', clickCount: 1 });
      for (const p of to) { await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'left', buttons: 1 }); await H.wait(80); }
      const last = to[to.length - 1];
      await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: last.x, y: last.y, button: 'left', clickCount: 1 });
      await H.wait(250);
      return ev(`(() => { const s = getSelection(); const row = (n) => { const e = n && (n.nodeType === 1 ? n : n.parentElement); return e && e.closest('[data-mts]'); };
        const a = row(s.anchorNode), f = row(s.focusNode); return { text: s.toString(), a: a && a.dataset.mts, f: f && f.dataset.mts }; })()`);
    };
    await cdp('Emulation.setTouchEmulationEnabled', { enabled: false });   // a mouse drag drives the same selection code
    await H.wait(200);
    const inside = await pt(T(1), 'end');
    const box = await ev(`(() => { const r = document.querySelector('#log [data-mts="${T(1)}"]').getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; })()`);
    const down = [{ x: inside.x, y: inside.y }, { x: 200, y: box.bottom + 6 }, { x: 200, y: Math.min(840, box.bottom + 200) }, { x: 300, y: 855 }];
    let r = await dragFrom(T(1), down);
    const flat = (t) => t.replace(/\*\*/g, '').replace(/^- /gm, '').replace(/\s+/g, ' ').trim();
    check(r.a === T(1) && r.f === T(1), 'dragging down past the bubble keeps both ends in that one message', r);
    check(r.text.length > 20 && flat(MSGS[1].text).includes(flat(r.text).slice(0, 40)) && !/Filler|copy this whole|Status of everything/.test(r.text), 'and selects part of it, never other messages (no select-all)', r.text.slice(0, 160));
    const up = [{ x: 100, y: box.top - 6 }, { x: 100, y: Math.max(5, box.top - 200) }, { x: 50, y: 5 }];
    r = await dragFrom(T(1), up);
    check(r.a === T(1) && r.f === T(1) && !/Status of everything|Filler/.test(r.text), 'dragging up past it does the same', r);

    // A reply landing while text is selected: the log is not rebuilt and the selection stays.
    r = await dragFrom(T(1), [{ x: inside.x, y: inside.y }]);
    const before = r.text;
    await ev(`(() => { window.__rowRef = document.querySelector('#log [data-mts="${T(1)}"]'); window.__msgs = window.__msgs.concat([{ role: 'assistant', ts: '${T(30)}', text: 'A new reply arrives.' }]); renderLog(0); })()`);
    await H.wait(300);
    const kept = await ev(`({ same: window.__rowRef === document.querySelector('#log [data-mts="${T(1)}"]'), text: getSelection().toString() })`);
    check(before.length > 10 && kept.same && kept.text === before, 'a reply arriving mid-selection does not rebuild the log or drop the selection', { before: before.slice(0, 60), kept });
    await ev(`getSelection().removeAllRanges()`); await H.wait(200);
    check(!(await ev(`document.documentElement.classList.contains('selecting')`)), 'clearing the selection makes every message selectable again');
    check(!errors.length, 'no page errors', errors);
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
