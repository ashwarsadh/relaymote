// session-links.js — g1869: what a Desktop session writes about other sessions and the board becomes a tap
// in the phone chat (mobile/public/app.js md()). Runs the REAL md() in a vm, as weblinks.js does.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failed = 0;
const check = (ok, name, extra) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra !== undefined && !ok ? '  ' + JSON.stringify(extra).slice(0, 300) : ''}`); if (!ok) failed++; };

const app = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'public', 'app.js'), 'utf8');
function grab(startRx) {
  const m = startRx.exec(app);
  if (!m) return '';
  const rest = app.slice(m.index);
  const end = rest.search(/\r?\n(?=(?:function |async function |const |let |\/\/|\/\*|\$\())/);
  return rest.slice(0, end > 0 ? end : undefined);
}
const parts = [/^function esc\(/m, /^const SESS_RX = /m, /^const BOARD_RX = /m, /^function boardLinks\(/m, /^const CODE_PATH_RX = /m,
  /^const FILE_RX = /m, /^const URL_RX = /m, /^function renderTables\(/m, /^function md\(/m].map(grab);
check(parts.every(Boolean), 'md() and its helpers are found in app.js', parts.map(p => p.length));
const ctx = {}; vm.createContext(ctx);
vm.runInContext(parts.join('\n') + '\n;globalThis.md = md;', ctx);
const md = ctx.md;
const SID = 'local_03ee57c8-a02d-4021-9289-91c69d2c5bef';
const all = (h, cls, attr) => [...h.matchAll(new RegExp(`<a class="${cls}" ${attr}="([^"]*)"[^>]*>([^<]*)</a>`, 'g'))].map(m => [m[1], m[2]]);

{
  const h = md(`Open [Naaptol P&L](#${SID}) and allow the push.`);
  check(JSON.stringify(all(h, 'sesslink', 'data-sid')) === JSON.stringify([[SID, 'Naaptol P&amp;L']]) && !/fileref/.test(h),
    'a [title](#local_id) link opens that session, not a file', h);
}
check(all(md(`session ${SID} is idle`), 'sesslink', 'data-sid')[0][0] === SID, 'a bare local_ id opens that session');
check(!/<a/.test(md('see [the terminal](#terminal/3)')) && /the terminal/.test(md('see [the terminal](#terminal/3)')), 'another #target is plain text, not a dead file link');
{
  const h = md('g1869 and g1867. Cards #1783, #1784 are on the board.');
  check(JSON.stringify(all(h, 'boardlink', 'data-goal').map(x => x[0])) === '["g1869","g1867"]', 'goal ids link to their goal', h);
  check(JSON.stringify(all(h, 'boardlink', 'data-card').map(x => x[0])) === '["1783","1784"]', 'card numbers link to their card', h);
  check(all(h, 'boardlink', 'data-board').length === 1, 'the word "board" opens the board', h);
}
{
  const h = md('notes/g1822-bd-audit.md, https://x.io/g1234/#555, PR #123, dashboard, onboarding, it&#39;s, `g12` g12345678');
  check(!/boardlink/.test(h), 'paths, URLs, PR numbers, dashboard, short or long numbers are not board links', h);
}
check(/<code><a class="boardlink" data-goal="g1500">/.test(md('`g1500`')) && /<strong><a class="boardlink" data-card="1788">/.test(md('**#1788**')),
  'a goal in a code span or a card in bold still links');
check(!/<a[^>]*>[^<]*<a/.test(md(`[g1869 on the board](#${SID})`)), 'a link label is never linked twice');

if (failed) { console.log(`\n${failed} FAILED`); process.exit(1); }
console.log('\nsession-links: all ok');
