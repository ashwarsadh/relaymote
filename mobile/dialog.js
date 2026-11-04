'use strict';
// g1712: a Claude Desktop modal (workspace trust, any [role=dialog]) blocks every send, and the phone could
// only say "answer this on the PC". This presses the ONE button the user tapped on the phone, on the SAME
// dialog he was shown, and reports whether it closed. It is only ever called from his tap
// (POST /api/dialog/press) — nothing in Relaymote answers a dialog on its own.
const desktop = require('../lib/desktop');

const DISMISS = 'Dismiss';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Must read the dialog exactly the way lib/desktop.js's sidebar scrape does, so `key` and the button
// index the phone got from the snapshot point at the same element here.
const FIND_JS = (key) => `(function(){
  var NL=String.fromCharCode(10), want=${JSON.stringify(String(key || ''))};
  var dl=document.querySelectorAll('[role=dialog],[role=alertdialog]');
  for(var q=0;q<dl.length;q++){
    var c=dl[q];
    if(!(${desktop.OPEN_DIALOG_FN})(c)) continue;
    var ct=((c.innerText)||'').split(NL).join(' ').trim();
    if(!ct) continue;
    if(ct.slice(0,300).slice(0,80)!==want) continue;
    var btns=Array.prototype.slice.call(c.querySelectorAll('button'),0,6)
      .filter(function(b){ return /[A-Za-z0-9]/.test((b.textContent||'').trim()); });
    window.__relaymoteDialogBtns=btns; window.__relaymoteDialog=c;
    return JSON.stringify({present:true, buttons:btns.map(function(b){ return (b.textContent||'').trim().slice(0,40); })});
  }
  window.__relaymoteDialogBtns=null; window.__relaymoteDialog=null;
  return JSON.stringify({present:false});
})()`;

const CLICK_JS = (i) => `(function(){
  var b=(window.__relaymoteDialogBtns||[])[${Number(i) | 0}];
  if(!b || !b.isConnected) return 'gone';
  if(b.disabled) return 'disabled';
  b.click(); return 'clicked';
})()`;

// #382 (25-Oct, Ashwar): "pressing the dismiss button interrupts the running sessions". Esc is also Desktop's Stop key: a
// box that doesn't take it, or one that closes first, lets it reach the chat and end the turn. So Dismiss clicks the
// box's own close button, and sends Esc only when no turn is running in the session on screen.
const CLOSE_JS = `(function(){
  var box=window.__relaymoteDialog;
  var all=box&&box.isConnected?Array.prototype.slice.call(box.querySelectorAll('button')):[];
  var want=/^(close|dismiss|cancel|not now|no thanks|skip)$/i;
  for(var i=0;i<all.length;i++){
    var b=all[i], name=((b.getAttribute('aria-label')||'')+'|'+(b.textContent||'')).split('|');
    if(b.disabled||!b.isConnected) continue;
    if(want.test(name[0].trim())||want.test((name[1]||'').trim())){ b.click(); return 'clicked'; }
  }
  return 'none';
})()`;
const RUNNING_JS = `(async function(){
  var LS=window['claude.web']&&window['claude.web'].LocalSessions, id=String(location.href).split('/').pop();
  if(!LS||!/^local_/.test(id)) return 'unknown';
  try{ var s=await LS.getSession(id); return s&&s.isRunning?'running':'idle'; }catch(e){ return 'unknown'; }
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
    // "Dismiss": a trusted Escape key to the Desktop window, the way he would close it at the PC.
    if (label === DISMISS && Number(index) === -1) {
      const gone = async () => {
        for (let n = 0; n < 10; n++) {
          await sleep(300);
          if (!JSON.parse(await conn.evaluate(desktop.rEval(CID, FIND_JS(key))) || '{}').present) return true;
        }
        return false;
      };
      if (await conn.evaluate(desktop.rEval(CID, CLOSE_JS)) === 'clicked' && await gone()) return { ok: true, pressed: DISMISS, closed: true, via: 'close-button' };
      const run = await conn.evaluate(desktop.rEval(CID, RUNNING_JS));
      if (run !== 'idle') {
        return { ok: false, error: 'WOULD_INTERRUPT', pressed: null,
                 message: run === 'running'
                   ? 'Claude is working in that session, and Esc would stop it. Pick one of the box\'s own buttons instead.'
                   : 'Could not tell whether Claude is working there, so Esc was not sent. Pick one of the box\'s own buttons.' };
      }
      await conn.evaluate(`(function(){const wc=process.mainModule.require('electron').webContents.fromId(${CID});` +
        `wc.sendInputEvent({type:'keyDown',keyCode:'Escape'});wc.sendInputEvent({type:'keyUp',keyCode:'Escape'});return 1})()`);
      for (let n = 0; n < 10; n++) {
        await sleep(300);
        const after = JSON.parse(await conn.evaluate(desktop.rEval(CID, FIND_JS(key))) || '{}');
        if (!after.present) return { ok: true, pressed: DISMISS, closed: true };
      }
      return { ok: false, error: 'STILL_SHOWING', pressed: DISMISS, message: 'Esc was sent but the box is still open on the PC.' };
    }
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

module.exports = { pressDialogButton, FIND_JS, DISMISS };
