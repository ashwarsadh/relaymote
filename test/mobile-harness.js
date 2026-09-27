// mobile-harness.js — shared by the test/mobile-*.js suites (not a suite itself).
//
// Everything runs offline against a throwaway world: a temp BATON_HOME, a fake Claude Desktop data
// set (test/make-demo.js) as APPDATA / CLAUDE_CONFIG_DIR, spare ports, and a debugger port that
// points at nothing, so every desktop call fails fast instead of touching a real app.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DEMO_ACCOUNT = '00000000-demo-acct';
const DEMO_ORG = '00000000-demo-org';

let failed = 0;
const check = (ok, name, extra) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra !== undefined && extra !== '' ? '  ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)) : ''}`); if (!ok) failed++; };
const failures = () => failed;
const wait = ms => new Promise(r => setTimeout(r, ms));
const src = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

/** A temp world. With `env: true` it also points THIS process at it (do that before any require). */
function world(tag, { demo = true, env = false, settings = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-' + tag + '-'));
  if (demo) execFileSync(process.execPath, [path.join(__dirname, 'make-demo.js'), dir]);
  const w = {
    dir,
    appdata: path.join(dir, 'appdata'),
    claude: path.join(dir, 'claude'),
    home: path.join(dir, 'baton'),
    store: path.join(dir, 'appdata', 'Claude', 'claude-code-sessions', DEMO_ACCOUNT, DEMO_ORG),
  };
  fs.mkdirSync(w.home, { recursive: true });
  fs.mkdirSync(path.join(w.appdata, 'Claude'), { recursive: true });
  fs.mkdirSync(w.claude, { recursive: true });
  fs.writeFileSync(path.join(w.home, 'settings.json'), JSON.stringify(Object.assign({
    cdpPort: 9, onboarded: true, autoEnableDebugger: false, idleGateSeconds: 0,
    modules: { autoResume: false, orchestrator: false, chipAutostart: false, masterNotify: false, organizer: false, routines: false },
  }, settings), null, 2));
  w.env = { APPDATA: w.appdata, CLAUDE_CONFIG_DIR: w.claude, BATON_HOME: w.home, USERPROFILE: dir, HOME: dir };
  if (env) { Object.assign(process.env, w.env); delete process.env.BATON_STATE_DIR; delete process.env.BATON_MOBILE_SECRET; }
  w.sessions = () => fs.existsSync(w.store) ? fs.readdirSync(w.store).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(w.store, f), 'utf8'))) : [];
  w.cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} };
  return w;
}

function request(port, p, { method = 'GET', body, headers = {}, token, cookie } = {}) {
  return new Promise(resolve => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const h = { ...headers };
    if (token) h.Authorization = 'Bearer ' + token;
    if (cookie) h.Cookie = 'baton_m=' + encodeURIComponent(cookie);
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: h, timeout: 20000 }, res => {
      let s = ''; res.on('data', c => s += c);
      res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch {} resolve({ status: res.statusCode, json: j || {}, text: s, headers: res.headers }); });
    });
    r.on('error', e => resolve({ status: 0, json: {}, text: e.message }));
    r.on('timeout', () => r.destroy(new Error('timeout')));
    if (data) r.write(data);
    r.end();
  });
}

/** Boot the daemon (server.js) in world `w`. Returns helpers bound to its app port and token. */
async function boot(w, extraEnv = {}) {
  const PORT = 20000 + Math.floor(Math.random() * 20000), APP = PORT + 1;
  const env = { ...process.env, ...w.env, BATON_PORT: String(PORT), BATON_APP_PORT: String(APP), ...extraEnv };
  delete env.BATON_STATE_DIR; delete env.BATON_MOBILE_SECRET;
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', d => out += d); child.stderr.on('data', d => out += d);
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { await wait(250); up = (await request(APP, '/manifest.webmanifest')).status === 200; }
  if (!up) { console.log(out.slice(-3000)); throw new Error('daemon did not come up'); }
  const token = JSON.parse(fs.readFileSync(path.join(w.home, 'mobile', 'secret.json'), 'utf8')).token;
  const streams = [];
  const d = {
    port: PORT, app: APP, token, child, output: () => out,
    req: (p, o = {}) => request(APP, p, { token: o.token === null || o.cookie ? undefined : (o.token || token), ...o }),
    /** Open an SSE stream; events land in the returned array as { event, data }. */
    stream(clientId, o = {}) {
      const got = [];
      const q = clientId ? '?client=' + encodeURIComponent(clientId) : '';
      const r = http.request({ host: '127.0.0.1', port: APP, path: '/api/stream' + q,
        headers: { Authorization: 'Bearer ' + (o.token || token), Accept: 'text/event-stream' } }, resp => {
          got.status = resp.statusCode;
          let buf = '';
          resp.on('data', c => {
            buf += c; let i;
            while ((i = buf.indexOf('\n\n')) >= 0) {
              const f = buf.slice(0, i); buf = buf.slice(i + 2);
              const m = f.match(/^event: *(\S+)[\s\S]*?data: *(.*)$/m);
              if (m) { let data = m[2]; try { data = JSON.parse(m[2]); } catch {} got.push({ event: m[1], data, at: Date.now() }); }
            }
          });
          resp.on('error', () => {});
        });
      r.on('error', () => {}); r.end();
      got.close = () => { try { r.destroy(); } catch {} };
      streams.push(got);
      return got;
    },
    async waitFor(list, pred, ms = 15000) {
      const t0 = Date.now();
      for (;;) { const e = list.find(pred); if (e) return e; if (Date.now() - t0 > ms) return null; await wait(200); }
    },
    async stop() {
      for (const s of streams) s.close();
      await request(PORT, '/api/shutdown', { method: 'POST' });
      for (let i = 0; i < 40 && child.exitCode === null; i++) await wait(250);
      if (child.exitCode === null) child.kill();
    },
  };
  return d;
}

/** Create a sub-user in world `w` through the module itself, exactly as the CLI does. */
function subuser(w, name, sessionIds) {
  const code = `const s = require(${JSON.stringify(path.join(ROOT, 'mobile', 'subusers.js'))});
    const a = process.argv.slice(1); const op = a[0];
    const r = op === 'create' ? s.create(a[1], JSON.parse(a[2])) : op === 'revoke' ? s.revoke(a[1]) : s.remove(a[1]);
    console.log(JSON.stringify(r || null));`;
  const run = (...args) => JSON.parse(execFileSync(process.execPath, ['-e', code, ...args], { env: { ...process.env, ...w.env } }).toString() || 'null');
  return { create: () => run('create', name, JSON.stringify(sessionIds)), revoke: () => run('revoke', name), remove: () => run('remove', name) };
}

/**
 * A stand-in for Claude Desktop's main-process debugger: an HTTP /json endpoint plus a WebSocket
 * that answers Runtime.evaluate by running the expression in a sandbox. The sandbox offers the two
 * things Relaymote's bridge scripts reach for — electron.webContents (one "claude.ai" renderer) and,
 * inside that renderer, window['claude.web'].LocalSessions — backed by `sessions`, a plain object
 * the test reads and mutates. Anything else a script touches throws, which Relaymote must survive.
 * Point a world at it with settings { cdpPort: fake.port }.
 */
async function fakeDesktop(sessions = {}) {
  const vm = require('vm');
  const { WebSocketServer } = require('ws');
  const calls = [];
  const sess = (id) => { const s = sessions[id]; if (!s) throw new Error('Session not found: ' + id); return s; };
  const LocalSessions = {
    async getSession(id) { calls.push(['getSession', id]); const s = sessions[id]; return s ? { model: s.model, effort: s.effort, ultracode: !!s.ultracode, isRunning: !!s.isRunning } : null; },
    async getEffort(id) { return sess(id).effort; },
    async setEffort(id, level) {
      calls.push(['setEffort', id, level]);
      if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(level)) throw new Error('invalid effort ' + level);
      sess(id).effort = level;
    },
    async applyFlagSettings(id, flags) { calls.push(['applyFlagSettings', id, flags]); if ('ultracode' in flags) sess(id).ultracode = !!flags.ultracode; },
    async setModel(id, model) {
      calls.push(['setModel', id, model]);
      if (!/^claude-[a-z]+-[\d-]+$/.test(model)) throw new Error('model not recognized: ' + model);
      sess(id).model = model;
    },
    async getTranscriptTail(id, n) { return { messages: (sess(id).transcript || []).slice(-(n || 40)) }; },
    // The desktop's own queue: a message sent to a running session is held until the turn ends.
    async sendMessage(id, text, _a, _b, _c, _d, _e, uuid) {
      calls.push(['sendMessage', id, text, uuid]);
      const s = sess(id);
      if (s.isRunning) (s.queue = s.queue || []).push({ uuid, text });
      else { deliver(s, text); s.isRunning = true; }
    },
    async cancelQueuedMessage(id, uuid) {
      calls.push(['cancelQueuedMessage', id, uuid]);
      const q = sess(id).queue || []; const i = q.findIndex(m => m.uuid === uuid);
      if (i < 0) return false; q.splice(i, 1); return true;
    },
    async promoteQueuedMessage(id, uuid) {
      calls.push(['promoteQueuedMessage', id, uuid]);
      const q = sess(id).queue || []; const i = q.findIndex(m => m.uuid === uuid);
      if (i < 0) return false; q.unshift(q.splice(i, 1)[0]); return true;
    },
    async interrupt(id) { calls.push(['interrupt', id]); const s = sess(id); s.interrupted = (s.interrupted || 0) + 1; turnEnds(s); },
  };
  // Delivery writes a user row into the session's transcript (and its .jsonl file, if `file` is set),
  // which is where Relaymote looks for proof of arrival.
  function deliver(s, text) {
    const row = { type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: text } };
    (s.transcript = s.transcript || []).push(row);
    if (s.file) fs.appendFileSync(s.file, JSON.stringify(row) + '\n');
  }
  function turnEnds(s) {
    s.isRunning = false;
    const next = (s.queue || []).shift();
    if (next) { deliver(s, next.text); s.isRunning = true; }
  }
  const renderer = vm.createContext({ setTimeout, clearTimeout, console });
  renderer.window = renderer;
  renderer['claude.web'] = { LocalSessions };
  renderer.location = { href: 'https://claude.ai/claude-code-desktop/local_none' };
  renderer.document = { querySelectorAll: () => ({ length: 3, forEach() {} }), addEventListener() {}, querySelector: () => null };
  const wc = { id: 1, getURL: () => 'https://claude.ai/claude-code-desktop', setBackgroundThrottling() {},
               executeJavaScript: async (js) => vm.runInContext(js, renderer) };
  const electron = { webContents: { getAllWebContents: () => [wc], fromId: (id) => (id === 1 ? wc : null) } };
  const main = vm.createContext({ process: { mainModule: { require: (m) => { if (m === 'electron') return electron; throw new Error('no module ' + m); } } }, setTimeout, JSON });
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([{ id: 'main', type: 'node', webSocketDebuggerUrl: `ws://127.0.0.1:${srv.address().port}/main` }]));
  });
  const wss = new WebSocketServer({ server: srv });
  wss.on('connection', sock => sock.on('message', async raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    let reply;
    try { reply = { id: m.id, result: { result: { value: await vm.runInContext(m.params.expression, main) } } }; }
    catch (e) { reply = { id: m.id, result: { exceptionDetails: { text: String(e && e.message || e) } } }; }
    try { sock.send(JSON.stringify(reply)); } catch {}
  }));
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const endTurn = (id, model) => {
    const s = sess(id);
    s.transcript.push({ type: 'assistant', timestamp: new Date().toISOString(), message: { model: model || s.model } });
    turnEnds(s);
  };
  return { port: srv.address().port, sessions, calls, endTurn, close: () => { wss.close(); srv.close(); } };
}

function finish(w) {
  if (w) w.cleanup();
  console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
}

module.exports = { world, boot, request, subuser, fakeDesktop, check, failures, wait, src, finish, ROOT, DEMO_ACCOUNT, DEMO_ORG };
