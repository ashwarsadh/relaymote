// sheets.js — closing a sheet (mobile/public/app.js enableSwipeToClose + boot). Swipe-to-close starts
// only on the sticky top bar and every sheet has an X; boot never opens the drawer over a sheet that is
// already open. Static checks on the source; each is also shown FIRING on the old code.
'use strict';
const fs = require('fs');
const path = require('path');

let failed = 0;
const check = (ok, name, extra) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra !== undefined && !ok ? '  ' + JSON.stringify(extra).slice(0, 300) : ''}`); if (!ok) failed++; };

const P = f => fs.readFileSync(path.join(__dirname, '..', 'mobile', 'public', f), 'utf8');
const app = P('app.js');
const css = P('style.css');
const html = P('index.html');
const fnOf = (src) => src.slice(src.indexOf('function enableSwipeToClose('), src.indexOf("document.querySelectorAll('.sheet').forEach(enableSwipeToClose)"));

const barOnly = (fn) => /bar\.addEventListener\('touchstart'/.test(fn) && /bar\.addEventListener\('touchmove'/.test(fn)
  && !/body\.addEventListener\('touch/.test(fn) && !/scrollTop/.test(fn);
// Boot opens the first screen only when no sheet is open, and firstScreen() re-checks before it opens anything.
const bootSafe = (src) => /const userMoved = navTouched !== bootTouched \|\| !!visibleSheetId\(\) \|\| !!state\.open;/.test(src)
  && /const untouched = \(\) => !state\.open && !visibleSheetId\(\)/.test(src) && !/\} else drawer\(true\);/.test(src);

// The checks fire on the pre-g426 shapes.
const OLD_FN = "function enableSwipeToClose(sheet) { const sc = 0; body.addEventListener('touchstart', f); return sc.scrollTop <= 0; }";
check(!barOnly(OLD_FN) && !bootSafe("    } else drawer(true);"), 'the checks fire on the old swipe rule and the old boot line');

const fn = fnOf(app);
check(fn.length > 200, 'enableSwipeToClose is found');
check(barOnly(fn), 'touch listeners are on the bar only; none on the scrolling body, no scroll-position rule');
check(/!target\.closest\('button'\)/.test(fn), 'a drag never starts on the X');
check(/sheet-x[\s\S]*x\.onclick = \(\) => navBack\(\)/.test(fn), 'the X closes through navBack(), like swipe, Escape and Done');
{
  const r = (css.match(/\.sheet-bar\{[^}]*\}/) || [''])[0];
  check(/position:sticky/.test(r) && /top:0/.test(r) && /touch-action:none/.test(r), 'the bar is sticky and takes the drag from the browser');
}
check(/\.sheet-x\{[^}]*width:44px/.test(css), 'the X is a 44px-wide target');
check(bootSafe(app), 'boot never opens the drawer over a sheet that is already open');
{
  // The bar is built from a .grab that is the body's FIRST child; one nested deeper would get a second grab.
  const bodies = [...html.matchAll(/<div class="sheet-body[^"]*"[^>]*>\s*(<[^>]+>)/g)].map(m => m[1]);
  const bad = bodies.filter(t => t !== '<div class="grab">');
  check(bodies.length >= 9 && bad.length === 0, `every sheet body in index.html starts with its grab (${bodies.length})`, bad);
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall sheet checks passed');
process.exit(failed ? 1 : 0);
