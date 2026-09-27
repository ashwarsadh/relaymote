'use strict';
// g369-evidence.js: scripts/check-g369.js --check proves the v2 README sections, the LLM-setup doc and
// the Settings › Models difficulty map. It passes on this tree, and each check is shown FIRING on a
// copy of the tree with that piece of evidence taken out.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const root = path.join(__dirname, '..');
const FILES = ['scripts/check-g369.js', 'README.md', 'INSTALL-FOR-AI.md', 'llms.txt', '.github/workflows/release.yml',
  'mobile/public/settings-ui.js', 'mobile/index.js', 'lib/config.js', 'lib/router.js', 'scripts/enable-debugger.ps1'];
let n = 0;
const ok = (c, name, extra) => { assert.ok(c, name + (extra ? '\n' + extra : '')); n++; console.log('ok ' + name); };

function run(dir, args) {
  const env = { ...process.env };
  delete env.RELAYMOTE_HOME;
  const r = spawnSync(process.execPath, [path.join(dir, 'scripts', 'check-g369.js'), ...args], { encoding: 'utf8', env, windowsHide: true });
  return { code: r.status, out: r.stdout + r.stderr };
}
function copyTree(mutate) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relaymote-g369-tree-'));
  for (const f of FILES) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.copyFileSync(path.join(root, f), path.join(dir, f));
  }
  if (mutate) for (const [f, from, to] of mutate) {
    const p = path.join(dir, f), t = fs.readFileSync(p, 'utf8');
    assert.ok(from.test ? from.test(t) : t.includes(from), `mutation target missing in ${f}: ${from}`);
    fs.writeFileSync(p, t.replace(from, to));
  }
  return dir;
}

const live = run(root, ['--check']);
ok(live.code === 0 && /g369 --check: 6\/6 passed/.test(live.out), 'check-g369 --check passes on this tree', live.out);
ok(/README\.md:\d+ +## Download/.test(live.out) && /release\.yml:\d+ +softprops\/action-gh-release/.test(live.out), 'A cites README and the release workflow by file:line');
ok(/renderModels\(\) rendered 4 levels \(easy, medium, hard, extraHard\)/.test(live.out), 'F renders the real Models section with all four levels');
ok(/router uses "hard: claude-sonnet-5\/max"/.test(live.out), 'F shows a saved level reaching the router');
{
  const j = JSON.parse(run(root, ['--json']).out);
  ok(j.ok && j.results.length === 6 && j.results.every(r => r.ok && r.evidence.length >= 4), '--json reports six passing checks with evidence');
}

const CASES = [
  ['A', 'README.md', /\| macOS, Intel \| `Relaymote-<version>-x64\.dmg`[^\n]*\n/, ''],
  ['B', 'README.md', '](INSTALL-FOR-AI.md)', '](docs/ARCHITECTURE.md)'],
  ['C', 'README.md', '**Relaymote keeps them in sync**', 'Relaymote can help'],
  ['D', 'README.md', "| | Claude's built-in Remote Control | Relaymote |", '| | Other | Relaymote |'],
  ['E', 'mobile/public/settings-ui.js', "var mac = desk && desk.platform === 'darwin'", 'var mac = false'],
  ['F', 'mobile/public/settings-ui.js', "sel('levels.' + L[0] + '.effort', 'Effort', cur.effort || '', eo) + ", ''],
  ['F', 'lib/router.js', "const l = (c.levels && c.levels[level]) || {};", 'const l = {};'],
];
for (const [id, file, from, to] of CASES) {
  const dir = copyTree([[file, from, to]]);
  try {
    const r = run(dir, ['--check']);
    const failedIds = [...r.out.matchAll(/^FAIL (\w)/gm)].map(m => m[1]);
    ok(r.code === 1 && failedIds.join() === id, `${id} fires when ${file} loses its evidence`, r.out);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
console.log(`\n${n}/${n} passed`);
