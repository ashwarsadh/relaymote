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
