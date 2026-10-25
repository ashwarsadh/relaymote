// session-switch.js — 25-Oct (Ashwar: "switching session should instantly show me the messages ... It was showing the
// old message and later on it got updated"). Two causes: the first page carried the WHOLE >=512 KB window (2,251 rows /
// 1.7 MB for a 60-row page), and the 0.2.53 last-view cache was painted however old it was. Real server.js in a temp
// world, three sessions with ~1.5 MB of history each, and the real app in headless Edge driven over CDP.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const H = require('./mobile-harness');
const { check } = H;

const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe']
  .find(p => fs.existsSync(p));

const row = (type, content, ts) => JSON.stringify({ type, timestamp: new Date(ts).toISOString(), uuid: crypto.randomUUID(),
  message: { role: type, content } }) + '\n';
const findJsonl = (dir, cli) => {
  for (const d of fs.readdirSync(dir)) { const p = path.join(dir, d, cli + '.jsonl'); if (fs.existsSync(p)) return p; }
  return null;
};

(async () => {
  const w = H.world('switch');
  const all = w.sessions();
  const ss = all.slice(0, 3);
  const tag = ['A', 'B', 'C'];
  const files = ss.map(s => findJsonl(path.join(w.claude, 'projects'), s.cliSessionId));
  check(files.every(Boolean), 'three demo sessions with transcripts');
  // ~1.5 MB of history each: turns of a question, a tool call, its result and a reply.
  const t0 = Date.now() - 6 * 3600e3;
  files.forEach((f, k) => {
    let s = '', t = t0;
    for (let i = 0; i < 700; i++) {
      s += row('user', `${tag[k]}-old question ${i}`, t += 1000);
      s += row('assistant', [{ type: 'tool_use', id: `t${k}_${i}`, name: 'Grep', input: { pattern: 'x'.repeat(200) } }], t += 1000);
      s += row('user', [{ type: 'tool_result', tool_use_id: `t${k}_${i}`, content: 'y'.repeat(1500) }], t += 1000);
      s += row('assistant', [{ type: 'text', text: `${tag[k]}-old reply ${i} ` + 'z'.repeat(300) }], t += 1000);
    }
    s += row('assistant', [{ type: 'text', text: `NEWEST-${tag[k]}` }], Date.now() - 60000);
    fs.appendFileSync(f, s);
  });

  // A fourth: a long autonomous run, 600 tool steps with no typed message (live: 731 rows / 582 KB went for one page).
  const longRun = findJsonl(path.join(w.claude, 'projects'), all[3].cliSessionId);
  { let s = '', t = t0; for (let i = 0; i < 600; i++) {
      s += row('assistant', [{ type: 'text', text: 'step ' + i }, { type: 'tool_use', id: 'r' + i, name: 'Bash', input: { command: 'q'.repeat(400) } }], t += 1000);
      s += row('user', [{ type: 'tool_result', tool_use_id: 'r' + i, content: 'p'.repeat(400) }], t += 1000); }
    fs.appendFileSync(longRun, s); }

  const d = await H.boot(w);
  let edge = null;
  try {
    // The first page is the tail it needs, not the whole window, and "load earlier" joins it without a gap.
    const r = await d.req('/api/session/' + encodeURIComponent(ss[0].sessionId) + '?limit=60');
    const tr = r.json.transcript;
    const bytes = JSON.stringify(r.json).length;
    check(bytes < 200 * 1024 && tr.messages.length < 120, 'the first page is small (was the whole 512 KB+ window)', { bytes, rows: tr.messages.length });
    check(/NEWEST-A/.test(tr.messages[tr.messages.length - 1].text || ''), 'and ends with the newest message');
    check(tr.hasMore && tr.startByte > 0, 'more is available above it', { startByte: tr.startByte });
    const r2 = await d.req('/api/session/' + encodeURIComponent(ss[0].sessionId) + '?limit=60&before=' + tr.startByte);
    const older = r2.json.transcript.messages;
    const lastOlder = older[older.length - 1], firstPage = tr.messages[0];
    check(lastOlder && lastOlder.ts < firstPage.ts && Date.parse(firstPage.ts) - Date.parse(lastOlder.ts) <= 1000,
      '"load earlier" continues exactly where the page starts (no gap, no repeat)', { lastOlder: lastOlder && lastOlder.ts, first: firstPage.ts });

    const lr = (await d.req('/api/session/' + encodeURIComponent(all[3].sessionId) + '?limit=60')).json.transcript;
    check(lr.messages.length <= 150 && lr.hasMore, 'a long run with no typed message still sends at most 150 rows', lr.messages.length);

    if (!EDGE) { console.log('skip headless switch: no Edge on this machine'); return; }
    const cdpPort = 9400 + Math.floor(Math.random() * 400);
    const prof = path.join(w.dir, 'edge');
    edge = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${prof}`, 'about:blank'], { stdio: 'ignore', windowsHide: true });
    let target = null;
    for (let i = 0; i < 60 && !target; i++) {
      await H.wait(250);
      try { target = (await H.request(cdpPort, '/json/list')).json.find(t => t.type === 'page'); } catch {}
    }
    check(!!target, 'headless Edge is up');
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((ok, no) => { ws.once('open', ok); ws.once('error', no); });
    let n = 0, lastNav = 0; const waiting = new Map();
    ws.on('message', m => { const j = JSON.parse(m);
      if (process.env.SW_DEBUG && j.method === 'Network.responseReceived' && j.params.response.url.includes('/api/') && (1) && /./.test(j.params.response.url) && (j.params.response.status >= 400 || !/json|event-stream/.test(j.params.response.mimeType))) console.log('net:', j.params.response.status, j.params.response.mimeType, j.params.response.url.slice(0, 120));
      if (j.method === 'Page.frameNavigated' && !j.params.frame.parentId) lastNav = Date.now();
      if (waiting.has(j.id)) { waiting.get(j.id)(j); waiting.delete(j.id); } });
    const cdp = (method, params = {}) => new Promise(ok => { const id = ++n; waiting.set(id, ok); ws.send(JSON.stringify({ id, method, params })); });
    const ev = async (expr) => { const j = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (!(j.result && j.result.result) || j.result.exceptionDetails || j.result.result.value === undefined) console.log('cdp:', JSON.stringify(j).slice(0, 400)); return j.result && j.result.result ? j.result.result.value : undefined; };

    await cdp('Page.enable');
    if (process.env.SW_DEBUG) await cdp('Network.enable');
    await cdp('Page.navigate', { url: `http://127.0.0.1:${d.app}/?k=${encodeURIComponent(d.token)}` });
    let ready = false;
    // The first visit installs the service worker, which reloads the page once: wait until it has settled.
    for (let i = 0; i < 120; i++) {
      await H.wait(250);
      ready = Date.now() - lastNav > 3000 && await ev(`typeof openChat === 'function' && !!(state.sessions || []).length`);
      if (ready) break;
    }
    check(ready, 'the app loaded its session list');

    // Open a session and watch the log every 15 ms: when does its newest message appear, and was anything older shown first?
    const open = async (k, want) => ev(`(async () => {
      const t = performance.now(), seen = [];
      openChat(${JSON.stringify(ss[k].sessionId)});
      for (;;) {
        const txt = document.getElementById('log').textContent;
        if (/${tag[k]}-old/.test(txt)) seen.push(/${want}/.test(txt));
        if (/${want}/.test(txt)) return { ms: Math.round(performance.now() - t), staleFirst: seen.some(x => !x) };
        if (performance.now() - t > 5000) return { ms: -1, staleFirst: seen.some(x => !x) };
        await new Promise(r => setTimeout(r, 15));
      }
    })()`);
    for (const k of [0, 1, 2, 0, 2, 1]) {
      const o = await open(k, 'NEWEST-' + tag[k]);
      check(o && o.ms >= 0 && o.ms <= 1000 && !o.staleFirst, `switch to ${tag[k]}: its newest message shows in ${o && o.ms} ms, nothing older first`, o);
    }
    // A reply lands in A while he is elsewhere; coming back after the cached view has gone stale must not show it without.
    await H.wait(500);
    fs.appendFileSync(files[0], row('assistant', [{ type: 'text', text: 'NEWEST-A2 the long final reply' }], Date.now()));
    await H.wait(11000);
    const o = await open(0, 'NEWEST-A2');
    check(o && o.ms >= 0 && o.ms <= 1000 && !o.staleFirst, `back to A after a reply landed there: the reply shows in ${o && o.ms} ms, the old view is never painted`, o);
    ws.close();
  } finally {
    try { if (edge) edge.kill(); } catch {}
    await d.stop();
  }
  H.finish(w);
})().catch(e => { console.error(e); process.exit(1); });
