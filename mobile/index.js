'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const zlib = require('zlib');

const sessions = require('./sessions');
const desktop = require('../lib/desktop');
const outbox = require('./outbox');
const deskState = require('../lib/desktop-state');
const routines = require('./routines');
const registry = require('../lib/registry');
const orch = require('../lib/orchestrator');
const push = require('./push');
const alerts = require('./alerts');
const pushHealth = require('./pushhealth');   // says so when no phone can receive an alert
const access = require('./access');
const { newSession } = require('./newsession');
const { answerQuestion, answersAsText, shouldFallBack } = require('./answer');
const { readRunningTasks, stopRunningTask } = require('./tasks');
const { pasteFiles } = require('./attach');
const { readFile } = require('./files');
const sentfiles = require('./sentfiles');   // files a session sent with SendUserFile
const tts = require('./tts');               // read-aloud audio the phone plays through <audio> (g808)
const { readSuggestion } = require('./suggest');
const config = require('../lib/config');
const pushMissed = require('./push-missed').make(path.join(config.STATE, 'push-missed.json'));   // per principal, shown on their phone
const tunnel = require('../lib/tunnel');
const pair = require('../lib/pair');
const accountScope = require('../lib/account-scope');
const { readUsage } = require('./usage');
const board = require('./board');
const { readPermission, answerPermission, peekPermission, approvalRisk, pendingApproval } = require('./permission');
const { pressDialogButton } = require('./dialog');
const accounts = require('./accounts');
const subusers = require('./subusers');

const DIR = __dirname;
const PUBLIC = path.join(DIR, 'public');
const UPLOADS = config.UPLOADS;
const SECRET_FILE = process.env.RELAYMOTE_MOBILE_SECRET || path.join(config.MOBILE, 'secret.json');
const PORT = Number(process.env.RELAYMOTE_MOBILE_PORT || config.get().appPort);
// Read once: an update restarts the daemon, so this is the version the phone should be running.
const APP_VERSION = (() => { try { return require('../package.json').version; } catch { return null; } })();
// g1630: a phone-call recording failed every time (the 20 s route deadline below cut the upload off
// mid-transfer). Uploads now stream to disk with no route deadline; the cap stays under Cloudflare's 100 MB
// per request, so the tunnel never refuses one the app accepted.
const MAX_UPLOAD = 95 * 1024 * 1024;
const UPLOAD_DEADLINE_MS = 30 * 60000;
const ROUTE_DEADLINE_MS = Number(process.env.RELAYMOTE_MOBILE_DEADLINE_MS || 20000);

const log = (m) => { try { orch.log('[mobile] ' + m); } catch { console.log('[mobile] ' + m); } };

function secret() {
  try {
    const s = JSON.parse(fs.readFileSync(SECRET_FILE, 'utf8'));
    if (s && s.token) return s;
  } catch {}
  const s = { token: crypto.randomBytes(24).toString('base64url'), createdAt: new Date().toISOString() };
  fs.writeFileSync(SECRET_FILE, JSON.stringify(s, null, 2), { mode: 0o600 });
  log('generated a new access token');
  return s;
}
const TOKEN = secret().token;

function safeEq(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

function cookieToken(req) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === 'baton_m') return decodeURIComponent(v.join('='));
  }
  return null;
}

// A login bound to a sub-principal (principals.json `logins`, e.g. Ajay's accounts@ email): a scoped identity
// that reuses every sub-user gate. Its session set is LIVE — his Conductor plus what it touched in the last 7
// days (principal-touch) — so a session his Conductor messages appears, and one untouched for a week drops out.
function scopedPrincipal(key, email) {
  const P = require('./principals'), touch = require('./principal-touch');
  let at = 0, ids = new Set();
  const live = () => {
    if (Date.now() - at < 5000) return ids;
    at = Date.now();
    try { touch.refresh(board.CONDUCTOR_DIR, (id) => sessions.transcriptPath(sessions.get(id))); } catch {}
    const p = P.resolve(board.CONDUCTOR_DIR, key);
    const out = new Set(touch.view(sessions.index().list, p, board.CONDUCTOR_DIR).map(s => s.id));
    if (p.conductor) out.add(p.conductor);
    ids = out;
    return ids;
  };
  return { kind: 'subuser', name: key, principal: key, email, via: 'access', token: null,
           sessions: { has: (id) => !!id && live().has(id), get size() { return live().size; } } };
}

// 27-Oct (AI Repair group): "on sanjay user baton logged in info user without otp or cloudflare access". Sanjay's
// Chrome on the office terminal server still held the team-wide Access session from an info@ OTP 24 days earlier,
// and Access re-issued Baton's token silently. A scoped (staff) login therefore also needs Baton's own sub-session
// (baton_ss, SUB_SESSION_H hours), and that is issued only after Baton has sent the browser through Access logout,
// which ends the stale session so the next Access login asks for the OTP. Owner logins are unchanged.
// The mark that this browser has been through Continue (the team-wide Access logout). Any Access login it makes after
// that asked for the code, however late. 15 min (0.2.145) and then 24 h (0.2.149) were time limits on a slow code email,
// and they trapped Sagar on 27-Oct: his code worked (14:40Z, a valid sagar@ login), but the mark from 14:08Z had expired,
// so he got Sign in again, and Continue logged him straight back out ("sagar entered relaymote pin and his account
// again logged out"). It now lasts as long as the login, and letting him in keeps it.
const OTP_WINDOW_S = 90 * 24 * 3600;
// 27-Oct 23:05 IST, Ashwar: "I do not want any login to expire in short amount ... like three months or so." 90 days,
// renewed while in use; ⏻ Log out still ends it at once.
const SUB_SESSION_H = () => Number(((config.get().remote || {}).access || {}).subSessionHours) || 2160;
const ssSig = (kind, email, exp) => crypto.createHmac('sha256', TOKEN).update(kind + '|' + String(email).toLowerCase() + '|' + exp).digest('hex');
function cookieVal(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}
function signedCookieOk(req, name, kind, email) {
  const v = cookieVal(req, name);
  const m = /^(\d+)\.([0-9a-f]{64})$/.exec(v || '');
  if (!m || Number(m[1]) < Date.now()) return false;
  return safeEq(m[2], ssSig(kind, email, m[1]));
}
function signedCookie(name, kind, email, maxAgeS, secure) {
  const exp = Date.now() + maxAgeS * 1000;
  return `${name}=${exp}.${ssSig(kind, email, exp)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeS}` + (secure ? '; Secure' : '');
}
// 0.2.145 sent the browser to the app's own /cdn-cgi/access/logout. That ends Baton's Access token only: the
// team-wide session on <team>.cloudflareaccess.com (which clearing Baton's site data never touches) re-issued it
// with no code asked. So: expire Baton's Access cookies here and end the team session at the team domain.
function accessLogout(secure) {
  const team = String(access.TEAM || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const gone = (n) => `${n}=; Path=/; Max-Age=0; HttpOnly` + (secure ? '; Secure; SameSite=None' : '; SameSite=Lax');
  return { location: team ? `https://${team}/cdn-cgi/access/logout` : '/cdn-cgi/access/logout',
           cookies: ['CF_Authorization', 'CF_AppSession', 'baton_ss', 'baton_m'].map(gone) };
}
// 27-Oct (0.2.146 live): a 302 to the team logout left him on Cloudflare's "You have successfully logged out" page
// with no way back ("when we log in, it directly opens the You have successfully logged out page"). Instead this
// page runs the team logout in a popup from his tap, closes it, and reloads Relaymote, which lands on Cloudflare's
// email-and-code screen and then straight back here. 401 so the service worker never caches it as the app shell.
function reauthPage(logoutUrl, email, explicit, postUrl) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const head = explicit ? 'Log out of Relaymote' : 'Sign in again';
  const why = explicit ? 'This signs Relaymote out on this browser. Coming back will ask for the emailed code.'
    : `For ${esc(email || 'this login')}, Relaymote asks for a fresh emailed code once every ${Math.round(SUB_SESSION_H() / 24)} days, renewed while you use it.`;
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Relaymote</title>
<body style="font:16px system-ui;background:#12110f;color:#e8e6e3;padding:28px;max-width:520px">
<b style="font-size:18px">${head}</b><p style="color:#9b9691">${why}</p>
<ol style="color:#9b9691;padding-left:20px"><li>Tap <b>Continue</b>. A Cloudflare window opens and closes by itself.</li>
<li>Cloudflare asks for your email: enter it and tap <b>Send me a code</b>.</li><li>Type the code from that inbox. Relaymote opens.</li></ol>
<button id="go" style="font:inherit;padding:12px 20px;border-radius:10px;border:0;background:#d97757;color:#fff">Continue</button>
<p id="msg" style="color:#9b9691"></p>
<script>
var L=${JSON.stringify(logoutUrl)}, P=${JSON.stringify(postUrl)};
// The cookies change only on this tap (a POST), never on a page load, so a plain reload cannot skip the logout.
function start(){return fetch(P,{method:'POST',credentials:'same-origin'}).catch(function(){});}
document.getElementById('go').onclick=function(){
  var w=null; try{w=window.open(L,'cflogout','width=420,height=520');}catch(e){}
  if(!w){document.getElementById('msg').innerHTML='Your browser blocked the window. <a id="lo" style="color:#d97757" href="'+L+'" target="_blank">Open Cloudflare logout</a>, then come back and <a style="color:#d97757" href="/">tap here</a>.';
    document.getElementById('lo').onclick=start;return;}
  document.getElementById('msg').textContent='Signing out of Cloudflare…';
  var t0=Date.now();
  start().then(function(){setTimeout(function(){try{w.close();}catch(e){} location.replace('/');},Math.max(0,4000-(Date.now()-t0)));});
};
</script>`;
}

async function resolveIdentity(req, url) {
  // A bound Access login is scoped whatever else the request carries: an owner ?k= or cookie must not lift it.
  const hasAccess = !!access.tokenFrom(req);
  const id = hasAccess ? await access.identify(req) : null;
  if (id && id.email) {
    const key = require('./principals').principalForLogin(board.CONDUCTOR_DIR, id.email);
    if (key) {
      if (signedCookieOk(req, 'baton_ss', 'ss', id.email)) {
        const sp = scopedPrincipal(key, id.email);
        // A live sub-session is topped back up to the full term (today's 12 h cookies become 90 days, no new sign-in).
        const exp = Number(String(cookieVal(req, 'baton_ss')).split('.')[0]);
        if (exp - Date.now() < SUB_SESSION_H() * 3600e3 * 0.9) sp.renewSS = true;
        return sp;
      }
      return { kind: 'reauth', principal: key, email: id.email, pending: signedCookieOk(req, 'baton_otp', 'otp', id.email) };
    }
  }
  const k = url.searchParams.get('k');
  if (k) {
    if (safeEq(k, TOKEN)) return { kind: 'owner', via: 'token' };
    const su = subusers.find(k);
    if (su) return { kind: 'subuser', name: su.name, token: su.token, sessions: su.sessions };
    return null;
  }
  if (id) return { kind: 'owner', via: 'access' };
  const cookieTok = cookieToken(req);
  if (cookieTok) {
    if (safeEq(cookieTok, TOKEN)) return { kind: 'owner', via: 'token' };
    const su = subusers.find(cookieTok);
    if (su) return { kind: 'subuser', name: su.name, token: su.token, sessions: su.sessions };
  }
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || null;
  if (bearer) {
    if (safeEq(bearer, TOKEN)) return { kind: 'owner', via: 'token' };
    const su = subusers.find(bearer);
    if (su) return { kind: 'subuser', name: su.name, token: su.token, sessions: su.sessions };
  }
  return null;
}

const isOwner = (identity) => !!identity && identity.kind === 'owner';
const isSubuser = (identity) => !!identity && identity.kind === 'subuser';

function visibleSessions(identity, all) {
  return isSubuser(identity) ? all.filter(s => identity.sessions.has(s.id)) : all;
}

// g1875: the phone says who holds it (X-Relaymote-As, set by app.js from Settings › This phone / ?as=).
// Sagar's phone lists his Conductor + what he touched in the last 7 days; Ashwar's list marks Sagar's sessions.
// A scoped login (Ajay) is always its own principal; the header/?as= cannot change it.
const principalOf = (req, url) => require('./principals').resolve(board.CONDUCTOR_DIR,
  (req._identity && req._identity.principal) || req.headers['x-relaymote-as'] || url.searchParams.get('as'));
function principalList(req, url, list) {
  const touch = require('./principal-touch');
  try { touch.refresh(board.CONDUCTOR_DIR, (id) => sessions.transcriptPath(sessions.get(id))); } catch (e) { log('principal touch scan failed: ' + e.message); }
  return touch.view(list, principalOf(req, url), board.CONDUCTOR_DIR);
}
// g1940: whose phones hear about session s — principal keys. An own principal (Sagar): the sessions his list
// shows. The default (Ashwar): every session except one another principal started (his list marks those).
function alertAudience(s) {
  const P = require('./principals'), touch = require('./principal-touch');
  const J = P.load(board.CONDUCTOR_DIR), out = new Set();
  for (const key of Object.keys(J.principals)) {
    const p = P.resolve(board.CONDUCTOR_DIR, key);
    const seen = touch.view([s], p, board.CONDUCTOR_DIR);
    if (seen.length && !(p.isDefault && seen[0].othersOnly)) out.add(key);
  }
  return { keys: out, def: J.default };
}
// 22-Oct (Ashwar): a session is never opened in the PC window because of another principal's activity, and any
// UI step done for his own phone waits until the PC has been idle for the idle gate (idleGateSeconds, 2 min).
const pcIdle = () => { try { return require('../lib/idle').isIdle(Number(require('../lib/config').get().idleGateSeconds || 120) * 1000); } catch { return false; } };
function windowBusy(req, url) {
  if (req && req._identity && req._identity.kind === 'subuser') return 'another principal';
  try { if (!principalOf(req, url).isDefault) return 'another principal'; } catch {}
  return pcIdle() ? null : 'PC in use';
}
function othersSession(s) {
  try { const a = alertAudience(s); return !a.keys.has(a.def); } catch { return true; }
}
const subPrincipal = (sub, def) => String((sub && sub.as) || def).toLowerCase();
function notePrincipalTouch(req, url, sid, started) {
  try {
    const p = principalOf(req, url);
    if (!p.own || !sid) return;
    const touch = require('./principal-touch');
    if (touch.note(sid, p.key, { started })) touch.save();
  } catch {}
}

// Warm the per-transcript caches of the most recent sessions after the list is served, so opening
// one does not pay the first full read (backgroundTasks parses incrementally from then on).
let warmAt = 0;
function warmRecent(list) {
  if (Date.now() - warmAt < 60000) return;
  warmAt = Date.now();
  const top = (list || []).slice().sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0)).slice(0, 12);
  let i = 0;
  const step = () => { const x = top[i++]; if (!x) return; try { const s1 = sessions.get(x.id); if (s1) sessions.backgroundTasks(s1); } catch {} setTimeout(step, 50); };
  setTimeout(step, 200);
}

function json(res, code, body) {
  const s = JSON.stringify(body);
  const ae = String((res.req && res.req.headers['accept-encoding']) || '');
  if (s.length > 4096 && /gzip/.test(ae)) {
    const z = zlib.gzipSync(s, { level: 4 });
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Encoding': 'gzip',
      'Content-Length': z.length, 'Vary': 'Accept-Encoding', 'Cache-Control': 'no-store' });
    return res.end(z);
  }
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(s),
    'Cache-Control': 'no-store',
  });
  res.end(s);
}

function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', c => {
      n += c.length;
      if (n > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.mjs': 'text/javascript; charset=utf-8',
};

let assetVer = { at: 0, hash: '', key: '', since: 0 };
function assetVersion() {
  if (Date.now() - assetVer.at < 2000) return assetVer.hash;
  let key = '';
  let files = [];
  try {
    files = fs.readdirSync(PUBLIC)
      .filter(f => /\.(js|css|html)$/i.test(f) && f !== 'sw.js' && !/\.bak/i.test(f))
      .sort();
  } catch {}
  for (const f of files) {
    try { const st = fs.statSync(path.join(PUBLIC, f)); key += f + st.size + st.mtimeMs + ';'; } catch {}
  }
  if (key !== assetVer.key) {
    assetVer.hash = crypto.createHash('sha1').update(key).digest('hex').slice(0, 10);
    assetVer.key = key;
    assetVer.since = Date.now();
  }
  assetVer.at = Date.now();
  return assetVer.hash;
}

function serveStatic(res, name, query) {
  const file = path.resolve(PUBLIC, '.' + name);
  if (!file.startsWith(PUBLIC + path.sep) && file !== PUBLIC) return json(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, buf) => {
    if (err) return json(res, 404, { error: 'not found' });
    const v = assetVersion();

    if (name === '/index.html') {
      buf = Buffer.from(String(buf)
        .replace(/(href|src)="\/?((?:[\w.-]+)\.(?:js|css))"/g, (m, a, f) =>
          f === 'sw.js' ? m : `${a}="/${f}?v=${v}"`));
    }

    if (name === '/sw.js') {
      buf = Buffer.from(`/* build ${v} */
` + String(buf));
    }
    const versioned = query && query.get('v');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': buf.length,
      'Cache-Control': versioned
        ? 'public, max-age=31536000, immutable'
        : 'no-store',
      ETag: '"' + crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16) + '"',
    });
    res.end(buf);
  });
}

let cmdCache = { at: 0, list: [] };
const BUILTIN = [
  ['goal', 'Keep working until a completion condition is met'],
  ['loop', 'Repeat a prompt on an interval, or self-paced'],
  ['compact', 'Compact the conversation'],
  ['clear', 'Clear the conversation'],
  ['context', 'Show context usage'],
  ['usage', 'Show plan usage'],
  ['model', 'Switch model'],
  ['effort', 'Set effort level'],
  ['rename', 'Rename this session'],
  ['code-review', 'Review the current diff'],
  ['security-review', 'Security review of pending changes'],
  ['init', 'Create a CLAUDE.md'],
];

function slashCommands() {
  if (Date.now() - cmdCache.at < 30000 && cmdCache.list.length) return cmdCache.list;
  const list = BUILTIN.map(([name, desc]) => ({ name, desc, kind: 'built-in' }));
  const home = process.env.USERPROFILE || require('os').homedir();
  for (const [dir, kind] of [[path.join(home, '.claude', 'skills'), 'skill'],
                             [path.join(home, '.claude', 'commands'), 'command']]) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (kind === 'skill' && e.isDirectory()) list.push({ name: e.name, desc: '', kind });
      else if (kind === 'command' && e.isFile() && e.name.endsWith('.md')) {
        list.push({ name: e.name.replace(/\.md$/, ''), desc: '', kind });
      }
    }
  }
  list.sort((a, b) => a.name.localeCompare(b.name));
  cmdCache = { at: Date.now(), list };
  return list;
}

const clients = new Set();
let pollTimer = null;
let lastListKey = '';

// g1132: a stream whose reader stopped reading (a phone browser put in the background keeps the
// socket open) buffers every write in THIS process: transcript payloads went into memory with no end,
// and the heap grew ~14 MB/min to 2.5 GB. A client that has fallen this far behind is dropped; its
// EventSource reconnects on its own and resyncs from scratch.
const SSE_MAX_QUEUED = 4 * 1048576;
let sseDropped = 0;
function sseSend(c, event, data) {
  if (c.dropped) return;
  const queued = (c.res && c.res.writableLength) || 0;
  if (queued > SSE_MAX_QUEUED) {
    c.dropped = true; sseDropped++;
    log(`sse: dropped a client that stopped reading (${Math.round(queued / 1048576)} MB unsent)`);
    clients.delete(c);
    try { c.res.destroy(); } catch {}
    return;
  }
  try { c.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {}
}
setInterval(() => {
  let q = 0; for (const c of clients) q += (c.res && c.res.writableLength) || 0;
  const m = process.memoryUsage();
  log(`sse: ${clients.size} client(s), ${Math.round(q / 1024)} KB unsent, ${sseDropped} dropped so far; heap ${Math.round(m.heapUsed / 1048576)} MB`);
}, 10 * 60000).unref();

const clientIdOf = (req) => String((req && req.headers && req.headers['x-baton-client']) || '').slice(0, 64) || null;

const clientBuilds = new Map();
const BUILD_KEEP_MS = 30 * 60 * 1000;
function noteClientBuild(id, build) {
  if (!build) return;
  const key = id || 'anonymous';
  const cur = assetVersion();
  const prev = clientBuilds.get(key);
  clientBuilds.set(key, { build, at: Date.now() });
  if (clientBuilds.size > 200) {
    for (const [k, v] of clientBuilds) {
      if (Date.now() - v.at > BUILD_KEEP_MS) clientBuilds.delete(k);
      if (clientBuilds.size <= 200) break;
    }
  }
  if (!prev || prev.build !== build) {
    log(`client ${key} booted build ${build}` + (build === cur ? ' (current)' : ` (STALE — server is ${cur})`));
  }
}
function clientBuildReport() {
  const cur = assetVersion();
  const now = Date.now();
  const liveIds = new Set();
  for (const c of clients) if (c.client) liveIds.add(c.client);
  const live = [];
  for (const id of liveIds) {
    const v = clientBuilds.get(id);
    live.push({ client: id, build: v ? v.build : null,
                current: v ? v.build === cur : null,
                secondsAgo: v ? Math.round((now - v.at) / 1000) : null });
  }
  live.sort((a, b) => (a.secondsAgo ?? 1e9) - (b.secondsAgo ?? 1e9));
  const recent = [];
  for (const [id, v] of clientBuilds) {
    if (now - v.at > BUILD_KEEP_MS) continue;
    recent.push({ client: id, build: v.build, current: v.build === cur,
                  secondsAgo: Math.round((now - v.at) / 1000), live: liveIds.has(id) });
  }
  recent.sort((a, b) => a.secondsAgo - b.secondsAgo);
  const stale = live.filter(c => c.current === false).length;
  const unknown = live.filter(c => c.current === null).length;
  return {
    serverBuild: cur,
    allCurrent: live.length ? (stale === 0 && unknown === 0) : null,
    connected: live.length,
    summary: { current: live.length - stale - unknown, stale, unknown },
    clients: live,
    recentBoots: recent.slice(0, 12),
  };
}
function recipients(origin) {
  const out = [];
  for (const c of clients) {
    if (origin ? c.client === origin : !c.client) out.push(c);
  }
  return out;
}

// 27-Oct, Ashwar: "I don't see the blue dot session, which is working. The blue dot ones should appear above the
// yellow dot ones." Working, then waiting, then the rest by last activity, BEFORE any list is cut (the phone asks
// for 80; the doorbell session, dated 7 days back by Desktop's file, never made the cut).
const attnRank = (s) => (s.running ? 0 : s.awaiting ? 1 : 2);
const byAttention = (list) => list.slice().sort((a, b) => (attnRank(a) - attnRank(b)) || ((b.lastActivityAt || 0) - (a.lastActivityAt || 0)));

function listKey(list) {
  let k = '';
  for (const s of list.slice(0, 80)) k += s.id + s.lastActivityAt + (s.dot || '') + s.title + ';';
  return k;
}

const attention = new Map();
let pushWarmed = false;

const wasRunning = new Map();
const obStamps = new Map();

function attentionState(s) {
  if (s.archived) return null;
  if (s.api) return null;          // API sessions (claude-api) never alert or push (Ashwar 14-Oct)
  if (s.awaiting) return 'awaiting';
  if (s.unread) return 'done';
  if (wasRunning.get(s.id) && !s.running) return 'done';
  return null;
}

/* "Finished" means a turn that just ENDED (g770 follow-up, 29-Sep: an alert for a session whose last
   message was 21 hours old). The two triggers above are state, not events: the Desktop re-raises
   unread dots in bulk (8 at once at 20:12 UTC on 28-Sep, none with a new turn), and a reconnect can
   re-observe running -> idle. So a done alert also needs the transcript to have been WRITTEN in the
   last 10 minutes, later than the turn already announced for that session. The transcript's mtime is
   the evidence: opening, reading or re-marking a session never writes it. Persisted, so a restart
   cannot announce the same turn again. */
const DONE_FRESH_MS = 10 * 60 * 1000;
const DONE_SEEN_FILE = path.join(config.STATE, 'done-notified.json');
let doneSeen = {};
try { doneSeen = JSON.parse(fs.readFileSync(DONE_SEEN_FILE, 'utf8')) || {}; } catch {}
function turnEndedAt(s) {
  const st = sessions.transcriptStamp(s);
  const m = st ? Number(String(st).split(':')[1]) : 0;
  return m || Number(s.lastActivityAt) || 0;
}
function freshDone(s, now = Date.now()) {
  const at = turnEndedAt(s);
  if (!at || now - at > DONE_FRESH_MS) return { ok: false, at, why: at ? Math.round((now - at) / 60000) + ' min old' : 'no transcript' };
  if (at <= (doneSeen[s.id] || 0)) return { ok: false, at, why: 'that turn was already announced' };
  return { ok: true, at };
}
function markDoneSeen(id, at) {
  doneSeen[id] = at;
  const cut = Date.now() - 7 * 86400e3;
  for (const k of Object.keys(doneSeen)) if (doneSeen[k] < cut) delete doneSeen[k];
  try { fs.writeFileSync(DONE_SEEN_FILE, JSON.stringify(doneSeen)); } catch {}
}

// Every alert's outcome is logged AFTER the send, from what the send reported. An alert that reached
// nobody is logged DROPPED and counted, so the push-health alarm can say how many were lost.
function logAlert(label, r) {
  const o = alerts.outcome(r);
  if (o.delivered) return log(`notify: ${label} -> ${o.text}`);
  log(`notify: DROPPED ${label}: ${o.text || 'no phone subscribed and no backup channel'}`);
  try { pushHealth.noteDropped(); } catch (e) { log('push-health: ' + e.message); }
}

/** 21-Oct (Ashwar: "I want you to allow or show allow button on relaymote"): when the awaiting session is held by an
 *  approval on screen (a computer-use "Allow Claude to use X?" card, or this session's own Allow/Deny prompt), the
 *  push says WHAT is asked and carries his Allow / Deny. Read only, no navigation; only his tap answers. */
async function approvalEvent(s, evt) {
  let pk;
  try { pk = await ui(() => peekPermission()); } catch (e) { log('approval peek failed: ' + e.message); return; }
  // Measured 21-Oct: the computer-use card is NOT drawn in every session's view (absent in Print Finder's, drawn in the
  // Conductor's). Nothing on screen -> open the waiting session, read its prompt, and put the view back -- but ONLY
  // when its transcript ends on a tool call still waiting (22-Oct: every awaiting turn, Sagar's Conductor asking him
  // a question included, used to switch Ashwar's window).
  if (!pk || !pk.ok || !pk.present || !(pk.card || pk.here === s.id)) {
    let tool = null;
    try { tool = pendingApproval(sessions.transcriptPath(s)); } catch {}
    if (!tool) return;
    // Another principal's session (Ajay's / Sagar's) is never opened on Ashwar's PC; nor is anything while he uses it.
    if (othersSession(s)) { log('approval read skipped for ' + s.id + ': another principal\'s session'); return; }
    if (!pcIdle()) { log('approval read skipped for ' + s.id + ': PC in use'); return; }
    try { pk = await ui(() => readPermission(s.id, { restore: true })); } catch (e) { log('approval read failed: ' + e.message); return; }
    if (pk && pk.restored === false) log('approval read: could not put the PC view back after reading ' + s.id);
    if (!pk || !pk.ok || !pk.present) return;
  }
  const ask = String(pk.request || '').replace(/\s+/g, ' ').trim();
  const allow = (pk.options || []).filter(o => o.kind === 'allow');
  const deny = (pk.options || []).find(o => o.kind === 'deny');
  const risk = approvalRisk(ask + ' ' + (pk.options || []).map(o => o.label).join(' '));
  // A one-tap Allow only for the narrowest allow choice (Desktop lists it first); never for a risky ask.
  const actions = [];
  if (!risk && allow[0]) actions.push({ action: 'allow', title: allow[0].label.slice(0, 30), raw: allow[0].raw || allow[0].label });
  if (deny) actions.push({ action: 'deny', title: deny.label.slice(0, 30), raw: deny.raw || deny.label });
  Object.assign(evt, {
    kind: 'approval',
    title: 'Approval needed · ' + String(s.title || s.id).slice(0, 60),
    body: ask.slice(0, 260) + (pk.card ? ' · it is declined by itself in about 5 minutes' : '')
      + (risk ? ' · "' + risk + '": open Relaymote to read it all and answer' : ''),
    tag: 'approval-' + s.id, renotify: true, requireInteraction: true, actions, risk: risk || null,
  });
  log('approval: "' + String(s.title || s.id).slice(0, 48) + '" asks "' + ask.slice(0, 90) + '"' + (risk ? ' [risky: ' + risk + ', no one-tap Allow]' : ''));
}

async function notifyAttention(all) {
  const flagged = all.map(s => [s, attentionState(s)]).filter(([, st]) => st);
  const ids = new Set(flagged.map(([s]) => s.id));
  for (const id of [...attention.keys()]) if (!ids.has(id)) attention.delete(id);

  if (!pushWarmed) {
    pushWarmed = true;
    for (const [s, st] of flagged) attention.set(s.id, st);
    for (const s of all) wasRunning.set(s.id, !!s.running);
    return;
  }

  const ncfg = config.get().notifications || {};
  for (const [s, st] of flagged) {
    if (attention.get(s.id) === st) continue;
    attention.set(s.id, st);
    if (ncfg.enabled === false) continue;
    if (st === 'awaiting' && ncfg.awaiting === false) continue;
    if (st === 'done' && ncfg.done === false) continue;
    if (st === 'done') {
      const f = freshDone(s);
      if (!f.ok) { log(`notify: skipped done "${String(s.title || s.id).slice(0, 48)}": ${f.why}`); continue; }
      markDoneSeen(s.id, f.at);
    }
    const folder = s.cwd ? path.basename(s.cwd) : '';
    const evt = {
      id: s.id,
      kind: st,
      title: s.title.slice(0, 80),
      body: (st === 'awaiting' ? 'Needs your input' : 'Finished') + (folder ? ' · ' + folder : ''),
      tag: 'sess-' + s.id,
      url: '/?s=' + encodeURIComponent(s.id),
    };
    if (st === 'awaiting') await approvalEvent(s, evt);
    let aud = null;
    try { require('./principal-touch').refresh(board.CONDUCTOR_DIR, (id) => sessions.transcriptPath(sessions.get(id))); aud = alertAudience(s); }
    catch (e) { log('notify: audience failed, sending to every phone: ' + e.message); }
    const group = aud ? [...aud.keys].sort().join('+') : '';
    const pushEvt = alerts.coalesceDone(evt, Date.now(), group);   // a burst of finishes = one phone notification (g770), per audience
    const label = `${st} "${String(s.title || s.id).slice(0, 48)}"` + (aud && !aud.keys.has(aud.def) ? ' [to ' + [...aud.keys].join(',') + ']' : '') +
                  (pushEvt.renotify === false ? ' [burst: replaces the last, no buzz]' : '');

    for (const c of clients) {
      if (isSubuser(c.identity) && !c.identity.sessions.has(s.id)) continue;
      if (aud && c.principal && !aud.keys.has(c.principal.key)) continue;
      sseSend(c, 'alert', evt);
    }

    if (aud && !aud.keys.size) { log(`notify: ${label} has no principal to tell`); continue; }
    logAlert(label, await alerts.deliver(pushEvt, log, aud ? { only: (sub) => aud.keys.has(subPrincipal(sub, aud.def)), backup: aud.keys.has(aud.def) } : {}));
    if (aud) {
      const subs = push.keys().subs || [];
      for (const k of aud.keys) if (!subs.some(sub => subPrincipal(sub, aud.def) === k)) pushMissed.note(k);
    }
  }
  for (const s of all) wasRunning.set(s.id, !!s.running);
}

let lastDecor = { key: '', all: null };
async function noticeAccountSwitch() {
  try {
    const change = accountScope.note(accountScope.activeScope());
    if (!change || !change.changed) return;
    // The text comes from the settings that govern account sync, and with the Accounts module off
    // no question is raised at all: nothing could act on "carry the chats over".
    const label = (sc) => { const [a, o] = String(sc).split('/'); return accountScope.labelFor(a, o) || a.slice(0, 8); };
    const words = alerts.accountSwitchText(config.get(), { to: label(change.to), from: label(change.from) });
    let q = null;
    if (words.ask) {
      q = accountScope.raise(change);
      if (!q || q.answer) return;
    }
    const to = q ? (q.toAccount || String(q.to).split('/')[0].slice(0, 8)) : label(change.to);
    const from = q ? (q.fromAccount || String(q.from).split('/')[0].slice(0, 8)) : label(change.from);
    log(`account switch: ${from} -> ${to}; ${q ? 'asked, nothing acted' : 'Accounts module off: told, not asked'}`);
    const evt = {
      id: 'account-switch',
      kind: q ? 'question' : 'info',
      title: 'You switched Claude account',
      body: alerts.accountSwitchText(config.get(), { to, from }).body,
      tag: 'account-switch',
      url: q ? '/?switch=1' : '/',
    };
    for (const c of clients) { if (!isSubuser(c.identity)) sseSend(c, 'alert', evt); }
    if (q) for (const c of clients) { if (!isSubuser(c.identity)) sseSend(c, 'accountswitch', q); }
    const ncfg = config.get().notifications || {};
    if (ncfg.enabled === false) { log('account switch: alerts are off; card is in the app only'); return; }
    logAlert('account switch', await alerts.deliver(evt, log));
  } catch (e) {
    log('account-switch check failed: ' + e.message);
  }
}

async function poll() {
  const _t0 = Date.now();
  try {
    await sessions.refresh();
    const _dR = Date.now() - _t0;
    if (_dR > 400) log(`poll: sessions.refresh took ${_dR}ms`);
    const snap = desktop.loadSnapshot();
    const decorKey = String(sessions.index().at) + '|' + String(snap && snap.at) + '|' + sessions.ackVersion();
    let all;
    if (lastDecor.all && lastDecor.key === decorKey) all = lastDecor.all;
    else { all = byAttention(sessions.decorate(sessions.index().list, snap)); lastDecor = { key: decorKey, all }; }

    const _tN = Date.now();
    await notifyAttention(all);
    const _dN = Date.now() - _tN;
    if (_dN > 400) log(`poll: notifyAttention took ${_dN}ms`);
    await noticeAccountSwitch();
    if (!clients.size) return;

    const key = listKey(all);
    if (key !== lastListKey) {
      lastListKey = key;
      // g1940 (Ashwar 14-Oct: "sagar relaymopte was showing all sessions instead of his sesion or sessions he
      // started or invoked"): this push replaced Sagar's filtered list with everyone's on the first change. Each
      // stream now gets the list its principal sees (/api/sessions' view), Ashwar's rows keep their `by` marks.
      const live = all.filter(s => !s.archived);
      const touch = require('./principal-touch');
      try { touch.refresh(board.CONDUCTOR_DIR, (id) => sessions.transcriptPath(sessions.get(id))); } catch (e) { log('principal touch scan failed: ' + e.message); }
      const byKey = new Map();
      for (const c of clients) {
        const base = isSubuser(c.identity) ? live.filter(s => c.identity.sessions.has(s.id)) : live;
        const k = (isSubuser(c.identity) ? 'sub:' + c.client : 'p:') + ((c.principal && c.principal.key) || '');
        let payload = byKey.get(k);
        if (!payload) {
          let seen = base;
          try { seen = touch.view(base, c.principal, board.CONDUCTOR_DIR); } catch (e) { if (c.principal && c.principal.own) seen = []; }
          payload = seen.slice(0, 80).map(slimSession);
          byKey.set(k, payload);
        }
        sseSend(c, 'sessions', { sessions: payload });
      }
    }
    try {
      const pend = outbox.pending();
      if (pend.length) {
        let moved = false;
        for (const sid of new Set(pend.map(e => e.session))) {
          const sess = sessions.get(sid);
          const stamp = sess ? String(sessions.transcriptStamp(sess) || '') : '';
          if (obStamps.get(sid) !== stamp) { obStamps.set(sid, stamp); if (stamp) moved = true; }
        }
        if (moved) outboxTick().catch(() => {});
      } else if (obStamps.size) obStamps.clear();
    } catch {}
    const watchers = new Map();
    for (const c of clients) {
      if (!c.watch) continue;
      if (!watchers.has(c.watch)) watchers.set(c.watch, []);
      watchers.get(c.watch).push(c);
    }
    for (const [wid, cs] of watchers) {
      const sess = sessions.get(wid);
      if (!sess) continue;
      const stamp = sessions.transcriptStamp(sess);
      if (!stamp) continue;
      const stale = cs.filter(c => c.stamp !== stamp);
      if (!stale.length) continue;
      const tr = sessions.transcript(sess, { limit: 60 });
      const pq = sessions.pendingQuestion(sess);
      const dec = all.find(s => s.id === wid);
      // startByte/hasMore let the client keep its paging state true when it keeps the tail alone.
      const payload = { id: wid, messages: tr.messages, startByte: tr.startByte, hasMore: tr.hasMore, pendingQuestion: pq || null, meta: dec ? slimSession(dec) : null };
      for (const c of stale) { c.stamp = stamp; sseSend(c, 'messages', payload); }
    }
  } catch (e) { log('poll error: ' + e.message); }
  const _dT = Date.now() - _t0;
  if (_dT > 800) log(`poll: TOTAL ${_dT}ms (clients=${clients.size})`);
}

const FAST_MS = 2500, SLOW_MS = 20000;
let pollRate = 0;
let polling = false;

function ensurePoll() {
  const want = clients.size ? FAST_MS : SLOW_MS;
  if (pollTimer && pollRate === want) return;
  if (pollTimer) clearInterval(pollTimer);
  pollRate = want;
  pollTimer = setInterval(() => {
    if (polling) return;
    polling = true;
    poll().catch(() => {}).finally(() => { polling = false; });
  }, want);
  if (pollTimer.unref) pollTimer.unref();
}
const maybeStopPoll = ensurePoll;

const EFFORT_ALIAS = { xhigh: 'extra' };
const normEffort = (e) => (e ? (EFFORT_ALIAS[e] || e) : null);

// g1133: Desktop takes an effort change at once but writes it to the session file this index reads
// seconds later, so the header kept the OLD effort and the picker snapped back to it when its hold
// ran out. A change confirmed by Desktop's own getSession is laid over the file until the file agrees
// (or 10 minutes pass).
const effortOverlay = new Map();   // sessionId -> { effort (phone label), at }
function effortFor(s) {
  const o = effortOverlay.get(s.id);
  const file = normEffort(s.effort);
  if (!o) return file;
  if (file === o.effort || Date.now() - o.at > 10 * 60000) { effortOverlay.delete(s.id); return file; }
  return o.effort;
}

function slimSession(s) {
  return {
    id: s.id, title: s.title, cwd: s.cwd, folder: s.cwd ? path.basename(s.cwd) : null,
    model: s.model, effort: effortFor(s), dot: s.dot, group: s.group,
    suggestion: s.suggestion || null,
    running: s.running, awaiting: s.awaiting, unread: s.unread, active: s.active,
    live: s.live, archived: s.archived, at: s.lastActivityAt, turns: s.turns,
    stalled: !!s.stalled, quietFor: s.quietFor || 0,
    by: s.by || undefined, othersOnly: s.othersOnly || undefined, api: s.api || undefined,
  };
}

const ui = (fn) => desktop.serializeUi(fn);

let cdpAt = 0, cdpVal = false;
const MODELS_FILE = path.join(require('../lib/config').STATE, 'models.json');
let modelsVal = null, modelsAt = 0, modelsRefreshing = false;
let modelIdsVal = {};   // picker label -> model id ("Sonnet 5.5" -> "claude-sonnet-5-5"), for New session
try {
  const j = JSON.parse(fs.readFileSync(MODELS_FILE, 'utf8'));
  if (j.ids && typeof j.ids === 'object') modelIdsVal = Object.fromEntries(Object.entries(j.ids).map(([k, v]) => [desktop.cleanModelName(k), v]));
  // A list saved before 0.2.39 can carry the picker's badge glyph ("Sonnet 5.5\uE08F"); one saved by 0.2.114
  // and earlier, badge words and the Effort radios ("Sonnet 5.5Preset", "Low", "MediumRecommended").
  if (Array.isArray(j.models) && j.models.length) {
    modelsVal = desktop.cleanModelList(j.models).map(m => m.name);
    modelsAt = modelsVal.length === j.models.length ? (j.at || 0) : 0;   // it was polluted: re-read the picker soon
  }
} catch {}

function refreshModelsSoon(ttl) {
  if (modelsRefreshing || (modelsVal && Date.now() - modelsAt < ttl)) return;
  modelsRefreshing = true;
  ui(() => desktop.listModels())
    .then(r => {
      if (r && r.ok && r.models && r.models.length) {
        modelsVal = r.models.map(m => m.name);
        modelIdsVal = Object.fromEntries(r.models.filter(m => m.id).map(m => [m.name, m.id]));
        modelsAt = Date.now();
        try { fs.writeFileSync(MODELS_FILE, JSON.stringify({ at: modelsAt, models: modelsVal, ids: modelIdsVal }, null, 1)); } catch {}
      }
    })
    .catch(() => {})
    .finally(() => { modelsRefreshing = false; });
}

function modelsCached(ttl = 10 * 60 * 1000) {
  refreshModelsSoon(ttl);
  return modelsVal || [];   // read live from the picker; never a hardcoded list of names
}

async function cdpCached(ttl = 4000) {
  if (Date.now() - cdpAt < ttl) return cdpVal;
  try { cdpVal = await desktop.cdpAvailable(); } catch { cdpVal = false; }
  cdpAt = Date.now();
  return cdpVal;
}

function deskNow() { deskState.note({ cdp: cdpVal }); return deskState.get(); }
// g1638: "shud restart if app opened". Opening the app (bootstrap / list) or sending while the link is down
// reopens Claude Desktop in this Windows session (desktop-state.js wake: single-flight, 90 s apart).
function wakeDesktop(why) {
  if (cdpVal !== false) return;
  deskState.wake({ why, log }).catch(() => {});
  if (deskState.onAppOpen) deskState.onAppOpen();   // Desktop up but link off: switch it on now (g1662)
}

// g1588: the phone keeps its own outbox and re-sends until the PC says the message reached Claude. A
// re-send of the same message (same cmid: the answer to the first try was lost on the way back) must
// never type it twice: it joins the job still running, or gets the finished result back.
const CMIDS_FILE = path.join(config.STATE, 'send-cmids.json');
let cmids = null;
function cmidStore() {
  if (!cmids) { try { cmids = new Map(Object.entries(JSON.parse(fs.readFileSync(CMIDS_FILE, 'utf8')) || {})); } catch { cmids = new Map(); } }
  return cmids;
}
function cmidSave() {
  const m = cmidStore(), cut = Date.now() - 7 * 864e5;
  for (const [k, v] of m) if (v.at < cut) m.delete(k);
  while (m.size > 500) m.delete(m.keys().next().value);
  try { fs.writeFileSync(CMIDS_FILE, JSON.stringify(Object.fromEntries(m))); } catch (e) { log('send-cmids save: ' + e.message); }
}

const TRANSIENT_SEND = new Set(['nav-lost', 'blocked', 'no-editor', 'not-found']);

const sendJobs = new Map();

function uiJobWith(res, op, run, echo) {
  const jobId = crypto.randomBytes(6).toString('hex');
  const origin = res._agoClient || null;
  (async () => {
    let out;
    try { out = await run(); }
    catch (e) { out = { ok: false, error: e.message }; }
    const ok = !!(out && out.ok);
    const why = out
      ? [out.error || out.result, out.message].filter(Boolean).join(': ')
      : 'no response from the desktop app';
    if (!ok) log(`${op} ${jobId} failed: ${why}`);
    for (const c of recipients(origin)) {
      sseSend(c, 'uiresult', {
        jobId, op, ok,
        error: ok ? null : String(why),
        ...(typeof echo === 'function' ? (echo(out) || {}) : (echo || {})),
      });
    }
  })().catch(e => log(`${op} ${jobId} crashed: ` + e.message));
  return json(res, 202, { ok: true, pending: true, jobId });
}

function withHoldingContext(id, out) {
  if (!out || out.result !== 'no-queued-message') return out || null;
  let held = null;
  try {
    held = outbox.pending().find(e => e.session === id && e.state === 'pending') || null;
  } catch { }
  if (!held) return out;
  const mins = Math.round((Date.now() - held.at) / 60000);
  return {
    ...out,
    result: 'held-no-control',
    holding: { outboxId: held.id, ageMs: Date.now() - held.at },
    message: 'That message has NOT been lost — the desktop is still holding it' +
             (mins >= 1 ? ` (${mins}m)` : '') + ' and will hand it over the moment this turn ends. ' +
             'It is offering no "Send now" for it, so there is nothing to press; you do not need to send it again.',
  };
}

const uiJob = (res, op, fn, echo) => uiJobWith(res, op, () => ui(fn), echo);

function finishSend(job, out) {
  sendJobs.delete(job.id);
  if (job.cmid) {
    cmidStore().set(job.cmid, { jobId: job.id, at: job.at, done: true, ok: !!(out && out.ok),
      result: { jobId: job.id, id: job.session, ok: !!(out && out.ok), error: out && out.ok ? null : String((out && (out.result || out.error)) || 'no response from the desktop app'),
                delivery: (out && out.delivery) || null, confirmed: !!(out && out.confirmed), outboxId: (out && out.outboxId) || null } });
    cmidSave();
  }
  setTimeout(() => { outboxTick().catch(() => {}); }, 4000);
  setTimeout(() => { outboxTick().catch(() => {}); }, 15000);
  const ok = !!(out && out.ok);
  const reason = (out && (out.result || out.error)) || 'no response from the desktop app';
  if (!ok) log(`send ${job.id} failed: ${reason}`);
  for (const c of recipients(job.origin || null)) {
    sseSend(c, 'sendresult', {
      jobId: job.id, id: job.session, ok, cmid: job.cmid || null,
      error: ok ? null : String(reason),
      attempts: out && out.attempts,
      delivery: (out && out.delivery) || null,
      confirmed: !!(out && out.confirmed),
      outboxId: (out && out.outboxId) || null,
      held: !!(ok && out && out.delivery === 'held' && out.uuid),
      text: (!ok || !(out && out.confirmed)) ? job.text : undefined
    });
  }
}

// Test seam (demo instances only). '1': every send is written straight into the transcript. 'drop-first': the
// FIRST send is accepted and then lost, as when Desktop crashes after taking it; later sends (the re-delivery) land.
// 'drop-all': every send and re-delivery is lost (the NOT delivered path).
const FAKE_SEND = process.env.RELAYMOTE_FAKE_SEND || '';
let fakeDropped = false;
function fakeWrite(id, body) {
  const s = sessions.index().list.find(x => x.id === id);
  const tp = s && sessions.transcriptPath(s);
  const at = new Date().toISOString();
  if (tp) fs.appendFileSync(tp, JSON.stringify({ type: 'user', timestamp: at, uuid: crypto.randomUUID(), message: { role: 'user', content: body } }) + '\n');
  fs.appendFileSync(path.join(config.STATE, 'fake-sends.jsonl'), JSON.stringify({ at, session: id, text: body }) + '\n');
}
/** Re-deliver an outbox entry: the bridge under its own uuid when it had one, else the composer. */
async function redeliver(e, text) {
  if (FAKE_SEND) { if (FAKE_SEND !== 'drop-all') fakeWrite(e.session, text); return { ok: true }; }
  if (e.uuid) return ui(() => desktop.sendQueued(e.session, text, { uuid: e.uuid }));
  return ui(() => desktop.sendMessage(e.session, text, { queue: true }));
}

async function doSend(id, text, attachments, { noUi = false } = {}) {
  let body = String(text || '');
  if (Array.isArray(attachments) && attachments.length) {
    body = attachments.map(a => '@' + a).join('\n') + (body ? '\n' + body : '');
  }
  if (!body.trim()) return { ok: false, error: 'EMPTY' };
  // Test seam (demo instances only): "deliver" by writing his message into the demo transcript and a
  // log, so the phone's outbox can be shown end to end with no Claude Desktop behind it.
  if (FAKE_SEND === '1') { fakeWrite(id, body); return { ok: true, confirmed: true, delivery: 'sent' }; }
  if (FAKE_SEND === 'drop-first' || FAKE_SEND === 'drop-all') {   // drop-all: the re-delivery is lost too
    const slip0 = outbox.add({ session: id, text: body });
    if (fakeDropped) fakeWrite(id, body); else fakeDropped = true;
    if (slip0) outbox.markSent(slip0.id, { ok: true, delivery: 'generating' });
    log(`send ${slip0 ? slip0.id : '?'} -> sent via fake (generating)`);
    return { ok: true, delivery: 'generating', outboxId: slip0 && slip0.id };
  }

  const slip = outbox.add({ session: id, text: body });

  // Attachments travel as "@<path>" lines in the text (the composer delivers them the same way), so a
  // message with attachments takes the bridge too and gets a handle for Send now and ×.
  {
    let live = null;
    try { live = await desktop.readAppliedModel(id); } catch { live = null; }
    if (live && live.ok && live.running) {
      const r = await desktop.sendQueued(id, body);
      if (r.ok) {
        if (slip) { outbox.setUuid(slip.id, r.uuid); outbox.markSent(slip.id, { ok: true, delivery: r.delivery }); }
        log(`send ${slip ? slip.id : '?'} -> held via bridge (uuid ${String(r.uuid).slice(0, 8)}) -- session was running`);
        return { ok: true, delivery: r.delivery, transport: 'bridge', uuid: r.uuid, attempts: 1, outboxId: slip && slip.id };
      }
      log(`send ${slip ? slip.id : '?'}: bridge send refused (${r.error}${r.detail ? ': ' + r.detail : ''}); using the composer`);
    }
  }

  const startedAt = Date.now();
  const landed = async () => {
    try {
      await sessions.refresh();
      const sess = sessions.get(id);
      if (!sess) return false;
      const tr = sessions.transcript(sess, { limit: 14 });
      const needle = body.trim().slice(0, 60);
      if (!needle) return false;
      return (tr.messages || []).some(m => {
        if (m.role !== 'user' && !m.queued) return false;
        const t = String(m.text || '');
        if (!t.includes(needle)) return false;
        if (/^\s*Another Claude session sent a message|^\s*<cross-session-message/i.test(t)) return false;
        const ts = Date.parse(m.ts || '');
        return !ts || ts >= startedAt - 5000;
      });
    } catch { return false; }
  };

  let last = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // Another principal's message goes through the app's own channel only, never the composer, which opens the
      // session in Ashwar's window (22-Oct). A refusal stays in that phone's outbox and is retried.
      last = await ui(() => desktop.sendMessage(id, body, { queue: true, backgroundOnly: noUi }));
    } catch (e) {
      const why = String((e && e.message) || 'threw');
      log(`send attempt ${attempt} threw: ${why}`);
      await new Promise(r => setTimeout(r, 1500));
      if (await landed()) {
        if (slip) outbox.markSent(slip.id, { ok: true, delivery: 'generating', proven: true });
        return { ok: true, recoveredAfter: why, attempts: attempt, outboxId: slip && slip.id };
      }
      if (!/timeout/i.test(why)) {
        if (slip) outbox.markSent(slip.id, { ok: false, error: why });
        return { ok: false, error: why, outboxId: slip && slip.id };
      }
      last = { ok: false, error: why };
      await new Promise(r => setTimeout(r, 900 * attempt));
      continue;
    }
    if (last && last.ok) {
      if (slip) outbox.markSent(slip.id, { ok: true, delivery: last.delivery || 'accepted' });
      log(`send ${slip ? slip.id : '?'} -> ${last.result || 'ok'} via ${last.transport || 'composer'}` +
          `${last.delivery ? ' (' + last.delivery + ')' : ''}`);
      return { ...last, attempts: attempt, outboxId: slip && slip.id };
    }
    const why = String((last && (last.result || last.error)) || '');
    if (!TRANSIENT_SEND.has(why)) {
      if (slip) outbox.markSent(slip.id, { ok: false, error: why });
      return { ...last, outboxId: slip && slip.id };
    }
    log(`send attempt ${attempt} -> ${why}; retrying`);
    await new Promise(r => setTimeout(r, 900 * attempt));
  }
  if (slip) outbox.markSent(slip.id, { ok: false, error: (last && (last.result || last.error)) || 'exhausted' });
  return { ...(last || {}), attempts: 3, exhausted: true, outboxId: slip && slip.id };
}

async function runningTaskCount(sessionId) {
  const conn = await desktop.connect(await desktop.wsUrl());
  let CID, original = null;
  try {
    CID = await desktop.pickChat(conn);
    const before = String(await conn.evaluate(desktop.rEval(CID, `location.href.split('/').pop()`)));
    original = before.startsWith('local_') ? before : null;
    if (sessionId && before !== sessionId) {
      const found = await desktop.findSessionRow(conn, CID, sessionId);
      if (!found.row) return null;
      if (!(await desktop.navTo(conn, CID, sessionId))) return null;
    }
    const out = await conn.evaluate(desktop.rEval(CID, `(function(){
      function clean(e){ return (e&&e.textContent||'').replace(/[\u200b-‍﻿­⁠-]/g,'').trim(); }
      var hit = Array.from(document.querySelectorAll('button,[role=button]')).filter(function(e){
        if (e.offsetParent === null) return false;
        var t = clean(e).toLowerCase();
        return t.indexOf('running task') > 0 && parseInt(t, 10) > 0;
      })[0];
      return hit ? String(parseInt(clean(hit), 10)) : '0';
    })()`));
    return Number(out);
  } catch { return null; }
  finally {
    try { if (original) await desktop.restoreActive(conn, CID, original); } catch {}
    conn.close();
  }
}

async function handle(req, res) {
  const _h0 = Date.now();
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = url.pathname;
  res._agoClient = clientIdOf(req);
  res.on('finish', () => { const d = Date.now() - _h0; if (d > 700) log(`slow ${p} ${d}ms (auth ${_hAuth}ms)`); });
  let _hAuth = 0;

  // Android's share sheet POSTs to /share-target; the service worker keeps the files and never lets it reach
  // here. Only a phone whose worker is not running yet gets this far (and its cookie may not come along on a
  // POST from another app): send it home, reading nothing, and the app asks for the share again.
  if (p === '/share-target') { res.writeHead(303, { Location: '/?share=missed', 'Cache-Control': 'no-store' }); return res.end(); }

  const open = p === '/sw.js' || p === '/manifest.webmanifest' ||
               /^\/(icon|badge)(-\d+)?\.(svg|png)$/.test(p);

  const _a0 = Date.now();
  let identity = open ? null : await resolveIdentity(req, url);
  _hAuth = Date.now() - _a0;
  if (identity && identity.kind === 'reauth') {
    const secure = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https' || !!req.headers['cf-ray'];
    if (p === '/reauth/start' && req.method === 'POST') {
      // His Continue tap, sent while the popup ends the team-wide Access session: from here a new Access login
      // (which will ask for the code) earns the sub-session.
      const out = accessLogout(secure);
      log(`access: ${identity.email} (${identity.principal}) started a fresh sign-in`);
      res.writeHead(204, { 'Set-Cookie': [...out.cookies, signedCookie('baton_otp', 'otp', identity.email, OTP_WINDOW_S, secure)], 'Cache-Control': 'no-store' });
      return res.end();
    }
    if (identity.pending) {
      // Back from Access logout with a new Access login: the OTP was asked. Start the sub-session.
      res.setHeader('Set-Cookie', signedCookie('baton_ss', 'ss', identity.email, SUB_SESSION_H() * 3600, secure));
      log(`access: ${identity.email} (${identity.principal}) signed in again; sub-session ${SUB_SESSION_H()} h`);
      identity = scopedPrincipal(identity.principal, identity.email);
    } else {
      const page = req.method === 'GET' && (p === '/' || p === '/board' || p === '/board.html' || /text\/html/.test(String(req.headers.accept || '')));
      log(`access: ${identity.email} (${identity.principal}) has no Baton sub-session; ${page ? 'shown the sign-in-again page' : 'refused (401)'}`);
      if (page) {
        res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(reauthPage(accessLogout(secure).location, identity.email, false, '/reauth/start'));
      }
      // No pending mark here: only the Continue tap on the sign-in-again page may earn the sub-session.
      return json(res, 401, { ok: false, error: 'SIGN_IN_AGAIN', message: 'Sign in again: reload the page and enter the code Cloudflare emails you.' });
    }
  }
  // The menu's Log out: Baton's cookies, Access's cookies, the app's cache and service worker, then the team-wide
  // Access session. The next visit asks for the emailed code (27-Oct: "I cannot understand the logout option").
  if (p === '/logout' && req.method !== 'POST') {
    const secure = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https' || !!req.headers['cf-ray'];
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(reauthPage(accessLogout(secure).location, null, true, '/logout'));
  }
  if (p === '/logout') {
    const secure = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https' || !!req.headers['cf-ray'];
    const out = accessLogout(secure);
    const id = access.tokenFrom(req) ? await access.identify(req).catch(() => null) : null;
    // A staff login coming back after this has already been through logout: one code, not two.
    if (id && id.email) out.cookies.push(signedCookie('baton_otp', 'otp', id.email, OTP_WINDOW_S, secure));
    log(`access: ${(id && id.email) || (identity && identity.kind) || 'anonymous'} logged out`);
    res.writeHead(204, { 'Set-Cookie': out.cookies, 'Clear-Site-Data': '"cache", "storage"', 'Cache-Control': 'no-store' });
    return res.end();
  }
  if (identity && identity.renewSS) {
    const secure = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https' || !!req.headers['cf-ray'];
    res.appendHeader('Set-Cookie', signedCookie('baton_ss', 'ss', identity.email, SUB_SESSION_H() * 3600, secure));
  }
  res._agoIdentity = identity;
  req._identity = identity;
  if (!open && !identity) {
    if (p === '/') {
      const viaTunnel = !!(req.headers['cf-ray'] || req.headers['cf-access-jwt-assertion']);
      // g1588: a phone that is not paired gets a screen it can pair itself from, not one grey sentence.
      if (!viaTunnel) {
        res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(require('./pairing-page').pairingPage());
      }
      const msg = viaTunnel
        ? 'Signed in with Cloudflare Access, but the assertion could not be verified. ' +
          'Check RELAYMOTE_ACCESS_AUD and RELAYMOTE_ACCESS_TEAM, then reload.'
        : 'This address is not behind Cloudflare Access, so it needs the access key. ' +
          'Open Relaymote on your computer and scan the pairing QR code, or run <code>relaymote pair</code>.';
      res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<meta name=viewport content="width=device-width,initial-scale=1">' +
        '<body style="font:16px/1.6 system-ui;padding:2rem;background:#12110f;color:#e8e6e1">' +
        '<h2 style="margin:0 0 .6rem">Relaymote</h2><p style="color:#9b958c">' + msg + '</p></body>');
    }
    return json(res, 401, { error: 'unauthorized' });
  }

  if ((p === '/' || p === '/board' || p === '/board.html') && url.searchParams.get('k') && identity) {
    const https_ = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
    const rest = new URLSearchParams(url.searchParams);
    rest.delete('k');
    const qs = rest.toString();
    res.writeHead(302, {
      'Set-Cookie': `baton_m=${encodeURIComponent(url.searchParams.get('k'))}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000` +
                    (https_ ? '; Secure' : ''),
      Location: p + (qs ? '?' + qs : ''),
    });
    return res.end();
  }

  if (p === '/') return serveStatic(res, '/index.html', url.searchParams);
  if (p === '/board' || p === '/board.html') {
    const bp = (config.get().board && config.get().board.html) || path.join(config.DATA, 'board.html');
    try {
      const html = fs.readFileSync(bp);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    } catch (e) {
      return json(res, 404, { ok: false, error: 'board not built yet (' + e.code + ') at ' + bp });
    }
  }

  if (!p.startsWith('/api/')) return serveStatic(res, p, url.searchParams);

  if (isSubuser(identity)) {
    const READ_OK = p === '/api/bootstrap' || p === '/api/sessions' || p === '/api/file' || p === '/api/sent-file' || p === '/api/tier' ||
                    p === '/api/permission' || p === '/api/build' || p === '/api/stream' ||
                    // a scoped principal (Ajay) has his own board: narrowed to his rows, taps go to his Conductor
                    // a scoped principal (Ajay) also reads his chats and his own board (narrowed to his rows; taps go to
                    // his Conductor). Every per-session read is checked against his live set just below.
                    (identity.principal && (p === '/api/board' || p === '/api/board/needs' || p.startsWith('/api/session/') ||
                                            p === '/api/chips' || p === '/api/chips/all'));   // never the seen/mark-read routes: unread dots are shared with Ashwar
    const WRITE_OK = req.method === 'POST' && (
      p === '/api/send' || p === '/api/model' || p === '/api/effort' ||
      p === '/api/answer' || p === '/api/permission/answer' ||
      p === '/api/queued/cancel' || p === '/api/queued/send-now' ||
      (identity.principal && (p === '/api/board/act' || p === '/api/board/act-batch' || p === '/api/upload' || p === '/api/attach')));
    if (!READ_OK && !WRITE_OK) {
      return json(res, 403, { ok: false, error: 'NOT_AVAILABLE',
        message: 'This account is scoped to specific sessions and cannot use that.' });
    }
    const sid = p.startsWith('/api/session/') ? decodeURIComponent(p.slice('/api/session/'.length))
      : (url.searchParams.get('id') || url.searchParams.get('session'));
    if (sid && !identity.sessions.has(sid)) {
      return json(res, 403, { ok: false, error: 'NOT_GRANTED', message: 'That session is not shared with you.' });
    }
  }

  if ((p === '/api/board' || p.startsWith('/api/board/')) && !config.mod('board')) return json(res, 404, { ok: false, error: 'module disabled', module: 'board' });
  if (p.startsWith('/api/routines') && !config.mod('routines')) return json(res, 404, { ok: false, error: 'module disabled', module: 'routines' });
  if ((p === '/api/accounts' || p.startsWith('/api/accounts/')) && !config.mod('accounts')) return json(res, 404, { ok: false, error: 'module disabled', module: 'accounts' });
  if ((p === '/api/accounts' || p.startsWith('/api/accounts/')) && !isOwner(identity)) return json(res, 403, { ok: false, error: 'OWNER_ONLY' });

  if (p === '/api/bootstrap') {
    await cdpCached(); wakeDesktop('app opened');
    noteClientBuild(res._agoClient, url.searchParams.get('build'));
    await sessions.refresh();
    const all = principalList(req, url, visibleSessions(identity, sessions.decorate(sessions.index().list, desktop.loadSnapshot())));
    return json(res, 200, {
      ok: true,
      host: os.hostname(),
      principal: (identity && identity.principal) || null,   // a scoped login (Ajay): the app follows the server
      principalHome: (identity && identity.principal && principalOf(req, url).conductor) || null,
      folders: isSubuser(identity) ? [] : sessions.folders(all).slice(0, 40),
      counts: {
        total: all.length,
        active: all.filter(s => !s.archived).length,
        running: all.filter(s => s.running).length,
        awaiting: all.filter(s => s.awaiting).length,
      },
      summary: isSubuser(identity) ? undefined : orch.summary(),
      cdp: await cdpCached(),
      desktop: deskNow(),
      vapid: push.publicKey(),
      // 24-Oct: whether THIS phone's person has any phone subscribed, and how many of their alerts found none.
      pushFor: (() => {
        try {
          const pr = principalOf(req, url), def = require('./principals').resolve(board.CONDUCTOR_DIR, '').key;
          const subscribed = (push.keys().subs || []).some(sub => subPrincipal(sub, def) === pr.key);
          return { principal: pr.key, subscribed, missed: pushMissed.get(pr.key) };
        } catch { return null; }
      })(),
      models: modelsCached(),
      efforts: Object.keys(desktop.EFFORT_VALUES || { low: 1, medium: 1, high: 1, xhigh: 1 }),
      startDefaults: newSessionDefaults(),
      build: assetVersion(),
      buildAgeMs: assetVer.since ? Date.now() - assetVer.since : null,
      version: APP_VERSION,
    });
  }

  if (p === '/api/build') return json(res, 200, { ok: true, ...clientBuildReport() });

  if (p === '/api/sessions') {
    await cdpCached(); wakeDesktop('app open');
    await sessions.refresh();
    const all = principalList(req, url, visibleSessions(identity, sessions.decorate(sessions.index().list, desktop.loadSnapshot())));
    warmRecent(all);
    const folder = url.searchParams.get('folder');
    const q = (url.searchParams.get('q') || '').toLowerCase();
    const wantArchived = url.searchParams.get('archived') === '1';
    const limit = Math.min(Number(url.searchParams.get('limit') || 60), 300);
    let out = all.filter(s => !!s.archived === wantArchived);
    if (folder) out = out.filter(s => s.cwd === folder);
    if (q) out = out.filter(s => (s.title || '').toLowerCase().includes(q) || (s.cwd || '').toLowerCase().includes(q));
    out = byAttention(out);
    const snap = desktop.loadSnapshot() || {};
    return json(res, 200, {
      ok: true, total: out.length,
      cdp: await cdpCached(),
      desktop: deskNow(),
      snapshotAt: snap.at || null,
      build: assetVersion(),
      buildAgeMs: assetVer.since ? Date.now() - assetVer.since : null,
      version: APP_VERSION,
      blocker: snap.blocker || null,
      sessions: out.slice(0, limit).map(slimSession),
    });
  }

  if (p === '/api/file') {
    await sessions.refresh();
    const sid = url.searchParams.get('session');
    if (isSubuser(identity)) {
      if (!sid || !identity.sessions.has(sid)) {
        return json(res, 403, { ok: false, error: 'NOT_GRANTED', message: 'That session is not shared with you.' });
      }
    }
    const sess = sid ? sessions.get(sid) : null;
    const roots = isSubuser(identity)
      ? [sess && sess.cwd].filter(Boolean)
      : [...new Set(sessions.index().list.map(x => x.cwd).filter(Boolean))].concat([UPLOADS, path.join(os.homedir(), '.claude')]);
    const raw = url.searchParams.get('raw') === '1';
    const out = readFile(url.searchParams.get('path'), { roots, cwd: sess && sess.cwd, siblings: !isSubuser(identity),
                                                          home: isSubuser(identity) ? null : os.homedir(), resolveOnly: raw });
    // raw=1: the file's own bytes (a PDF, xlsx or image a reply named), for the viewer, Download and
    // Share. Same scope and secret checks as the JSON read; HTML and SVG stream sandboxed.
    if (raw && out.ok && out.kind === 'file') {
      log('file raw: ' + path.basename(out.path));
      return sentfiles.stream(req, res, out.path, out.bytes, out.mtimeMs,
                              { name: path.basename(out.path), download: url.searchParams.get('dl') === '1' });
    }
    // One line per open, so "a link did not open on the phone" can be answered from evidence.
    log('file ' + (out.ok ? 'ok' : (out.error || 'fail')) + ': ' + path.basename(String(url.searchParams.get('path') || '')));
    return json(res, out.ok ? 200 : 404, out);
  }

  // Stream a file the session SENT (SendUserFile): audio/video with Range, images, pdf, html.
  // The allowlist is the session's own transcript, so this reaches nothing the session did not hand
  // the user; a sub-user additionally needs the session granted, exactly as /api/file.
  if (p === '/api/sent-file') {
    const sid = url.searchParams.get('session');
    const want = url.searchParams.get('path');
    if (!sid || !want) return json(res, 400, { ok: false, error: 'session and path required' });
    if (isSubuser(identity) && !identity.sessions.has(sid)) {
      return json(res, 403, { ok: false, error: 'NOT_GRANTED', message: 'That session is not shared with you.' });
    }
    await sessions.refresh();
    const tr = sessions.transcriptPath(sessions.get(sid));
    if (!tr) return json(res, 404, { ok: false, error: 'NO_TRANSCRIPT' });
    const sent = await sentfiles.sentFiles(tr);
    const file = sentfiles.norm(want);
    if (!sent.has(file)) return json(res, 403, { ok: false, error: 'NOT_SENT', message: 'This session did not send that file.' });
    let st; try { st = await fs.promises.stat(file); } catch { st = null; }
    if (!st || !st.isFile()) return json(res, 404, { ok: false, error: 'GONE', message: 'The file is no longer on the desktop.' });
    return sentfiles.stream(req, res, file, st.size, st.mtimeMs,
                            { name: path.basename(String(want)), download: url.searchParams.get('dl') === '1' });
  }

  if (p === '/api/tts-audio') {
    const file = tts.fileOf(url.searchParams.get('a'));
    let st; try { st = file && fs.statSync(file); } catch { st = null; }
    if (!st || !st.isFile()) return json(res, 404, { ok: false, error: 'GONE', message: 'That audio is no longer cached.' });
    return sentfiles.stream(req, res, file, st.size);
  }

  if (p === '/api/permission') {
    const id = url.searchParams.get('id');
    if (!id) return json(res, 400, { ok: false, error: 'id required' });
    if (isSubuser(identity) && !identity.sessions.has(id)) {
      return json(res, 403, { ok: false, error: 'NOT_GRANTED', message: 'That session is not shared with you.' });
    }
    // 26-Oct (Ashwar: "while i am typing here my window switches to ajay conductor while he uses relaymote"): a phone
    // looking at an awaiting session asked for this, and readPermission CLICKED that session open on the PC -- no idle
    // check, no principal check, no restore. Now the PC view is only read where it already is unless the owner asks,
    // the PC is idle, and the transcript really ends on a tool call waiting for approval; then it is put back.
    const busy = windowBusy(req, url);
    try { await sessions.refresh(); } catch {}
    const sess = sessions.get(id);
    let waitsTool = null;
    try { waitsTool = sess ? pendingApproval(sessions.transcriptPath(sess)) : null; } catch {}
    if (busy || !waitsTool) {
      return uiJobWith(res, 'permission', () => ui(() => peekPermission()),
                       (out) => ({ id, permission: out && out.ok && out.present && out.here === id ? out : null,
                                   notOpened: busy || (waitsTool ? null : 'nothing waits for approval') }));
    }
    return uiJobWith(res, 'permission', () => ui(() => readPermission(id, { restore: true })),
                     (out) => ({ id, permission: out && out.ok ? out : null }));
  }

  if (p === '/api/fast' && req.method !== 'POST') {
    try {
      const all = await desktop.readFastModeAll();
      if (!all.ok) return json(res, 200, all);
      await sessions.refresh();
      const when = new Map((sessions.index().list || []).map(s => [s.id, s.lastActivityAt || 0]));
      const rows = Object.entries(all.byId)
        .map(([id, d]) => Object.assign({ sessionId: id, at: when.get(id) || 0 }, d))
        .sort((a, b) => b.at - a.at);
      if (!rows.length) {
        return json(res, 200, {
          ok: true, scope: 'global', loaded: false, on: false, blocked: false,
          loadedCount: 0, total: all.total,
          message: 'No session has a live process right now, so Claude Desktop cannot report fast mode. Open any session and it will.',
        });
      }
      const best = rows[0];
      const agree = rows.filter(r => r.fastMode === best.fastMode).length;
      return json(res, 200, Object.assign({ ok: true, scope: 'global' }, best, {
        basedOn: best.sessionId,
        loadedCount: all.loadedCount, total: all.total,
        agree, disagree: rows.length - agree,
      }));
    } catch (e) {
      return json(res, 200, { ok: false, error: 'READ_FAILED', message: e.message });
    }
  }

  if (p === '/api/account-switch' && req.method !== 'POST') {
    return json(res, 200, {
      ok: true,
      pending: accountScope.pending(),
      active: accountScope.activeScope(),
      ...(() => { const w = alerts.accountSwitchText(config.get()); return { note: w.note, transferToast: w.transferToast, accountsModule: w.moduleOn }; })(),
    });
  }

  if (p === '/api/tier') {
    const id = url.searchParams.get('id');
    if (!id) return json(res, 400, { ok: false, error: 'id required' });
    if (isSubuser(identity) && !identity.sessions.has(id)) {
      return json(res, 403, { ok: false, error: 'NOT_GRANTED', message: 'That session is not shared with you.' });
    }
    try { return json(res, 200, await desktop.readAppliedModel(id)); }
    catch (e) { return json(res, 200, { ok: false, error: 'READ_FAILED', message: e.message }); }
  }

  if (p === '/api/models') {
    if (url.searchParams.get('refresh') === '1') { modelsAt = 0; }
    return json(res, 200, { ok: true, models: modelsCached() });
  }

  if (p === '/api/routines') {
    await sessions.refresh();
    const all = sessions.decorate(sessions.index().list, desktop.loadSnapshot());
    return json(res, 200, routines.list(all));
  }
  if (p === '/api/routines/prompt') {
    const id = url.searchParams.get('id');
    if (!id) return json(res, 400, { ok: false, error: 'id required' });
    return json(res, 200, routines.prompt(id));
  }
  if (p === '/api/routines/meta' && req.method === 'POST') {
    let body = '';
    for await (const c of req) body += c;
    let meta; try { meta = JSON.parse(body); } catch { return json(res, 400, { ok: false, error: 'bad json' }); }
    if (!meta || typeof meta.tasks !== 'object') return json(res, 400, { ok: false, error: 'tasks object required' });
    meta.at = new Date().toISOString();
    routines.saveMeta(meta);
    return json(res, 200, { ok: true, at: meta.at, count: Object.keys(meta.tasks).length });
  }

  // g1870: the principals a phone can belong to (Settings › This phone; a ?as= link). Names and Conductor ids only.
  if (p === '/api/principals') {
    try { return json(res, 200, { ok: true, principals: require('./principals').list(board.CONDUCTOR_DIR) }); }
    catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }
  if (p === '/api/board' || p === '/api/board/needs') {
    // g1885: the rebuild (inbox upkeep + compose + HTML, ~2.1 s) used to run INSIDE the request every minute.
    // It now runs after the answer has gone, so it only freshens the next open.
    const t0 = Date.now();
    let built = 0;
    res.once('finish', () => {
      // Every open is measured on the phone's own path: bytes sent, our build, and until the last byte left
      // (through the tunnel, so a slow link shows here).
      log(`[board] ${p === '/api/board' ? 'full' : 'needs'} ${Math.round((Number(res.getHeader('Content-Length')) || 0) / 1024)} KB in ${Date.now() - t0}ms (build ${built}ms)`);
      setTimeout(() => { require('../lib/board-build').maybeBuild(60000).catch(e => log('board build failed: ' + e.message)); }, 50);
    });
    try {
      try { await sessions.refresh(); } catch {}
      const as = (identity && identity.principal) || url.searchParams.get('as');
      const r = p === '/api/board' ? await board.viewCached({ as }) : await board.needs({ as, goal: url.searchParams.get('goal') });
      const body = r.body && r.body.ok ? Object.assign({}, p === '/api/board' ? board.phoneFull(r.body) : r.body, { bundle: assetVersion() }) : r.body;
      built = Date.now() - t0;
      res.setHeader('Server-Timing', 'build;dur=' + built);
      return json(res, r.code, body);
    }
    catch (e) { log('board view failed: ' + e.message); return json(res, 503, { ok: false, error: 'board-failed', detail: e.message }); }
  }
  if (p === '/api/board/unhide' && req.method === 'POST') {
    let body; try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { ok: false, error: 'bad json' }); }
    if (!body || !body.id) return json(res, 400, { ok: false, error: 'id required' });
    try { return json(res, 200, { ok: true, id: body.id, wasHidden: board.unhide(body.id) }); }
    catch (e) { return json(res, 500, { ok: false, error: 'unhide-failed', detail: e.message }); }
  }
  if (p === '/api/board/act-batch' && req.method === 'POST') {
    let body; try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { ok: false, error: 'bad json' }); }
    try {
      const r = await board.actBatch({ items: body && body.items, bid: body && body.bid, who: 'mobile', as: (identity && identity.principal) || (body && body.as) });
      return json(res, r.code, r.body);
    } catch (e) {
      log('board batch failed: ' + e.message);
      return json(res, 429, { ok: false, error: 'send-failed', reason: e.message });
    }
  }
  if (p === '/api/goals') {
    if (!config.mod('goalChaser') && !config.mod('cacheKeeper')) return json(res, 404, { ok: false, error: 'module disabled', module: 'goalChaser' });
    if (!isOwner(identity)) return json(res, 403, { ok: false, error: 'OWNER_ONLY' });
    const goals = require('../lib/goals');
    if (req.method === 'POST') {
      let body; try { body = JSON.parse((await readBody(req)).toString('utf8') || '{}'); } catch { return json(res, 400, { ok: false, error: 'bad json' }); }
      const a = String(body.action || 'add');
      let r;
      if (a === 'add') r = goals.add({ title: body.title, text: body.text, project: body.project, due: body.due, checks: body.checks, source: 'app' });
      else if (a === 'done' || a === 'failed' || a === 'dropped') r = goals.close(body.id, { status: a, note: body.note, by: 'app' });
      else if (a === 'reopen') r = goals.reopen(body.id, body.note);
      else if (a === 'judged') r = goals.judged(body.id, body.note);
      else if (a === 'verify') r = goals.verify(body.id, body.verify_by || body.date, body.what || body.note);
      else return json(res, 400, { ok: false, error: 'action must be add | done | failed | dropped | reopen | judged | verify' });
      return json(res, r.ok ? 200 : 400, r);
    }
    try { await sessions.refresh(); } catch {}
    const list = sessions.decorate(sessions.index().list, desktop.loadSnapshot());
    let items = null;
    try {
      const h = JSON.parse(fs.readFileSync(goals.HEALTH, 'utf8'));
      if (Date.now() - Date.parse(h.at) < 15 * 60000) items = h.items;
    } catch {}
    if (!items) {
      const anyLive = list.some(s => s.live);
      items = goals.assess({ goals: goals.list({ all: true }), sessions: new Map(list.map(s => [s.id, anyLive ? s : { ...s, live: undefined }])),
        fresh: true, now: Date.now(), st: goals.settings() });
    }
    const cond = new Map(items.map(i => [i.id, i]));
    const titles = new Map(list.map(s => [s.id, s.title]));
    const all = goals.list({ all: true }).map(g => ({ ...g, condition: g.status === 'open' ? ((cond.get(g.id) || {}).condition || null) : null,
      ownerState: (cond.get(g.id) || {}).ownerState || null,
      ownerTitle: g.ownerSessionId ? (titles.get(g.ownerSessionId) || null) : null }));
    return json(res, 200, { ok: true, goals: all, ...goals.status(), modules: { goalChaser: config.mod('goalChaser'), cacheKeeper: config.mod('cacheKeeper') } });
  }
  if (p === '/api/board/act' && req.method === 'POST') {
    let body; try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { ok: false, error: 'bad json' }); }
    try {
      const r = await board.act({ kind: body.kind, id: body.id, text: body.text, who: 'mobile', as: (identity && identity.principal) || body.as });
      return json(res, r.code, r.body);
    } catch (e) {
      log('board act failed: ' + e.message);
      return json(res, 429, { ok: false, error: 'send-failed', reason: e.message });
    }
  }

  if (p === '/api/outbox') {
    return json(res, 200, { ok: true, pending: outbox.pending().map(e => ({
      id: e.id, session: e.session, text: e.text, at: e.at,
      delivery: e.delivery, state: e.state, error: e.error || null,
      ageMs: Date.now() - e.at, suspect: !!e.suspectedAt,
      held: e.state === 'pending' && e.delivery === 'held' && !!e.uuid,
      accepted: !!e.acceptedAt, notDelivered: !!e.notDelivered, resent: !!e.resentAt, redelivered: !!e.redelivered,
    })) });
  }

  if (p === '/api/outbox/check') {
    const id = url.searchParams.get('id');
    if (!id) return json(res, 400, { ok: false, error: 'id required' });
    const before = outbox.get(id);
    if (!before) return json(res, 200, { ok: true, landed: false, gone: true });
    if (before.state === 'confirmed') return json(res, 200, { ok: true, landed: true });
    try { await sessions.refresh(); } catch {}
    const busy = (sid) => { const s2 = sessions.get(sid); return !!(s2 && (s2.running || s2.dot === 'Running')); };
    try { outbox.reconcile(transcriptTail, Date.now(), busy); } catch {}
    const after = outbox.get(id);
    return json(res, 200, { ok: true, landed: !!(after && after.state === 'confirmed') });
  }

  if (p === '/api/outbox/drop') {
    const id = url.searchParams.get('id');
    if (!id) return json(res, 400, { ok: false, error: 'id required' });
    outbox.drop(id);
    return json(res, 200, { ok: true });
  }

  if (p === '/api/cancel') {
    const id = url.searchParams.get('id');
    if (!id) return json(res, 400, { ok: false, error: 'id required' });
    return uiJobWith(res, 'cancel', () => ui(() => desktop.cancelSession(id)),
                     (out) => ({ id, cancel: out || null }));
  }

  if (p === '/api/projects') {
    if (!isOwner(identity)) return json(res, 403, { ok: false, error: 'OWNER_ONLY' });
    const projects = require('../lib/projects');
    try {
      const ix = url.searchParams.get('refresh') === '1' ? await projects.build({ force: true }) : await projects.fresh(30 * 60000);
      return json(res, 200, { ok: true, ...ix });
    } catch (e) { return json(res, 500, { ok: false, error: 'INDEX_FAILED', message: e.message }); }
  }
  if (p === '/api/settings') {
    if (req.method === 'POST') {
      let body; try { body = JSON.parse((await readBody(req)).toString('utf8') || '{}'); } catch { return json(res, 400, { ok: false, error: 'bad json' }); }
      const as = String(url.searchParams.get('as') || '').replace(/[^\w-]/g, '').slice(0, 32);
      const next = config.set(body || {}, 'phone' + (as ? ' (' + as + ')' : ''));
      if (body && body.remote) { try { tunnel.apply(); } catch (e) { log('tunnel apply: ' + e.message); } }
      return json(res, 200, { ok: true, settings: next, defaults: config.DEFAULTS, dataDir: config.DATA });
    }
    return json(res, 200, { ok: true, settings: config.get(), defaults: config.DEFAULTS, dataDir: config.DATA, version: require('../package.json').version });
  }
  // Settings › Now: every setting read live from the file that holds it, with who/when (lib/live-settings.js).
  if (p === '/api/live-settings') {
    if (!isOwner(identity)) return json(res, 403, { ok: false, error: 'OWNER_ONLY' });
    const titles = new Map((sessions.index().list || []).map(s => [s.id, s.title || '']));
    const titleOf = id => titles.get(id) || titles.get(String(id || '').replace(/^local_/, '')) || '';
    try { return json(res, 200, require('../lib/live-settings').read({ titleOf, principal: url.searchParams.get('as') || '' })); }
    catch (e) { return json(res, 500, { ok: false, error: 'LIVE_SETTINGS_FAILED', message: e.message }); }
  }
  if (p === '/api/send/status') {
    const v = cmidStore().get(url.searchParams.get('cmid') || '');
    if (!v) return json(res, 200, { ok: true, known: false });
    return json(res, 200, { ok: true, known: true, done: !!v.done, running: !v.done && sendJobs.has(v.jobId), jobId: v.jobId, result: v.result || null });
  }
  if (p === '/api/pair') {
    const list = pair.links(TOKEN);
    for (const l of list) l.qr = await pair.qrSvg(l.url);
    return json(res, 200, { ok: true, links: list, tunnel: tunnel.status() });
  }
  if (p === '/api/desktop') {
    const cdp = await require('../lib/heal').checkCdp();
    cdpVal = !!cdp.healthy; cdpAt = Date.now();
    return json(res, 200, { ok: true, platform: process.platform, cdp: !!cdp.healthy, cdpPort: config.get().cdpPort, desktop: deskNow(),
      desktopData: fs.existsSync(path.join(config.APPDATA, 'Claude')), devMode: devModeOn(), canAutoEnable: process.platform === 'win32' });
  }
  if (p === '/api/desktop/dev-mode' && req.method === 'POST') {
    const f = path.join(config.APPDATA, 'Claude', 'developer_settings.json');
    if (!fs.existsSync(path.dirname(f))) return json(res, 200, { ok: false, message: 'Claude Desktop is not installed for this user.' });
    if (devModeOn()) return json(res, 200, { ok: true, already: true });
    let j = {}; try { j = JSON.parse(fs.readFileSync(f, 'utf8')) || {}; } catch {}
    fs.writeFileSync(f, JSON.stringify({ ...j, allowDevTools: true }, null, 2));
    return json(res, 200, { ok: true, message: 'Developer Mode is on. Quit Claude Desktop completely and open it again, then turn on the debugger.' });
  }
  if (p === '/api/desktop/enable-debugger' && req.method === 'POST') {
    if (process.platform !== 'win32') return json(res, 200, { ok: false, error: 'MANUAL', message: 'Turning the debugger on automatically is Windows-only for now. Follow the steps shown.' });
    if (!devModeOn()) return json(res, 200, { ok: false, error: 'DEV_MODE_OFF', message: 'Turn on Developer Mode first, then quit and reopen Claude Desktop.' });
    // One switch-on at a time: a second press joins the first instead of clicking the menus twice.
    const heal = require('../lib/heal');
    if ((await heal.checkCdp()).healthy) return json(res, 200, { ok: true, already: true, message: 'Claude Desktop’s debugger is already on.' });
    if (!enableDebuggerRun) enableDebuggerRun = heal.enableDebugger().finally(() => { enableDebuggerRun = null; });
    const r = await enableDebuggerRun;
    log('enable-debugger (button): exit ' + r.code + ' ' + (r.detail || r.message));
    return json(res, 200, r);
  }
  if (p === '/api/tunnel') return json(res, 200, { ok: true, tunnel: tunnel.status() });
  if (p === '/api/tunnel/login' && req.method === 'POST') return json(res, 200, await tunnel.login());
  if (p === '/api/tunnel/setup' && req.method === 'POST') {
    let body; try { body = JSON.parse((await readBody(req)).toString('utf8') || '{}'); } catch { body = {}; }
    return json(res, 200, await tunnel.setupNamed(body.hostname, body.tunnelName));
  }
  if (p === '/api/token/rotate' && req.method === 'POST') {
    try { fs.unlinkSync(SECRET_FILE); } catch {}
    return json(res, 200, { ok: true, note: 'A new token is issued when Relaymote restarts; every paired phone must scan again.' });
  }

  if (p === '/api/send-now') {
    const id = url.searchParams.get('id');
    if (!id) return json(res, 400, { ok: false, error: 'id required' });
    return uiJobWith(res, 'send-now',
                     () => ui(() => desktop.sendQueuedNow(id)).then(out => withHoldingContext(id, out)),
                     (out) => ({ id, sendNow: out || null,
                                 result: (out && out.result) || null }));
  }

  if (p === '/api/accounts') {
    try { return json(res, 200, { ok: true, ...(await accounts.readAccounts()) }); }
    catch (e) { return json(res, 500, { ok: false, error: 'accounts-failed', detail: e.message }); }
  }
  if (p.startsWith('/api/accounts/') && req.method === 'POST') {
    let body; try { body = JSON.parse((await readBody(req)) || '{}') || {}; } catch { return json(res, 400, { ok: false, error: 'bad json' }); }
    try {
      if (p === '/api/accounts/sync') {
        const r = await accounts.syncNow(body);
        if (r.applied) log(`accounts sync: ${r.applied.count} change(s) written`);
        return json(res, r.ok ? 200 : 409, r);
      }
      if (p === '/api/accounts/settings') return json(res, 200, { ok: true, settings: accounts.saveSettings(body) });
      if (p === '/api/accounts/label') { const r = accounts.setLabel(body); return json(res, r.ok ? 200 : 400, r); }
      if (p === '/api/accounts/cycle') {
        const snap = desktop.loadSnapshot();
        const running = () => sessions.decorate(sessions.index().list, snap)
          .filter(s => s.running || s.awaiting).map(s => ({ id: s.id, title: s.title, running: !!s.running, awaiting: !!s.awaiting }));
        const r = await accounts.closeSyncReopen(body, running);
        const age = snap && snap.at ? Math.round((Date.now() - Date.parse(snap.at)) / 1000) : null;
        if (r.needsConfirm && (age === null || age > 120)) r.snapshotWarning = 'The list of running sessions may be out of date. Check Claude Desktop before you confirm.';
        if (r.log) log('accounts cycle: ' + r.log.join(' | '));
        return json(res, 200, r);
      }
      const adv = await accounts.handle(p, body);   // Advanced: hold, freeze, undo, group restore, forget, launch hook
      if (adv) { log('accounts ' + p.slice(14) + ': ' + (adv.body && adv.body.ok !== false ? 'done' : (adv.body && (adv.body.error || adv.body.message)))); return json(res, adv.status, adv.body); }
    } catch (e) {
      log('accounts failed: ' + e.message);
      return json(res, 500, { ok: false, error: 'accounts-failed', detail: e.message });
    }
    return json(res, 404, { ok: false, error: 'unknown accounts action' });
  }

  if (p === '/api/usage') {
    const id = url.searchParams.get('id') || null;
    const panel = url.searchParams.get('panel') === '1';
    return uiJobWith(res, 'usage', () => ui(() => readUsage(id, { panel })),
                     (out) => ({ usage: out && out.ok ? out : null }));
  }

  // Opened in the app with no question or permission open: this turn's dot is seen (see sessions.ackDot).
  if (p === '/api/seen') {
    const id = url.searchParams.get('id');
    if (!id) return json(res, 400, { ok: false, error: 'id required' });
    const s = sessions.get(id);
    if (!s) return json(res, 404, { ok: false, error: 'NO_SUCH_SESSION' });
    if (!visibleSessions(identity, [s]).length) return json(res, 403, { ok: false, error: 'forbidden' });
    const ok = sessions.ackDot(id, s.turnMark);
    log(`seen: "${String(s.title || id).slice(0, 48)}" turn ${s.turnMark || '?'}${s.blockedNeed ? ' (Desktop said blocked: ' + s.blockedNeed.slice(0, 80) + ')' : ''}`);
    return json(res, 200, { ok, turnMark: s.turnMark || null });
  }

  if (p === '/api/mark-read') {
    const id = url.searchParams.get('id');
    if (!id) return json(res, 400, { ok: false, error: 'id required' });
    await sessions.refresh();
    const dec = sessions.decorate(sessions.index().list, desktop.loadSnapshot()).find(x => x.id === id);
    if (!dec) return json(res, 404, { ok: false, error: 'NO_SUCH_SESSION' });
    if (!(dec.unread || dec.dot === 'unread' || /unread/i.test(String(dec.dot || '')))) {
      return json(res, 200, { ok: true, skipped: 'not unread' });
    }
    // 22-Oct, Ashwar: "Sagar opened his conductor. Then my Claude desktop app switched to that conductor session" and
    // "you again switched my session ... took me to Ajay conductor". Clearing the PC's unread dot CLICKS that session
    // in his window. Another principal's phone never does that; his own only when the PC has been idle (2 min).
    const why = windowBusy(req, url);
    if (why) { log(`mark-read ${id}: PC window not touched (${why})`); return json(res, 200, { ok: true, skipped: why }); }
    return uiJob(res, 'markread', () => desktop.markRead(id), { id });
  }

  if (p === '/api/notify-config') {
    if (req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      const patch = {};
      for (const k of ['enabled', 'awaiting', 'done']) if (k in body) patch[k] = !!body[k];
      const next = config.set({ notifications: patch }, 'phone (notifications)').notifications;
      return json(res, 200, { ok: true, push: push.count(), notifications: next, route: alerts.route(), contact: push.subjectStatus() });
    }
    return json(res, 200, { ok: true, push: push.count(), notifications: config.get().notifications, route: alerts.route(), contact: push.subjectStatus() });
  }

  if (p === '/api/suggestion') {
    const id = url.searchParams.get('id');
    if (!id) return json(res, 400, { ok: false, error: 'id required' });
    (async () => {
      let out = null;
      try { out = await ui(() => readSuggestion(id)); }
      catch (e) { log('suggestion read failed: ' + e.message); }
      for (const c of clients) {
        if (isSubuser(c.identity) && !c.identity.sessions.has(id)) continue;
        sseSend(c, 'suggestion', { id, suggestion: (out && out.suggestion) || null,
                                   error: out && out.ok ? null : String((out && out.error) || 'failed') });
      }
    })().catch(e => log('suggestion background failed: ' + e.message));
    return json(res, 202, { ok: true, pending: true });
  }

  if (p === '/api/search') {
    await sessions.refresh();
    const all = sessions.decorate(sessions.index().list, desktop.loadSnapshot());
    const r = await sessions.searchTranscripts(url.searchParams.get('q') || '', {
      limit: Math.min(Number(url.searchParams.get('limit') || 30), 60),
      list: all.filter(x => !x.archived),
    });
    const byId = new Map(all.map(x => [x.id, x]));
    return json(res, r.ok ? 200 : 400, {
      ...r,
      hits: (r.hits || []).map(h => ({ ...h, ...(byId.get(h.id) ? slimSession(byId.get(h.id)) : {}), snippet: h.snippet })),
    });
  }

  if (p === '/api/session-search') {
    await sessions.refresh();
    const sess = sessions.get(url.searchParams.get('id') || '');
    // Owner only: a scoped sub-user never reaches here (not in READ_OK above).
    if (!sess) return json(res, 404, { ok: false, error: 'no such session' });
    const r = await sessions.searchSession(sess, url.searchParams.get('q') || '', { uuid: url.searchParams.get('uuid') || null, work: url.searchParams.get('work') === '1' });
    return json(res, r.ok ? 200 : 400, r);
  }

  if (p.startsWith('/api/session/')) {
    const id = decodeURIComponent(p.slice('/api/session/'.length));
    await sessions.refresh();
    // A session started seconds ago is not in a cache that is still inside its TTL: rescan once
    // (~15 ms) before saying it does not exist (g1131).
    if (!sessions.get(id)) { try { await sessions.refresh({ force: true }); } catch {} }
    const sess = sessions.get(id);
    if (!sess) return json(res, 404, { ok: false, error: 'no such session' });
    const dec = sessions.decorate([sess], desktop.loadSnapshot())[0];
    const beforeRaw = url.searchParams.get('before');
    const before = beforeRaw === null ? null : Number(beforeRaw);
    const tr = sessions.transcript(sess, {
      limit: Math.min(Number(url.searchParams.get('limit') || 60), 200),
      before: Number.isFinite(before) ? before : null,
    });
    const pq = before === null ? sessions.pendingQuestion(sess) : null;
    const bg = before === null ? sessions.backgroundTasks(sess) : [];
    const chips = before === null ? sessions.pendingChips(sess, sessions.index().list) : [];
    return json(res, 200, { ok: true, meta: slimSession(dec), running: bg,
                            transcript: { ...tr, pendingQuestion: pq, chips } });
  }

  if (p === '/api/folders') {
    await sessions.refresh();
    const all = sessions.decorate(sessions.index().list, desktop.loadSnapshot());
    // Only folders that exist on the PC are offered: a removed worktree can never be started in (g1131).
    const fs_ = sessions.folders(all).filter(f => { try { return !!f.cwd && fs.statSync(f.cwd).isDirectory(); } catch { return false; } });
    const byBase = new Map();
    for (const f of fs_) byBase.set(f.name, (byBase.get(f.name) || 0) + 1);
    return json(res, 200, {
      ok: true,
      folders: fs_.map(f => ({ ...f, ambiguous: byBase.get(f.name) > 1 })),
    });
  }

  // 26-Oct (chips self-start): every pending suggested-task chip on the PC, read from the app's own records
  // (no session opened, no unread dot touched). A scoped login sees only chips in its own sessions.
  if (p === '/api/chips/all') {
    let q;
    try { q = await desktop.allChipQueues(); } catch (e) { return json(res, 503, { ok: false, error: 'DESKTOP_UNAVAILABLE', message: e.message }); }
    if (!q || !q.ok) return json(res, 503, { ok: false, error: (q && q.error) || 'DESKTOP_UNAVAILABLE' });
    await sessions.refresh();
    let visible = null;
    if (isSubuser(identity)) visible = identity.sessions;
    else {
      const pr = principalOf(req, url);
      if (pr.own) visible = new Set(principalList(req, url, sessions.index().list).map(s => s.id));
    }
    const auto = new Set(require('../lib/chipwatch').ownedSessions().map(o => o.sessionId));
    const out = [];
    for (const s of q.sessions.values()) {
      if (s.archived || (visible && !visible.has(s.sessionId))) continue;
      out.push({ sessionId: s.sessionId, owner: s.owner, autoStarts: auto.has(s.sessionId),
        chips: s.chips.map(c => ({ taskId: c.taskId, title: c.title, tldr: c.description, createdAt: c.createdAt,
                                   optional: require('../lib/chipwatch').isOptional(c) })) });
    }
    out.sort((a, b) => Math.max(...b.chips.map(c => c.createdAt || 0)) - Math.max(...a.chips.map(c => c.createdAt || 0)));
    return json(res, 200, { ok: true, sessions: out, total: out.reduce((n, s) => n + s.chips.length, 0) });
  }

  if (p === '/api/chips') {
    const id = url.searchParams.get('id');
    if (!id) return json(res, 400, { ok: false, error: 'id required' });
    await sessions.refresh();
    const sess = sessions.get(id);
    const running = sess ? sessions.backgroundTasks(sess) : [];
    let fromTranscript = [];
    try { fromTranscript = sess ? sessions.pendingChips(sess, sessions.index().list) : []; } catch {}

    if (url.searchParams.get('peek') === '1') {
      const snap = desktop.loadSnapshot() || {};
      if (String(snap.active || '') !== id) {
        return json(res, 200, { ok: true, running, offered: [], fromTranscript, skipped: 'not-the-open-session' });
      }
    }

    if (url.searchParams.get('offered') === '1') {
      (async () => {
        let liveTasks = [], uiRunning = null, offered = [], note = null;
        const cap = (work, ms) => Promise.race([
          work,
          new Promise(r => setTimeout(() => r({ __timedOut: true }), ms)),
        ]);
        try {
          const rt = await cap(ui(() => readRunningTasks(id)), 25000);
          if (rt && rt.__timedOut) { note = 'the desktop did not answer in time'; log('chips: running read timed out'); }
          else if (rt && rt.ok) { uiRunning = rt.count; liveTasks = rt.tasks || []; }
        } catch (e) { log('chips: running read failed: ' + e.message); }
        for (const c of clients) { if (!isSubuser(c.identity)) sseSend(c, 'chips', { id, uiRunning, liveTasks, offered: [], partial: true }); }
        try {
          const out = await cap(ui(() => desktop.listChipTasks(id, { protect: true })), 25000);
          if (out && out.__timedOut) { note = 'the desktop did not answer in time'; log('chips: offered read timed out'); }
          else { offered = (out && out.chips) || []; note = (out && out.note) || note; }
        } catch (e) { log('chips: offered read failed: ' + e.message); }
        for (const c of clients) { if (!isSubuser(c.identity)) sseSend(c, 'chips', { id, uiRunning, liveTasks, offered, note }); }
      })().catch(e => log('chips background failed: ' + e.message));
    }
    return json(res, 200, { ok: true, running, offered: [], fromTranscript, pending: true });
  }

  // g1719: errors the phone hit (see clientLog in app.js), so a phone-only failure leaves evidence on the PC.
  if (p === '/api/clientlog' && req.method === 'POST') {
    let b = {}; try { b = JSON.parse(await readBody(req)) || {}; } catch {}
    log(`phone: ${String(b.msg || '').replace(/\s+/g, ' ').slice(0, 400)} [${String(b.ua || '').slice(0, 80)}]`);
    return json(res, 200, { ok: true });
  }
  if (p === '/api/commands') {
    return json(res, 200, { ok: true, commands: slashCommands() });
  }

  if (p === '/api/relaymote-task') {
    const id = url.searchParams.get('id');
    const t = registry.allTasks().find(x => x.id === id);
    if (!t) return json(res, 404, { ok: false, error: 'NO_SUCH_TASK' });
    const read = (f, max) => {
      try {
        if (!f || !fs.existsSync(f)) return null;
        const b = fs.readFileSync(f, 'utf8');
        return b.length > max ? b.slice(-max) : b;
      } catch { return null; }
    };
    let result = null, events = [], streaming = false;
    const rawResult = read(t.resultFile, 240000);
    if (rawResult && rawResult.trim()) {
      const txt = rawResult.trim();
      if (txt.indexOf('\n') < 0) {
        try { result = JSON.parse(txt); } catch { result = { raw: txt.slice(0, 4000) }; }
      } else {
        streaming = true;
        for (const line of txt.split('\n')) {
          const L = line.trim();
          if (!L || L[0] !== '{') continue;
          let o; try { o = JSON.parse(L); } catch { continue; }
          if (o.type === 'result') { result = o; continue; }
          if (o.type === 'assistant' && o.message && Array.isArray(o.message.content)) {
            for (const c of o.message.content) {
              if (c.type === 'text' && String(c.text || '').trim()) {
                events.push({ kind: 'text', text: String(c.text).trim().slice(0, 700) });
              } else if (c.type === 'tool_use') {
                const inp = c.input || {};
                const hint = inp.command || inp.file_path || inp.path || inp.pattern || inp.prompt || inp.description || '';
                events.push({ kind: 'tool', name: c.name, text: String(hint).replace(/[\s]+/g, ' ').slice(0, 160) });
              }
            }
          }
        }
        events = events.slice(-80);
      }
    }
    return json(res, 200, {
      ok: true,
      task: {
        id: t.id, title: t.title, status: t.status, prompt: String(t.prompt || '').slice(0, 4000),
        cwd: t.cwd, model: t.model, effort: t.effort, mode: t.mode, dispatch: t.dispatch,
        type: t.type, complexity: t.complexity, attempt: t.attempt, maxAttempts: t.maxAttempts,
        createdAt: t.createdAt, startedAt: t.startedAt, endedAt: t.endedAt,
        costUsd: t.costUsd, tokens: t.tokens || null, pid: t.pid || null,
        sessionId: t.sessionId || null, guiSessionId: t.guiSessionId || null,
        tags: t.tags || [], routeReason: t.routeReason || null, error: t.error || null,
        logFile: t.logFile, resultFile: t.resultFile,
      },
      log: read(t.logFile, 8000),
      result, events, streaming,
    });
  }

  if (p === '/api/tasks') {
    const rank = (t) => (t.status === 'running' ? 0 : t.status === 'queued' ? 1 : 2);
    const all = registry.allTasks();
    const live = all.filter(t => t.status === 'running' || t.status === 'queued');
    const rest = all.filter(t => t.status !== 'running' && t.status !== 'queued').slice(0, 60);
    const tasks = [...live, ...rest]
      .sort((a2, b2) => rank(a2) - rank(b2) ||
                        String(b2.startedAt || b2.createdAt || '').localeCompare(String(a2.startedAt || a2.createdAt || '')))
      .map(t => ({
        id: t.id, title: t.title, status: t.status, model: t.model, effort: t.effort,
        cwd: t.cwd, createdAt: t.createdAt, startedAt: t.startedAt, endedAt: t.endedAt,
        costUsd: t.costUsd, error: t.error ? String(t.error).slice(0, 400) : null,
        brief: String(t.prompt || '').replace(/[\s]+/g, ' ').trim().slice(0, 320) || null,
        type: t.type, complexity: t.complexity, mode: t.mode, dispatch: t.dispatch,
        attempt: t.attempt, maxAttempts: t.maxAttempts,
        sessionId: t.sessionId || t.guiSessionId || null,
        tags: Array.isArray(t.tags) ? t.tags.slice(0, 6) : [],
        escalations: Array.isArray(t.escalations) ? t.escalations.length : 0,
        result: t.result ? String(t.result).replace(/[\s]+/g, ' ').trim().slice(0, 400) : null,
      }));
    return json(res, 200, { ok: true, summary: orch.summary(), tasks });
  }

  if (p === '/api/probe') {
    const id = url.searchParams.get('id');
    if (!id) return json(res, 400, { ok: false, error: 'id required' });
    try { return json(res, 200, { ok: true, probe: await desktop.probeSendTarget(id) }); }
    catch (e) { return json(res, 200, { ok: false, error: e.message }); }
  }

  if (p === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    let watch = url.searchParams.get('watch') || null;
    if (watch && isSubuser(identity) && !identity.sessions.has(watch)) watch = null;
    const c = { res, watch, stamp: null, identity, principal: principalOf(req, url),
                client: (url.searchParams.get('client') || '').slice(0, 64) || null };
    noteClientBuild(c.client, url.searchParams.get('build'));
    clients.add(c);
    ensurePoll();
    const ka = setInterval(() => sseSend(c, 'ping', { t: Date.now() }), 20000);
    if (ka.unref) ka.unref();
    req.on('close', () => { clearInterval(ka); clients.delete(c); maybeStopPoll(); });
    if (!polling) { polling = true; poll().catch(() => {}).finally(() => { polling = false; }); }
    return;
  }

  if (req.method !== 'POST') return json(res, 404, { ok: false, error: 'not found' });

  if (p === '/api/upload') {
    const name = String(req.headers['x-filename'] || 'upload.bin').replace(/[^\w.\-]/g, '_').slice(0, 120);
    fs.mkdirSync(UPLOADS, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const file = path.join(UPLOADS, `${stamp}_${name}`);
    const part = file + '.part';
    const r = await new Promise((resolve) => {
      const out = fs.createWriteStream(part);
      let n = 0, settled = false;
      const end = (v) => { if (!settled) { settled = true; resolve(v); } };
      req.on('data', c => { n += c.length; if (n > MAX_UPLOAD) { req.unpipe(out); out.destroy(); end({ err: 'too-large' }); req.resume(); } });
      req.on('aborted', () => { out.destroy(); end({ err: 'aborted' }); });
      req.on('error', () => { out.destroy(); end({ err: 'aborted' }); });
      out.on('error', e => end({ err: e.message }));
      out.on('finish', () => end({ n }));
      req.pipe(out);
    });
    if (r.err) {
      try { fs.unlinkSync(part); } catch {}
      if (r.err !== 'aborted') log(`upload ${name} refused: ${r.err}`);
      if (r.err === 'too-large') return json(res, 413, { ok: false, error: `That file is over ${MAX_UPLOAD / 1048576} MB, the most one upload can carry.` });
      return json(res, 400, { ok: false, error: 'the upload stopped before the whole file arrived' });
    }
    fs.renameSync(part, file);
    return json(res, 200, { ok: true, path: file, bytes: r.n });
  }

  let body = {};
  try { body = JSON.parse((await readBody(req)).toString('utf8') || '{}'); }
  catch { return json(res, 400, { ok: false, error: 'bad json' }); }

  if (isSubuser(identity) && ['/api/send', '/api/model', '/api/effort', '/api/answer', '/api/permission/answer', '/api/queued/cancel', '/api/queued/send-now', '/api/attach'].includes(p)) {
    if (!body.id || !identity.sessions.has(body.id)) {
      return json(res, 403, { ok: false, error: 'NOT_GRANTED', message: 'That session is not shared with you.' });
    }
  }

  try {
    if (p === '/api/tts') {
      const out = await tts.synth(body.text);
      return json(res, out.ok ? 200 : (out.error === 'NO_TEXT' ? 400 : 501), out);
    }
    if (p === '/api/send') {
      // Desktop down: start it and tell the phone to hold the message (its outbox retries), instead of a send
      // that is certain to fail and count against the message.
      if (!(await cdpCached())) {
        const w = await deskState.wake({ why: 'message sent', log }).catch(() => null);
        const st = deskState.get();
        if (w && (w.launched || w.already || st.state === 'restarting')) return json(res, 503, { ok: false, error: 'DESKTOP_RESTARTING', message: 'Claude is restarting on the PC; this message goes as soon as it is back.' });
      }
      const cmid = typeof body.cmid === 'string' && /^[\w-]{6,64}$/.test(body.cmid) ? body.cmid : null;
      const seen = cmid && cmidStore().get(cmid);
      if (seen && !seen.done && sendJobs.has(seen.jobId)) return json(res, 202, { ok: true, queued: true, jobId: seen.jobId, again: true });
      if (seen && seen.done && seen.ok) return json(res, 200, { ok: true, already: true, jobId: seen.jobId, result: seen.result });
      const jobId = crypto.randomBytes(6).toString('hex');
      const job = { id: jobId, session: body.id, text: String(body.text || ''), at: Date.now(),
                    origin: res._agoClient || null, cmid };
      sendJobs.set(jobId, job);
      notePrincipalTouch(req, url, body.id, false);
      if (cmid) { cmidStore().set(cmid, { jobId, at: job.at, done: false }); cmidSave(); }
      doSend(body.id, body.text, body.attachments, { noUi: windowBusy(req, url) === 'another principal' })
        .then(out => finishSend(job, out))
        .catch(e => finishSend(job, { ok: false, error: e.message }));
      return json(res, 202, { ok: true, queued: true, jobId });
    }
    const tierEcho = (out) => ({
      id: body.id,
      pending: !!(out && out.pending),
      confirmed: !!(out && out.confirmed),
      unchanged: !!(out && out.unchanged),
      model: (out && out.model) || null,
      effort: (out && out.effort) || null,
      applied: (out && out.applied) || null,
      was: (out && out.was) || null,
      running: !!(out && out.running),
      note: (out && (out.message || out.detail)) || '',
    });
    if (p === '/api/queued/cancel' || p === '/api/queued/send-now') {
      const slip = body.outboxId ? outbox.get(body.outboxId) : null;
      if (!slip || slip.session !== body.id) return json(res, 404, { ok: false, error: 'NO_SUCH_MESSAGE' });
      if (!slip.uuid) {
        return json(res, 409, { ok: false, error: 'NOT_ADDRESSABLE',
          message: 'That message went through the desktop composer, so it has no handle the phone can act on. It will be delivered when the current turn ends.' });
      }
      if (slip.state === 'confirmed') {
        return json(res, 409, { ok: false, error: 'ALREADY_DELIVERED', message: 'That message has already been delivered.' });
      }
      const sendNow = p === '/api/queued/send-now';
      return uiJobWith(res, sendNow ? 'send-now' : 'cancel-queued', async () => {
        const out = sendNow
          ? await desktop.sendQueuedNowByUuid(body.id, slip.uuid)
          : await desktop.cancelQueued(body.id, slip.uuid);
        if (out.ok && !sendNow) outbox.drop(slip.id);
        if (out.ok && sendNow) outbox.markSent(slip.id, { ok: true, delivery: 'sent-now' });
        if (out && out.alreadySent) { try { await outboxTick(); } catch {} }
        setTimeout(() => { outboxTick().catch(() => {}); }, 2500);
        return out;
      }, (out) => ({ id: body.id, outboxId: slip.id, cancelled: !!(out && out.cancelled),
                     interrupted: !!(out && out.interrupted), alreadySent: !!(out && out.alreadySent),
                     note: (out && (out.message || out.detail)) || '' }));
    }
    if (p === '/api/model') {
      require('../lib/tier-policy').recordUser(body.id, { model: body.model });
      return uiJob(res, 'model', () => desktop.setModel(body.id, body.model), tierEcho);
    }
    if (p === '/api/effort') {
      require('../lib/tier-policy').recordUser(body.id, { effort: body.effort });
      // g1133: Desktop's bridge, answered directly with the effort Desktop now reports. The slider
      // path navigated Desktop to the session (the flicker) and could miss the control ("effort not
      // found"); it is kept only for ultracode, which is a flag, not an effort.
      let out;
      try { out = await desktop.setEffortBridge(body.id, body.effort); }
      catch (e) { out = { ok: false, bridged: true, error: 'EXCEPTION', message: e.message }; }
      if (out && out.bridged === false) return uiJob(res, 'effort', () => desktop.setEffort(body.id, body.effort), tierEcho);
      if (out && out.ok) effortOverlay.set(body.id, { effort: out.effort, at: Date.now() });
      log(`effort ${body.id} -> ${body.effort}: ${out && out.ok ? 'now ' + out.effort : 'FAILED ' + (out && (out.error + ' ' + (out.message || '')))}`);
      return json(res, out && out.ok ? 200 : 400, out && out.ok
        ? { ok: true, sync: true, id: body.id, effort: out.effort, was: out.was, unchanged: out.unchanged, confirmed: true }
        : { ok: false, sync: true, id: body.id, code: out && out.error, error: (out && out.message) || 'Desktop did not take the change.', was: out && out.was });
    }
    if (p === '/api/fast') {
      return uiJobWith(res, 'fast', async () => {
        let handle = body.id, borrowed = null;
        const probe = handle ? await desktop.readFastMode(handle).catch(() => ({ ok: false })) : { ok: false };
        if (!probe.ok || !probe.loaded) {
          const all = await desktop.readFastModeAll().catch(() => ({ ok: false }));
          const ids = all.ok ? Object.keys(all.byId) : [];
          const pick = ids.find(id => !all.byId[id].running) || ids[0];
          if (pick) { handle = pick; borrowed = pick; }
        }
        if (!handle) {
          return { ok: false, error: 'NO_LIVE_SESSION',
                   message: 'No session has a live process, so Claude Desktop has nothing to set fast mode through. Open any session and try again.' };
        }
        const out = await desktop.setFastMode(handle, !!body.fast);
        return Object.assign({}, out, { handle, borrowed });
      }, (out) => ({
        id: body.id,
        scope: 'global',
        handle: (out && out.handle) || null,
        borrowed: (out && out.borrowed) || null,
        asked: !!body.fast,
        on: !!(out && out.on),
        state: (out && out.state) || null,
        reason: (out && out.reason) || null,
        blocked: !!(out && out.blocked),
        loaded: !!(out && out.loaded),
        confirmed: !!(out && out.confirmed),
        note: (out && out.message) || '',
      }));
    }
    if (p === '/api/account-switch') {
      const out = accountScope.answer(body.answer);
      if (out.ok) log(`account switch: answered "${body.answer}" for ${out.question.key}`);
      for (const c of recipients(res._agoClient || null)) sseSend(c, 'accountswitch', accountScope.pending());
      return json(res, out.ok ? 200 : 400, out);
    }
    if (p === '/api/rename') {
      return uiJob(res, 'rename', () => desktop.renameSession(body.id, body.title), { id: body.id });
    }
    if (p === '/api/archive') {
      return uiJob(res, 'archive', () => desktop.archiveSession(body.id, { force: !!body.force }),
                   { id: body.id, forced: !!body.force });
    }
    if (p === '/api/group') {
      return uiJob(res, 'group', () => desktop.setGroup(body.id, body.group), { id: body.id });
    }
    if (p === '/api/answer') {
      return uiJobWith(res, 'answer', async () => {
        // 26-Oct: answering on the card opens the session on the PC. While the PC is in use, or for another principal,
        // the tap goes as a message through the background route instead (the window is never touched).
        const busy = windowBusy(req, url);
        if (busy) {
          const text = answersAsText(body.answers);
          if (!text) return { ok: false, error: 'NOTHING_TO_SEND', message: 'No answer was picked, and the PC is not opened for it (' + busy + ').' };
          log(`answer ${body.id}: ${busy} -> sent as a message, PC window not touched`);
          const s = await doSend(body.id, text, [], { noUi: true });
          return { ...s, fallback: 'message', sentText: text, why: busy };
        }
        let out = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
          out = await ui(() => answerQuestion(body.id, body.answers));
          if (out && out.ok) return { ...out, attempts: attempt };
          if (!TRANSIENT_SEND.has(String(out && out.error))) break;
          log(`answer attempt ${attempt} -> ${out && out.error}; retrying`);
          await new Promise(r => setTimeout(r, 900 * attempt));
        }
        const text = shouldFallBack(out) ? answersAsText(body.answers) : '';
        if (text) {
          log(`answer ${body.id}: ${out.error} -> sending his tap as a message instead`);
          const s = await doSend(body.id, text, [], { noUi: windowBusy(req, url) === 'another principal' });
          return { ...s, fallback: 'message', sentText: text, why: out.error };
        }
        return out;
      }, out => ({ id: body.id, fallback: out && out.fallback, sentText: out && out.sentText }));
    }
    if (p === '/api/new') {
      const cwd = String(body.cwd || '');
      if (cwd && !/[\\/]/.test(cwd)) {
        return json(res, 400, { ok: false, error: 'BAD_CWD',
          message: `The folder path arrived with no \\ or / in it ("${cwd.slice(0, 60)}"), so it is not a real path — something stripped the separators before it got here. Send the full path, e.g. C:\\Users\\you\\projects\\my-app.` });
      }
      const ns = config.get().newSession || {};
      const extra = String(ns.instructions || '').trim();
      const job = { ...body, model: body.model || ns.model || undefined, effort: body.effort || ns.effort || undefined,
                    prompt: extra && body.prompt ? body.prompt + '\n\n' + extra : body.prompt, modelIds: modelIdsVal };
      // Not behind the UI queue: the create is one bridge call, no clicks (g1131). "Created" is said
      // only once the session is in this server's own index, so opening it never reads "no such session".
      // Answered directly, not through a job id + stream event: a create takes about a second, and a
      // stream event that beat the POST's reply was matched to nothing, leaving "Creating…" up.
      let out;
      try { out = await newSession(job); } catch (e) { out = { ok: false, error: 'EXCEPTION', message: e.message }; }
      if (out && out.ok && out.sessionId) {
        // Desktop's start() returns in ~0.2 s, but writes the session's record to disk 6-10 s later
        // (measured 0.2.70), and only then can the index see it. So: a short look with FORCED rescans
        // (a plain refresh() serves its cache), then answer; the phone opens it once it is listed.
        for (let i = 0; i < 6 && !sessions.get(out.sessionId); i++) {
          try { await sessions.refresh({ force: true }); } catch {}
          if (!sessions.get(out.sessionId)) await new Promise(r => setTimeout(r, 250));
        }
        out.indexed = !!sessions.get(out.sessionId);
        notePrincipalTouch(req, url, out.sessionId, true);
        log(`new ${out.sessionId} in ${out.cwd} model=${out.model} effort=${out.effort} perm=${out.permissionMode} ${out.ms}ms indexed=${out.indexed}`);
      } else log(`new failed: ${(out && (out.error + ': ' + out.message)) || 'no result'}`);
      if (!out || !out.ok) {
        // The client shows `error`, so it carries the sentence; the code moves to `code`. (On 03-Oct it
        // showed a bare JSON blob with "error":"" because the reason sat in `message`.)
        const o = out || {};
        return json(res, 400, { ...o, ok: false, code: o.error || 'NO_RESULT', error: o.message || o.error || 'The session could not be created.' });
      }
      return json(res, 200, out);
    }
    // g1712: his tap on a Desktop dialog's button (workspace trust etc.), pressed on the same dialog on the PC.
    if (p === '/api/dialog/press') {
      log(`dialog press "${String(body.label || '').slice(0, 40)}" on "${String(body.key || '').slice(0, 60)}"`);
      return uiJobWith(res, 'dialog-press',
                       () => ui(() => pressDialogButton({ key: body.key, label: body.label, index: body.index })),
                       (out) => ({ key: body.key, label: body.label, closed: !!(out && (out.closed || out.alreadyClosed)) }));
    }
    if (p === '/api/permission/answer') {
      // 26-Oct: an Allow/Deny can only be pressed in that session's view. It is pressed in place if the PC already
      // shows it; otherwise only while nobody is using the PC (and the view is put back). Never while he types.
      if (!pcIdle()) {
        const pk = await ui(() => peekPermission()).catch(() => null);
        if (!(pk && pk.ok && pk.present && pk.here === String(body.id || ''))) {
          log('approval answer for ' + String(body.id || '') + ' held: PC in use, session not on screen');
          return json(res, 409, { ok: false, error: 'PC_IN_USE', message: 'Someone is using the PC right now, so the session was not opened there. The approval is still waiting; tap again in a couple of minutes.' });
        }
      }
      log('approval answer: ' + String(body.kind || '') + ' "' + String(body.raw || '').slice(0, 40) + '" for ' + String(body.id || '') + ' from ' + (body.from || 'app'));
      // The notification's own buttons cannot hold the SSE stream, so they ask for the result in the reply.
      if (body.wait) {
        const out = await ui(() => answerPermission(body.id, body.kind, body.raw)).catch(e => ({ ok: false, error: e.message }));
        log('approval answer ' + (out && out.ok ? 'done: ' + out.chose : 'failed: ' + ((out && (out.error || out.message)) || '?')));
        return json(res, out && out.ok ? 200 : 409, out || { ok: false });
      }
      return uiJobWith(res, 'permission-answer',
                       () => ui(() => answerPermission(body.id, body.kind, body.raw)),
                       { id: body.id, kind: body.kind });
    }
    // 22-Oct: take a session off another principal's list (owner only: scoped logins are refused above) until
    // that principal's Conductor touches it again. body: { principal, ids: [sid...] } or { principal, id }.
    if (p === '/api/principal/release') {
      const P = require('./principals'), touch = require('./principal-touch');
      const key = String(body.principal || '').toLowerCase();
      const J = P.load(board.CONDUCTOR_DIR);
      if (!J.principals[key] || key === J.default) return json(res, 400, { ok: false, error: 'NO_PRINCIPAL', message: 'Name another principal (not the default).' });
      const conductor = J.principals[key].conductor;
      const out = [].concat(body.ids || body.id || []).map(String).map(sid => sid === conductor
        ? { ok: false, sid, error: 'his own Conductor stays on his list' } : touch.release(sid, key));
      log('principal release: ' + key + ' ' + out.map(r => r.sid + (r.ok ? '' : ' (' + r.error + ')')).join(', '));
      return json(res, out.length && out.every(r => r.ok) ? 200 : 400, { ok: out.length > 0 && out.every(r => r.ok), results: out });
    }

    if (p === '/api/relaymote-task/stop') {
      const out = await orch.stopTask(String(body.id || ''), { by: 'phone (Relaymote mobile)' });
      return json(res, out && out.ok !== false ? 200 : 400, { ok: !(out && out.ok === false), result: out });
    }

    if (p === '/api/task/stop') {
      const idx = Number(body.index) || 0;
      return uiJob(res, 'stop', () => stopRunningTask(body.id, idx), { id: body.id, index: idx });
    }
    if (p === '/api/attach') {
      return uiJob(res, 'attach', () => pasteFiles(body.id, body.files), { id: body.id });
    }
    if (p === '/api/chip/start') {
      // A chip named by taskId starts through the bridge: nothing is clicked or fronted on the PC (0.2.139 rule),
      // so it is safe while he types. Only an old phone (title/index, no taskId) or a missing bridge falls back
      // to pressing the card, which waits for an idle PC.
      if (body.taskId) {
        const tier = require('../lib/tier-policy').defaults();
        const r = await desktop.startChipBackground({ sessionId: body.sessionId, taskId: body.taskId,
          model: tier.model || undefined, effort: tier.effort || undefined }).catch(e => ({ ok: false, error: 'THREW', message: e.message }));
        if (r.ok) {
          try { require('../lib/tier-policy').recordRelaymote(r.startedSessionId, { model: r.model, effort: r.effort }); } catch {}
          log(`chip started in background: ${body.taskId} "${String(r.title || '').slice(0, 60)}" from ${body.sessionId} -> ${r.startedSessionId}`);
          return json(res, 200, r);
        }
        if (r.error !== 'NO_BRIDGE') return json(res, r.error === 'NO_CHIP' ? 410 : 409, r);
      }
      return uiJob(res, 'chipstart', () => desktop.startTask({ ...body, mode: body.mode || 'local' }),
                   { id: body.sessionId });
    }
    if (p === '/api/chip/dismiss') {
      return uiJob(res, 'chipdismiss', () => desktop.dismissTask(body), { id: body.sessionId });
    }
    if (p === '/api/push/subscribe') {
      const n = push.subscribe(body, (() => {
        // undefined = the service worker's re-subscribe (no idea whose phone): keep what the endpoint had.
        const said = body && 'as' in body ? body.as : (req.headers['x-relaymote-as'] || url.searchParams.get('as') || undefined);
        if (said === undefined) return undefined;
        const pr = require('./principals').resolve(board.CONDUCTOR_DIR, said);
        return pr.isDefault ? '' : pr.key;
      })());
      let host = '?'; try { host = new URL(body.endpoint).host; } catch {}
      const said = body && 'as' in body ? body.as : (req.headers['x-relaymote-as'] || url.searchParams.get('as'));
      if (said !== undefined) pushMissed.clear(require('./principals').resolve(board.CONDUCTOR_DIR, said).key);
      log(`push: subscribed ${host} (${n} now)`);
      return json(res, 200, { ok: true, subs: n });
    }
    if (p === '/api/push/test') {
      const r = await push.send({ title: 'Relaymote', body: 'Test notification' });
      log(`notify: test -> ${alerts.outcome({ push: { ...r, subscribed: (r.results || []).length } }).text || 'no phone subscribed'}`);
      return json(res, 200, { ok: r.sent > 0, sent: r.sent, subs: push.count() });
    }
    // What the app's silent re-subscribe on open concluded. It used to reach only the phone's console,
    // so when no phone was subscribed nothing on this side could say whether the app had been opened
    // at all, or opened and refused (permission, insecure origin, no service worker).
    if (p === '/api/push/state') {
      const b = body || {};
      log(`push: app open reports ok=${!!b.ok} reason=${String(b.reason || '').slice(0, 40)}` +
          ` permission=${String(b.permission || '').slice(0, 12)} secure=${!!b.secure}` +
          (b.detail ? ` detail=${String(b.detail).slice(0, 80)}` : '') + ` (server subs ${push.count()})`);
      return json(res, 200, { ok: true, subs: push.count() });
    }
    if (p === '/api/notify/test-backup') {
      const r = await alerts.sendBackup({ kind: 'test', title: 'Relaymote', body: 'Test alert from Relaymote — the backup channel works.', tag: 'relaymote-test', url: '/' }, { test: true });
      return json(res, 200, { ok: !!r.ok, result: r });
    }
  } catch (e) {
    return json(res, 500, { ok: false, error: e.message });
  }

  return json(res, 404, { ok: false, error: 'not found' });
}

function tailscaleAddrs() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(ifs)) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const o = a.address.split('.').map(Number);
      if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) out.push({ name, address: a.address });
    }
  }
  return out;
}

const bound = new Map();

function bind(address, label) {
  if (bound.has(address)) return;
  const s = http.createServer((req, res) => {
    // An upload's time is the phone's transfer time, not server work: it gets its own long deadline (g1630).
    const ms = req.url && req.url.startsWith('/api/upload') ? UPLOAD_DEADLINE_MS : ROUTE_DEADLINE_MS;
    const deadline = req.url && req.url.startsWith('/api/stream') ? null : setTimeout(() => {
      if (res.headersSent || res.writableEnded) return;
      log(`deadline hit: ${req.method} ${req.url && req.url.split('?')[0]} exceeded ${ms}ms`);
      try { json(res, 503, { ok: false, error: `the server took longer than ${ms / 1000}s` }); } catch {}
    }, ms);
    if (deadline && deadline.unref) deadline.unref();
    const done = () => { if (deadline) clearTimeout(deadline); };
    res.on('finish', done); res.on('close', done);
    handle(req, res)
      .catch(e => { try { json(res, 500, { ok: false, error: e.message }); } catch {} })
      .finally(done);
  });
  s.on('error', e => {
    log(`listener ${address}:${PORT} failed: ${e.code || e.message}`);
    bound.delete(address);
  });
  s.listen(PORT, address, () => log(`listening on http://${address}:${PORT}  (${label})`));
  s.keepAliveTimeout = 65000;
  s.requestTimeout = UPLOAD_DEADLINE_MS;   // Node's default (5 min) would cut a long upload on a slow phone link
  bound.set(address, s);
}

/** Addresses the app may listen on for a remote-access mode. Only 'lan' and 'tailscale' go beyond loopback. */
function wantedAddrs(mode, tsList) {
  const want = new Set(['127.0.0.1']);
  if (mode === 'lan') want.add('0.0.0.0');
  if (mode === 'tailscale') for (const ts of tsList || []) want.add(ts.address);
  return want;
}

function rebindLoop() {
  let announced = null;
  const tick = () => {
    const mode = (config.get().remote || {}).mode;
    // Listen beyond loopback ONLY in the mode that asks for it ("off" and the Cloudflare modes are loopback-only;
    // the tunnel connects to 127.0.0.1). Leaving a mode closes its listeners.
    const want = wantedAddrs(mode, tailscaleAddrs());
    for (const [addr, srv] of bound) {
      if (want.has(addr)) continue;
      bound.delete(addr);
      try { srv.close(); } catch {}
      log(`stopped listening on ${addr}:${PORT} (remote mode is ${mode || 'off'})`);
    }
    if (mode === 'lan' && !bound.has('0.0.0.0')) bind('0.0.0.0', 'LAN');
    for (const ts of tailscaleAddrs()) {
      if (mode !== 'tailscale') break;
      if (!bound.has(ts.address)) bind(ts.address, 'Tailscale');
      if (announced !== ts.address) {
        announced = ts.address;
        log(`reachable over Tailscale at http://${ts.address}:${PORT}`);
      }
    }
  };
  tick();
  const t = setInterval(tick, 30000);
  if (t.unref) t.unref();
}

const TAIL_BYTES = 2 * 1024 * 1024;

function transcriptTail(id, span = TAIL_BYTES) {
  const sess = sessions.get(id);
  if (!sess) return '';
  try {
    const file = sessions.transcriptPath(sess);
    if (!file) return '';
    const size = fs.statSync(file).size;
    const want = Math.min(size, span);
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.allocUnsafe(want);
      fs.readSync(fd, buf, 0, want, size - want);
      return buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return ''; }
}

let startDefaults = null;
function startDefaultsCached() { return startDefaults; }
let enableDebuggerRun = null;
function devModeOn() {
  try { return JSON.parse(fs.readFileSync(path.join(config.APPDATA, 'Claude', 'developer_settings.json'), 'utf8')).allowDevTools === true; } catch { return false; }
}
function newSessionDefaults() {
  const n = config.get().newSession || {};
  if (!n.model && !n.effort) return startDefaults;
  const d = startDefaults || {};
  return { ...d, model: n.model || d.model, effort: n.effort || d.effort, effortSource: n.effort ? 'settings' : d.effortSource };
}
async function refreshStartDefaults() {
  try { const v = await desktop.readStartDefaults(); if (v && v.ok) startDefaults = { model: v.model, effort: v.effort, effortSource: v.effortSource }; } catch {}
}

// Runs every 5 s while anything is pending, so a message reads "sent" within seconds of Desktop taking
// it (g1050). The session index is refreshed at most once a minute; a refresh can take seconds.
let outboxBusy = false, outboxRefreshedAt = 0;
async function outboxTick() {
  if (outboxBusy || !outbox.pending().length) return;
  outboxBusy = true;
  try { await outboxTickInner(); } finally { outboxBusy = false; }
}
async function outboxTickInner() {
  if (Date.now() - outboxRefreshedAt > 60000) { outboxRefreshedAt = Date.now(); try { await sessions.refresh(); } catch {} }
  const busy = (id) => { const s = sessions.get(id); return !!(s && (s.running || s.dot === 'Running')); };
  const { confirmed, suspect } = outbox.reconcile(transcriptTail, Date.now(), busy);
  for (const e of confirmed) log(`outbox: confirmed ${e.id} in ${e.session}`);
  // g1783 + 21-Oct (at-least-once): a send Desktop never took is re-delivered once, marked as such, then reported
  // NOT delivered. Not while Desktop is down or restarting: its absence is not the message's fault, and the check
  // runs again once it is back.
  const acc = (FAKE_SEND || await cdpCached()) ? outbox.checkAccepted(transcriptTail, Date.now()) : { resend: [], failed: [] };
  for (const e of acc.resend) {
    const text = outbox.redeliveryText(e);
    let r = null;
    try { r = await redeliver(e, text); } catch (x) { r = { ok: false, error: x.message }; }
    outbox.markResent(e.id, { ok: !!(r && r.ok), error: r && (r.detail || r.error) });
    log(`outbox: ${e.id} never reached ${e.session} (no queue or user row in ${outbox.ACCEPT_MS / 1000}s) -- REDELIVERED once ` +
        `${e.uuid ? 'via bridge, same uuid ' + String(e.uuid).slice(0, 8) : 'via the composer'}: ${r && r.ok ? 'ok' : 'FAILED ' + (r && (r.detail || r.error))}`);
    for (const c of clients) {
      if (isSubuser(c.identity) && !c.identity.sessions.has(e.session)) continue;
      sseSend(c, 'outbox', { redelivered: [{ id: e.id, session: e.session, ok: !!(r && r.ok) }] });
    }
  }
  for (const e of acc.failed) {
    log(`outbox: ${e.id} NOT delivered to ${e.session} -- dropped twice`);
    for (const c of clients) {
      if (isSubuser(c.identity) && !c.identity.sessions.has(e.session)) continue;
      sseSend(c, 'alert', { kind: 'outbox', title: 'Message NOT delivered', body: e.text.slice(0, 120), id: e.session, outboxId: e.id });
    }
  }
  if (confirmed.length) {
    for (const c of clients) {
      const mine = isSubuser(c.identity) ? confirmed.filter(e => c.identity.sessions.has(e.session)) : confirmed;
      if (mine.length) sseSend(c, 'outbox', { confirmed: mine.map(e => ({ id: e.id, session: e.session })) });
    }
  }
  for (const e of suspect) {
    log(`outbox: ${e.id} still not in the transcript after ${Math.round((Date.now() - e.at) / 60000)}m`);
    for (const c of clients) {
      if (isSubuser(c.identity) && !c.identity.sessions.has(e.session)) continue;
      sseSend(c, 'alert', {
        kind: 'outbox',
        title: 'A message may not have arrived',
        body: e.text.slice(0, 120),
        id: e.session, outboxId: e.id,
      });
    }
  }
}

function start() {
  setTimeout(() => { tts.warm().catch(() => {}); }, 8000);   // read-aloud: start the voice worker before the first tap
  bind('127.0.0.1', 'loopback');
  rebindLoop();
  ensurePoll();
  const ob = setInterval(() => { outboxTick().catch(e => log('outbox tick: ' + e.message)); }, 5000);
  setTimeout(() => { refreshStartDefaults(); }, 8000);
  const sdT = setInterval(refreshStartDefaults, 5 * 60000);
  if (sdT.unref) sdT.unref();
  if (ob.unref) ob.unref();
  // Every 5 min: can any phone receive an alert? None for 30 min -> one alarm over
  // notifications.healthAlarm; a phone subscribing again -> one "back on". See pushhealth.js.
  const pushHealthTick = async () => {
    try {
      let seed = null;
      try { seed = fs.statSync(path.join(config.MOBILE, 'push.json')).mtimeMs; } catch {}
      await pushHealth.tick({ count: push.count(), send: alerts.alarm, log,
                              enabled: (config.get().notifications || {}).enabled !== false, seedZeroSince: seed });
    } catch (e) { log('push-health: ' + e.message); }
  };
  const phT = setInterval(pushHealthTick, 5 * 60000);
  if (phT.unref) phT.unref();
  const ph0 = setTimeout(pushHealthTick, 60000);
  if (ph0.unref) ph0.unref();

  const ts = tailscaleAddrs()[0];
  try { tunnel.apply(); } catch (e) { log('tunnel: ' + e.message); }
  return { servers: [...bound.values()], token: TOKEN, port: PORT, tailscale: ts ? ts.address : null };
}

module.exports = Object.assign(start, { start, TOKEN, PORT, tailscaleAddrs, wantedAddrs, outbox, outboxTick, transcriptTail, TAIL_BYTES, buildReport: clientBuildReport });
