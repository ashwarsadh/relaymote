// all-models.js — 16-Nov-2026. Ashwar 15-Nov: a "View all models" entry on New session that opens a searchable list of every
// model the account can start. The list is read live from Desktop's picker, its main list AND its "More models" submenu
// (lib/desktop.js listModels); no model id is written into the app. Proven in a phone-sized browser.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const H = require('./mobile-harness');
const { check } = H;
const NS = require('../mobile/newsession');

// What the picker read on 16-Nov (live probe): four in the menu, nine more in the submenu.
const MAIN = { 'Opus 5.5': 'claude-opus-5-5', 'Fable 5.2': 'claude-fable-5-2', 'Sonnet 5.5': 'claude-sonnet-5-5', 'Haiku 5.5': 'claude-haiku-5-5' };
const MORE = { 'Fable 5.1': 'claude-fable-5-1', 'Haiku 4.5': 'claude-haiku-4-5-20251001', 'Opus 4.6': 'claude-opus-4-6', 'Sonnet 4.6': 'claude-sonnet-4-6' };
const ids = { ...MAIN, ...MORE };

// ---- 1. a model from the submenu starts with ITS id
check(NS.resolveModel('Opus 4.6', ids).id === 'claude-opus-4-6', 'a "More models" label resolves to its own id');
check(NS.resolveModel('Haiku 4.5', ids).id === 'claude-haiku-4-5-20251001', 'a dated id is taken as the picker gives it');

// ---- 2. the source: listModels reads the submenu, and the alias path skips it
const dsrc = H.src('lib/desktop.js'), isrc = H.src('mobile/index.js'), app = H.src('mobile/public/app.js');
check(/more models[\s\S]{0,400}ArrowRight/i.test(dsrc) && /return \{ ok: true, models, more,/.test(dsrc),
  'listModels opens "More models" and returns its models');
// Desktop also draws the menu flat (efforts and the more models inline, live 16-Nov): a model after the efforts is "more".
check(/past=true;\s*return;/.test(dsrc) && /more:past/.test(dsrc) && /let more = models\.filter\(m => m\.more\);/.test(dsrc),
  'in the flat layout, models listed after the efforts are the more models, so New session keeps its main four');
check(/listModels\(\{ more: false \}\)/.test(dsrc), 'resolving a bare family name does not open the submenu');
check(/r\.models\.concat\(r\.more \|\| \[\]\)/.test(isrc) && /moreModels: moreVal/.test(isrc) && /more: moreVal, ids: modelIdsVal/.test(isrc),
  'the server keeps the submenu ids for starting a session and sends the list to the phone');
const code = app.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
check(!/['"]claude-(opus|sonnet|haiku|fable)-\d/.test(code), 'the phone app holds no model id of its own');

const bin = [process.env.CHROME_BIN, 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(p => p && fs.existsSync(p));
if (!bin) { console.log('skip browser part: no Edge/Chrome on this machine'); H.finish({ cleanup() {} }); return; }

(async () => {
  const w = H.world('allmodels');
  fs.mkdirSync(path.join(w.home, 'state'), { recursive: true });
  fs.writeFileSync(path.join(w.home, 'state', 'models.json'),
    JSON.stringify({ at: Date.now(), models: Object.keys(MAIN), more: Object.keys(MORE), ids }));
  const d = await H.boot(w);
  const api = (await d.req('/api/models')).json;
  check(api.more && api.more.join() === Object.keys(MORE).join() && api.ids && api.ids['Opus 4.6'] === 'claude-opus-4-6',
    '/api/models sends the submenu models and their ids', api.more);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'allmodels-'));
  const dbg = 30000 + Math.floor(Math.random() * 20000);
  const br = spawn(bin, ['--headless=new', '--remote-debugging-port=' + dbg, '--user-data-dir=' + prof, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  try {
    const WebSocket = require('ws');
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
    for (let i = 0; i < 60 && !(await ev(`typeof openNew === 'function' && !!navigator.serviceWorker.controller`)); i++) await H.wait(250);
    await H.wait(1500);
    for (let i = 0; i < 60 && !(await ev(`typeof state === 'object' && !!state.boot`)); i++) await H.wait(250);
    // 17-Nov: a fresh profile's first service-worker install reloads the page once (watchForUpdates). Under load that reload
    // commits seconds later, and the old page kept running the checks below until it was replaced (samePage false, nav
    // "reload"). Wait for a page that stays.
    for (let i = 0; i < 20; i++) {
      await ev(`window.__settle = 1; true`); await H.wait(2500);
      if (await ev(`window.__settle === 1 && typeof state === 'object' && !!state.boot`)) break;
      for (let k = 0; k < 60 && !(await ev(`typeof state === 'object' && !!state.boot`)); k++) await H.wait(250);
    }

    await ev(`window.__page = 1; openNew().catch(() => {})`);
    await H.wait(600);
    // On a failure, say what moved the page: a reload (samePage false), boot's first screen (open chat, drawer), or history.
    const btn = await ev(`(() => { const b = document.getElementById('btn-all-models'); const r = b.getBoundingClientRect();
      return { text: b.textContent, visible: !!b.offsetParent, w: r.width, right: r.right, samePage: window.__page === 1,
        nav: performance.getEntriesByType('navigation')[0].type, sheet: visibleSheetId(), chat: state.open || null,
        drawer: $('drawer').classList.contains('open'), first: window.__relaymoteFirstScreen || null, stack: navStack.length }; })()`);
    check(btn && btn.visible && btn.text === 'View all models' && btn.right <= 412, 'New session shows "View all models" on a phone screen', btn);
    await ev(`document.getElementById('btn-all-models').click(); true`);
    for (let i = 0; i < 20 && !(await ev(`document.querySelectorAll('#modellist .row').length >= 8`)); i++) await H.wait(250);
    const listed = await ev(`[...document.querySelectorAll('#modellist .row-title')].map(e => e.textContent)`);
    check(listed && Object.keys(ids).every(k => listed.includes(k)), 'the list has every model, the main four and the submenu', listed);
    check(await ev(`!document.getElementById('modelsheet').classList.contains('hidden') && document.documentElement.scrollWidth <= 412`),
      'the list opens as a sheet that fits the phone width');
    await ev(`const f = document.getElementById('model-filter'); f.value = '4.6'; f.dispatchEvent(new Event('input')); true`);
    const hits = await ev(`[...document.querySelectorAll('#modellist .row-title')].map(e => e.textContent)`);
    check(hits && hits.join() === 'Opus 4.6,Sonnet 4.6', 'typing "4.6" narrows it to the two 4.6 models', hits);
    await ev(`const g = document.getElementById('model-filter'); g.value = 'Opus 5.8'; g.dispatchEvent(new Event('input')); true`);
    const none = await ev(`document.querySelector('#modellist .empty') && document.querySelector('#modellist .empty').textContent`);
    check(none === '"Opus 5.8" is not offered on this account.', 'a model the account does not offer says so', none);
    await ev(`const h = document.getElementById('model-filter'); h.value = '4.6'; h.dispatchEvent(new Event('input')); true`);
    await ev(`[...document.querySelectorAll('#modellist .row')].find(e => e.textContent.includes('Opus 4.6')).click(); true`);
    await H.wait(800);
    const after = await ev(`({ model: state.newModel, sheet: document.getElementById('modelsheet').classList.contains('hidden'),
      newOpen: !document.getElementById('newsheet').classList.contains('hidden'),
      on: [...document.querySelectorAll('#new-model button.on')].map(b => b.textContent) })`);
    check(after && after.model === 'Opus 4.6' && after.sheet && after.newOpen && after.on.join() === 'Opus 4.6',
      'a pick closes the list, back on New session with it selected beside the main four', after);
    // Pinned first, then recent (what he last started on), then the picker's order.
    await ev(`localStorage.setItem('baton.modelRecent', JSON.stringify(['Opus 4.6'])); openAllModels(); true`);
    await H.wait(400);
    await ev(`[...document.querySelectorAll('#modellist .row')].find(e => e.dataset.name === 'Sonnet 4.6').querySelector('.model-pin').click(); true`);
    await H.wait(200);
    const order = await ev(`({ rows: [...document.querySelectorAll('#modellist .row')].map(e => e.dataset.name + ':' + e.querySelector('.row-meta').textContent), open: !document.getElementById('modelsheet').classList.contains('hidden') })`);
    check(order && order.open && /^Sonnet 4\.6:.*pinned/.test(order.rows[0]) && /^Opus 4\.6:.*recent/.test(order.rows[1]),
      'a pinned model goes to the top, his recent pick next, and pinning keeps the list open', order);
    await ev(`navBack(); openAllModels(); true`); await H.wait(400);
    const again = await ev(`[...document.querySelectorAll('#modellist .row')].map(e => e.dataset.name)`);
    check(again && again[0] === 'Sonnet 4.6' && again[1] === 'Opus 4.6', 'and it is still there next time', again);
    // 17-Nov: this test failed under load because the app's update reload fired 900 ms after a new build installed, with
    // New session open; only a busy chat box held it back. A reload now waits while any sheet is open.
    await ev(`document.querySelectorAll('.sheet:not(.hidden)').forEach(hideSheet); showSheet($('newsheet')); state.newModel = 'Opus 4.6'; window.__keep = 1; true`); await H.wait(300);
    const held = await ev(`(async () => { reloadForUpdate(); await new Promise(r => setTimeout(r, 2000));
      return { kept: window.__keep === 1, open: !document.getElementById('newsheet').classList.contains('hidden'), model: state.newModel }; })()`);
    check(held && held.kept && held.open && held.model === 'Opus 4.6', 'an update reload waits while New session is open (the pick is not lost)', held);
    ws.close();
  } finally {
    br.kill();
    await d.stop();
    await H.wait(500);
    try { fs.rmSync(prof, { recursive: true, force: true }); } catch {}
  }
  H.finish(w);
})().catch(e => { console.error(e); process.exit(1); });
