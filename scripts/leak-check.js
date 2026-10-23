#!/usr/bin/env node
// leak-check.js — this repo is PUBLIC. Refuse a commit (pre-commit hook) or a push (CI) that carries a real
// email address, a Claude session id, a tailnet address, a Cloudflare id or a secret-shaped string.
// 23-Oct-2026: a STATE note with staff emails, session ids and Access app ids reached the public repo.
//   node scripts/leak-check.js            every tracked file (CI)
//   node scripts/leak-check.js --staged   the staged version of each staged file (pre-commit)
//   node scripts/leak-check.js --history  every line ever added on every ref (after a purge)
// Placeholders pass: @example.com/.org/.net, *.test/*.invalid, GitHub noreply, local_aaaaaaaa-… style ids.
'use strict';
const { execFileSync } = require('child_process');

const SKIP = [/^package-lock\.json$/, /^mobile\/public\/vendor\//, /\.(png|jpe?g|gif|ico|webp|woff2?|ttf|pdf|exe|zip)$/i, /^scripts\/leak-check\.js$/];
const OK_EMAIL = /@(example\.(com|org|net)|[a-z0-9.-]+\.(test|invalid|example)|users\.noreply\.github\.com)$/i;
const fakeId = h => new Set(h).size <= 2 || h === 'deadbeef';

const RULES = [
  { what: 'email address', rx: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, ok: m => OK_EMAIL.test(m) || /^[^@]+@\d/.test(m) || /^noreply@anthropic\.com$/i.test(m) },
  { what: 'Claude session id', rx: /\blocal_([0-9a-f]{8})/g, ok: (m, h) => fakeId(h) },
  { what: 'tailnet address', rx: /\b100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/g },
  { what: 'Cloudflare account/app id', rx: /(?:account|app|zone|aud|tunnel)[_ -]?(?:id|tag)?["'`:= ]+([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi, ok: (m, h) => fakeId(h.slice(0, 8)) },
  { what: 'secret-shaped string', rx: /\b(?:ghp_[A-Za-z0-9]{30,}|gho_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-ant-[A-Za-z0-9_-]{20,}|sk-proj-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|xox[abp]-[A-Za-z0-9-]{20,}|AIza[0-9A-Za-z_-]{35}|eyJ[A-Za-z0-9_-]{30,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})/g },
  { what: 'private key', rx: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g },
];

const git = (...a) => execFileSync('git', a, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 });
const staged = process.argv.includes('--staged');
const history = process.argv.includes('--history');   // every line ever added, on every ref
const files = history ? [] : (staged ? git('diff', '--cached', '--name-only', '--diff-filter=ACMR') : git('ls-files'))
  .split('\n').map(s => s.trim()).filter(f => f && !SKIP.some(r => r.test(f)));

const hits = [];
const scan = (where, line) => {
  for (const r of RULES) {
    for (const m of line.matchAll(r.rx)) {
      if (r.ok && r.ok(m[0], m[1] || '')) continue;
      hits.push(`${where}: ${r.what}: ${m[0].slice(0, 12)}…`);
    }
  }
};
if (history) {
  let commit = '', file = '', n = 0;
  for (const line of git('log', '--all', '-p', '--no-color', '--no-ext-diff', '--format=@@commit %h').split('\n')) {
    if (line.startsWith('@@commit ')) { commit = line.slice(9); continue; }
    if (line.startsWith('+++ ')) { file = line.replace(/^\+\+\+ (b\/)?/, ''); continue; }
    if (line[0] !== '+' || SKIP.some(r => r.test(file))) continue;
    n++; scan(`${commit} ${file}`, line);
  }
  files.length = 0; files.push(...Array(n));
}
for (const f of files) {
  if (f === undefined) break;
  let text;
  try { text = staged ? git('show', ':' + f) : require('fs').readFileSync(f, 'utf8'); } catch { continue; }
  if (text.includes('\u0000')) continue;   // binary
  text.split('\n').forEach((line, i) => scan(`${f}:${i + 1}`, line));
}
if (hits.length) {
  console.error('leak-check: this repo is public; remove these or use a placeholder (example.com, local_aaaaaaaa-…):');
  for (const h of hits) console.error('  ' + h);
  process.exit(1);
}
console.log(history ? `leak-check: history clean (${files.length} added lines on all refs)` : `leak-check: ${files.length} file(s) clean`);
