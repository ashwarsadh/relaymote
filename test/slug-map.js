'use strict';
// 15-Nov: desktop.projectSlugMap lists a project folder again only when its mtime changed. Each Desktop refresh used to
// list all of them (21 loop stalls in 3 days, up to 8.7 s). Checks: same map as a full listing, unchanged folders are
// not listed again, and a transcript added, removed or moved, or a folder removed, shows up at once.
const fs = require('fs'), os = require('os'), path = require('path');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-slug-'));
process.env.CLAUDE_CONFIG_DIR = home;
const root = path.join(home, 'projects');
const desktop = require('../lib/desktop');
let fails = 0;
const check = (ok, what, got) => { console.log((ok ? 'ok   ' : 'FAIL ') + what + (ok || got === undefined ? '' : '  ' + JSON.stringify(got))); if (!ok) fails++; };
const touch = (d, id) => { fs.mkdirSync(path.join(root, d), { recursive: true }); fs.writeFileSync(path.join(root, d, id + '.jsonl'), '{}\n'); };
const full = () => { const m = new Map(); for (const d of fs.readdirSync(root)) for (const f of fs.readdirSync(path.join(root, d))) if (f.endsWith('.jsonl')) m.set(f.slice(0, -6), d); return m; };
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  check(desktop.projectSlugMap().size === 0, 'no projects folder: an empty map');
  for (let d = 0; d < 20; d++) for (let i = 0; i < 30; i++) touch('C--proj' + d, 'sess-' + d + '-' + i);
  fs.mkdirSync(path.join(root, 'C--proj0', 'sess-0-0'), { recursive: true });   // a subagent folder is not a transcript
  let m = desktop.projectSlugMap();
  check(same(m, full()) && m.size === 600, 'same map as a full listing', m.size);
  const listed = desktop.slugStats.listed;
  m = desktop.projectSlugMap();
  check(desktop.slugStats.listed === listed && same(m, full()), 'a second refresh lists no folder again', desktop.slugStats.listed - listed);
  await sleep(30);
  touch('C--proj3', 'brand-new');
  m = desktop.projectSlugMap();
  check(m.get('brand-new') === 'C--proj3' && desktop.slugStats.listed === listed + 1, 'a new transcript shows at once; only its folder is listed', desktop.slugStats.listed - listed);
  await sleep(30);
  fs.renameSync(path.join(root, 'C--proj4', 'sess-4-1.jsonl'), path.join(root, 'C--proj5', 'sess-4-1.jsonl'));
  fs.unlinkSync(path.join(root, 'C--proj6', 'sess-6-2.jsonl'));
  fs.rmSync(path.join(root, 'C--proj7'), { recursive: true });
  touch('C--new-folder', 'in-new-folder');
  m = desktop.projectSlugMap();
  check(m.get('sess-4-1') === 'C--proj5' && !m.has('sess-6-2') && !m.has('sess-7-0') && m.get('in-new-folder') === 'C--new-folder' && same(m, full()),
        'a moved, a removed transcript, a removed folder and a new folder are all seen', m.size);
  // The cwd cache is read once per refresh when the caller passes it.
  const c = desktop.lookupCwd(new Map([['x', { slug: 'C--proj1' }]]), 'x', { x: 'D:\\work' });
  check(c.cwd === 'D:\\work' && c.slug === 'C--proj1', 'lookupCwd takes a cache read once by its caller');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  check((src.match(/lookupCwd\(cwdMap, [^)]*, cwdCache\)/g) || []).length === 2, 'the Desktop refresh passes one cwd-cache read to both lookups');
  fs.rmSync(home, { recursive: true, force: true });
  if (fails) { console.error(fails + ' failed'); process.exit(1); }
  console.log('slug-map: all checks passed');
})();
