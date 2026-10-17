'use strict';
// reading-position.js: while someone reads mid-log, a live update must not move the message being read.
// Runs the REAL applyTail() out of app.js in a vm, plus source guards for the three defects measured live
// at 375: the stream's 60-row tail replacing loaded history, block keys carrying the row index, and
// loadMore's stale second scroll write.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const app = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'public', 'app.js'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'index.js'), 'utf8');
const a = app.indexOf('function applyTail(');
const src = app.slice(a, app.indexOf('\nfunction ', a + 20));
assert.ok(a > 0 && src.length > 300, 'applyTail not found');

function load({ messages, atBottom = false, toBottom = false, oldestByte = 100, hasMore = true }) {
  const ctx = { state: { messages, oldestByte, hasMore }, logAtBottom: atBottom, scrollToBottomNext: toBottom };
  vm.createContext(ctx);
  vm.runInContext(src + '\n;globalThis.__f = applyTail;', ctx);
  return ctx;
}
const row = (n, role = 'assistant') => ({ role, ts: '2026-09-24T00:00:' + String(n).padStart(2, '0') + 'Z', text: 'r' + n });
const range = (a, b) => Array.from({ length: b - a }, (_, i) => row(a + i));
const ids = (l) => l.map(m => m.text).join(',');
let n = 0;
const ok = (c, name) => { assert.ok(c, name); n++; console.log('ok ' + name); };

{ // control: the old rule rendered the tail as the whole list, dropping every loaded row above it
  const OLD = (tail) => tail;
  ok(ids(OLD(range(10, 31))) !== ids(range(0, 31)), 'control: replacing the list with the tail loses rows 0-9 (the jump)');
}
{ // reading mid-log with older pages loaded: they stay, the tail is spliced on
  const c = load({ messages: range(0, 30) });
  const out = c.__f(range(10, 31), 5, true);
  ok(ids(out) === ids(range(0, 31)), 'reading: older rows kept, the new row appended');
  ok(c.state.oldestByte === 100 && c.state.hasMore === true, 'reading: paging still describes the top of what is loaded');
}
{ // the window slid by one: the row that fell off the front is kept
  const c = load({ messages: range(0, 10) });
  ok(ids(c.__f(range(1, 11), 5, true)) === ids(range(0, 11)), 'window slides one row: nothing above the reader is removed');
}
{ // a streaming reply grows in place: the tail's version wins
  const cur = range(0, 5); const tail = range(0, 5); tail[4] = Object.assign({}, tail[4], { text: 'r4 longer' });
  ok(load({ messages: cur }).__f(tail, 0, false)[4].text === 'r4 longer', 'a row that grew is taken from the tail');
}
{ // at the bottom the tail alone is right, and paging follows it
  const c = load({ messages: range(0, 30), atBottom: true });
  ok(ids(c.__f(range(10, 31), 7, true)) === ids(range(10, 31)) && c.state.oldestByte === 7, 'at the bottom: the tail alone, oldestByte from the server');
  const s = load({ messages: range(0, 30), toBottom: true });
  ok(ids(s.__f(range(10, 31), 7, true)) === ids(range(10, 31)), 'after an own send: the tail alone');
}
{ // no overlap: more arrived than one window holds
  const c = load({ messages: range(0, 5) });
  ok(ids(c.__f(range(20, 25), 9, true)) === ids(range(20, 25)) && c.state.oldestByte === 9, 'no overlap: the tail is the truth, paging reset');
  const o = load({ messages: range(0, 5) });
  o.__f(range(20, 25), undefined, undefined);
  ok(o.state.oldestByte === 100, 'an old server without startByte leaves paging alone');
}
{ // repeated timestamps: the splice point is confirmed by the following rows, not the first match
  const dup = [row(1), row(1), row(2), row(3)];
  const out = load({ messages: [row(0)].concat(dup) }).__f([row(1), row(2), row(3), row(4)], 0, false);
  // The first r1 is followed by another r1, not r2, so the splice lands on the second one.
  ok(ids(out) === 'r0,r1,r1,r2,r3,r4', 'repeated timestamps splice on the confirmed sequence');
}
ok(/renderLog\(applyTail\(d\.messages, d\.startByte, d\.hasMore\)\)/.test(app), 'the stream handler goes through applyTail');
ok(/renderLog\(applyTail\(d\.transcript\.messages, d\.transcript\.startByte, d\.transcript\.hasMore\), false\)/.test(app), 'the timed reload goes through applyTail');
ok(/startByte: tr\.startByte, hasMore: tr\.hasMore/.test(server), 'the server stream carries startByte / hasMore');
ok(!/const k = keyOf\(m\) \+ ':' \+ i;/.test(app) && /key: wk,/.test(app), 'block keys carry no row index; a working group is keyed by its first row');
ok(/const anchorKey = \(el\) => el\.dataset\.key \? 'k:' \+ el\.dataset\.key/.test(app), 'a working group anchors by data-key, not its changing summary');
ok(/counts\.get\(key\) === 1/.test(app) && /el\.id !== 'log-top'/.test(app), 'ambiguous keys and the history sentinel are never anchors');
const lm = app.slice(app.indexOf('async function loadMore()'), app.indexOf('const topSentinel'));
ok(!/log\.scrollTop = top \+/.test(lm), 'loadMore leaves the position to renderLog (no stale second write)');

{ // 17-Oct: after a minimise the stamps read "just now" and a reload lost the place he was reading.
  const resume = app.slice(app.indexOf('function tickStamps('), app.indexOf('let resumeAt'));
  ok(/for \(const ev of \['visibilitychange', 'pageshow', 'focus', 'resume'\]\)/.test(resume) && /tickStamps\(\)/.test(resume),
    'stamps are re-derived synchronously when the page comes back, not on the frozen 30 s timer');
  ok(/\[data-at\]/.test(resume) && /data-at="\$\{Number\(s\.at\) \|\| 0\}"/.test(app), 'session-list ages are refreshed the same way');
  const sp = app.slice(app.indexOf('function savePlace('), app.indexOf('function savePlace(') + 400);
  ok(/place\.atBottom = !!logAtBottom/.test(sp) && /place\.anchor = readingAnchor/.test(sp), 'savePlace keeps the reading anchor (message key + offset)');
  ok(/state\.restorePlace = \{ id: p\.id, anchor: place\.anchor \}/.test(app) && /const back = state\.restorePlace/.test(app), 'a resumed chat puts that anchor back on its first render');
}

console.log(`\n${n}/${n} passed`);
