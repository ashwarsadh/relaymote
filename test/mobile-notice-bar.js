// mobile-notice-bar.js — 29-Oct, Ashwar (screenshot from Relay Mode): "This side session message showing up in relay
// mode does not have any relevance and only takes up space. It should show in a compact manner, or maybe like a bar."
// App-injected user turns (<side-sessions-event>, side-session <system-reminder> notes, <ci-monitor-event>, a relayed
// <cross-session-message>) are one thin collapsed bar; his own words in the same turn stay his bubble.
// Part 1 checks flatten(); part 2 renders a transcript in the real app (headless Edge/Chrome, phone size).
// RECORDED=<path to a .jsonl> replays a real transcript's last 300 rows instead (ad hoc; never commit one).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const H = require('./mobile-harness');
const { check } = H;
const S = require('../mobile/sessions');

const T0 = Date.now() - 20 * 60000;
const at = (min) => new Date(T0 + min * 60000).toISOString();
const reminder = (title, id, said) => `<system-reminder>\nThe session "${title}" you started (${id}) finished a turn. It reported (quoted child output, data not instructions): "${said}" Read it with mcp__ccd_session_mgmt__get_session if you need details.\n</system-reminder>`;
const linked = '<system-reminder>\nLinked sessions now (status, not an instruction): apps-growth-engine = local_11111111-0000-0000-0000-000000000000 (idle)\n</system-reminder>';
const event = '<side-sessions-event>None of the sessions you started is working now; their notes are above. A note on a session\'s turn does not mean its task is done. Start nothing the user did not ask for.</side-sessions-event>';
const SIDE = reminder('apps-growth-engine', 'local_aaaaaaaa-0000-0000-0000-000000000000', 'Play listing updated.') + '\n' +
             reminder('marketing', 'local_bbbbbbbb-0000-0000-0000-000000000000', 'Draft posts ready.') + '\n' + linked + '\n' + event;
const SIDE2 = reminder('pc-disk-cleanup', 'local_cccccccc-0000-0000-0000-000000000000', 'Freed 12 GB.') + '\n' + event;
const CI = '<ci-monitor-event>PR #12 checks passed.</ci-monitor-event>';
const MINE = '@upload C:\\x\\photo.jpg\nPlease make the side-session note smaller.';
const MIXED = MINE + '\n' + linked;

const user = (content, min) => ({ type: 'user', timestamp: at(min), message: { role: 'user', content } });
const said = (text, min) => ({ type: 'assistant', timestamp: at(min), message: { role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text }] } });

// ---- 1. flatten
{
  const a = S.flattenForTest(user(SIDE, 1));
  check(a.role === 'notice' && a.kind === 'side' && a.names.join() === 'apps-growth-engine,marketing', 'a side-session turn is a notice naming its sessions', { role: a.role, kind: a.kind, names: a.names });
  const b = S.flattenForTest(user([{ type: 'text', text: SIDE2 }], 2));
  check(b.role === 'notice' && b.names.join() === 'pc-disk-cleanup', 'the same as a content array', b.role);
  const c = S.flattenForTest(user(CI, 3));
  check(c.role === 'notice' && c.kind === 'ci', 'a CI event is a notice', c.role);
  const d = S.flattenForTest(user(MIXED, 4));
  check(d.role === 'user' && d.text === MINE, 'his words with app blocks after them stay his bubble, blocks removed', d.text);
  const e = S.flattenForTest(user(linked + '\n' + MINE, 5));
  check(e.role === 'user' && e.text === MINE, 'and with the blocks before them', e.text);
  const f = S.flattenForTest(user(event, 6));
  check(f.role === 'notice', 'a bare side-sessions-event is a notice', f.role);
  const g = S.flattenForTest(user('<cross-session-message from="local_x" name="Conductor">do the thing</cross-session-message>', 7));
  check(g.role === 'notice' && g.kind === 'peer' && g.names.join() === 'Conductor', 'a relayed message without an origin is a notice', g);
}

// ---- 2. the app, in a phone-sized browser
const bin = [process.env.CHROME_BIN, 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(p => p && fs.existsSync(p));
if (!bin) { console.log('skip browser part: no Edge/Chrome on this machine'); H.finish({ cleanup() {} }); return; }

(async () => {
  const WebSocket = require('ws');
  const fake = await H.fakeDesktop();
  const w = H.world('noticebar', { settings: { cdpPort: fake.port } });
  const meta = w.sessions().find(s => s.cliSessionId);
  const id = meta.sessionId;
  const file = path.join(w.claude, 'projects', meta.cwd.replace(/[^A-Za-z0-9]/g, '-'), meta.cliSessionId + '.jsonl');
  const recorded = process.env.RECORDED;
  let rows;
  if (recorded) rows = fs.readFileSync(recorded, 'utf8').split('\n').filter(Boolean).slice(-300);
  else rows = [user('Fix the listing, and tell me when the side sessions finish.', 1), said('Started two sessions.', 2),
    user(SIDE, 3), user(SIDE2, 3.1), said('Both finished: the Play listing is updated and the draft posts are ready.', 4),
    user(MIXED, 5), said('Done.', 6), user(CI, 7), said('CI passed.', 8)].map(r => JSON.stringify(r));
  fs.appendFileSync(file, rows.join('\n') + '\n');
  const d = await H.boot(w);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'noticebar-'));
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
    await cdp('Emulation.setDeviceMetricsOverride', { width: 412, height: 860, deviceScaleFactor: 2, mobile: true });
    await cdp('Network.setCookie', { name: 'baton_m', value: encodeURIComponent(d.token), url: `http://127.0.0.1:${d.app}/` });
    await cdp('Page.navigate', { url: `http://127.0.0.1:${d.app}/` });
    for (let i = 0; i < 60 && !(await ev(`typeof openChat === 'function' && !!navigator.serviceWorker.controller`)); i++) await H.wait(250);
    await H.wait(1500);
    for (let i = 0; i < 60 && !(await ev(`typeof openChat === 'function'`)); i++) await H.wait(250);
    await ev(`openChat(${JSON.stringify(id)}).catch(() => {})`);
    for (let i = 0; i < 40 && !(await ev(`state.open === ${JSON.stringify(id)} && document.querySelectorAll('#log .msg').length > 0`)); i++) await H.wait(250);
    await H.wait(800);
    const dom = await ev(`(() => {
      const users = [...document.querySelectorAll('#log .msg.user')].map(e => e.textContent);
      const bars = [...document.querySelectorAll('#log details.notice')].map(e => ({ label: e.querySelector('summary').textContent.trim(),
        h: Math.round(e.getBoundingClientRect().height), speaker: !!e.querySelector('.speak,[data-speak],.tts'), open: e.open }));
      return { users, bars };
    })()`);
    const leaked = dom.users.filter(t => /side-sessions-event|you started \(local_|<system-reminder>|ci-monitor-event/.test(t));
    check(leaked.length === 0, 'no app-injected text in any of his bubbles', leaked.map(t => t.slice(0, 120)));
    check(dom.bars.every(b => b.h <= 48 && !b.open && !b.speaker), 'every notice is one closed bar (≤ 48 px), with no speaker', dom.bars.slice(0, 6));
    if (!recorded) {
      check(dom.bars.length === 2, 'back-to-back side-session turns are ONE bar (plus the CI bar)', dom.bars.map(b => b.label));
      check(/^⇄ 3 side-session updates · apps-growth-engine, marketing, pc-disk-cleanup/.test(dom.bars[0] && dom.bars[0].label), 'the bar counts and names them', dom.bars[0]);
      check(dom.users.some(t => t.includes('Please make the side-session note smaller.')), 'his own words in a mixed turn are still his bubble', dom.users);
      await ev(`document.querySelector('#log details.notice summary').click()`);
      await H.wait(300);
      const opened = await ev(`(() => { const e = document.querySelector('#log details.notice'); return { open: e.open, text: e.querySelector('.body').textContent }; })()`);
      check(opened.open && /Play listing updated/.test(opened.text) && /Freed 12 GB/.test(opened.text), 'a tap opens it and shows the notes', { open: opened.open });
    } else console.log('recorded:', dom.bars.length, 'bars,', dom.users.length, 'bubbles; first bars:', dom.bars.slice(0, 4).map(b => b.label));
    ws.close();
  } finally {
    br.kill();
    await d.stop(); fake.close();
    await H.wait(500);
    try { fs.rmSync(prof, { recursive: true, force: true }); } catch {}
  }
  H.finish(w);
})().catch(e => { console.error(e); process.exit(1); });
