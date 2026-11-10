// reply-select.js — 10-Nov, Ashwar: long-press words in a message, tap "Reply", type a reply to just those words; do it
// for several things, then send them all as ONE message in Claude Desktop's own reply format:
//   <!-- reply N -->
//   > the selected words
//   his reply
// The real app in a phone-sized headless browser against the daemon in a test world; /api/send is answered here, so the
// test reads exactly what the session would receive. The draft must survive the app being closed and reopened.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const H = require('./mobile-harness');
const { check } = H;

// Server half: two batches that quote the same words are told apart by his replies.
const { needleFor } = (() => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'outbox.js'), 'utf8');
  const fn = src.slice(src.indexOf('const ATTACH_LINE'), src.indexOf('\n}\n', src.indexOf('function needleFor')) + 3);
  return new Function('norm', fn + '\nreturn { needleFor };')((t) => String(t || '').replace(/\s+/g, ' ').trim());
})();
const head = '<!-- reply 1 -->\n> the same selected words, long enough to fill the whole sixty character needle\n';
check(needleFor(head + 'first answer') !== needleFor(head + 'second answer'), 'two batches quoting the same words have different delivery needles');

const bin = [process.env.CHROME_BIN, 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(p => p && fs.existsSync(p));
if (!bin) { console.log('skip: no Edge/Chrome on this machine'); process.exit(H.failures() ? 1 : 0); }

const T = (m) => '2026-11-10T09:' + String(m).padStart(2, '0') + ':00.000Z';
const MSGS = [
  { role: 'user', ts: T(0), text: 'Status of everything?' },
  { role: 'assistant', ts: T(1), text: 'The shipment left on Tuesday and the invoice goes out tomorrow.' },
  { role: 'user', ts: T(2), text: 'ok' },
  { role: 'assistant', ts: T(3), text: 'Also: the GST return is ready for review, and the bank line still does not match.' },
];
for (let i = 4; i < 20; i++) MSGS.push({ role: i % 2 ? 'assistant' : 'user', ts: T(i), text: 'Filler message number ' + i + '.' });

(async () => {
  const fake = await H.fakeDesktop();
  const w = H.world('replyselect', { settings: { cdpPort: fake.port } });
  const id = w.sessions().filter(s => !/^Migrate database/.test(s.title || '')).map(s => s.sessionId || s.id).filter(Boolean)[0];
  const d = await H.boot(w);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'replyselect-'));
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

    // Select words inside one bubble the way a long press leaves them: a DOM selection.
    const select = (ts, words) => ev(`(() => {
      const row = document.querySelector('#log [data-mts="${ts}"]'); row.scrollIntoView({ block: 'center' });
      const walk = document.createTreeWalker(row, NodeFilter.SHOW_TEXT); let node;
      while ((node = walk.nextNode())) { const i = node.data.indexOf(${JSON.stringify(words)}); if (i >= 0) {
        const r = document.createRange(); r.setStart(node, i); r.setEnd(node, i + ${words.length});
        const s = getSelection(); s.removeAllRanges(); s.addRange(r); return true; } }
      return false; })()`);
    const pill = () => ev(`(() => { const p = document.getElementById('sel-reply'); const r = p.getBoundingClientRect(); return { shown: !p.classList.contains('hidden'), top: r.top, left: r.left, right: r.right, bottom: r.bottom }; })()`);
    const pillUp = async () => { for (let i = 0; i < 20; i++) { const p = await pill(); if (p.shown) return p; await H.wait(150); } return pill(); };
    const chips = () => ev(`document.querySelectorAll('#quotes .qchip').length`);
    const type = (i, text) => ev(`(() => { const t = document.querySelector('#quotes .qnote[data-qn="${i}"]'); t.value = ${JSON.stringify(text)}; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);

    check(await select(T(1), 'left on Tuesday'), 'words in a message can be selected');
    let p = await pillUp();
    check(p.shown, 'a Reply pill appears for the selection', p);
    check(p.left >= 0 && p.right <= 412 && p.top >= 0 && p.bottom <= 860, 'and is on screen', p);
    await ev(`document.getElementById('sel-reply').click()`);
    await H.wait(200);
    check((await chips()) === 1, 'Reply adds a chip');
    check((await ev(`document.querySelector('#quotes .qchip-line').textContent`)) === 'left on Tuesday', 'quoting ONLY the selected words');
    check((await ev(`document.activeElement.classList.contains('qnote')`)), 'and puts the cursor in its own reply box');
    check(!(await pill()).shown, 'the pill goes away');
    await type(0, 'Which courier?');

    // A selection that spans two messages has no single author: no pill.
    await ev(`(() => { const a = document.querySelector('#log [data-mts="${T(1)}"]'), b = document.querySelector('#log [data-mts="${T(3)}"]');
      const r = document.createRange(); r.setStart(a.firstChild, 0); r.setEnd(b, b.childNodes.length); const s = getSelection(); s.removeAllRanges(); s.addRange(r); })()`);
    await H.wait(200); await ev(`selReplyLook()`);
    check(!(await pill()).shown, 'no pill for a selection across two messages');

    // Two more replies, one removed.
    await select(T(3), 'the GST return is ready for review'); await pillUp();
    await ev(`document.getElementById('sel-reply').click()`); await H.wait(150);
    await type(1, 'Send it to Ajay.');
    await select(T(3), 'bank line still does not match'); await pillUp();
    await ev(`document.getElementById('sel-reply').click()`); await H.wait(150);
    await type(2, 'temporary');
    check((await chips()) === 3, 'three replies queued');
    check((await ev(`document.querySelector('#quotes .qcount').textContent`)).startsWith('3 replies'), 'with the count shown');
    await ev(`document.querySelector('#quotes [data-qi="2"]').click()`);
    check((await chips()) === 2, 'the × removes one');
    await select(T(1), 'left on Tuesday'); await pillUp();
    await ev(`document.getElementById('sel-reply').click()`); await H.wait(150);
    check((await chips()) === 2, 'the same words twice are one reply');
    const shotChips = await cdp('Page.captureScreenshot', { format: 'png' });

    // The app closed and reopened (Android kills a backgrounded PWA): the batch and his words are still there.
    // Mark the old page, so open() cannot mistake it for the reloaded one on a slow machine (10-Nov flake).
    await ev('window.__stale = 1');
    await cdp('Page.reload', { ignoreCache: false });
    await H.wait(1500);
    await open();
    check((await chips()) === 2, 'the batch survives the app being closed and reopened');
    const notes = await ev(`[...document.querySelectorAll('#quotes .qnote')].map(t => t.value)`);
    check(notes[0] === 'Which courier?' && notes[1] === 'Send it to Ajay.', 'with every reply he typed', notes);
    await type(1, 'Send it to Ajay for his tick.');   // edit one

    // Send with an empty box: the chips carry his words.
    await ev(`document.getElementById('input').value = ''; send()`);
    for (let i = 0; i < 30 && !sends.length; i++) await H.wait(100);
    const wire = sends[0] || '';
    const want = '<!-- reply 1 -->\n> left on Tuesday\nWhich courier?\n\n<!-- reply 2 -->\n> the GST return is ready for review\nSend it to Ajay for his tick.';
    check(wire === want, 'ONE message, in Claude Desktop\'s reply format', wire);
    check((await chips()) === 0 && (await ev(`localStorage.getItem('baton.quotes.' + state.open)`)) === null, 'the batch clears on send');

    // Words in the box go after the blocks.
    await select(T(3), 'bank line'); await pillUp();
    await ev(`document.getElementById('sel-reply').click()`); await H.wait(150);
    await type(0, 'Check HDFC.');
    await ev(`(() => { const i = document.getElementById('input'); i.value = 'And thanks.'; i.dispatchEvent(new Event('input')); send(); })()`);
    for (let i = 0; i < 30 && sends.length < 2; i++) await H.wait(100);
    check(sends[1] === '<!-- reply 1 -->\n> bank line\nCheck HDFC.\n\nAnd thanks.', 'anything in the box follows the replies', sends[1]);

    // A reply with no words is not sent alone.
    await select(T(1), 'invoice'); await pillUp();
    await ev(`document.getElementById('sel-reply').click()`); await H.wait(150);
    await ev(`document.getElementById('input').value = ''; send()`); await H.wait(400);
    check(sends.length === 2 && (await chips()) === 1, 'a quote with no reply typed is not sent');
    await ev(`saveQuotes(state.open, []); renderQuotes()`);

    // His bubble once it is in the transcript: each selection as a quote, his reply under it, no raw markup.
    const delivered = MSGS.concat([{ role: 'user', ts: T(50), text: wire }]);
    await ev(`window.__msgs = ${JSON.stringify(delivered)}; renderLog(0, true)`);
    const b = `document.querySelector('#log .msg.user[data-mts="${T(50)}"]')`;
    await ev(`${b}.scrollIntoView({block:'center'})`);
    check((await ev(`${b}.querySelectorAll('.quote').length`)) === 2, 'his bubble draws both quotes');
    const txt = await ev(`${b}.innerText`);
    check(!txt.includes('<!--') && !txt.includes('reply 1') && !/^>/m.test(txt), 'with no raw markup showing', txt.slice(0, 200));
    check(txt.indexOf('left on Tuesday') < txt.indexOf('Which courier?') && txt.indexOf('Which courier?') < txt.indexOf('the GST return'), 'each reply under its own quote');
    const shotBubble = await cdp('Page.captureScreenshot', { format: 'png' });

    // Round trip, and Edit on a waiting batch puts it back on chips.
    const rt = await ev(`(() => { const s = splitQuotes(${JSON.stringify(wire)}); return { n: s.quotes.length, batch: s.batch, again: composeReply(s.quotes, s.body) === ${JSON.stringify(wire)} }; })()`);
    check(rt.n === 2 && rt.batch && rt.again, 'a batch splits back into its parts exactly', rt);
    await ev(`(() => { obAdd(state.open, ${JSON.stringify(wire)}, []); const it = obItems[obItems.length - 1]; it.state = 'waiting'; it.next = Date.now() + 60000; obEdit(it.cmid); })()`);
    const back = await ev(`[...document.querySelectorAll('#quotes .qnote')].map(t => t.value)`);
    check(back.length === 2 && back[1] === 'Send it to Ajay for his tick.', 'Edit on a waiting batch: back on chips with his replies', back);
    check((await ev(`deliveryNeedle(${JSON.stringify(wire)})`)).endsWith('his tick.'), 'its delivery needle is his words, not the shared opening');

    const real = errors.filter(e => !/Failed to fetch/.test(e));
    check(real.length === 0, 'no page errors', real.slice(0, 3));
    const out = process.env.REPLY_SELECT_SHOTS;
    if (out) { fs.writeFileSync(path.join(out, 'select-chips.png'), Buffer.from(shotChips.result.data, 'base64')); fs.writeFileSync(path.join(out, 'select-bubble.png'), Buffer.from(shotBubble.result.data, 'base64')); }
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

