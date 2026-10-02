'use strict';
const desktop = require('../lib/desktop');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// The control's aria-label: "Usage: …" until Sep 2026, "Usage, Weekly · …" from Oct 2026.
const LABEL_RE = /^Usage\s*[:,]/;

const FIND_JS = `(function(){
  var LRE=new RegExp(${JSON.stringify(LABEL_RE.source)});
  var all=document.querySelectorAll('[aria-label]');
  for(var i=0;i<all.length;i++){
    var e=all[i], l=e.getAttribute('aria-label')||'';
    if(LRE.test(l) && e.offsetParent!==null){ window.__relaymoteUsage=e; return l; }
  }
  return '';
})()`;

const TOGGLE_JS = `(function(){
  if(!window.__relaymoteUsage) return 'no-control';
  window.__relaymoteUsage.click();
  return 'ok';
})()`;

const PANEL_JS = `(function(){
  var sp=String.fromCharCode(32), nl=String.fromCharCode(10), tb=String.fromCharCode(9), cr=String.fromCharCode(13);
  var d=Array.from(document.querySelectorAll('[role="dialog"]')).filter(function(e){return e.offsetParent!==null;});
  for(var i=0;i<d.length;i++){
    var t=(d[i].textContent||'');
    t=t.split(nl).join(sp).split(tb).join(sp).split(cr).join(sp);
    while(t.indexOf(sp+sp)>=0) t=t.split(sp+sp).join(sp);
    t=t.trim();
    if(t.indexOf('Usage')>=0 && t.toLowerCase().indexOf('limit')>=0) return t;
  }
  return '';
})()`;

function parse(text, label) {
  const tidy = (v) => String(v || '')
    .replace(/[\u200B-\u200D\uFEFF\u00AD\u2060\uE000-\uF8FF]/g, '')
    .trim();
  const t = String(text || '');
  const num = (re) => { const m = t.match(re); return m ? m : null; };

  const ctx = num(/Context window\s*([\d.]+\s*[kKmM]?)\s*\/\s*([\d.]+\s*[kKmM]?)\s*\((\d+)%\)/);
  // Desktop renamed "5-hour limit" to "Session limit" (Oct 2026); accept both.
  const plan = num(/Plan usage limits\s*[·\-]\s*(.+?)\s*(?:5-hour|Session) limit/i);
  const five = num(/(?:5-hour|Session) limit\s*(Resets[^%]*?)\s*(\d+)%/i);
  const week = num(/Weekly\s*[·-]\s*all models\s*(Resets[^%]*?)\s*(\d+)%/i);

  const lab = String(label || '');
  const labWeek = lab.match(/all models:\s*(\d+)%/i);
  const labReset = lab.match(/Resets ([^,]+)/i);
  const labCtx = lab.match(/Context\s*([\d.]+\s*[kKmM]?)\s*\/\s*([\d.]+\s*[kKmM]?)\s*\((\d+)%\)/i);

  return {
    plan: plan ? tidy(plan[1]) : null,
    context: ctx ? { used: ctx[1].trim(), total: ctx[2].trim(), pct: Number(ctx[3]) }
           : labCtx ? { used: labCtx[1].trim(), total: labCtx[2].trim(), pct: Number(labCtx[3]) } : null,
    fiveHour: five ? { pct: Number(five[2]), resets: tidy(five[1]) } : null,
    weekly: week ? { pct: Number(week[2]), resets: tidy(week[1]) }
          : labWeek ? { pct: Number(labWeek[1]), resets: labReset ? labReset[1].trim() : null } : null,
    raw: t.slice(0, 400) || lab,
  };
}

async function readUsage(sessionId, opts = {}) {
  const panel = !!opts.panel;
  if (!(await desktop.cdpAvailable())) {
    return { ok: false, error: 'CDP_UNAVAILABLE', message: "Claude Desktop's debugger is not reachable." };
  }
  const conn = await desktop.connect(await desktop.wsUrl());
  let step = 'connect';
  const at = async (name, fn) => { step = name; return fn(); };
  try {
    const CID = await at('pick-window', () => desktop.pickChat(conn));

    if (sessionId) {
      const here = String(await conn.evaluate(desktop.rEval(CID, `location.href.split('/').pop()`)));
      if (here !== sessionId) {
        await conn.evaluate(desktop.rEval(CID, `
          (function(){
            var b=document.querySelector('[data-row-key="code:${sessionId}"] [data-row-main-button]');
            if(b) b.click(); return 1;
          })()`));
        let ok = false;
        for (let i = 0; i < 24 && !ok; i++) {
          await sleep(300);
          ok = String(await conn.evaluate(desktop.rEval(CID, `location.href.split('/').pop()`))) === sessionId;
        }
        if (!ok) return { ok: false, error: 'NAV_FAILED', message: 'Could not switch to that session.' };
      }
    }

    const label = String(await at('find-control', () => conn.evaluate(desktop.rEval(CID, FIND_JS))) || '');
    if (!label) return { ok: false, error: 'NO_USAGE_CONTROL', message: 'No usage control on screen.' };

    const forSession = String(await at('read-href', () => conn.evaluate(desktop.rEval(CID, `location.href.split('/').pop()`))));

    let text = '';
    let opened = false;
    if (panel) {
      await at('open-panel', () => conn.evaluate(desktop.rEval(CID, TOGGLE_JS)));
      opened = true;
      for (let i = 0; i < 16 && !text; i++) {
        await sleep(200);
        text = String(await at('read-panel', () => conn.evaluate(desktop.rEval(CID, PANEL_JS))) || '');
      }
      await at('close-panel', () => conn.evaluate(desktop.rEval(CID, TOGGLE_JS)));
      await sleep(300);
    }

    return { ok: true, forSession: forSession.startsWith('local_') ? forSession : null,
             ...parse(text, label), openedPanel: opened };
  } catch (e) {
    return { ok: false, error: 'EXCEPTION', step, message: `${e.message} at step "${step}"` };
  } finally { conn.close(); }
}

module.exports = { readUsage, parse, LABEL_RE, FIND_JS };
