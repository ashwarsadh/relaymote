'use strict';
const http = require('http');
const path = require('path');
const fs = require('fs');

let WebSocket = null;
try { WebSocket = require('ws'); } catch {}

function wsUrl() {
  const CDP_PORT = require('./config').get().cdpPort;
  return new Promise((res, rej) => {
    const req = http.get(`http://127.0.0.1:${CDP_PORT}/json`, r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => { try { const t = JSON.parse(d); t.length ? res(t[0].webSocketDebuggerUrl) : rej(new Error('no cdp targets')); } catch (e) { rej(e); } });
    });
    req.on('error', rej);
    req.setTimeout(4000, () => { req.destroy(new Error('cdp probe timeout')); });
  });
}

function connect(url, opts = {}) {
  const evalTimeout = Number(opts.evalTimeout) > 0 ? Number(opts.evalTimeout) : 20000;
  return new Promise((res, rej) => {
    if (!WebSocket) return rej(new Error('ws module unavailable'));
    const sock = new WebSocket(url); let id = 0; const pend = new Map();
    const timer = setTimeout(() => rej(new Error('cdp connect timeout')), 8000);
    sock.on('open', () => {
      clearTimeout(timer);
      res({
        evaluate: expr => new Promise((rs, rj) => {
          const mid = ++id; pend.set(mid, { rs, rj });
          setTimeout(() => { if (pend.has(mid)) { pend.delete(mid); rj(new Error('eval timeout')); } }, evalTimeout);
          sock.send(JSON.stringify({ id: mid, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
        }),
        close: () => { try { sock.close(); } catch {} },
      });
    });
    sock.on('message', raw => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      const p = pend.get(m.id); if (!p) return; pend.delete(m.id);
      if (m.result && m.result.exceptionDetails) return p.rj(new Error(JSON.stringify(m.result.exceptionDetails).slice(0, 200)));
      p.rs(m.result && m.result.result ? m.result.result.value : undefined);
    });
    sock.on('error', e => { clearTimeout(timer); rej(e); });
  });
}

const rEval = (wc, js) => `(async function(){const wc=process.mainModule.require('electron').webContents.fromId(${wc});return await wc.executeJavaScript(\`${js.replace(/\\/g, '\\\\').replace(/`/g, '\\`')}\`)})()`;

async function pickChat(d) {
  const raw = await d.evaluate(`(function(){const{webContents}=process.mainModule.require('electron');return JSON.stringify(webContents.getAllWebContents().map(w=>({id:w.id,url:w.getURL()})))})()`);
  if (!raw) throw new Error('no webContents');
  const wl = JSON.parse(raw);
  const candidates = wl.filter(w => (w.url || '').includes('claude.ai'));
  if (!candidates.length) throw new Error('no chat webContents');

  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await sleep(1000);
    let CID = null, best = 0;
    for (const c of candidates) {
      let n = 0;
      try { n = parseInt(await d.evaluate(rEval(c.id, `String(document.querySelectorAll('[data-row-key]').length)`)), 10) || 0; } catch {}
      if (n > best) { best = n; CID = c.id; }
    }
    if (CID !== null) {
      try {
        await d.evaluate(`(function(){ const {webContents}=process.mainModule.require('electron');
          const w=webContents.fromId(${CID}); if(w && w.setBackgroundThrottling) w.setBackgroundThrottling(false); return 1; })()`);
      } catch { }
      try {
        await d.evaluate(rEval(CID, `(function(){
          if (window.__batonActivityHooked === 2) return 1;
          window.__batonActivityHooked = 2; window.__batonLastKey = 0; window.__batonLastPointer = 0;
          var editable=function(el){
            for (var n=el, i=0; n && i<6; n=n.parentElement, i++) {
              if (n.isContentEditable) return true;
              var t=(n.tagName||'').toUpperCase();
              if (t==='INPUT' || t==='TEXTAREA') return true;
            }
            return false;
          };
          var k=function(e){ if(e.isTrusted && e.target && editable(e.target)) window.__batonLastKey=Date.now(); };
          document.addEventListener('keydown', k, true);
          document.addEventListener('input', k, true);
          document.addEventListener('compositionupdate', k, true);
          return 1; })()`));
      } catch {}
      return CID;
    }
  }
  throw new Error(
    `no webContents contains a sidebar (checked ${candidates.length}: ${candidates.map(c => (c.url || '').slice(0, 60)).join(', ')}). ` +
    'The main window may be closed or still rendering — Relaymote refuses to guess, because picking an empty preview webview would report an empty fleet.');
}

const SCRAPE_JS = `
(function(){
  var rows=Array.from(document.querySelectorAll('[data-row-key]'));
  var group='(none)', out=[], groups=[];
  rows.forEach(function(r){
    var key=r.getAttribute('data-row-key')||'';
    if(key.indexOf('label:')===0){
      if(/^label:(showmore|fetchmore)/.test(key)) return;
      var lb=r.querySelector('[data-row-main-button]')||r;
      group=(lb.textContent||'').replace(/[\\u200B-\\u200D\\uFEFF\\u00AD\\u2060\\uE000-\\uF8FF]/g,'').trim().slice(0,60)||key.replace('label:','');
      groups.push({key:key,name:group});
      return;
    }
    if(key.indexOf('code:')!==0) return;
    var b=r.querySelector('[data-row-main-button]');
    var status='';
    Array.from(r.querySelectorAll('[aria-label]')).forEach(function(e){
      var l=(e.getAttribute('aria-label')||'').trim();
      if(!status && /^(idle|running|awaiting input|unread|browser open|archived|error)/i.test(l)) status=l;
    });
    out.push({
      id:key.replace('code:',''),
      title:b?(b.textContent||'').trim().replace(/^Running\\s+/,'').slice(0,90):'',
      status:status,
      awaiting:/awaiting input/i.test(status),
      running:/^running/i.test(status),
      unread:/^unread/i.test(status),
      errored:/^error/i.test(status),
      archived:/^archived/i.test(status),
      group:group
    });
  });
  var blocker=null;
  var dl=document.querySelectorAll('[role=dialog],[role=alertdialog]');
  for(var q=0;q<dl.length;q++){
    var c=dl[q];
    if(!(c.offsetWidth||c.offsetHeight)) continue;
    var ct=((c.innerText)||'').split(String.fromCharCode(10)).join(' ').trim();
    if(!ct) continue;
    blocker={ text:ct.slice(0,300),
      buttons:Array.prototype.slice.call(c.querySelectorAll('button'),0,6)
        .map(function(b){return (b.textContent||'').trim().slice(0,40);}).filter(Boolean) };
    break;
  }
  return JSON.stringify({sessions:out,groups:groups,blocker:blocker,active:location.href.split('/').pop()});
})()`;

async function scrapeSidebar() {
  const d = await connect(await wsUrl());
  try {
    const CID = await pickChat(d);
    const raw = await d.evaluate(rEval(CID, SCRAPE_JS));
    if (!raw) throw new Error('sidebar scrape returned nothing');
    return decorateGroups(JSON.parse(raw));
  } finally { d.close(); }
}

let uiChain = Promise.resolve();
function serializeUi(fn) {
  const next = uiChain.then(() => fn());
  uiChain = next.then(() => {}, () => {});
  return next;
}

async function cdpAvailable() {
  try { await wsUrl(); return true; } catch { return false; }
}

function projectSlugMap() {
  const map = new Map();
  const root = path.join(require('./config').CLAUDE_HOME, 'projects');
  let dirs = [];
  try { dirs = fs.readdirSync(root); } catch { return map; }
  for (const d of dirs) {
    let files = [];
    try { files = fs.readdirSync(path.join(root, d)); } catch { continue; }
    for (const f of files) {
      if (f.endsWith('.jsonl')) map.set(f.slice(0, -6), d);
    }
  }
  return map;
}

function buildCwdMap(agents) {
  const out = new Map();
  const slugs = projectSlugMap();
  for (const [sid, slug] of slugs) out.set(sid, { cwd: null, slug });
  for (const a of agents || []) {
    if (!a || !a.sessionId) continue;
    const prev = out.get(a.sessionId) || {};
    out.set(a.sessionId, { cwd: a.cwd || prev.cwd || null, slug: prev.slug || null });
  }
  return out;
}

const CWD_CACHE = path.join(require('./config').STATE, 'cwd-cache.json');
function loadCwdCache() {
  try { return JSON.parse(fs.readFileSync(CWD_CACHE, 'utf8')) || {}; } catch { return {}; }
}
function saveCwdCache(map) {
  try {
    fs.mkdirSync(path.dirname(CWD_CACHE), { recursive: true });
    const tmp = CWD_CACHE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(map, null, 2));
    fs.renameSync(tmp, CWD_CACHE);
  } catch {}
}
function syncCwd(pairs) {
  const cache = loadCwdCache();
  let added = 0;
  for (const p of pairs || []) {
    if (!p || !p.sessionId || !p.cwd) continue;
    if (cache[p.sessionId] !== p.cwd) added++;
    cache[p.sessionId] = p.cwd;
  }
  saveCwdCache(cache);
  return { added, total: Object.keys(cache).length };
}

function lookupCwd(map, sessionId) {
  const cache = loadCwdCache();
  const cached = cache[sessionId] || cache[String(sessionId).replace(/^local_/, '')];
  const fromMap = (map && (map.get(sessionId) || map.get(String(sessionId).replace(/^local_/, '')))) || {};
  return { cwd: cached || fromMap.cwd || null, slug: fromMap.slug || null };
}

function cwdMatches(session, needle) {
  if (!needle) return true;
  const norm = s => String(s || '').toLowerCase().replace(/[\\/\s_]+/g, '-');
  const q = norm(needle);
  return norm(session.cwd).includes(q) || norm(session.projectSlug).includes(q);
}

const ARCHIVE_RULES = {
  idleDays: 7,
  requireNotRunning: true,
  requireNotAwaiting: true,
  requireRead: true,
};

function mergeSessions(mcpSessions, sidebar) {
  const dots = new Map();
  if (sidebar && Array.isArray(sidebar.sessions)) for (const s of sidebar.sessions) dots.set(s.id, s);

  const now = Date.now();
  const merged = (mcpSessions || []).map(m => {
    const d = dots.get(m.sessionId) || {};
    const idleMs = m.lastActivityAt ? now - Date.parse(m.lastActivityAt) : null;
    const idleDays = idleMs == null ? null : +(idleMs / 86400000).toFixed(2);
    const awaiting = !!d.awaiting;
    const running = m.isRunning || !!d.running;
    const unread = !!d.unread;
    const archived = !!m.isArchived || !!d.archived;

    let state = 'idle';
    if (archived) state = 'archived';
    else if (awaiting) state = 'awaiting_input';
    else if (unread) state = 'unread';
    else if (running) state = 'running';

    const archivable =
      !archived &&
      (!ARCHIVE_RULES.requireNotRunning || !running) &&
      (!ARCHIVE_RULES.requireNotAwaiting || !awaiting) &&
      (!ARCHIVE_RULES.requireRead || !unread) &&
      idleDays != null && idleDays >= ARCHIVE_RULES.idleDays;

    return {
      sessionId: m.sessionId,
      title: m.title,
      cwd: m.cwd,
      group: d.group || '(unknown)',
      state, awaiting, running, unread,
      isArchived: archived,
      lastActivityAt: m.lastActivityAt,
      idleDays,
      statusDot: d.status || '',
      doNotOpen: unread || awaiting,
      archiveCandidate: archivable,
      archiveReason: archivable ? `idle ${idleDays}d · not running · no pending question · already read` : null,
    };
  });

  for (const [id, d] of dots) {
    if (!merged.some(x => x.sessionId === id)) {
      merged.push({
        sessionId: id, title: d.title, cwd: null, group: d.group,
        state: d.archived ? 'archived' : d.awaiting ? 'awaiting_input' : d.unread ? 'unread' : d.running ? 'running' : d.errored ? 'error' : 'idle',
        awaiting: !!d.awaiting, running: !!d.running, unread: !!d.unread, isArchived: !!d.archived,
        lastActivityAt: null, idleDays: null, statusDot: d.status,
        doNotOpen: !!d.unread || !!d.awaiting,
        archiveCandidate: false, archiveReason: null, sidebarOnly: true,
      });
    }
  }
  return merged;
}

function groupSessions(merged) {
  const map = new Map();
  for (const s of merged) {
    if (!map.has(s.group)) map.set(s.group, { group: s.group, sessions: [], counts: { running: 0, awaiting: 0, idle: 0, archived: 0 } });
    const g = map.get(s.group);
    g.sessions.push(s);
    if (g.counts[s.state] != null) g.counts[s.state]++;
    else g.counts.idle++;
  }
  return [...map.values()].sort((a, b) => (b.counts.awaiting - a.counts.awaiting) || (b.counts.running - a.counts.running) || a.group.localeCompare(b.group));
}

function needsAttention(merged) {
  return merged.filter(s => s.state === 'awaiting_input');
}

async function waitFor(conn, CID, bodyJs, opts = {}) {
  const timeout = opts.timeout || 2000;
  const interval = opts.interval || 10;
  try {
    return (await conn.evaluate(rEval(CID, `
      (async function(){
        var deadline=Date.now()+${timeout};
        for(;;){
          var v;
          try { v=(function(){ ${bodyJs} })(); } catch(e){ v=''; }
          if(v) return v;
          if(Date.now()>deadline) return '';
          await new Promise(function(r){setTimeout(r,${interval});});
        }
      })()`))) || '';
  } catch { return ''; }
}

async function openRowMenuLive(conn, CID, sessionId, handleVar, opts = {}) {
  const waits = opts.waits || [0, 250, 700, 1500, 3000];
  const H = JSON.stringify(String(handleVar));
  let detail = 'no attempt made';
  for (let attempt = 0; attempt < waits.length; attempt++) {
    if (waits[attempt]) await sleep(waits[attempt]);
    const _t = Date.now();
    const _m = (l) => { if (process.env.RELAYMOTE_TIMING) console.error('      [menu] a' + attempt + ' ' + l + ' +' + (Date.now() - _t) + 'ms'); };

    await closeMenus(conn, CID, { noEscape: !!opts.noEscape });
    _m('prime');

    await conn.evaluate(rEval(CID, `
      (function(){
        Array.from(document.querySelectorAll('[role="menu"]')).forEach(function(m){ m.setAttribute('data-baton-stale','1'); });
        return 1;
      })()`));

    const opened = await conn.evaluate(rEval(CID, `
      (function(){
        var r=document.querySelector('[data-row-key="code:${sessionId}"]');
        if(!r) return 'no-row';
        r.scrollIntoView({block:'center',behavior:'instant'});
        var rr=r.getBoundingClientRect();
        var o={bubbles:true,clientX:rr.left+rr.width/2,clientY:rr.top+rr.height/2};
        ['pointerenter','pointerover','pointermove'].forEach(function(t){ r.dispatchEvent(new PointerEvent(t,o)); });
        ['mouseenter','mouseover','mousemove'].forEach(function(t){ r.dispatchEvent(new MouseEvent(t,o)); });
        var b=Array.from(r.querySelectorAll('[aria-label]')).find(function(e){return /^More options/i.test(e.getAttribute('aria-label')||'');});
        if(!b) return 'no-menu-button';
        b.click();
        window[${H}]=b;
        return 'ok';
      })()`));
    _m('click=' + opened);
    if (opened !== 'ok') {
      detail = opened;
      if (opened === 'no-row') await revealRow(conn, CID, sessionId, { maxSteps: 12 });
      continue;
    }

    let menuId = await waitFor(conn, CID,
      `var b=window[${H}]; return (b && b.getAttribute('aria-expanded')==='true' && b.getAttribute('aria-controls'))||'';`,
      { timeout: 260 });
    _m('menuId=' + (menuId ? 'got' : 'MISS'));
    if (menuId) return { ok: true, menuId, attempts: attempt + 1 };
    detail = 'trigger never exposed aria-controls (menu did not open)';
    await closeMenus(conn, CID);
  }
  return {
    ok: false,
    error: (detail === 'no-row' || detail === 'no-menu-button') ? 'MENU_FAILED' : 'NO_LIVE_MENU',
    detail, attempts: waits.length, sessionId,
    message: detail === 'no-row'
      ? 'No sidebar row with that session id, after retrying long enough for a just-started session to mount.'
      : 'The row menu never became interactive. If this session was started seconds ago, its menu portal may still be mounting — retry shortly.',
  };
}

let _groupCache = { mtimeMs: -1, assign: new Map(), names: new Map() };
function readGroupConfig() {
  try {
    const roaming = require('./config').APPDATA;
    const file = path.join(roaming, 'Claude', 'claude_desktop_config.json');
    const st = fs.statSync(file);
    if (st.mtimeMs !== _groupCache.mtimeMs) {
      const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
      const scopes = ((cfg.preferences || {}).epitaxyPrefs || {})['dframe-group-scopes'] || {};
      const scopeList = [];
      for (const v of Object.values(scopes)) {
        if (v && (v.assignments || v.groups)) scopeList.push(v);
        else if (v && typeof v === 'object') for (const w of Object.values(v)) if (w && (w.assignments || w.groups)) scopeList.push(w);
      }
      const assign = new Map(), names = new Map();
      for (const sc of scopeList) {
        for (const g of (sc.groups || [])) if (g && g.id) names.set(String(g.id), String(g.name || g.id));
        for (const [k, g] of Object.entries(sc.assignments || {})) if (k.startsWith('code:') && g) assign.set(k.slice(5), String(g));
      }
      _groupCache = { mtimeMs: st.mtimeMs, assign, names };
    }
    return _groupCache;
  } catch { return null; }
}
function groupLabelKeyFor(sessionId) {
  const cfg = readGroupConfig();
  if (!cfg) return null;
  const g = cfg.assign.get(sessionId);
  return g ? `label:showmore:custom-${g}` : 'label:showmore:custom-ungrouped';
}

const VIEW_MENU_TEXT = { custom: 'Custom groups', state: 'State', date: 'Date', folder: 'Folder', none: 'None' };
const VIEW_FROM_TEXT = Object.fromEntries(Object.entries(VIEW_MENU_TEXT).map(([k, v]) => [v.toLowerCase(), k]));
const VIEW_FROM_LABELS_JS = `(function(){
  var keys=Array.from(document.querySelectorAll('[data-row-key^="label:"]')).map(function(r){return r.getAttribute('data-row-key')||'';});
  if(keys.some(function(k){return /^label:custom-/.test(k);})) return 'custom';
  if(keys.some(function(k){return /^label:state-/.test(k);})) return 'state';
  return '';
})()`;

async function readSidebarView(conn, CID, opts = {}) {
  const fromLabels = String(await conn.evaluate(rEval(CID, VIEW_FROM_LABELS_JS)) || '');
  if (fromLabels) return fromLabels;
  if (opts.labelsOnly) return 'unknown';
  const r = await groupByMenu(conn, CID, null);
  return r.current || 'unknown';
}

async function closeAllMenus(conn, CID) {
  for (let i = 0; i < 3; i++) {
    await closeMenus(conn, CID);
    const open = Number(await conn.evaluate(rEval(CID, `document.querySelectorAll('[role="menu"]:not([data-baton-stale])').length`))) || 0;
    if (!open) return true;
    await conn.evaluate(rEval(CID, `(function(){ document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); document.body.click(); return 1; })()`));
  }
  return !Number(await conn.evaluate(rEval(CID, `document.querySelectorAll('[role="menu"]:not([data-baton-stale])').length`)));
}

async function groupByMenu(conn, CID, select) {
  await closeAllMenus(conn, CID);
  const opened = await conn.evaluate(rEval(CID, `(function(){
    Array.from(document.querySelectorAll('[role="menu"]')).forEach(function(m){ m.setAttribute('data-baton-stale','1'); });
    var b=Array.from(document.querySelectorAll('button[aria-label]')).find(function(b){return /^Filter( [(]active[)])?$/i.test(b.getAttribute('aria-label')||'') && b.getAttribute('aria-haspopup')==='menu';});
    if(!b) return 'no-filter-button';
    document.body.click(); b.click(); return 'ok';
  })()`));
  if (opened !== 'ok') return { ok: false, error: 'NO_FILTER_BUTTON', detail: opened };
  const raw = await waitFor(conn, CID, `
    var menus=Array.from(document.querySelectorAll('[role="menu"]:not([data-baton-stale])')); if(!menus.length) return '';
    var it=null; menus.forEach(function(m){ it=it||Array.from(m.querySelectorAll('[role^="menuitem"]')).find(function(e){return /^Group by/i.test((e.textContent||'').trim());}); });
    if(!it) return '';
    if(!it.hasAttribute('data-baton-hovered')){
      it.setAttribute('data-baton-hovered','1');
      var r=it.getBoundingClientRect(); var o={bubbles:true,clientX:r.left+10,clientY:r.top+r.height/2};
      ['pointerenter','pointerover','pointermove'].forEach(function(t){ it.dispatchEvent(new PointerEvent(t,o)); });
      ['mouseenter','mouseover','mousemove'].forEach(function(t){ it.dispatchEvent(new MouseEvent(t,o)); });
      it.click();
    }
    menus=Array.from(document.querySelectorAll('[role="menu"]:not([data-baton-stale])'));
    if(menus.length<2) return '';
    var radios=Array.from(menus[menus.length-1].querySelectorAll('[role="menuitemradio"]'));
    if(!radios.length) return '';
    return JSON.stringify(radios.map(function(e){return {text:(e.textContent||'').trim(), checked:e.getAttribute('aria-checked')==='true'};}));`,
    { timeout: 2500, interval: 15 });
  let radios = [];
  try { radios = JSON.parse(raw || '[]'); } catch { radios = []; }
  if (!radios.length) { await closeAllMenus(conn, CID); return { ok: false, error: 'NO_GROUPBY_MENU' }; }
  const checked = radios.find(r => r.checked);
  const current = checked ? (VIEW_FROM_TEXT[checked.text.toLowerCase()] || checked.text) : null;
  if (!select || select === current) {
    const closed = await closeAllMenus(conn, CID);
    return { ok: true, current, selected: null, verified: true, closed };
  }
  const wantText = VIEW_MENU_TEXT[select];
  if (!wantText) { await closeAllMenus(conn, CID); return { ok: false, error: 'BAD_VIEW', detail: select, current }; }
  const clicked = await conn.evaluate(rEval(CID, `(function(){
    var menus=Array.from(document.querySelectorAll('[role="menu"]:not([data-baton-stale])')); if(!menus.length) return 'menu-gone';
    var it=Array.from(menus[menus.length-1].querySelectorAll('[role="menuitemradio"]')).find(function(e){return (e.textContent||'').trim().toLowerCase()===${JSON.stringify(wantText.toLowerCase())};});
    if(!it) return 'no-radio'; it.click(); return 'ok'; })()`));
  if (clicked !== 'ok') { await closeAllMenus(conn, CID); return { ok: false, error: 'VIEW_CLICK_FAILED', detail: clicked, current }; }
  let verified;
  if (select === 'custom' || select === 'state') {
    verified = (await waitFor(conn, CID, `return ${VIEW_FROM_LABELS_JS} === ${JSON.stringify(select)} ? '1' : '';`, { timeout: 3000, interval: 15 })) === '1';
  } else {
    verified = (await waitFor(conn, CID, `return ${VIEW_FROM_LABELS_JS} === '' ? '1' : '';`, { timeout: 3000, interval: 15 })) === '1';
  }
  const closed = await closeAllMenus(conn, CID);
  return { ok: verified, error: verified ? undefined : 'VIEW_NOT_APPLIED', current, selected: select, verified, closed };
}

async function withGroupView(conn, CID, fn, want = 'custom') {
  const before = await readSidebarView(conn, CID);
  if (before === want) return { result: await fn(), view: { before, switched: false } };
  const active = String(await conn.evaluate(rEval(CID, `location.href.split('/').pop()`)) || '');
  const sw = await groupByMenu(conn, CID, want);
  if (!sw.ok) return { result: { ok: false, error: 'VIEW_SWITCH_FAILED', detail: sw }, view: { before, switched: false } };
  let result, restored = false, activeRestored = true, attempts = 0;
  try { result = await fn(); }
  finally {
    if (before !== 'unknown') {
      for (attempts = 0; attempts < 3 && !restored; attempts++) {
        await groupByMenu(conn, CID, before);
        restored = (await readSidebarView(conn, CID, { labelsOnly: true })) === before;
      }
      if (!restored) console.error(`[sidebar] withGroupView could not restore the Group-by view to "${before}" after ${attempts} attempts`);
    } else restored = true;
    const now = String(await conn.evaluate(rEval(CID, `location.href.split('/').pop()`)) || '');
    if (now !== active && /^local_/.test(active)) {
      await routeTo(conn, CID, active, { idle: false });
      activeRestored = String(await conn.evaluate(rEval(CID, `location.href.split('/').pop()`)) || '') === active;
    }
    await closeAllMenus(conn, CID);
  }
  return { result, view: { before, switched: true, restored, restoreAttempts: attempts, activeRestored } };
}

const FILTER_ITEMS = {
  lastActivity: { itemRe: /^Last activity/i, optionRe: /^(\d+d|All)$/i },
  status:       { itemRe: /^Status/i,        optionRe: /^(Active|Archived|All)$/i },
};
async function filterMenu(conn, CID, which, wantText) {
  const spec = FILTER_ITEMS[which];
  if (!spec) return { ok: false, error: 'BAD_FILTER', detail: which };
  await closeAllMenus(conn, CID);
  const opened = await conn.evaluate(rEval(CID, `(function(){
    var b=Array.from(document.querySelectorAll('button[aria-label]')).find(function(b){return /^Filter( [(]active[)])?$/i.test(b.getAttribute('aria-label')||'') && b.getAttribute('aria-haspopup')==='menu';});
    if(!b) return 'no-filter-button';
    window.__batonFilterBtn=b; window.__batonFilterT=Date.now();
    document.body.click(); b.click(); return 'ok';
  })()`));
  if (opened !== 'ok') return { ok: false, error: 'NO_FILTER_BUTTON', detail: opened };
  const nonce = 'h' + Date.now();
  const raw = await waitFor(conn, CID, `
    try {
    var CLEAN=function(s){return String(s||'').replace(/[\\u200B-\\u200D\\uFEFF\\u00AD\\u2060\\uE000-\\uF8FF]/g,'').replace(/\\s+/g,' ').trim();};
    var b=window.__batonFilterBtn; if(!b) return '';
    if(b.getAttribute('aria-expanded')!=='true' || !b.getAttribute('aria-controls')){
      if(Date.now()-(window.__batonFilterT||0)>500 && !window.__batonFilterRe){ window.__batonFilterRe=1; b.click(); }
      return '';
    }
    var root=document.getElementById(b.getAttribute('aria-controls')); if(!root) return '';
    var it=Array.from(root.querySelectorAll('[role^="menuitem"]')).find(function(e){return ${spec.itemRe.toString()}.test(CLEAN(e.textContent));});
    if(!it) return '';
    if(it.getAttribute('data-baton-h')!==${JSON.stringify(nonce)}){
      it.setAttribute('data-baton-h',${JSON.stringify(nonce)}); it.setAttribute('data-baton-t',String(Date.now())); it.removeAttribute('data-baton-c');
      var r=it.getBoundingClientRect(); var o={bubbles:true,clientX:r.left+10,clientY:r.top+r.height/2};
      ['pointerenter','pointerover','pointermove'].forEach(function(t){ it.dispatchEvent(new PointerEvent(t,o)); });
      ['mouseenter','mouseover','mousemove'].forEach(function(t){ it.dispatchEvent(new MouseEvent(t,o)); });
    }
    var subId=it.getAttribute('aria-expanded')==='true' ? it.getAttribute('aria-controls') : null;
    var sub=subId ? document.getElementById(subId) : null;
    if(!sub){
      if(Date.now()-Number(it.getAttribute('data-baton-t')||0)>400 && !it.hasAttribute('data-baton-c')){ it.setAttribute('data-baton-c','1'); it.click(); }
      return '';
    }
    var opts=Array.from(sub.querySelectorAll('[role="menuitemradio"],[role="menuitemcheckbox"]'));
    if(!opts.length || !opts.every(function(e){ return ${spec.optionRe.toString()}.test(CLEAN(e.textContent)); })) return '';
    window.__batonFilterSub=sub;
    return JSON.stringify(opts.map(function(e){return {text:CLEAN(e.textContent), checked:e.getAttribute('aria-checked')==='true'};}));
    } catch(e) { window.__batonFilterErr=String(e && e.stack || e); return ''; }`,
    { timeout: 2500, interval: 15 });
  await conn.evaluate(rEval(CID, `(function(){ delete window.__batonFilterRe; return 1; })()`));
  let options = [];
  try { options = JSON.parse(raw || '[]'); } catch { options = []; }
  if (process.env.RELAYMOTE_DEBUG_FILTER) {
    const dbg = await conn.evaluate(rEval(CID, `JSON.stringify({expanded:(window.__batonFilterBtn||{}).getAttribute && window.__batonFilterBtn.getAttribute('aria-expanded'), controls:window.__batonFilterBtn && window.__batonFilterBtn.getAttribute('aria-controls'), err:window.__batonFilterErr||null})`));
    console.error('[filterMenu]', which, 'raw=', JSON.stringify(raw).slice(0, 200), 'page=', dbg);
  }
  if (!options.length) { await closeAllMenus(conn, CID); return { ok: false, error: 'NO_FILTER_SUBMENU', which }; }
  const checked = options.find(o => o.checked);
  const current = checked ? checked.text : null;
  if (!wantText || wantText.toLowerCase() === String(current).toLowerCase()) {
    const closed = await closeAllMenus(conn, CID);
    return { ok: true, which, current, options: options.map(o => o.text), selected: null, closed };
  }
  const clicked = await conn.evaluate(rEval(CID, `(function(){
    var CLEAN=function(s){return String(s||'').replace(/[\\u200B-\\u200D\\uFEFF\\u00AD\\u2060\\uE000-\\uF8FF]/g,'').replace(/\\s+/g,' ').trim();};
    var sub=window.__batonFilterSub; if(!sub || !document.contains(sub)) return 'submenu-gone';
    var it=Array.from(sub.querySelectorAll('[role="menuitemradio"],[role="menuitemcheckbox"]')).find(function(e){return CLEAN(e.textContent).toLowerCase()===${JSON.stringify(wantText.toLowerCase())};});
    if(!it) return 'no-option'; it.click(); return 'ok'; })()`));
  await waitFor(conn, CID, `return (window.__batonFilterBtn && window.__batonFilterBtn.getAttribute('aria-expanded')!=='true') ? '1' : '';`, { timeout: 1500, interval: 15 });
  await closeAllMenus(conn, CID);
  if (clicked !== 'ok') return { ok: false, error: 'FILTER_CLICK_FAILED', detail: clicked, which, current };
  let again = await filterMenu(conn, CID, which, null);
  if (!again.ok) { await sleep(400); again = await filterMenu(conn, CID, which, null); }
  const verified = !!(again.ok && String(again.current).toLowerCase() === wantText.toLowerCase());
  return { ok: verified, error: verified ? undefined : 'FILTER_NOT_APPLIED', which, previous: current, current: again.current, selected: wantText, verified };
}

async function settleSidebar(conn, CID, { expectIds = [], atLeast = 0, timeout = 8000 } = {}) {
  const t0 = Date.now();
  const how = await waitFor(conn, CID, `
    var ids=${JSON.stringify(expectIds)};
    var n=document.querySelectorAll('[data-row-key^="code:"]').length;
    if(ids.length && ids.every(function(id){ return !!document.querySelector('[data-row-key="code:'+id+'"]'); })) return 'ids';
    var now=Date.now();
    if(window.__batonSettleN!==n){ window.__batonSettleN=n; window.__batonSettleT=now; return ''; }
    return (n>=${Number(atLeast) || 0} && now-(window.__batonSettleT||now)>=400) ? 'stable' : '';`,
    { timeout, interval: 15 });
  await conn.evaluate(rEval(CID, `(function(){ delete window.__batonSettleN; delete window.__batonSettleT; return 1; })()`));
  const rows = Number(await conn.evaluate(rEval(CID, `document.querySelectorAll('[data-row-key^="code:"]').length`))) || 0;
  return { rows, how: how || 'timeout', ms: Date.now() - t0 };
}

async function withAllSessionsVisible(conn, CID, fn, opts = {}) {
  const read = await filterMenu(conn, CID, 'lastActivity', null);
  if (!read.ok) return { result: { ok: false, error: 'FILTER_READ_FAILED', detail: read }, visibility: { relaxed: false } };
  const before = read.current;
  if (String(before).toLowerCase() === 'all') return { result: await fn(), visibility: { before, relaxed: false } };
  const active = String(await conn.evaluate(rEval(CID, `location.href.split('/').pop()`)) || '');
  const rowsBefore = Number(await conn.evaluate(rEval(CID, `document.querySelectorAll('[data-row-key^="code:"]').length`))) || 0;
  const set = await filterMenu(conn, CID, 'lastActivity', 'All');
  if (!set.ok) return { result: { ok: false, error: 'FILTER_RELAX_FAILED', detail: set }, visibility: { before, relaxed: false } };
  const settled = await settleSidebar(conn, CID, { expectIds: opts.expectIds || [], atLeast: 1, timeout: opts.settleMs || 8000 });
  const rowsAfter = settled.rows;
  let result, restored = false, attempts = 0, activeRestored = true;
  try { result = await fn(); }
  finally {
    for (attempts = 0; attempts < 3 && !restored; attempts++) {
      const r = await filterMenu(conn, CID, 'lastActivity', before);
      restored = !!(r.ok && String(r.current).toLowerCase() === String(before).toLowerCase());
    }
    if (!restored) console.error(`[sidebar] withAllSessionsVisible could not restore Last activity to "${before}" after ${attempts} attempts`);
    const now = String(await conn.evaluate(rEval(CID, `location.href.split('/').pop()`)) || '');
    if (now !== active && /^local_/.test(active)) {
      await routeTo(conn, CID, active, { idle: false });
      activeRestored = String(await conn.evaluate(rEval(CID, `location.href.split('/').pop()`)) || '') === active;
    }
    await closeAllMenus(conn, CID);
    await settleSidebar(conn, CID, { expectIds: [], atLeast: 0, timeout: 3000 });
  }
  return { result, visibility: { before, relaxed: true, restored, restoreAttempts: attempts, activeRestored, rowsBefore, rowsAfter, settled: settled.how, settleMs: settled.ms } };
}

const SIDEBAR_PREF = path.join(require('./config').STATE, 'sidebar-pref.json');
const AUDIT_LOG = path.join(require('./config').STATE, 'master-audit.log');
const UI_VERBS = /^(SET_GROUP|START_TASK|DISMISS_TASK|ARCHIVE|RENAME|SET_MODEL|SET_EFFORT|STOP|RESUME|SEND|HEAL)/;
function readSidebarPref() { try { return JSON.parse(fs.readFileSync(SIDEBAR_PREF, 'utf8')); } catch { return null; } }
function writeSidebarPref(view, source) {
  try { fs.writeFileSync(SIDEBAR_PREF, JSON.stringify({ view, source, at: new Date().toISOString() }, null, 2)); } catch {}
}
function recentUiAction(windowMs = 5 * 60000) {
  try {
    const lines = fs.readFileSync(AUDIT_LOG, 'utf8').split('\n').slice(-300);
    const now = Date.now();
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = lines[i].match(/^\[([^\]]+)\]\s+([A-Z_]+) by (local_[0-9a-f-]+)/);
      if (!m) continue;
      const t = Date.parse(m[1]);
      if (!(now - t <= windowMs)) break;
      if (UI_VERBS.test(m[2])) return { verb: m[2], by: m[3], at: m[1] };
    }
  } catch {}
  return null;
}
async function viewSentinel(opts = {}) {
  const pref = readSidebarPref();
  const conn = await connect(await wsUrl());
  try {
    const CID = await pickChat(conn);
    const view = await readSidebarView(conn, CID, { labelsOnly: true });
    if (view === 'unknown') return { ok: true, view, action: 'none', note: 'view not readable from labels' };
    if (!pref || !pref.view) { writeSidebarPref(view, 'bootstrap'); return { ok: true, view, action: 'recorded' }; }
    if (view === pref.view) return { ok: true, view, action: 'none' };
    const recent = opts.assumeRecentAction ? { verb: 'TEST', by: 'test', at: new Date().toISOString() } : recentUiAction(opts.windowMs);
    if (!recent) { writeSidebarPref(view, 'user'); return { ok: true, view, action: 'adopted', note: 'no Relaymote UI action in the window, so this is the user\'s own choice' }; }
    if (opts.idle !== false && !idle.isIdle(idleMinMs())) return { ok: true, view, action: 'deferred', reason: 'user active', cause: recent };
    const r = await groupByMenu(conn, CID, pref.view);
    const now = await readSidebarView(conn, CID, { labelsOnly: true });
    await closeAllMenus(conn, CID);
    return { ok: now === pref.view, view: now, action: 'restored', from: view, to: pref.view, cause: recent, detail: r.error };
  } finally { conn.close(); }
}

function decorateGroups(snap) {
  const keys = (snap.groups || []).map(g => g.key || '');
  snap.view = keys.some(k => /^label:custom-/.test(k)) ? 'custom' : keys.some(k => /^label:state-/.test(k)) ? 'state' : 'other';
  if (snap.view === 'custom') return snap;
  const cfg = readGroupConfig();
  if (!cfg) return snap;
  for (const s of snap.sessions || []) {
    s.stateLabel = s.group;
    const g = cfg.assign.get(s.id);
    s.group = g ? (cfg.names.get(g) || g) : '(none)';
  }
  snap.sidebarGroups = snap.groups;
  snap.groups = [...cfg.names].map(([id, name]) => ({ key: 'label:custom-' + id, name }));
  snap.groupSource = 'config';
  return snap;
}
async function scrape(conn, CID) {
  return decorateGroups(JSON.parse(await conn.evaluate(rEval(CID, SCRAPE_JS))));
}

async function revealRow(conn, CID, sessionId, opts = {}) {
  const maxClicks = opts.maxSteps || 30;
  const present = async () => !!(await conn.evaluate(rEval(CID,
    `(function(){ return document.querySelector('[data-row-key="code:${sessionId}"]') ? '1' : ''; })()`)));
  if (await present()) return { found: true, revealed: false, steps: 0 };

  const exp = JSON.parse(await conn.evaluate(rEval(CID, `
    (function(){
      var done=[]; var rows0=document.querySelectorAll('[data-row-key^="code:"]').length;
      document.querySelectorAll('[data-row-key^="label:"]').forEach(function(r){
        var b=r.querySelector('[aria-expanded]');
        if(b && b.getAttribute('aria-expanded')==='false'){ b.click(); done.push(r.getAttribute('data-row-key')); }
      });
      return JSON.stringify({done:done, rows:rows0});
    })()`)) || '{"done":[],"rows":0}');
  const expanded = exp.done || [];
  if (expanded.length) {
    await waitFor(conn, CID, `return document.querySelectorAll('[data-row-key^="code:"]').length > ${Number(exp.rows) || 0} ? '1' : '';`, { timeout: 900, interval: 15 });
  }
  if (await present()) return { found: true, revealed: true, steps: 0, expandedSections: expanded };

  const view = await readSidebarView(conn, CID, { labelsOnly: true });
  const scopedKey = view === 'custom' ? groupLabelKeyFor(sessionId) : view === 'state' ? 'label:showmore:state-done' : null;
  let steps = 0, loadedMore = 0, scopedClicks = 0, stalled = 0;
  for (; steps < maxClicks; steps++) {
    const step = JSON.parse(await conn.evaluate(rEval(CID, `
      (function(){
        var scoped=${JSON.stringify(scopedKey)};
        var more=scoped ? document.querySelector('[data-row-key="'+scoped+'"]') : null;
        var usedScoped=!!more;
        if(!more){
          var rows=Array.from(document.querySelectorAll('[data-row-key]'));
          more=rows.find(function(r){ return /^label:showmore/.test(r.getAttribute('data-row-key')||''); })
            || rows.find(function(r){ return /^label:fetchmore/.test(r.getAttribute('data-row-key')||''); });
        }
        var rows0=document.querySelectorAll('[data-row-key^="code:"]').length;
        if(!more) return JSON.stringify({clicked:false, rows:rows0});
        var b=more.querySelector('button')||more.querySelector('[data-row-main-button]')||more; b.click();
        return JSON.stringify({clicked:true, scoped:usedScoped, key:more.getAttribute('data-row-key'), rows:rows0});
      })()`)) || '{}');
    if (!step.clicked) break;
    loadedMore++; if (step.scoped) scopedClicks++;
    const grew = await waitFor(conn, CID,
      `return document.querySelectorAll('[data-row-key^="code:"]').length > ${Number(step.rows) || 0} ? '1' : '';`,
      { timeout: 1500, interval: 15 });
    if (await present()) return { found: true, revealed: true, steps: steps + 1, loadedMore, scopedClicks, expandedSections: expanded };
    if (!grew) { if (++stalled >= 2) break; } else stalled = 0;
  }

  if (expanded.length) {
    await conn.evaluate(rEval(CID, `
      (function(){
        ${JSON.stringify(expanded)}.forEach(function(k){
          var r=document.querySelector('[data-row-key="'+k+'"]');
          var b=r && r.querySelector('[aria-expanded]');
          if(b && b.getAttribute('aria-expanded')==='true') b.click();
        });
        return 1;
      })()`));
  }
  return { found: false, revealed: false, steps, loadedMore, scopedClicks, group: scopedKey, view, expandedSections: expanded };
}

const ROUTE_404_JS = `(function(){ var t=(document.body&&document.body.innerText||''); return /Page not found/i.test(t) && /Go back home/i.test(t); })()`;
async function routeRecover(conn, CID, prevHref) {
  await conn.evaluate(rEval(CID, `(function(){ try{ history.pushState({}, '', ${JSON.stringify(prevHref)}); window.dispatchEvent(new PopStateEvent('popstate', { state: {} })); }catch(e){} return 1; })()`));
  const ok = await waitFor(conn, CID, `return (location.href === ${JSON.stringify(prevHref)} && !${ROUTE_404_JS}) ? '1' : '';`, { timeout: 2000, interval: 15 });
  if (!ok) console.error('[routeTo] could not recover from the 404 route; app is on ' + prevHref);
  return !!ok;
}
async function knownToApp(conn, CID, sessionId) {
  return (await conn.evaluate(rEval(CID, `(async function(){
    var id=${JSON.stringify(sessionId)};
    if(document.querySelector('[data-row-key="code:'+id+'"]')) return 'row';
    try{
      var LS=window['claude.web'] && window['claude.web'].LocalSessions;
      if(!LS || typeof LS.getSessionList!=='function') return '';
      var l=await LS.getSessionList();
      var arr=Array.isArray(l)?l:(l&&Array.isArray(l.sessions))?l.sessions:Object.values(l||{});
      var r=arr.find(function(x){ return x && (x.sessionId===id || x.id===id); });
      return r ? (r.isArchived ? 'archived' : 'listed') : '';
    }catch(e){ return ''; }
  })()`))) || '';
}
async function routeTo(conn, CID, sessionId, opts = {}) {
  const timeout = typeof opts === 'number' ? opts : (opts.timeout || 1200);
  if (!/^local_[0-9a-f-]{36}$/i.test(String(sessionId))) return false;
  if (opts.idle !== false && !idle.isIdle(idleMinMs())) return false;
  const here = String(await conn.evaluate(rEval(CID, `location.pathname + '|' + location.href`)) || '');
  const [pathname, prevHref] = here.split('|');
  if (!/^\/epitaxy\/(local_[0-9a-f-]{36})?$/i.test(pathname)) return false;
  const known = await knownToApp(conn, CID, sessionId);
  if (known !== 'row' && known !== 'listed') return false;
  const r = await conn.evaluate(rEval(CID, `(function(){ try{
      window.__batonRouteT=Date.now();
      history.pushState({}, '', '/epitaxy/' + ${JSON.stringify(sessionId)});
      window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
      return 'ok'; }catch(e){ return 'err:'+e.message; } })()`));
  if (r !== 'ok') return false;
  const sel = await waitFor(conn, CID, `
    var id=${JSON.stringify(sessionId)};
    if(${ROUTE_404_JS}) return '404';
    if(location.href.split('/').pop()!==id) return 'lost';
    var b=document.querySelector('[data-row-key="code:'+id+'"] [data-row-main-button]');
    if(!b) return (Date.now()-(window.__batonRouteT||0))>150 ? 'norow' : '';
    return b.hasAttribute('data-selected') ? 'selected' : '';`, { timeout, interval: 15 });
  if (sel === 'selected' || sel === 'norow') {
    if (await conn.evaluate(rEval(CID, ROUTE_404_JS))) { await routeRecover(conn, CID, prevHref); return false; }
    return true;
  }
  if (sel === '404' || sel === '') await routeRecover(conn, CID, prevHref);
  return false;
}

async function findSessionRow(conn, CID, sessionId) {
  let snap = await scrape(conn, CID);
  let row = snap.sessions.find(s => s.id === sessionId);
  if (row) return { row, snap, revealed: false };
  const rev = await revealRow(conn, CID, sessionId);
  if (!rev.found) return { row: null, snap, revealed: false, searched: rev };
  snap = await scrape(conn, CID);
  row = snap.sessions.find(s => s.id === sessionId) || null;
  return { row, snap, revealed: true, searched: rev };
}

async function findRowSettling(conn, CID, sessionId, tries = 4) {
  let snap = null;
  for (let i = 0; i < tries; i++) {
    if (i) await sleep(1500);
    snap = await scrape(conn, CID);
    const row = snap.sessions.find(s => s.id === sessionId);
    if (row) return { row, snap };
  }
  return await findSessionRow(conn, CID, sessionId);
}

const ATTENTION_STATES = new Set(['awaiting_input', 'unread']);
let attentionHistory = new Map();

function confirmAttentionStates(merged) {
  const held = [];
  const seen = new Set();
  for (const m of merged) {
    if (!m || !m.sessionId) continue;
    seen.add(m.sessionId);
    const raw = m.state;
    const prev = attentionHistory.get(m.sessionId);
    attentionHistory.set(m.sessionId, raw);
    if (!ATTENTION_STATES.has(raw)) continue;
    if (prev === raw) continue;
    m.pendingAttention = raw;
    m.state = (prev && !ATTENTION_STATES.has(prev)) ? prev : 'running';
    held.push({ sessionId: m.sessionId, title: m.title, pending: raw });
  }
  for (const id of [...attentionHistory.keys()]) if (!seen.has(id)) attentionHistory.delete(id);
  return held;
}

function _resetAttentionHistory() { attentionHistory = new Map(); }

async function setGroup(sessionId, groupName, opts = {}) {
  const create = opts.create !== false;
  const T0 = Date.now(); let TL = T0;
  const mark = (label) => { if (process.env.RELAYMOTE_TIMING) { const n = Date.now(); console.error('    [timing] ' + label.padEnd(22) + (n - TL) + 'ms (total ' + (n - T0) + 'ms)'); TL = n; } };
  const conn = await connect(await wsUrl());
  const norm = v => String(v || '').replace(/[^\x20-\x7E]/g, '').replace(/[0-9]+$/, '').trim().toLowerCase();
  try {
    const CID = await pickChat(conn);
    mark('connect+pickChat');
    if (!opts._inView) {
      const view = await readSidebarView(conn, CID, { labelsOnly: true });
      if (view !== 'custom') {
        const wrapped = await withGroupView(conn, CID, () => setGroup(sessionId, groupName, { ...opts, _inView: true }));
        return { ...(wrapped.result || {}), view: wrapped.view };
      }
    }
    const { row } = await findRowSettling(conn, CID, sessionId);
    mark('findRow');
    if (!row) return { ok: false, error: 'NO_SUCH_SESSION', sessionId };
    if (norm(row.group) === norm(groupName)) return { ok: true, unchanged: true, sessionId, group: row.group };

    const menu = await openRowMenuLive(conn, CID, sessionId, '__batonBtn');
    if (!menu.ok) return menu;
    mark('openRowMenu');
    const menuId = menu.menuId;

    const hov = await conn.evaluate(rEval(CID, `
      (function(){
        var menu=document.getElementById(${JSON.stringify(String(menuId))});
        if(!menu) return 'menu-gone';
        var it=Array.from(menu.querySelectorAll('[role="menuitem"]')).find(function(e){return /Move to group/i.test(e.textContent||'');});
        if(!it) return 'no-move-item';
        var r=it.getBoundingClientRect();
        var o={bubbles:true,clientX:r.left+r.width/2,clientY:r.top+r.height/2};
        ['pointerenter','pointerover','pointermove'].forEach(function(t){ it.dispatchEvent(new PointerEvent(t,o)); });
        ['mouseenter','mouseover','mousemove'].forEach(function(t){ it.dispatchEvent(new MouseEvent(t,o)); });
        if(it.focus) it.focus();
        window.__batonMoveItem=it;
        return 'ok';
      })()`));
    mark('hoverMoveToGroup');
    if (hov !== 'ok') { await closeMenus(conn, CID, { noEscape: !!opts.noEscape }); return { ok: false, error: 'NO_MOVE_TO_GROUP', detail: hov }; }
    const subId = await waitFor(conn, CID,
      `var it=window.__batonMoveItem; return (it && it.getAttribute('aria-controls'))||'';`,
      { timeout: 1500 });
    mark('submenuOpen');
    if (!subId) { await closeMenus(conn, CID, { noEscape: !!opts.noEscape }); return { ok: false, error: 'NO_SUBMENU', detail: 'Move-to-group exposed no aria-controls (submenu did not open)' }; }

    const picked = JSON.parse(await conn.evaluate(rEval(CID, `
      (function(){
        var clean=function(s){return String(s||'').replace(/[^ -~]/g,'').replace(/[0-9]+$/,'').trim().toLowerCase();};
        var want=clean(${JSON.stringify(String(groupName))});
        var sub=document.getElementById(${JSON.stringify(String(subId))});
        if(!sub) return JSON.stringify({picked:false, names:[], err:'submenu-gone'});
        var items=Array.from(sub.querySelectorAll('[role="menuitemradio"],[role="menuitem"]')).filter(function(e){return e.offsetParent!==null;});
        var names=items.map(function(e){ return (e.textContent||'').trim(); });
        var hit=items.find(function(e){ return clean(e.textContent)===want; });
        if(!hit) return JSON.stringify({picked:false, names:names});
        var r=hit.getBoundingClientRect();
        var o={bubbles:true,cancelable:true,clientX:r.left+r.width/2,clientY:r.top+r.height/2,button:0,isPrimary:true,pointerId:1};
        hit.dispatchEvent(new PointerEvent('pointerdown',o));
        hit.dispatchEvent(new MouseEvent('mousedown',o));
        hit.dispatchEvent(new PointerEvent('pointerup',o));
        hit.dispatchEvent(new MouseEvent('mouseup',o));
        hit.dispatchEvent(new MouseEvent('click',o));
        return JSON.stringify({picked:true, names:names});
      })()`)) || '{}');

    mark('pickGroupItem');
    if (!picked.picked) {
      const offered = (picked.names || []).map(n => String(n).replace(/[0-9]+$/, '').trim());
      if (norm(groupName) === 'ungrouped') {
        await closeMenus(conn, CID, { noEscape: !!opts.noEscape });
        return {
          ok: false, error: 'CANNOT_UNGROUP',
          message: 'The Move-to-group menu offers no "Ungrouped" target once a session belongs to a group, so a session cannot be un-grouped this way. Move it to a different group instead.',
          offered,
        };
      }
      if (!create) { await closeMenus(conn, CID, { noEscape: !!opts.noEscape }); return { ok: false, error: 'GROUP_NOT_FOUND', offered }; }

      const made = await conn.evaluate(rEval(CID, `
        (function(){
          var sub=document.getElementById(${JSON.stringify(String(subId))});
          var it=sub?Array.from(sub.querySelectorAll('[role="menuitem"]')).find(function(e){return /New group/i.test(e.textContent||'');}):null;
          if(!it) return 'no-new-group';
          var r=it.getBoundingClientRect();
          var o={bubbles:true,cancelable:true,clientX:r.left+r.width/2,clientY:r.top+r.height/2,button:0,isPrimary:true,pointerId:1,pointerType:'mouse'};
          it.dispatchEvent(new PointerEvent('pointerdown',o));
          it.dispatchEvent(new MouseEvent('mousedown',o));
          it.dispatchEvent(new PointerEvent('pointerup',o));
          it.dispatchEvent(new MouseEvent('mouseup',o));
          it.dispatchEvent(new MouseEvent('click',o));
          return 'ok';
        })()`));
      if (made !== 'ok') { await closeMenus(conn, CID, { noEscape: !!opts.noEscape }); return { ok: false, error: 'NO_NEW_GROUP_ITEM', offered }; }
      await sleep(900);

      const typed = await conn.evaluate(rEval(CID, `
        (function(){
          var inp=Array.from(document.querySelectorAll('input,[contenteditable="true"]'))
            .filter(function(e){ return e.offsetParent!==null && !e.closest('.tiptap'); }).pop();
          if(!inp) return 'no-input';
          var v=${JSON.stringify(String(groupName))};
          if(inp.tagName==='INPUT'){
            var setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
            setter.call(inp, v);
            inp.dispatchEvent(new Event('input',{bubbles:true}));
          } else {
            inp.textContent=v;
            inp.dispatchEvent(new Event('input',{bubbles:true}));
          }
          ['keydown','keypress','keyup'].forEach(function(t){
            inp.dispatchEvent(new KeyboardEvent(t,{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true}));
          });
          var f=inp.closest('form'); if(f) f.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
          return 'ok';
        })()`));
      if (typed !== 'ok') { await closeMenus(conn, CID, { noEscape: !!opts.noEscape }); return { ok: false, error: 'NAME_INPUT_FAILED', detail: typed, offered }; }
    }

    await waitFor(conn, CID,
      `var r=document.querySelector('[data-row-key="code:' + ${JSON.stringify(sessionId)} + '"]');
        if(!r) return '';
        var all=Array.from(document.querySelectorAll('[data-row-key]'));
        for(var j=all.indexOf(r)-1;j>=0;j--){
          var k=all[j].getAttribute('data-row-key')||'';
          if(k.indexOf('label:')!==0) continue;
          if(/^label:(showmore|fetchmore)/.test(k)) continue;
          var t=(all[j].textContent||'').replace(/[^ -~]/g,'').replace(/[0-9]+$/,'').trim().toLowerCase();
          return t===${JSON.stringify(norm(groupName))} ? '1' : '';
        }
        return '';`,
      { timeout: 2500, interval: 25 });
    mark('awaitMoveLanded');
    await closeMenus(conn, CID, { noEscape: !!opts.noEscape });
    mark('closeMenus');

    const after = await scrape(conn, CID);
    const now = after.sessions.find(s => s.id === sessionId);
    const ok = !!now && norm(now.group) === norm(groupName);
    return ok
      ? { ok: true, sessionId, group: now.group, was: row.group }
      : { ok: false, error: 'VERIFY_FAILED', sessionId, expected: groupName, actual: now && now.group, was: row.group, offered: (picked.names || []) };
  } finally { conn.close(); }
}

async function markRead(sessionId) {
  if (!(await cdpAvailable())) return { ok: false, error: 'CDP_UNAVAILABLE' };
  const conn = await connect(await wsUrl());
  try {
    const CID = await pickChat(conn);
    const before = String(await conn.evaluate(rEval(CID, `location.href.split('/').pop()`)));
    const original = before.startsWith('local_') ? before : null;
    if (original === sessionId) return { ok: true, sessionId, alreadyOpen: true };

    const found = await findSessionRow(conn, CID, sessionId);
    if (!found.row) return { ok: false, error: 'NO_SUCH_SESSION', sessionId };

    await conn.evaluate(rEval(CID, `
      (function(){
        var b=document.querySelector('[data-row-key="code:${sessionId}"] [data-row-main-button]');
        if(b) b.click(); return 1;
      })()`));

    let landed = false;
    for (let i = 0; i < 24 && !landed; i++) {
      await sleep(300);
      landed = String(await conn.evaluate(rEval(CID, `location.href.split('/').pop()`))) === sessionId;
    }
    if (!landed) return { ok: false, error: 'NAV_FAILED', sessionId };

    await sleep(1200);
    if (original) { try { await restoreActive(conn, CID, original); } catch {} }
    return { ok: true, sessionId, restored: original };
  } catch (e) {
    return { ok: false, error: 'EXCEPTION', message: e.message };
  } finally { conn.close(); }
}

async function closeMenus(conn, CID, opts = {}) {
  const OUTSIDE_CLICK = `
    (function(){
      var t=document.body;
      var o={bubbles:true,cancelable:true,clientX:4,clientY:4,button:0,isPrimary:true,pointerId:1,pointerType:'mouse'};
      t.dispatchEvent(new PointerEvent('pointerdown',o));
      t.dispatchEvent(new MouseEvent('mousedown',o));
      t.dispatchEvent(new PointerEvent('pointerup',o));
      t.dispatchEvent(new MouseEvent('mouseup',o));
      t.dispatchEvent(new MouseEvent('click',o));
      return String(document.querySelectorAll('[role="menu"] [role="menuitem"]').length);
    })()`;
  try { await conn.evaluate(rEval(CID, OUTSIDE_CLICK)); } catch {}
  await waitFor(conn, CID,
    `return document.querySelectorAll('[role="menu"]').length === 0 ? '1' : '';`,
    { timeout: 600 });

  try {
    const stillOpen = await conn.evaluate(rEval(CID, `
      (function(){
        var open=Array.from(document.querySelectorAll('[role="menu"]')).filter(function(m){
          var t=m.getAttribute('aria-labelledby')||'';
          return m.offsetParent!==null && t;
        });
        return String(open.length);
      })()`));
    if (Number(stillOpen) > 0 && !opts.noEscape) {
      await conn.evaluate(rEval(CID, `(function(){document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));return 1;})()`));
      await sleep(300);
    }
  } catch {}
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// The id is the whole version, not the family: "opus" is a prefix of both "Opus 5.5" and "Opus 5",
// so a family prefix clicked the first opus in the menu and then verified it with the same prefix,
// a wrong switch reported as success. Only a BARE family word ("opus") is an alias; it takes the
// first of its family, which is the desktop's own default for it.
function modelMatcher(model) {
  const raw = String(model || '').trim();
  if (!raw) return null;
  const id = normModel(raw);
  if (!id) return null;
  return { source: id, bare: /^[a-z]+$/.test(id), test: (t) => sameModel(t, raw) };
}

async function awaitUserIdle(conn, CID, { idleMs = 2000, maxWaitMs = 8000 } = {}) {
  const t0 = Date.now();
  for (;;) {
    let last = 0;
    try {
      last = Number(await conn.evaluate(rEval(CID, `String(window.__batonLastKey||0)`))) || 0;
    } catch { return { waited: Date.now() - t0, forced: false }; }
    const quiet = Date.now() - last;
    if (!last || quiet >= idleMs) return { waited: Date.now() - t0, forced: false };
    if (Date.now() - t0 >= maxWaitMs) return { waited: Date.now() - t0, forced: true };
    await sleep(Math.min(400, idleMs - quiet + 50));
  }
}

async function navTo(conn, CID, sessionId, maxMs = 4000, opts = {}) {
  if (opts.idle !== false && !idle.isIdle(idleMinMs())) return false;
  if (!(await routeTo(conn, CID, sessionId, { idle: opts.idle }))) {
    const clicked = await conn.evaluate(rEval(CID, `
      (function(){ var b=document.querySelector('[data-row-key="code:${sessionId}"] [data-row-main-button]');
        if(!b) return 'not-found'; b.scrollIntoView({block:'center',behavior:'instant'}); setTimeout(function(){ b.click(); }, 0); return 'ok'; })()`));
    if (clicked !== 'ok') return false;
  }
  const hit = await waitFor(conn, CID, `return location.href.split('/').pop() === ${JSON.stringify(sessionId)} ? '1' : '';`, { timeout: maxMs, interval: 15 });
  if (!hit) return false;
  await waitFor(conn, CID, `return document.querySelector('[contenteditable="true"], textarea') ? '1' : '';`, { timeout: 1000, interval: 15 });
  return true;
}

async function setModel(sessionId, model, opts = {}) {
  const rx = modelMatcher(model);
  if (!rx) return { ok: false, error: 'BAD_MODEL', message: 'a model name is required' };

  const conn = await connect(await wsUrl());
  try {
    const CID = await pickChat(conn);
    const before = await scrape(conn, CID);
    const row = before.sessions.find(s => s.id === sessionId);
    if (!row) return { ok: false, error: 'NO_SUCH_SESSION', sessionId };
    if (row.running) {
      return { ok: false, error: 'SESSION_RUNNING', sessionId, status: row.status,
               message: 'Claude Desktop will not change the model while the session is running. Stop the turn, or wait for it to finish.' };
    }
    const markerAtRisk = row.unread ? 'Unread response' : row.awaiting ? 'Awaiting input' : null;
    if (markerAtRisk && opts.protect) {
      return {
        ok: false, error: 'PROTECTED',
        message: `Session is "${row.status}" and protect:true was set, so it was not opened.`,
        sessionId, status: row.status,
      };
    }
    const original = before.active;

    if (before.active !== sessionId) { await awaitUserIdle(conn, CID); await navTo(conn, CID, sessionId); }

    const onTarget = await conn.evaluate(rEval(CID, `(function(){return location.href.split('/').pop();})()`));
    if (onTarget !== sessionId) return { ok: false, error: 'NAV_FAILED', expected: sessionId, actual: onTarget };

    const cur = await conn.evaluate(rEval(CID, `
      (function(){
        var b=document.querySelector('[data-cds="ModelSelector"]')
          || document.querySelector('[data-testid="epitaxy-cds-model-selector"]')
          || Array.from(document.querySelectorAll('button')).find(function(e){
          if(e.offsetParent===null || e.getAttribute('aria-haspopup')!=='menu') return false;
          var l=(e.getAttribute('aria-label')||'').trim().toLowerCase();
          if(l.indexOf('model')===0) return true;
          var t=((e.textContent)||'').trim().toLowerCase();
          var fam=['opus','sonnet','haiku','fable'];
          for(var k=0;k<fam.length;k++){ if(t.indexOf(fam[k])===0) return true; }
          return false;
        });
        if(b && b.offsetParent===null) b=null;
        if(!b) return '';
        window.__batonModelBtn=b;
        return (b.textContent||'').trim();
      })()`));
    if (!cur) return { ok: false, error: 'NO_MODEL_PICKER' };
    if (rx.test(cur)) {
      if (original && original !== sessionId) await restoreActive(conn, CID, original);
      return { ok: true, unchanged: true, sessionId, model: cur };
    }

    await conn.evaluate(rEval(CID, `
      (function(){
        window.__batonModelTrigger=function(){
          var b=document.querySelector('[data-cds="ModelSelector"]')
             || document.querySelector('[data-testid="epitaxy-cds-model-selector"]');
          return (b && b.offsetParent!==null) ? b : null;
        };
        var b=window.__batonModelTrigger();
        if(!b) return 0;
        setTimeout(function(){ b.click(); }, 0);
        return 1;
      })()`));
    let menuId = '';
    for (let i = 0; i < 14 && !menuId; i++) {
      await sleep(250);
      menuId = await conn.evaluate(rEval(CID, `
        (function(){
          var b=window.__batonModelTrigger && window.__batonModelTrigger();
          return (b && b.getAttribute('aria-expanded')==='true' && b.getAttribute('aria-controls'))||'';
        })()`)) || '';
    }
    if (!menuId) { await closeMenus(conn, CID); return { ok: false, error: 'MODEL_MENU_DID_NOT_OPEN' }; }

    const picked = JSON.parse(await conn.evaluate(rEval(CID, `
      (function(){
        var m=document.getElementById(${JSON.stringify(String(menuId))});
        if(!m) return JSON.stringify({picked:false, names:[]});
        var items=Array.from(m.querySelectorAll('[role="menuitemradio"]')).filter(function(e){return e.offsetParent!==null;});
        var names=items.map(function(e){return (e.textContent||'').trim();});
        // Exact id, compared on the item's NAME (its first child; the rest is a description),
        // normalised the way normModel does it ("Opus 5.5" -> opus-5-5) with split/join: page-side
        // code stays regex-free.
        var want=${JSON.stringify(String(rx.source))}, bare=${rx.bare ? 'true' : 'false'};
        var norm=function(s){ return String(s||'').trim().toLowerCase().split(' ').join('-').split('.').join('-').split('_').join('-'); };
        var hit=items.find(function(e){
          var f=e.children && e.children[0];
          var n=norm(f ? f.textContent : e.textContent);
          return bare ? n.split('-')[0]===want : n===want;
        });
        if(!hit) return JSON.stringify({picked:false, names:names});
        var r=hit.getBoundingClientRect();
        var o={bubbles:true,cancelable:true,clientX:r.left+r.width/2,clientY:r.top+r.height/2,button:0,isPrimary:true,pointerId:1};
        hit.dispatchEvent(new PointerEvent('pointerdown',o));
        hit.dispatchEvent(new MouseEvent('mousedown',o));
        hit.dispatchEvent(new PointerEvent('pointerup',o));
        hit.dispatchEvent(new MouseEvent('mouseup',o));
        hit.dispatchEvent(new MouseEvent('click',o));
        return JSON.stringify({picked:true, names:names});
      })()`)) || '{}');
    if (!picked.picked) { await closeMenus(conn, CID); return { ok: false, error: 'MODEL_NOT_OFFERED', offered: picked.names }; }

    await sleep(1200);
    await closeMenus(conn, CID);

    const now = await conn.evaluate(rEval(CID, `
      (function(){
        var b=document.querySelector('[data-cds="ModelSelector"]')
           || document.querySelector('[data-testid="epitaxy-cds-model-selector"]');
        if(b && b.offsetParent===null) b=null;
        if(b){
          var l=(b.getAttribute('aria-label')||'').trim();
          var c=l.indexOf(':');
          return c>=0 ? l.slice(c+1).trim() : ((b.textContent)||'').trim();
        }
        return '';
      })()`));
    const ok = rx.test(now || '');
    if (original && original !== sessionId) await restoreActive(conn, CID, original);
    return ok
      ? { ok: true, sessionId, model: now, was: cur, markerCleared: markerAtRisk || undefined }
      : { ok: false, error: 'VERIFY_FAILED', expected: model, actual: now, was: cur, markerCleared: markerAtRisk || undefined };
  } finally { conn.close(); }
}

const EFFORT_VALUES = { low: 0, medium: 1, high: 2, extra: 3, max: 4, ultracode: 5 };

async function setEffort(sessionId, effort, opts = {}) {
  const key = String(effort || '').trim().toLowerCase();
  if (!(key in EFFORT_VALUES)) {
    return { ok: false, error: 'BAD_EFFORT', message: 'effort must be one of: ' + Object.keys(EFFORT_VALUES).join(', ') };
  }
  const want = EFFORT_VALUES[key];
  const conn = await connect(await wsUrl());
  try {
    const CID = await pickChat(conn);
    const before = await scrape(conn, CID);
    const row = before.sessions.find(s => s.id === sessionId);
    if (!row) return { ok: false, error: 'NO_SUCH_SESSION', sessionId };
    if (row.running) {
      return { ok: false, error: 'SESSION_RUNNING', sessionId, status: row.status,
               message: 'Claude Desktop will not change this while the session is running. Stop the turn, or wait for it to finish.' };
    }
    const markerAtRisk = row.unread ? 'Unread response' : row.awaiting ? 'Awaiting input' : null;
    if (markerAtRisk && opts.protect) {
      return { ok: false, error: 'PROTECTED', message: `Session is "${row.status}" and protect:true was set.`, sessionId, status: row.status };
    }
    const original = before.active;

    if (before.active !== sessionId) { await awaitUserIdle(conn, CID); await navTo(conn, CID, sessionId); }
    const onTarget = await conn.evaluate(rEval(CID, `(function(){return location.href.split('/').pop();})()`));
    if (onTarget !== sessionId) return { ok: false, error: 'NAV_FAILED', expected: sessionId, actual: onTarget };

    const opened = await conn.evaluate(rEval(CID, `
      (function(){
        var b=document.querySelector('[data-cds="ModelSelectorEffort"]')
          || Array.from(document.querySelectorAll('button')).find(function(e){
          if(e.offsetParent===null) return false;
          var l=(e.getAttribute('aria-label')||'').trim().toLowerCase();
          var t=((e.textContent)||'').trim().toLowerCase();
          return l.indexOf('effort')===0 || t.indexOf('effort')===0;
        });
        if(b && b.offsetParent===null) b=null;
        if(!b) return '';
        window.__batonEffortBtn=b;
        var was=(b.textContent||'').trim();
        b.click();
        return was;
      })()`));
    if (!opened) return { ok: false, error: 'NO_EFFORT_CONTROL' };
    await sleep(900);

    const set = await conn.evaluate(rEval(CID, `
      (function(){
        var id=(window.__batonEffortBtn && window.__batonEffortBtn.getAttribute('aria-controls'))||'';
        var sc=id?document.getElementById(id):null;
        var inp=sc?sc.querySelector('input[type=range]'):null;
        if(!inp) return 'no-slider';
        var setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
        setter.call(inp, String(${want}));
        inp.dispatchEvent(new Event('input',{bubbles:true}));
        inp.dispatchEvent(new Event('change',{bubbles:true}));
        return 'ok';
      })()`));
    if (set !== 'ok') { await closeMenus(conn, CID); return { ok: false, error: 'SLIDER_NOT_FOUND', detail: set }; }
    await sleep(800);
    await closeMenus(conn, CID);

    const now = await conn.evaluate(rEval(CID, `
      (function(){
        var b=document.querySelector('[data-cds="ModelSelectorEffort"]')
          || Array.from(document.querySelectorAll('button')).find(function(e){
          if(e.offsetParent===null) return false;
          var l=(e.getAttribute('aria-label')||'').trim().toLowerCase();
          var t=((e.textContent)||'').trim().toLowerCase();
          return l.indexOf('effort')===0 || t.indexOf('effort')===0;
        });
        if(b && b.offsetParent===null) b=null;
        return b?(b.textContent||'').trim():'';
      })()`));
    // Exact, not a substring: new RegExp('high') also matched "Extra high", so a change to High
    // that never landed verified as done.
    const ok = sameEffort(now, key);
    if (original && original !== sessionId) await restoreActive(conn, CID, original);
    return ok
      ? { ok: true, sessionId, effort: now, was: opened, markerCleared: markerAtRisk || undefined }
      : { ok: false, error: 'VERIFY_FAILED', expected: effort, actual: now, was: opened, markerCleared: markerAtRisk || undefined };
  } finally { conn.close(); }
}

// g580: put the user back on the session they were on. The old version clicked the sidebar row only if it
// happened to be rendered and never checked, so a row scrolled out of view left the user somewhere else.
// Now: route there (no click), else reveal the row and click it; verified, and a miss is logged. Returns true
// when the user is back where they were.
async function restoreActive(conn, CID, sessionId) {
  if (!sessionId) return false;
  const here = async () => String(await conn.evaluate(rEval(CID, `location.href.split('/').pop()`)) || '');
  try {
    if (await here() === sessionId) return true;
    try { await routeTo(conn, CID, sessionId, { idle: false }); } catch {}
    if (await here() === sessionId) return true;
    const hasRow = () => conn.evaluate(rEval(CID, `!!document.querySelector('[data-row-key="code:${sessionId}"] [data-row-main-button]')`));
    if (!(await hasRow())) { try { await findSessionRow(conn, CID, sessionId); } catch {} }
    await conn.evaluate(rEval(CID, `
      (function(){
        var b=document.querySelector('[data-row-key="code:${sessionId}"] [data-row-main-button]');
        if(b){ b.scrollIntoView({block:'center',behavior:'instant'}); setTimeout(function(){ b.click(); }, 0); }
        return 1;
      })()`));
    await waitFor(conn, CID,
      `return location.href.split('/').pop() === ${JSON.stringify(sessionId)} ? '1' : '';`,
      { timeout: 4000, interval: 15 });
    const back = await here() === sessionId;
    if (!back) console.error(`[focus] could not return the user to ${sessionId}`);
    return back;
  } catch { return false; }
}

async function renameSession(sessionId, title, opts = {}) {
  const want = String(title || '').replace(/\s+/g, ' ').trim();
  if (!want) return { ok: false, error: 'EMPTY_TITLE', message: 'A session title cannot be blank; the app rejects it and keeps the old name.' };
  if (want.length > 200) return { ok: false, error: 'TITLE_TOO_LONG', length: want.length };

  const conn = await connect(await wsUrl());
  try {
    const CID = await pickChat(conn);
    const { row } = await findSessionRow(conn, CID, sessionId);
    if (!row) return { ok: false, error: 'NO_SUCH_SESSION', sessionId };
    const wasCalled = row.title;
    if (titleKey(wasCalled) === titleKey(want)) {
      return { ok: true, unchanged: true, sessionId, title: wasCalled, note: 'Already named that.' };
    }

    const menu = await openRowMenuLive(conn, CID, sessionId, '__batonRenameBtn');
    if (!menu.ok) return menu;

    const picked = await conn.evaluate(rEval(CID, `
      (function(){
        var CLEAN=function(s){return String(s||'').replace(/[\\u200B-\\u200D\\uFEFF\\u00AD\\u2060\\uE000-\\uF8FF]/g,'').replace(/\\s+/g,' ').trim();};
        var NORM=function(s){return CLEAN(s).replace(/([a-z])[A-Z]$/,'$1').toLowerCase();};
        var m=document.getElementById(${JSON.stringify(String(menu.menuId))});
        if(!m) return 'menu-gone';
        var it=Array.from(m.querySelectorAll('[role="menuitem"]')).find(function(e){return NORM(e.textContent)==='rename';});
        if(!it) return 'no-rename-item';
        var r=it.getBoundingClientRect();
        var o={bubbles:true,clientX:r.left+r.width/2,clientY:r.top+r.height/2};
        ['pointerenter','pointerover','pointermove','pointerdown','mousedown','pointerup','mouseup','click'].forEach(function(t){
          it.dispatchEvent(t.indexOf('pointer')===0?new PointerEvent(t,o):new MouseEvent(t,o));
        });
        return 'ok';
      })()`));
    if (picked !== 'ok') { await closeMenus(conn, CID); return { ok: false, error: 'RENAME_UNAVAILABLE', detail: picked, sessionId }; }

    let ready = false;
    for (let i = 0; i < 12 && !ready; i++) {
      await sleep(250);
      ready = (await conn.evaluate(rEval(CID, `
        (function(){
          var r=document.querySelector('[data-row-key="code:${sessionId}"]');
          var el=r && Array.from(r.querySelectorAll('[aria-label]')).find(function(e){return /^Rename/i.test(e.getAttribute('aria-label')||'');});
          return el ? '1' : '';
        })()`))) === '1';
    }
    if (!ready) { await closeMenus(conn, CID); return { ok: false, error: 'NO_RENAME_INPUT', sessionId, previousTitle: wasCalled }; }

    const set = await conn.evaluate(rEval(CID, `
      (function(){
        var r=document.querySelector('[data-row-key="code:${sessionId}"]');
        var el=r && Array.from(r.querySelectorAll('[aria-label]')).find(function(e){return /^Rename/i.test(e.getAttribute('aria-label')||'');});
        if(!el) return 'no-input';
        el.focus();
        var setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
        setter.call(el, ${JSON.stringify(want)});
        el.dispatchEvent(new Event('input',{bubbles:true}));
        ['keydown','keyup'].forEach(function(t){
          el.dispatchEvent(new KeyboardEvent(t,{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true}));
        });
        return 'committed';
      })()`));
    if (set !== 'committed') { await closeMenus(conn, CID); return { ok: false, error: 'RENAME_FAILED', detail: set, sessionId, previousTitle: wasCalled }; }

    await sleep(1600);
    let now = null;
    for (let i = 0; i < 4 && titleKey(now) !== titleKey(want); i++) {
      if (i) await sleep(700);
      const after = await findSessionRow(conn, CID, sessionId);
      now = after.row ? after.row.title : null;
    }
    return titleKey(now) === titleKey(want)
      ? { ok: true, sessionId, title: now, previousTitle: wasCalled, verifiedBy: 'the sidebar row now carries the new title' }
      : { ok: false, error: 'VERIFY_FAILED', sessionId, previousTitle: wasCalled, expected: want, actual: now,
          message: 'Rename was typed and committed but the row does not show it, so this is NOT reported as renamed.' };
  } finally { conn.close(); }
}

const CHIP_JS = `
(function(){
  var CLEAN=function(s){return String(s||'').replace(/[\\u200B-\\u200D\\uFEFF\\u00AD\\u2060\\uE000-\\uF8FF]/g,'').replace(/\\s+/g,' ').trim();};
  var card=document.querySelector('.epitaxy-notification-enter');
  var out={active:location.href.split('/').pop(),present:!!card,index:0,total:0};
  if(!card) return JSON.stringify(out);
  var host=card.parentElement;
  var fk=Object.keys(card).find(function(k){return /^__reactFiber/.test(k);});
  var n=fk?card[fk]:null,i=0;
  out.taskId=null; out.owner=null;
  while(n&&i<8){
    if(typeof n.key==='string'){
      if(!out.taskId&&/^task_/.test(n.key)) out.taskId=n.key;
      if(!out.owner&&/^chip-/.test(n.key)) out.owner=n.key.replace(/^chip-/,'');
    }
    n=n.return;i++;
  }
  out.title=CLEAN((card.querySelector('[role="status"] span.text-body')||{}).textContent);
  out.description=CLEAN((card.querySelector('[role="status"] span.line-clamp-3')||{}).textContent);
  out.index=1; out.total=1;
  Array.from(host.querySelectorAll('span')).forEach(function(e){
    var m=/^(\\d+) of (\\d+)$/.exec(CLEAN(e.textContent));
    if(m){ out.index=Number(m[1]); out.total=Number(m[2]); }
  });
  var nx=host.querySelector('button[aria-label="Show next suggestion"]');
  var pv=host.querySelector('button[aria-label="Show previous suggestion"]');
  out.hasNext=!!(nx&&!nx.hasAttribute('disabled'));
  out.hasPrev=!!(pv&&!pv.hasAttribute('disabled'));
  out.canStartWorktree=!!card.querySelector('button[aria-label="Start with worktree"]');
  out.canStartLocal=!!Array.from(card.querySelectorAll('button')).find(function(e){
    return /^more (spawn|start) options$/i.test(e.getAttribute('aria-label')||''); });
  return JSON.stringify(out);
})()`;

const ROWS_JS = `
(function(){
  var CLEAN=function(s){return String(s||'').replace(/[\\u200B-\\u200D\\uFEFF\\u00AD\\u2060\\uE000-\\uF8FF]/g,'').replace(/\\s+/g,' ').trim();};
  return JSON.stringify(Array.from(document.querySelectorAll('[data-row-key^="code:"]')).map(function(r){
    var b=r.querySelector('[data-row-main-button]');
    return {id:r.getAttribute('data-row-key').replace('code:',''),
            title:CLEAN(b?b.textContent:'').replace(/^Running /,'')};
  }));
})()`;

const POINTER_SEQ = `
  var r=b.getBoundingClientRect();
  var o={bubbles:true,cancelable:true,clientX:r.left+r.width/2,clientY:r.top+r.height/2,button:0,isPrimary:true,pointerId:1,pointerType:'mouse'};
  b.dispatchEvent(new PointerEvent('pointerdown',o));
  b.dispatchEvent(new MouseEvent('mousedown',o));
  b.dispatchEvent(new PointerEvent('pointerup',o));
  b.dispatchEvent(new MouseEvent('mouseup',o));
  b.dispatchEvent(new MouseEvent('click',o));`;

const chipNavJs = dir => `
(function(){
  var card=document.querySelector('.epitaxy-notification-enter');
  if(!card) return 'no-card';
  var b=card.parentElement.querySelector('button[aria-label="Show ${dir} suggestion"]');
  if(!b) return 'no-arrow';
  if(b.hasAttribute('disabled')) return 'disabled';
  ${POINTER_SEQ}
  return 'ok';
})()`;

const CHIP_START_WORKTREE = `
(function(){
  var card=document.querySelector('.epitaxy-notification-enter');
  if(!card) return 'no-card';
  var b=card.querySelector('button[aria-label="Start with worktree"]');
  if(!b) return 'no-start-button';
  if(b.hasAttribute('disabled')||b.getAttribute('aria-disabled')==='true') return 'disabled';
  ${POINTER_SEQ}
  return 'ok';
})()`;

const CHIP_OPEN_MORE = `
(function(){
  Array.from(document.querySelectorAll('[role="menu"]')).forEach(function(m){ m.setAttribute('data-baton-stale','1'); });
  var card=document.querySelector('.epitaxy-notification-enter');
  if(!card) return 'no-card';
  var b=Array.from(card.querySelectorAll('button')).find(function(e){
    return /^more (spawn|start) options$/i.test(e.getAttribute('aria-label')||''); });
  if(!b) return 'no-more-button';
  window.__batonChipMore=b;
  b.click();
  return 'ok';
})()`;

const chipPickLocalJs = menuId => `
(function(){
  var CLEAN=function(s){return String(s||'').replace(/[\\u200B-\\u200D\\uFEFF\\u00AD\\u2060\\uE000-\\uF8FF]/g,'').replace(/\\s+/g,' ').trim();};
  var m=document.getElementById(${JSON.stringify(String(menuId))});
  if(!m) return JSON.stringify({ok:false,error:'menu-gone'});
  var items=Array.from(m.querySelectorAll('[role="menuitem"],[role="menuitemradio"]')).filter(function(e){return e.offsetParent!==null;});
  var names=items.map(function(e){return CLEAN(e.textContent).slice(0,60);});
  var b=items.find(function(e){return /^Start locally/i.test(CLEAN(e.textContent));});
  if(!b) return JSON.stringify({ok:false,error:'not-offered',offered:names});
  if(b.hasAttribute('disabled')||b.getAttribute('aria-disabled')==='true') return JSON.stringify({ok:false,error:'disabled',offered:names});
  ${POINTER_SEQ}
  return JSON.stringify({ok:true,offered:names});
})()`;

const CHIP_MODES = ['local', 'worktree'];

function titleKey(s) {
  return String(s || '').replace(/[\u200B-\u200D\uFEFF\u00AD\u2060\uE000-\uF8FF]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}
function titlesMatch(chipTitle, rowTitle) {
  const a = titleKey(chipTitle), b = titleKey(rowTitle);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length < 8 || b.length < 8) return false;
  return a.startsWith(b) || b.startsWith(a);
}

const readChip = (conn, CID) => conn.evaluate(rEval(CID, CHIP_JS)).then(r => JSON.parse(r || '{}'));

async function readChipSettled(conn, CID, opts = {}) {
  let chip = await readChip(conn, CID);
  if (chip.present) return chip;

  const sid = chip.active || (await conn.evaluate(rEval(CID, `(function(){return location.href.split('/').pop();})()`)));
  let expected = null;
  try {
    const j = await conn.evaluate(rEval(CID, `
      (async function(){
        var LS=window['claude.web'] && window['claude.web'].LocalSessions;
        if(!LS || typeof LS.getSession!=='function') return '';
        try{ var s=await LS.getSession(${JSON.stringify(String(sid))}); if(!s) return '';
             return String((s.backgroundTaskSuggestions||[]).length); }catch(e){ return ''; }
      })()`));
    if (j !== '') expected = Number(j);
  } catch {}
  if (expected === 0) return chip;

  const deadline = Date.now() + (opts.timeout || 4000);
  while (Date.now() < deadline) {
    await sleep(80);
    chip = await readChip(conn, CID);
    if (chip.present) return chip;
  }
  return { ...chip, expectedChips: expected };
}
const readRows = (conn, CID) => conn.evaluate(rEval(CID, ROWS_JS)).then(r => JSON.parse(r || '[]'));

async function blockedSessions() {
  const conn = await connect(await wsUrl());
  try {
    const CID = await pickChat(conn);
    const raw = await conn.evaluate(rEval(CID, `
      (async function(){
        var LS=window['claude.web'] && window['claude.web'].LocalSessions;
        if(!LS || typeof LS.getSessionList!=='function') return 'NO_BRIDGE';
        try{
          var list=await LS.getSessionList();
          var arr=Array.isArray(list)?list:(list&&list.sessions)||[];
          var out=[];
          arr.forEach(function(s){
            if(s.isArchived) return;
            var kinds=[];
            if((s.pendingToolPermissions||[]).length) kinds.push('tool-permission');
            if(s.pendingCwdTrustPrompt) kinds.push('folder-trust');
            if(s.pendingRefusalFallbackPrompt) kinds.push('refusal-fallback');
            if(s.pendingLanyardConsent) kinds.push('consent');
            if(!kinds.length) return;
            out.push({ sessionId:s.sessionId, title:s.title||'', kinds:kinds,
              running:!!s.isRunning, cwd:s.cwd||'',
              detail: JSON.stringify(s.pendingToolPermissions||null).slice(0,600) });
          });
          return JSON.stringify(out);
        }catch(e){ return 'THREW:'+String((e&&e.message)||e).slice(0,180); }
      })()`));
    if (raw === 'NO_BRIDGE') return { ok: false, error: 'NO_BRIDGE' };
    if (String(raw).startsWith('THREW:')) return { ok: false, error: 'BRIDGE_ERROR', detail: String(raw).slice(6) };
    const blocked = JSON.parse(raw);
    return {
      ok: true, blocked, total: blocked.length, transport: 'background',
      note: blocked.length
        ? 'These sessions are waiting on a human. Read one with ccd_session_mgmt list_events (lossless) and answer it, or open it with the /open endpoint. Relaymote does not press Allow for you.'
        : 'No session is blocked on a permission or consent prompt.',
    };
  } finally { conn.close(); }
}

async function allChipQueues() {
  const conn = await connect(await wsUrl());
  try {
    const CID = await pickChat(conn);
    const raw = await conn.evaluate(rEval(CID, `
      (async function(){
        var LS=window['claude.web'] && window['claude.web'].LocalSessions;
        if(!LS || typeof LS.getSessionList!=='function') return 'NO_BRIDGE';
        try{
          var list=await LS.getSessionList();
          var arr=Array.isArray(list)?list:(list&&list.sessions)||[];
          var out=[];
          arr.forEach(function(s){
            var c=s.backgroundTaskSuggestions||[];
            if(c.length) out.push({ sessionId:s.sessionId, title:s.title||'', archived:!!s.isArchived,
              chips:c.map(function(x){ return {id:x.id, title:x.title, tldr:x.tldr, prompt:x.prompt, cwd:x.cwd, createdAt:x.createdAt}; }) });
          });
          return JSON.stringify(out);
        }catch(e){ return 'THREW:'+String((e&&e.message)||e).slice(0,180); }
      })()`));
    if (raw === 'NO_BRIDGE') return { ok: false, error: 'NO_BRIDGE' };
    if (String(raw).startsWith('THREW:')) return { ok: false, error: 'BRIDGE_ERROR', detail: String(raw).slice(6) };
    const byId = new Map();
    for (const s of JSON.parse(raw)) {
      byId.set(s.sessionId, {
        sessionId: s.sessionId, owner: s.title, archived: s.archived,
        chips: s.chips.map((c, i) => ({ taskId: c.id, title: c.title, description: c.tldr || '',
          prompt: c.prompt || '', cwd: c.cwd || '', createdAt: c.createdAt || null, index: i + 1, owner: s.title })),
      });
    }
    return { ok: true, sessions: byId, total: [...byId.values()].reduce((n, s) => n + s.chips.length, 0), transport: 'background' };
  } finally { conn.close(); }
}

async function listChipTasksBackground(sessionId) {
  const conn = await connect(await wsUrl());
  try {
    const CID = await pickChat(conn);
    if (!sessionId) {
      sessionId = await conn.evaluate(rEval(CID, `(function(){return location.href.split('/').pop();})()`));
      if (!sessionId || !/^local_|^session_/.test(String(sessionId))) return { ok: false, error: 'NO_SESSION_ID' };
    }
    const raw = await conn.evaluate(rEval(CID, `
      (async function(){
        var LS=window['claude.web'] && window['claude.web'].LocalSessions;
        if(!LS || typeof LS.getSession!=='function') return 'NO_BRIDGE';
        try{
          var s=await LS.getSession(${JSON.stringify(sessionId)});
          if(!s) return 'NO_SESSION';
          return JSON.stringify({ title:s.title||'', chips:(s.backgroundTaskSuggestions||[]) });
        }catch(e){ return 'THREW:'+String((e&&e.message)||e).slice(0,180); }
      })()`));
    if (raw === 'NO_BRIDGE') return { ok: false, error: 'NO_BRIDGE' };
    if (raw === 'NO_SESSION') return { ok: false, error: 'NO_SUCH_SESSION', sessionId };
    if (String(raw).startsWith('THREW:')) return { ok: false, error: 'BRIDGE_ERROR', detail: String(raw).slice(6) };
    const j = JSON.parse(raw);
    const chips = (j.chips || []).map((c, i) => ({
      taskId: c.id, title: c.title, description: c.tldr || '',
      prompt: c.prompt || '', cwd: c.cwd || '', createdAt: c.createdAt || null,
      index: i + 1, owner: j.title,
    }));
    return {
      ok: true, sessionId, chips, total: chips.length, transport: 'background',
      markerCleared: undefined,
      note: chips.length
        ? 'Read from the app’s own session record — the session was NOT opened, so no unread/awaiting marker was touched. Includes each chip’s full prompt.'
        : 'No suggested-task chip is pending in this session (read without opening it).',
    };
  } finally { conn.close(); }
}

async function listChipTasks(sessionId, opts = {}) {
  const conn = await connect(await wsUrl());
  try {
    const CID = await pickChat(conn);
    const nav = await ensureSessionOpen(conn, CID, sessionId, opts);
    if (!nav.ok) return nav;
    const queue = [];
    let chip = await readChipSettled(conn, CID);
    if (!chip.present) {
      if (nav.restore) await restoreActive(conn, CID, nav.restore);
      return { ok: true, sessionId: nav.session, chips: [], total: 0, markerCleared: nav.markerCleared,
               note: 'No suggested-task chip is pending in this session.' };
    }
    let steps = 0;
    const guard = (chip.total || 1) + 2;
    while (steps < guard) {
      queue.push({ taskId: chip.taskId, title: chip.title, description: chip.description,
                   index: chip.index, owner: chip.owner });
      if (!chip.hasNext) break;
      const r = await conn.evaluate(rEval(CID, chipNavJs('next')));
      if (r !== 'ok') break;
      steps++;
      await sleep(500);
      chip = await readChip(conn, CID);
    }
    for (let i = 0; i < steps; i++) { await conn.evaluate(rEval(CID, chipNavJs('previous'))); await sleep(400); }
    if (nav.restore) await restoreActive(conn, CID, nav.restore);
    return { ok: true, sessionId: nav.session, total: queue.length, chips: queue, markerCleared: nav.markerCleared };
  } finally { conn.close(); }
}

async function ensureSessionOpen(conn, CID, sessionId, opts = {}) {
  const before = await scrape(conn, CID);
  if (!sessionId || sessionId === before.active) {
    return { ok: true, session: before.active, restore: null, markerCleared: undefined };
  }
  if (opts.idle !== false && !idle.isIdle(idleMinMs())) {
    return { ok: false, error: 'USER_ACTIVE', sessionId, idleMs: idle.idleMs(), requiredIdleMs: idleMinMs(),
             message: 'The user is active, so the session was not opened. Safe to retry when idle.' };
  }
  let row = before.sessions.find(s => s.id === sessionId);
  if (!row) {
    const found = await findSessionRow(conn, CID, sessionId);
    row = found.row;
    if (!row) {
      return { ok: false, error: 'NO_SUCH_SESSION', sessionId,
               message: 'No sidebar row for that session id after walking the whole list (scrolling and loading more). If the session really does exist, it may be archived.' };
    }
  }
  const markerAtRisk = row.unread ? 'Unread response' : row.awaiting ? 'Awaiting input' : null;
  if (markerAtRisk && opts.protect) {
    return { ok: false, error: 'PROTECTED', sessionId, status: row.status,
             message: `Session is "${row.status}" and protect:true was set, so it was not opened. Chips are only reachable inside the open session, so this chip cannot be read or started without clearing that marker.` };
  }
  if (!(await routeTo(conn, CID, sessionId, { idle: opts.idle }))) {
    await conn.evaluate(rEval(CID, `
      (function(){
        var b=document.querySelector('[data-row-key="code:${sessionId}"] [data-row-main-button]');
        if(!b) return 'no-row';
        b.scrollIntoView({block:'center',behavior:'instant'});
        b.click();
        return 'ok';
      })()`));
  }
  await waitFor(conn, CID,
    `return location.href.split('/').pop() === ${JSON.stringify(sessionId)} ? '1' : '';`,
    { timeout: 4000, interval: 15 });
  const now = await conn.evaluate(rEval(CID, `(function(){return location.href.split('/').pop();})()`));
  if (now !== sessionId) return { ok: false, error: 'NAV_FAILED', expected: sessionId, actual: now };
  return { ok: true, session: sessionId, restore: before.active !== sessionId ? before.active : null,
           markerCleared: markerAtRisk || undefined };
}

async function haltSession(sessionId, opts = {}) {
  if (!sessionId) return { ok: false, error: 'NO_SESSION_ID' };
  const hard = !!opts.hard;
  const conn = await connect(await wsUrl());
  try {
    const CID = await pickChat(conn);
    const read = async () => {
      const j = await conn.evaluate(rEval(CID, `
        (async function(){
          var LS=window['claude.web'] && window['claude.web'].LocalSessions;
          if(!LS || typeof LS.getSession!=='function') return '';
          try{ var s=await LS.getSession(${JSON.stringify(sessionId)}); if(!s) return 'null';
               return JSON.stringify({running:!!s.isRunning, turn:!!s.turnRunning, title:s.title||''}); }
          catch(e){ return ''; }
        })()`));
      return j && j !== 'null' ? JSON.parse(j) : null;
    };
    const before = await read();
    if (before === null) return { ok: false, error: 'NO_SUCH_SESSION', sessionId };
    if (!before.running && !before.turn) {
      return { ok: true, unchanged: true, sessionId, title: before.title,
               note: 'It was not running, so there was nothing to halt.' };
    }
    const out = await conn.evaluate(rEval(CID, `
      (async function(){
        var LS=window['claude.web'].LocalSessions;
        try{ await LS.${hard ? 'stop' : 'interrupt'}(${JSON.stringify(sessionId)}); return 'OK'; }
        catch(e){ return 'THREW:'+String((e&&e.message)||e).replace(/^Error invoking remote method '[^']*': /,'').slice(0,180); }
      })()`));
    if (String(out).startsWith('THREW:')) return { ok: false, error: 'BRIDGE_ERROR', detail: String(out).slice(6), sessionId };

    let after = null;
    for (let i = 0; i < 20; i++) { after = await read(); if (after && !after.running && !after.turn) break; await sleep(200); }
    const halted = !!(after && !after.running && !after.turn);
    return halted
      ? { ok: true, sessionId, title: before.title, method: hard ? 'stop' : 'interrupt', wasRunning: true,
          note: 'Halted, and confirmed stopped by reading the session back. Anything it had already done — a message sent, a file written, a commit — still stands.' }
      : { ok: false, error: 'STILL_RUNNING', sessionId, title: before.title, method: hard ? 'stop' : 'interrupt',
          message: 'The halt was issued but the session is still running 4s later. Try again with hard:true, or stop it from the UI.' };
  } finally { conn.close(); }
}

async function sessionForChip(taskId) {
  if (!taskId) return null;
  const conn = await connect(await wsUrl());
  try {
    const CID = await pickChat(conn);
    const raw = await conn.evaluate(rEval(CID, `
      (async function(){
        var LS=window['claude.web'] && window['claude.web'].LocalSessions;
        if(!LS || typeof LS.getSessionList!=='function') return '';
        try{
          var list=await LS.getSessionList();
          var arr=Array.isArray(list)?list:(list&&list.sessions)||[];
          var hit=arr.filter(function(s){ return s.spawnedFrom && s.spawnedFrom.taskId===${JSON.stringify(String(taskId))}; })
                     .sort(function(a,b){ return (b.createdAt||0)-(a.createdAt||0); })[0];
          if(!hit) return '';
          return JSON.stringify({ sessionId:hit.sessionId, title:hit.title||'', running:!!hit.isRunning,
                                  archived:!!hit.isArchived, createdAt:hit.createdAt||null });
        }catch(e){ return ''; }
      })()`));
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
  finally { conn.close(); }
}

async function startTaskRetrying(opts = {}) {
  const tries = opts.retries === undefined ? 3 : Math.max(1, opts.retries);
  const RETRYABLE = new Set(['NO_CHIP', 'NO_SUCH_CHIP', 'MENU_FAILED', 'NO_LIVE_MENU', 'VERIFY_FAILED', 'START_FAILED', 'START_LOCALLY_UNAVAILABLE']);
  const attempts = [];
  for (let i = 0; i < tries; i++) {
    if (i) await sleep(i * 4000);
    const r = await startTask(opts);
    attempts.push(r && r.error ? r.error : (r && r.ok ? 'ok' : 'unknown'));
    if (r && r.ok) return attempts.length > 1 ? { ...r, attempts, retried: true } : r;
    if (!r || !RETRYABLE.has(r.error)) return r && typeof r === 'object' ? { ...r, attempts } : r;

    const already = await sessionForChip(opts.taskId);
    if (already) {
      return {
        ok: true, taskId: opts.taskId, startedSessionId: already.sessionId, title: already.title,
        attempts, recovered: true, chipConsumed: true,
        note: 'The press HAD taken effect — the app links this chip to that session. Verification had failed (typically an unrendered sidebar row), which would previously have triggered a retry and started a duplicate.',
      };
    }
    if (r.chipConsumed) {
      return { ...r, attempts, retryRefused: 'chip-consumed',
        message: (r.message || '') + ' The chip is no longer in the queue, so the press probably DID start something. Not retrying, because a second press would risk a duplicate session. Check the sidebar before starting it again.' };
    }
    if (i === tries - 1) {
      return { ...r, attempts,
        message: (r.message || '') + ' Retried ' + tries + ' times with backoff; the chip did not become startable. If the app still shows it, say so and I will look at the DOM path again.' };
    }
  }
}

async function startTask(opts = {}) {
  const mode = String(opts.mode || 'local').toLowerCase();
  if (!CHIP_MODES.includes(mode)) {
    return { ok: false, error: 'BAD_MODE', message: `mode must be one of: ${CHIP_MODES.join(', ')}` };
  }
  const conn = await connect(await wsUrl());
  try {
    const CID = await pickChat(conn);
    const nav = await ensureSessionOpen(conn, CID, opts.sessionId, opts);
    if (!nav.ok) return nav;
    if (opts.idle !== false && idleMinMs() > 0 && (idle.idleMs() === null || idle.idleMs() < 3000)) {
      if (nav.restore) await restoreActive(conn, CID, nav.restore);
      return { ok: false, error: 'USER_ACTIVE', action: 'startTask', idleMs: idle.idleMs(), message: 'Input detected while navigating; restored the previous session and did not press the chip.' };
    }
    const out = await startOneChip(conn, CID, { ...opts, mode }, nav);
    if (nav.restore) await restoreActive(conn, CID, nav.restore);
    return out;
  } finally { conn.close(); }
}

async function startAllTasks(opts = {}) {
  const mode = String(opts.mode || 'local').toLowerCase();
  if (!CHIP_MODES.includes(mode)) {
    return { ok: false, error: 'BAD_MODE', message: `mode must be one of: ${CHIP_MODES.join(', ')}` };
  }
  const conn = await connect(await wsUrl());
  try {
    const CID = await pickChat(conn);
    const nav = await ensureSessionOpen(conn, CID, opts.sessionId, opts);
    if (!nav.ok) return nav;
    const first = await readChipSettled(conn, CID);
    const results = [];
    const guard = (first.total || 0) + 2;
    for (let i = 0; i < guard; i++) {
      const chip = await readChip(conn, CID);
      if (!chip.present) break;
      const r = await startOneChip(conn, CID, { mode }, nav);
      results.push(r);
      if (!r.ok) break;
      await sleep(1200);
    }
    if (nav.restore) await restoreActive(conn, CID, nav.restore);
    const started = results.filter(r => r.ok).length;
    return {
      ok: started > 0 && results.every(r => r.ok),
      sessionId: nav.session, mode, started, attempted: results.length,
      queuedAtStart: first.total || 0, results, markerCleared: nav.markerCleared,
      note: started === results.length
        ? `Started ${started} chip(s); each one verified by a new session row appearing.`
        : 'Some chips did not start — see per-chip results. Nothing counts as started without a verified new session.',
    };
  } finally { conn.close(); }
}

async function startOneChip(conn, CID, opts, nav) {
  let chip = await readChipSettled(conn, CID);
  if (!chip.present) {
    return { ok: false, error: 'NO_CHIP', sessionId: nav.session, markerCleared: nav.markerCleared,
             message: 'No suggested-task chip is pending in this session. Chips are only visible inside the session that created them, so check you named the right session.' };
  }

  if (opts.taskId) {
    const want = String(opts.taskId);
    const seen = [];
    let steps = 0;
    const guard = (chip.total || 1) + 2;
    while (chip.present && chip.taskId !== want && steps < guard) {
      seen.push(chip.taskId);
      if (!chip.hasNext) break;
      if (await conn.evaluate(rEval(CID, chipNavJs('next'))) !== 'ok') break;
      steps++;
      await sleep(500);
      chip = await readChip(conn, CID);
    }
    if (chip.taskId !== want) {
      return { ok: false, error: 'NO_SUCH_CHIP', requested: want, sessionId: nav.session,
               chipsSeen: [...new Set(seen.concat(chip.taskId ? [chip.taskId] : []))].filter(Boolean),
               markerCleared: nav.markerCleared,
               message: 'That task id is not in this session\'s chip queue. Chip ids come from ccd_session_mgmt spawn_task and are only visible in the session that created them.' };
    }
  }

  const target = { taskId: chip.taskId, title: chip.title, owner: chip.owner, total: chip.total };
  const rowsBefore = await readRows(conn, CID);
  const idsBefore = new Set(rowsBefore.map(r => r.id));

  let pressed, offered;
  if (opts.mode === 'worktree') {
    pressed = await conn.evaluate(rEval(CID, CHIP_START_WORKTREE));
  } else {
    const open = await conn.evaluate(rEval(CID, CHIP_OPEN_MORE));
    if (open !== 'ok') {
      return { ok: false, error: 'MENU_FAILED', detail: open, ...target, sessionId: nav.session, markerCleared: nav.markerCleared };
    }
    let menuId = '';
    for (let i = 0; i < 12 && !menuId; i++) {
      menuId = await conn.evaluate(rEval(CID, `
        (function(){ var b=window.__batonChipMore; return (b && b.getAttribute('aria-expanded')==='true' && b.getAttribute('aria-controls'))||''; })()`)) || '';
      if (!menuId) await sleep(250);
    }
    if (!menuId) {
      await closeMenus(conn, CID);
      return { ok: false, error: 'NO_LIVE_MENU', detail: 'the "More start options" trigger never exposed aria-controls',
               ...target, sessionId: nav.session, markerCleared: nav.markerCleared };
    }
    const pick = JSON.parse(await conn.evaluate(rEval(CID, chipPickLocalJs(menuId))) || '{}');
    offered = pick.offered;
    if (!pick.ok) {
      await closeMenus(conn, CID);
      return { ok: false, error: 'START_LOCALLY_UNAVAILABLE', detail: pick.error, offered,
               ...target, sessionId: nav.session, markerCleared: nav.markerCleared };
    }
    pressed = 'ok';
    await closeMenus(conn, CID);
  }
  if (pressed !== 'ok') {
    return { ok: false, error: 'START_FAILED', detail: pressed, ...target, sessionId: nav.session, markerCleared: nav.markerCleared };
  }

  let startedId = null, newRows = [];
  const rowDeadline = Date.now() + 14000;
  while (!startedId && Date.now() < rowDeadline) {
    await sleep(25);
    const rows = await readRows(conn, CID);
    newRows = rows.filter(r => !idsBefore.has(r.id));
    const hit = newRows.find(r => titlesMatch(target.title, r.title));
    if (hit) startedId = hit.id;
  }
  const after = await readChip(conn, CID);
  const chipConsumed = !after.present || after.taskId !== target.taskId;

  if (!startedId) {
    return {
      ok: false, error: 'VERIFY_FAILED', ...target, mode: opts.mode, sessionId: nav.session,
      expected: `a new sidebar session titled "${target.title}"`,
      actual: newRows.length ? `new rows appeared but none matched: ${newRows.map(r => r.title).join(' | ')}` : 'no new session row appeared',
      chipConsumed, offered, markerCleared: nav.markerCleared,
      message: 'The chip was pressed but no matching session could be confirmed, so this is NOT reported as started.',
    };
  }
  return {
    ok: true, taskId: target.taskId, title: target.title, mode: opts.mode,
    sessionId: nav.session, startedSessionId: startedId, chipConsumed,
    chipsRemaining: after.present ? (after.total || 1) : 0,
    markerCleared: nav.markerCleared,
    note: `Verified: session ${startedId} exists in the sidebar with the chip's title.`,
  };
}

async function archiveSessionCore(sessionId, opts = {}) {
  const conn = await connect(await wsUrl());
  try {
    const CID = await pickChat(conn);
    const { row } = await findSessionRow(conn, CID, sessionId);
    if (!row) return { ok: false, error: 'NO_SUCH_SESSION', sessionId,
                       message: 'No sidebar row for that session id after walking the whole list.' };
    if (row.archived) return { ok: true, unchanged: true, sessionId, note: 'Already archived.' };

    const blockers = [];
    if (row.running) blockers.push('running');
    if (row.awaiting) blockers.push('awaiting input');
    if (row.unread) blockers.push('unread — nobody has seen this result yet');
    if (blockers.length && !opts.force) {
      return {
        ok: false, error: 'PROTECTED', sessionId, status: row.status, blockers,
        message: `Refusing to archive: session is ${blockers.join(' + ')}. Archiving stops the process and cleans the worktree, so unseen or in-flight work would be lost. Read it first (ccd_session_mgmt list_events is lossless) and pass force:true if it really should go.`,
      };
    }

    const menu = await openRowMenuLive(conn, CID, sessionId, '__batonArcBtn');
    if (!menu.ok) return menu;
    const menuId = menu.menuId;

    const picked = JSON.parse(await conn.evaluate(rEval(CID, `
      (function(){
        var CLEAN=function(s){return String(s||'').replace(/[\\u200B-\\u200D\\uFEFF\\u00AD\\u2060\\uE000-\\uF8FF]/g,'').replace(/\\s+/g,' ').trim();};
        var NORM=function(s){return CLEAN(s).replace(/([a-z])[A-Z]$/,'$1').toLowerCase();};
        var m=document.getElementById(${JSON.stringify(String(menuId))});
        if(!m) return JSON.stringify({ok:false,error:'menu-gone'});
        var items=Array.from(m.querySelectorAll('[role="menuitem"],[role="menuitemradio"]')).filter(function(e){return e.offsetParent!==null;});
        var names=items.map(function(e){return CLEAN(e.textContent).slice(0,40);});
        var b=items.find(function(e){return NORM(e.textContent)==='archive';});
        if(!b) return JSON.stringify({ok:false,error:'not-offered',offered:names,normalised:items.map(function(e){return NORM(e.textContent);})});
        ${POINTER_SEQ}
        return JSON.stringify({ok:true,offered:names});
      })()`)) || '{}');
    if (!picked.ok) { await closeMenus(conn, CID); return { ok: false, error: 'ARCHIVE_NOT_OFFERED', detail: picked.error, offered: picked.offered, sessionId }; }
    await sleep(1200);

    const confirmed = JSON.parse(await conn.evaluate(rEval(CID, `
      (function(){
        var CLEAN=function(s){return String(s||'').replace(/[\\u200B-\\u200D\\uFEFF\\u00AD\\u2060\\uE000-\\uF8FF]/g,'').replace(/\\s+/g,' ').trim();};
        var RX=/^(archive|confirm|yes|ok)$/i;
        var dlgs=Array.from(document.querySelectorAll('[role="dialog"],[role="alertdialog"]')).filter(function(d){return d.offsetParent!==null;});
        if(!dlgs.length) return JSON.stringify({dialog:false});
        var labels=[], b=null;
        for(var i=dlgs.length-1;i>=0;i--){
          var btns=Array.from(dlgs[i].querySelectorAll('button')).filter(function(e){return e.offsetParent!==null;});
          labels=labels.concat(btns.map(function(e){return CLEAN(e.textContent)||e.getAttribute('aria-label')||'';}));
          if(!b) b=btns.find(function(e){return RX.test(CLEAN(e.textContent));})||null;
        }
        if(!b) return JSON.stringify({dialog:true,confirmed:false,buttons:labels});
        ${POINTER_SEQ}
        return JSON.stringify({dialog:true,confirmed:true,buttons:labels});
      })()`)) || '{}');
    const unrecognisedDialog = !!(confirmed.dialog && !confirmed.confirmed);
    await sleep(1600);
    await closeMenus(conn, CID);

    const after = await scrape(conn, CID);
    const still = after.sessions.find(s => s.id === sessionId);
    const gone = !still || still.archived;
    return gone
      ? { ok: true, sessionId, title: row.title, was: row.status, group: row.group,
          confirmDialog: !!confirmed.dialog,
          verifiedBy: still ? 'row now marked Archived' : 'row no longer in the active sidebar list',
          note: 'Archived from the row menu — no approval prompt, and the session process is stopped.' }
      : unrecognisedDialog
        ? { ok: false, error: 'CONFIRM_DIALOG_UNRECOGNISED', sessionId, buttons: confirmed.buttons,
            actual: still.status,
            message: 'The session did not archive, and a dialog was open whose buttons matched no known confirm label, so nothing was pressed. Reporting rather than clicking something unidentified.' }
        : { ok: false, error: 'VERIFY_FAILED', sessionId, expected: 'row archived or removed from the sidebar',
            actual: still.status, was: row.status, confirmDialog: !!confirmed.dialog, offered: picked.offered };
  } finally { conn.close(); }
}

async function archiveSession(sessionId, opts = {}) {
  const first = await archiveSessionCore(sessionId, opts);
  if (opts._visible || first.error !== 'NO_SUCH_SESSION') return { ...first, visibility: { relaxed: false, rowFound: first.error !== 'NO_SUCH_SESSION' } };
  const conn = await connect(await wsUrl());
  try {
    const CID = await pickChat(conn);
    const known = await knownToApp(conn, CID, sessionId);
    if (known !== 'row' && known !== 'listed') {
      return { ...first, visibility: { relaxed: false, rowFound: false, appKnows: known || 'no' },
               message: known === 'archived' ? 'The app lists this session as already archived.' : first.message };
    }
    const w = await withAllSessionsVisible(conn, CID, () => archiveSessionCore(sessionId, { ...opts, _visible: true }), { expectIds: [sessionId] });
    const r = w.result || {};
    if (r.error === 'FILTER_READ_FAILED' || r.error === 'FILTER_RELAX_FAILED') {
      return { ...first, visibility: { relaxed: false, rowFound: false, filterProblem: r.error, detail: r.detail } };
    }
    return { ...r, visibility: { ...w.visibility, rowFound: r.error !== 'NO_SUCH_SESSION' } };
  } finally { conn.close(); }
}

async function archiveSessions(ids, opts = {}) {
  const list = Array.isArray(ids) ? ids : [ids];
  const results = [];
  if (!list.length) return { ok: false, error: 'NO_SESSIONS', results };
  const conn = await connect(await wsUrl());
  try {
    const CID = await pickChat(conn);
    const known = new Map();
    for (const id of list) known.set(id, await knownToApp(conn, CID, id));
    const unknown = list.filter(id => known.get(id) !== 'row' && known.get(id) !== 'listed');
    const mounted = list.filter(id => known.get(id) === 'row');
    const hidden = list.filter(id => known.get(id) === 'listed');
    for (const id of unknown) results.push({ ok: false, error: 'NO_SUCH_SESSION', sessionId: id, message: known.get(id) === 'archived' ? 'The app lists this session as already archived.' : 'The app does not list this session id.', visibility: { relaxed: false, rowFound: false, appKnows: known.get(id) || 'no' } });
    const runCore = async (ids, relaxed) => {
      for (const id of ids) {
        let r;
        try { r = await archiveSessionCore(id, { ...opts, _visible: true }); }
        catch (e) { r = { ok: false, sessionId: id, error: 'FAILED', message: e.message }; }
        r.visibility = { relaxed, rowFound: r.error !== 'NO_SUCH_SESSION' };
        results.push(r);
      }
    };
    await runCore(mounted, false);
    let vis = { relaxed: false };
    if (hidden.length) {
      const w = await withAllSessionsVisible(conn, CID, () => runCore(hidden, true), { expectIds: hidden });
      vis = w.visibility || vis;
      if (w.result && (w.result.error === 'FILTER_READ_FAILED' || w.result.error === 'FILTER_RELAX_FAILED')) {
        for (const id of hidden) results.push({ ok: false, error: 'NO_SUCH_SESSION', sessionId: id, message: 'Row hidden by the sidebar filter and the filter could not be relaxed: ' + w.result.error, visibility: { relaxed: false, rowFound: false, filterProblem: w.result.error, detail: w.result.detail } });
      }
    }
    const order = new Map(list.map((id, i) => [id, i]));
    results.sort((a, b) => (order.get(a.sessionId) ?? 0) - (order.get(b.sessionId) ?? 0));
    return { ok: true, archived: results.filter(r => r.ok && !r.unchanged).length, attempted: list.length, results, visibility: { ...vis, unknown: unknown.length, mounted: mounted.length, hidden: hidden.length } };
  } finally { conn.close(); }
}

const CHIP_DISMISS = `
(function(){
  var card=document.querySelector('.epitaxy-notification-enter');
  if(!card) return 'no-card';
  var b=card.querySelector('button[aria-label="Dismiss suggestion"]');
  if(!b) return 'no-dismiss-button';
  ${POINTER_SEQ}
  return 'ok';
})()`;

async function dismissTask(opts = {}) {
  const conn = await connect(await wsUrl());
  try {
    const CID = await pickChat(conn);
    const nav = await ensureSessionOpen(conn, CID, opts.sessionId, opts);
    if (!nav.ok) return nav;
    try {
      let chip = await readChipSettled(conn, CID);
      if (!chip.present) {
        return { ok: false, error: 'NO_CHIP', sessionId: nav.session, markerCleared: nav.markerCleared,
                 message: 'No suggested-task chip is pending in this session.' };
      }
      if (opts.taskId) {
        const want = String(opts.taskId);
        const seen = [];
        let steps = 0;
        const guard = (chip.total || 1) + 2;
        while (chip.present && chip.taskId !== want && steps < guard) {
          seen.push(chip.taskId);
          if (!chip.hasNext) break;
          if (await conn.evaluate(rEval(CID, chipNavJs('next'))) !== 'ok') break;
          steps++;
          await sleep(500);
          chip = await readChip(conn, CID);
        }
        if (chip.taskId !== want) {
          return { ok: false, error: 'NO_SUCH_CHIP', requested: want, sessionId: nav.session,
                   chipsSeen: [...new Set(seen.concat(chip.taskId ? [chip.taskId] : []))].filter(Boolean),
                   markerCleared: nav.markerCleared };
        }
      }
      const target = { taskId: chip.taskId, title: chip.title };
      const rowsBefore = await readRows(conn, CID);
      const idsBefore = new Set(rowsBefore.map(r => r.id));

      const pressed = await conn.evaluate(rEval(CID, CHIP_DISMISS));
      if (pressed !== 'ok') {
        return { ok: false, error: 'DISMISS_FAILED', detail: pressed, ...target, sessionId: nav.session, markerCleared: nav.markerCleared };
      }
      await sleep(2500);

      const after = await readChip(conn, CID);
      const gone = !after.present || after.taskId !== target.taskId;
      const rowsAfter = await readRows(conn, CID);
      const started = rowsAfter.filter(r => !idsBefore.has(r.id) && titlesMatch(target.title, r.title));
      if (started.length) {
        return { ok: false, error: 'DISMISS_STARTED_A_SESSION', ...target, sessionId: nav.session,
                 startedSessionId: started[0].id, markerCleared: nav.markerCleared,
                 message: 'The dismiss button appears to have STARTED the task instead of discarding it. Treating this as a failure so it is not mistaken for a clean dismissal.' };
      }
      if (!gone) {
        return { ok: false, error: 'VERIFY_FAILED', ...target, sessionId: nav.session,
                 expected: 'chip removed from the queue', actual: `chip ${after.taskId} still showing`,
                 markerCleared: nav.markerCleared };
      }
      return { ok: true, taskId: target.taskId, title: target.title, sessionId: nav.session,
               dismissed: true, chipsRemaining: after.present ? (after.total || 1) : 0,
               markerCleared: nav.markerCleared,
               note: 'Verified: the chip left the queue and no session was started.' };
    } finally {
      if (nav.restore) await restoreActive(conn, CID, nav.restore);
    }
  } finally { conn.close(); }
}

const MAX_MESSAGE_CHARS = 2000000;

function composerHtml(message, maxChars = MAX_MESSAGE_CHARS) {
  const raw = String(message || '');
  if (raw.length > maxChars) throw new Error('MESSAGE_TOO_LONG:' + raw.length + '>' + maxChars);
  const text = raw;
  const html = text.split(/\r?\n/).map(line => {
    const esc = line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return '<p>' + (esc.trim() ? esc : '<br>') + '</p>';
  }).join('');
  return html.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, ' ').replace(/\$\{/g, '$ {');
}

async function clearOurDraft(conn, CID, message) {
  try {
    const probe = String(message || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!probe) return false;
    return (await conn.evaluate(rEval(CID, `
      (function(){
        var e=(window.__batonComposer && window.__batonComposer.isConnected) ? window.__batonComposer
              : document.querySelector('.tiptap.ProseMirror');
        if(!e || !e.editor) return 'no-editor';
        var txt=(e.textContent||'').replace(/\\s+/g,' ').trim();
        if(!txt) return 'empty';
        if(txt.indexOf(${JSON.stringify(probe)}) !== 0) return 'not-ours';
        try{ e.editor.commands.clearContent(); }catch(err){ return 'clear-failed'; }
        return 'cleared';
      })()`))) === 'cleared';
  } catch { return false; }
}

async function parkComposer(conn, CID, sessionId, tries = 10) {
  let last = 'no-editor';
  for (let i = 0; i < tries; i++) {
    if (i) await sleep(350);
    last = await conn.evaluate(rEval(CID, `
      (function(){
        if(location.href.split('/').pop() !== '${sessionId}') return 'nav-lost';
        var hits=function(el){
          var r=el.getBoundingClientRect();
          if(!r.width || !r.height) return false;
          var xs=[0.08,0.3,0.5,0.7,0.92], y=r.top+r.height/2;
          for(var i=0;i<xs.length;i++){
            var h=document.elementFromPoint(r.left+r.width*xs[i], y);
            if(h && el.contains(h)) return true;
          }
          return false;
        };
        window.__batonLiveBtn=function(label){
          var all=Array.from(document.querySelectorAll('button[aria-label="'+label+'"]'));
          for(var i=0;i<all.length;i++){ if(hits(all[i])) return all[i]; }
          return null;
        };
        var all=Array.from(document.querySelectorAll('.tiptap.ProseMirror')).filter(function(e){return !!e.editor;});
        if(!all.length) return 'no-editor';
        var live=all.filter(hits);
        if(live.length === 1){ window.__batonComposer = live[0]; return 'ok'; }
        if(live.length > 1) return 'ambiguous-composer';
        var top=null;
        for(var i=0;i<all.length && !top;i++){
          var r=all[i].getBoundingClientRect();
          if(r.width && r.height) top=document.elementFromPoint(r.left+r.width/2, r.top+r.height/2);
        }
        var dlg=null, n=top, d=0;
        while(n && d<25){
          var role=n.getAttribute ? n.getAttribute('role') : null;
          if(role==='dialog' || role==='alertdialog'){ dlg=n; break; }
          n=n.parentElement; d++;
        }
        var host = dlg || top;
        var choice = false;
        if (host && host.querySelectorAll) {
          var bs = host.querySelectorAll('button');
          for (var k=0; k<bs.length; k++){
            var bt = ((bs[k].textContent)||'').trim().toLowerCase();
            if (bt.indexOf('allow')===0 || bt.indexOf('deny')===0 || bt.indexOf("don't allow")===0
                || bt.indexOf('always allow')===0 || bt.indexOf('reject')===0){ choice = true; break; }
          }
        }
        window.__batonBlocker = host || null;
        var desc = null;
        if (host) {
          var r2 = host.getBoundingClientRect ? host.getBoundingClientRect() : null;
          var vw = window.innerWidth||0, vh = window.innerHeight||0;
          desc = {
            tag: (host.tagName||'').toLowerCase(),
            role: (host.getAttribute && host.getAttribute('role')) || null,
            label: (host.getAttribute && (host.getAttribute('aria-label') || host.getAttribute('data-testid'))) || null,
            cls: String(host.className||'').slice(0,120),
            w: r2 ? Math.round(r2.width) : null, h: r2 ? Math.round(r2.height) : null,
            buttons: (host.querySelectorAll ? Array.prototype.slice.call(host.querySelectorAll('button'),0,6) : [])
                       .map(function(b){ return (b.textContent||'').trim().slice(0,30); }).filter(Boolean),
            fullScreen: !!(r2 && vw && vh && r2.width >= vw*0.98 && r2.height >= vh*0.98)
          };
        }
        var modal = null;
        var cand = document.querySelectorAll('[role=dialog],[role=alertdialog]');
        for (var q=0; q<cand.length; q++){
          var c = cand[q];
          if (!(c.offsetWidth || c.offsetHeight)) continue;
          var ct = ((c.innerText)||'').split(String.fromCharCode(10)).join(' ').trim();
          if (!ct) continue;
          modal = {
            text: ct.slice(0,300),
            label: (c.getAttribute && c.getAttribute('aria-label')) || null,
            buttons: Array.prototype.slice.call(c.querySelectorAll('button'),0,6)
                       .map(function(b){ return (b.textContent||'').trim().slice(0,40); }).filter(Boolean)
          };
          break;
        }
        if (modal && modal.buttons && !choice) {
          for (var z=0; z<modal.buttons.length; z++){
            var mb = modal.buttons[z].toLowerCase();
            if (mb.indexOf('allow')===0 || mb.indexOf('deny')===0 || mb.indexOf("don't allow")===0
                || mb.indexOf('always allow')===0 || mb.indexOf('reject')===0){ choice = true; break; }
          }
        }
        return JSON.stringify({ covered:true, dialog:!!dlg || !!modal, choice:choice, desc: desc,
          modal: modal, text: ((host && host.innerText) || '').slice(0,200) });
      })()`));
    if (last === 'ok' || last === 'nav-lost') return last;
  }
  return last;
}

function classifyCover(raw) {
  if (typeof raw !== 'string' || raw.charAt(0) !== '{') return null;
  let o; try { o = JSON.parse(raw); } catch { return null; }
  if (!o || !o.covered) return null;
  const text = String(o.text || '').split(String.fromCharCode(10)).join(' ').replace(/\s+/g, ' ').trim();
  const d = o.desc;
  const m = o.modal;
  let described = text;
  if (!described && m && m.text) {
    described = m.text + (m.buttons && m.buttons.length ? ' — buttons: ' + m.buttons.join(' / ') : '');
  }
  if (!described) {
    if (d) {
      const bits = [`<${d.tag}${d.role ? ' role="' + d.role + '"' : ''}${d.label ? ' label="' + d.label + '"' : ''}>`];
      if (d.w && d.h) bits.push(`${d.w}x${d.h}`);
      if (d.fullScreen) bits.push('full-screen overlay (looks like a modal backdrop)');
      if (d.buttons && d.buttons.length) bits.push('buttons: ' + d.buttons.join(' / '));
      if (d.cls) bits.push('class="' + d.cls + '"');
      described = 'no text on the covering element — ' + bits.join(' · ');
    } else {
      described = 'no text and no element could be identified — the composer was hit-tested as covered but whatever is on top could not be described. Look at the Claude Desktop window.';
    }
  }
  return { result: o.choice ? 'blocked-by-dialog' : 'covered',
           dialog: !!o.dialog, choice: !!o.choice, blockerText: described,
           blockerHadText: !!(text || (m && m.text)), blocker: d || null,
           modal: m || null };
}

async function releaseComposer(conn, CID) {
  try { await conn.evaluate(rEval(CID, `(function(){ window.__batonComposer=null; window.__batonLiveBtn=null; window.__batonWasRunning=null; return 1; })()`)); } catch {}
}

async function cancelSession(sessionId, opts = {}) {
  if (!sessionId) return { ok: false, result: 'not-found', error: 'NO_SESSION_ID' };
  const conn = await connect(await wsUrl(), { evalTimeout: 30000 });
  const marks = [];
  let step = 'connect';
  const at = async (name, fn) => {
    step = name; const t = Date.now();
    try { return await fn(); } finally { marks.push(`${name} ${Date.now() - t}ms`); }
  };
  try {
    const CID = await at('pick-window', () => pickChat(conn));
    const { row, snap: before } = await at('find-row', () => findSessionRow(conn, CID, sessionId));
    if (!row) {
      return { ok: false, result: 'not-found', sessionId,
               message: 'No sidebar row for that session id.' };
    }
    if (!row.running) {
      return { ok: false, result: 'not-running', sessionId, status: row.status, marks,
               message: `That session is "${row.status || 'Idle'}", so there was nothing to cancel.` };
    }

    const original = before.active && before.active !== sessionId ? before.active : null;
    if (before.active === sessionId) {
      marks.push('open-session skipped (already active)');
    } else {
      const idle = await at('await-idle', () => awaitUserIdle(conn, CID));
      if (idle.waited > 300) marks.push(`waited ${idle.waited}ms for a typing gap${idle.forced ? ' (proceeded anyway)' : ''}`);
      await at('open-session', () => navTo(conn, CID, sessionId));
    }

    const found = await at('find-stop', () => conn.evaluate(rEval(CID, `
      (function(){
        if(location.href.split('/').pop() !== '${sessionId}') return 'nav-lost';
        var all=Array.from(document.querySelectorAll('button[aria-label="Stop"]'));
        for(var i=0;i<all.length;i++){
          var b=all[i], r=b.getBoundingClientRect();
          if(!r.width || !r.height) continue;
          var h=document.elementFromPoint(r.left+r.width/2, r.top+r.height/2);
          if(h && b.contains(h)){ window.__batonStop = b; return 'ok'; }
        }
        return 'no-stop';
      })()`)));

    if (found !== 'ok') {
      if (original) await restoreActive(conn, CID, original);
      if (found === 'no-stop') {
        return { ok: false, result: 'stale-label', sessionId, restored: original, marks,
                 message: 'The desktop lists this session as Running but offers no Stop control, ' +
                          'so no turn is actually in progress — the status is stale.' };
      }
      return { ok: false, result: found, sessionId, restored: original, marks };
    }

    await at('press-stop', () => conn.evaluate(rEval(CID, `
      (function(){ var b=window.__batonStop; if(!b) return 'gone';
        setTimeout(function(){ b.click(); }, 0); return 'clicked'; })()`)));

    let stopped = false;
    for (let i = 0; i < 20 && !stopped; i++) {
      await sleep(300);
      stopped = String(await conn.evaluate(rEval(CID, `
        (function(){
          var b=window.__batonStop;
          var goneFromDom = !(b && b.isConnected);
          var anyStop=Array.from(document.querySelectorAll('button[aria-label="Stop"]')).some(function(x){
            var r=x.getBoundingClientRect(); return !!(r.width && r.height);
          });
          return String(goneFromDom || !anyStop);
        })()`))) === 'true';
    }
    await at('release', () => conn.evaluate(rEval(CID, `(function(){ window.__batonStop=null; return 1; })()`)));

    const after = await at('verify', () => conn.evaluate(rEval(CID, `
      (function(){
        var r=document.querySelector('[data-row-key="code:${sessionId}"]');
        if(!r) return 'row-gone';
        var st='';
        Array.from(r.querySelectorAll('[aria-label]')).forEach(function(e){
          var l=(e.getAttribute('aria-label')||'').trim();
          if(!st && /^(idle|running|awaiting input|unread|browser open|archived|error)/i.test(l)) st=l;
        });
        return st || 'unknown';
      })()`)));

    if (original) await restoreActive(conn, CID, original);
    const stillRunning = /^running/i.test(String(after));
    return { ok: stopped && !stillRunning, result: stopped && !stillRunning ? 'cancelled' : 'unconfirmed',
             sessionId, status: String(after), restored: original, marks,
             message: stopped && !stillRunning
               ? 'The turn was stopped.'
               : `Stop was pressed but the row still reads "${after}".` };
  } catch (e) {
    throw new Error(`${e.message} at step "${step}" (${marks.join(', ') || 'no step completed'})`);
  } finally { conn.close(); }
}

async function sendQueuedNow(sessionId, opts = {}) {
  if (!sessionId) return { ok: false, result: 'not-found', error: 'NO_SESSION_ID' };
  const conn = await connect(await wsUrl(), { evalTimeout: 30000 });
  const marks = [];
  let step = 'connect';
  const at = async (name, fn) => {
    step = name; const t = Date.now();
    try { return await fn(); } finally { marks.push(name + ' ' + (Date.now() - t) + 'ms'); }
  };

  const FIND = (sid) => `
    (function(){
      if(location.href.split('/').pop() !== '${sid}') return JSON.stringify({ result:'nav-lost' });
      var hits=function(el){
        var r=el.getBoundingClientRect();
        if(!r.width || !r.height) return false;
        var xs=[0.2,0.5,0.8], y=r.top+r.height/2;
        for(var i=0;i<xs.length;i++){
          var h=document.elementFromPoint(r.left+r.width*xs[i], y);
          if(h && (el.contains(h) || h.contains(el))) return true;
        }
        return false;
      };
      var vis=function(el){ var r=el.getBoundingClientRect(); return !!(r.width && r.height); };
      var press=Array.from(document.querySelectorAll('[data-testid="awaiting-turn-send-now"]'));
      var mark=Array.from(document.querySelectorAll('button[aria-label="Remove queued message"],button[aria-label^="Cancel and edit message"]'));
      var live=press.filter(hits), liveMark=mark.filter(hits);
      if(!press.length && !mark.length)
        return JSON.stringify({ result:'no-queued-message', inDom:0, markers:0 });
      if(!press.length)
        return JSON.stringify({ result:'no-send-control', inDom:0, markers:liveMark.length });
      if(!live.length){
        if(!liveMark.length && !press.some(vis))
          return JSON.stringify({ result:'no-queued-message', inDom:press.length, markers:mark.length });
        return JSON.stringify({ result:'covered', inDom:press.length, markers:liveMark.length });
      }
      var b=live[0];
      if(b.disabled || b.getAttribute('aria-busy')==='true' || b.getAttribute('data-busy')==='true')
        return JSON.stringify({ result:'busy', inDom:press.length, markers:liveMark.length });
      var host=b, entry=null;
      for(var k=0;k<12 && host;k++){
        if(host.getAttribute && host.getAttribute('data-take-back-entry')){ entry=host.getAttribute('data-take-back-entry'); break; }
        host=host.parentElement;
      }
      window.__batonSendNow = b;
      window.__batonSendNowEntry = entry;
      return JSON.stringify({ result:'ok', inDom:press.length, markers:liveMark.length, entry:entry,
                              label:(b.innerText||'').trim().slice(0,40) });
    })()`;

  try {
    const CID = await at('pick-window', () => pickChat(conn));
    const { row, snap: before } = await at('find-row', () => findSessionRow(conn, CID, sessionId));
    if (!row) {
      return { ok: false, result: 'not-found', sessionId, marks,
               message: 'No sidebar row for that session id.' };
    }

    let navRefused = false;
    const original = before.active && before.active !== sessionId ? before.active : null;
    if (before.active === sessionId) {
      marks.push('open-session skipped (already active)');
    } else {
      const idle = await at('await-idle', () => awaitUserIdle(conn, CID));
      if (idle.waited > 300) marks.push('waited ' + idle.waited + 'ms for a typing gap' + (idle.forced ? ' (proceeded anyway)' : ''));
      const moved = await at('open-session', () => navTo(conn, CID, sessionId));
      if (!moved) { marks.push('navTo did not land'); navRefused = true; }
    }

    const stray = await at('dismiss-menus', () => dismissStrayMenus(conn, CID));
    if (stray.open) marks.push('menu still open (' + stray.open + ')');

    let found = null, empties = 0;
    for (let i = 0; i < 6; i++) {
      if (i) await sleep(300);
      found = JSON.parse(await at('find-send-now', () => conn.evaluate(rEval(CID, FIND(sessionId)))) || '{}');
      if (found.result === 'ok' || found.result === 'nav-lost') break;
      if (found.result === 'no-queued-message' && ++empties >= 2) break;
    }

    if (!found || found.result !== 'ok') {
      if (original) await restoreActive(conn, CID, original);
      const r = (found && found.result) || 'not-found';
      const message =
        r === 'no-queued-message'
          ? 'That message has already gone through — it is with the session now and will be answered '
            + 'when the current turn ends. Nothing was still waiting, so there was nothing to push.'
        : r === 'covered'
          ? 'The "Send now" control is on screen but something in the desktop is painted over it, so it was NOT pressed. Clear whatever is floating over the Claude Desktop window and try again.'
        : r === 'no-send-control'
          ? 'A message is waiting in that session, but the desktop is offering no "Send now" for it — it only offers one on the message at the head of the queue. Nothing was pressed.'
        : r === 'busy'
          ? 'The "Send now" control is already working on a press, so it was not pressed again.'
        : r === 'nav-lost'
          ? (navRefused
              ? 'Claude Desktop would not open that session — somebody is using the keyboard or mouse on the PC, and Relaymote never pulls the view out from under them. Nothing was pressed; try again in a moment.'
              : 'The desktop view moved while the control was being found; nothing was pressed.')
          : 'The "Send now" control could not be resolved in the live pane; nothing was pressed.';
      return { ok: false, result: r, sessionId, restored: original, marks, message,
               controlsInDom: found ? found.inDom : null, queueMarkers: found ? found.markers : null };
    }

    const fired = await at('press-send-now', () => conn.evaluate(rEval(CID, `
      (function(){
        var b=window.__batonSendNow;
        if(!b || !b.isConnected) return 'gone';
        if(location.href.split('/').pop() !== '${sessionId}') return 'nav-lost';
        setTimeout(function(){ try{ b.click(); }catch(e){} }, 0);
        return 'clicked';
      })()`)));

    if (fired !== 'clicked') {
      try { await conn.evaluate(rEval(CID, `(function(){ window.__batonSendNow=null; return 1; })()`)); } catch {}
      if (original) await restoreActive(conn, CID, original);
      return { ok: false, result: fired === 'nav-lost' ? 'nav-lost' : 'not-found', sessionId,
               restored: original, marks,
               message: fired === 'nav-lost'
                 ? 'The view moved between finding the control and pressing it; nothing was pressed.'
                 : 'The control was re-rendered away before it could be pressed; nothing was sent.' };
    }

    const ENTRY = found.entry ? JSON.stringify(found.entry) : 'null';
    let cleared = false;
    for (let i = 0; i < 25 && !cleared; i++) {
      await sleep(300);
      cleared = String(await conn.evaluate(rEval(CID, `
        (function(){
          if(location.href.split('/').pop() !== '${sessionId}') return 'false';
          var vis=function(el){ var r=el.getBoundingClientRect(); return !!(r.width && r.height); };
          var entry=${ENTRY};
          if(entry){
            var row=document.querySelector('[data-take-back-entry="'+entry+'"]');
            if(!row) return 'true';                       // the row itself is gone: it moved on
            return String(!row.querySelector('[data-testid="awaiting-turn-send-now"]'));
          }
          var mark=Array.from(document.querySelectorAll('button[aria-label="Remove queued message"]')).filter(vis);
          var press=Array.from(document.querySelectorAll('[data-testid="awaiting-turn-send-now"]')).filter(vis);
          return String(!mark.length && !press.length);
        })()`))) === 'true';
    }
    await at('release', () => conn.evaluate(rEval(CID, `(function(){ window.__batonSendNow=null; window.__batonSendNowEntry=null; return 1; })()`)));
    if (original) await restoreActive(conn, CID, original);

    return {
      ok: cleared, result: cleared ? 'sent' : 'unconfirmed', sessionId, restored: original, marks,
      entry: found.entry || null,
      message: cleared
        ? 'The queued message was pushed through — the desktop is no longer holding it back for the end of the turn.'
        : 'Send now was pressed but that message still reads as queued. It may still land when the turn ends — do not send it again yet.',
    };
  } catch (e) {
    throw new Error(`${e.message} at step "${step}" (${marks.join(', ') || 'no step completed'})`);
  } finally { conn.close(); }
}

async function dismissStrayMenus(conn, CID) {
  const OPEN = `(function(){
    var ms=Array.from(document.querySelectorAll('[role="menu"]')).filter(function(m){ var r=m.getBoundingClientRect(); return !!(r.width && r.height); });
    return String(ms.length);
  })()`;
  const OUTSIDE = `(function(){
    var t=document.querySelector('[data-row-key="label:recents"]') || document.querySelector('main') || document.body;
    var r=t.getBoundingClientRect();
    var o={bubbles:true,cancelable:true,clientX:r.left+8,clientY:r.top+4,button:0,isPrimary:true,pointerId:1};
    t.dispatchEvent(new PointerEvent('pointerdown',o)); t.dispatchEvent(new MouseEvent('mousedown',o));
    t.dispatchEvent(new PointerEvent('pointerup',o));   t.dispatchEvent(new MouseEvent('mouseup',o));
    document.dispatchEvent(new PointerEvent('pointerdown',o));
    return 1;
  })()`;
  let open = Number(await conn.evaluate(rEval(CID, OPEN))) || 0;
  if (!open) return { open: 0, dismissed: false };
  for (let i = 0; i < 3 && open; i++) {
    await conn.evaluate(rEval(CID, OUTSIDE));
    await sleep(400);
    open = Number(await conn.evaluate(rEval(CID, OPEN))) || 0;
  }
  if (!open) return { open: 0, dismissed: true };
  const neutralised = await conn.evaluate(rEval(CID, `
    (function(){
      var n=0;
      Array.from(document.querySelectorAll('[role="menu"]')).forEach(function(m){
        var r=m.getBoundingClientRect(); if(!(r.width && r.height)) return;
        var owner=Array.from(document.querySelectorAll('[aria-controls]')).some(function(t){ return t.getAttribute('aria-controls')===m.id; });
        if(owner) return;
        var host=m; for(var k=0;k<3 && host.parentElement && host.parentElement!==document.body; k++) host=host.parentElement;
        host.style.setProperty('display','none','important');
        host.style.setProperty('pointer-events','none','important');
        n++;
      });
      return String(n);
    })()`));
  await sleep(150);
  open = Number(await conn.evaluate(rEval(CID, OPEN))) || 0;
  return { open, dismissed: open === 0, neutralised: Number(neutralised) || 0 };
}

async function listModels(opts = {}) {
  if (!(await cdpAvailable())) return { ok: false, error: 'CDP_UNAVAILABLE' };
  const conn = await connect(await wsUrl());
  try {
    const CID = await pickChat(conn);
    const opened = await conn.evaluate(rEval(CID, `
      (function(){
        var b=document.querySelector('[data-cds="ModelSelector"]')
           || document.querySelector('[data-testid="epitaxy-cds-model-selector"]');
        if(!b || b.offsetParent===null) return 'no-trigger';
        window.__batonModelList=b;
        setTimeout(function(){ b.click(); }, 0);      // never await our own click
        return 'opening';
      })()`));
    if (opened !== 'opening') return { ok: false, error: 'NO_MODEL_PICKER' };

    let raw = '';
    for (let i = 0; i < 14 && !raw; i++) {
      await sleep(250);
      raw = String(await conn.evaluate(rEval(CID, `
        (function(){
          var b=window.__batonModelList;
          var id=(b && b.getAttribute('aria-controls'))||'';
          var m=id?document.getElementById(id):null;
          if(!m) return '';
          var out=[];
          Array.from(m.querySelectorAll('[role="menuitem"],[role="menuitemradio"]')).forEach(function(e){
            var first=e.children && e.children[0];
            var name=((first?first.textContent:e.textContent)||'').trim();
            if(!name) return;
            if(/^more models$/i.test(name)) return;          // opens a submenu, not a model
            out.push({ name:name, id:e.getAttribute('data-model-id')||'', current:e.getAttribute('aria-checked')==='true',
                       disabled:e.getAttribute('aria-disabled')==='true' });
          });
          return JSON.stringify(out);
        })()`)) || '');
    }
    await conn.evaluate(rEval(CID, `
      (function(){ var b=window.__batonModelList; if(b) setTimeout(function(){ b.click(); }, 0); return 1; })()`));
    await sleep(500);
    await dismissStrayMenus(conn, CID);
    await conn.evaluate(rEval(CID, `(function(){ window.__batonModelList=null; return 1; })()`));

    let models = [];
    try { models = JSON.parse(raw || '[]'); } catch {}
    models = models.map(m => ({ ...m, name: cleanLabel(m.name) })).filter(m => m.name);
    if (!models.length) return { ok: false, error: 'NO_MODELS_READ' };
    return { ok: true, models, current: (models.find(m => m.current) || {}).name || null };
  } catch (e) {
    return { ok: false, error: 'EXCEPTION', message: e.message };
  } finally { conn.close(); }
}

async function sendMessage(sessionId, message, opts = {}) {
  if (!sessionId) return { ok: false, result: 'not-found', error: 'NO_SESSION_ID' };
  if (!String(message || '').trim()) return { ok: false, result: 'blocked', error: 'EMPTY_MESSAGE' };
  const maxChars = opts.maxChars || MAX_MESSAGE_CHARS;
  if (String(message).length > maxChars) {
    return { ok: false, result: 'too-long', error: 'MESSAGE_TOO_LONG', length: String(message).length, max: maxChars,
             message: `Message is ${String(message).length} characters; the desktop composer path is limited to ${maxChars}. Nothing was sent.` };
  }
  const conn = await connect(await wsUrl(), { evalTimeout: 60000 });
  const marks = [];
  let step = 'connect';
  const at = async (name, fn) => {
    step = name; const t = Date.now();
    try { return await fn(); } finally { marks.push(`${name} ${Date.now() - t}ms`); }
  };
  try {
    const CID = await at('pick-window', () => pickChat(conn));
    const { row, snap: before } = await at('find-row', () => findSessionRow(conn, CID, sessionId));
    if (!row) return { ok: false, result: 'not-found', sessionId,
                       message: 'No sidebar row for that session id after walking the whole list.' };
    const markerAtRisk = row.unread ? 'Unread response' : row.awaiting ? 'Awaiting input' : null;
    if (markerAtRisk && opts.protect) {
      return { ok: false, result: 'protected', sessionId, status: row.status,
               message: `Session is "${row.status}" and protect:true was set, so no message was delivered.` };
    }
    const original = before.active && before.active !== sessionId ? before.active : null;

    if (before.active === sessionId) {
      marks.push('open-session skipped (already active)');
    } else {
      const idle = await at('await-idle', () => awaitUserIdle(conn, CID));
      if (idle.waited > 300) marks.push(`waited ${idle.waited}ms for a typing gap${idle.forced ? ' (proceeded anyway)' : ''}`);
      await at('open-session', () => navTo(conn, CID, sessionId));
    }

    const stray = await at('dismiss-menus', () => dismissStrayMenus(conn, CID));
    if (stray.open) marks.push('menu still open (' + stray.open + ')');

    let park = await at('park-composer', () => parkComposer(conn, CID, sessionId));

    let cover = classifyCover(park);
    if (cover && !cover.choice) {
      await at('uncover', () => conn.evaluate(rEval(CID, `
        (function(){
          var host = window.__batonBlocker;
          if (host && host.querySelectorAll) {
            var lbl=['Close','Dismiss','Cancel'];
            for (var i=0;i<lbl.length;i++){
              var b=host.querySelector('button[aria-label="'+lbl[i]+'"]');
              if (b){ var r=b.getBoundingClientRect(); if(r.width && r.height){ b.click(); return 'closed:'+lbl[i]; } }
            }
          }
          var all=document.querySelectorAll('[aria-label]');
          for (var j=0;j<all.length;j++){
            var l=(all[j].getAttribute('aria-label')||'').toLowerCase();
            if (l.indexOf('usage')>=0 || l.indexOf('context window')>=0){
              if (host && host.contains(all[j])) continue;   // do not click inside the panel itself
              all[j].click(); return 'toggled:usage';
            }
          }
          return 'no-handle';
        })()`)));
      await sleep(500);
      park = await at('park-retry', () => parkComposer(conn, CID, sessionId));
      cover = classifyCover(park);
    }

    if (park !== 'ok') {
      if (original) await restoreActive(conn, CID, original);
      const out = { ok: false, result: cover ? cover.result : park, sessionId,
                    markerCleared: markerAtRisk || undefined, restored: original, marks };
      if (cover) {
        out.blockerText = cover.blockerText;
        out.message = cover.dialog
          ? 'A dialog in the desktop is covering the composer, so nothing could be typed. Answer it and the message will go.'
          : 'Something is floating over the composer in the desktop and would not close.';
      }
      return out;
    }

    const html = composerHtml(message, maxChars);
    let res = await at('type-and-send', () => conn.evaluate(rEval(CID, `
      (async function(){
        var el=window.__batonComposer;
        if(!el || !el.isConnected || !el.editor) return 'no-editor';
        if(location.href.split('/').pop() !== '${sessionId}') return 'nav-lost';
        window.__batonWasRunning = !!window.__batonLiveBtn('Stop');
        if(!${opts.queue ? 'true' : 'false'} && window.__batonWasRunning) return 'busy';
        if(window.__batonLiveBtn('Remove queued message')) return 'queued';
        el.editor.commands.focus();
        el.editor.commands.setContent('${html}');
        var b=null;
        for (var i=0;i<15;i++){
          await new Promise(function(r){setTimeout(r,100);});
          b=window.__batonLiveBtn('Send');
          if(b && !b.disabled) break;
        }
        var stillLive=(function(){
          if(!el.isConnected) return false;
          var r=el.getBoundingClientRect();
          if(!r.width || !r.height) return false;
          var h=document.elementFromPoint(r.left+r.width/2, r.top+r.height/2);
          return !!(h && el.contains(h));
        })();
        if(location.href.split('/').pop() !== '${sessionId}' || !stillLive){
          try{ el.editor.commands.clearContent(); }catch(e){}
          return 'nav-lost';
        }
        if(${opts.dryRun ? 'true' : 'false'}){
          var ready=!!(b && !b.disabled);
          var typed=(el.textContent||'').trim().length;
          el.editor.commands.clearContent();
          return 'dry:'+(ready?'ready':'not-ready')+':'+typed;
        }
        if(b && !b.disabled){ window.__batonSendBtn = b; return 'ready-to-send'; }
        el.editor.commands.clearContent();
        return 'blocked';
      })()`)));

    let res2 = res;
    if (res === 'ready-to-send') {
      const fired = await at('click-send', () => conn.evaluate(rEval(CID, `
        (function(){
          var b=window.__batonSendBtn;
          if(!b || !b.isConnected) return 'gone';
          if(location.href.split('/').pop() !== '${sessionId}') return 'nav-lost';
          setTimeout(function(){ try{ b.click(); }catch(e){} }, 0);
          return 'fired';
        })()`)));
      if (fired !== 'fired') {
        res2 = fired === 'nav-lost' ? 'nav-lost' : 'blocked';
      } else {
        let done = false;
        for (let i = 0; i < 25 && !done; i++) {
          await sleep(300);
          done = (await at('confirm-send', () => conn.evaluate(rEval(CID, `
            (function(){
              var el=window.__batonComposer;
              var empty=!el || !el.textContent || !el.textContent.trim();
              var queued=!!(window.__batonLiveBtn && window.__batonLiveBtn('Remove queued message'));
              return (empty || queued) ? 'yes' : 'no';
            })()`)))) === 'yes';
        }
        res2 = done ? 'sent-tentative' : 'send-unconfirmed';
      }
    }
    res = res2;

    if (opts.dryRun) {
      await releaseComposer(conn, CID);
      if (original) await restoreActive(conn, CID, original);
      const [, verdict, typed] = String(res || '').split(':');
      return { ok: String(res || '').startsWith('dry:ready'), result: res, dryRun: true, sessionId,
               charsTyped: Number(typed) || 0, sendButtonReady: verdict === 'ready',
               markerCleared: markerAtRisk || undefined, restored: original, marks,
               note: 'Composer was filled and cleared. Nothing was sent.' };
    }

    if (res !== 'sent-tentative') {
      await clearOurDraft(conn, CID, message);
      await releaseComposer(conn, CID);
      if (original) await restoreActive(conn, CID, original);
      return { ok: false, result: res || 'blocked', sessionId, markerCleared: markerAtRisk || undefined, restored: original, marks };
    }

    for (let i = 0; i < 10; i++) {
      await sleep(i ? 200 : 150);
      const q = JSON.parse(await conn.evaluate(rEval(CID, `JSON.stringify({
        gen:!!(window.__batonLiveBtn && window.__batonLiveBtn('Stop')),
        queued:!!(window.__batonLiveBtn && window.__batonLiveBtn('Remove queued message')),
        empty:(function(){var e=window.__batonComposer;return !!(e&&e.isConnected)&&(e.textContent||'').trim().length===0;})()
      })`)));
      if (q.gen || q.queued || q.empty) break;
    }
    const after = JSON.parse(await conn.evaluate(rEval(CID, `JSON.stringify({
      active:location.href.split('/').pop(),
      gen:!!(window.__batonLiveBtn && window.__batonLiveBtn('Stop')),
      queued:!!(window.__batonLiveBtn && window.__batonLiveBtn('Remove queued message')),
      wasRunning:!!window.__batonWasRunning,
      empty:(function(){var e=window.__batonComposer;return !!(e&&e.isConnected)&&(e.textContent||'').trim().length===0;})()
    })`)));
    const landed = after.active === sessionId && (after.gen || after.queued || after.empty);
    if (!landed) await clearOurDraft(conn, CID, message);
    await releaseComposer(conn, CID);
    if (original) await restoreActive(conn, CID, original);
    const startedTheTurn = after.gen === true && after.wasRunning !== true;
    const delivery = after.queued ? 'queued'
                   : startedTheTurn ? 'generating'
                   : after.gen ? 'queued'
                   : 'accepted';
    return landed
      ? { ok: true, result: 'sent', delivery, confirmed: startedTheTurn,
          wasRunning: after.wasRunning === true,
          sessionId, markerCleared: markerAtRisk || undefined, restored: original, marks }
      : { ok: false, result: 'blocked', sessionId, markerCleared: markerAtRisk || undefined, restored: original, marks };
  } catch (e) {
    throw new Error(`${e.message} at step "${step}" (${marks.join(', ') || 'no step completed'})`);
} finally { conn.close(); }
}

async function probeSendTarget(sessionId) {
  const conn = await connect(await wsUrl());
  try {
    const CID = await pickChat(conn);
    const snap = await scrape(conn, CID);
    const row = snap.sessions.find(s => s.id === sessionId) || null;
    const composer = await conn.evaluate(rEval(CID, `(function(){
      var e=document.querySelector('.tiptap.ProseMirror');
      return JSON.stringify({editor:!!(e&&e.editor),send:!!document.querySelector('button[aria-label="Send"]')});
    })()`));
    return {
      ok: !!row,
      sessionId,
      rowFound: !!row,
      status: row ? row.status : null,
      markerAtRisk: row ? (row.unread ? 'Unread response' : row.awaiting ? 'Awaiting input' : null) : null,
      activeSession: snap.active,
      composer: JSON.parse(composer || '{}'),
      note: 'Read-only probe: no navigation, no click, nothing sent.',
    };
  } finally { conn.close(); }
}

function saveSnapshot(data) {
  const f = path.join(require('./config').STATE, 'desktop-snapshot.json');
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ at: new Date().toISOString(), ...data }, null, 2));
    fs.renameSync(tmp, f);
  } catch {}
  return data;
}

function loadSnapshot() {
  const f = path.join(require('./config').STATE, 'desktop-snapshot.json');
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}

function changedFrom(was, now) {
  if (!now) return false;
  if (now.held && !(was && was.held)) return true;
  if (!was) return !!(now.running || now.turn || now.held);
  if (was.running || was.turn) return false;
  if (now.running || now.turn) return true;
  return !!(was.at && now.at && now.at !== was.at);
}

async function sendMessageBackground(sessionId, message, opts = {}) {
  if (!sessionId) return { ok: false, result: 'not-found', error: 'NO_SESSION_ID' };
  if (!String(message || '').trim()) return { ok: false, result: 'blocked', error: 'EMPTY_MESSAGE' };
  const conn = await connect(await wsUrl());
  try {
    const CID = await pickChat(conn);
    const readState = async () => {
      const j = await conn.evaluate(rEval(CID, `
        (async function(){
          var LS=window['claude.web'].LocalSessions;
          try{
            var s=await LS.getSession(${JSON.stringify(sessionId)});
            if(!s) return '';
            return JSON.stringify({running:!!s.isRunning, turn:!!s.turnRunning, held:!!s.heldInput, at:s.lastActivityAt||''});
          }catch(e){ return ''; }
        })()`));
      return j ? JSON.parse(j) : null;
    };
    const was = await readState();
    const before = await conn.evaluate(rEval(CID, `(function(){return location.href.split('/').pop();})()`));
    const out = await conn.evaluate(rEval(CID, `
      (async function(){
        var LS = window['claude.web'] && window['claude.web'].LocalSessions;
        if(!LS || typeof LS.sendMessage!=='function') return 'NO_BRIDGE';
        try { await LS.sendMessage(${JSON.stringify(sessionId)}, ${JSON.stringify(String(message))}); }
        catch(e){ return 'THREW:'+String((e&&e.message)||e).slice(0,200); }
        return 'SENT';
      })()`));
    if (out === 'NO_BRIDGE') return { ok: false, result: 'no-bridge' };
    if (String(out).startsWith('THREW:')) return { ok: false, result: 'bridge-error', error: String(out).slice(6) };

    const t0 = Date.now();
    let seen = null;
    for (let i = 0; i < 20; i++) {
      const now = await readState();
      if (now) { seen = now; if (changedFrom(was, now)) break; }
      await sleep(150);
    }
    const after = await conn.evaluate(rEval(CID, `(function(){return location.href.split('/').pop();})()`));
    const accepted = changedFrom(was, seen);
    return {
      ok: true, result: 'sent', sessionId, transport: 'background',
      delivery: accepted ? 'generating' : 'queued',
      confirmed: accepted === true,
      accepted, state: seen, ms: Date.now() - t0,
      navigated: before !== after,
      markerCleared: undefined,
      note: accepted
        ? "Delivered through the app’s own channel — no tab switch, no marker touched, nothing interrupted."
        : "Handed to the app’s own channel; the session is mid-turn, so it is queued until that turn ends.",
    };
  } finally { conn.close(); }
}

const EFFORT_TO_CLI = { low: 'low', medium: 'medium', high: 'high', extra: 'xhigh', xhigh: 'xhigh', max: 'max' };
const CLI_TO_EFFORT = { low: 'low', medium: 'medium', high: 'high', xhigh: 'extra', max: 'max' };

/* The desktop's picker draws badges ("new") with an icon font, so a row's text can end in a Private
   Use character: "Sonnet 5.5" arrived as "Sonnet 5.5\uE08F". It showed as a box on the phone and, worse,
   never matched "Sonnet 5.5", so a switch to that model could not find its row. The rule is generic,
   so a badge on a model that ships later needs no new code point: NFKC, then drop controls (Cc),
   format characters (Cf: zero-width, bidi, soft hyphen), private use (Co, every plane) and any
   non-ASCII symbol (So/Sk: emoji and icon badges; ASCII ^ and ` are Sk too, so they are kept). */
const NOT_TEXT_RX = /[\p{Cc}\p{Cf}\p{Co}]|(?![\x00-\x7F])[\p{So}\p{Sk}]/gu;
function cleanLabel(s) {
  return String(s == null ? '' : s).normalize('NFKC').replace(/\s+/g, ' ').replace(NOT_TEXT_RX, '').replace(/\s+/g, ' ').trim();
}
function normModel(s) {
  return cleanLabel(s).toLowerCase()
    .replace(/^claude-/, '')
    .replace(/\[[^\]]*\]$/, '')
    .replace(/[\s._]+/g, '-')
    .replace(/-(20\d{6})$/, '')
    .replace(/-+$/, '');
}
// Effort by its NAME, exactly: the desktop's label ("Extra", "Extra high"), the CLI's id ("xhigh")
// and ours ("extra") are one value; "high" is never "extra high".
function normEffort(s) {
  const v = String(s || '').trim().toLowerCase().replace(/^effort:\s*/, '').replace(/[\s_-]+/g, ' ');
  if (v === 'xhigh' || v === 'extra high' || v === 'x high') return 'extra';
  if (v === 'ultra code') return 'ultracode';
  return v;
}
function sameEffort(a, b) {
  const x = normEffort(a), y = normEffort(b);
  return !!x && x === y;
}
function sameModel(a, b) {
  const x = normModel(a), y = normModel(b);
  if (!x || !y) return false;
  const bare = (v) => /^[a-z]+$/.test(v);
  if (bare(x) || bare(y)) return x.split('-')[0] === y.split('-')[0];
  return x === y;
}

// "sonnet-5-5" -> [5,5]; only ranks one family's versions against each other.
function modelVersion(norm) {
  return String(norm || '').split('-').slice(1).map(Number).filter(n => Number.isFinite(n));
}
function newerVersion(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0, y = b[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}
/**
 * The item a caller means, from the LIVE model list ({ id, label } rows read off the picker). No
 * model names are hardcoded: a specific id or label ("claude-sonnet-5-5", "Sonnet 5.5") matches by
 * normalised name, and a bare family ("sonnet") means the NEWEST of that family in the list.
 */
function chooseModel(items, want) {
  const key = normModel(cleanLabel(want));
  if (!key || !Array.isArray(items)) return null;
  if (/^[a-z]+$/.test(key)) {
    let best = null, bestV = null;
    for (const it of items) {
      const n = normModel(it.id || '') || normModel(cleanLabel(it.label));
      const nl = normModel(cleanLabel(it.label));
      const fam = n.split('-')[0] === key ? n : (nl.split('-')[0] === key ? nl : '');
      if (!fam) continue;
      const v = modelVersion(fam);
      if (!best || newerVersion(v, bestV)) { best = it; bestV = v; }
    }
    return best;
  }
  return items.find(it => (it.id && sameModel(it.id, key)) || sameModel(cleanLabel(it.label), key)) || null;
}

function modelCandidates(value) {
  const raw = String(value || '').trim();
  const out = [];
  if (/^claude-/i.test(raw) || /^[a-z]+$/i.test(raw)) out.push(raw);
  else {
    out.push('claude-' + raw.toLowerCase().replace(/[\s.]+/g, '-'));
    const fam = raw.split(/[\s\-_[]/)[0].toLowerCase();
    if (fam) out.push(fam);
  }
  return [...new Set(out)];
}

const modelChanges = new Map();

async function setTierBackground(kind, sessionId, value) {
  if (!sessionId) return { ok: false, error: 'NO_SESSION_ID' };
  const want = String(value || '').trim();
  if (!want) return { ok: false, error: kind === 'model' ? 'BAD_MODEL' : 'BAD_EFFORT' };
  const conn = await connect(await wsUrl());
  try {
    const CID = await pickChat(conn);
    const read = async () => {
      const j = await conn.evaluate(rEval(CID, `
        (async function(){
          var LS=window['claude.web'] && window['claude.web'].LocalSessions;
          if(!LS || typeof LS.getSession!=='function') return '';
          try{ var s=await LS.getSession(${JSON.stringify(sessionId)}); if(!s) return 'null';
               var ge=null; try{ ge=await LS.getEffort(${JSON.stringify(sessionId)}); }catch(e){ ge=null; }
               return JSON.stringify({model:s.model, effort:s.effort, ultracode:!!s.ultracode, running:!!s.isRunning, getEffort:ge}); }
          catch(e){ return ''; }
        })()`));
      return j && j !== 'null' ? JSON.parse(j) : (j === 'null' ? null : undefined);
    };
    const before = await read();
    if (before === undefined) return { ok: false, error: 'NO_BRIDGE' };
    if (before === null) return { ok: false, error: 'NO_BRIDGE_OR_SESSION' };

    if (kind === 'effort') {
      const label = want.toLowerCase();
      const isUltra = label === 'ultracode';
      const cli = EFFORT_TO_CLI[label];
      if (!isUltra && !cli) {
        return { ok: false, error: 'BAD_EFFORT', message: `"${want}" is not an effort level (low, medium, high, extra, max, ultracode)`, was: before.getEffort || before.effort };
      }
      const wasLevel = before.getEffort || before.effort;
      const wasLabel = before.ultracode ? 'ultracode' : (CLI_TO_EFFORT[wasLevel] || wasLevel);
      if (wasLabel === label) {
        return { ok: true, unchanged: true, sessionId, transport: 'background', effort: label, applied: wasLevel, was: wasLevel, running: before.running };
      }
      const out = await conn.evaluate(rEval(CID, `
        (async function(){
          var LS=window['claude.web'].LocalSessions;
          try{
            ${isUltra
              ? `await LS.applyFlagSettings(${JSON.stringify(sessionId)}, {ultracode:true});`
              : `${before.ultracode ? `await LS.applyFlagSettings(${JSON.stringify(sessionId)}, {ultracode:false});` : ''}
                 await LS.setEffort(${JSON.stringify(sessionId)}, ${JSON.stringify(cli)});`}
            return 'OK';
          } catch(e){ return 'THREW:'+String((e&&e.message)||e).replace(/^Error invoking remote method '[^']*': /,'').slice(0,200); }
        })()`));
      if (String(out).startsWith('THREW:')) return { ok: false, error: 'BRIDGE_ERROR', detail: String(out).slice(6), was: wasLevel };
      let after = before;
      for (let i = 0; i < 12; i++) {
        after = (await read()) || after;
        const okNow = isUltra ? after.ultracode === true : (after.getEffort === cli && !after.ultracode);
        if (okNow) break;
        await sleep(100);
      }
      const applied = after.getEffort || after.effort;
      const okFinal = isUltra ? after.ultracode === true : (after.getEffort === cli && !after.ultracode);
      if (!okFinal) {
        return { ok: false, error: 'VERIFY_FAILED', expected: isUltra ? 'ultracode' : cli, actual: after.ultracode ? 'ultracode' : applied, was: wasLevel, transport: 'background' };
      }
      return { ok: true, sessionId, transport: 'background', effort: label, applied: isUltra ? 'ultracode' : applied,
               was: wasLabel, running: before.running, confirmed: true };
    }

    const cands = modelCandidates(want);
    if (sameModel(before.model, want)) {
      return { ok: true, unchanged: true, sessionId, transport: 'background', model: before.model, was: before.model, running: before.running, confirmed: true };
    }
    let sent = null, lastErr = null;
    for (const c of cands) {
      const out = await conn.evaluate(rEval(CID, `
        (async function(){
          var LS=window['claude.web'].LocalSessions;
          try{ await LS.setModel(${JSON.stringify(sessionId)}, ${JSON.stringify(c)}); return 'OK'; }
          catch(e){ return 'THREW:'+String((e&&e.message)||e).replace(/^Error invoking remote method '[^']*': /,'').slice(0,200); }
        })()`));
      if (out === 'OK') { sent = c; break; }
      lastErr = String(out).slice(6);
      if (!/not (a )?recogni[sz]ed|not found/i.test(lastErr)) break;
    }
    if (!sent) return { ok: false, error: 'BRIDGE_ERROR', detail: lastErr, tried: cands, was: before.model };
    let after = before;
    for (let i = 0; i < 12; i++) { after = (await read()) || after; if (sameModel(after.model, want)) break; await sleep(100); }
    if (!sameModel(after.model, want)) {
      return { ok: false, error: 'VERIFY_FAILED', expected: want, sent, actual: after.model, was: before.model, transport: 'background' };
    }
    modelChanges.set(sessionId, { model: after.model, at: Date.now() });
    return {
      ok: true, sessionId, transport: 'background', model: after.model, sent, was: before.model,
      running: before.running,
      pending: !!before.running, confirmed: !before.running,
      ...(before.running ? { message: `Recorded. The turn already running finishes on ${before.model}; the next turn uses ${after.model}.` } : {}),
    };
  } finally { conn.close(); }
}

/** A session's model and effort (effort as a label: low | medium | high | extra | max | ultracode), read with no UI. */
async function readTier(sessionId) {
  if (!sessionId) return { ok: false, error: 'NO_SESSION_ID' };
  const conn = await connect(await wsUrl());
  try {
    const CID = await pickChat(conn);
    const j = await conn.evaluate(rEval(CID, `
      (async function(){
        var LS=window['claude.web'] && window['claude.web'].LocalSessions;
        if(!LS || typeof LS.getSession!=='function') return '';
        try{ var s=await LS.getSession(${JSON.stringify(sessionId)}); if(!s) return 'null';
             var ge=null; try{ ge=await LS.getEffort(${JSON.stringify(sessionId)}); }catch(e){ ge=null; }
             return JSON.stringify({model:s.model, effort:s.effort, ultracode:!!s.ultracode, running:!!s.isRunning, getEffort:ge}); }
        catch(e){ return ''; }
      })()`));
    if (!j) return { ok: false, error: 'NO_BRIDGE' };
    if (j === 'null') return { ok: false, error: 'NO_SUCH_SESSION' };
    const t = JSON.parse(j); const lvl = t.getEffort || t.effort;
    return { ok: true, sessionId, model: t.model || '', effort: t.ultracode ? 'ultracode' : (CLI_TO_EFFORT[lvl] || lvl || ''), running: t.running };
  } finally { conn.close(); }
}

async function readAppliedModel(sessionId) {
  if (!sessionId) return { ok: false, error: 'NO_SESSION_ID' };
  const conn = await connect(await wsUrl());
  try {
    const CID = await pickChat(conn);
    const j = await conn.evaluate(rEval(CID, `
      (async function(){
        var LS=window['claude.web'] && window['claude.web'].LocalSessions;
        if(!LS) return '';
        try{
          var s=await LS.getSession(${JSON.stringify(sessionId)}); if(!s) return 'null';
          var applied=null, appliedAt=null;
          for(var attempt=0; attempt<3 && applied===null; attempt++){
            try{ var t=await LS.getTranscriptTail(${JSON.stringify(sessionId)}, 40);
                 var ms=(t&&t.messages)||[]; for(var i=ms.length-1;i>=0;i--){ var m=ms[i]; if(m.type==='assistant'&&m.message&&m.message.model){ applied=m.message.model; appliedAt=m.timestamp||null; break; } } }catch(e){}
            if(applied===null && attempt<2) await new Promise(function(r){ setTimeout(r,250); });
          }
          var ge=null; try{ ge=await LS.getEffort(${JSON.stringify(sessionId)}); }catch(e){}
          return JSON.stringify({ recorded:s.model, applied:applied, appliedAt:appliedAt, effort:ge||s.effort, ultracode:!!s.ultracode, running:!!s.isRunning });
        } catch(e){ return ''; }
      })()`));
    if (!j) return { ok: false, error: 'NO_BRIDGE' };
    if (j === 'null') return { ok: false, error: 'NO_SUCH_SESSION' };
    const r = JSON.parse(j);
    return Object.assign({ ok: true, sessionId }, r, {
      effortLabel: r.ultracode ? 'ultracode' : (CLI_TO_EFFORT[r.effort] || r.effort),
      modelPending: (() => {
        const ch = modelChanges.get(sessionId);
        if (ch && sameModel(ch.model, r.recorded)) {
          const t = r.appliedAt ? Date.parse(r.appliedAt) : NaN;
          if (Number.isFinite(t) && t > ch.at && sameModel(r.applied, r.recorded)) { modelChanges.delete(sessionId); return false; }
          return true;
        }
        return r.applied ? !!(r.recorded && !sameModel(r.applied, r.recorded)) : !!r.running;
      })(),
    });
  } finally { conn.close(); }
}

function mintMessageUuid() {
  return require('crypto').randomUUID();
}

async function sendQueued(sessionId, text) {
  if (!sessionId) return { ok: false, error: 'NO_SESSION_ID' };
  const body = String(text || '');
  if (!body.trim()) return { ok: false, error: 'EMPTY' };
  const uuid = mintMessageUuid();
  const conn = await connect(await wsUrl());
  try {
    const CID = await pickChat(conn);
    const out = await conn.evaluate(rEval(CID, `
      (async function(){
        var LS=window['claude.web'] && window['claude.web'].LocalSessions;
        if(!LS || typeof LS.sendMessage!=='function') return 'NO_BRIDGE';
        try{
          var s=await LS.getSession(${JSON.stringify(sessionId)}); if(!s) return 'NO_SUCH_SESSION';
          var running=!!s.isRunning;
          await LS.sendMessage(${JSON.stringify(sessionId)}, ${JSON.stringify(body)}, undefined, undefined, undefined, undefined, undefined, ${JSON.stringify(uuid)});
          return JSON.stringify({ ok:true, running:running });
        } catch(e){ return 'THREW:'+String((e&&e.message)||e).replace(/^Error invoking remote method '[^']*': /,'').slice(0,200); }
      })()`));
    if (out === 'NO_BRIDGE') return { ok: false, error: 'NO_BRIDGE' };
    if (out === 'NO_SUCH_SESSION') return { ok: false, error: 'NO_SUCH_SESSION' };
    if (String(out).startsWith('THREW:')) return { ok: false, error: 'BRIDGE_ERROR', detail: String(out).slice(6) };
    const r = JSON.parse(out);
    return { ok: true, uuid, transport: 'bridge', running: r.running, delivery: r.running ? 'held' : 'generating' };
  } finally { conn.close(); }
}

async function cancelQueued(sessionId, uuid) {
  if (!sessionId || !uuid) return { ok: false, error: 'NO_UUID' };
  const conn = await connect(await wsUrl());
  try {
    const CID = await pickChat(conn);
    const out = await conn.evaluate(rEval(CID, `
      (async function(){
        var LS=window['claude.web'].LocalSessions;
        try{ var r=await LS.cancelQueuedMessage(${JSON.stringify(sessionId)}, ${JSON.stringify(uuid)}); return JSON.stringify({ ok:true, cancelled: r===true }); }
        catch(e){ return 'THREW:'+String((e&&e.message)||e).slice(0,200); }
      })()`));
    if (String(out).startsWith('THREW:')) return { ok: false, error: 'BRIDGE_ERROR', detail: String(out).slice(6) };
    const r = JSON.parse(out);
    return r.cancelled
      ? { ok: true, cancelled: true }
      : { ok: false, error: 'ALREADY_SENT', alreadySent: true, message: 'Already sent -- it was delivered when the turn ended, so there was nothing to take back.' };
  } finally { conn.close(); }
}

async function sendQueuedNowByUuid(sessionId, uuid) {
  if (!sessionId || !uuid) return { ok: false, error: 'NO_UUID' };
  const conn = await connect(await wsUrl());
  try {
    const CID = await pickChat(conn);
    const out = await conn.evaluate(rEval(CID, `
      (async function(){
        var LS=window['claude.web'].LocalSessions;
        try{
          var promoted=await LS.promoteQueuedMessage(${JSON.stringify(sessionId)}, ${JSON.stringify(uuid)});
          if(promoted!==true) return JSON.stringify({ ok:false, error:'TOO_LATE' });
          var s=await LS.getSession(${JSON.stringify(sessionId)});
          if(s && s.isRunning) await LS.interrupt(${JSON.stringify(sessionId)});
          return JSON.stringify({ ok:true, interrupted: !!(s && s.isRunning) });
        } catch(e){ return 'THREW:'+String((e&&e.message)||e).slice(0,200); }
      })()`));
    if (String(out).startsWith('THREW:')) return { ok: false, error: 'BRIDGE_ERROR', detail: String(out).slice(6) };
    const r = JSON.parse(out);
    if (!r.ok) return { ok: false, error: 'ALREADY_SENT', alreadySent: true, message: 'Already sent -- it was delivered when the turn ended. Nothing was sent twice.' };
    return { ok: true, interrupted: r.interrupted, transport: 'bridge' };
  } finally { conn.close(); }
}

const FAST_REASON_TEXT = {
  free: 'Fast mode requires a paid subscription.',
  preference: 'Fast mode has been disabled by your organization.',
  extra_usage_disabled: 'Fast mode requires usage credits — turn them on with /usage-credits.',
  network_error: 'Fast mode is unavailable due to network connectivity issues.',
  unknown: 'Fast mode is currently unavailable.',
  not_first_party: 'Fast mode is only available when using the Anthropic API directly.',
  disabled_by_env: 'Fast mode is not available here.',
  model_not_allowed: 'Fast mode is not offered on this model.',
};
const FAST_SOFT_REASONS = new Set(['sdk_opt_in_required', 'pending']);

const fastReadJs = (sessionId) => `
  (async function(){
    var LS = window['claude.web'] && window['claude.web'].LocalSessions;
    if (!LS || typeof LS.getSession !== 'function') return '';
    try {
      var s = await LS.getSession(${JSON.stringify(sessionId)});
      if (!s) return 'null';
      return JSON.stringify({
        state: s.fastModeState, reason: s.fastModeDisabledReason,
        offByCredits: s.fastModeOffByCredits, model: s.model,
        running: !!s.isRunning, neverStarted: !!s.neverStarted
      });
    } catch (e) { return ''; }
  })()`;

function describeFast(raw) {
  const state = raw && raw.state !== undefined && raw.state !== null ? String(raw.state) : null;
  const reason = raw && raw.reason !== undefined && raw.reason !== null ? String(raw.reason) : null;
  const loaded = state !== null;
  const on = state === 'on' || state === 'cooldown';
  const blocked = !!(reason && !FAST_SOFT_REASONS.has(reason));
  let message = '';
  if (!loaded) {
    message = raw && raw.neverStarted
      ? 'This session has not started yet — send it something first, then fast mode can be switched.'
      : 'Claude Desktop is not holding this session open, so fast mode cannot be read or changed. Open the session once and it will work.';
  } else if (blocked) {
    message = FAST_REASON_TEXT[reason] || ('Fast mode is unavailable (' + reason + ').');
  } else if (state === 'cooldown') {
    message = 'On, but paused after a rate limit — it resumes on its own.';
  } else if (reason === 'pending') {
    message = 'Claude is still checking whether fast mode is available.';
  }
  return {
    state, reason, on, loaded, blocked, message,
    model: (raw && raw.model) || null,
    running: !!(raw && raw.running),
    offByCredits: raw ? raw.offByCredits : undefined,
  };
}

function fastSummary(desc) {
  if (!desc || !desc.loaded) return 'unknown';
  if (desc.blocked) return 'unavailable';
  return desc.on ? 'on' : 'off';
}

let startDefaultsCache = { at: 0, value: null };
async function readStartDefaults() {
  if (Date.now() - startDefaultsCache.at < 60000 && startDefaultsCache.value) return startDefaultsCache.value;
  const conn = await connect(await wsUrl());
  try {
    const CID = await pickChat(conn);
    const out = await conn.evaluate(rEval(CID, `
      (async function(){
        var LS=window['claude.web'] && window['claude.web'].LocalSessions; if(!LS) return 'NO_BRIDGE';
        var model=null; try{ model=localStorage.getItem('default-model'); }catch(e){}
        var effort=null; try{ effort=await LS.getDefaultEffort(); }catch(e){}
        return JSON.stringify({ model:model||null, effort:effort||null });
      })()`));
    if (out === 'NO_BRIDGE') return { ok: false, error: 'NO_BRIDGE' };
    const r = JSON.parse(out);
    const v = { ok: true, model: r.model, effort: CLI_TO_EFFORT[r.effort] || r.effort || 'medium', effortSource: r.effort ? 'settings' : 'cli-default' };
    startDefaultsCache = { at: Date.now(), value: v };
    return v;
  } finally { conn.close(); }
}

async function readFastModeAll() {
  const conn = await connect(await wsUrl());
  try {
    const CID = await pickChat(conn);
    const j = await conn.evaluate(rEval(CID, `
      (async function(){
        var LS = window['claude.web'] && window['claude.web'].LocalSessions;
        if (!LS || typeof LS.getAll !== 'function') return '';
        try {
          var all = await LS.getAll();
          var out = {};
          for (var i=0;i<all.length;i++){
            var s = all[i];
            if (s.fastModeState === undefined) continue;   // process retired: nothing to report
            out[s.sessionId] = { state: s.fastModeState, reason: s.fastModeDisabledReason,
                                 offByCredits: s.fastModeOffByCredits, model: s.model,
                                 running: !!s.isRunning, neverStarted: !!s.neverStarted };
          }
          return JSON.stringify({ total: all.length, loaded: Object.keys(out).length, sessions: out });
        } catch (e) { return ''; }
      })()`));
    if (!j) return { ok: false, error: 'NO_BRIDGE', message: 'Claude Desktop did not answer — the desktop link is down.' };
    const raw = JSON.parse(j);
    const byId = {};
    for (const [id, r] of Object.entries(raw.sessions)) {
      const d = describeFast(r);
      byId[id] = Object.assign({ fastMode: fastSummary(d) }, d);
    }
    return { ok: true, total: raw.total, loadedCount: raw.loaded, byId };
  } finally { conn.close(); }
}

async function readFastMode(sessionId) {
  if (!sessionId) return { ok: false, error: 'NO_SESSION_ID' };
  const conn = await connect(await wsUrl());
  try {
    const CID = await pickChat(conn);
    const j = await conn.evaluate(rEval(CID, fastReadJs(sessionId)));
    if (!j) return { ok: false, error: 'NO_BRIDGE', message: 'Claude Desktop did not answer — the desktop link is down.' };
    if (j === 'null') return { ok: false, error: 'NO_SUCH_SESSION', sessionId };
    return Object.assign({ ok: true, sessionId }, describeFast(JSON.parse(j)));
  } finally { conn.close(); }
}

async function setFastMode(sessionId, on, opts = {}) {
  if (!sessionId) return { ok: false, error: 'NO_SESSION_ID' };
  const want = !!on;
  const waitMs = Number(opts.waitMs) > 0 ? Number(opts.waitMs) : 4000;
  const conn = await connect(await wsUrl());
  try {
    const CID = await pickChat(conn);
    const read = async () => {
      const j = await conn.evaluate(rEval(CID, fastReadJs(sessionId)));
      if (!j) return undefined;
      return j === 'null' ? null : describeFast(JSON.parse(j));
    };

    const before = await read();
    if (before === undefined) return { ok: false, error: 'NO_BRIDGE', message: 'Claude Desktop did not answer — the desktop link is down.' };
    if (before === null) return { ok: false, error: 'NO_SUCH_SESSION', sessionId };
    if (!before.loaded) return Object.assign({ ok: false, error: 'SESSION_NOT_LOADED' }, before);

    const optedIn = before.on || (before.reason !== null && before.reason !== 'sdk_opt_in_required');
    if (optedIn === want && before.on === want) {
      return Object.assign({ ok: true, unchanged: true, confirmed: true, asked: want, was: before.state }, before);
    }

    const out = await conn.evaluate(rEval(CID, `
      (async function(){
        var LS = window['claude.web'].LocalSessions;
        try { await LS.setFastMode(${JSON.stringify(sessionId)}, ${want ? 'true' : 'false'}); return 'OK'; }
        catch (e) { return 'THREW:' + String((e && e.message) || e).slice(0, 200); }
      })()`));
    if (String(out || '').startsWith('THREW:')) {
      return Object.assign({ ok: false, error: 'BRIDGE_ERROR' }, before, { message: String(out).slice(6) });
    }
    if (out !== 'OK') {
      return Object.assign({ ok: false, error: 'NO_BRIDGE' }, before, { message: 'Claude Desktop did not answer the write.' });
    }

    let after = before;
    const t0 = Date.now();
    for (;;) {
      const now = await read();
      if (now && now.loaded) {
        after = now;
        if (now.on === want || now.state !== before.state || now.reason !== before.reason) break;
      }
      if (Date.now() - t0 >= waitMs) break;
      await sleep(300);
    }

    const confirmed = after.on === want;
    if (want && !confirmed && after.blocked) {
      return Object.assign({ ok: false, error: 'FAST_UNAVAILABLE', asked: want, was: before.state }, after);
    }
    return Object.assign({ ok: true, asked: want, was: before.state }, after, confirmed
      ? { confirmed: true, pending: false }
      : { confirmed: false, pending: true,
          message: 'Claude Desktop accepted it. The session reports fast mode when its next turn ends, so it will confirm then.' });
  } finally { conn.close(); }
}

let idle = require('./idle');
function _setIdleProbe(p) { const prev = idle; idle = p || require('./idle'); return prev; }
const idleMinMs = () => Number(process.env.RELAYMOTE_IDLE_MIN_MS ?? (require('./config').get().idleGateSeconds * 1000));
const IDLE_MAX_WAIT_MS = Number(process.env.RELAYMOTE_IDLE_MAX_WAIT_MS ?? 240000);
const IDLE_RETRIES = Number(process.env.RELAYMOTE_IDLE_RETRIES ?? 1);

async function sidebarSnapshot() {
  try {
    const conn = await connect(await wsUrl());
    try {
      const CID = await pickChat(conn);
      const view = await readSidebarView(conn, CID, { labelsOnly: true });
      const active = String(await conn.evaluate(rEval(CID, `location.href.split('/').pop()`)) || '');
      return { view, active };
    } finally { conn.close(); }
  } catch { return null; }
}
async function sidebarRestore(snap, name) {
  if (!snap) return { checked: false };
  try {
    const conn = await connect(await wsUrl());
    try {
      const CID = await pickChat(conn);
      const out = { checked: true, viewBefore: snap.view, activeBefore: snap.active };
      let view = await readSidebarView(conn, CID, { labelsOnly: true });
      if (snap.view !== 'unknown' && view !== snap.view) {
        let attempts = 0;
        for (; attempts < 3 && view !== snap.view; attempts++) {
          const r = await groupByMenu(conn, CID, snap.view);
          view = await readSidebarView(conn, CID, { labelsOnly: true });
          if (r && r.error) out.viewRestoreDetail = r.error;
        }
        out.viewRestoreAttempts = attempts;
        out.viewRestored = view === snap.view;
        if (!out.viewRestored) console.error(`[sidebar-guard] ${name}: could not restore the Group-by view to "${snap.view}" (it is "${view}")`);
      }
      let active = String(await conn.evaluate(rEval(CID, `location.href.split('/').pop()`)) || '');
      if (/^local_/.test(snap.active) && active !== snap.active) {
        await restoreActive(conn, CID, snap.active);
        active = String(await conn.evaluate(rEval(CID, `location.href.split('/').pop()`)) || '');
        out.activeRestored = active === snap.active;
        if (!out.activeRestored) console.error(`[sidebar-guard] ${name}: could not return to session ${snap.active} (on ${active})`);
      }
      await closeAllMenus(conn, CID);
      out.viewAfter = view; out.activeAfter = active;
      return out;
    } finally { conn.close(); }
  } catch (e) { return { checked: false, error: e.message }; }
}
async function guarded(name, fn, args) {
  const snap = await sidebarSnapshot();
  let out, err;
  try { out = await fn(...args); } catch (e) { err = e; }
  const restore = await sidebarRestore(snap, name);
  if (err) throw err;
  if (out && typeof out === 'object' && !Array.isArray(out) && (restore.viewRestored !== undefined || restore.activeRestored !== undefined)) out.sidebar = restore;
  return out;
}

function gated(name, fn) {
  return async function (...args) {
    const opts = args.length && args[args.length - 1] && typeof args[args.length - 1] === 'object'
      ? args[args.length - 1] : {};
    const min = opts.idleMinMs !== undefined ? opts.idleMinMs : idleMinMs();
    if (opts.idle === false || !(min > 0)) return guarded(name, fn, args);

    const maxWait = opts.idleMaxWaitMs !== undefined ? opts.idleMaxWaitMs : IDLE_MAX_WAIT_MS;
    const gateStart = Date.now();
    let waitedMs = 0, attempts = 0, wasInterrupted = false;

    for (let attempt = 0; attempt <= IDLE_RETRIES; attempt++) {
      while (!idle.isIdle(min)) {
        if (Date.now() - gateStart > maxWait) {
          const ms = idle.idleMs();
          let queued = null;
          try { queued = require('./uiqueue').enqueue(name, args.slice(0, -1).length ? args.slice(0, -1) : args, {}); } catch {}
          return {
            ok: false, error: 'USER_ACTIVE', action: name,
            queued: queued ? { id: queued.id, willRunAtNextIdleWindow: true } : undefined,
            idleMs: ms, requiredIdleMs: min, waitedMs: Date.now() - gateStart,
            message: ms === null
              ? 'Could not tell whether the user is active (idle probe unavailable), so nothing was done. Pass idle:false to act anyway.'
              : 'The user has been active the whole time, so this was NOT performed rather than interrupting them. It is safe to call again later; nothing was half-done.',
          };
        }
        await sleep(500);
      }
      waitedMs = Date.now() - gateStart;

      const before = idle.idleMs();
      const t0 = Date.now();
      const out = await guarded(name, fn, args);
      const after = idle.idleMs();
      const elapsed = Date.now() - t0;
      const interrupted = before !== null && after !== null && after < before + elapsed - 1500;
      attempts = attempt + 1;

      if (!interrupted) {
        return (out && typeof out === 'object')
          ? { ...out, idleWaitedMs: waitedMs, attempts, ...(wasInterrupted ? { retriedAfterInterruption: true } : {}) }
          : out;
      }
      wasInterrupted = true;
      if (out && typeof out === 'object' && out.ok) {
        return { ...out, idleWaitedMs: waitedMs, attempts, interruptedByUser: true,
                 note: 'The user typed or moved the mouse during this action, but it verified anyway.' };
      }
      if (attempt === IDLE_RETRIES) {
        return (out && typeof out === 'object')
          ? { ...out, idleWaitedMs: waitedMs, attempts, interruptedByUser: true,
              message: 'Interrupted by user input on every attempt; reported as interrupted rather than as a defect. Retry when they are away from the machine.' }
          : out;
      }
    }
  };
}

module.exports = {
  sameModel, normModel, cleanLabel, chooseModel, sameEffort, normEffort, modelMatcher,
  changedFrom,
  markRead,
  scrapeSidebar, cdpAvailable, mergeSessions, groupSessions, needsAttention,
  saveSnapshot, loadSnapshot, ARCHIVE_RULES, connect, wsUrl, pickChat, rEval,
  setGroup: gated('setGroup', setGroup),
  setModel: async (sessionId, model, opts = {}) => {
    // A bare family ("sonnet") means the NEWEST of it in the live picker list, sent as that item's
    // own id; Desktop's own alias may resolve to an older default.
    if (/^[a-z]+$/i.test(String(model || '').trim()) && opts.resolveAlias !== false) {
      const live = await listModels().catch(() => null);
      const hit = live && live.ok ? chooseModel(live.models.map(m => ({ id: m.id, label: m.name })), model) : null;
      if (hit && hit.id) model = hit.id;
    }
    if (opts.transport !== 'picker') {
      const bg = await setTierBackground('model', sessionId, model);
      if (bg.ok) return bg;
      if (bg.error !== 'NO_BRIDGE' && bg.error !== 'NO_BRIDGE_OR_SESSION') return bg;
      var why = bg.error;
    }
    const out = await gated('setModel', setModel)(sessionId, model, opts);
    return (out && typeof out === 'object') ? { ...out, transport: 'picker', ...(why ? { backgroundUnavailable: why } : {}) } : out;
  },
  setEffort: async (sessionId, effort, opts = {}) => {
    if (opts.transport !== 'picker') {
      const bg = await setTierBackground('effort', sessionId, effort);
      if (bg.ok) return bg;
      if (bg.error !== 'NO_BRIDGE' && bg.error !== 'NO_BRIDGE_OR_SESSION') return bg;
      var why = bg.error;
    }
    const out = await gated('setEffort', setEffort)(sessionId, effort, opts);
    return (out && typeof out === 'object') ? { ...out, transport: 'picker', ...(why ? { backgroundUnavailable: why } : {}) } : out;
  },
  setTierBackground, readAppliedModel, readTier, EFFORT_TO_CLI, CLI_TO_EFFORT,
  sendQueued, cancelQueued, sendQueuedNowByUuid, readStartDefaults,
  readFastMode, setFastMode, readFastModeAll, fastSummary, describeFast, FAST_REASON_TEXT,
  // A chip inherits the starter's model and effort: tier-policy puts the default on first (g551).
  startTask: (opts = {}) => require('./tier-policy').withStarterTier(opts.sessionId, () => gated('startTask', startTaskRetrying)(opts)),
  startAllTasks: gated('startAllTasks', startAllTasks),
  dismissTask: gated('dismissTask', dismissTask),
  listChipTasks: async (sessionId, opts = {}) => {
    if (opts.transport !== 'dom') {
      const bg = await listChipTasksBackground(sessionId);
      if (bg.ok) return bg;
      var why = bg.error;
      if (bg.error === 'NO_SUCH_SESSION') return bg;
    }
    const out = await gated('listChipTasks', listChipTasks)(sessionId, opts);
    return (out && typeof out === 'object') ? { ...out, transport: 'dom', ...(why ? { backgroundUnavailable: why } : {}) } : out;
  },
  listChipTasksBackground, allChipQueues, blockedSessions, sessionForChip, haltSession,
  archiveSession: gated('archiveSession', archiveSession),
  archiveSessions: gated('archiveSessions', archiveSessions),
  archiveSessionsNow: archiveSessions,
  renameSession: gated('renameSession', renameSession),
  sendMessage: async (sessionId, message, opts = {}) => {
    if (opts.transport !== 'composer') {
      try {
        const bg = await sendMessageBackground(sessionId, message, opts);
        if (bg.ok) return bg;
        if (bg.error === 'NO_SESSION_ID' || bg.error === 'EMPTY_MESSAGE') return bg;
        var bgFailure = bg.result || bg.error;
      } catch (e) { var bgFailure = 'threw:' + e.message; }
    }
    const out = await gated('sendMessage', sendMessage)(sessionId, message, opts);
    return (out && typeof out === 'object')
      ? { ...out, transport: 'composer', ...(typeof bgFailure === 'undefined' ? {} : { backgroundUnavailable: bgFailure }) }
      : out;
  },
  sendMessageBackground,
  setGroupNow: setGroup, setModelNow: setModel, setEffortNow: setEffort,
  startTaskNow: startTask, archiveSessionNow: archiveSession, sendMessageNow: sendMessage,
  idleMs: (...a) => idle.idleMs(...a), isIdle: (...a) => idle.isIdle(...a), gated, _setIdleProbe,
  EFFORT_VALUES, closeMenus, restoreActive, classifyCover, parkComposer, cancelSession, sendQueuedNow, listModels, dismissStrayMenus, awaitUserIdle, navTo, SCRAPE_JS, serializeUi, buildCwdMap, lookupCwd, cwdMatches, projectSlugMap, syncCwd, loadCwdCache,
  CHIP_MODES, titlesMatch, titleKey,

  probeSendTarget, composerHtml, clearOurDraft, revealRow, findSessionRow, routeTo, groupLabelKeyFor, readGroupConfig, readSidebarView, groupByMenu, withGroupView, closeAllMenus, scrape, decorateGroups, sidebarSnapshot, sidebarRestore, guarded, knownToApp, routeRecover, filterMenu, withAllSessionsVisible, settleSidebar, viewSentinel, readSidebarPref, writeSidebarPref, recentUiAction, waitFor, closeMenus, openRowMenuLive, findRowSettling, ensureSessionOpen, restoreActive,
  confirmAttentionStates, _resetAttentionHistory, openRowMenuLive, parkComposer, releaseComposer,
};
