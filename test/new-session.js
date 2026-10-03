// g1131: New session from the phone. It drove Desktop's New view with clicks, so it could only pick a
// folder from Desktop's recent-folders list, refused Sonnet (the menu text read "Sonnet 5.53" with the
// shortcut digit glued on), took long enough to leave "Creating…" up while the session started anyway,
// and showed a failure as a JSON blob with an empty error. It is now one LocalSessions.start call.
const fs = require('fs'), os = require('os'), path = require('path');
const root = path.join(__dirname, '..');
process.env.RELAYMOTE_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-new-'));
const ns = require('../mobile/newsession.js');
let fails = 0;
const check = (ok, what, got) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) { fails++; if (got !== undefined) console.log('     ', JSON.stringify(got)); } };

const ids = { 'Opus 5.5': 'claude-opus-5-5', 'Fable 5.1': 'claude-fable-5-1', 'Sonnet 5.5': 'claude-sonnet-5-5', 'Haiku 4.5': 'claude-haiku-4-5-20251001' };
for (const [label, id] of Object.entries(ids)) {
  const r = ns.resolveModel(label, ids);
  check(r.ok && r.id === id, `every offered model resolves: ${label} -> ${id}`, r);
}
check(ns.resolveModel('sonnet', ids).id === 'claude-sonnet-5-5', 'a bare family name resolves to the offered model');
check(ns.resolveModel('Sonnet 5.5', {}).id === 'claude-sonnet-5-5', 'with no live list, a label is derived to its id');
check(ns.resolveModel('claude-opus-5-5', ids).id === 'claude-opus-5-5', 'an id passes through');
check(!ns.resolveModel('gpt-9', ids).ok, 'an unknown model is refused');

(async () => {
  // Refusals happen BEFORE anything is created: no Desktop call is made for them.
  const gone = path.join(os.tmpdir(), 'rm-no-such-folder-' + Date.now());
  const r1 = await ns.newSession({ cwd: gone, prompt: 'hi', model: 'Sonnet 5.5', modelIds: ids });
  check(!r1.ok && r1.error === 'FOLDER_MISSING' && /Nothing was created/.test(r1.message), 'a folder that does not exist is refused, nothing created', r1);
  const r2 = await ns.newSession({ cwd: os.tmpdir(), prompt: 'hi', model: 'gpt-9', modelIds: ids });
  check(!r2.ok && /Nothing was created/.test(r2.message), 'an unknown model is refused, nothing created', r2);
  // Any existing folder is accepted: no recent-folders list is consulted.
  const r3 = await ns.newSession({ cwd: os.tmpdir(), prompt: 'hi', model: 'Sonnet 5.5', effort: 'high', modelIds: ids, dryRun: true });
  check(r3.ok && r3.model === 'claude-sonnet-5-5' && r3.effort === 'high', 'any existing folder + Sonnet + effort passes the checks', r3);
  const r4 = await ns.newSession({ cwd: os.tmpdir(), prompt: 'hi', model: 'Haiku 4.5', effort: 'high', modelIds: ids, dryRun: true });
  check(r4.ok && r4.effort === null, 'Haiku is started without an effort (it has none)', r4);

  const src = fs.readFileSync(path.join(root, 'mobile', 'newsession.js'), 'utf8');
  check(/permissionMode: 'bypassPermissions'/.test(src) && /\.start\(/.test(src), 'it starts through LocalSessions.start with bypass permissions');
  check(/setModel\(/.test(src) && /setEffort\(/.test(src) && /verified/.test(src), 'it reads back the folder, model and effort Desktop recorded, and corrects a miss');

  const idx = fs.readFileSync(path.join(root, 'mobile', 'index.js'), 'utf8');
  const route = idx.slice(idx.indexOf("if (p === '/api/new')"), idx.indexOf("if (p === '/api/permission/answer')"));
  check(!/uiJob\(/.test(route) && /out = await newSession\(job\)/.test(route), 'the route answers directly, not through the UI queue and a job id');
  check(/sessions\.get\(out\.sessionId\)/.test(route) && /refresh\(\{ force: true \}\)/.test(route),
        'it says created only once the session is in the index, found by forced rescans (no "no such session", no 8 s wait)');
  check(/error: o\.message \|\| o\.error/.test(route), 'a failure carries the reason as a sentence in error');
  check(/statSync\(f\.cwd\)\.isDirectory\(\)/.test(idx), 'the folder list offers only folders that exist');

  const app = fs.readFileSync(path.join(root, 'mobile', 'public', 'app.js'), 'utf8');
  const cs = app.slice(app.indexOf('async function createSession'), app.indexOf('async function loadMore'));
  check(!/uiJobs\.set/.test(cs) && /openChat\(sid\)/.test(cs) && /Started in /.test(cs), 'the phone confirms where and on what it started, and opens it');
  check(cs.indexOf("api('/api/session/'") > 0 && cs.indexOf("api('/api/session/'") < cs.indexOf('openChat(sid)'), 'it opens the session only once the server can serve it (never "no such session")');
  const sessRoute = idx.slice(idx.indexOf("if (p.startsWith('/api/session/'))"), idx.indexOf("if (p.startsWith('/api/session/'))") + 600);
  check(/refresh\(\{ force: true \}\)/.test(sessRoute), 'the session view rescans once before answering "no such session"');

  const gw = fs.readFileSync(path.join(root, 'lib', 'gui-worker.js'), 'utf8');
  const pr = gw.slice(gw.indexOf('const pickRadioJs'), gw.indexOf('const readTriggerJs'));
  check(/e\.children && e\.children\[0\]/.test(pr), 'the in-session model picker reads the label, not the shortcut digit');

  fs.rmSync(process.env.RELAYMOTE_STATE_DIR, { recursive: true, force: true });
  if (fails) { console.error(fails + ' failed'); process.exit(1); }
  console.log('new-session: all checks passed');
})();
