// sidebar-native.js — the organizer's native sidebar path, run against a fake Claude Desktop main process.
// The code lib/sidebar-native.js sends into Desktop is EXECUTED here (node:vm), against a fake LocalSessionManager,
// module cache (LocalSessions dispatcher, mainView, SidebarCommandKind) and window reply handler, so a typo in the
// in-Desktop script fails this test rather than his sidebar. Never talks to Claude Desktop.
'use strict';
const vm = require('vm');
const N = require('../lib/sidebar-native');

let failed = 0;
const check = (ok, name, extra) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra !== undefined ? '  ' + JSON.stringify(extra) : ''}`); if (!ok) failed++; };

// A fake Desktop: sessions, custom groups (id -> name), assignments, nested children, and a window that answers
// each sidebar command on the respondSidebarCommand handler, as Desktop 5.1231 does.
function fakeDesktop({ groups = {}, assign = {}, nested = {}, archived = [], window = true, reply = true, ignoreMove = false } = {}) {
  const sent = [];
  const names = new Map(Object.entries(groups));
  const bySession = new Map(Object.entries(assign));
  const sessions = new Map();
  for (const id of ['local_a', 'local_b', 'local_c', 'local_kid']) sessions.set(id, { isArchived: archived.includes(id) });
  const m = {
    sessions, sendMessage() {}, saveSession() {},
    customGroups: { bySession, names },
    listCustomGroups() { const c = new Map(); for (const g of bySession.values()) c.set(g, (c.get(g) || 0) + 1); return [...names].map(([id, name], order) => ({ id, name, sessionCount: c.get(id) || 0, order })); },
    // As Desktop 5.1231 answers it: {id, name}, not the bare id (13-Nov: the bare-id compare called real moves MOVE_NOT_APPLIED).
    getSessionCustomGroup(id) { const g = bySession.get(id); return g ? { id: g, name: names.get(g) } : null; },
  };
  const handlers = new Map();
  const KEY = '$eipc_message$_x_$_claude.web_$_LocalSessions_$_respondSidebarCommand';
  let respondCalls = 0;
  handlers.set(KEY, () => { respondCalls++; });
  const apply = (rid, cmd) => {
    sent.push(cmd);
    let result;
    if (cmd.kind === 'create_group') { const id = 'cg-' + (names.size + 1); names.set(id, cmd.name); result = { ok: true, groupId: id }; }
    else if (cmd.kind === 'move_sessions') {
      const kid = cmd.sessionIds.find(s => nested[s]);
      if (kid) result = { ok: false, error: `Session ${kid} is nested under ${nested[kid]}, and nested sessions move with their parent. Nothing was moved.` };
      else { if (!ignoreMove) for (const s of cmd.sessionIds) bySession.set(s, cmd.groupId); result = { ok: true, changedCount: cmd.sessionIds.length }; }
    }
    if (reply) setTimeout(() => handlers.get(KEY)({}, rid, result), 5);
  };
  const dispatcher = { dispatchSidebarCommand: (rid, cmd) => {
    if (typeof rid !== 'string' || !/^[0-9a-f-]{36}$/.test(rid)) throw new Error('Argument "requestId" at position 0 to event "sidebarCommand" in interface "LocalSessions" failed to pass validation');
    apply(rid, cmd);
  } };
  const wc = { isDestroyed: () => false, ipc: { _invokeHandlers: handlers } };
  const cache = {
    'x/index.chunk-a.js': { exports: { Uut: { LocalSessions: { getDispatcher: (w) => (window && w === wc ? dispatcher : undefined) } },
                                       BCt: { mainView: { webContents: wc } },
                                       Aft: { CreateGroup: 'create_group', MoveSessions: 'move_sessions' } } },
  };
  const ctx = { console, setTimeout, Promise, JSON, Object, Map, Array, String, Math, Date, Error };
  ctx.globalThis = ctx;
  ctx.crypto = require('crypto');
  ctx.__relaymoteLSM = m;
  ctx.process = { mainModule: { constructor: { _cache: cache }, require: (n) => (n === 'electron' ? { webContents: { getAllWebContents: () => [wc] } } : null) } };
  vm.createContext(ctx);
  const conn = { evaluate: async (expr) => {
    try { const v = await vm.runInContext(expr, ctx); return { result: { value: v } }; }
    catch (e) { return { exceptionDetails: { text: String(e && e.message || e) }, result: {} }; }
  }, close() {} };
  return { conn, sent, m, handlers, KEY, origHandler: handlers.get(KEY), respondCalls: () => respondCalls };
}
const deps = (d, extra = {}) => ({ conn: d.conn, pollMs: 10, maxMs: 300, replyMs: 300, ...extra });

(async () => {
  // 1. The group is missing in the live sidebar (13-Nov: an account switch left 0 groups): it is created, then the move.
  let d = fakeDesktop();
  let r = await N.setGroup('local_a', 'AGO', {}, deps(d));
  check(r.ok && r.created && r.via === 'native', 'a missing group is created, then the session is moved into it', r);
  check(d.m.getSessionCustomGroup('local_a').id === r.groupId && d.m.listCustomGroups()[0].name === 'AGO', 'the live snapshot shows it in the group');
  check(d.sent.map(c => c.kind).join() === 'create_group,move_sessions', 'exactly two commands: create_group then move_sessions', d.sent);
  check(d.handlers.get(d.KEY) === d.origHandler && d.respondCalls() === 2, "Desktop's reply handler is put back and still saw every reply");

  // 2. Existing group, matched by name case-insensitively: no second group.
  d = fakeDesktop({ groups: { 'cg-9': 'Email Analyzer' } });
  r = await N.setGroup('local_b', 'email analyzer', {}, deps(d));
  check(r.ok && !r.created && r.groupId === 'cg-9' && d.sent.length === 1, 'an existing group is used, not duplicated', r);

  // 3. Already there: nothing is sent.
  d = fakeDesktop({ groups: { 'cg-9': 'AGO' }, assign: { local_a: 'cg-9' } });
  r = await N.setGroup('local_a', 'AGO', {}, deps(d));
  check(r.ok && r.unchanged && d.sent.length === 0, 'a session already in the group is left alone', r);

  // 4. Filed by the user in another group: never moved.
  d = fakeDesktop({ groups: { 'cg-1': 'Payments', 'cg-2': 'AGO' }, assign: { local_a: 'cg-1' } });
  r = await N.setGroup('local_a', 'AGO', {}, deps(d));
  check(!r.ok && r.error === 'ALREADY_GROUPED' && r.group === 'Payments' && d.sent.length === 0, 'a session the user filed elsewhere is never moved', r);

  // 5. A nested session: the window refuses, and its words come back.
  d = fakeDesktop({ groups: { 'cg-2': 'AGO' }, nested: { local_kid: 'local_a' } });
  r = await N.setGroup('local_kid', 'AGO', {}, deps(d));
  check(!r.ok && r.error === 'NESTED' && /move with their parent/.test(r.detail), "a nested session reports NESTED with the window's reason", r);

  // 6. Unknown / archived session.
  d = fakeDesktop({ archived: ['local_c'] });
  check((await N.setGroup('local_zzz', 'AGO', {}, deps(d))).error === 'NO_SUCH_SESSION', 'an unknown session: NO_SUCH_SESSION');
  check((await N.setGroup('local_c', 'AGO', {}, deps(d))).error === 'ARCHIVED' && d.sent.length === 0, 'an archived session: ARCHIVED, nothing sent');

  // 7. No window: NO_WINDOW, which is one of the errors that hands over to the menu path.
  d = fakeDesktop({ window: false });
  r = await N.setGroup('local_a', 'AGO', {}, deps(d));
  check(r.error === 'NO_WINDOW' && N.UNAVAILABLE.has(r.error), 'no window: NO_WINDOW, and the caller may fall back to the menus', r);

  // 8. The window took the command but the snapshot never shows it: not called done.
  d = fakeDesktop({ groups: { 'cg-2': 'AGO' }, ignoreMove: true });
  r = await N.setGroup('local_a', 'AGO', {}, deps(d));
  check(!r.ok && r.error === 'MOVE_NOT_APPLIED', 'a move the snapshot does not show is MOVE_NOT_APPLIED, not ok', r);

  // 9. The organizer: NESTED is final (no retry storm); GROUPS_UNKNOWN pauses like the old menu errors.
  const org = require('../lib/organizer');
  check(org.SYSTEMIC_ERRORS.has('GROUPS_UNKNOWN') && !org.SYSTEMIC_ERRORS.has('NESTED'), 'organizer: GROUPS_UNKNOWN pauses the pass, NESTED does not');

  console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log('FAIL the run finished  ' + (e && e.stack || e)); process.exit(1); });
