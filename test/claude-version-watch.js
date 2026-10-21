// claude-version-watch.js — 21-Oct-2026. Claude Desktop 2.42304.2 -> 3.1623.0 put screen-reader-only status text
// inside each sidebar row's button, and 404 of 473 titles read "Sagar Conductor Awaiting input". A version change
// now runs a live check and alerts him once. Here: stubbed Desktop, temp state, temp install folders.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cvw-'));
process.env.RELAYMOTE_STATE_DIR = path.join(tmp, 'state');
const W = require('../lib/claude-version-watch');
let failed = 0;
const check = (ok, name, extra) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra !== undefined ? '  ' + JSON.stringify(extra) : ''}`); if (!ok) failed++; };

const desk = path.join(tmp, 'AnthropicClaude'), code = path.join(tmp, 'claude-code'), proj = path.join(tmp, 'projects', 'p');
for (const d of [path.join(desk, 'app-2.42304.2'), path.join(code, '2.1.299'), proj]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(proj, 's.jsonl'), [{ type: 'user', version: '2.1.304' }, { type: 'api-request' }, { type: 'brand-new-kind' }]
  .map(x => JSON.stringify(x)).join('\n') + '\n');
const rowsClean = Array.from({ length: 30 }, (_, i) => ({ id: 'local_' + i, title: 'Session ' + i, status: i < 3 ? 'Awaiting input' : '' }));
const rowsPolluted = rowsClean.map(r => ({ ...r, title: r.title + (r.status ? ' Awaiting input' : ' Started from a suggestion in X') }));
let scrapeRows = rowsClean, cdpUp = true;
const alerts = [];
const deps = { dirs: { desktop: desk, code }, projectsDir: path.join(tmp, 'projects'), cdp: async () => cdpUp,
  scrape: async () => ({ sessions: scrapeRows }), alert: async (e) => { alerts.push(e); return { push: { sent: 1 } }; } };

(async () => {
  check(JSON.stringify(W.versions(deps.dirs)) === JSON.stringify({ desktop: '2.42304.2', code: '2.1.299' }), 'reads the installed versions', W.versions(deps.dirs));
  let r = await W.tick(deps);
  check(r && r.first && !alerts.length, 'first sight only records, no alert');
  check((await W.tick(deps)) === null, 'same versions: nothing runs');

  fs.mkdirSync(path.join(desk, 'app-3.1623.0')); fs.mkdirSync(path.join(code, '2.1.304'));
  scrapeRows = rowsPolluted;
  r = await W.tick(deps);
  check(r && r.changed && !r.ok, 'Desktop 3.x + polluted titles -> a problem', r && r.problems);
  check(alerts.length === 1 && /Desktop 2\.42304\.2 → 3\.1623\.0/.test(alerts[0].title) && /Claude Code 2\.1\.299 → 2\.1\.304/.test(alerts[0].title), 'one alert names both changes', alerts[0] && alerts[0].title);
  check(/30 of 30 session titles carry status text/.test(alerts[0].body) && /A lane must update Relaymote/.test(alerts[0].body), 'the alert says what broke', alerts[0] && alerts[0].body.slice(0, 120));
  check(/brand-new-kind×1/.test(JSON.stringify(r.notes)) && !/api-request/.test(JSON.stringify(r.notes)), 'an unknown transcript type is noted; known new ones are not', r.notes);
  check((await W.tick(deps)) === null && alerts.length === 1, 'alerts once per change, not every tick');

  fs.mkdirSync(path.join(desk, 'app-3.1700.0'));
  scrapeRows = rowsClean; cdpUp = false;
  r = await W.tick(deps);
  check(r && r.waiting && alerts.length === 1, 'Desktop still restarting: waits instead of alerting');
  cdpUp = true;
  r = await W.tick(deps);
  check(r && r.changed && r.ok && alerts.length === 2 && /everything it reads from Claude works/.test(alerts[1].body), 'once it is up and clean: one OK alert', alerts[1] && alerts[1].body.slice(0, 90));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failed ? `\n${failed} check(s) failed` : '\nall claude-version-watch checks passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
