// organizer.js — build the project index from a fake data set and run the organizer against a stub
// setGroup. Never talks to Claude Desktop.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-organizer-'));
execFileSync(process.execPath, [path.join(__dirname, 'make-demo.js'), TMP]);
process.env.APPDATA = path.join(TMP, 'appdata');
process.env.CLAUDE_CONFIG_DIR = path.join(TMP, 'claude');
process.env.RELAYMOTE_HOME = path.join(TMP, 'relaymote');
delete process.env.RELAYMOTE_STATE_DIR;

let failed = 0;
const check = (ok, name, extra) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };

const store = path.join(TMP, 'appdata', 'Claude', 'claude-code-sessions', '00000000-demo-acct', '00000000-demo-org');
const byTitle = {};
for (const f of fs.readdirSync(store)) { const d = JSON.parse(fs.readFileSync(path.join(store, f), 'utf8')); byTitle[d.title] = d; }
const now = Date.now();
let n = 0;
function add(title, cwd, extra = {}) {
  const id = 'local_' + String(++n).padStart(8, '0') + '-0000-4000-8000-000000000000';
  const d = { sessionId: id, title, cwd, model: 'claude-opus-5-5', isArchived: false, createdAt: now - (60 + n) * 60000, lastActivityAt: now - n * 60000, ...extra };
  fs.writeFileSync(path.join(store, id + '.json'), JSON.stringify(d));
  byTitle[title] = d;
  return id;
}
const repo = path.join(TMP, 'repos', 'alpha');
fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
fs.mkdirSync(path.join(repo, 'src', 'lib'), { recursive: true });
add('Alpha root work', repo);
add('Alpha nested work', path.join(repo, 'src', 'lib'));
add('Work api', path.join(TMP, 'work', 'api'));
add('Home api', path.join(TMP, 'home', 'api'));
add('Old docs draft', byTitle['Write API reference for v2 endpoints'].cwd, { isArchived: true });
add('No folder chat', null);
add('Just started', byTitle['Fix flaky checkout e2e test'].cwd, { createdAt: now - 10000, lastActivityAt: now });

const id = t => byTitle[t].sessionId;
const webCwd = byTitle['Fix flaky checkout e2e test'].cwd;
fs.mkdirSync(path.join(TMP, 'appdata', 'Claude'), { recursive: true });
fs.writeFileSync(path.join(TMP, 'appdata', 'Claude', 'claude_desktop_config.json'), JSON.stringify({ preferences: { epitaxyPrefs: { 'dframe-group-scopes': {
  scope: { groups: [{ id: 'g1', name: 'Web' }, { id: 'g2', name: 'Docs team' }],
    assignments: { ['code:' + id('Refactor auth middleware to async/await')]: 'g1', ['code:' + id('Write API reference for v2 endpoints')]: 'g2' } },
} } } }));

const config = require('../lib/config');
fs.mkdirSync(config.STATE, { recursive: true });
fs.writeFileSync(path.join(config.STATE, 'masters.json'), JSON.stringify({
  [webCwd.toLowerCase()]: { sessionId: id('Fix flaky checkout e2e test'), claimedAt: new Date().toISOString(), expiresAt: new Date(now + 3600000).toISOString(), fleet: [] },
}));
config.set({ conductorSession: id('Landing page redesign — hero + pricing'), organizer: { rename: { backend: 'Server' } } });

const projects = require('../lib/projects');
const organizer = require('../lib/organizer');
const owner = require('../lib/owner');

(async () => {
  const ix = await projects.build();
  const names = Object.keys(ix.projects).sort();
  check(ix.counts.projects === 8, 'eight projects found', names.join(', '));
  check(ix.counts.sessions === 14, 'every session indexed', String(ix.counts.sessions));
  const alpha = ix.projects.alpha;
  check(alpha && alpha.sessions.length === 2 && alpha.path === repo, 'sub-folders of one git repo are one project');
  const apis = names.filter(x => /^api\b/.test(x));
  check(apis.length === 2 && apis[0] !== apis[1], 'same-named folders get distinct project names', apis.join(' | '));
  const web = ix.projects['web-app'];
  check(web && web.master && web.master.sessionId === id('Fix flaky checkout e2e test'), 'master claim attached to its project');
  check(web && web.group === 'Web' && web.counts.ungrouped === 2, 'project group and ungrouped count read from Desktop config');
  check(ix.sessions[id('No folder chat')].project === null, 'a session without a folder has no project');
  check(ix.sessions[id('Landing page redesign — hero + pricing')].conductor === true && ix.conductor, 'conductor flagged from settings');
  check(fs.existsSync(projects.INDEX_JSON) && fs.existsSync(projects.INDEX_MD), 'index.json and INDEX.md written');
  check(/## alpha/.test(fs.readFileSync(projects.INDEX_MD, 'utf8')), 'INDEX.md lists projects');
  const ro = owner.readIndex();
  check(ro && Object.keys(ro.sessions).length === 14, 'owner.js reads the index by default (no ownerIndex setting)');
  const r = owner.resolve('fix the flaky checkout test in web-app');
  check(r.ok && r.owner === id('Fix flaky checkout e2e test'), 'relaymote_route_owner resolves against it', r.ok ? r.title : JSON.stringify(r).slice(0, 120));
  check(require('../lib/master-protocol').conductorId() === ix.conductor, 'conductorId() reads settings first');

  const calls = [];
  const stub = failIds => async (sid, group) => { calls.push({ sid, group }); return failIds.includes(sid) ? { ok: false, error: 'NO_SUCH_SESSION' } : { ok: true, sessionId: sid }; };

  let t = await organizer.tick({ index: ix, setGroup: stub([]), isIdle: () => false });
  check(t.moved.length === 0 && calls.length === 0 && t.skipped === 'user active', 'nothing moves while the user is active');

  t = await organizer.tick({ index: ix, setGroup: stub([]), isIdle: () => true, limit: 3 });
  check(t.considered === 9, 'nine ungrouped, settled, live sessions are candidates', String(t.considered));
  check(calls.length === 3 && t.moved.length === 3, 'batch limit holds', String(calls.length));

  t = await organizer.tick({ index: ix, setGroup: stub([id('Alpha nested work')]), isIdle: () => true });
  check(calls.length === 9 && t.moved.length === 5 && t.failed.length === 1, 'second pass moves the rest, records the failure', `${t.moved.length} moved, ${t.failed.length} failed`);
  t = await organizer.tick({ index: ix, setGroup: stub([]), isIdle: () => true });
  check(t.considered === 0 && calls.length === 9, 'no repeats, failed move waits out its retry window');

  const moved = new Set(calls.map(c => c.sid));
  const never = ['Refactor auth middleware to async/await', 'Write API reference for v2 endpoints', 'Old docs draft', 'No folder chat', 'Just started'].map(id);
  check(never.every(x => !moved.has(x)), 'grouped, archived, folderless and brand-new sessions untouched');
  check(moved.size === 9, 'each candidate moved once');
  const to = sid => (calls.find(c => c.sid === sid) || {}).group;
  check(to(id('Fix flaky checkout e2e test')) === 'Web', "joins the group its project already uses");
  check(to(id('Migrate database to Postgres 17')) === 'Server' && to(id('Nightly dependency audit')) === 'Server', 'rename map applies');
  check(to(id('Alpha root work')) === 'alpha' && to(id('Add dark mode to the mobile app')) === 'mobile-app', 'otherwise the group is the project name');
  const log = fs.readFileSync(organizer.LOG(), 'utf8').trim().split('\n');
  check(log.length === 9 && log.filter(l => / FAILED /.test(l)).length === 1, 'every assignment logged', log.length + ' lines');

  // 03-Nov-2026: a session the sidebar does not have is final (each lookup cost ~30 s, retried 3x), and a pass
  // yields the UI lane after its time budget instead of holding it for the 300 s cap.
  const stFile = path.join(config.STATE, 'organizer-state.json');
  const st = JSON.parse(fs.readFileSync(stFile, 'utf8'));
  check((st.attempts[id('Alpha nested work')] || {}).fails === 3, 'NO_SUCH_SESSION is not retried', JSON.stringify(st.attempts[id('Alpha nested work')]));
  fs.unlinkSync(stFile);
  const slow = async (sid) => { calls.push({ sid }); await new Promise(r => setTimeout(r, 60)); return { ok: true }; };
  const before = calls.length;
  t = await organizer.tick({ index: ix, setGroup: slow, isIdle: () => true, budgetMs: 100 });
  check(t.skipped === 'time budget' && calls.length - before === 2, 'a pass stops at its time budget', `${calls.length - before} moves, skipped=${t.skipped}`);
  check(Object.keys(JSON.parse(fs.readFileSync(stFile, 'utf8')).attempts).length === 2, 'moves are saved as they happen');

  // 12-Nov-2026: the sidebar's menus stopped matching (VIEW_SWITCH_FAILED x172, NO_MOVE_TO_GROUP x37 in 23 h, no real
  // move), and every new session was still tried 3 times, each try flipping his sidebar view. Such an error is the
  // sidebar's, not the session's: one try, then the organizer pauses; nobody is charged.
  fs.writeFileSync(stFile, '{}');
  let sys = 0;
  const broken = async (sid) => { sys++; calls.push({ sid }); return { ok: false, error: 'VIEW_SWITCH_FAILED' }; };
  t = await organizer.tick({ index: ix, setGroup: broken, isIdle: () => true });
  let st2 = JSON.parse(fs.readFileSync(stFile, 'utf8'));
  check(sys === 1 && t.failed.length === 1 && t.failed[0].systemic && /^paused until/.test(t.skipped), 'a sidebar-wide error (VIEW_SWITCH_FAILED): one try, then the pass stops paused', JSON.stringify(t));
  check(Object.keys(st2.attempts || {}).length === 0 && st2.pauseReason === 'VIEW_SWITCH_FAILED' && Date.parse(st2.pausedUntil) - Date.now() > 5 * 3600000, 'no session is charged for it; paused ~6 h with the reason saved', JSON.stringify(st2));
  t = await organizer.tick({ index: ix, setGroup: broken, isIdle: () => true });
  check(sys === 1 && t.paused && t.failed.length === 0, 'while paused: no UI attempt at all, nothing logged as a failure', JSON.stringify(t));
  st2.pausedUntil = new Date(Date.now() - 1000).toISOString(); fs.writeFileSync(stFile, JSON.stringify(st2));
  t = await organizer.tick({ index: ix, setGroup: stub([]), isIdle: () => true });
  check(!t.paused && t.moved.length > 0, 'after the pause it tries again, and moves when the sidebar works', JSON.stringify({ moved: t.moved.length, skipped: t.skipped }));
  fs.writeFileSync(stFile, '{}');
  const noMove = async () => ({ ok: false, error: 'NO_MOVE_TO_GROUP' });
  t = await organizer.tick({ index: ix, setGroup: noMove, isIdle: () => true });
  check(t.failed.length === 1 && t.failed[0].systemic, 'NO_MOVE_TO_GROUP (the row menu has no Move item) pauses too', JSON.stringify(t.failed));
  fs.writeFileSync(stFile, '{}');
  t = await organizer.tick({ index: ix, setGroup: stub([id('Alpha nested work')]), isIdle: () => true });
  check(!t.paused && !/paused/.test(t.skipped || '') && t.failed.some(f => f.error === 'NO_SUCH_SESSION' && !f.systemic), 'a per-session error (NO_SUCH_SESSION) does not pause the organizer', JSON.stringify(t));

  config.set({ modules: { organizer: false } });
  t = await organizer.tick({ index: ix, setGroup: stub([]), isIdle: () => true });
  check(t.skipped === 'module off', 'module toggle switches it off');

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
