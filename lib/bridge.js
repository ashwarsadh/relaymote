'use strict';
const http = require('http');
const path = require('path');

let WebSocket = null;
try { WebSocket = require('ws'); } catch {}

const PIN = '__relaymoteLSM';

function wsUrl() {
  return new Promise((res, rej) => {
    const req = http.get(`http://127.0.0.1:${require("./config").get().cdpPort}/json`, r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => { try { const t = JSON.parse(d); t.length ? res(t[0].webSocketDebuggerUrl) : rej(new Error('no cdp targets')); } catch (e) { rej(e); } });
    });
    req.on('error', rej);
    req.setTimeout(4000, () => { req.destroy(new Error('cdp probe timeout')); });
  });
}

function connectRaw(url, evalTimeout = 20000) {
  return new Promise((res, rej) => {
    if (!WebSocket) return rej(new Error('ws module unavailable'));
    const sock = new WebSocket(url); let id = 0; const pend = new Map();
    const timer = setTimeout(() => rej(new Error('cdp connect timeout')), 8000);
    sock.on('open', () => {
      clearTimeout(timer);
      const call = (method, params = {}) => new Promise((rs, rj) => {
        const mid = ++id; pend.set(mid, { rs, rj });
        setTimeout(() => { if (pend.has(mid)) { pend.delete(mid); rj(new Error('cdp timeout: ' + method)); } }, evalTimeout);
        sock.send(JSON.stringify({ id: mid, method, params }));
      });
      res({
        call,
        evaluate: (expression, extra = {}) => call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, ...extra }),
        close: () => { try { sock.close(); } catch {} },
      });
    });
    sock.on('message', raw => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.id === undefined) return;
      const p = pend.get(m.id); if (!p) return; pend.delete(m.id);
      if (m.error) return p.rj(new Error(m.error.message || JSON.stringify(m.error)));
      p.rs(m.result);
    });
    sock.on('error', e => { clearTimeout(timer); rej(e); });
  });
}

const looksLikeManager = `(function(o){ try {
  if(!(o && typeof o==='object' && o.sessions instanceof Map && typeof o.sendMessage==='function' && typeof o.saveSession==='function')) return false;
  if(o.sessions.size===0) return false;
  var it=o.sessions.keys(); for(var k=it.next(); !k.done; k=it.next()){ if(String(k.value).indexOf('local_')===0) return true; }
  return false;
} catch(e){ return false; } })`;

async function locate(conn, opts = {}) {
  const pinned = await conn.evaluate(`(function(){ var o=globalThis.${PIN}; return ${looksLikeManager}(o) ? 'pinned:'+o.sessions.size : ''; })()`);
  if (pinned.result && pinned.result.value) return { found: true, via: 'pinned', sessions: Number(String(pinned.result.value).split(':')[1]) };

  const roots = await conn.evaluate(`(function(){
    var e=process.mainModule.require('electron'); var out=[];
    try { var h=e.ipcMain._invokeHandlers; if(h) h.forEach(function(fn,k){ out.push(['ipc-invoke:'+k, fn]); }); } catch(x){}
    try { e.ipcMain.eventNames().forEach(function(k){ e.ipcMain.listeners(k).forEach(function(fn,i){ out.push(['ipc-on:'+String(k)+'#'+i, fn]); }); }); } catch(x){}
    try { e.app.eventNames().forEach(function(k){ e.app.listeners(k).forEach(function(fn,i){ out.push(['app:'+String(k)+'#'+i, fn]); }); }); } catch(x){}
    try { process.eventNames().forEach(function(k){ process.listeners(k).forEach(function(fn,i){ out.push(['process:'+String(k)+'#'+i, fn]); }); }); } catch(x){}
    globalThis.__relaymoteRoots = out;
    return out.length;
  })()`);
  const nRoots = roots.result && roots.result.value;
  if (!nRoots) return { found: false, reason: 'no roots' };

  const queue = [];
  const seen = new Set();
  const maxVisits = opts.maxVisits || 400;
  const rootsObj = await conn.call('Runtime.evaluate', { expression: 'globalThis.__relaymoteRoots', returnByValue: false });
  const rootsProps = await conn.call('Runtime.getProperties', { objectId: rootsObj.result.objectId, ownProperties: true });
  for (const p of rootsProps.result) {
    if (!/^\d+$/.test(p.name) || !p.value || !p.value.objectId) continue;
    const pair = await conn.call('Runtime.getProperties', { objectId: p.value.objectId, ownProperties: true });
    const label = (pair.result.find(x => x.name === '0') || {}).value;
    const fn = (pair.result.find(x => x.name === '1') || {}).value;
    if (fn && fn.objectId) queue.push({ objectId: fn.objectId, via: label ? label.value : '?', depth: 0 });
  }

  let visits = 0;
  while (queue.length && visits < maxVisits) {
    const item = queue.shift();
    visits++;
    let props;
    try { props = await conn.call('Runtime.getProperties', { objectId: item.objectId, ownProperties: true }); } catch { continue; }
    const scopes = (props.internalProperties || []).find(x => x.name === '[[Scopes]]');
    if (!scopes || !scopes.value || !scopes.value.objectId) continue;
    let scopeList;
    try { scopeList = await conn.call('Runtime.getProperties', { objectId: scopes.value.objectId, ownProperties: true }); } catch { continue; }
    for (const sc of scopeList.result) {
      if (!sc.value || !sc.value.objectId) continue;
      if (/Global/.test(sc.value.description || '')) continue;
      let vars;
      try { vars = await conn.call('Runtime.getProperties', { objectId: sc.value.objectId, ownProperties: true }); } catch { continue; }
      for (const v of vars.result) {
        const val = v.value;
        if (!val || !val.objectId) continue;
        if (val.type === 'object') {
          const key = val.objectId;
          if (seen.has(key)) continue;
          seen.add(key);
          let test;
          try {
            test = await conn.call('Runtime.callFunctionOn', { objectId: val.objectId, functionDeclaration: `function(){ return ${looksLikeManager}(this) ? this.sessions.size : -1; }`, returnByValue: true });
          } catch { continue; }
          if (test.result && typeof test.result.value === 'number' && test.result.value >= 0) {
            await conn.call('Runtime.callFunctionOn', { objectId: val.objectId, functionDeclaration: `function(){ globalThis.${PIN}=this; return 1; }`, returnByValue: true });
            return { found: true, via: `${item.via} -> scope var "${v.name}" (depth ${item.depth}, ${visits} functions visited)`, sessions: test.result.value };
          }
          if (item.depth < 3) {
            let sub;
            try { sub = await conn.call('Runtime.getProperties', { objectId: val.objectId, ownProperties: true }); } catch { continue; }
            for (const s of sub.result.slice(0, 80)) {
              const sv = s.value;
              if (!sv || !sv.objectId) continue;
              if (sv.type === 'object' && !seen.has(sv.objectId)) {
                seen.add(sv.objectId);
                let t2;
                try { t2 = await conn.call('Runtime.callFunctionOn', { objectId: sv.objectId, functionDeclaration: `function(){ return ${looksLikeManager}(this) ? this.sessions.size : -1; }`, returnByValue: true }); } catch { continue; }
                if (t2.result && typeof t2.result.value === 'number' && t2.result.value >= 0) {
                  await conn.call('Runtime.callFunctionOn', { objectId: sv.objectId, functionDeclaration: `function(){ globalThis.${PIN}=this; return 1; }`, returnByValue: true });
                  return { found: true, via: `${item.via} -> scope var "${v.name}".${s.name} (depth ${item.depth}, ${visits} functions visited)`, sessions: t2.result.value };
                }
              }
            }
          }
        } else if (val.type === 'function' && item.depth < 4) {
          if (seen.has(val.objectId)) continue;
          seen.add(val.objectId);
          queue.push({ objectId: val.objectId, via: item.via, depth: item.depth + 1 });
        }
      }
    }
  }
  return { found: false, reason: `manager not found after visiting ${visits} functions from ${nRoots} roots` };
}

async function probe(opts = {}) {
  const conn = await connectRaw(await wsUrl(), 30000);
  try {
    const t0 = Date.now();
    const r = await locate(conn, opts);
    return { ...r, ms: Date.now() - t0 };
  } finally { conn.close(); }
}

async function sessionState(sessionId) {
  const conn = await connectRaw(await wsUrl());
  try {
    const loc = await locate(conn);
    if (!loc.found) return { ok: false, error: 'NO_BRIDGE', reason: loc.reason };
    const r = await conn.evaluate(`(function(){
      var m=globalThis.${PIN}; var s=m.sessions.get(${JSON.stringify(sessionId)});
      if(!s) return JSON.stringify({ok:false,error:'NO_SUCH_SESSION'});
      var keys=Object.keys(s);
      var pick={};
      ['isRunning','isArchived','title','error','errorAt','cwd','model','lastActivityAt','completedTurns','interruptedByQuitAt'].forEach(function(k){ if(s[k]!==undefined) pick[k]=s[k]; });
      pick.hasQuery=!!s.query; pick.hasPendingCycle=!!s.pendingCycle;
      var q=null; try { q = typeof m.hasPendingUserInput==='function' ? !!m.hasPendingUserInput(s) : null; } catch(e){ q='err:'+e.message; }
      pick.pendingUserInput=q;
      pick.keys=keys.filter(function(k){ return /queue|pending|draft|interrupt|error/i.test(k); });
      return JSON.stringify({ok:true, session:pick});
    })()`);
    return JSON.parse(r.result.value);
  } finally { conn.close(); }
}

async function sendMessage(sessionId, text, opts = {}) {
  if (!sessionId) return { ok: false, error: 'NO_SESSION_ID' };
  if (!String(text || '').trim()) return { ok: false, error: 'EMPTY_MESSAGE' };
  // g551: model/effort to Settings › New session before the wake, unless the user changed it recently.
  let tier = null;
  if (opts.tier !== false) {
    tier = await Promise.race([require('./tier-policy').beforeWake(sessionId).catch(e => ({ ok: false, error: String(e && e.message || e) })),
                               new Promise(r => setTimeout(() => r({ ok: false, skipped: 'TIMEOUT' }), 8000))]);
  }
  const conn = await connectRaw(await wsUrl(), 45000);
  try {
    const loc = await locate(conn);
    if (!loc.found) return { ok: false, error: 'NO_BRIDGE', reason: loc.reason, via: 'bridge' };
    const origin = opts.origin || { kind: 'auto-continuation' };
    const initiator = opts.initiator || 'baton-resume';
    const r = await conn.evaluate(`(async function(){
      var m=globalThis.${PIN}; var s=m.sessions.get(${JSON.stringify(sessionId)});
      if(!s) return JSON.stringify({ok:false,error:'NO_SUCH_SESSION'});
      if(s.isArchived) return JSON.stringify({ok:false,error:'ARCHIVED'});
      try {
        var res = await m.sendMessage(${JSON.stringify(sessionId)}, ${JSON.stringify(String(text))}, undefined, { origin: ${JSON.stringify(origin)}, initiator: ${JSON.stringify(initiator)} ${opts.priority ? ', priority: ' + JSON.stringify(opts.priority) : ''} });
        return JSON.stringify({ok: !!(res && res.delivered), delivered: !!(res && res.delivered), queued: !!(res && res.queued), pending: !!(res && res.pending), reason: res && res.reason, raw: res});
      } catch(e) { return JSON.stringify({ok:false, error:'SEND_THREW', reason: String(e && e.message || e)}); }
    })()`);
    const out = JSON.parse(r.result.value);
    return { ...out, via: 'bridge', sessionId, ...(tier ? { tier } : {}) };
  } finally { conn.close(); }
}

async function listStates(ids) {
  const conn = await connectRaw(await wsUrl(), 30000);
  try {
    const loc = await locate(conn);
    if (!loc.found) throw new Error('NO_BRIDGE: ' + loc.reason);
    const r = await conn.evaluate(`(function(){
      var m=globalThis.${PIN}; var want=${ids ? JSON.stringify(ids) : 'null'}; var out={};
      m.sessions.forEach(function(s,id){
        if(want && want.indexOf(id)<0) return;
        var o={isRunning:!!s.isRunning,isArchived:!!s.isArchived,error:s.error||null,errorAt:s.errorAt||null};
        try { if(typeof m.willSelfResume==='function'){ var w=m.willSelfResume(s); o.willSelfResume=!!w; if(w && typeof m.selfResumeReason==='function'){ try{ o.selfResumeReason=String(m.selfResumeReason(s)); }catch(e){} } } } catch(e){ o.willSelfResume=null; }
        try { if(typeof m.hasPendingUserInput==='function') o.pendingUserInput=!!m.hasPendingUserInput(s); } catch(e){}
        out[id]=o;
      });
      return JSON.stringify(out);
    })()`);
    return JSON.parse(r.result.value);
  } finally { conn.close(); }
}

async function desktopProcess() {
  const conn = await connectRaw(await wsUrl());
  try {
    const r = await conn.evaluate(`JSON.stringify({pid:process.pid, uptimeSec:Math.round(process.uptime()), startedAt: Date.now()-Math.round(process.uptime()*1000)})`);
    return JSON.parse(r.result.value);
  } finally { conn.close(); }
}

module.exports = { probe, locate, sendMessage, sessionState, listStates, desktopProcess, connectRaw, wsUrl, PIN };
