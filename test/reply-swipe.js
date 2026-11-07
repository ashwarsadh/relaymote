// reply-swipe.js — swipe a message right to reply, as on WhatsApp. The real app in a real browser (phone-sized, touch input
// over CDP) against the daemon in a test world; /api/send is answered here, so this reads exactly what the session would get.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const H = require('./mobile-harness');
const { check } = H;

// The server half first: a second reply to one message must not count as delivered on sight of the first.
const { needleFor } = (() => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'outbox.js'), 'utf8');
  const fn = src.slice(src.indexOf('const ATTACH_LINE'), src.indexOf('\n}\n', src.indexOf('function needleFor')) + 3);
  return new Function('norm', fn + '\nreturn { needleFor };')((t) => String(t || '').replace(/\s+/g, ' ').trim());
})();
const q = '> Replying to Claude (6 Nov, 19:40):\n> the same quoted text, long enough to fill the whole sixty character needle\n\n';
check(needleFor(q + 'first answer') !== needleFor(q + 'second answer'), 'two replies to one message have different delivery needles');
check(needleFor('a plain message of his') === 'a plain message of his', 'a plain message keeps its needle');

const bin = [process.env.CHROME_BIN, 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(p => p && fs.existsSync(p));
if (!bin) { console.log('skip: no Edge/Chrome on this machine'); process.exit(H.failures() ? 1 : 0); }

const LONG = Array.from({ length: 40 }, (_, i) => 'Line ' + (i + 1) + ' of the long reply, with enough words to wrap on a phone.').join('\n');
const WIDE = 'Here is a table of output:\n```\n' + 'x'.repeat(400) + '\n```\nend';
const T = (m) => '2026-11-06T14:' + String(m).padStart(2, '0') + ':00.000Z';
const MSGS = [
  { role: 'user', ts: T(0), text: 'What is the status of the shipment?' },
  { role: 'assistant', ts: T(1), text: 'The shipment left on **Tuesday**.' },
  { role: 'assistant', ts: T(2) + 'x', text: 'placeholder', tools: [{ name: 'Bash', done: true }] },
  { role: 'user', ts: T(3), text: 'and the invoice?' },
  { role: 'assistant', ts: T(4), text: LONG },
  { role: 'user', ts: T(5), text: 'ok' },
  { role: 'assistant', ts: T(6), text: WIDE },
].filter(m => !m.tools);
for (let i = 7; i < 37; i++) MSGS.push({ role: i % 2 ? 'user' : 'assistant', ts: T(i), text: 'Filler message number ' + i + ' so the log can scroll.' });

(async () => {
  const fake = await H.fakeDesktop();
  const w = H.world('replyswipe', { settings: { cdpPort: fake.port } });
  const id = w.sessions().filter(s => !/^Migrate database/.test(s.title || '')).map(s => s.sessionId || s.id).filter(Boolean)[0] /* not the demo session with an open question */;
  const d = await H.boot(w);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'replyswipe-'));
  const dbg = 30000 + Math.floor(Math.random() * 20000);
  const br = spawn(bin, ['--headless=new', '--remote-debugging-port=' + dbg, '--user-data-dir=' + prof, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  try {
    let targets;
    for (let i = 0; i < 40 && !targets; i++) { await H.wait(250); try { targets = await (await fetch(`http://127.0.0.1:${dbg}/json`)).json(); } catch {} }
    const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
    await new Promise(r => ws.on('open', r));
    let n = 0; const waiting = new Map(), sends = [], errors = [];
    ws.on('message', m => {
      const j = JSON.parse(m);
      if (j.id && waiting.has(j.id)) { waiting.get(j.id)(j); waiting.delete(j.id); return; }
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
    const ev = async (expr) => { const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400)); return r.result.result.value; };

    await cdp('Emulation.setDeviceMetricsOverride', { width: 412, height: 860, deviceScaleFactor: 2, mobile: true });
    await cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await cdp('Runtime.enable');
    await cdp('Network.enable');
    await cdp('Fetch.enable', { patterns: [{ urlPattern: '*/api/send*' }] });
    await cdp('Network.setCookie', { name: 'baton_m', value: encodeURIComponent(d.token), url: `http://127.0.0.1:${d.app}/` });
    await cdp('Page.enable');
    await cdp('Page.navigate', { url: `http://127.0.0.1:${d.app}/` });
    for (let i = 0; i < 60 && !(await ev(`typeof openChat === 'function' && !!document.getElementById('btn-send') && !!navigator.serviceWorker.controller`).catch(() => false)); i++) await H.wait(250);
    await H.wait(1500);
    for (let i = 0; i < 60 && !(await ev(`typeof openChat === 'function' && !!document.getElementById('btn-send')`).catch(() => false)); i++) await H.wait(250);
    await ev(`openChat(${JSON.stringify(id)}).catch(() => {})`);
    for (let i = 0; i < 40 && (await ev(`state.open`)) !== id; i++) await H.wait(250);
    await H.wait(800);

    // The test's own conversation: every render draws it, whatever the demo world's stream brings.
    const draw = () => ev(`(() => { const real = renderLog; window.__msgs = ${JSON.stringify(MSGS)}; renderLog = (m, f) => real(window.__msgs, f); renderLog(0, true); })()`);
    await draw();
    const touch = (type, x, y) => cdp('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
    const rowAt = (ts) => ev(`(() => { const e = document.querySelector('#log [data-mts="${ts}"]'); e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.left, y: Math.max(90, Math.min(650, r.top + Math.min(r.height / 2, 300))), w: r.width, h: r.height }; })()`);
    const drag = async (x, y, dx, dy, steps = 8) => {
      await touch('touchStart', x, y); await H.wait(20);
      for (let s = 1; s <= steps; s++) { await touch('touchMove', x + dx * s / steps, y + dy * s / steps); await H.wait(16); }
      await H.wait(30); await touch('touchEnd', x + dx, y + dy); await H.wait(260);
    };
    const chips = () => ev(`document.querySelectorAll('#quotes .qchip').length`);
    for (let i = 0; i < 3; i++) { await touch('touchStart', 200, 300); await touch('touchEnd', 200, 300); await H.wait(200); }

    // Swipe and threshold.
    let r = await rowAt(T(1));
    await drag(r.x + 40, r.y, 30, 0);
    check((await chips()) === 0, 'a 30 px drag does not reply');
    check((await ev(`document.querySelector('#log [data-mts="${T(1)}"]').style.transform`)) === '', 'and the bubble goes back');
    await drag(r.x + 40, r.y, 90, 0);
    check((await chips()) === 1, 'a 90 px swipe right opens a quote chip');
    check((await ev(`document.querySelector('#quotes .qchip-line').textContent`)).includes('The shipment left'), 'the chip shows the message');
    check((await ev(`document.activeElement.id`)) === 'input', 'the box takes focus');
    check((await ev(`document.querySelector('#log [data-mts="${T(1)}"]').style.transform`)) === '', 'the bubble snaps back after the swipe');
    await drag(r.x + 40, r.y, 90, 0);
    check((await chips()) === 1, 'the same message twice is one chip');

    // What must not reply.
    await drag(r.x + 120, r.y, -90, 0);
    check((await chips()) === 1, 'a swipe left does nothing');
    await drag(10, r.y, 120, 0);
    check((await chips()) === 1, 'a swipe from the screen edge is left to the phone');
    // The gesture before this was the phone's own; a tap clears the harness's touch state first.
    await touch('touchStart', 200, 300); await touch('touchEnd', 200, 300); await H.wait(300);
    const scrolled = [];
    for (let k = 0; k < 5; k++) {
      await ev(`document.getElementById('log').scrollTop = 0`); await H.wait(120);
      // Begin on a bubble, wherever the layout has put one: the gesture under test starts there.
      const at = await ev(`(() => { for (const e of document.querySelectorAll('#log [data-mts]')) { const b = e.getBoundingClientRect(); const y = Math.max(b.top + 5, 400); if (y < Math.min(b.bottom - 5, 720)) return { x: b.left + 60, y }; } return null; })()`);
      await drag(at.x, at.y, 8, -260, 12); await H.wait(350);
      scrolled.push(await ev(`document.getElementById('log').scrollTop`));
    }
    check(scrolled.every(t => t > 40), 'a vertical drag still scrolls the log, every time', scrolled);
    check((await chips()) === 1, 'and does not reply');
    r = await rowAt(T(1));
    await drag(r.x + 60, r.y, 70, -100, 10);
    check((await chips()) === 1, 'a diagonal, mostly vertical drag does not reply');
    r = await rowAt(T(6));
    const pre = await ev(`(() => { const p = document.querySelector('#log [data-mts="${T(6)}"] pre'); const b = p.getBoundingClientRect(); return { x: b.left, y: b.top + b.height / 2, wide: p.scrollWidth > p.clientWidth }; })()`);
    await drag(pre.x + 30, pre.y, 90, 0);
    check(pre.wide && (await chips()) === 1, 'a swipe inside a sideways-scrolling code block does not reply', pre);
    check((await ev(`document.documentElement.scrollWidth <= innerWidth`)), 'nothing makes the page wider');

    // The Reply action, and a rebuild under the finger.
    r = await rowAt(T(3));
    await ev(`document.querySelector('#log .stamp[data-ts="${T(3)}"] .msg-reply').click()`);
    check((await chips()) === 2, 'the small Reply action works too, on his own message');
    check((await ev(`document.querySelectorAll('#quotes .qwho')[1].textContent`)) === 'Replying to yourself', 'and names him');
    r = await rowAt(T(4));
    await touch('touchStart', r.x + 40, r.y); await H.wait(16);
    for (let s = 1; s <= 4; s++) { await touch('touchMove', r.x + 40 + 12 * s, r.y); await H.wait(16); }
    await ev(`renderLog(0, true)`);
    for (let s = 5; s <= 8; s++) { await touch('touchMove', r.x + 40 + 12 * s, r.y); await H.wait(16); }
    await touch('touchEnd', r.x + 136, r.y); await H.wait(260);
    check((await chips()) === 3, 'a reply arriving mid-swipe does not lose it');
    check((await ev(`document.querySelector('#log [data-mts="${T(4)}"]').style.transform`)) === '', 'the rebuilt bubble is not left shifted');

    // Cancel one; survive a reload of the composer; empty box does not send.
    await ev(`document.querySelector('#quotes [data-qi="1"]').click()`);
    check((await chips()) === 2, 'the × cancels that one');
    await ev(`renderQuotes()`);
    check((await chips()) === 2, 'the chips are kept per session');
    await ev(`document.getElementById('input').value = ''; send()`);
    check(sends.length === 0 && (await chips()) === 2, 'quotes with no words are not sent');

    // The wire.
    await ev(`(() => { const i = document.getElementById('input'); i.value = 'Send me the AWB for both.'; i.dispatchEvent(new Event('input')); })()`);
    const shot1 = await cdp('Page.captureScreenshot', { format: 'png' });
    await ev(`send()`);
    for (let i = 0; i < 30 && !sends.length; i++) await H.wait(100);
    const wire = sends[0] || '';
    check(/^> Replying to Claude \(\d+ Nov, \d\d:\d\d\):\n> The shipment left on \*\*Tuesday\*\*\.\n\n> Replying to Claude \(/.test(wire), 'the session gets a blockquote per message, each naming whose', wire.slice(0, 120));
    check(wire.endsWith('\n\nSend me the AWB for both.'), 'then his words');
    check(wire.includes('> Line 40 of the long reply'), 'a long message reaches the session whole');
    check((await chips()) === 0 && (await ev(`localStorage.getItem('baton.quotes.' + state.open)`)) === null, 'the chips clear on send');

    // His bubble, while it is sending and once it is in the transcript.
    await H.wait(300);
    const delivered = MSGS.concat([{ role: 'user', ts: T(50), text: wire }]);
    await ev(`window.__msgs = ${JSON.stringify(delivered)}; renderLog(0, true)`);
    const b = `document.querySelector('#log .msg.user[data-mts="${T(50)}"]')`;
    check((await ev(`${b}.querySelectorAll('.quote').length`)) === 2, 'his bubble draws both quotes');
    check(!(await ev(`${b}.innerText`)).includes('Replying to') && !(await ev(`${b}.innerText`)).includes('>'), 'with no raw markdown showing');
    check((await ev(`${b}.innerText`)).includes('Send me the AWB'), 'and his words');
    const h = (sel) => ev(`${b}.querySelectorAll('.quote')[1].querySelector('.qtext').getBoundingClientRect().height`);
    const closed = await h();
    await ev(`${b}.scrollIntoView({block:'center'})`);
    await ev(`${b}.querySelectorAll('.quote')[1].click()`);
    const opened = await h();
    check(closed < 70 && opened > 400, 'a long quote is trimmed until tapped', { closed, opened });
    await ev(`renderLog(0, true)`);
    check((await h()) > 400, 'and stays open through a re-render');
    await ev(`${b}.scrollIntoView({block:'center'})`);
    const shot2 = await cdp('Page.captureScreenshot', { format: 'png' });
    await ev(`document.querySelector('#log [data-mts="${T(50)}"] .quote').click()`);

    // Replying to a reply quotes his words, not the quotes inside it.
    await ev(`document.querySelector('#log .stamp[data-ts="${T(50)}"] .msg-reply').click()`);
    const chip = await ev(`JSON.parse(localStorage.getItem('baton.quotes.' + state.open))[0].text`);
    check(chip === 'Send me the AWB for both.', 'replying to a reply quotes only its words', chip);
    await ev(`document.querySelector('#quotes [data-qi="0"]').click()`);

    // Edit on a waiting message puts the quotes back on chips.
    await ev(`(() => { obAdd(state.open, ${JSON.stringify(wire)}, []); const it = obItems[obItems.length - 1]; it.state = 'waiting'; it.next = Date.now() + 60000; obEdit(it.cmid); })()`);
    check((await chips()) === 2 && (await ev(`document.getElementById('input').value`)) === 'Send me the AWB for both.', 'Edit on a waiting reply: quotes on chips, only his words in the box');
    await ev(`saveQuotes(state.open, []); renderQuotes(); document.getElementById('input').value = ''`);
    const rt = await ev(`(() => { const s = splitQuotes(${JSON.stringify(wire)}); return { n: s.quotes.length, body: s.body, w0: s.quotes[0].who, again: composeReply(s.quotes, s.body) === ${JSON.stringify(wire)} }; })()`);
    check(rt.n === 2 && rt.body === 'Send me the AWB for both.' && rt.w0 === 'Claude' && rt.again, 'a reply splits back into its parts exactly', rt);
    const pasted = await ev(`(() => { const s = splitQuotes('> a pasted line\\n\\nmy note'); return { n: s.quotes.length, who: s.quotes[0].who, body: s.body }; })()`);
    check(pasted.n === 1 && pasted.who === '' && pasted.body === 'my note', 'a pasted "> line" reads as a quote with no name', pasted);
    check((await ev(`splitQuotes('no quote here').quotes.length`)) === 0 && (await ev(`userBody('a > b')`)).includes('a &gt; b'), 'a message with no quote is drawn as before');

    const real = errors.filter(e => !/Failed to fetch/.test(e));   // a poll cut off by the test's own timing is not a page fault
    check(real.length === 0, 'no page errors', real.slice(0, 3));
    const out = process.env.REPLY_SWIPE_SHOTS;
    if (out) { fs.writeFileSync(path.join(out, 'chips.png'), Buffer.from(shot1.result.data, 'base64')); fs.writeFileSync(path.join(out, 'bubble.png'), Buffer.from(shot2.result.data, 'base64')); }
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
