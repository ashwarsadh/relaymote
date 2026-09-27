#!/usr/bin/env node
'use strict';
// check-g369.js --check: evidence that the v2 docs and the difficulty map are really in place.
//   A. README: GitHub Releases download with the Windows .exe and macOS .dmg, and a release workflow
//      that builds and publishes both.
//   B. The LLM-setup doc (INSTALL-FOR-AI.md) exists, has its steps, and README + llms.txt link it.
//   C. README highlights multi-account switching/sync and has the Accounts section.
//   D. README compares Relaymote with Claude's built-in Remote Control.
//   E. Developer Mode + Main Process Debugger setup for Windows and macOS, in README and in the app.
//   F. Settings › Models renders a model + effort per difficulty level, and a saved choice reaches the
//      router (rendered from the real settings-ui.js source, saved through lib/config.js in a temp home).
// Every line printed is file:line plus the text that proves it. Exit 0 only when every check passes.
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const results = [];

function lineOf(text, index) { return text.slice(0, index).split('\n').length; }
// Find rx in file; return "file:line  matched text" or null.
function find(file, rx) {
  const t = read(file), m = rx.exec(t);
  if (!m) return null;
  return `${file}:${lineOf(t, m.index)}  ${m[0].split('\n')[0].trim().slice(0, 110)}`;
}
function check(id, name, fn) {
  let evidence = [], ok = false, why = '';
  try {
    const r = fn();
    evidence = r.filter(Boolean);
    ok = evidence.length === r.length;
    if (!ok) why = `${r.length - evidence.length} of ${r.length} pieces of evidence missing`;
  } catch (e) { why = e.message; }
  results.push({ id, name, ok, evidence, why });
}
// Section text of README between a heading and the next heading of the same or higher level.
function section(file, heading) {
  const t = read(file), i = t.indexOf(heading);
  if (i < 0) throw new Error(`${file}: no heading "${heading}"`);
  const level = heading.match(/^#+/)[0].length;
  const rest = t.slice(i + heading.length);
  const next = rest.search(new RegExp(`\\n#{1,${level}} `));
  return next < 0 ? rest : rest.slice(0, next);
}

check('A', 'README: GitHub Releases with installers (.exe / .dmg)', () => {
  const dl = section('README.md', '## Download');
  if (!/releases\/latest/.test(dl) || !/Relaymote-Setup-<version>\.exe/.test(dl) || !/arm64\.dmg/.test(dl) || !/x64\.dmg/.test(dl))
    throw new Error('README ## Download does not list the release, the .exe and both .dmg files');
  return [
    find('README.md', /^## Download$/m),
    find('README.md', /\| Windows 10\/11 \| `Relaymote-Setup-<version>\.exe`/),
    find('README.md', /\| macOS, Apple silicon \| `Relaymote-<version>-arm64\.dmg`/),
    find('README.md', /\| macOS, Intel \| `Relaymote-<version>-x64\.dmg`/),
    find('README.md', /<a href="https:\/\/github\.com\/ashwarsadh\/relaymote\/releases\/latest"><b>⬇ Download/),
    find('.github/workflows/release.yml', /dist\/Relaymote-Setup-\$v-x64\.exe/),
    find('.github/workflows/release.yml', /bash installer\/macos\/build-dmg\.sh/),
    find('.github/workflows/release.yml', /softprops\/action-gh-release@v2/),
    find('.github/workflows/release.yml', /files: dist\/\*/),
  ];
});

check('B', 'LLM-setup doc (INSTALL-FOR-AI.md), linked from README and llms.txt', () => {
  const doc = read('INSTALL-FOR-AI.md');
  const steps = (doc.match(/^## \d+\. /gm) || []).length;
  if (steps < 8) throw new Error(`INSTALL-FOR-AI.md has ${steps} numbered steps, expected at least 8`);
  return [
    find('INSTALL-FOR-AI.md', /^# Installing Relaymote — instructions for an AI agent/m),
    find('INSTALL-FOR-AI.md', /^## 5\. Connect Claude Desktop \(the Main Process Debugger\)/m),
    find('INSTALL-FOR-AI.md', /^## 7\. Pair the phone/m),
    find('README.md', /^## Let your AI install it$/m),
    find('README.md', /Follow https:\/\/github\.com\/ashwarsadh\/relaymote\/blob\/main\/INSTALL-FOR-AI\.md/),
    find('README.md', /\]\(INSTALL-FOR-AI\.md\)/),
    find('llms.txt', /\[INSTALL-FOR-AI\.md\]\(https:\/\/github\.com\/ashwarsadh\/relaymote\/blob\/main\/INSTALL-FOR-AI\.md\)/),
  ];
});

check('C', 'README: multi-account switching and sync highlighted', () => [
  find('README.md', /^### 2\. One app across all your Claude accounts$/m),
  find('README.md', /\*\*Relaymote keeps them in sync\*\*, so switching accounts shows the same app/),
  find('README.md', /^## Accounts$/m),
  find('README.md', /\*\*Preview sync\*\* shows exactly what would change/),
  find('README.md', /\*\*Sync now\*\* writes it, after backing up/),
  find('README.md', /relaymote accounts \| accounts sync \[--apply\]/),
]);

check('D', 'README: comparison with Claude\'s built-in Remote Control', () => {
  const s = section('README.md', '### 1. It mirrors your desktop');
  const rows = (s.match(/^\| (?!---|\s\|)/gm) || []).length - 1;
  if (rows < 5) throw new Error(`the Remote Control comparison has ${rows} rows, expected at least 5`);
  return [
    find('README.md', /\| \| Claude's built-in Remote Control \| Relaymote \|/),
    find('README.md', /\| Switching it on \| per session, and again after Claude restarts \| once, at install \|/),
    find('README.md', /\| Several accounts \| — \| one identical app across them/),
    find('README.md', /Remote Control is Anthropic's feature and may change/),
  ];
});

check('E', 'Developer Mode + Main Process Debugger setup (Windows + macOS, README and in-app)', () => [
  find('README.md', /^### 2\. Connect Claude Desktop \(Developer Mode \+ Main Process Debugger\)$/m),
  find('README.md', /On Windows the menus are behind the\s+\*\*☰\*\*/),
  find('README.md', /on macOS they are in the menu bar/),
  find('README.md', /\*\*Developer › Enable Main Process Debugger\*\*/),
  find('README.md', /\*\*On Windows Relaymote turns it back on for\s+you\*\*/),
  find('README.md', /On macOS, repeat step 2 after a restart/),
  find('mobile/public/settings-ui.js', /\['desktop', 'Desktop connection'\]/),
  find('mobile/public/settings-ui.js', /var mac = desk && desk\.platform === 'darwin'/),
  find('mobile/index.js', /canAutoEnable: process\.platform === 'win32'/),
  find('scripts/enable-debugger.ps1', /Enable Main Process Debugger/),
]);

// --- F: render the real Models section and push a choice through config into the router ---
// Pull named top-level declarations out of the settings-ui.js IIFE, so the check runs the code the
// app ships rather than a copy of it. Declarations there sit at two spaces of indent: a one-line one
// ends on its own line; a longer one ends at the first line that is back at two spaces.
function extract(src, name) {
  const lines = src.split('\n');
  const at = lines.findIndex(l => l.startsWith(`  function ${name}(`) || l.startsWith(`  var ${name} = `));
  if (at < 0) throw new Error(`settings-ui.js: ${name} not found`);
  let end = at;
  while (end + 1 < lines.length && /^ {4}/.test(lines[end + 1])) end++;
  if (end > at && /^  [}\]]/.test(lines[end + 1] || '')) end++;
  return lines.slice(at, end + 1).join('\n');
}

check('F', 'Settings › Models: difficulty map (model + effort per level) wired to the router', () => {
  const uiFile = 'mobile/public/settings-ui.js';
  const ui = read(uiFile);
  const code = ['LEVELS', 'EFFORTS', 'esc', 'field', 'toggle', 'sel', 'setPath', 'renderModels'].map(n => extract(ui, n)).join('\n');
  const sandbox = {
    S: { levels: { easy: { model: 'claude-sonnet-5', effort: 'medium' } }, newSession: {} },
    modelList: ['claude-opus-5-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
    section: 'models', req: () => Promise.resolve({}), render: () => {},
  };
  vm.createContext(sandbox);
  vm.runInContext(code + '\nthis.out = { html: renderModels(), levels: LEVELS, patch: setPath({}, "levels.hard.model", "claude-sonnet-5") };', sandbox);
  const { html, levels, patch } = sandbox.out;
  const keys = levels.map(l => l[0]);
  const router = require(path.join(root, 'lib', 'router.js'));
  if (JSON.stringify(keys) !== JSON.stringify(router.LEVELS)) throw new Error(`UI levels ${keys} differ from router levels ${router.LEVELS}`);
  const missing = keys.filter(k => !html.includes(`data-field="levels.${k}.model"`) || !html.includes(`data-field="levels.${k}.effort"`));
  if (missing.length) throw new Error('Models section has no model/effort select for: ' + missing.join(', '));
  if (!/data-field="levels\.easy\.model"><option value="claude-opus-5-5">[^]*?<option value="claude-sonnet-5" selected>/.test(html))
    throw new Error('the saved easy model is not shown as selected');
  const rendered = `${uiFile} renderModels() rendered ${keys.length} levels (${keys.join(', ')}), each with a model and an effort select; saved easy → claude-sonnet-5 shows as selected`;

  // Save the choice the way the Settings screen does (setPath patch → POST /api/settings → config.set)
  // in a throwaway RELAYMOTE_HOME, then ask the router in a fresh process which model "hard" uses.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'relaymote-g369-'));
  let routed;
  try {
    const env = { ...process.env, RELAYMOTE_HOME: home };
    const probe = `const c=require(${JSON.stringify(path.join(root, 'lib', 'config.js'))});c.set(${JSON.stringify(patch)});c.set({levels:{hard:{effort:'max'}}});
      const r=require(${JSON.stringify(path.join(root, 'lib', 'router.js'))});process.stdout.write(JSON.stringify({hard:r.rung(2),ladder:r.ladder().map(l=>l.label)}))`;
    routed = JSON.parse(execFileSync(process.execPath, ['-e', probe], { env, encoding: 'utf8', windowsHide: true }));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
  if (routed.hard.model !== 'claude-sonnet-5' || routed.hard.effort !== 'max') throw new Error('router did not pick up the saved level: ' + JSON.stringify(routed.hard));
  const wired = `lib/config.js set() + lib/router.js ladder(): saved levels.hard = claude-sonnet-5/max → router uses "${routed.hard.label}" (ladder: ${routed.ladder.join(' · ')})`;

  return [
    rendered,
    wired,
    find(uiFile, /\['models', 'Models'\]/),
    find(uiFile, /<h3>Workers by difficulty<\/h3>/),
    find('lib/config.js', /^  levels: \{$/m),
    find('mobile/index.js', /const next = config\.set\(body \|\| \{\}\)/),
    find('README.md', /Map difficulty to model and effort in \*\*Settings › Models\*\*/),
  ];
});

const failed = results.filter(r => !r.ok);
const asJson = process.argv.includes('--json');
if (asJson) process.stdout.write(JSON.stringify({ goal: 'g369', ok: !failed.length, results }, null, 2) + '\n');
else {
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.id}  ${r.name}${r.ok ? '' : '  — ' + r.why}`);
    for (const e of r.evidence) console.log('       ' + e);
  }
  console.log(`\ng369 --check: ${results.length - failed.length}/${results.length} passed`);
}
if (!process.argv.includes('--check') && !asJson) console.log('(run with --check to exit non-zero on failure)');
process.exit(failed.length && (process.argv.includes('--check') || asJson) ? 1 : 0);
