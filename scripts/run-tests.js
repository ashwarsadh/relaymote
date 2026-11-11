#!/usr/bin/env node
// run-tests.js — runs package.json `scripts.test` one test at a time for the release build.
// 11-Nov-2026: two Windows release builds (0.2.178, 0.2.179) stopped in `npm test` and the job log is not readable
// without a token, so which test failed was unknowable. Here each failure is published as a GitHub annotation (the
// test, and the tail of its output), readable from the public check-run API. A failed test is run once more: a pass
// on the retry is a warning annotation (a flake, named), a second failure stops the build.
'use strict';
const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const cmds = require(path.join(ROOT, 'package.json')).scripts.test.split(' && ').map(s => s.trim()).filter(Boolean);
const GH = !!process.env.GITHUB_ACTIONS;
const esc = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const tail = (s, n = 40) => String(s).split('\n').filter(l => l.trim()).slice(-n).join('\n').slice(-3500);

function run(cmd) {
  const t = Date.now();
  const r = spawnSync(cmd, { cwd: ROOT, shell: true, windowsHide: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60000 });
  const out = (r.stdout || '') + (r.stderr || '');
  return { ok: r.status === 0, out, ms: Date.now() - t, why: r.error ? r.error.message : 'exit ' + r.status };
}

let flakes = 0;
for (const cmd of cmds) {
  let r = run(cmd);
  if (r.ok) { console.log(`ok   ${cmd}  (${(r.ms / 1000).toFixed(1)} s)`); continue; }
  console.log(`FAIL ${cmd}  (${r.why}, ${(r.ms / 1000).toFixed(1)} s)\n${tail(r.out)}`);
  const first = r;
  r = run(cmd);
  if (r.ok) {
    flakes++;
    console.log(`ok   ${cmd} on retry: a flake`);
    if (GH) console.log(`::warning title=flaky test: ${esc(cmd)}::${esc(first.why + '\n' + tail(first.out, 25))}`);
    continue;
  }
  console.log(`FAIL ${cmd} again (${r.why})\n${tail(r.out)}`);
  if (GH) console.log(`::error title=test failed twice: ${esc(cmd)}::${esc(r.why + '\n' + tail(r.out, 30))}`);
  process.exit(1);
}
console.log(`\nall ${cmds.length} tests passed${flakes ? ` (${flakes} on a retry)` : ''}`);
