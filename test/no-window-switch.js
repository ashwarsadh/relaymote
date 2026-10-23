'use strict';
// no-window-switch.js (23-Oct, "why relay mote keep switching and toggling between sessions unnecesary"):
// reading on the phone must never move the PC window. Mark-read no longer clicks the session, the chip
// sheet's running-task read stays off the DOM unless that session is already open, and every
// away-and-back that remains is written to nav.log with its caller.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
let n = 0;
const ok = (c, name) => { assert.ok(c, name); n++; console.log('ok ' + name); };

(async () => {
  const d = require(path.join(root, 'lib', 'desktop.js'));
  delete process.env.RELAYMOTE_MARKREAD_CLICK;
  const r = await d.markRead('local_00000000-0000-0000-0000-000000000000');
  ok(r.ok && r.skipped === 'PC window not touched', 'mark-read returns without touching Desktop');

  const src = fs.readFileSync(path.join(root, 'lib', 'desktop.js'), 'utf8');
  const ra = src.slice(src.indexOf('async function restoreActive'), src.indexOf('async function renameSession'));
  ok(/noteNav\(away, sessionId\)/.test(ra), 'restoreActive logs every away-and-back to nav.log');

  const t = fs.readFileSync(path.join(root, 'mobile', 'tasks.js'), 'utf8');
  const rr = t.slice(t.indexOf('async function readRunningTasks'), t.indexOf('async function stopRunningTask'));
  ok(/navigate: false/.test(rr) && /ifClosed/.test(rr), 'the chip sheet reads running tasks without opening the session');
  ok(/opts\.navigate === false/.test(t), 'withSession honours navigate:false before any click');

  console.log(`\nno-window-switch: all ok (${n})`);
})().catch(e => { console.error(e); process.exit(1); });
