// board-queue.js — the Board's day filter and reply queue (mobile/public/board-ui.js, index.html).
// A day chip filters the For-you cards too (their age from ts) and the list says how many it holds back;
// the Handled count is the list a tap on it shows; every tap QUEUES and the queue goes as ONE message
// (Send all, the board closing by any path, a reopen or a return to the foreground with a queue left).
// Static checks on the source, each shown firing on the old shape; Filter itself is run.
'use strict';
const fs = require('fs');
const path = require('path');

let failed = 0;
const check = (ok, name, extra) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra !== undefined && !ok ? '  ' + JSON.stringify(extra).slice(0, 300) : ''}`); if (!ok) failed++; };

const P = f => fs.readFileSync(path.join(__dirname, '..', 'mobile', 'public', f), 'utf8');
const ui = P('board-ui.js');
const html = P('index.html');
const Filter = require('../mobile/public/board-ui.js');

// ---- the day filter: For-you cards too, age from ts
const now = Date.now(), day = 86400000;
const f0 = { bucket: 'all', days: null, project: 'all', q: '', showHandled: false };
const old = { n: 5, status: 'open', ts: new Date(now - 10 * day).toISOString(), text: 'old ask' };
const fresh = { n: 6, status: 'open', ts: new Date(now - 1 * day).toISOString(), text: 'new ask' };
const noTs = { n: 7, status: 'open', text: 'undated ask' };
check(Math.round(Filter.ageOf(old)) === 10 && Filter.ageOf({ age: 3, ts: old.ts }) === 3 && Filter.ageOf(noTs) === null, 'ageOf: the row\'s own age, else from ts, else unknown');
check(Filter.count([old, fresh, noTs], { ...f0, days: 7 }) === 2 && Filter.count([old, fresh, noTs], f0) === 3,
  'a 7d chip hides a 10-day-old For-you card; an undated one is never hidden; no chip hides nothing');
check(Filter.count([{ bucket: 'decide', age: 12 }], { ...f0, bucket: 'decide', days: 7 }) === 0, 'session rows keep their day filter');
{
  // The control: the old predicate returned before the days check for inbox cards.
  const OLD = (r, f) => (r.n != null ? r.status === 'open' : !(f.days != null && r.age != null && r.age > f.days));
  check([old, fresh].filter(r => OLD(r, { days: 7 })).length === 2, 'control: the old predicate let the 10-day-old card through a 7d chip');
}
check(/if \(!B\.showHandled && B\.days != null\) \{\s*const older = Filter\.count\(d\.inbox, filt\(\{ days: null \}\)\) - inbox\.length;/.test(ui)
  && /id="board-older"/.test(ui) && /closest\('#board-older'\)\) \{ B\.days = null; render\(\); return; \}/.test(ui),
  'the list says how many older asks the chip holds back, and one tap shows them');
check(/const nDone = Filter\.count\(d\.rows, filt\(\{ showHandled: true \}\)\) \+ Filter\.count\(d\.inbox, filt\(\{ showHandled: true \}\)\);/.test(ui)
  && !/filt\(\{ bucket: 'all', showHandled: true \}\)/.test(ui), 'the Handled count is the list a tap on it shows (this bucket), not bucket "all"');

// ---- the queue: every tap queues; one message; the flush triggers
const oldUi = "send(kind, id);\n api('/api/board/act', {";
const perTap = (src) => /api\('\/api\/board\/act',/.test(src) || /\bsend\(kind, id\)/.test(src);
check(perTap(oldUi) && !perTap(ui), 'no per-tap send is left: a tap never POSTs /api/board/act on its own (fires on the old shape)');
check(/enqueue\(kind, id\);\s*\/\/ queued/.test(ui) && /enqueue\('answer', id, text\);/.test(ui), 'a tap and an answer both queue');
check(/body: JSON\.stringify\(\{ bid: batchId\(batch\), why, items:/.test(ui), 'the batch carries a bid, so a retry is recognised');
check(/new MutationObserver\(\(\) => \{\s*if \(\$\('view-board'\)\.classList\.contains\('hidden'\) && B\.queue\.length && !isHeld\(\)\) flush\('board-closed'\);/.test(ui)
  && /\.observe\(\$\('view-board'\), \{ attributes: true, attributeFilter: \['class'\] \}\)/.test(ui), 'closing the board by ANY path sends the queue (watched on the sheet\'s hidden class)');
check(/\$\('board-sendall'\)\.onclick = \(\) => flush\('send-all'\);/.test(ui), '"Send all as one" sends it');
check(/if \(B\.queue\.length\) setTimeout\(\(\) => \{ if \(\$\('view-board'\)\.classList\.contains\('hidden'\) && !isHeld\(\)\) flush\('reopen'\); \}, 4000\);/.test(ui)
  && /visibilitychange[\s\S]{0,160}flush\('resume'\)/.test(ui), 'a queue left over goes on the next open and on a return to the foreground');
check(/const went = new Set\(batch\.map\(q => q\.id \+ '@' \+ q\.at\)\);/.test(ui), 'only what went is removed: a tap made while sending stays queued');
check(!/B\.batch\b/.test(ui), 'the old opt-in Batch switch is gone (queueing is always on)');

// ---- the markup
const board = (html.match(/<section id="view-board"[\s\S]*?<\/section>/) || [''])[0];
check(/<div class="board-head">\s*<h2>Board[\s\S]*?id="btn-board-refresh"[^>]*>&#x21bb;<\/button>\s*<\/div>/.test(board), 'Refresh is the ↻ icon in the title row');
check(/<div class="board-filters">\s*<div class="search-row board-search">[\s\S]*?id="board-q"[\s\S]*?id="board-days"[\s\S]*?<\/nav>\s*<\/div>/.test(board), 'search and the day chips share one row');
check(/id="board-pending"[\s\S]*id="board-pending-n"[\s\S]*id="board-sendall"/.test(board), 'the pending bar is under the list');
{
  const acts = (board.match(/<div class="sheet-actions board-actions">([\s\S]*?)<\/div>/) || [, ''])[1];
  check((acts.match(/<button/g) || []).length === 1 && /btn-close-board/.test(acts), 'the footer has Done only', acts);
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall board-queue checks passed');
process.exit(failed ? 1 : 0);
