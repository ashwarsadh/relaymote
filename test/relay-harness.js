// relay-harness.js — shared by the test/relay-*.js suites (not a suite itself).
//
// Builds on test/mobile-harness.js (temp world, request(), fakeDesktop()) and adds what the relay
// suites need on top: a daemon boot that passes windowsHide (and can be booted again in the same
// world, to prove what survives a restart), a controllable stand-in for Claude Desktop's debugger
// (it can hang, drop the socket mid-call, go down and come back on the SAME port), a server that
// accepts connections and never answers, a way to move the debugger port under a running daemon,
// and KNOWN-BUG reporting: a check that documents a real defect prints `KNOWN-BUG ...` and does not
// fail the suite (no source is changed by these tests; see NOTES-q09.md).
// Everything is offline and local: 127.0.0.1 only, temp RELAYMOTE_HOME / APPDATA / CLAUDE_CONFIG_DIR.
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn, execFileSync } = require('child_process');
const H = require('./mobile-harness');

const ROOT = path.join(__dirname, '..');
let known = 0, passed = 0;
const wait = H.wait;

/** A normal check, counted for the summary line (failures counted by the mobile harness). */
function check(ok, name, extra) { if (ok) passed++; H.check(ok, name, extra); }

/**
 * A check that is EXPECTED to fail today because it documents a real bug. `ok` is what the code
 * should do; when it does not, the line reads KNOWN-BUG and the suite still passes. If the bug is
 * ever fixed the line turns into a plain `ok` with a reminder to drop the marker.
 */
function knownBug(ok, name, extra) {
  if (ok) { passed++; console.log(`ok   ${name}  (was a KNOWN-BUG: it now passes; turn this into a plain check)`); return; }
  known++;
  console.log(`KNOWN-BUG ${name}${extra !== undefined && extra !== '' ? '  ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)) : ''}`);
}

function finish(w, label) {
  if (w) w.cleanup();
  const failed = H.failures();
  console.log(`\n${label}: ${passed} passed, ${failed} failed, ${known} known bug(s)`);
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
  process.exit(failed ? 1 : 0);
}

/** Point a world's settings at another debugger port while a daemon is running (settings are read fresh, mtime-cached). */
function setCdpPort(w, port) {
  const f = path.join(w.home, 'settings.json');
  const s = JSON.parse(fs.readFileSync(f, 'utf8'));
  s.cdpPort = port;
  fs.writeFileSync(f, JSON.stringify(s, null, 2));
  const t = new Date(Date.now() + Math.floor(Math.random() * 1000) + 1000);
  fs.utimesSync(f, t, t);   // guarantee a new mtime, so the cached settings are re-read
}

/** Boot server.js in world `w` (same shape as mobile-harness boot(), with windowsHide). */
async function boot(w, extraEnv = {}) {
  const PORT = 20000 + Math.floor(Math.random() * 20000), APP = PORT + 1;
  const env = { ...process.env, ...w.env, RELAYMOTE_PORT: String(PORT), RELAYMOTE_APP_PORT: String(APP), ...extraEnv };
  delete env.RELAYMOTE_STATE_DIR; delete env.RELAYMOTE_MOBILE_SECRET; delete env.RELAYMOTE_CDP_PORT;
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = ''; child.stdout.on('data', d => out += d); child.stderr.on('data', d => out += d);
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { await wait(250); up = (await H.request(APP, '/manifest.webmanifest')).status === 200; }
  if (!up) { console.log(out.slice(-3000)); throw new Error('daemon did not come up'); }
  const token = JSON.parse(fs.readFileSync(path.join(w.home, 'mobile', 'secret.json'), 'utf8')).token;
  const streams = [];
  const d = {
    port: PORT, app: APP, token, child, output: () => out,
    req: (p, o = {}) => H.request(APP, p, { token: o.token === null || o.cookie ? undefined : (o.token || token), ...o }),
    /** Open an SSE stream; events land in the returned array as { event, data, at }. close() drops it. */
    stream(clientId, o = {}) {
      const got = [];
      const q = new URLSearchParams();
      if (clientId) q.set('client', clientId);
      if (o.watch) q.set('watch', o.watch);
      const qs = q.toString();
      let sock = null;
      const r = http.request({ host: '127.0.0.1', port: APP, path: '/api/stream' + (qs ? '?' + qs : ''),
        headers: { Authorization: 'Bearer ' + (o.token || token), Accept: 'text/event-stream' } }, resp => {
          got.status = resp.statusCode;
          let buf = '';
          resp.on('data', c => {
            buf += c; let i;
            while ((i = buf.indexOf('\n\n')) >= 0) {
              const f = buf.slice(0, i); buf = buf.slice(i + 2);
              if (/^: *connected/m.test(f)) got.connected = true;
              const m = f.match(/^event: *(\S+)[\s\S]*?data: *(.*)$/m);
              if (m) { let data = m[2]; try { data = JSON.parse(m[2]); } catch {} got.push({ event: m[1], data, at: Date.now() }); }
            }
          });
          resp.on('error', () => {});
        });
      r.on('socket', s => { sock = s; });
      r.on('error', () => {}); r.end();
      got.close = () => { try { r.destroy(); } catch {} };
      /** Drop the TCP connection without any HTTP-level goodbye (a phone losing signal). */
      got.kill = () => { try { if (sock) sock.destroy(); } catch {} try { r.destroy(); } catch {} };
      streams.push(got);
      return got;
    },
    async waitFor(list, pred, ms = 15000) {
      const t0 = Date.now();
      for (;;) { const e = list.find(pred); if (e) return e; if (Date.now() - t0 > ms) return null; await wait(150); }
    },
    async stop() {
      for (const s of streams) s.close();
      await H.request(PORT, '/api/shutdown', { method: 'POST' });
      for (let i = 0; i < 40 && child.exitCode === null; i++) await wait(250);
      if (child.exitCode === null) child.kill();
    },
  };
  return d;
}

/** Create / revoke a sub-user in world `w` through the module itself, in a child (windowsHide). */
function subuser(w, name, sessionIds) {
  const code = `const s = require(${JSON.stringify(path.join(ROOT, 'mobile', 'subusers.js'))});
    const a = process.argv.slice(1); const op = a[0];
    const r = op === 'create' ? s.create(a[1], JSON.parse(a[2])) : op === 'revoke' ? s.revoke(a[1]) : s.remove(a[1]);
    console.log(JSON.stringify(r || null));`;
  const run = (...args) => JSON.parse(execFileSync(process.execPath, ['-e', code, ...args], { env: { ...process.env, ...w.env }, windowsHide: true }).toString() || 'null');
  return { create: () => run('create', name, JSON.stringify(sessionIds)), revoke: () => run('revoke', name), remove: () => run('remove', name) };
}

/**
 * A controllable stand-in for the debugger endpoint: GET /json lists one target whose WebSocket is
 * on the same port; every Runtime.evaluate is passed to `behave(expression, n)`, which returns
 *   { value }        -> reply with that value
 *   { exception: s } -> reply with exceptionDetails
 *   { hang: true }   -> never reply
 *   { close: true }  -> drop the socket without replying
 * stop() takes it down (destroying every open socket) and start() brings it back on the SAME port.
 */
async function cdpStub(behave = () => ({ value: 'pong' })) {
  const { WebSocketServer } = require('ws');
  const st = { port: 0, conns: 0, evals: [], open: new Set(), behave, srv: null, wss: null };
  const listen = (port) => new Promise((res, rej) => {
    const srv = http.createServer((req, resp) => {
      resp.writeHead(200, { 'Content-Type': 'application/json' });
      resp.end(JSON.stringify([{ id: 'main', type: 'node', webSocketDebuggerUrl: `ws://127.0.0.1:${srv.address().port}/main` }]));
    });
    srv.on('connection', s => { st.open.add(s); s.on('close', () => st.open.delete(s)); });
    const wss = new WebSocketServer({ server: srv });
    wss.on('connection', sock => {
      st.conns++;
      sock.on('message', async raw => {
        let m; try { m = JSON.parse(raw); } catch { return; }
        const expr = (m.params && m.params.expression) || '';
        st.evals.push(expr);
        let b; try { b = await st.behave(expr, st.evals.length); } catch (e) { b = { exception: e.message }; }
        if (!b || b.hang) return;
        if (b.close) { try { sock.terminate(); } catch {} return; }
        const reply = b.exception !== undefined
          ? { id: m.id, result: { exceptionDetails: { text: String(b.exception) } } }
          : { id: m.id, result: { result: { value: b.value } } };
        try { sock.send(JSON.stringify(reply)); } catch {}
      });
    });
    srv.once('error', rej);
    srv.listen(port, '127.0.0.1', () => { st.port = srv.address().port; st.srv = srv; st.wss = wss; res(); });
  });
  await listen(0);
  st.stop = () => new Promise(res => {
    for (const s of st.open) { try { s.destroy(); } catch {} }
    try { st.wss.close(); } catch {}
    st.srv.close(() => res());
  });
  st.start = () => listen(st.port);
  return st;
}

/** A TCP server that accepts and then says nothing (a debugger that hangs, or a socket that never upgrades). */
async function silentServer() {
  const open = new Set();
  const srv = net.createServer(s => { open.add(s); s.on('close', () => open.delete(s)); s.on('error', () => {}); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  return { port: srv.address().port, open, close: () => new Promise(r => { for (const s of open) s.destroy(); srv.close(() => r()); }) };
}

/** A port on 127.0.0.1 with nothing listening (taken, then released). */
async function deadPort() {
  const s = net.createServer();
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  const p = s.address().port;
  await new Promise(r => s.close(r));
  return p;
}

/** The .jsonl transcript of a world's session record (where delivery is proven). */
function transcriptFile(w, rec) {
  return path.join(w.claude, 'projects', String(rec.cwd).replace(/[^A-Za-z0-9]/g, '-'), rec.cliSessionId + '.jsonl');
}

module.exports = { ...H, check, knownBug, finish, boot, subuser, cdpStub, silentServer, deadPort, setCdpPort, transcriptFile };
