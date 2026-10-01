// q10-auth-audit.js — offline proof for the auth findings in NOTES-q10.md. NOT part of `npm test`.
//
// Run:  node test/q10-auth-audit.js
//
// It boots the daemon (server.js) in a throwaway world (temp RELAYMOTE_HOME, CLAUDE_CONFIG_DIR, APPDATA,
// HOME; demo sessions from test/make-demo.js; debugger port 9, so every desktop call fails fast), and
// exercises mobile/subusers.js, mobile/access.js, mobile/files.js and lib/control-guard.js in-process.
// No network: the Cloudflare Access JWKS fetch is answered by a stubbed https.get.
//
// Output: "FINDING <id> ..." for each confirmed weakness, "fine <what>" for each property that held,
// "info ..." for observations. It always exits 0: it reports, it does not gate.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const wait = ms => new Promise(r => setTimeout(r, ms));
const findings = [];
const FINDING = (id, msg) => { findings.push(id); console.log(`FINDING ${id} ${msg}`); };
const fine = (msg) => console.log(`fine    ${msg}`);
const info = (msg) => console.log(`info    ${msg}`);
const red = (s) => { s = String(s || ''); return s.length > 4 ? s.slice(0, 4) + '…[REDACTED]' : s; };

// ---------------------------------------------------------------- temp world (before any require of lib/)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relaymote-q10-'));
execFileSync(process.execPath, [path.join(__dirname, 'make-demo.js'), dir], { windowsHide: true });
const W = {
  appdata: path.join(dir, 'appdata'), claude: path.join(dir, 'claude'), home: path.join(dir, 'relaymote'),
  store: path.join(dir, 'appdata', 'Claude', 'claude-code-sessions', '00000000-demo-acct', '00000000-demo-org'),
};
for (const d of [W.home, path.join(W.appdata, 'Claude'), W.claude]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(W.home, 'settings.json'), JSON.stringify({
  cdpPort: 9, onboarded: true, autoEnableDebugger: false, idleGateSeconds: 0,
  notifications: { enabled: false },
  modules: { autoResume: false, orchestrator: false, chipAutostart: false, masterNotify: false, organizer: false,
             routines: false, autoUpdate: false },
}, null, 2));
const ENV = { APPDATA: W.appdata, CLAUDE_CONFIG_DIR: W.claude, RELAYMOTE_HOME: W.home, USERPROFILE: dir, HOME: dir,
              RELAYMOTE_ACCESS_TEAM: '', RELAYMOTE_ACCESS_AUD: '' };
Object.assign(process.env, ENV);
delete process.env.RELAYMOTE_STATE_DIR; delete process.env.RELAYMOTE_MOBILE_SECRET;

// A board.html with a marker: what the owner's desktop board would hold (session titles, questions, goals).
const BOARD_MARK = 'Q10-OWNER-BOARD-MARKER';
fs.writeFileSync(path.join(W.home, 'board.html'), `<!doctype html><title>board</title><p>${BOARD_MARK}: owner-only questions and goals</p>`);

// ---------------------------------------------------------------- HTTP helpers
function request(port, p, { method = 'GET', body, raw, headers = {} } = {}) {
  return new Promise(resolve => {
    const data = raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : null;
    const h = { ...headers };
    if (data) { if (!h['Content-Type']) h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: h, timeout: 20000 }, res => {
      let s = ''; res.on('data', c => s += c);
      res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch {} resolve({ status: res.statusCode, json: j || {}, text: s, headers: res.headers }); });
    });
    r.on('error', e => resolve({ status: 0, json: {}, text: e.message, headers: {} }));
    r.on('timeout', () => r.destroy(new Error('timeout')));
    if (data) r.write(data);
    r.end();
  });
}
function sse(port, p, headers = {}) {
  const got = [];
  const r = http.request({ host: '127.0.0.1', port, path: p, headers: { Accept: 'text/event-stream', ...headers } }, resp => {
    got.status = resp.statusCode;
    let buf = '';
    resp.on('data', c => {
      buf += c; let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const f = buf.slice(0, i); buf = buf.slice(i + 2);
        const m = f.match(/^event: *(\S+)[\s\S]*?data: *(.*)$/m);
        if (m) { let d = m[2]; try { d = JSON.parse(m[2]); } catch {} got.push({ event: m[1], data: d }); }
      }
    });
    resp.on('error', () => {});
  });
  r.on('error', () => {}); r.end();
  got.close = () => { try { r.destroy(); } catch {} };
  return got;
}
async function waitFor(list, pred, ms = 12000) {
  const t0 = Date.now();
  for (;;) { const e = list.find(pred); if (e) return e; if (Date.now() - t0 > ms) return null; await wait(200); }
}

// ---------------------------------------------------------------- in-process checks (no daemon needed)
function checkAccessJwt() {
  // Stub https.get BEFORE mobile/access.js loads, so its JWKS fetch never leaves the process.
  const https = require('https');
  const { EventEmitter } = require('events');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'q10kid', kty: 'RSA', alg: 'RS256' };
  const realGet = https.get;
  https.get = (url, opts, cb) => {
    const req = new EventEmitter(); req.destroy = () => {};
    setImmediate(() => { const res = new EventEmitter(); cb(res); res.emit('data', JSON.stringify({ keys: [jwk] })); res.emit('end'); });
    return req;
  };
  process.env.RELAYMOTE_ACCESS_TEAM = 'q10team.cloudflareaccess.com';
  process.env.RELAYMOTE_ACCESS_AUD = 'q10-aud';
  const access = require(path.join(ROOT, 'mobile', 'access.js'));
  const b64u = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
  const sign = (head, payload, key = privateKey) => {
    const h = b64u(head), p = b64u(payload);
    const s = crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`), key).toString('base64url');
    return `${h}.${p}.${s}`;
  };
  const now = Math.floor(Date.now() / 1000);
  const base = { iss: 'https://q10team.cloudflareaccess.com', aud: ['q10-aud'], email: 'owner@example.com', sub: 'x' };
  const H = { alg: 'RS256', kid: 'q10kid', typ: 'JWT' };
  return (async () => {
    await wait(50);
    const good = await access.verify(sign(H, { ...base, exp: now + 600 }));
    good ? fine('access.js accepts a well-formed RS256 Access JWT (control)') : info('access.js rejected the control JWT; the JWT checks below are inconclusive');
    const noExp = await access.verify(sign(H, { ...base, iat: now }));
    if (noExp) FINDING('B7-access-no-exp', 'mobile/access.js verify() accepts a validly-signed Access JWT that has NO exp claim (owner identity, cached 60s)');
    else fine('access.js rejects a JWT with no exp');
    const expired = await access.verify(sign(H, { ...base, exp: now - 10 }));
    expired ? FINDING('B7-access-expired', 'expired JWT accepted') : fine('access.js rejects an expired JWT');
    const wrongAud = await access.verify(sign(H, { ...base, aud: ['other'], exp: now + 600 }));
    wrongAud ? FINDING('B7-access-aud', 'wrong aud accepted') : fine('access.js rejects a wrong aud');
    const wrongIss = await access.verify(sign(H, { ...base, iss: 'https://evil.cloudflareaccess.com', exp: now + 600 }));
    wrongIss ? FINDING('B7-access-iss', 'wrong iss accepted') : fine('access.js rejects a wrong iss');
    const none = await access.verify(`${b64u({ alg: 'none', kid: 'q10kid' })}.${b64u({ ...base, exp: now + 600 })}.`);
    none ? FINDING('B7-access-none', 'alg none accepted') : fine('access.js rejects alg:none');
    const hs = crypto.createHmac('sha256', 'k');
    const hsTok = `${b64u({ alg: 'HS256', kid: 'q10kid' })}.${b64u({ ...base, exp: now + 600 })}`;
    const hsOk = await access.verify(hsTok + '.' + hs.update(hsTok).digest('base64url'));
    hsOk ? FINDING('B7-access-hs256', 'HS256 accepted') : fine('access.js rejects HS256 (alg confusion)');
    const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    const forged = await access.verify(sign(H, { ...base, exp: now + 600 }, other));
    forged ? FINDING('B7-access-sig', 'bad signature accepted') : fine('access.js rejects a token signed by another key');
    const unkKid = await access.verify(sign({ ...H, kid: 'nope' }, { ...base, exp: now + 600 }));
    unkKid ? FINDING('B7-access-kid', 'unknown kid accepted') : fine('access.js rejects an unknown kid');
    https.get = realGet;
    process.env.RELAYMOTE_ACCESS_TEAM = ''; process.env.RELAYMOTE_ACCESS_AUD = '';
  })();
}

function checkFiles() {
  const { readFile } = require(path.join(ROOT, 'mobile', 'files.js'));
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'relaymote-q10-files-'));
  // Symlink escape (the sub-user case: roots = [session cwd], siblings off).
  const proj = path.join(T, 'proj'); fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(T, 'outside.txt'), 'OUTSIDE-SECRET');
  fs.writeFileSync(path.join(proj, 'ok.txt'), 'inside');
  let linked = false;
  try { fs.symlinkSync(path.join(T, 'outside.txt'), path.join(proj, 'link.txt')); linked = true; } catch {}
  const asSub = (ref) => readFile(ref, { roots: [proj], cwd: proj, siblings: false, home: null });
  asSub('ok.txt').ok ? fine('files.readFile serves a file inside the granted cwd (control)') : info('control read failed');
  const trav = asSub('../outside.txt');
  trav.ok ? FINDING('B5-files-traversal', 'readFile ../ escapes the root') : fine(`files.readFile refuses ../ traversal (${trav.error})`);
  const abs = asSub(path.join(T, 'outside.txt'));
  abs.ok ? FINDING('B5-files-abs', 'absolute path outside root served') : fine(`files.readFile refuses an absolute path outside the root (${abs.error})`);
  if (linked) {
    const l = asSub('link.txt');
    l.ok ? FINDING('B5-files-symlink', 'symlink inside root pointing outside was served') : fine(`files.readFile refuses a symlink that escapes the root (${l.error})`);
  } else info('symlink not creatable here; symlink escape not exercised');
  fs.writeFileSync(path.join(proj, '.env'), 'X=1');
  asSub('.env').ok ? FINDING('B5-files-env', '.env served') : fine('files.readFile refuses .env (SECRET_RX)');
  // Owner-only sibling search: its hit is never re-checked against the roots.
  // roots: deep = T/base/a/b/c, shallow = T/base/a. bare "../../n/outside2.txt" resolves INSIDE the shallow root
  // from the deep one (so it passes the scope check, but does not exist), then the sibling search joins it onto
  // T/base/<dir>/ and lands on T/n/outside2.txt — outside every root.
  const deep = path.join(T, 'base', 'a', 'b', 'c'), shallow = path.join(T, 'base', 'a');
  fs.mkdirSync(deep, { recursive: true });
  fs.mkdirSync(path.join(T, 'n'), { recursive: true });
  fs.writeFileSync(path.join(T, 'n', 'outside2.txt'), 'OUTSIDE-EVERY-ROOT');
  const sib = readFile('../../n/outside2.txt', { roots: [deep, shallow], cwd: deep, siblings: true, home: null });
  if (sib.ok && /OUTSIDE-EVERY-ROOT/.test(sib.text || '')) FINDING('B6-files-sibling-escape', `owner /api/file sibling search returned a file outside every root (${path.relative(T, sib.path)})`);
  else fine(`owner sibling search stayed inside the roots (${sib.error || 'ok'})`);
  try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
}

function checkControlGuard() {
  const g = require(path.join(ROOT, 'lib', 'control-guard.js'));
  const P = 8788;
  const r1 = g.check({ method: 'POST', headers: { host: `127.0.0.1:${P}`, origin: 'https://evil.example' } }, P);
  r1 ? fine('control-guard refuses a cross-origin POST (Origin)') : FINDING('B9-guard-post', 'cross-origin POST allowed');
  const r2 = g.check({ method: 'POST', headers: { host: `127.0.0.1:${P}`, 'sec-fetch-site': 'cross-site' } }, P);
  r2 ? fine('control-guard refuses Sec-Fetch-Site: cross-site POST') : FINDING('B9-guard-sfs', 'cross-site POST allowed');
  const r3 = g.check({ method: 'GET', headers: { host: `rebind.evil.example:${P}` } }, P);
  r3 ? fine('control-guard refuses a non-loopback Host (DNS rebinding)') : FINDING('B9-guard-host', 'rebinding Host allowed');
  const r4 = g.check({ method: 'POST', headers: { host: `127.0.0.1:${P}`, origin: 'null' } }, P);
  r4 ? fine('control-guard refuses Origin: null POST') : FINDING('B9-guard-null', 'Origin null allowed');
  const r5 = g.check({ method: 'GET', headers: { host: `127.0.0.1:${P}`, origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' } }, P);
  if (!r5) info('control-guard lets every cross-site GET through by design (GET is treated as safe); see B9 for GET /open');
}

// ---------------------------------------------------------------- daemon
async function boot() {
  const PORT = 20000 + Math.floor(Math.random() * 20000), APP = PORT + 1;
  const env = { ...process.env, ...ENV, RELAYMOTE_PORT: String(PORT), RELAYMOTE_APP_PORT: String(APP) };
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = ''; child.stdout.on('data', d => out += d); child.stderr.on('data', d => out += d);
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { await wait(250); up = (await request(APP, '/manifest.webmanifest')).status === 200; }
  if (!up) throw new Error('daemon did not come up: ' + out.slice(-1500));
  const token = JSON.parse(fs.readFileSync(path.join(W.home, 'mobile', 'secret.json'), 'utf8')).token;
  return {
    PORT, APP, token, child,
    async stop() {
      await request(PORT, '/api/shutdown', { method: 'POST' });
      for (let i = 0; i < 40 && child.exitCode === null; i++) await wait(250);
      if (child.exitCode === null) child.kill();
    },
  };
}

(async () => {
  let d = null;
  try {
    await checkAccessJwt();
    checkFiles();
    checkControlGuard();

    // subusers.js in-process, against the same RELAYMOTE_HOME the daemon reads.
    const subusers = require(path.join(ROOT, 'mobile', 'subusers.js'));

    // B1: prototype keys authenticate (no daemon needed for the core proof).
    for (const k of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      const r = subusers.find(k);
      if (r) FINDING('B1-proto-token', `subusers.find(${JSON.stringify(k)}) returns an identity (name=${JSON.stringify(r.name)}, sessions=${r.sessions.size}) with no subusers.json entry`);
      else fine(`subusers.find(${JSON.stringify(k)}) is null`);
    }

    d = await boot();
    const own = { Authorization: 'Bearer ' + d.token };
    info(`daemon up: control 127.0.0.1:${d.PORT}, app 127.0.0.1:${d.APP}; owner token [REDACTED]`);

    // Control: a random token is refused.
    const rnd = await request(d.APP, '/api/bootstrap?k=' + crypto.randomBytes(24).toString('base64url'));
    rnd.status === 401 ? fine('a random ?k= token gets 401 (control)') : info('random token status ' + rnd.status);
    const noauth = await request(d.APP, '/api/bootstrap');
    noauth.status === 401 ? fine('no credentials -> 401 on /api/bootstrap (control)') : FINDING('B0-noauth', 'bootstrap without auth: ' + noauth.status);

    // B1 over HTTP: what the bogus identity reaches.
    for (const [how, opts] of [
      ['?k=constructor', { path: (p) => p + (p.includes('?') ? '&' : '?') + 'k=constructor', headers: {} }],
      ['?k=__proto__', { path: (p) => p + (p.includes('?') ? '&' : '?') + 'k=__proto__', headers: {} }],
      ['Bearer toString', { path: (p) => p, headers: { Authorization: 'Bearer toString' } }],
      ['cookie baton_m=valueOf', { path: (p) => p, headers: { Cookie: 'baton_m=valueOf' } }],
    ]) {
      const got = [];
      for (const p of ['/api/bootstrap', '/api/build', '/api/sessions', '/board', '/index.html']) {
        const r = await request(d.APP, opts.path(p), { headers: opts.headers });
        got.push(`${p}=${r.status}`);
        if (p === '/board' && r.status === 200 && r.text.includes(BOARD_MARK)) got.push('(board.html contents served)');
        if (p === '/api/bootstrap' && r.status === 200 && r.json.host) got.push('(hostname disclosed)');
      }
      const anyOk = got.some(s => /=200/.test(s));
      if (anyOk) FINDING('B1-proto-token-http', `unauthenticated "${how}" reaches: ${got.join(' ')}`);
      else fine(`"${how}" is refused everywhere (${got.join(' ')})`);
    }
    const ck = await request(d.APP, '/?k=constructor');
    if (ck.status === 302 && /baton_m=constructor/.test(String(ck.headers['set-cookie'] || ''))) FINDING('B1-proto-cookie', 'GET /?k=constructor answers 302 and sets a year-long baton_m=constructor cookie');
    const wr = await request(d.APP, '/api/send?k=constructor', { method: 'POST', body: { id: 'local_x', text: 'never' } });
    wr.status === 403 ? fine('the bogus identity cannot POST /api/send (empty grant -> 403 NOT_GRANTED)') : FINDING('B1-proto-write', 'POST /api/send status ' + wr.status);
    const st = await request(d.APP, '/api/settings?k=constructor');
    st.status === 403 ? fine('the bogus identity cannot read /api/settings (403)') : FINDING('B1-proto-settings', '/api/settings status ' + st.status);

    // B2: a GENUINE sub-user reads the owner's board (route sits before the sub-user allowlist).
    const ids = ((await request(d.APP, '/api/sessions?limit=300', { headers: own })).json.sessions || []).map(s => s.id);
    const sub = subusers.create('q10-sub', ids.slice(0, 1));
    const sb = await request(d.APP, '/board', { headers: { Authorization: 'Bearer ' + sub.token } });
    if (sb.status === 200 && sb.text.includes(BOARD_MARK)) FINDING('B2-subuser-board', 'a scoped sub-user GET /board gets the owner\'s whole board.html (route is above the sub-user allowlist)');
    else fine('sub-user /board refused (' + sb.status + ')');
    const sapi = await request(d.APP, '/api/board', { headers: { Authorization: 'Bearer ' + sub.token } });
    sapi.status === 403 ? fine('sub-user /api/board is refused (403) — only the HTML route leaks') : info('/api/board status ' + sapi.status);

    // B3: client ids from /api/build let another identity subscribe to the owner's job results.
    const OWNER_CLIENT = 'c-q10-owner-' + crypto.randomBytes(4).toString('hex');
    const ownerStream = sse(d.APP, '/api/stream?client=' + OWNER_CLIENT, own);
    await wait(1200);
    const bld = await request(d.APP, '/api/build?k=constructor');
    const leaked = (bld.json.clients || []).map(c => c.client).filter(Boolean);
    if (leaked.includes(OWNER_CLIENT)) FINDING('B3-client-id-leak', `/api/build (sub-user allowlisted; reachable via B1 without auth) lists live client ids: ${leaked.map(red).join(', ')}`);
    else fine('/api/build does not list the owner client id');
    const spy = sse(d.APP, '/api/stream?k=constructor&client=' + encodeURIComponent(OWNER_CLIENT));
    await wait(1200);
    await request(d.APP, '/api/rename', { method: 'POST', body: { id: ids[0] || 'local_x', title: 'q10 owner rename' }, headers: { ...own, 'X-Baton-Client': OWNER_CLIENT } });
    const ev = await waitFor(spy, e => e.event === 'uiresult', 15000);
    if (ev) FINDING('B3-sse-hijack', `a stream opened with ?k=constructor&client=<owner id> received the owner's uiresult (op=${ev.data.op}, id=${red(ev.data.id)})`);
    else info('spy stream got no uiresult within 15s (inconclusive)');
    // and an owner request with NO client header goes to every stream without a client id
    const spy2 = sse(d.APP, '/api/stream?k=constructor');
    await wait(1200);
    await request(d.APP, '/api/rename', { method: 'POST', body: { id: ids[0] || 'local_x', title: 'q10 owner rename 2' }, headers: own });
    const ev2 = await waitFor(spy2, e => e.event === 'uiresult', 15000);
    if (ev2) FINDING('B3-sse-null-origin', 'an owner request without X-Baton-Client is broadcast (uiresult) to a sub-user stream that has no client id');
    ownerStream.close(); spy.close(); spy2.close();

    // B4: revoke() acts on the FIRST record with the name, even an already-revoked one.
    const first = subusers.create('q10-dup', ids.slice(0, 1));
    subusers.revoke('q10-dup');
    const second = subusers.create('q10-dup', ids.slice(0, 1));
    const rv = subusers.revoke('q10-dup');
    const still = await request(d.APP, '/api/sessions', { headers: { Authorization: 'Bearer ' + second.token } });
    if (rv.ok && still.status === 200) FINDING('B4-revoke-first', `subusers.revoke("q10-dup") reported ok but the second token with that name still authenticates (${still.status})`);
    else fine('revoke on a reused name revoked the live token');
    const firstNow = await request(d.APP, '/api/sessions', { headers: { Authorization: 'Bearer ' + first.token } });
    firstNow.status === 401 ? fine('the first (revoked) token stays refused') : info('first token status ' + firstNow.status);

    // B10: subusers.json permissions (POSIX only).
    if (process.platform !== 'win32') {
      const sf = path.join(W.home, 'mobile', 'subusers.json'), sec = path.join(W.home, 'mobile', 'secret.json');
      const m = fs.statSync(sf).mode & 0o777, ms = fs.statSync(sec).mode & 0o777;
      if (m & 0o077) FINDING('B10-subusers-mode', `subusers.json (bearer tokens) is mode ${m.toString(8)} under umask ${process.umask().toString(8)}; secret.json is ${ms.toString(8)}`);
      else fine('subusers.json is not group/other readable');
    }

    // B8: mobile POSTs carry no Origin / Sec-Fetch-Site check.
    const xo = await request(d.APP, '/api/notify-config', { method: 'POST', raw: JSON.stringify({ enabled: false }),
      headers: { ...own, 'Content-Type': 'text/plain', Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' } });
    if (xo.status === 200 && xo.json.ok) FINDING('B8-no-origin-check', 'POST /api/notify-config with Origin https://evil.example, Sec-Fetch-Site cross-site and text/plain body is accepted (200)');
    else fine('cross-origin POST refused (' + xo.status + ')');
    const getMut = await request(d.APP, '/api/outbox/drop?id=q10', { headers: own });
    if (getMut.status === 200) FINDING('B8-get-mutates', 'GET /api/outbox/drop answers 200 (state change on GET: also /api/cancel, /api/send-now, /api/seen, /api/mark-read, ?refresh=1)');
    const cors = await request(d.APP, '/api/bootstrap', { headers: { ...own, Origin: 'https://evil.example' } });
    cors.headers['access-control-allow-origin'] ? FINDING('B8-cors', 'mobile API sends ACAO ' + cors.headers['access-control-allow-origin']) : fine('mobile API sends no Access-Control-Allow-Origin');

    // Cookie flags.
    const pair = await request(d.APP, '/?k=' + encodeURIComponent(d.token));
    const c1 = String(pair.headers['set-cookie'] || '');
    const pairS = await request(d.APP, '/?k=' + encodeURIComponent(d.token), { headers: { 'X-Forwarded-Proto': 'https' } });
    const c2 = String(pairS.headers['set-cookie'] || '');
    info(`pairing cookie flags: plain http -> ${c1.replace(/baton_m=[^;]+/, 'baton_m=<token>')}; with X-Forwarded-Proto https -> Secure=${/;\s*Secure/i.test(c2)}`);
    /HttpOnly/.test(c1) && /SameSite=Lax/.test(c1) ? fine('baton_m is HttpOnly; SameSite=Lax') : FINDING('B11-cookie', 'cookie flags missing');
    const loc = String(pair.headers.location || '');
    !/k=/.test(loc) ? fine('the pairing redirect strips ?k= from the URL') : FINDING('B11-redirect', 'redirect keeps the token');

    // Static traversal.
    const tr1 = await request(d.APP, '/%2e%2e/package.json', { headers: own });
    const tr2 = await request(d.APP, '/..%2fpackage.json', { headers: own });
    (/"name"\s*:\s*"relaymote"/.test(tr1.text) || /"name"\s*:\s*"relaymote"/.test(tr2.text)) ? FINDING('B5-static-traversal', 'static route served package.json') : fine(`static route refuses encoded ../ (${tr1.status}, ${tr2.status})`);

    // Open routes.
    for (const p of ['/sw.js', '/manifest.webmanifest', '/icon-192.png']) {
      const r = await request(d.APP, p);
      info(`open route ${p} -> ${r.status} without auth (public asset by design)`);
    }

    // B9: the control API's GET /open is reachable cross-site and sends ACAO *.
    const op = await request(d.PORT, '/open?session=local_00000000-0000-4000-8000-000000000000', { headers: { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' } });
    if (op.headers['access-control-allow-origin'] === '*' && op.status !== 403) FINDING('B9-open-cors', `control GET /open from Origin evil.example is not refused (${op.status}) and answers Access-Control-Allow-Origin: *`);
    const cp = await request(d.PORT, '/api/task', { method: 'POST', body: { prompt: 'x' }, headers: { Origin: 'https://evil.example' } });
    cp.status === 403 ? fine('control POST /api/task with a foreign Origin -> 403') : FINDING('B9-task-xo', 'control POST /api/task cross-origin status ' + cp.status);
    const cs = await request(d.PORT, '/api/state', { headers: { Host: 'rebind.evil.example:' + d.PORT } });
    cs.status === 403 ? fine('control GET /api/state with a rebinding Host -> 403') : FINDING('B9-rebind', 'rebinding Host status ' + cs.status);
    const ca = await request(d.PORT, '/api/state');
    if (ca.status === 200) FINDING('B12-control-noauth', 'control API GET /api/state answers 200 to any local process with no credential (POST /api/task is equally unauthenticated and calls orch.pump() directly; not exercised here)');

    // B13: token rotation does not take effect until restart.
    const rot = await request(d.APP, '/api/token/rotate', { method: 'POST', body: {}, headers: own });
    const after = await request(d.APP, '/api/sessions', { headers: own });
    if (rot.status === 200 && after.status === 200) FINDING('B13-rotate-lag', 'after POST /api/token/rotate the old owner token still authenticates until the daemon restarts');
  } catch (e) {
    console.log('info    harness error (results above still stand): ' + (e && e.message));
  } finally {
    try { if (d) await d.stop(); } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    console.log(`\n${findings.length} FINDING line(s). This script reports; it never fails.`);
    process.exit(0);
  }
})();
