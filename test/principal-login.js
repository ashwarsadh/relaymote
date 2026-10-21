// principal-login.js — Ajay's Conductor (Ashwar 21-Oct-2026): "make a conductor for ajay, login via
// colleague@example.com ... he sees his own sessions and my session where his prompt invoked it ...
// he dont see my other sessions". A Cloudflare Access email listed in a sub-principal's `logins` is a SCOPED
// identity, enforced by the server: his Conductor + what it touched in 7 days, everything else 403.
// Real server.js in a temp world; real RS256 Access JWTs, verified by mobile/access.js against a stubbed JWKS.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const H = require('./mobile-harness');
const { check } = H;

const TEAM = 'team-test.cloudflareaccess.com', AUD = 'aud-test-ajay';
const AJAY = 'colleague@example.com', ASHWAR = 'owner@example.com';

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plogin-'));
  const boardDir = path.join(tmp, 'board'), stub = path.join(tmp, 'stub.js');
  fs.mkdirSync(boardDir, { recursive: true });
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = Object.assign(publicKey.export({ format: 'jwk' }), { kid: 'k1', alg: 'RS256', use: 'sig' });
  fs.writeFileSync(stub, `const https = require('https'), { EventEmitter } = require('events');
const body = ${JSON.stringify(JSON.stringify({ keys: [jwk] }))};
https.get = function (url, opts, cb) {
  if (typeof opts === 'function') cb = opts;
  const req = new EventEmitter(); req.destroy = () => {}; req.end = () => {};
  setImmediate(() => { const res = new EventEmitter(); res.statusCode = 200; cb && cb(res);
    res.emit('data', body); res.emit('end'); });
  return req;
};`);
  const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const jwt = (email) => {
    const now = Math.floor(Date.now() / 1000);
    const h = b64u({ alg: 'RS256', kid: 'k1', typ: 'JWT' });
    const p = b64u({ email, sub: 'sub-' + email, iss: 'https://' + TEAM, aud: [AUD], iat: now, nbf: now, exp: now + 3600 });
    return `${h}.${p}.${crypto.sign('RSA-SHA256', Buffer.from(h + '.' + p), privateKey).toString('base64url')}`;
  };

  const w = H.world('plogin', { settings: { board: { dir: boardDir } } });
  const ids = w.sessions().map(s => s.sessionId || s.id).filter(Boolean);
  check(ids.length >= 4, 'precondition: at least 4 sessions on disk', ids.length);
  const [AJAY_C, TOUCHED, STALE, OTHER] = ids;
  fs.writeFileSync(path.join(boardDir, 'principals.json'), JSON.stringify({ default: 'ashwar', principals: {
    ashwar: { name: 'Ashwar', conductor: null, sees: 'all', admin: true },
    ajay: { name: 'Ajay', conductor: AJAY_C, sees: 'own', enabled: true, logins: [AJAY] } } }));
  // His Conductor messaged TOUCHED an hour ago (an Ashwar-side session his prompt invoked) and STALE 8 days ago.
  const now = Date.now(), H1 = 3600e3, D8 = 8 * 24 * H1;
  fs.mkdirSync(path.join(w.home, 'state'), { recursive: true });
  fs.writeFileSync(path.join(w.home, 'state', 'principal-touch.json'), JSON.stringify({ files: {}, touch: {
    [TOUCHED]: { ajay: { first: now - H1, last: now - H1, started: false } },
    [STALE]: { ajay: { first: now - D8, last: now - D8, started: false } } } }));

  const d = await H.boot(w, { NODE_OPTIONS: '--require ' + JSON.stringify(stub).slice(1, -1),
                              RELAYMOTE_ACCESS_TEAM: TEAM, RELAYMOTE_ACCESS_AUD: AUD });
  const asAjay = (p, o = {}) => d.req(p, { ...o, token: null, headers: { 'Cf-Access-Jwt-Assertion': jwt(AJAY), ...(o.headers || {}) } });
  const asAshwar = (p, o = {}) => d.req(p, { ...o, token: null, headers: { 'Cf-Access-Jwt-Assertion': jwt(ASHWAR), ...(o.headers || {}) } });
  const refused = (r) => r.status === 403;
  try {
    let r = await asAjay('/api/sessions?limit=300');
    const aj = (r.json.sessions || []).map(s => s.id);
    check(r.status === 200 && aj.length === 2 && aj.includes(AJAY_C) && aj.includes(TOUCHED),
      "Ajay's list = his Conductor + the session it touched this week, nothing else", aj);
    check(!aj.includes(STALE) && !aj.includes(OTHER), 'a session untouched for 8 days and an untouched one are hidden', aj);

    r = await asAjay('/api/sessions?limit=300', { headers: { 'X-Relaymote-As': 'ashwar' } });
    check((r.json.sessions || []).length === 2, 'X-Relaymote-As: ashwar cannot widen his list', (r.json.sessions || []).length);
    r = await asAjay('/api/sessions?limit=300&k=' + encodeURIComponent(d.token));
    check((r.json.sessions || []).length === 2, 'even the owner ?k= cannot lift a bound login', (r.json.sessions || []).length);
    r = await asAjay('/api/bootstrap');
    check(r.status === 200 && r.json.counts && r.json.counts.total === 2 && r.json.principal === 'ajay' && !r.json.folders.length, '/api/bootstrap agrees (2 sessions, principal ajay, no folders)', r.json.counts);

    check(refused(await asAjay('/api/session/' + OTHER)), 'GET /api/session/<other> -> 403');
    check(refused(await asAjay('/api/session/' + STALE)), 'GET /api/session/<stale> -> 403');
    check((await asAjay('/api/session/' + AJAY_C)).status === 200, 'GET /api/session/<his Conductor> -> 200');
    check((await asAjay('/api/session/' + TOUCHED)).status === 200, 'GET /api/session/<touched> -> 200');
    check(refused(await asAjay('/api/send', { method: 'POST', body: { id: OTHER, text: 'must never be dispatched' } })), 'POST /api/send to another session -> 403');
    check(refused(await asAjay('/api/permission?id=' + OTHER)), 'GET /api/permission on another session -> 403');
    check(refused(await asAjay('/api/file?session=' + OTHER + '&path=x.txt')), 'GET /api/file on another session -> 403');
    check(refused(await asAjay('/api/chips?id=' + OTHER)), 'GET /api/chips on another session -> 403');
    check(refused(await asAjay('/api/attach', { method: 'POST', body: { id: OTHER, files: [] } })), 'POST /api/attach to another session -> 403');
    for (const p of ['/api/accounts', '/api/settings', '/api/goals', '/api/new', '/api/folders', '/api/search?q=x', '/api/principals', '/api/live-settings']) {
      check(refused(await asAjay(p)), `${p} is closed to him`);
    }

    const ev = [];
    await new Promise((resolve) => {
      const req = require('http').request({ host: '127.0.0.1', port: d.app, path: '/api/stream?client=pc-ajay&as=ashwar',
        headers: { 'Cf-Access-Jwt-Assertion': jwt(AJAY), Accept: 'text/event-stream' } }, res => {
          let buf = '';
          res.on('data', c => { buf += c; const m = buf.match(/event: *sessions\r?\ndata: *(.*)\n/); if (m) { ev.push(JSON.parse(m[1])); req.destroy(); resolve(); } });
          res.on('error', () => resolve());
        });
      req.on('error', () => resolve()); req.end();
      setTimeout(resolve, 15000);
    });
    const sIds = ev[0] ? ev[0].sessions.map(s => s.id) : null;
    check(!!sIds && sIds.length === 2 && sIds.includes(AJAY_C), "his live stream (asking as=ashwar) still gets only his 2", sIds);

    r = await asAshwar('/api/sessions?limit=300');
    const all = (r.json.sessions || []).map(s => s.id);
    check(r.status === 200 && all.length >= ids.length - 1 && all.includes(OTHER) && all.includes(STALE),
      "Ashwar's Access login still sees every session", all.length);
    check((await asAshwar('/api/session/' + OTHER)).status === 200, 'Ashwar opens any session');
    r = await d.req('/api/sessions?limit=300');
    check((r.json.sessions || []).length === all.length, 'the owner token sees the same as Ashwar', (r.json.sessions || []).length);
    // 21-Oct, his PC: "this phone needs pairing and doesnt work" - the app read the 403 of every owner-only call
    // (/api/accounts, /api/settings, /api/principals ...) as a lost pairing and reloaded. Only 401 / an uncoded 403 is.
    r = await asAjay('/api/settings');
    check(r.status === 403 && !!r.json.error, 'an owner-only call answers him with a CODED 403', r.json.error);
    check(/r\.status === 401 \|\| \(r\.status === 403 && !code\)/.test(H.src('mobile/public/app.js')),
      'the app shows the pairing screen only on 401 or an uncoded 403, never on a coded refusal');
  } finally {
    await d.stop();
    w.cleanup();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
  H.finish(w);
})().catch(e => { console.error(e); process.exit(1); });
