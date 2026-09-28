// mobile-file-siblings.js — a relative path a session mentions may belong to ANOTHER project than the
// session's own folder ("docs/marketing/reddit-post.md" said by a session whose cwd is a different
// repo). The owner's file viewer finds it in a sibling project folder, only when exactly one matches;
// a sub-user never gets the wider search.
'use strict';
const H = require('./mobile-harness');
const W = H.world('filesib', { demo: false });
const fs = require('fs');
const path = require('path');
const { check } = H;
const { readFile } = require('../mobile/files');

const dev = path.join(W.dir, 'dev');
const own = path.join(dev, 'analyzer');        // the session's folder
const other = path.join(dev, 'relay');         // the repo it worked in (not a session folder)
const third = path.join(dev, 'third');
for (const d of [own, path.join(other, 'docs', 'm'), third]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(other, 'docs', 'm', 'post.md'), '# Post');
const roots = [own];

let r = readFile('docs/m/post.md', { roots, cwd: own });
check(!r.ok && r.error === 'NOT_FOUND', 'without the fallback: NOT_FOUND (the reported bug)', r.error);
r = readFile('docs/m/post.md', { roots, cwd: own, siblings: true });
check(r.ok && r.kind === 'text' && /# Post/.test(r.text) && r.path.includes('relay'), 'the owner finds it in the sibling project', r.path);
r = readFile('docs/m/post.md:3', { roots, cwd: own, siblings: true });
check(r.ok && r.line === 3, 'a :line suffix still works through the fallback');
fs.mkdirSync(path.join(third, 'docs', 'm'), { recursive: true });
fs.writeFileSync(path.join(third, 'docs', 'm', 'post.md'), '# Other');
r = readFile('docs/m/post.md', { roots, cwd: own, siblings: true });
check(!r.ok && r.error === 'AMBIGUOUS' && r.candidates.length === 2, 'two projects with that path: refused as AMBIGUOUS, never a guess', r.error);
fs.writeFileSync(path.join(own, 'docs.md'), 'mine');
r = readFile('docs.md', { roots, cwd: own, siblings: true });
check(r.ok && r.text === 'mine', "the session's own folder still wins");
r = readFile('docs/m/post.md', { roots, cwd: own, siblings: false });
check(!r.ok, 'a sub-user (siblings off) gets no wider search');
// A root reached through a link (macOS /var -> /private/var, Windows RUNNER~1): a path not yet
// written must still be in scope, or every such lookup reads OUT_OF_SCOPE (v0.2.29 CI, mac + win).
const link = path.join(W.dir, 'linked');
fs.symlinkSync(own, link, 'junction');
r = readFile('not/yet.md', { roots: [link], cwd: link });
check(!r.ok && r.error === 'NOT_FOUND', 'an unwritten path under a linked root is NOT_FOUND, not OUT_OF_SCOPE', r.error);
check(/siblings: !isSubuser\(identity\)/.test(H.src('mobile/index.js')), '/api/file enables it for the owner only');
H.finish(W);
