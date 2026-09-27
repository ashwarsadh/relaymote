'use strict';
const desktop = require('../lib/desktop');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const CLEAN = `function batonClean(e){ return (e&&e.textContent||'').replace(/[\\u200B-\\u200D\\uFEFF\\u00AD\\u2060\\uE000-\\uF8FF]/g,'').trim(); }`;
const PTR = `function batonPtr(el){
  el.scrollIntoView({block:'center',behavior:'instant'});
  var r=el.getBoundingClientRect();
  var o={bubbles:true,cancelable:true,clientX:r.left+r.width/2,clientY:r.top+r.height/2,button:0,isPrimary:true,pointerId:1,pointerType:'mouse'};
  ['pointerover','pointerenter','pointerdown','mousedown','pointerup','mouseup','click'].forEach(function(t){
    el.dispatchEvent(new (t.indexOf('pointer')===0?PointerEvent:MouseEvent)(t,o));
  });
}`;
const BOX = `function batonBox(){
  var dismiss = Array.from(document.querySelectorAll('button')).filter(function(b){
    return b.getAttribute('aria-label')==='Dismiss question' && b.offsetParent!==null; })[0];
  if(!dismiss) return null;
  var box = dismiss;
  for (var i=0;i<20 && box;i++){
    var hasConfirm = Array.from(box.querySelectorAll('button')).some(function(b){
      return /^(submit|next|skip)$/i.test(batonClean(b)); });
    if (hasConfirm) return box;
    box = box.parentElement;
  }
  return null;
}`;
const CHROME_RX = `var RELAYMOTE_CHROME = /^(back|skip|submit|next)$/i;`;
const OPTIONS = `function batonOptions(){
  var box = batonBox(); if(!box) return [];
  return Array.from(box.querySelectorAll('button')).filter(function(b){
    if (b.offsetParent === null) return false;
    if (b.getAttribute('aria-label')) return false;      // chrome is aria-labelled, options are not
    var t = batonClean(b);
    return t && !RELAYMOTE_CHROME.test(t);
  });
}`;
const CHROME = `function batonChrome(name){
  var box = batonBox(); if(!box) return null;
  return Array.from(box.querySelectorAll('button')).filter(function(b){
    return b.offsetParent !== null && batonClean(b).toLowerCase() === name;
  })[0] || null;
}`;

const STATE_JS = `(function(){ ${CLEAN} ${CHROME_RX} ${BOX} ${OPTIONS} ${CHROME}
  var dismiss = Array.from(document.querySelectorAll('button')).filter(function(b){
    return b.getAttribute('aria-label')==='Dismiss question' && b.offsetParent!==null; })[0];
  if(!dismiss) return JSON.stringify({widget:false});
  var box = dismiss, m = null, qbox = dismiss;
  for (var i=0;i<16 && box;i++){
    var txt = batonClean(box);
    if (txt.length > 400) break;                  // left the widget; keep the last good box
    qbox = box;
    var mm = null, sl = txt.indexOf('/');
    if (sl > 0) {
      var lhs = txt.slice(0, sl), rhs = txt.slice(sl + 1);
      while (lhs.length && lhs.charAt(lhs.length-1) === ' ') lhs = lhs.slice(0, -1);
      while (rhs.length && rhs.charAt(0) === ' ') rhs = rhs.slice(1);
      var la = lhs.length, lb = 0;
      while (la > 0 && lhs.charAt(la-1) >= '0' && lhs.charAt(la-1) <= '9') la--;
      while (lb < rhs.length && rhs.charAt(lb) >= '0' && rhs.charAt(lb) <= '9') lb++;
      var ls = lhs.slice(la), rs = rhs.slice(0, lb);
      if (ls && rs) mm = [null, ls, rs];
    }
    if (mm) {
      var qi = Number(mm[1]), qt = Number(mm[2]);
      if (qi >= 1 && qt >= 1 && qi <= qt && qt <= 20) { m = mm; break; }
    }
    box = box.parentElement;
  }
  box = qbox;
  var opts = batonOptions().map(function(b){
    return { text: batonClean(b).slice(0,60), pressed: b.getAttribute('aria-pressed')==='true' };
  });
  var submit = batonChrome('submit');
  return JSON.stringify({
    widget: true,
    index: m ? Number(m[1]) : 1,
    total: m ? Number(m[2]) : 1,
    question: box ? batonClean(box).replace(/^\\d+\\s*\\/\\s*\\d+/,'').slice(0,120) : '',
    options: opts,
    hasNext: !!batonChrome('next'),
    hasSubmit: !!submit,
    submitEnabled: !!(submit && !submit.disabled),
    otherBox: !!document.querySelector('textarea[aria-label="Other option"]')
  });
})()`;

const clickOptionJs = (label) => `(function(){ ${CLEAN} ${PTR} ${CHROME_RX} ${BOX} ${OPTIONS}
  var want = ${JSON.stringify(String(label).toLowerCase())};
  var hit = batonOptions().filter(function(b){
    return batonClean(b).toLowerCase().indexOf(want) === 0;
  })[0];
  if(!hit) return 'not-found:' + batonOptions().map(function(b){return batonClean(b).slice(0,20);}).join('|');
  if (hit.getAttribute('aria-pressed') === 'true') return 'already';
  batonPtr(hit);
  return 'clicked';
})()`;

const deselectOthersJs = (wanted) => `(function(){ ${CLEAN} ${CHROME_RX} ${BOX} ${OPTIONS} ${PTR}
  var want = ${JSON.stringify(wanted.map(w => String(w).toLowerCase()))};
  var off = 0;
  batonOptions().forEach(function(b){
    if (b.getAttribute('aria-pressed') !== 'true') return;   // single-select has no toggles
    var t = batonClean(b).toLowerCase();
    var keep = want.some(function(w){ return t.indexOf(w) === 0; });
    if (!keep) { batonPtr(b); off++; }
  });
  return 'deselected:' + off;
})()`;

const clickChromeJs = (name) => `(function(){ ${CLEAN} ${PTR} ${CHROME_RX} ${BOX} ${CHROME}
  var b = batonChrome(${JSON.stringify(String(name).toLowerCase())});
  if(!b) return 'not-found';
  batonPtr(b); return 'clicked';
})()`;

const typeOtherJs = (text) => `(function(){
  var ta = document.querySelector('textarea[aria-label="Other option"]');
  if(!ta) return 'no-textarea';
  var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;
  setter.call(ta, ${JSON.stringify(String(text))});
  ta.dispatchEvent(new Event('input',{bubbles:true}));
  ta.focus();
  return 'typed';
})()`;

const CLEAR_OTHER_JS = `(function(){
  var ta = document.querySelector('textarea[aria-label="Other option"]');
  if(!ta) return 'none';
  if(!ta.value) return 'empty';
  var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;
  setter.call(ta, '');
  ta.dispatchEvent(new Event('input',{bubbles:true}));
  return 'cleared';
})()`;

async function answerQuestion(sessionId, answers = []) {
  if (!sessionId) return { ok: false, error: 'NO_SESSION_ID' };
  if (!Array.isArray(answers) || !answers.length) return { ok: false, error: 'NO_ANSWERS' };
  if (!(await desktop.cdpAvailable())) return { ok: false, error: 'CDP_UNAVAILABLE' };

  const conn = await desktop.connect(await desktop.wsUrl());
  let CID, original = null;
  const evalJs = async (js) => conn.evaluate(desktop.rEval(CID, js));
  const read = async () => JSON.parse(await evalJs(STATE_JS) || '{}');

  try {
    CID = await desktop.pickChat(conn);
    const before = String(await evalJs(`location.href.split('/').pop()`));
    original = before.startsWith('local_') ? before : null;

    const found = await desktop.findSessionRow(conn, CID, sessionId);
    if (!found.row) return { ok: false, error: 'NO_SUCH_SESSION' };
    await evalJs(`
      (function(){
        var b=document.querySelector('[data-row-key="code:${sessionId}"] [data-row-main-button]');
        if(!b) return 'not-found';
        b.scrollIntoView({block:'center',behavior:'instant'}); b.click(); return 'ok';
      })()`);
    let onTarget = false;
    for (let i = 0; i < 24 && !onTarget; i++) {
      await sleep(300);
      onTarget = String(await evalJs(`location.href.split('/').pop()`)) === sessionId;
    }
    if (!onTarget) {
      return { ok: false, error: 'NAV_FAILED',
               message: 'Could not switch the desktop to that session, so its question was never reached.' };
    }

    let st = await read();
    for (let i = 0; i < 24 && !st.widget; i++) { await sleep(300); st = await read(); }
    if (!st.widget) return { ok: false, error: 'NO_QUESTION', message: 'No question widget is showing in that session.' };

    const answered = [];
    let guard = 0;
    while (st.widget && guard++ < 12) {
      const a = answers[st.index - 1] || {};
      const labels = Array.isArray(a.labels) ? a.labels.filter(Boolean) : [];
      const other = String(a.other || '').trim();
      const at = st.index;

      if (!labels.length && !other) {
        return { ok: false, error: 'NO_ANSWER_FOR_QUESTION', at, answered, state: st };
      }

      if (other) {
        const r = await evalJs(clickOptionJs('Other'));
        if (r.startsWith('not-found')) return { ok: false, error: 'NO_OTHER_OPTION', at, detail: r, answered, state: st };
        await sleep(800);
        const t = await evalJs(typeOtherJs(other));
        if (t !== 'typed') return { ok: false, error: 'NO_OTHER_TEXTAREA', at, answered, state: st };
        await sleep(500);
      } else {
        await evalJs(CLEAR_OTHER_JS);
        await sleep(250);
        await evalJs(deselectOthersJs(labels));
        await sleep(350);
        for (const l of labels) {
          const r = await evalJs(clickOptionJs(l));
          if (r.startsWith('not-found')) {
            return { ok: false, error: 'OPTION_NOT_FOUND', label: l, at, detail: r, answered, state: st };
          }
          await sleep(650);
        }
        const mid = await read();
        if (mid.widget && mid.index === at && mid.hasNext) {
          const pressed = (mid.options || []).filter(o => o.pressed).length;
          if (!pressed) return { ok: false, error: 'SELECTION_DID_NOT_STICK', at, answered, state: mid };
        }
      }

      let cur = await read();
      if (cur.widget && cur.index === at) {
        if (cur.hasNext) await evalJs(clickChromeJs('next'));
        else if (cur.hasSubmit) await evalJs(clickChromeJs('submit'));
      }

      let moved = false;
      for (let k = 0; k < 16; k++) {
        await sleep(500);
        cur = await read();
        if (!cur.widget || cur.index !== at) { moved = true; break; }
      }
      st = cur;
      answered.push(other ? { q: at, other } : { q: at, labels });
      if (!moved) return { ok: false, error: 'DID_NOT_ADVANCE', at, answered, state: st };
    }

    return { ok: true, answered, state: st };
  } catch (e) {
    return { ok: false, error: 'EXCEPTION', message: e.message };
  } finally {
    try { if (original) await desktop.restoreActive(conn, CID, original); } catch {}
    conn.close();
  }
}

module.exports = { answerQuestion, STATE_JS };
