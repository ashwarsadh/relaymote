// board-live-goals.js — g1881: a tapped gNNNN always finds its goal, and the board opens on what needs him.
// board.json is rebuilt only every 30 min, so a goal named minutes ago was missing ("opens the board, no goal").
// The server now folds goals.jsonl rows newer than the snapshot into the view; a goal can be acted on by id;
// and the first screen ("Needs you") lists only his move / check-and-close goals and asks, recent first,
// with anything older than a week folded below.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

let failed = 0;
const check = (ok, name, extra) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra !== undefined && !ok ? '  ' + JSON.stringify(extra).slice(0, 300) : ''}`); if (!ok) failed++; };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-goals-'));
const built = '2026-10-13T10:00:00.000Z', before = '2026-10-13T09:00:00.000Z', after = '2026-10-13T10:20:00.000Z';
fs.writeFileSync(path.join(dir, 'board.json'), JSON.stringify({ built_at: built, conductor: 'local_C', inbox: [], inbox_waiting: [], inbox_resolved: [], rows: [],
  goals: [{ id: 'g1', title: 'old goal', status: 'open', condition: 'STUCK', session: 'local_A' },
          { id: 'g2', title: 'about to close', status: 'open', condition: 'DELIVERED', session: 'local_A' }] }));
fs.writeFileSync(path.join(dir, 'goals.jsonl'), [
  { id: 'g1', title: 'old goal', status: 'open', session: 'local_A', ts: before },
  { id: 'g2', title: 'about to close', status: 'open', session: 'local_A', ts: before },
  { id: 'g2', status: 'done', outcome: 'shipped', closed_ts: after, ts: after },
  { id: 'g3', title: 'named five minutes ago', status: 'open', session: 'local_B', blocked_on: "on Ashwar's tap: approve the draft", ts: after },
].map(o => JSON.stringify(o)).join('\r\n') + '\r\n'); // CRLF: the register is written from Windows too

process.env.RELAYMOTE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-home-'));
const cfg = require('../lib/config');
cfg.get().board = { dir };
const B = require('../mobile/board');

(async () => {
  if (B.CONDUCTOR_DIR !== dir) { console.log('skip: board dir is ' + B.CONDUCTOR_DIR); process.exit(0); }
  check(!B.readBoard().goals.some(g => g.id === 'g3'), 'control: board.json alone does not have the new goal (the 14-Oct bug)');
  const live = B.readBoardLive();
  const by = Object.fromEntries(live.goals.map(g => [g.id, g]));
  check(by.g3 && by.g3.title === 'named five minutes ago' && by.g3.fresh && by.g3.condition === 'FRESH',
    'a goal newer than board.json is on the board at once (fresh, FRESH)', by.g3);
  check(by.g2 && by.g2.status === 'done' && by.g2.closed_at === after && by.g2.outcome === 'shipped', 'a goal closed after the snapshot shows closed', by.g2);
  check(by.g1 && by.g1.condition === 'STUCK' && !by.g1.fresh && by.g1.ts === before, 'an unchanged goal keeps its snapshot condition and gains its last-change time', by.g1);
  check(JSON.parse(fs.readFileSync(path.join(dir, 'board.json'), 'utf8')).goals.length === 2, 'board.json itself is never written');

  const l = B.lineFor(live, 'done', 'G3');
  check(l.ok && l.target === 'goal' && /^close g3\b/.test(l.line), 'a goal is tapped by its id: Close sends "close g3"', l);
  check(B.lineFor(live, 'yes', 'g3').line.startsWith('go g3'), 'Go ahead on a goal sends "go g3"');
  check(B.lineFor(live, 'answer', 'g3', '').error === 'no-text', 'an empty answer to a goal is refused');
  check(/^answer g3\b[\s\S]*use the second draft/.test(B.lineFor(live, 'answer', 'g3', 'use the second draft').line), 'an answer carries his text');

  const v = (await B.view({})).body;
  const g3 = v.goals.find(g => g.id === 'g3');
  check(g3 && g3.fresh === true && g3.ts === after && 'owner' in g3, 'the phone view carries fresh, last-change time and owner', g3);
  const g2v = v.goals.find(g => g.id === 'g2');
  check(g2v && g2v.status === 'done' && !g2v.progress && !g2v.checks.length && !g2v.detail && g2v.outcome === 'shipped',
    'a finished goal goes to the phone slim: status and outcome only (its full texts made /api/board 4.3 MB)', g2v);

  // ---- g1885: the first screen comes from a light board; the whole one only on demand
  {
    const dayMs = 86400000;
    const ib = [{ n: 11, status: 'open', ts: new Date(Date.now() - 1 * dayMs).toISOString(), text: 'x'.repeat(5000), ask: 'pick one', ask_kind: 'decide' },
                { n: 12, status: 'open', ts: new Date(Date.now() - 20 * dayMs).toISOString(), text: 'old ask' },
                { n: 13, status: 'open', ts: new Date(Date.now() - 20 * dayMs).toISOString(), text: 'old ask about g3' }];
    const bj = JSON.parse(fs.readFileSync(path.join(dir, 'board.json'), 'utf8'));
    fs.writeFileSync(path.join(dir, 'board.json'), JSON.stringify(Object.assign(bj, { inbox: ib, owner_name: 'Ashwar' })));
    const n = (await B.needs({})).body;
    check(n.light && n.inbox.map(r => r.n).join() === '11' && n.old_ids.join() === '12,13' && n.inbox[0].text.length <= 700,
      'needs: last week\'s asks (text capped), older ones as numbers only', { inbox: n.inbox.map(r => r.n), old: n.old_ids });
    check(n.goals.map(g => g.id).join() === 'g3' && n.tab_counts && typeof n.tab_counts.run === 'number', 'needs: only goals on his move or to check, plus the tab counts', n.goals.map(g => g.id));
    const ng = (await B.needs({ goal: 'g2' })).body;
    check(ng.goal === 'g2' && ng.goals.some(g => g.id === 'g2' && g.status === 'done'), 'needs?goal=: a tapped goal comes along whatever its status');
    const n3 = (await B.needs({ goal: 'g3' })).body;
    check(n3.inbox.some(r => r.n === 13) && !n3.old_ids.includes(13), 'needs?goal=: an old ask naming that goal comes in full');
    const t = Date.now(); await B.viewCached({}); await B.viewCached({});
    check(Date.now() - t < 2000, 'the built view is reused while nothing it reads has changed');
    const full = B.phoneFull({ ok: true, finished_keep_days: 3, goals: [{ id: 'a', status: 'open' }, { id: 'b', status: 'done', closed_at: new Date().toISOString() },
      { id: 'c', status: 'done', closed_at: new Date(Date.now() - 30 * dayMs).toISOString() }] });
    check(full.goals.map(g => g.id).join() === 'a,b' && full.finished_hidden === 1, 'the whole board leaves goals finished long ago on the PC', full);
  }
  {
    const idx = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'index.js'), 'utf8');
    const route = (idx.match(/if \(p === '\/api\/board' \|\| p === '\/api\/board\/needs'\) \{[\s\S]*?\n  \}\n/) || [''])[0];
    check(/res\.once\('finish'[\s\S]*maybeBuild/.test(route) && !/await require\('\.\.\/lib\/board-build'\)\.maybeBuild/.test(route),
      'the 2-second board rebuild runs after the answer has gone, never inside it (control: 0.2.104 awaited it)');
    check(/\[board\] \$\{p === '\/api\/board' \? 'full' : 'needs'\} /.test(route), 'every board open is logged with its size and time on the phone\'s path');
    const ui = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'public', 'board-ui.js'), 'utf8');
    check(/api\('\/api\/board\/needs' \+ asQ\(\)/.test(ui) && /const c = cacheGet\(\); if \(c\) \{ B\.data = c;/.test(ui) && /if \(!goal\) cachePut\(d\);/.test(ui),
      'the phone asks for the light board and paints the cached one first (stale-while-revalidate)');
    check(/if \(t\.open && \['bs-run', 'bs-wait', 'bs-done', 'bs-old'\]\.includes\(t\.id\) && !B\.full\) ensureFull\(\);/.test(ui) && /if \(t\.dataset\.tab !== 'bs-need'\) ensureFull\(\);/.test(ui),
      'the whole board loads only when a tab, section or the old fold opens');
  }

  // ---- the phone side: which goals are his, and the order of "Needs you"
  const ui = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'public', 'board-ui.js'), 'utf8');
  const cut = (a, b) => { const i = ui.indexOf(a), j = ui.indexOf(b, i + 1); if (i < 0 || j < 0) throw new Error('missing ' + a); return ui.slice(i, j); };
  const ctx = { B: { data: { owner_name: 'Ashwar' } }, Filter: require('../mobile/public/board-ui.js'), FINISHED: ['done', 'closed', 'failed', 'dropped'] };
  vm.createContext(ctx);
  vm.runInContext([
    cut('const KIND_ORDER', 'const STATUS'), cut('const meName', '/** One plain line'), cut('const goalAge', '\n', ),
    cut('function youText', '\n  }\n') + '\n  }', cut('function needsYou', '/** The full goal'),
    'this.goalKind = goalKind; this.needsYou = needsYou; this.youText = youText;'].join('\n'), ctx);
  const gk = (b, extra) => ctx.goalKind(Object.assign({ blocked_on: b }, extra || {}));
  check(gk("on Ashwar's tap") === 'you' && gk('on his go-ahead') === 'you' && gk('waits on your approval') === 'you', 'his move: blocked on Ashwar / his / your');
  check(gk('on Ajay approving the TDS file') === 'wait' && gk('') === 'run' && gk('', { condition: 'DELIVERED' }) === 'check', 'others: waiting; none: running; delivered: check & close');
  check(ctx.youText("on Ashwar's tap: approve the draft") === 'Your tap: approve the draft' && ctx.youText(', unchanged since 04:06') === 'unchanged since 04:06',
    'what he must do is said to him, not about him');

  const day = 86400000, ago = (d) => new Date(Date.now() - d * day).toISOString();
  const order = ctx.needsYou({
    inbox: [{ n: 1, status: 'open', ts: ago(10), text: 'old ask' }, { n: 2, status: 'open', ts: ago(1), text: 'reply', ask_kind: '' },
            { n: 3, status: 'open', ts: ago(2), text: 'pick one', ask_kind: 'decide' }, { n: 4, status: 'done', ts: ago(1), text: 'closed' }],
    rows: [], goals: [{ id: 'g9', status: 'open', blocked_on: 'on his tap', ts: ago(3) }, { id: 'g8', status: 'open', condition: 'DELIVERED', ts: ago(1) },
                      { id: 'g7', status: 'open', blocked_on: 'on Ajay', ts: ago(1) }, { id: 'g6', status: 'done', blocked_on: 'on his tap', ts: ago(1) }],
  }).map(it => it.id + (it.old ? '(old)' : ''));
  check(order.join() === '#3,g9,g8,#2,#1(old)', 'Needs you: decide, his move, check & close, reply; older than a week last; closed and others\' goals left out', order);

  console.log(failed ? `\n${failed} FAILED` : '\nall board-live-goals checks passed');
  process.exit(failed ? 1 : 0);
})();
