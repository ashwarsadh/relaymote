'use strict';
const desktop = require('../lib/desktop');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const CLEAN = `function relaymoteClean(e){ return (e&&e.textContent||'').replace(/[\\u200B-\\u200D\\uFEFF\\u00AD\\u2060\\uE000-\\uF8FF]/g,'').trim(); }`;
const PTR = `function relaymotePtr(el){
  el.scrollIntoView({block:'center',behavior:'instant'});
  var r=el.getBoundingClientRect();
  var o={bubbles:true,cancelable:true,clientX:r.left+r.width/2,clientY:r.top+r.height/2,button:0,isPrimary:true,pointerId:1,pointerType:'mouse'};
  ['pointerover','pointerenter','pointerdown','mousedown','pointerup','mouseup','click'].forEach(function(t){
    el.dispatchEvent(new (t.indexOf('pointer')===0?PointerEvent:MouseEvent)(t,o));
  });
}`;

const EXPAND_JS = `(function(){ ${CLEAN} ${PTR}
  var b = Array.from(document.querySelectorAll('button,[role=button]')).filter(function(e){
    if (e.offsetParent === null) return false;
    var t = relaymoteClean(e).toLowerCase();
    return t.indexOf('running task') > 0 && parseInt(t, 10) > 0;
  })[0];
  if(!b) return '0';
  var n = parseInt(relaymoteClean(b), 10) || 0;
  var alreadyOpen = Array.from(document.querySelectorAll('button')).some(function(x){
    return x.offsetParent !== null &&
           (x.getAttribute('aria-label')||'').toLowerCase().indexOf('stop this task') >= 0;
  });
  if (!alreadyOpen) relaymotePtr(b);
  return String(n);
})()`;

const LIST_JS = `(function(){ ${CLEAN}
  var stops = Array.from(document.querySelectorAll('button')).filter(function(b){
    return b.offsetParent !== null && (b.getAttribute('aria-label')||'').toLowerCase().indexOf('stop this task') >= 0;
  });
  var out = stops.map(function(b, i){
    var n = b.parentElement, label = '';
    for (var k = 0; k < 6 && n; k++) {
      var t = relaymoteClean(n);
      if (t && t.length > 2) { label = t; break; }
      n = n.parentElement;
    }
    var half = label.length / 2;
    if (label.length > 6 && label.length % 2 === 0 &&
        label.slice(0, half) === label.slice(half)) label = label.slice(0, half);
    return { index: i, label: label.slice(0, 140) };
  });
  return JSON.stringify({ tasks: out });
})()`;

const stopJs = (i) => `(function(){ ${CLEAN} ${PTR}
  var stops = Array.from(document.querySelectorAll('button')).filter(function(b){
    return b.offsetParent !== null && (b.getAttribute('aria-label')||'').toLowerCase().indexOf('stop this task') >= 0;
  });
  if(!stops[${i}]) return 'not-found';
  relaymotePtr(stops[${i}]);
  return 'stopped';
})()`;

async function withSession(sessionId, fn) {
  const conn = await desktop.connect(await desktop.wsUrl());
  let CID, original = null;
  try {
    CID = await desktop.pickChat(conn);
    const here = String(await conn.evaluate(desktop.rEval(CID, `location.href.split('/').pop()`)));
    original = here.startsWith('local_') ? here : null;
    if (here !== sessionId) {
      const found = await desktop.findSessionRow(conn, CID, sessionId);
      if (!found.row) return { ok: false, error: 'NO_SUCH_SESSION' };
      await conn.evaluate(desktop.rEval(CID, `
        (function(){
          var b=document.querySelector('[data-row-key="code:${sessionId}"] [data-row-main-button]');
          if(!b) return 'not-found';
          b.scrollIntoView({block:'center',behavior:'instant'}); b.click(); return 'ok';
        })()`));
      await sleep(2600);
    }
    return await fn(conn, CID);
  } catch (e) {
    return { ok: false, error: 'EXCEPTION', message: e.message };
  } finally {
    try { if (original) await desktop.restoreActive(conn, CID, original); } catch {}
    conn.close();
  }
}

async function readRunningTasks(sessionId) {
  return withSession(sessionId, async (conn, CID) => {
    const count = Number(await conn.evaluate(desktop.rEval(CID, EXPAND_JS))) || 0;
    if (!count) return { ok: true, count: 0, tasks: [] };
    await sleep(1400);
    let tasks = [];
    try { tasks = (JSON.parse(await conn.evaluate(desktop.rEval(CID, LIST_JS)) || '{}').tasks) || []; } catch {}
    await desktop.closeMenus(conn, CID);
    return { ok: true, count, tasks };
  });
}

async function stopRunningTask(sessionId, index = 0) {
  return withSession(sessionId, async (conn, CID) => {
    const count = Number(await conn.evaluate(desktop.rEval(CID, EXPAND_JS))) || 0;
    if (!count) return { ok: false, error: 'NOTHING_RUNNING' };
    await sleep(1400);
    const r = await conn.evaluate(desktop.rEval(CID, stopJs(index)));
    await sleep(1200);
    const left = Number(await conn.evaluate(desktop.rEval(CID, EXPAND_JS))) || 0;
    await desktop.closeMenus(conn, CID);
    return r === 'stopped' ? { ok: true, remaining: left } : { ok: false, error: 'STOP_NOT_FOUND' };
  });
}

module.exports = { readRunningTasks, stopRunningTask };
