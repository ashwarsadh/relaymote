// scroll-hold.js — 14-Nov-2026, Ashwar (via the Conductor): "I was reading the older messages, but as soon as some
// messages were arriving, it was scrolling down again and again automatically ... Also for the quoted messages, if I
// click on the quote, it would be possible to take to the message from where we quoted?"
// The real app in headless Edge at phone size, the real daemon, a long chat. (1) He scrolls up with his finger while
// replies keep landing: the view must never be pulled down, what he reads must not move, and a "↓ N new" pill must
// count them; tapping it takes him to the end. (2) He taps a quote whose original is older than the loaded window:
// older history is paged in and the view lands on that message, highlighted.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const crypto = require('crypto');
const H = require('./mobile-harness');
const { check } = H;
let clock = Date.parse('2026-11-14T03:00:00Z');
const row = (type, content) => JSON.stringify({ type, timestamp: new Date(clock += 1000).toISOString(), uuid: crypto.randomUUID(), message: { role: type, content } }) + '\n';
const findJsonl = (dir, cli) => { for (const d of fs.readdirSync(dir)) { const p = path.join(dir, d, cli + '.jsonl'); if (fs.existsSync(p)) return p; } return null; };
const para = (k) => `Reply ${k}. ` + 'This is an older message he is reading, long enough to fill some of a phone screen. '.repeat(4);

const bin = [process.env.CHROME_BIN, 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(p => p && fs.existsSync(p));
if (!bin) { console.log('skip: no Edge/Chrome on this machine'); process.exit(0); }

(async () => {
  const fake = await H.fakeDesktop();
  const w = H.world('scrollhold', { settings: { cdpPort: fake.port } });
  const id = w.sessions().filter(s => !/^Migrate database/.test(s.title || '')).map(s => s.sessionId || s.id).filter(Boolean)[0];
  const sess = w.sessions().find(x => (x.sessionId || x.id) === id);
  const file = findJsonl(path.join(w.claude, 'projects'), sess.cliSessionId);
  // The original he will quote, then 150 more exchanges: it is far older than the 60-row window first loaded.
  fs.appendFileSync(file, row('user', 'start') + row('assistant', [{ type: 'text', text: 'QUOTED ORIGINAL: the fabric order ships on Friday from Jaipur by road.' }]));
  for (let k = 0; k < 150; k++) fs.appendFileSync(file, row('user', 'ok ' + k) + row('assistant', [{ type: 'text', text: para(k) }]));
  fs.appendFileSync(file, row('user', 'and now?') + row('assistant', [{ type: 'text', text: 'The usual one.' }]));
  const d = await H.boot(w);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'scrollhold-'));
  const dbg = 30000 + Math.floor(Math.random() * 20000);
  const br = spawn(bin, ['--headless=new', '--remote-debugging-port=' + dbg, '--user-data-dir=' + prof, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  try {
    let targets;
    for (let i = 0; i < 40 && !targets; i++) { await H.wait(250); try { targets = await (await fetch(`http://127.0.0.1:${dbg}/json`)).json(); } catch {} }
    const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
    await new Promise(r => ws.on('open', r));
    let n = 0, lastNav = 0; const waiting = new Map();
    ws.on('message', m => {
      const j = JSON.parse(m);
      if (j.id && waiting.has(j.id)) { waiting.get(j.id)(j); waiting.delete(j.id); return; }
      if (j.method === 'Page.frameNavigated' && !j.params.frame.parentId) lastNav = Date.now();
    });
    const cdp = (method, params = {}) => new Promise(r => { const i = ++n; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    const ev = async (expr) => { let r; for (let q = 0; q < 20; q++) { r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r && r.result) break; await H.wait(250); }
      return r && r.result && r.result.result && r.result.result.value; };

    await cdp('Emulation.setDeviceMetricsOverride', { width: 412, height: 860, deviceScaleFactor: 2, mobile: true });
    await cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await cdp('Network.enable');
    await cdp('Network.setCookie', { name: 'baton_m', value: encodeURIComponent(d.token), url: `http://127.0.0.1:${d.app}/` });
    await cdp('Page.enable'); await cdp('Runtime.enable');
    await cdp('Page.navigate', { url: `http://127.0.0.1:${d.app}/` });
    // Headless Edge sometimes reloads a fresh profile's page late, after the chat was opened; open it again if so.
    for (let tries = 0; tries < 3; tries++) {
      for (let i = 0; i < 240 && !(Date.now() - lastNav > 3000 && await ev(`typeof openChat === 'function' && !!document.getElementById('btn-send')`)); i++) await H.wait(250);
      const navAt = lastNav;
      await ev(`openChat(${JSON.stringify(id)}).catch(() => {}); drawer(false)`);
      for (let i = 0; i < 40 && !(await ev(`state.open === ${JSON.stringify(id)} && /The usual one/.test(document.getElementById('log').textContent)`)); i++) await H.wait(250);
      await H.wait(2500);
      if (lastNav === navAt) break;
    }
    // His finger moving the log toward older messages. (A synthesized touch gesture does not scroll headless Edge; a wheel
    // scroll goes through the same scroll path and fires the same scroll events.)
    const swipe = async (dy) => { await cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 200, y: 450, deltaX: 0, deltaY: -dy }); };
    const gap = `(() => { const l = document.getElementById('log'); return Math.round(l.scrollHeight - l.scrollTop - l.clientHeight); })()`;
    { const g0 = await ev(gap); check(g0 < 60, 'the chat opens at its end', g0 + ' px from the end; last navigation ' + (Date.now() - lastNav) + ' ms ago'); }

    // (A) The Conductor's case. He scrolls up into OLDER pages (paged in above the 60-row tail) to read. A message typed
    // during a busy turn is written to the transcript late, stamped with when it was typed (minutes ago, before the tail's
    // first row), so the server moves it to the top of every tail it sends. The tail then never lined up with what was
    // loaded; every reply replaced the whole list, his older pages went, and the view fell to the end, again and again.
    {
      for (let i = 0; i < 40 && !((await ev(`state.messages.length`)) > 130); i++) { await swipe(1500); await H.wait(300); }
      await H.wait(1500);
      await swipe(-300); await H.wait(800);   // settle a little below the top so no further page is pulled in
      const reading = `(() => { const l = document.getElementById('log'), top = l.getBoundingClientRect().top;
        const el = [...l.querySelectorAll('.msg')].find(e => e.getBoundingClientRect().bottom > top + 40);
        return el ? { t: el.textContent.slice(0, 40), y: Math.round(el.getBoundingClientRect().top), loaded: state.messages.length } : null; })()`;
      const r0 = await ev(reading);
      const lateTs = new Date(clock - 300000).toISOString();
      fs.appendFileSync(file, JSON.stringify({ type: 'user', timestamp: lateTs, uuid: crypto.randomUUID(), message: { role: 'user', content: 'typed while it was busy' } }) + '\n');
      for (let s = 0; s < 6; s++) { fs.appendFileSync(file, row('assistant', [{ type: 'text', text: 'conductor reply ' + s + '. ' + 'Words. '.repeat(15) }])); await H.wait(700); }
      await H.wait(1500);
      const r1 = await ev(reading);
      check(r0 && r1 && r0.loaded > 120 && r0.t === r1.t && Math.abs(r0.y - r1.y) <= 2,
        'reading older pages, a late-written message plus 6 replies do not move him (nor drop what he loaded)', { r0, r1, gap: await ev(gap) });
      await ev(`jumpToBottom()`); await H.wait(1200);
      check((await ev(gap)) < 60 && /conductor reply 5/.test(await ev(`document.getElementById('log').textContent.slice(-3000)`)), 'the pill then takes him to the newest reply');
    }

    // (0) His finger, slowly: a real touch drag off the bottom, 1 px every 40 ms for 90 px, while a working session writes
    // a reply every 300 ms. The finger spends over two seconds inside the 60 px that counted as "at the end", and every
    // reply landing in that time snapped the view back down under it. Where the log sits (scrollTop) must follow the
    // finger up, whatever lands below.
    const drag = async (px) => {
      await cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 200, y: 300 }] });
      for (let i = 1; i <= px; i++) { await cdp('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 200, y: 300 + i }] }); await H.wait(40); }
      await cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    {
      const topNow = `Math.round(document.getElementById('log').scrollTop)`;
      let j = 0; const wr = setInterval(() => fs.appendFileSync(file, row('assistant', [{ type: 'text', text: 'step reply ' + (j++) + '. ' + 'Words. '.repeat(12) }])), 300);
      let t0, t1;
      try { await H.wait(700); t0 = await ev(topNow); await drag(90); await H.wait(1500); t1 = await ev(topNow); }
      finally { clearInterval(wr); }
      check(t1 <= t0 - 60, 'a slow finger drag up while replies land is never snapped back to the end', { before: t0, after: t1, replies: j });
    }
    // (1) Replies keep landing (one every 400 ms) while he scrolls up a little at a time, as when reading.
    let k = 0; const writer = setInterval(() => fs.appendFileSync(file, row('assistant', [{ type: 'text', text: 'new reply ' + (k++) + ' while he reads. ' + 'More words. '.repeat(10) }])), 400);
    const gaps = [];
    try {
      await swipe(250);                 // the first small move off the bottom, mid-stream
      for (let s = 0; s < 6; s++) { await H.wait(700); gaps.push(await ev(gap)); await swipe(300); }
      await H.wait(800); gaps.push(await ev(gap));
    } finally { clearInterval(writer); }
    // Each reading of "how far from the end" may only grow: he moves up and new replies land below.
    const pulled = gaps.findIndex((g, i) => i && g < gaps[i - 1] - 4);
    check(gaps.every(g => g > 200) && pulled < 0, 'scrolling up while replies land, the view is never pulled back down', gaps);

    // Now he stops and reads. Note the row at the top of his screen and where it sits.
    const spot = `(() => { const l = document.getElementById('log'), top = l.getBoundingClientRect().top;
      const el = [...l.querySelectorAll('.msg')].find(e => e.getBoundingClientRect().bottom > top + 40);
      return el ? { t: el.textContent.slice(0, 40), y: Math.round(el.getBoundingClientRect().top) } : null; })()`;
    await H.wait(600);
    const before = await ev(spot);
    const k0 = k;
    for (let s = 0; s < 8; s++) { fs.appendFileSync(file, row('assistant', [{ type: 'text', text: 'later reply ' + s + '. ' + 'Words. '.repeat(30) }])); await H.wait(500); }
    await H.wait(1500);
    const after = await ev(spot);
    check(before && after && before.t === after.t && Math.abs(before.y - after.y) <= 2, 'what he is reading stays exactly where it was while 8 more replies land', { before, after });
    const pill = await ev(`(() => { const b = document.getElementById('jump'); return b && !b.hidden ? b.textContent : null; })()`);
    const m = /↓\s*(\d+)\s*new/.exec(pill || '');
    check(m && Number(m[1]) >= 8, 'a "↓ N new" pill counts the replies that landed below him', { pill, landed: k0 + 8 });
    const pr = await ev(`(() => { const r = document.getElementById('jump').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pr.x, y: pr.y }] });
    await cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await H.wait(800);
    check((await ev(gap)) < 60 && /later reply 7/.test(await ev(`document.getElementById('log').textContent.slice(-4000)`)), 'tapping the pill takes him to the newest reply');
    check(await ev(`document.getElementById('jump').hidden`), 'and the pill goes');
    // At the end, a new reply still follows him down.
    fs.appendFileSync(file, row('assistant', [{ type: 'text', text: 'final reply at the end' }]));
    for (let i = 0; i < 20 && !/final reply at the end/.test(await ev(`document.getElementById('log').textContent.slice(-2000)`)); i++) await H.wait(250);
    await H.wait(600);
    check((await ev(gap)) < 60, 'at the end, a new reply keeps the view at the end');

    // His reply quoting the old message lands at the end, as one sent from the box does.
    fs.appendFileSync(file, row('user', '> Replying to Claude (14 Nov, 08:30):\n> QUOTED ORIGINAL: the fabric order ships on Friday from Jaipur by road.\n\nwhich truck?'));
    for (let i = 0; i < 20 && !(await ev(`!!document.querySelector('#log .quote')`)); i++) await H.wait(250);
    if (!(await ev(`!!document.querySelector('#log .quote')`))) console.log('  log tail: ' + JSON.stringify(await ev(`document.getElementById('log').innerText.slice(-600)`)));
    // (2) He taps the quote in his own message; the original is 150 exchanges back, outside what is loaded.
    check(!(await ev(`/QUOTED ORIGINAL: the fabric order ships/.test([...document.querySelectorAll('#log .msg.assistant')].map(e => e.textContent).join(' '))`)), 'the quoted original is not loaded yet (older than the window)');
    const q = await ev(`(() => { const q = [...document.querySelectorAll('#log .quote')].pop(); q.scrollIntoView({ block: 'center' }); const r = q.getBoundingClientRect(); return { x: r.x + 30, y: r.y + r.height / 2 }; })()`);
    await H.wait(400);
    await cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: q.x, y: q.y }] });
    await cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    let landed = null;
    for (let i = 0; i < 60 && !landed; i++) {
      await H.wait(250);
      landed = await ev(`(() => { const l = document.getElementById('log'), lr = l.getBoundingClientRect();
        const el = [...l.querySelectorAll('.msg.assistant')].find(e => /QUOTED ORIGINAL: the fabric order ships/.test(e.textContent));
        if (!el) return null; const r = el.getBoundingClientRect();
        return (r.bottom > lr.top && r.top < lr.bottom) ? { hl: el.classList.contains('askhit'), y: Math.round(r.top - lr.top) } : null; })()`);
    }
    check(landed && landed.hl, 'tapping the quote pages in older history and lands on the original, highlighted', landed);
    await H.wait(3000);
    const still = await ev(`(() => { const l = document.getElementById('log'), lr = l.getBoundingClientRect();
      const el = [...l.querySelectorAll('.msg.assistant')].find(e => /QUOTED ORIGINAL/.test(e.textContent)); if (!el) return false; const r = el.getBoundingClientRect(); return r.bottom > lr.top && r.top < lr.bottom; })()`);
    check(still, 'and it stays there (no jump back to the end)');
    ws.close();
  } finally {
    br.kill();
    await d.stop(); fake.close();
    await H.wait(500);
    try { fs.rmSync(prof, { recursive: true, force: true }); } catch {}
  }
  H.finish(w);
})().catch(e => { console.error(e); process.exit(1); });
