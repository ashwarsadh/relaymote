// make-demo.js <dir> — write a fake Claude Desktop data set (sessions + transcripts) for demos,
// screenshots and UI work without touching real data. Run Relaymote against it with:
//   APPDATA=<dir>/appdata CLAUDE_CONFIG_DIR=<dir>/claude BATON_HOME=<dir>/baton node server.js
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const dir = path.resolve(process.argv[2] || 'demo');
const store = path.join(dir, 'appdata', 'Claude', 'claude-code-sessions', '00000000-demo-acct', '00000000-demo-org');
const projects = path.join(dir, 'claude', 'projects');
fs.mkdirSync(store, { recursive: true });
fs.mkdirSync(projects, { recursive: true });

const now = Date.now();
const root = process.platform === 'win32' ? 'C:\\Users\\you\\projects\\' : '/home/you/projects/';
const S = [
  ['Refactor auth middleware to async/await', 'web-app', 'claude-opus-5-5', 'medium', 2, true],
  ['Fix flaky checkout e2e test', 'web-app', 'claude-opus-5-5', 'high', 9],
  ['Write API reference for v2 endpoints', 'docs', 'claude-opus-5-5', 'low', 35],
  ['Migrate database to Postgres 17', 'backend', 'claude-opus-5-5', 'high', 70],
  ['Landing page redesign — hero + pricing', 'marketing-site', 'claude-sonnet-5', 'medium', 180],
  ['Nightly dependency audit', 'backend', 'claude-opus-5-5', 'low', 600],
  ['Add dark mode to the mobile app', 'mobile-app', 'claude-opus-5-5', 'medium', 1400],
];
const ev = (type, content, ts) => JSON.stringify({ type, timestamp: new Date(ts).toISOString(), uuid: crypto.randomUUID(),
  message: type === 'user' ? { role: 'user', content } : { role: 'assistant', content } });

const ids = {};
S.forEach(([title, proj, model, effort, minsAgo, rich], i) => {
  const id = 'local_' + crypto.randomUUID();
  ids[title] = id;
  const cli = crypto.randomUUID();
  const cwd = root + proj;
  const t = now - minsAgo * 60000;
  fs.writeFileSync(path.join(store, id + '.json'), JSON.stringify({
    sessionId: id, cliSessionId: cli, title, cwd, model, effort, isArchived: false,
    permissionMode: 'acceptEdits', createdAt: t - 3600000, lastActivityAt: t, completedTurns: 3 + i,
  }, null, 2));
  const slug = cwd.replace(/[^A-Za-z0-9]/g, '-');
  fs.mkdirSync(path.join(projects, slug), { recursive: true });
  const lines = [
    ev('user', title + '. Keep the public API unchanged and add tests.', t - 600000),
    ev('assistant', [{ type: 'text', text: 'On it. I will map the current call sites first, then change the implementation behind the same interface.' }], t - 590000),
  ];
  if (rich) {
    lines.push(ev('assistant', [{ type: 'tool_use', id: 'tu1', name: 'Grep', input: { pattern: 'function authenticate', path: 'src' } }], t - 580000));
    lines.push(ev('user', [{ type: 'tool_result', tool_use_id: 'tu1', content: 'src/middleware/auth.js:12\nsrc/routes/admin.js:40' }], t - 575000));
    lines.push(ev('assistant', [{ type: 'text', text: 'Two call sites. I converted `authenticate()` to `async` and replaced the callback chain:\n\n```js\nexport async function authenticate(req) {\n  const token = await readToken(req);\n  return verify(token);\n}\n```\n\nAll **42 tests pass**. Shall I also update the admin routes to use the new helper?' }], t - 120000));
  }
  if (title.startsWith('Migrate database')) {
    lines.push(ev('assistant', [{ type: 'tool_use', id: 'ask1', name: 'AskUserQuestion', input: { questions: [{
      question: 'The migration needs about 10 minutes of downtime. Run it tonight at 23:00, or wait for the weekend?',
      header: 'Downtime', options: [{ label: 'Tonight' }, { label: 'Weekend' }] }] } }], t - 60000));
  }
  fs.writeFileSync(path.join(projects, slug, cli + '.jsonl'), lines.join('\n') + '\n');
});

// Goals, a note for the user, and the Board built from them (Board, Goal chaser and Cache keeper on;
// goals.dryRun so a demo daemon never sends anything to a real session).
const baton = path.join(dir, 'baton');
const goalsDir = path.join(baton, 'goals');
fs.mkdirSync(goalsDir, { recursive: true });
const ago = (h) => new Date(now - h * 3600000).toISOString();
let settings = {};
try { settings = JSON.parse(fs.readFileSync(path.join(baton, 'settings.json'), 'utf8')); } catch {}
settings.modules = { ...(settings.modules || {}), board: true, goalChaser: true, cacheKeeper: true };
settings.goals = { ...(settings.goals || {}), dryRun: true };
fs.writeFileSync(path.join(baton, 'settings.json'), JSON.stringify(settings, null, 2));
const goal = (n, o) => ({ id: 'g' + n, text: '', checks: [], project: null, ownerSessionId: null, status: 'open', due: null,
  verifyBy: null, verifyWhat: null, lastProgressAt: null, progress: null, blockedOn: null, deliveredAt: null, lastChaseAt: null,
  chases: 0, unanswered: 0, told: true, source: 'demo', routing: { state: 'routed', why: 'demo' }, ...o });
const demoGoals = [
  goal(1, { title: 'Auth middleware on async/await with tests green', project: 'web-app', ownerSessionId: ids['Refactor auth middleware to async/await'],
    createdAt: ago(6), toldAt: ago(6), lastProgressAt: ago(1), progress: 'Two call sites converted; admin routes left' }),
  goal(2, { title: 'Checkout e2e test passes 20 runs in a row', project: 'web-app', ownerSessionId: ids['Fix flaky checkout e2e test'],
    createdAt: ago(50), toldAt: ago(50), lastProgressAt: ago(30), due: ago(20), lastChaseAt: ago(8), chases: 1, unanswered: 1 }),
  goal(3, { title: 'Dark mode ships behind a settings toggle', project: 'mobile-app', ownerSessionId: ids['Add dark mode to the mobile app'],
    createdAt: ago(40), toldAt: ago(40), lastProgressAt: ago(26), blockedOn: 'needs the brand colour palette for dark surfaces' }),
  goal(4, { title: 'Publish the v2 changelog', project: 'docs', told: false, routing: { state: 'unrouted', why: 'nothing in the index matched this topic at all' },
    createdAt: ago(3) }),
  goal(5, { title: 'API reference covers every v2 endpoint', project: 'docs', ownerSessionId: ids['Write API reference for v2 endpoints'],
    createdAt: ago(30), toldAt: ago(30), lastProgressAt: ago(2), status: 'done', closedAt: ago(2), outcome: '42 endpoints documented; link check passes' }),
];
fs.writeFileSync(path.join(goalsDir, 'goals.json'), JSON.stringify({ version: 1, next: 6, goals: demoGoals }, null, 1));
fs.writeFileSync(path.join(goalsDir, 'notes.jsonl'), JSON.stringify({ n: 1, text: 'The staging TLS certificate expires on Friday; renewing it needs your DNS login.',
  session: ids['Nightly dependency audit'], kind: 'do', ts: ago(1), status: 'open' }) + '\n');
fs.writeFileSync(path.join(goalsDir, 'chase.jsonl'), [
  { at: ago(8), kind: 'stuck', to: ids['Fix flaky checkout e2e test'], goals: ['g2'], warm: false, ok: true },
  { at: ago(5.5), kind: 'warm', to: ids['Refactor auth middleware to async/await'], goals: ['g1'], warm: true, apiAgeMin: 31, ok: true },
].map(r => JSON.stringify(r)).join('\n') + '\n');

process.env.APPDATA = path.join(dir, 'appdata');
process.env.CLAUDE_CONFIG_DIR = path.join(dir, 'claude');
process.env.BATON_HOME = baton;
delete process.env.BATON_STATE_DIR;
require('../lib/board-build').build({ now })
  .then(r => console.log('demo data written to ' + dir + (r.written ? ' (board.json built)' : '')))
  .catch(e => { console.log('demo data written to ' + dir + ' (board build failed: ' + e.message + ')'); });
