'use strict';
// sent-files.js: a file a session SENT (SendUserFile) could not be played or seen in the app: it lived in
// the session's scratchpad, outside every cwd /api/file may read, and the send itself hid inside the
// collapsed "Working" group. Guards: the allowlist is the transcript's own SendUserFile calls, Range is
// answered 206, and the client renders a player card through the authenticated route.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const sf = require(path.join(__dirname, '..', 'mobile', 'sentfiles.js'));
const root = path.join(__dirname, '..', 'mobile');
const idx = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'latin1');
let n = 0;
const ok = (c, name) => { assert.ok(c, name); n++; console.log('ok ' + name); };

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-sentfiles-'));
  try {
    const wav = path.join(dir, 'a.wav');
    fs.writeFileSync(wav, Buffer.alloc(5000, 7));
    const tr = path.join(dir, 't.jsonl');
    const row = (files) => JSON.stringify({ cwd: dir, message: { content: [{ type: 'tool_use', name: 'SendUserFile', input: { files, caption: 'x' } }] } }) + '\n';
    fs.writeFileSync(tr, row([wav.replace(/\\/g, '/')]) + '{"message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"C:/secret.txt"}}]}}\n');
    let s = await sf.sentFiles(tr);
    ok(s.has(sf.norm(wav)), 'a path SendUserFile named is allowed (slash style and case normalised)');
    ok(!s.has(sf.norm('C:/secret.txt')), 'a path any other tool touched is not');
    fs.appendFileSync(tr, row(['rel.png']) + '{"half":');
    s = await sf.sentFiles(tr);
    ok(s.has(sf.norm(path.join(dir, 'rel.png'))), 'appended sends are picked up; a relative path resolves against the row cwd');
    ok(s.size === 2, 'a half-written last line is left for the next read');

    const srv = http.createServer((req, res) => sf.stream(req, res, wav, 5000));
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const get = (range) => new Promise((r, j) => http.get({ port: srv.address().port, host: '127.0.0.1', headers: range ? { Range: range } : {} },
      (res) => { let len = 0; res.on('data', d => len += d.length); res.on('end', () => r({ code: res.statusCode, h: res.headers, len })); }).on('error', j));
    let r = await get();
    ok(r.code === 200 && r.len === 5000 && r.h['accept-ranges'] === 'bytes' && r.h['content-type'] === 'audio/wav', 'a plain GET streams the whole file as audio/wav');
    r = await get('bytes=100-199');
    ok(r.code === 206 && r.len === 100 && r.h['content-range'] === 'bytes 100-199/5000', 'a Range is answered 206 with exactly those bytes');
    r = await get('bytes=4000-');
    ok(r.code === 206 && r.len === 1000, 'an open-ended Range runs to the end');
    r = await get('bytes=-10');
    ok(r.code === 206 && r.len === 10 && r.h['content-range'] === 'bytes 4990-4999/5000', 'a suffix Range gives the last N bytes');
    r = await get('bytes=9000-');
    ok(r.code === 416, 'a Range past the end is 416');
    srv.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }

  ok(sf.typeOf('x.MP3') === 'audio/mpeg' && sf.typeOf('x.ogg') === 'audio/ogg' && sf.typeOf('x.pdf') === 'application/pdf', 'mp3 / ogg / pdf get their media types');
  const sfSrc = fs.readFileSync(path.join(root, 'sentfiles.js'), 'utf8');
  ok(/sandbox allow-scripts/.test(sfSrc), 'a sent HTML page runs sandboxed, so it cannot act as the user');
  ok(/p === '\/api\/sent-file'/.test(idx) && /READ_OK = [^;]*'\/api\/sent-file'/.test(idx), 'the route exists and is readable by a scoped sub-user');
  ok(/identity\.sessions\.has\(sid\)[\s\S]{0,400}NOT_GRANTED[\s\S]{0,900}sentFiles\(tr\)/.test(idx.slice(idx.indexOf("p === '/api/sent-file'"))), 'a sub-user needs the session granted before anything is read');
  ok(/NOT_SENT/.test(idx), 'a path the session did not send is refused');
  ok(/function sentFileHtml\(t\)/.test(app) && /<audio controls preload="metadata"/.test(app) && /\/api\/sent-file\?session=/.test(app), 'the client renders a player through the authenticated route');
  ok(/const sent = \(m\.tools \|\| \[\]\)\.filter\(t => t\.files && t\.files\.length\);/.test(app), 'the card is its own block, not a step inside the working group');
  // A sent .md or other text file opens in the file viewer; a .md one is formatted.
  ok(/data-sent=/.test(app) && /openFile\(sentA\.dataset\.p, sentA\.dataset\.sent\)/.test(app), 'a sent text file opens in the file viewer, not a raw tab');
  ok(/md\(d\.text, true\)/.test(app) && /if \(doc\) h = h\.replace\(\/\^\(#\{1,6\}\)/.test(app) && /if \(!doc\) h = h\.replace\(\/\^#\{1,6\}/.test(app), 'the viewer renders .md with real headings (doc mode); chat keeps bold');
  {
    // Doc headings swallow their newline, so they must come AFTER the bullet and table passes, which
    // anchor on line start; before them, a list right under a heading kept its raw "- ".
    const m = app.slice(app.indexOf('function md(src, doc)'), app.indexOf('\n}\n', app.indexOf('function md(src, doc)')));
    ok(m.indexOf('if (doc) h = h.replace(/^(#{1,6})') > m.indexOf("h = h.replace(/^\\s*[-*]\\s+/gm, '• ')") && m.indexOf('if (doc) h = h.replace(/^(#{1,6})') > m.indexOf('h = renderTables(h)'),
      'doc headings are rendered after the bullet and table passes');
  }
  ok(/doc \? \/\\\*\\\*\(\(\?:\[\^\*\\n\]\|\\r\?\\n\(\?!\\r\?\\n\)\)\+\?\)\\\*\\\*\/g/.test(app), 'hard-wrapped bold in a document renders across one line break');
  const cssSrc = fs.readFileSync(path.join(root, 'public', 'style.css'), 'utf8');
  ok(/\.filebody \.mdbody \.mdh\{[^}]*white-space:normal/.test(cssSrc), 'a long heading wraps instead of the sheet-title ellipsis');
  ok(sf.typeOf('notes.markdown') === 'text/plain; charset=utf-8', '.markdown is served as text');
  // g1695: the same name sent again with new content showed the old picture on the phone.
  ok(/'&path=' \+ encodeURIComponent\(f\) \+ \(t\.id \? '&v=' \+ encodeURIComponent\(t\.id\) : ''\)/.test(app), 'each send has its own URL (its tool id), so a re-sent name never reuses the old image or its size');
  ok(/'Cache-Control': 'private, no-cache'/.test(sfSrc) && /ETag: etag/.test(sfSrc) && /sentfiles\.stream\(req, res, file, st\.size, st\.mtimeMs\)/.test(idx), 'a sent file is revalidated by size+mtime, so a rewritten file is fetched fresh');
  {
    const img = path.join(os.tmpdir(), 'rm-etag-' + process.pid + '.png'); fs.writeFileSync(img, 'aaaa');
    const srv = http.createServer((req, res) => { const st = fs.statSync(img); sf.stream(req, res, img, st.size, st.mtimeMs); });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const get = (h) => new Promise(r => http.get({ port: srv.address().port, path: '/', headers: h || {} }, x => { let d = ''; x.on('data', c => d += c).on('end', () => r({ s: x.statusCode, e: x.headers.etag, d })); }));
    const a = await get(); const a2 = await get({ 'if-none-match': a.e });
    fs.writeFileSync(img, 'bbbbbbbb'); fs.utimesSync(img, new Date(), new Date(Date.now() + 5000));
    const b = await get({ 'if-none-match': a.e });
    srv.close(); fs.unlinkSync(img);
    ok(a.s === 200 && a2.s === 304 && b.s === 200 && b.d === 'bbbbbbbb' && b.e !== a.e, 'unchanged file answers 304; the rewritten file answers 200 with the new bytes', [a.s, a2.s, b.s, b.d]);
  }
  console.log(`\n${n}/${n} passed`);
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
