'use strict';
// g1712: a Claude Desktop modal (workspace trust, any [role=dialog]) blocks every send, and the phone could
// only say "answer this on the PC". This presses the ONE button the user tapped on the phone, on the SAME
// dialog he was shown, and reports whether it closed. It is only ever called from his tap
// (POST /api/dialog/press) — nothing in Relaymote answers a dialog on its own.
const desktop = require('../lib/desktop');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Must read the dialog exactly the way lib/desktop.js's sidebar scrape does, so `key` and the button
// index the phone got from the snapshot point at the same element here.
const FIND_JS = (key) => `(function(){
  var NL=String.fromCharCode(10), want=${JSON.stringify(String(key || ''))};
  var dl=document.querySelectorAll('[role=dialog],[role=alertdialog]');
  for(var q=0;q<dl.length;q++){
    var c=dl[q];
    if(!(c.offsetWidth||c.offsetHeight)) continue;
    var ct=((c.innerText)||'').split(NL).join(' ').trim();
    if(!ct) continue;
    if(ct.slice(0,300).slice(0,80)!==want) continue;
    var btns=Array.prototype.slice.call(c.querySelectorAll('button'),0,6)
      .filter(function(b){ return (b.textContent||'').trim(); });
    window.__relaymoteDialogBtns=btns;
    return JSON.stringify({present:true, buttons:btns.map(function(b){ return (b.textContent||'').trim().slice(0,40); })});
  }
  window.__relaymoteDialogBtns=null;
  return JSON.stringify({present:false});
})()`;

const CLICK_JS = (i) => `(function(){
  var b=(window.__relaymoteDialogBtns||[])[${Number(i) | 0}];
  if(!b || !b.isConnected) return 'gone';
  if(b.disabled) return 'disabled';
  b.click(); return 'clicked';
})()`;

async function pressDialogButton({ key, label, index } = {}) {
  key = String(key || ''); label = String(label || '');
  if (!key || !label) return { ok: false, error: 'BAD_REQUEST', message: 'Which dialog and which button were not both given.' };
  if (!(await desktop.cdpAvailable())) return { ok: false, error: 'CDP_UNAVAILABLE', message: 'Claude Desktop\'s link is off, so the PC cannot be reached.' };
  const conn = await desktop.connect(await desktop.wsUrl());
  try {
    const CID = await desktop.pickChat(conn);
    const st = JSON.parse(await conn.evaluate(desktop.rEval(CID, FIND_JS(key))) || '{}');
    if (!st.present) return { ok: true, alreadyClosed: true, message: 'That box is no longer open on the PC.' };
    const i = Number(index);
    // The exact button he tapped: same position AND same words. A changed dialog is never guessed at.
    if (!(i >= 0 && st.buttons[i] === label)) {
      return { ok: false, error: 'DIALOG_CHANGED', message: 'The box on the PC has changed since your phone showed it. Look again.', buttons: st.buttons };
    }
    const r = await conn.evaluate(desktop.rEval(CID, CLICK_JS(i)));
    if (r !== 'clicked') return { ok: false, error: 'CLICK_FAILED', message: 'The button could not be pressed (' + r + ').' };
    for (let n = 0; n < 20; n++) {
      await sleep(300);
      const after = JSON.parse(await conn.evaluate(desktop.rEval(CID, FIND_JS(key))) || '{}');
      if (!after.present) return { ok: true, pressed: label, closed: true };
    }
    return { ok: false, error: 'STILL_SHOWING', pressed: label, message: '"' + label + '" was pressed but the box is still open on the PC.' };
  } catch (e) {
    return { ok: false, error: 'EXCEPTION', message: e.message };
  } finally { conn.close(); }
}

module.exports = { pressDialogButton, FIND_JS };
