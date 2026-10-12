'use strict';
// g1712: a Claude Desktop dialog (workspace trust) blocked sends and the phone could only say "answer this
// on the PC". The phone now shows the dialog's real buttons and his tap presses that exact button on the PC.
// Here: the dialog read on the PC (mobile/dialog.js) must be the same one the snapshot showed the phone, a
// changed dialog is refused, nothing presses a dialog on its own, and a scoped sub-user cannot press one.
const fs = require('fs'), path = require('path'), vm = require('vm');
const { FIND_JS } = require('../mobile/dialog');
let fails = 0;
const check = (ok, what, got) => { console.log((ok ? 'ok   ' : 'FAIL ') + what + (ok || got === undefined ? '' : '  ' + JSON.stringify(got))); if (!ok) fails++; };

// A fake DOM: one hidden dialog, then the trust dialog with an icon-only close button.
const btn = (t) => ({ textContent: t, isConnected: true, disabled: false, clicked: 0, click() { this.clicked++; } });
const trustText = 'Trust this workspace?\n\nClaude Code may read, write, or execute files in this folder.\n\nC:/x/probe';
const el = (o, attrs = {}, style = {}) => Object.assign({ attrs, style: Object.assign({ visibility: 'visible', display: 'block', opacity: '1', pointerEvents: 'auto' }, style),
  hasAttribute(n) { return n in this.attrs; }, querySelectorAll() { return this.buttons || []; } }, o);
const trust = el({ offsetWidth: 400, offsetHeight: 200, innerText: trustText, buttons: [btn(''), btn(''), btn('Cancel'), btn('Trust workspace')] }, { 'data-open': '' });
const hidden = el({ offsetWidth: 0, offsetHeight: 0, innerText: 'old' });
// 13-Oct, measured on his Desktop: the Usage popover after it closed (data-closed, data-side, pointer-events none)
// and a claimed-credit modal faded out (data-closed, opacity 0). Both keep their size in the page.
const usageText = 'Usage Context window 294.1k / 400k (74%) Compact session See detailed breakdown';
const usageClosed = el({ offsetWidth: 360, offsetHeight: 314, innerText: usageText, buttons: [btn('Compact session'), btn(''), btn('See detailed breakdown')] }, { 'data-closed': '', 'data-side': 'top' }, { pointerEvents: 'none' });
const usageOpen = el({ offsetWidth: 360, offsetHeight: 314, innerText: usageText, buttons: [btn('Compact session')] }, { 'data-open': '', 'data-side': 'top' });
const credit = el({ offsetWidth: 509, offsetHeight: 560, innerText: 'Credit claimed $250 credits for cloud sessions added', buttons: [btn('Done')] }, { 'data-closed': '' }, { opacity: '0' });
const ctx = { window: {}, String, JSON, Array, Number, getComputedStyle: (e) => e.style, document: { querySelectorAll: () => [hidden, usageClosed, usageOpen, credit, trust] } };
vm.createContext(ctx);

// The key exactly as lib/desktop.js's scrape builds the phone's blocker text.
const scraped = trustText.split('\n').join(' ').trim().slice(0, 300);
const key = scraped.slice(0, 80);
const found = JSON.parse(vm.runInContext(FIND_JS(key), ctx));
check(found.present && JSON.stringify(found.buttons) === '["Cancel","Trust workspace"]', 'the PC finds the same dialog and the same buttons the phone was shown (no blank or icon-only button)', found);
for (const [d, what] of [[usageClosed, 'a closed Usage popover'], [usageOpen, 'an open Usage popover (anchored, never blocks a send)'], [credit, 'a faded-out closed modal']]) {
  const k = d.innerText.split(String.fromCharCode(10)).join(' ').trim().slice(0, 300).slice(0, 80);
  check(!JSON.parse(vm.runInContext(FIND_JS(k), ctx)).present, what + ' is not a blocking box');
}
// The sidebar scrape (what puts the banner on the phone) uses the same test.
const desktop = require('../lib/desktop');
const scrapeCtx = Object.assign({}, ctx, { location: { href: 'x/local_1' }, document: { querySelectorAll: (q) => /dialog/.test(q) ? [hidden, usageClosed, usageOpen, credit] : [] } });
vm.createContext(scrapeCtx);
let scraped0 = null; try { scraped0 = JSON.parse(vm.runInContext(desktop.SCRAPE_JS, scrapeCtx)); } catch (e) { scraped0 = { err: e.message }; }
check(scraped0 && !scraped0.err && scraped0.blocker === null, 'the phone banner is not raised for the Usage popover or a closed modal', scraped0 && (scraped0.err || scraped0.blocker));
const other = JSON.parse(vm.runInContext(FIND_JS('Some other dialog'), ctx));
check(!other.present, 'a dialog that is no longer the one he saw is not touched', other);

const src = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'dialog.js'), 'utf8');
check(/st\.buttons\[i\] === label/.test(src) && /DIALOG_CHANGED/.test(src), 'the press needs the same position AND the same words, or it refuses');
check(/after\.present/.test(src) && /closed: true/.test(src), 'success is only reported once the dialog has actually closed');

// Only his tap presses: the route is the sole caller, and the scoped-account allow-list does not include it.
const root = path.join(__dirname, '..');
const callers = [];
for (const dir of ['lib', 'mobile']) for (const f of fs.readdirSync(path.join(root, dir))) {
  if (!f.endsWith('.js') || f === 'dialog.js') continue;
  if (/pressDialogButton\s*\(/.test(fs.readFileSync(path.join(root, dir, f), 'utf8'))) callers.push(dir + '/' + f);
}
check(callers.length === 1 && callers[0] === 'mobile/index.js', 'nothing but the phone route presses a dialog', callers);
const idx = fs.readFileSync(path.join(root, 'mobile', 'index.js'), 'utf8');
const writeOk = (idx.match(/const WRITE_OK = [\s\S]*?\);/) || [''])[0];
check(writeOk && !/dialog\/press/.test(writeOk), 'a scoped sub-user cannot press a PC dialog');

const app = fs.readFileSync(path.join(root, 'mobile', 'public', 'app.js'), 'utf8');
check(/\/api\/dialog\/press/.test(app) && /class="permbtn dlgbtn"/.test(app), 'the phone renders the dialog\'s buttons and sends his tap');
check(!/answer this on the PC/.test(app), 'the phone no longer tells him to go to the PC');
check(/data-i="-1">Dismiss \(Esc\)/.test(app) && /label === DISMISS && Number\(index\) === -1/.test(src) && /keyCode:'Escape'/.test(src), 'a single Dismiss sends Esc on the PC');

if (fails) { console.log(fails + ' failure(s)'); process.exit(1); }
console.log('dialog-press: all passed');
