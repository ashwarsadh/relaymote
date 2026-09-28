// mobile-session-search.js — g784: find text inside ONE session, across its whole transcript, so a
// match in history the phone has not loaded yet is still found; each hit says where its line starts.
'use strict';
const H = require('./mobile-harness');
const W = H.world('ssearch', { env: true });
const fs = require('fs');
const { check } = H;
const sessions = require('../mobile/sessions');

(async () => {
  await sessions.refresh();
  const sess = sessions.index().list.find(s => sessions.transcriptPath(s));
  check(!!sess, 'the demo has a session with a transcript');
  const file = sessions.transcriptPath(sess);
  const orig = fs.readFileSync(file, 'utf8');
  const t0 = Date.parse('2026-01-01T00:00:00Z');
  const ts = (i) => new Date(t0 + i * 1000).toISOString();
  const user = (i, text) => JSON.stringify({ type: 'user', timestamp: ts(i), uuid: 'u' + i, message: { role: 'user', content: text } });
  const said = (i, text) => JSON.stringify({ type: 'assistant', timestamp: ts(i), uuid: 'a' + i, message: { role: 'assistant', content: [{ type: 'text', text }] } });
  const tool = (i, cmd) => JSON.stringify({ type: 'assistant', timestamp: ts(i), uuid: 't' + i, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_' + i, name: 'Bash', input: { command: cmd } }] } });
  const rows = [user(0, 'Remember the word Quokkafish, please.'), said(1, 'Noted: quokkafish, and QUOKKAFISH twice.'),
                tool(2, 'grep quokkafish notes.txt')];
  // Push the next hit past the 1 MB read chunk, so a line straddling the chunk edge is exercised.
  for (let i = 3; i < 400; i++) rows.push(said(i, 'padding ' + i + ' ' + 'lorem ipsum '.repeat(250)));
  rows.push(user(400, 'late mention of quokkafish'));
  fs.writeFileSync(file, rows.join('\n') + '\n' + orig);

  const r = await sessions.searchSession(sess, 'quokkafish');
  check(r.ok && r.hits.length === 3, 'three messages match, in his words and the replies (the tool step does not)', r.hits && r.hits.map(h => h.role));
  check(r.occurrences === 4, 'occurrences are counted case-insensitively, per message (1 + 2 + 1)', r.occurrences);
  check(r.hits.map(h => h.ts).join() === [ts(0), ts(1), ts(400)].join(), 'hits come oldest first');
  const buf = fs.readFileSync(file);
  const lineAt = (b) => buf.toString('utf8', b, buf.indexOf(10, b));
  check(r.hits.every(h => { try { return JSON.parse(lineAt(h.byte)).timestamp === h.ts; } catch { return false; } }),
        'every hit byte is the start of its own line, including the one past the 1 MB chunk edge', r.hits.map(h => h.byte));
  check(r.hits[2].byte > 1 << 20, 'the late hit really is past the first chunk', r.hits[2].byte);
  check(/quokkafish/i.test(r.hits[0].snippet) && r.hits[0].snippet.length < 220, 'each hit carries a short snippet');
  check(!(await sessions.searchSession(sess, 'q')).ok, 'a one-letter query is refused');
  check((await sessions.searchSession(sess, 'nothing-like-this-anywhere')).hits.length === 0, 'no match: no hits');

  // g785: a board card's anchor names ONE message by its transcript uuid.
  const rawRows = rows.map(l => JSON.parse(l));
  const byUuid = await sessions.searchSession(sess, '', { uuid: rawRows[400].uuid.length > 8 ? rawRows[400].uuid : 'x' });
  check(byUuid.hits.length === 0, 'control: a non-uuid anchor finds nothing', byUuid.hits.length);
  const U = 'abcdef01-2345-4789-8abc-def012345678';
  const withUuid = fs.readFileSync(file, 'utf8').replace('"uuid":"u400"', '"uuid":"' + U + '"');
  fs.writeFileSync(file, withUuid);
  const hit = await sessions.searchSession(sess, '', { uuid: U });
  check(hit.hits.length === 1 && hit.hits[0].ts === ts(400) && /late mention/.test(hit.hits[0].snippet), 'an anchor uuid finds its message, with its time and text', hit.hits[0]);
  check(JSON.parse(lineAt.call(null, hit.hits[0].byte).length ? fs.readFileSync(file).toString('utf8', hit.hits[0].byte, fs.readFileSync(file).indexOf(10, hit.hits[0].byte)) : '{}').uuid === U,
        'and its byte is that line');
  check(/searchSession\(sess, url\.searchParams\.get\('q'\) \|\| '', \{ uuid: url\.searchParams\.get\('uuid'\) \|\| null \}\)/.test(H.src('mobile/index.js')), 'the endpoint takes ?uuid=');

  const inbox = require('../lib/inbox');
  const made = inbox.add('Card about a blocked emulator', { session: sess.id, anchor: U });
  check(made.ok && inbox.fold().items.get(made.n).anchor === U, 'inbox add --anchor records the message');
  check(!inbox.add('no session', { anchor: U }).ok, 'an anchor without a session is refused');
  check(!inbox.link(made.n, sess.id, { anchor: 'not-a-uuid' }).ok, 'a malformed anchor is refused');
  inbox.link(made.n, 'local_other');
  check(!inbox.fold().items.get(made.n).anchor, 'moving a card to another session drops the old anchor');
  inbox.link(made.n, sess.id, { anchor: U });
  check(inbox.fold().items.get(made.n).anchor === U, 'inbox link <n> <sid> <uuid> sets it');
  check(/anchor: \(r\.anchor && sid === r\.session\) \? r\.anchor : undefined/.test(H.src('lib/board-build.js')), 'the board carries the anchor to the phone');
  const bui = H.src('mobile/public/board-ui.js');
  check(/data-anchor="/.test(bui) && /window\.landAtAnchor\(id, \{ uuid: anchor, text: land, raised \}\)/.test(bui), 'Open session lands on the anchor, else searches the card words');
  const appSrc = H.src('mobile/public/app.js');
  check(/async function landAtHit/.test(appSrc) && /await findLoadUntil\(hit\.byte\)/.test(appSrc), 'landing pages older history in until the message is loaded');

  // 29-Sep: the drawer's search across sessions matched raw JSON (tool calls, ids) and showed ids.
  const g = await sessions.searchTranscripts('quokkafish', { list: [sess] });
  check(g.ok && g.hits.length === 1 && g.hits[0].matches === 4, 'search across sessions counts only what was said (the tool step is not a match)', g.hits[0] && g.hits[0].matches);
  check(/late mention of quokkafish/.test(g.hits[0].snippet) && !/"uuid"|toolu_|\{"type"/.test(g.hits[0].snippet), 'its hint is the text around the match, not JSON or ids', g.hits[0].snippet);
  check(g.hits[0].ts === ts(400) && g.hits[0].role === 'user' && Number.isFinite(g.hits[0].byte), 'and it says which message, so a tap can land there');
  const grepOnly = await sessions.searchTranscripts('notes.txt', { list: [sess] });
  check(grepOnly.hits.length === 0, 'a word that appears only inside a tool call finds nothing');
  const tail = await sessions.searchSession(sess, 'quokkafish', { tailBytes: 4096, roles: ['user', 'assistant'] });
  check(tail.hits.length === 1 && tail.truncated, 'a tail window reads only the newest part (and says it is partial)', tail.hits.length);
  const ui = H.src('mobile/public/app.js');
  check(/function markSnip\(text, q\)/.test(ui) && /markSnip\(s\.snippet, state\.deepQ\)/.test(ui), 'the hint marks the match');
  check(/landAtHit\(\{ byte: s\.byte, ts: s\.ts, snippet: s\.snippet \}, state\.deepQ\)/.test(ui), 'tapping a hit opens the session on that message');

  // g784 follow-up: the header's 👁 gave its place to 🔍; working steps moved to the ⋯ sheet.
  const html = H.src('mobile/public/index.html');
  const header = html.slice(html.indexOf('<header class="bar">'), html.indexOf('</header>'));
  check(/id="btn-find"/.test(header) && !/id="btn-work"/.test(header), 'the header has find, not the working-steps eye');
  check(/<label class="lbl">Working steps<\/label>\s*<div class="seg" id="seg-work"><button id="btn-work"/.test(html), 'working steps are a toggle in the session sheet');

  // g770 follow-up: "Finished" for a turn that ended 21 hours earlier.
  const ix = H.src('mobile/index.js');
  check(/const DONE_FRESH_MS = 10 \* 60 \* 1000;/.test(ix) && /if \(st === 'done'\) \{\s*const f = freshDone\(s\);\s*if \(!f\.ok\)/.test(ix), 'a done alert needs a turn written in the last 10 minutes');
  {
    const vm = require('vm');
    const grabI = (name) => { const i = ix.indexOf('function ' + name + '('); const rest = ix.slice(i); return rest.slice(0, rest.search(/\n\}\n/) + 2); };
    const now = Date.parse('2026-09-28T20:15:46Z');
    const stamps = { old: '1:' + Date.parse('2026-09-27T23:16:10Z'), fresh: '1:' + (now - 60e3) };
    const c = { DONE_FRESH_MS: 600000, doneSeen: {}, sessions: { transcriptStamp: (s) => stamps[s.id] } };
    vm.createContext(c);
    vm.runInContext(grabI('turnEndedAt') + grabI('freshDone') + ';globalThis.F = freshDone;', c);
    check(!c.F({ id: 'old' }, now).ok, 'the 28-Sep case: a session re-marked unread 21 h after its turn is not announced', c.F({ id: 'old' }, now).why);
    check(c.F({ id: 'fresh' }, now).ok, 'control: a turn that ended a minute ago is');
    c.doneSeen.fresh = now - 60e3;
    check(!c.F({ id: 'fresh' }, now).ok, 'and the same turn is never announced twice (persisted)');
  }

  const idx = H.src('mobile/index.js');
  check(/p === '\/api\/session-search'/.test(idx) && /sessions\.searchSession\(sess, url\.searchParams\.get\('q'\)/.test(idx), 'the app reaches it at /api/session-search');
  const readOk = idx.slice(idx.indexOf('const READ_OK'), idx.indexOf('const WRITE_OK'));
  check(!/session-search/.test(readOk), 'a scoped sub-user cannot use it (not in READ_OK)');

  const app = H.src('mobile/public/app.js');
  check(/findRemark\(\);\s*\n\s*renderJump\(\);\s*\n\}/.test(app), 'the marks are re-applied after every render');
  check(/findLoadUntil\(older\[older\.length - 1\]\.byte\)/.test(app), 'going past the oldest loaded match pages history in to the next hit');
  check(/\.findbar\{position:absolute/.test(H.src('mobile/public/style.css')), 'the find bar is an overlay: opening it does not resize the log (g780)');
  check(/id="btn-find"/.test(H.src('mobile/public/index.html')), 'the header has the find button');
  H.finish(W);
})();
