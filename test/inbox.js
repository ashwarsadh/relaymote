// inbox.js — the inbox ledger (lib/inbox.js), its auto-resolver, Board answers landing on cards, the
// Board's inbox drawers, the one chip/list predicate, the board.html build check, and the MCP inbox
// tools over real stdio. Temp BATON_HOME / APPDATA / CLAUDE_CONFIG_DIR, stub sender; nothing reaches
// Claude Desktop or a real session.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-inbox-'));
process.env.BATON_HOME = path.join(TMP, 'baton');
process.env.APPDATA = path.join(TMP, 'appdata');
process.env.CLAUDE_CONFIG_DIR = path.join(TMP, 'claude');
delete process.env.BATON_STATE_DIR;

const config = require('../lib/config');
const inbox = require('../lib/inbox');
const goals = require('../lib/goals');
const boardBuild = require('../lib/board-build');
const board = require('../mobile/board');
const Filter = require('../mobile/public/board-ui.js');

let failed = 0;
const check = (ok, name, extra) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && extra !== undefined ? '  ' + JSON.stringify(extra).slice(0, 300) : ''}`); if (!ok) failed++; };

const DAY = 86400000, MIN = 60000, H = 3600000;
const NOW = Date.parse('2026-02-10T12:00:00Z');
const iso = (t) => new Date(t).toISOString();
const sid = (n) => 'local_' + String(n).padStart(8, 'a') + '-0000-4000-8000-000000000000';
const BOARD_DIR = path.join(config.DATA, 'board');
function reset() { fs.rmSync(BOARD_DIR, { recursive: true, force: true }); fs.rmSync(goals.DIR, { recursive: true, force: true }); }
const lines = () => { try { return fs.readFileSync(inbox.file(), 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } };
const item = (n) => inbox.fold().items.get(n);

(async () => {
  // ---------------------------------------------------------------- operations
  reset();
  const a1 = inbox.add('Approve the new pricing table before it goes live on Monday', { session: sid(1), now: NOW - 3 * H });
  check(a1.ok && a1.n === 1 && !a1.warnings.length, 'add: verbatim text with a session, numbered #1');
  const a2 = inbox.add('Something with no lane attached to it at all, recorded anyway', { now: NOW - 2 * H });
  check(a2.ok && a2.n === 2 && a2.warnings.some(w => /session/i.test(w)), 'add without a session warns (guard fires) but still records', a2.warnings);
  check(inbox.add('   ').ok === false, 'empty text is refused');
  const long = 'Decide whether the release goes out today or waits until the flaky integration suite is green again, '.repeat(3);
  check(inbox.ask(1, 'decide', long).ok === false && !item(1).ask, 'an ask over 200 chars is refused and nothing is written (guard fires)');
  const r178 = inbox.ask(1, 'decide', 'Approve the pricing table (yes/no)? The finance lane needs it before Monday; later means the old prices stay live for a week and every quote sent meanwhile uses them, so please answer today.');
  check(r178.ok && (r178.warnings || []).some(w => /178|visible|card/i.test(w)), 'an ask whose imperative runs past ~178 visible chars is kept but warned', r178);
  check(inbox.ask(1, 'shout', 'x').ok === false, 'ask kind must be decide | do | fyi');
  check(inbox.ask(1, 'decide', 'Approve the pricing table: yes or no?').ok && item(1).ask_kind === 'decide', 'ask sets the one-line imperative question');
  check(inbox.setText(1, 'too short').ok === false, 'rewriting text to a fragment (< 20 chars) is refused');
  const huge = 'n'.repeat(15000);
  const nt = inbox.note(1, huge);
  check(nt.ok && item(1).note.length === 15000, 'note appends with no truncation');
  inbox.note(1, 'second note');
  check(item(1).note.endsWith(' | second note') && item(1).note.startsWith('nnn'), 'a second note is appended, never replaces');
  const before = lines();
  inbox.link(2, sid(2));
  check(lines() === before + 1 && item(2).session === sid(2), 'every change appends one ledger row (append-only)');
  check(inbox.show(1).history.length >= 4, 'show returns the item with its full history');
  inbox.add('A record of what happened overnight, for the log only', { kind: 'log', now: NOW - 5 * DAY });
  const l = inbox.list({});
  check(l.items.every(i => i.kind !== 'log') && l.counts.logHidden === 1, 'list hides log items unless --all');
  inbox.add('Tie on the clock: created at the same instant as the next one', { session: sid(3), now: NOW });
  inbox.add('Tie on the clock: the second of the two created together', { session: sid(3), now: NOW });
  const order = inbox.list({}).items.map(i => i.n);
  check(order[0] === 5 && order[1] === 4 && order.indexOf(1) > order.indexOf(2), 'newest first, ties broken by number', order);
  inbox.done(2, 'handled by phone');
  check(item(2).status === 'done' && /handled by phone/.test(item(2).note) && item(2).n === 2, 'done keeps the number and adds the closing word to the note');
  check(inbox.add('Another one after a close, to check numbers never move', { session: sid(1), now: NOW }).n === 6 && item(1).n === 1, 'item numbers never change');
  const sw = inbox.sweep(2, { now: NOW });
  check(item(3).status === 'done' && sw && JSON.stringify(sw).includes('3'), 'sweep closes quiet log items');
  inbox.wait(4);
  check(item(4).status === 'waiting' && inbox.list({}).counts.waiting === 1, 'wait marks an item in flight');
  check(inbox.setKind([6], 'log').ok && item(6).kind === 'log', 'kind reclassifies');

  // ---------------------------------------------------------------- the command line
  const cliBefore = lines();
  const bad = inbox.cli(['add', 'some text that is long enough', '--sesion', sid(1)]);
  check(bad.code === 2 && /unknown option/.test(bad.text) && lines() === cliBefore, 'inbox add refuses an unknown flag and writes NOTHING (guard fires)', bad);
  const good = inbox.cli(['add', 'A proper item from the command line, verbatim', '--session', sid(1)]);
  check(good.code === 0 && /#7/.test(good.text), 'inbox add from the CLI', good.text);
  const nos = inbox.cli(['add', 'A proper item with no session named anywhere']);
  check(nos.code === 0 && /session/i.test(nos.text), 'the CLI prints the no-session warning', nos.text);
  const fromStdin = inbox.cli(['note', '7', '-'], { stdin: () => 'text with `backticks` read from stdin' });
  check(fromStdin.code === 0 && /`backticks`/.test(item(7).note), '- reads the text from stdin');
  check(/#1\b/.test(inbox.cli(['list']).text) && inbox.cli(['help']).code === 0, 'list and help');

  // ---------------------------------------------------------------- session of an item
  const full = sid(9);
  check(inbox.sessionOf({ text: 'see ' + full + ' for details' }) === full, 'a full session id named in the text is the item\'s session');
  const pm = new Map([[full.slice(0, 14), full]]);
  check(inbox.sessionOf({ text: 'lane ' + full.slice(0, 14) + ' asked this' }, { prefixMap: pm }) === full, 'an 8-hex prefix resolves through the index prefix map');
  check(inbox.sessionOf({ text: 'lane ' + full.slice(0, 14) + ' asked this' }, { prefixMap: new Map() }) === null, 'an unknown prefix resolves to nothing, never a guess');

  // ---------------------------------------------------------------- board answers land on the card
  reset();
  inbox.add('Which carrier should the samples go with this week?', { session: sid(1), now: NOW - H });
  const acts = [
    { at: iso(NOW - 30 * MIN), kind: 'answer', id: '#1', target: 'inbox', line: 'answer #1: the usual one, tracked   # #1 Which carrier', result: 'delivered' },
    { at: iso(NOW - 20 * MIN), kind: 'answer', id: '#1', target: 'inbox', line: 'answer #1: this one failed', result: 'failed' },
  ];
  check(inbox.ingestBoardAnswers({ actions: acts }) === 1, 'a delivered Board answer is ingested');
  check(/ANSWER from the board .*the usual one, tracked/.test(item(1).note) && !/failed/.test(item(1).note) && item(1).answered_at, 'the answer TEXT lands on the card with answered_at; a failed send does not');
  check(inbox.ingestBoardAnswers({ actions: acts }) === 0, 'ingesting again changes nothing (idempotent)');

  // ---------------------------------------------------------------- the auto-resolver
  reset();
  const T0 = NOW - 10 * DAY;
  const mk = (text, o = {}) => inbox.add(text, { now: T0, ...o }).n;
  const nTap = mk('Please sign the updated contract draft and send it back', { session: sid(1) });
  const nPin = mk('Pinned: check the renewal quote with the landlord this week', { session: sid(1) });
  inbox.reopen(nPin, 'still needed');
  const nCrit = mk('Approve the payment of the deposit to the new supplier', { session: sid(2) });
  const nRec = mk('fyi: no action - the nightly backup moved to 02:00', {});
  const nSeen = mk('Pick the hero image for the landing page redesign', { session: sid(3) });
  const nOrph = mk('Review the export of the quarterly figures', { session: sid(4) });
  const nCritRec = mk('fyi: no action - refund issued to the customer yesterday', {});
  const taps = [{ at: iso(T0 + H), kind: 'done', id: '#' + nTap, result: 'delivered' }, { at: iso(T0 + H), kind: 'done', id: '#' + nPin, result: 'delivered' },
    { at: iso(T0 - H), kind: 'done', id: '#' + nSeen, result: 'delivered' }];
  const deps = {
    now: NOW, actions: taps, relays: () => [], sessionInfo: () => null,
    ownerSpokeAfter: (s, when) => (s === sid(3) ? { at: when + H, text: 'something else' } : null),
    sessionReportedAfter: (s, when) => (s === sid(4) || s === sid(2) ? { at: when + H } : null),
  };
  const r = inbox.autoResolve(deps);
  check(item(nTap).status === 'resolved?' && item(nTap).resolved_tier === 'high', 'your tap on the card flags it HIGH, to resolved? (never straight to done)');
  check(item(nPin).status === 'open' && !r.flagged.some(f => f.n === nPin), 'a reinstated (pinned) item is never auto-resolved, even with a tap');
  check(item(nCrit).status === 'open' && !item(nCrit).orphaned, 'a money/deletion/outward item is never touched on weak evidence');
  check(item(nRec).status === 'resolved?' && item(nRec).resolved_tier === 'low', 'a pure record older than recordDays is flagged, LOW');
  check(item(nCritRec).status === 'open', 'a critical record is not flagged either');
  check(item(nSeen).status === 'open' && item(nSeen).seen_in_lane, 'you spoke in its lane afterwards: MARKED seen, left open (a tap before it was raised does not count)');
  check(item(nOrph).status === 'open' && item(nOrph).orphaned, 'its session carried on and ended: marked ORPHANED (ownerless, not done)');
  let r2 = inbox.autoResolve({ ...deps, now: NOW + 2 * DAY });
  check(!r2.closed.length && item(nTap).status === 'resolved?', 'nothing closes before graceDays');
  r2 = inbox.autoResolve({ ...deps, now: NOW + 5 * DAY });
  check(r2.closed.includes(nTap) && item(nTap).status === 'done', 'after graceDays a HIGH (earned) flag closes');
  check(!r2.closed.includes(nRec) && item(nRec).status === 'resolved?', 'a LOW flag never closes by itself: it waits for you');
  inbox.reopen(nRec, 'not handled');
  check(item(nRec).status === 'open' && item(nRec).no_auto && !item(nRec).resolved_tier, 'Reinstate puts it back open and pins it');
  const beforeOff = lines();
  const m0 = inbox.maintain({ ...deps, now: NOW + 9 * DAY });
  check(m0.resolve === null && lines() === beforeOff, 'maintain: the auto-resolver is OFF unless the inboxAutoResolve module is on');
  check(inbox.maintain({ ...deps, autoResolve: true, now: NOW + 9 * DAY }).resolve !== null, 'maintain runs it when the module is on');
  check(inbox.linkIsAbout('the landing page hero image', { title: 'Landing page redesign', project: 'web', tags: ['image'] }) === true
    && inbox.linkIsAbout('the quarterly figures', { title: 'Landing page redesign' }) === false, 'an inferred lane is trusted only with 2 shared word stems');

  // ---------------------------------------------------------------- the Board: drawers, reopen, counts
  reset();
  const OLD = NOW - 20 * DAY;
  inbox.add('A question nobody asked properly, just a statement of facts here', { session: sid(1), now: NOW - H });
  inbox.add('Clear this: the weekly report went out as usual', { session: sid(1), now: NOW - H, ask_kind: 'fyi' });
  inbox.ask(2, 'fyi', 'The weekly report went out.');
  inbox.add('This was probably handled already by the lane itself', { session: sid(2), now: NOW - 3 * DAY });
  inbox.autoResolve({ now: NOW, actions: [{ at: iso(NOW - DAY), kind: 'done', id: '#3', result: 'delivered' }], relays: () => [], sessionInfo: () => null });
  inbox.add('Waiting on the courier to confirm the pickup slot', { session: sid(2), now: NOW - 2 * H });
  inbox.wait(4);
  inbox.add('Mentions lane ' + sid(5).slice(0, 14) + ' only by its short prefix here', { now: NOW - H });
  goals.add({ title: 'Recently finished goal' }, { resolve: () => ({ ok: false }) });
  goals.add({ title: 'Long finished goal' }, { resolve: () => ({ ok: false }) });
  goals.add({ title: 'Still open goal', project: 'web' }, { resolve: () => ({ ok: false }) });
  goals.close('g1', { note: 'done', now: NOW - DAY });
  goals.close('g2', { note: 'done', now: NOW - 5 * DAY });
  goals.mutate(reg => { goals.find(reg, 'g1').closedAt = iso(NOW - DAY); goals.find(reg, 'g2').closedAt = iso(NOW - 5 * DAY); });
  const bsessions = [
    { id: sid(7), title: 'Old question', cwd: path.join(TMP, 'api'), lastActivityAt: OLD + 8 * DAY, awaiting: true, live: true },
    { id: sid(8), title: 'Fresh question', cwd: path.join(TMP, 'web'), lastActivityAt: NOW - 10 * MIN, awaiting: true, live: true },
  ];
  const index = { sessions: { [sid(5)]: { project: 'web', title: 'Web lane' } } };
  const built = await boardBuild.build({ now: NOW, sessions: bsessions, pendingQuestion: () => null, conductor: sid(99), index, hygiene: { counts: { 'CTX-FULL': 2, OK: 1 }, wakes: { baton24: 3, lastDay: { warm: 5, cold: 2 } },
    items: [{ id: sid(7), title: 'Big lane', verdict: 'CTX-FULL', why: 'over the threshold', tokens: 9 }, { id: sid(8), title: 'Fine lane', verdict: 'OK', tokens: 1 }] }, maintain: false });
  const bj = JSON.parse(fs.readFileSync(boardBuild.boardFile(), 'utf8'));
  check(built.written && ['inbox_waiting', 'inbox_resolved', 'goals_health', 'hygiene', 'owner_name', 'projects'].every(k => k in bj), 'board.json passes inbox_waiting, inbox_resolved, goals_health, hygiene and owner_name through', Object.keys(bj));
  check(bj.inbox.map(i => i.n).join() === '5,2,1' && bj.inbox_waiting[0].n === 4 && bj.inbox_resolved[0].n === 3 && bj.inbox_resolved[0].tier === 'high', 'open, in-flight and probably-handled items go to their own lists', [bj.inbox.map(i => i.n), bj.inbox_waiting.length, bj.inbox_resolved.length]);
  check(bj.inbox.find(i => i.n === 5).session === sid(5) && bj.inbox.find(i => i.n === 5).project === 'web', 'an item\'s session is resolved from an 8-hex prefix in its text, and its project follows');
  check(bj.inbox.find(i => i.n === 1).ask_kind === '', 'an item with no ask carries an empty ask_kind (the NO QUESTION badge)');
  check(bj.owner_name === 'you' && bj.hygiene.counts['CTX-FULL'] === 2, 'owner name defaults to "you"; hygiene counts pass through');
  check(bj.hygiene.wakes.lastDay.cold === 2 && bj.hygiene.items.length === 1 && bj.hygiene.items[0].verdict === 'CTX-FULL' && !('tokens' in bj.hygiene.items[0]), 'hygiene: the wake roll-up passes through; only sessions needing a look are carried, slimmed');
  const gIds = bj.goals.map(g => g.id);
  check(gIds.includes('g1') && !gIds.includes('g2') && gIds.includes('g3') && bj.finished_older === 1 && bj.finished_keep_days === 3, 'finished goals stay 3 days (Finished drawer), older ones are only counted', { gIds, older: bj.finished_older });
  const oldRow = bj.rows.find(x => x.id === sid(7));
  check(oldRow && oldRow.age > 7 && bj.counts.decide === 2, 'the header count has NO age cut-off: a 12-day-old question still counts', { age: oldRow && oldRow.age, counts: bj.counts });
  const v = (await board.view()).body;
  check(v.counts.decide === 2 && v.counts.inbox === 3, 'the app\'s counts have no age cut-off either', v.counts);
  check(v.inbox_resolved.length === 1 && v.inbox_waiting.length === 1 && v.goals_health && v.hygiene && v.goals.every(g => 'condition' in g && 'closed_at' in g), 'the app view passes the new sections through');

  // one predicate: a chip's number is exactly the cards its filter shows
  const f0 = { days: null, project: 'all', q: '', showHandled: false };
  const all = v.rows.concat(v.inbox);
  for (const key of ['all', 'inbox', 'decide', 'ask:fyi', 'ask:none']) {
    const shown = all.filter(x => Filter.matches(x, { ...f0, bucket: key }));
    const counted = Filter.count(v.rows, { ...f0, bucket: key }) + Filter.count(v.inbox, { ...f0, bucket: key });
    check(shown.length === counted, `chip "${key}": count == cards shown (${counted})`);
  }
  check(Filter.count(v.inbox, { ...f0, bucket: 'ask:none' }) === 2, 'the NO QUESTION chip counts items with no ask_kind');
  check(Filter.count(v.rows, { ...f0, bucket: 'decide', days: 7 }) === 1 && Filter.count(v.rows, { ...f0, bucket: 'decide' }) === 2, 'the day filter is a filter you apply, not a hidden cut-off');
  check(Filter.count(v.inbox, { ...f0, bucket: 'inbox', project: 'web' }) === 1, 'the project filter narrows the chip and the list alike');
  check(Filter.count([{ bucket: 'decide', acted: { kind: 'yes' } }], { ...f0, bucket: 'decide' }) === 0 && Filter.count([{ bucket: 'decide', acted: { kind: 'yes' } }], { ...f0, bucket: 'decide', showHandled: true }) === 1, 'a card you already answered moves to Handled');

  // taps: reopen (Reinstate) on a probably-handled card, Done on an open one, reopen refused on a session
  check(board.lineFor(bj, 'reopen', '#3').ok && /^reopen #3 /.test(board.lineFor(bj, 'reopen', '#3').line), 'Reinstate on a probably-handled card composes a "reopen #n" line');
  check(board.lineFor(bj, 'reopen', sid(8)).error === 'bad-kind', 'reopen on a session row is refused (guard fires)');
  check(board.lineFor(bj, 'yes', '#1').error === 'bad-kind', 'Yes on an inbox card is refused');
  const msgs = [];
  board._setSender(async (to, text) => { msgs.push({ to, text }); return { ok: true, delivered: true }; });
  board._setConductorState(async () => ({ id: sid(99), ok: true, reason: 'idle' }));
  const out = await board.actBatch({ items: [{ kind: 'reopen', id: '#3' }, { kind: 'done', id: '#2' }] });
  check(out.code === 200 && msgs.length === 1 && /reopen #3/.test(msgs[0].text) && /done #2/.test(msgs[0].text), 'bulk taps go as ONE message to the Conductor');
  check(item(3).status === 'open' && item(3).no_auto && item(2).status === 'done', 'on Relaymote\'s own board a delivered Reinstate reopens and pins; Done closes');
  board._setSender(null); board._setConductorState(null);

  // ---------------------------------------------------------------- board.html: the build refuses a broken script
  check(boardBuild.jsOpenStrings(boardBuild.BOARD_JS).length === 0, 'the shipped board script has no open string');
  const broken = "var a = 'fine';\nvar b = 'a real newline\ninside a string';\n";
  const hits = boardBuild.jsOpenStrings(broken);
  check(hits.length >= 1 && hits[0].line === 2, 'an unclosed JS string is found, with its line (guard fires)', hits);
  check(boardBuild.jsOpenStrings("/* don't\n it's fine */ var x = 1; // won't\n").length === 0, 'apostrophes in comments do not cry wolf');
  const htmlFile = path.join(TMP, 'out', 'board.html');
  let w = boardBuild.writeHtml(bj, { file: htmlFile, script: broken });
  check(!w.written && /unclosed string/.test(w.reason) && !fs.existsSync(htmlFile), 'board.html is NOT written when its script would not parse');
  w = boardBuild.writeHtml(bj, { file: htmlFile });
  const html = fs.readFileSync(htmlFile, 'utf8');
  check(w.written && /generator" content="baton"/.test(html) && /NO QUESTION/.test(html) && /Probably handled/.test(html) && /Reinstate/.test(html) && /outside the cache window|outside/.test(html), 'board.html is written with the inbox sections and the hygiene wake line');
  fs.writeFileSync(htmlFile, '<html>someone else\'s board</html>');
  w = boardBuild.writeHtml(bj, { file: htmlFile });
  check(!w.written && fs.readFileSync(htmlFile, 'utf8').includes('someone else'), 'a board.html written by something else is left alone');
  check(config.get().board && 'html' in config.get().board && config.get().board.finishedKeepDays === 3, 'board.html path and finishedKeepDays are in config DEFAULTS');
  check(config.get().modules.inbox === true && config.get().modules.inboxAutoResolve === false && config.get().inbox.ownerName === 'you', 'modules: inbox on (passive), inboxAutoResolve off');

  // ---------------------------------------------------------------- MCP tools over stdio
  const mcp = (sessionId) => {
    const env = { ...process.env, BATON_HOME: process.env.BATON_HOME, BATON_PORT: '9', BATON_APP_PORT: '9', BATON_CDP_PORT: '9', CLAUDE_CODE_HOST_SESSION_ID: sessionId };
    delete env.CLAUDE_CODE_SESSION_ID;
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'mcp', 'baton-mcp.js')], { cwd: TMP, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '', seq = 0; const waiting = new Map();
    child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); let m; try { m = JSON.parse(line); } catch { continue; } if (m.id != null && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } } });
    child.stderr.on('data', () => {});
    const rpc = (method, params) => new Promise((res, rej) => { const id = ++seq; const t = setTimeout(() => rej(new Error('timeout ' + method)), 20000); waiting.set(id, (m) => { clearTimeout(t); res(m); }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
    const call = async (name, args) => { const m = await rpc('tools/call', { name, arguments: args || {} }); let body = null; try { body = JSON.parse(m.result.content[0].text); } catch {} return body; };
    return { rpc, call, close: () => { try { child.stdin.end(); child.kill(); } catch {} } };
  };
  reset();
  const S = mcp(sid(21));
  try {
    await S.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'inbox-test', version: '0' } });
    const names = (await S.rpc('tools/list', {})).result.tools.map(t => t.name);
    check(['baton_inbox_add', 'baton_inbox', 'baton_inbox_update'].every(n => names.includes(n)), 'MCP: baton_inbox_add, baton_inbox and baton_inbox_update are listed');
    const added = await S.call('baton_inbox_add', { text: 'Decide which of the two layouts ships in the next release', ask_kind: 'decide', ask: 'Layout A or B?' });
    check(added && added.ok && added.item.session === sid(21) && item(added.n).ask === 'Layout A or B?', 'a slave may add; its own session is recorded and the ask is set', added);
    const listed = await S.call('baton_inbox', {});
    check(listed && listed.ok && listed.items.length === 1, 'a slave may read the inbox');
    const upd = await S.call('baton_inbox_update', { op: 'done', n: added.n });
    check(upd && upd.error === 'NOT_MASTER' && item(added.n).status === 'open', 'a slave may NOT change items (guard fires)', upd);
  } finally { S.close(); }

  // Goals register (board-ui.js source): the #board=goals deep link opens it the way the chip does, and
  // "open" is one predicate everywhere, so the chip count cannot drift from the register (AGO counted
  // closed and failed goals as open with a stray `status !== 'done'`: 144 vs 126).
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'public', 'board-ui.js'), 'utf8');
    const hashFn = (src.match(/const openIfHashed = [\s\S]*?\n  \};/) || [''])[0];
    check(/m\[1\] === 'goals'\)[^\n]*B\.goalsOpen = true/.test(hashFn), '#board=goals opens the goals register expanded');
    const stray = src.match(/\.status\s*[!=]==?\s*'(done|closed|failed|dropped)'/g) || [];
    check(stray.length === 0 && (src.match(/FINISHED\.includes\(g\.status\)/g) || []).length >= 4, 'goal open/finished is decided only by FINISHED (chip count = register split)', stray);
  }

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
