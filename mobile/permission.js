'use strict';
const desktop = require('../lib/desktop');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const CLEAN = "replace(/[\\u200B-\\u200D\\uFEFF\\u00AD\\u2060\\uE000-\\uF8FF]/g,'')";

const READ_JS = `(function(){
  var SP=String.fromCharCode(32), NL=String.fromCharCode(10), TB=String.fromCharCode(9), CR=String.fromCharCode(13);
  function cl(e){
    var t=((e && e.textContent) || '');
    t=t.split(NL).join(SP).split(TB).join(SP).split(CR).join(SP);
    while(t.indexOf(SP+SP)>=0) t=t.split(SP+SP).join(SP);
    return t.trim();
  }
  function isChoice(t){
    t=t.toLowerCase();
    return t.indexOf('allow')===0 || t.indexOf('always allow')===0 || t.indexOf('deny')===0
        || t.indexOf("don't allow")===0 || t.indexOf('reject')===0 || t.indexOf('no,')===0;
  }
  function isDeny(t){
    t=t.toLowerCase();
    return t.indexOf('deny')===0 || t.indexOf("don't allow")===0 || t.indexOf('reject')===0 || t.indexOf('no,')===0;
  }
  function pretty(raw){
    var mods='CtrlShiftEnterEscAltCmdMeta';
    var k=raw.length;
    while(k>0){
      var c=raw.charCodeAt(k-1);
      var isLetter=(c>=65&&c<=90)||(c>=97&&c<=122);
      var isSym=(c>0x2000);                       // arrows and glyphs like the shift symbol
      if(isLetter||isSym||c===32||c===43){ k--; continue; }
      break;
    }
    if(k>0 && k<raw.length){
      var tail=raw.slice(k).split(SP).join('');
      var c2=raw.charCodeAt(k-1);
      if(c2>=48 && c2<=57 && (tail.length===0 || mods.toLowerCase().indexOf(tail.slice(0,4).toLowerCase())>=0
          || tail.toLowerCase().indexOf('esc')===0 || tail.toLowerCase().indexOf('ctrl')===0
          || tail.toLowerCase().indexOf('enter')===0 || tail.toLowerCase().indexOf('shift')===0)){
        return raw.slice(0, k-1).trim();
      }
    }
    return raw.trim();
  }

  var cand=Array.from(document.querySelectorAll('button')).filter(function(b){
    return b.offsetParent!==null && isChoice(cl(b));
  });
  var withShortcut=cand.filter(function(b){ var t=cl(b); return pretty(t)!==t; });
  var opts=withShortcut.length ? withShortcut
                               : cand.filter(function(b){ return cl(b).slice(-1)!=='?'; });
  if(!opts.length) return JSON.stringify({present:false});

  var host=opts[0];
  for(var g=0; g<25 && host; g++){
    var all=true;
    for(var q=0;q<opts.length;q++){ if(!host.contains(opts[q])){ all=false; break; } }
    if(all) break;
    host=host.parentElement;
  }
  function askOf(node){
    if(!node) return '';
    var t=cl(node);
    for(var r=0;r<opts.length;r++){ t=t.split(cl(opts[r])).join(SP); }
    while(t.indexOf(SP+SP)>=0) t=t.split(SP+SP).join(SP);
    return t.trim();
  }
  var ask=askOf(host);
  for(var h=0; h<6 && host && ask.length<40; h++){ host=host.parentElement; ask=askOf(host); }

  window.__relaymotePerm={};
  var list=[];
  for(var n=0;n<opts.length;n++){
    var raw=cl(opts[n]);
    window.__relaymotePerm['k'+n]=opts[n];
    list.push({ key:'k'+n, label:pretty(raw), raw:raw.slice(0,60), kind:isDeny(raw)?'deny':'allow' });
  }
  return JSON.stringify({ present:true, request: ask ? ask.slice(0,700) : null, options:list });
})()`;

const CLICK_JS = (key) => `(function(){
  var m = window.__relaymotePerm || {};
  var b = m[${JSON.stringify(String(key))}];
  if(!b) return 'gone';
  if(b.disabled) return 'disabled';
  b.click();
  return 'clicked';
})()`;

async function focus(conn, CID, sessionId) {
  const before = String(await conn.evaluate(desktop.rEval(CID, `location.href.split('/').pop()`)));
  if (before === sessionId) return { ok: true, restore: null };
  await conn.evaluate(desktop.rEval(CID, `
    (function(){
      var b=document.querySelector('[data-row-key="code:${sessionId}"] [data-row-main-button]');
      if(b) b.click(); return 1;
    })()`));
  for (let i = 0; i < 24; i++) {
    await sleep(300);
    if (String(await conn.evaluate(desktop.rEval(CID, `location.href.split('/').pop()`))) === sessionId) {
      return { ok: true, restore: before.startsWith('local_') ? before : null };
    }
  }
  return { ok: false, error: 'NAV_FAILED' };
}

async function readPermission(sessionId) {
  if (!(await desktop.cdpAvailable())) return { ok: false, error: 'CDP_UNAVAILABLE' };
  const conn = await desktop.connect(await desktop.wsUrl());
  try {
    const CID = await desktop.pickChat(conn);
    const nav = await focus(conn, CID, sessionId);
    if (!nav.ok) return nav;
    await sleep(400);
    const st = JSON.parse(await conn.evaluate(desktop.rEval(CID, READ_JS)) || '{}');
    return { ok: true, sessionId, ...st };
  } catch (e) {
    return { ok: false, error: 'EXCEPTION', message: e.message };
  } finally { conn.close(); }
}

async function answerPermission(sessionId, kind, raw) {
  if (!(await desktop.cdpAvailable())) return { ok: false, error: 'CDP_UNAVAILABLE' };
  const conn = await desktop.connect(await desktop.wsUrl());
  try {
    const CID = await desktop.pickChat(conn);
    const nav = await focus(conn, CID, sessionId);
    if (!nav.ok) return nav;
    await sleep(300);

    const st = JSON.parse(await conn.evaluate(desktop.rEval(CID, READ_JS)) || '{}');
    if (!st.present) return { ok: false, error: 'NO_PROMPT', message: 'Nothing is waiting for permission in that session.' };
    const want = String(kind || 'allow').toLowerCase();
    const opts = st.options || [];
    const sameKind = opts.filter(o => o.kind === want);
    const pick = (raw && opts.find(o => o.raw === raw))
              || (raw && opts.find(o => o.label === raw))
              || (sameKind.length === 1 ? sameKind[0] : null);
    if (!pick) {
      return { ok: false, error: 'AMBIGUOUS_CHOICE',
               message: 'More than one option matches and the exact button was not identified.',
               offered: opts.map(o => ({ label: o.label, kind: o.kind })) };
    }

    const r = await conn.evaluate(desktop.rEval(CID, CLICK_JS(pick.key)));
    if (r !== 'clicked') return { ok: false, error: 'CLICK_FAILED', detail: r };

    for (let i = 0; i < 20; i++) {
      await sleep(300);
      const after = JSON.parse(await conn.evaluate(desktop.rEval(CID, READ_JS)) || '{}');
      if (!after.present) return { ok: true, sessionId, chose: pick.label, kind: want };
    }
    return { ok: false, error: 'STILL_SHOWING', chose: pick.label };
  } catch (e) {
    return { ok: false, error: 'EXCEPTION', message: e.message };
  } finally { conn.close(); }
}

module.exports = { readPermission, answerPermission };
