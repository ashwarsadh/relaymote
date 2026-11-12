// sidebar-native.js — move a session into a sidebar group through Claude Desktop's own sidebar command, not its menus.
//
// 13-Nov-2026: the organizer's menu path failed 274 times in 23 h (VIEW_SWITCH_FAILED / NO_MOVE_TO_GROUP), flipping
// his sidebar view each try. Root cause: Desktop 5.1231 was signed into another account/org scope whose sidebar has
// NO custom groups (his 27 live under the old scope in claude_desktop_config.json), so there was no group to move to.
// This path is the one the ccd_sidebar MCP tools use: the main process sends LocalSessions_$_sidebarCommand
// {kind:'create_group'|'move_sessions', ...} to the window; the window applies it and reports the new group snapshot
// back (LocalSessionManager.customGroups). Nothing is clicked and the sidebar view is never switched. Every change is
// read back from that snapshot before it is called done.
'use strict';
const bridge = require('./bridge');

const wait = (ms) => new Promise(r => setTimeout(r, ms));
const norm = (v) => String(v || '').trim().toLowerCase();

// Runs in Desktop's main process. Finds the window's sidebar dispatcher and the SidebarCommandKind enum by shape
// (export names are minified and change every Desktop build).
const FIND = `(function(){
  var C=process.mainModule&&process.mainModule.constructor, cache=(C&&C._cache)||{}, LS=null, MV=null, KIND=null;
  Object.keys(cache).forEach(function(k){ var ex=cache[k]&&cache[k].exports; if(!ex||typeof ex!=='object') return;
    Object.keys(ex).forEach(function(n){ var v; try{ v=ex[n]; }catch(e){ return; } if(!v||typeof v!=='object') return;
      try{ if(!LS&&v.LocalSessions&&typeof v.LocalSessions.getDispatcher==='function') LS=v.LocalSessions; }catch(e){}
      try{ if(!MV&&('mainView' in v)&&v.mainView&&v.mainView.webContents) MV=v; }catch(e){}
      try{ if(!KIND&&v.MoveSessions==='move_sessions'&&v.CreateGroup) KIND=v; }catch(e){} }); });
  var wc=MV&&MV.mainView.webContents, d=(LS&&wc&&!wc.isDestroyed())?LS.getDispatcher(wc):null;
  return { d: d && typeof d.dispatchSidebarCommand==='function' ? d : null,
           kind: KIND || { MoveSessions:'move_sessions', CreateGroup:'create_group' } };
})()`;

async function run(fnBody, arg, deps = {}) {
  const conn = deps.conn || await bridge.connectRaw(await bridge.wsUrl());
  try {
    const loc = await bridge.locate(conn);
    if (!loc.found) return { error: 'NO_BRIDGE', reason: loc.reason };
    const r = await conn.evaluate(`(async function(){ var m=globalThis.${bridge.PIN}; var S=${FIND}; var A=${JSON.stringify(arg)};
      try { ${fnBody} } catch(e) { return { error:'BRIDGE_ERROR', detail:String(e&&e.message||e) }; } })()`);
    if (!r.result || r.exceptionDetails) return { error: 'BRIDGE_ERROR', detail: JSON.stringify(r).slice(0, 300) };
    return r.result.value || { error: 'BRIDGE_ERROR', detail: 'no value' };
  } finally { if (!deps.conn) conn.close(); }
}

/** Live groups: { groups:[{id,name,sessionCount}], dispatcher:bool } or { error }. groups null = window has not reported. */
async function state(sessionId, deps = {}) {
  return run(`var g=m.listCustomGroups(); return { groups: g ? g.map(function(x){ return {id:x.id,name:x.name,sessionCount:x.sessionCount}; }) : null,
    dispatcher: !!S.d, known: A.id ? m.sessions.has(A.id) : null, archived: !!(A.id && m.sessions.get(A.id) && m.sessions.get(A.id).isArchived),
    // getSessionCustomGroup answers {id, name} (5.1231); older builds answered the bare id.
    group: A.id ? (function(x){ return x && typeof x==='object' ? (x.id || null) : (x || null); })(m.getSessionCustomGroup(A.id)) : null };`, { id: sessionId || null }, deps);
}

// Sends one command and returns the window's own answer ({ok, error?, changedCount?, groupId?}). The answer comes
// back on the window's respondSidebarCommand IPC handler; it is wrapped only for the length of this call (every
// call, ours or Desktop's, still reaches the original) and put back in finally.
async function send(cmd, deps = {}) {
  return run(`if(!S.d) return { error:'NO_WINDOW' };
    var c=Object.assign({}, A.cmd, { kind: S.kind[A.kindKey] }), rid=globalThis.crypto.randomUUID();
    var E=process.mainModule.require('electron'), H=null, K=null;
    E.webContents.getAllWebContents().forEach(function(w){ var h=w.ipc&&w.ipc._invokeHandlers; if(!h||H) return;
      h.forEach(function(fn,k){ if(!K&&/LocalSessions_\\$_respondSidebarCommand$/.test(k)){ H=h; K=k; } }); });
    if(!H) { S.d.dispatchSidebarCommand(rid, c); return { sent:true, reply:null }; }
    var orig=H.get(K), done;
    var got=new Promise(function(res){ done=res; });
    H.set(K, function(ev, id, result){ if(id===rid) done(result); return orig.apply(this, arguments); });
    try { S.d.dispatchSidebarCommand(rid, c);
      var reply=await Promise.race([got, new Promise(function(res){ setTimeout(function(){ res(null); }, A.timeout); })]);
      return { sent:true, reply: reply };
    } finally { if(H.get(K)!==orig) H.set(K, orig); }`,
  { cmd: cmd.body, kindKey: cmd.kindKey, timeout: deps.replyMs || 8000 }, deps);
}

/**
 * Put sessionId into the group named groupName (created first when opts.create !== false).
 * Never moves a session that is already in a different group. Returns { ok, unchanged?, created?, groupId, via:'native' }
 * or { ok:false, error } — error NO_BRIDGE / NO_WINDOW means "not available here, use the menu path".
 */
async function setGroup(sessionId, groupName, opts = {}, deps = {}) {
  const pollMs = deps.pollMs || 250, maxMs = deps.maxMs || 6000;
  const st = await state(sessionId, deps);
  if (st.error) return { ok: false, error: st.error, detail: st.detail || st.reason, via: 'native' };
  if (!st.dispatcher) return { ok: false, error: 'NO_WINDOW', via: 'native' };
  if (!Array.isArray(st.groups)) return { ok: false, error: 'GROUPS_UNKNOWN', via: 'native' };
  if (!st.known) return { ok: false, error: 'NO_SUCH_SESSION', sessionId, via: 'native' };
  if (st.archived) return { ok: false, error: 'ARCHIVED', sessionId, via: 'native' };
  let g = st.groups.find(x => norm(x.name) === norm(groupName));
  if (st.group) {
    if (g && st.group === g.id) return { ok: true, unchanged: true, sessionId, group: g.name, groupId: g.id, via: 'native' };
    const cur = (st.groups.find(x => x.id === st.group) || {}).name || st.group;
    return { ok: false, error: 'ALREADY_GROUPED', group: cur, sessionId, via: 'native' };
  }
  let created = false;
  if (!g) {
    if (opts.create === false) return { ok: false, error: 'NO_SUCH_GROUP', group: groupName, via: 'native' };
    const s1 = await send({ kindKey: 'CreateGroup', body: { name: String(groupName).trim() } }, deps);
    if (s1.error) return { ok: false, error: s1.error, detail: s1.detail, via: 'native' };
    if (s1.reply && s1.reply.ok === false) return { ok: false, error: 'REFUSED', detail: s1.reply.error, group: groupName, via: 'native' };
    for (let t = 0; t < maxMs && !g; t += pollMs) {
      await wait(pollMs);
      const s = await state(null, deps);
      g = (s.groups || []).find(x => norm(x.name) === norm(groupName));
    }
    if (!g) return { ok: false, error: 'CREATE_NOT_APPLIED', group: groupName, via: 'native' };
    created = true;
  }
  const s2 = await send({ kindKey: 'MoveSessions', body: { sessionIds: [sessionId], groupId: g.id } }, deps);
  if (s2.error) return { ok: false, error: s2.error, detail: s2.detail, via: 'native' };
  if (s2.reply && s2.reply.ok === false) {
    const why = String(s2.reply.error || '');
    // A nested (child) session moves with its parent; the window refuses to move it alone.
    return { ok: false, error: /nested/i.test(why) ? 'NESTED' : 'REFUSED', detail: why, group: g.name, created, via: 'native' };
  }
  for (let t = 0; t < maxMs; t += pollMs) {
    await wait(pollMs);
    const s = await state(sessionId, deps);
    if (s.group === g.id) return { ok: true, sessionId, group: g.name, groupId: g.id, created, via: 'native' };
  }
  return { ok: false, error: 'MOVE_NOT_APPLIED', group: g.name, created, via: 'native' };
}

// Errors meaning "this path is not available here" — the caller may fall back to the menu path.
const UNAVAILABLE = new Set(['NO_BRIDGE', 'NO_WINDOW', 'BRIDGE_ERROR']);

module.exports = { setGroup, state, send, UNAVAILABLE };
