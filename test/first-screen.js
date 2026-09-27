// first-screen.js — what a cold open lands on (mobile/public/app.js pickFirstScreen / firstScreen), the
// header's connection dot, and the install markup. g454 rule: closed and reopened within RESUME_MS ->
// exactly where you were (session, Board or list); otherwise, or when that session is gone -> the
// session open on the PC (Desktop's `active` row), else the most recent one, else the list. The Board is
// not a default any more. The functions are taken from app.js as written and run against stubs.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failed = 0;
const check = (ok, name, extra) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra !== undefined && !ok ? '  ' + JSON.stringify(extra).slice(0, 300) : ''}`); if (!ok) failed++; };

const P = f => fs.readFileSync(path.join(__dirname, '..', 'mobile', 'public', f), 'utf8');
const app = P('app.js');
const html = P('index.html');
const src = app.slice(app.indexOf('const RESUME_MS'), app.indexOf("document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') savePlace(); });"));

function load({ place = null, sessions = [], open = null, sheet = null, drawerOpen = false, board = true } = {}) {
  const did = [];
  const store = { 'baton.lastPlace': place == null ? null : JSON.stringify(place) };
  const ctx = {
    state: { open, rawSessions: sessions },
    window: board ? { openBoard: () => did.push('board') } : {},
    localStorage: { getItem: k => store[k] == null ? null : store[k], setItem: (k, v) => { store[k] = v; } },
    visibleSheetId: () => sheet,
    $: () => ({ classList: { contains: () => drawerOpen } }),
    openChat: id => did.push('chat:' + id),
    drawer: () => did.push('list'),
    navTouched: 0,
    Date, JSON, Promise,
  };
  vm.createContext(ctx);
  vm.runInContext(src + '\nthis.firstScreen = firstScreen; this.pickFirstScreen = pickFirstScreen; this.savePlace = savePlace; this.RESUME_MS = RESUME_MS;', ctx);
  return { ctx, did, store };
}

(async () => {
  check(src.length > 800 && /function pickFirstScreen\(/.test(src) && /async function firstScreen\(touched0 = navTouched\)/.test(src), 'the g454 first-screen code is found in app.js');
  const now = Date.now(), MIN = 60000;
  const S = [{ id: 'old', at: 1 }, { id: 'newest', at: 9 }, { id: 'arch', at: 99, archived: true }, { id: 'mine', at: 5 }, { id: 'onpc', at: 3, active: true }];
  const { ctx } = load();
  const pick = (place, list = S) => ctx.pickFirstScreen(place, list, { now });
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  check(ctx.RESUME_MS === 30 * MIN, 'a reopen within 30 minutes counts as "just closed it"');
  check(eq(pick({ kind: 'chat', id: 'mine', at: now - 5 * MIN }), { kind: 'chat', id: 'mine', why: 'resume' }), 'closed a session 5 min ago: reopens THAT session (not the PC one)');
  check(eq(pick({ kind: 'board', at: now - 2 * MIN }), { kind: 'board', why: 'resume' }), 'closed on the Board: reopens the Board');
  check(eq(pick({ kind: 'list', at: now - 1 * MIN }), { kind: 'list', why: 'resume' }), 'closed on the session list: reopens the list');
  check(eq(pick({ kind: 'chat', id: 'mine', at: now - 45 * MIN }), { kind: 'chat', id: 'onpc', why: 'pc' }), 'closed 45 min ago: the session open on the PC');
  check(eq(pick(null), { kind: 'chat', id: 'onpc', why: 'pc' }), 'no history: the session open on the PC');
  check(eq(pick({ kind: 'chat', id: 'gone', at: now - MIN }), { kind: 'chat', id: 'onpc', why: 'pc' }), 'that session no longer exists: the session open on the PC');
  check(eq(pick({ kind: 'chat', id: 'arch', at: now - MIN }), { kind: 'chat', id: 'onpc', why: 'pc' }), 'that session was archived: the session open on the PC');
  check(eq(pick(null, S.filter(s => !s.active)), { kind: 'chat', id: 'newest', why: 'recent' }), 'nothing open on the PC (or Desktop not read yet): the most recently active session');
  check(eq(pick(null, [{ id: 'a', archived: true, active: true }]), { kind: 'list', why: 'empty' }), 'no live sessions at all: the list');
  check(eq(ctx.pickFirstScreen({ kind: 'board', at: now }, S, { now, board: false }), { kind: 'chat', id: 'onpc', why: 'pc' }), 'Board module off: a Board "resume" falls to the PC session');
  {
    // The control: the pre-g454 rule opened the Board whenever something waited, whatever you had open.
    const OLD = (waiting) => (waiting > 0 ? 'board' : 'session');
    check(OLD(3) === 'board' && pick({ kind: 'chat', id: 'mine', at: now - MIN }).kind === 'chat', 'control: the old rule would have opened the Board here; the new one resumes the session');
  }

  // firstScreen acts on the pick, and never over something you opened meanwhile.
  let x = load({ place: { kind: 'chat', id: 'mine', at: now - MIN }, sessions: S });
  check(await x.ctx.firstScreen() === 'chat:resume' && x.did.join() === 'chat:mine', 'firstScreen opens the resumed session', x.did);
  x = load({ place: { kind: 'board', at: now - MIN }, sessions: S });
  check(await x.ctx.firstScreen() === 'board:resume' && x.did.join() === 'board', 'firstScreen reopens the Board', x.did);
  x = load({ sessions: S });
  check(await x.ctx.firstScreen() === 'chat:pc' && x.did.join() === 'chat:onpc', 'firstScreen opens the PC session', x.did);
  x = load({ sessions: [] });
  check(await x.ctx.firstScreen() === 'list:empty' && x.did.join() === 'list', 'firstScreen shows the list when there is nothing', x.did);
  for (const [name, o] of [['a session', { open: 'tapped' }], ['a sheet', { sheet: 'settings' }], ['the drawer', { drawerOpen: true }]]) {
    x = load({ sessions: S, ...o });
    check(await x.ctx.firstScreen() === 'user' && x.did.length === 0, `${name} opened while the app loaded wins`, x.did);
  }
  x = load({ sessions: S });
  x.ctx.navTouched = 1;
  check(await x.ctx.firstScreen(0) === 'user' && x.did.length === 0, 'any navigation while the app loaded wins');
  // savePlace records where you are.
  x = load({ open: 'mine' }); x.ctx.savePlace();
  let saved = JSON.parse(x.store['baton.lastPlace']);
  check(saved.kind === 'chat' && saved.id === 'mine' && Math.abs(saved.at - Date.now()) < 5000, 'savePlace records the open session and when', saved);
  x = load({ open: 'mine', sheet: 'view-board' }); x.ctx.savePlace();
  check(JSON.parse(x.store['baton.lastPlace']).kind === 'board', 'with the Board over a session, the place is the Board');

  // Wiring
  check(/document\.addEventListener\('visibilitychange', \(\) => \{ if \(document\.visibilityState === 'hidden'\) savePlace\(\); \}\);\s*window\.addEventListener\('pagehide', savePlace\);/.test(app), 'the place is saved when the app is hidden or closed');
  check(/state\.open = id;\s*try \{ localStorage\.setItem\(PLACE_KEY, JSON\.stringify\(\{ kind: 'chat', id, at: Date\.now\(\) \}\)\); \} catch \{\}/.test(app), 'opening a session records it');
  check(/const userMoved = navTouched !== bootTouched \|\| !!visibleSheetId\(\) \|\| !!state\.open;\s*if \(userMoved\) \{[^}]*\}\s*else if \(want\) openChat\(want\);\s*else firstScreen\(bootTouched\)/.test(app), 'boot: a ?s= link first, else firstScreen, only if nothing moved');
  check(!/boardWaiting/.test(app) && !/boardWaiting/.test(P('board-ui.js')) && !/relaymote\.lastChat/.test(app), 'the Board-first rule and its old key are gone');

  // The connection dot (no session open): green when the stream is up and Desktop answers.
  {
    const a = app.indexOf('function connState()'), b = app.indexOf('function noteLinkState(');
    const dot = { className: '', parentElement: { title: '' } };
    const c = { state: { open: null, es: null, esLastEvent: 0, boot: { cdp: true } }, $: () => dot, Date };
    vm.createContext(c);
    vm.runInContext(app.slice(a, b) + '\nthis.paint = paintConnDot;', c);
    c.paint();
    const off = dot.className;
    c.state.es = { readyState: 1 }; c.state.esLastEvent = Date.now(); c.paint();
    const ok = dot.className;
    c.state.boot.cdp = false; c.paint();
    const down = dot.className;
    c.state.open = 'x'; dot.className = 'dot running'; c.paint();
    check(off === 'dot ' && ok === 'dot linked' && down === 'dot err' && dot.className === 'dot running', 'dot: grey connecting, GREEN connected, red when Desktop is down; a session keeps its own dot', { off, ok, down });
    check(/\.dot\.linked\{background:var\(--ok\)\}/.test(P('style.css')), 'the green is the --ok colour');
    // The first cut used `.live`, a standalone rule (the status line) whose padding stretched the dot into an oval.
    check(!/^\.linked\s*[{[:]/m.test(P('style.css')) && /^\.live\{[^}]*padding/m.test(P('style.css')), 'the green class has no standalone rule of its own (".live" does, and made the dot an oval)');
    check(/es\.onopen = \(\) => \{ state\.esLastEvent = Date\.now\(\); paintConnDot\(\); \};/.test(app) && /setInterval\(\(\) => \{\s*paintConnDot\(\);/.test(app), 'the dot is repainted on connect and every 10 s');
  }

  // Install markup: the manifest only in a secure context.
  check(!/<link rel="manifest"/.test(html) && !/<meta name="mobile-web-app-capable"/.test(html)
    && /if\(!window\.isSecureContext\)return;[\s\S]*?l\.rel='manifest'/.test(html), 'over plain http there is no manifest (Add to Home screen makes a shortcut); over https it is added');

  console.log(failed ? `\n${failed} check(s) failed` : '\nall first-screen checks passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
