'use strict';

const desktop = require('./desktop');
const bridge = require('./bridge');

const MAX_CONDITION = 4000;
const CLEAR_WORDS = ['clear', 'stop', 'off', 'reset', 'none', 'cancel'];
const DEFAULT_WAIT_MS = 15 * 60 * 1000;
const MAX_WAIT_MS = 60 * 60 * 1000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const PHASE1_CAP_MS = 90 * 1000;
function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('RELAYMOTE_TIMEOUT:' + label)), ms); }),
  ]);
}

const ANCHOR_SEL = 'span.slash-command-menu-anchor, span.suggestion';

async function typeSlashCommand(conn, CID, sessionId, cmd, rest) {
  const ev = js => conn.evaluate(desktop.rEval(CID, js));
  const q = s => JSON.stringify(String(s));

  const cleared = await ev(`(function(){
    var el=window.__relaymoteComposer;
    if(!el || !el.isConnected || !el.editor) return 'no-editor';
    if(location.href.split('/').pop() !== ${q(sessionId)}) return 'nav-lost';
    el.editor.commands.focus();
    el.editor.commands.clearContent();
    return 'ok';
  })()`);
  if (cleared !== 'ok') return { ok: false, result: cleared };

  let menuSaw = null, recognised = false;
  for (let pass = 0; pass < 3 && !recognised; pass++) {
    if (pass) await sleep(700);
    await ev(`(function(){
      var el=window.__relaymoteComposer;
      if(!el || !el.editor) return 'no-editor';
      el.editor.commands.focus();
      el.editor.commands.clearContent();
      return 1;
    })()`);
    await ev(`(function(){
      var el=window.__relaymoteComposer; el.editor.commands.focus();
      document.execCommand('insertText', false, ${q('/' + cmd)});
      return 1;
    })()`);
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !recognised) {
      await sleep(150);
      const raw = await ev(`(function(){
        var pops=Array.from(document.querySelectorAll('[role="menu"],[role="listbox"]'))
          .filter(function(e){ var r=e.getBoundingClientRect(); return r.width>0 && r.height>0; });
        if(!pops.length) return JSON.stringify({open:false});
        var items=[];
        pops.forEach(function(p){
          Array.prototype.forEach.call(p.querySelectorAll('[role="menuitem"],[role="option"]'), function(it){
            items.push({t:(it.textContent||'').trim(), hi: it.hasAttribute('data-highlighted')});
          });
        });
        return JSON.stringify({open:true, items:items.slice(0,25)});
      })()`);
      let m; try { m = JSON.parse(raw); } catch { m = { open: false }; }
      if (m.open && m.items && m.items.length) {
        menuSaw = m.items;
        if (m.items.some(x => x.t === cmd)) recognised = true;
      }
    }
  }

  await ev(`(function(){
    var el=window.__relaymoteComposer; el.editor.commands.focus();
    document.execCommand('insertText', false, ' ');
    return 1;
  })()`);
  await sleep(250);

  const anchoredRaw = await ev(`(function(){
    var el=window.__relaymoteComposer;
    if(!el || !el.isConnected) return JSON.stringify({});
    var a=el.querySelector(${q(ANCHOR_SEL)});
    return JSON.stringify({ anchored:!!a, anchorText:a?(a.textContent||''):null });
  })()`);
  let anc; try { anc = JSON.parse(anchoredRaw); } catch { anc = {}; }

  const line = String(rest || '').replace(/\s+/g, ' ').trim();
  if (line) {
    await ev(`(function(){
      var el=window.__relaymoteComposer; el.editor.commands.focus();
      document.execCommand('insertText', false, ${q(line)});
      return 1;
    })()`);
    await sleep(200);
  }

  const raw = await ev(`(function(){
    var el=window.__relaymoteComposer;
    if(!el || !el.isConnected) return JSON.stringify({text:null, gone:1});
    if(location.href.split('/').pop() !== ${q(sessionId)}) return JSON.stringify({nav:'lost'});
    return JSON.stringify({ text:(el.textContent||'') });
  })()`);
  let st; try { st = JSON.parse(raw); } catch { st = {}; }
  if (st.nav === 'lost') return { ok: false, result: 'nav-lost' };

  const want = ('/' + cmd + ' ' + line).trim();
  const got = String(st.text || '').trim();
  const result = !recognised ? 'command-not-offered'
    : !anc.anchored ? 'not-anchored'
    : got !== want ? 'text-mismatch'
    : 'ready';
  return {
    ok: result === 'ready', result, text: got, want,
    anchored: !!anc.anchored, anchorText: anc.anchorText, recognised,
    menuSaw: menuSaw ? menuSaw.map(x => x.t).slice(0, 12) : null,
  };
}

async function pressSend(conn, CID, sessionId) {
  const ev = js => conn.evaluate(desktop.rEval(CID, js));
  const q = s => JSON.stringify(String(s));
  const ready = await ev(`(async function(){
    var el=window.__relaymoteComposer;
    if(!el || !el.isConnected) return 'no-editor';
    if(location.href.split('/').pop() !== ${q(sessionId)}) return 'nav-lost';
    var b=null;
    for(var i=0;i<20;i++){
      await new Promise(function(r){setTimeout(r,100);});
      b=window.__relaymoteLiveBtn('Send');
      if(b && !b.disabled) break;
    }
    if(location.href.split('/').pop() !== ${q(sessionId)}) return 'nav-lost';
    if(b && !b.disabled){ window.__relaymoteGoalSendBtn=b; return 'ready'; }
    return 'blocked';
  })()`);
  if (ready !== 'ready') return { ok: false, result: ready };

  const fired = await ev(`(function(){
    var b=window.__relaymoteGoalSendBtn; window.__relaymoteGoalSendBtn=null;
    if(!b || !b.isConnected) return 'gone';
    if(location.href.split('/').pop() !== ${q(sessionId)}) return 'nav-lost';
    setTimeout(function(){ try{ b.click(); }catch(e){} }, 0);
    return 'fired';
  })()`);
  if (fired !== 'fired') return { ok: false, result: fired };

  for (let i = 0; i < 30; i++) {
    await sleep(300);
    const done = await ev(`(function(){
      var el=window.__relaymoteComposer;
      var empty = !el || !el.textContent || !el.textContent.trim();
      var queued = !!(window.__relaymoteLiveBtn && window.__relaymoteLiveBtn('Remove queued message'));
      return (empty || queued) ? 'yes' : 'no';
    })()`);
    if (done === 'yes') return { ok: true, result: 'sent' };
  }
  return { ok: false, result: 'unconfirmed' };
}

async function readGoalOutputs(sessionId) {
  let conn;
  try { conn = await bridge.connectRaw(await bridge.wsUrl()); }
  catch (e) { return { ok: false, error: 'NO_BRIDGE', reason: e.message }; }
  try {
    const loc = await bridge.locate(conn);
    if (!loc.found) return { ok: false, error: 'NO_BRIDGE', reason: loc.reason };
    const r = await conn.evaluate(`(function(){
      var m = globalThis.${bridge.PIN};
      var s = m.sessions.get(${JSON.stringify(sessionId)});
      if (!s) return JSON.stringify({ok:false, error:'NO_SUCH_SESSION'});
      var b = s.messageBuffer || [];
      var out = [];
      for (var i = 0; i < b.length; i++) {
        var e = b[i];
        if (!e || e.type !== 'assistant' || !e.message || e.message.model !== '<synthetic>') continue;
        var c = e.message.content || [], txt = '';
        for (var j = 0; j < c.length; j++) if (c[j] && c[j].type === 'text') txt += c[j].text;
        txt = txt.trim();
        if (!txt) continue;
        out.push({ uuid: e.uuid || (i + ':' + txt.length), at: e.timestamp || null, text: txt });
      }
      return JSON.stringify({ok:true, isRunning: !!s.isRunning, lines: out.slice(-60)});
    })()`);
    return JSON.parse(r.result.value);
  } catch (e) {
    return { ok: false, error: 'BRIDGE_THREW', reason: e.message };
  } finally { try { conn.close(); } catch {} }
}

const norm = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

function classifyVerdict(lines, action, condition) {
  const want = norm(condition);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = String(lines[i] || '').replace(/`/g, '').trim();
    if (/^No goal set\b/i.test(line) && (/Usage:\s*\/goal/i.test(line) || action !== 'set')) {
      return { state: 'none', verdict: line, why: 'app reported no goal set' };
    }
    const act = line.match(/^Goal active:\s*(.*?)\s*\(([^)]*)\)\s*$/i);
    if (act && (!want || norm(act[1]) === want)) return { state: 'active', verdict: line, why: 'app reported the goal active' };
    const cleared = line.match(/^Goal cleared:\s*(.*)$/i);
    if (cleared && (!want || norm(cleared[1]) === want)) return { state: 'cleared', verdict: line, why: 'app confirmed the clear' };
    const set = line.match(/^Goal set:\s*(.*)$/i);
    if (set && want && norm(set[1]) === want) return { state: 'active', verdict: line, why: 'app confirmed the goal was set' };
    if (/^Goal (achieved|met)\b/i.test(line)) return { state: 'achieved', verdict: line, why: 'the evaluator judged it met' };
  }
  return { state: null, verdict: null,
           why: lines.length ? 'the app printed goal output, but none of it matched the command we sent' : 'the app printed no goal output' };
}

async function runGoalCommandOnce(sessionId, arg, opts = {}) {
  if (!sessionId) return { ok: false, result: 'NO_SESSION_ID' };
  const condition = String(arg == null ? '' : arg).replace(/\s+/g, ' ').trim();
  if (condition.length > MAX_CONDITION) {
    return { ok: false, result: 'CONDITION_TOO_LONG', detail: `${condition.length} > ${MAX_CONDITION}` };
  }
  const action = !condition ? 'status' : CLEAR_WORDS.includes(condition.toLowerCase()) ? 'clear' : 'set';
  const waitMs = Number(opts.waitMs) > 0 ? Math.min(Number(opts.waitMs), MAX_WAIT_MS) : DEFAULT_WAIT_MS;
  const marks = [];
  const at = async (n, fn) => { const t = Date.now(); try { return await fn(); } finally { marks.push(`${n} ${Date.now() - t}ms`); } };

  const pre = await at('read-before', () => readGoalOutputs(sessionId));
  if (!pre.ok) {
    return { ok: false, result: pre.error === 'NO_SUCH_SESSION' ? 'no-such-session' : 'cannot-verify', sessionId, marks,
             message: pre.error === 'NO_SUCH_SESSION'
               ? 'No such session in the desktop app.'
               : `The app's message bridge could not be reached (${pre.error}: ${pre.reason}), so nothing could be PROVEN about a goal. Refusing to type a command whose result cannot be read back.` };
  }
  const seen = new Set(pre.lines.map(l => l.uuid));

  const conn = await desktop.connect(await desktop.wsUrl(), { evalTimeout: 20000 });
  let CID = null, original = null, queuedBehindTurn = false;
  const wipe = async () => {
    await conn.evaluate(desktop.rEval(CID, `(function(){ try{ window.__relaymoteComposer.editor.commands.clearContent(); }catch(e){} return 1; })()`)).catch(() => {});
  };
  let givenBack = false;
  const giveBack = async () => {
    givenBack = true;
    await desktop.releaseComposer(conn, CID).catch(() => {});
    if (original) await desktop.restoreActive(conn, CID, original).catch(() => {});
  };
  let typed = null;
  try {
    CID = await at('pick-window', () => desktop.pickChat(conn));
    const open = await at('open-session', () => desktop.ensureSessionOpen(conn, CID, sessionId, opts.openOpts || {}));
    if (!open.ok) return { ok: false, result: open.error || 'nav-failed', sessionId, detail: open, marks };
    original = open.restore || null;

    await at('dismiss-menus', () => desktop.dismissStrayMenus(conn, CID));
    const park = await at('park-composer', () => desktop.parkComposer(conn, CID, sessionId));
    if (park !== 'ok') {
      const cover = desktop.classifyCover(park);
      if (original) await desktop.restoreActive(conn, CID, original).catch(() => {});
      return { ok: false, result: cover ? cover.result : park, blockerText: cover && cover.blockerText, sessionId, marks };
    }

    const busyAtType = await conn.evaluate(desktop.rEval(CID, `(function(){
      if(window.__relaymoteLiveBtn('Remove queued message')) return 'queued';
      return window.__relaymoteLiveBtn('Stop') ? 'busy' : 'idle';
    })()`));
    queuedBehindTurn = busyAtType === 'busy';
    if (busyAtType === 'queued') {
      await giveBack();
      return { ok: false, result: 'queue-occupied', sessionId, marks,
               message: 'Another message is already queued in that session and the app has only one queue slot, so sending now would silently replace it. Retry shortly.' };
    }
    if (busyAtType === 'busy' && opts.noQueue) {
      await giveBack();
      return { ok: false, result: 'busy', sessionId, marks, message: 'The session is mid-turn and noQueue was set.' };
    }

    typed = await at('type', () => typeSlashCommand(conn, CID, sessionId, 'goal', condition));
    if (!typed.ok) { await wipe(); await giveBack(); return { ok: false, result: typed.result, sessionId, typed, marks }; }

    if (opts.dryRun) {
      await wipe(); await giveBack();
      return { ok: true, result: 'dry-run', dryRun: true, sessionId, typed, queuedBehindTurn, marks,
               note: 'Composed and recognised as a command; nothing was sent.' };
    }

    const sent = await at('send', () => pressSend(conn, CID, sessionId));
    if (!sent.ok) { await wipe(); await giveBack(); return { ok: false, result: sent.result, sessionId, typed, marks }; }
    await giveBack();
  } finally {
    if (!givenBack && original) await desktop.restoreActive(conn, CID, original).catch(() => {});
    conn.close();
  }

  const t0 = Date.now();
  let verdict = { state: null, verdict: null, why: 'not read yet' };
  let running = null;
  while (Date.now() - t0 < waitMs) {
    await sleep(queuedBehindTurn ? 3000 : 900);
    const now = await readGoalOutputs(sessionId);
    if (!now.ok) continue;
    running = now.isRunning;
    const fresh = now.lines.filter(l => !seen.has(l.uuid)).map(l => l.text);
    verdict = classifyVerdict(fresh, action, action === 'set' ? condition : '');
    if (verdict.state) break;
  }
  marks.push(`prove ${Date.now() - t0}ms`);

  if (!verdict.state) {
    const stillWaiting = queuedBehindTurn && running;
    return { ok: false, result: stillWaiting ? 'pending' : 'unverified', sessionId, typed, queuedBehindTurn,
             waitedMs: Date.now() - t0, stillRunning: running, marks,
             message: stillWaiting
               ? `The command was sent and is queued behind a turn still running after ${Math.round((Date.now() - t0) / 1000)}s, so the app has not answered yet. It is NOT known whether the goal is set. Do NOT send it again — poll with action:"status" once that turn ends, or call again with a larger wait_ms.`
               : `The command was typed and sent${queuedBehindTurn ? ' (queued behind a running turn)' : ''}, but the app printed no matching "Goal set/active/cleared" output within ${Math.round(waitMs / 1000)}s: ${verdict.why}. Treat the goal as NOT set.` };
  }
  return { ok: true, result: verdict.state, sessionId, typed, verdict: verdict.verdict, why: verdict.why,
           goalActive: verdict.state === 'active', queuedBehindTurn, waitedMs: Date.now() - t0, marks };
}

const RETRYABLE = new Set(['command-not-offered', 'nav-lost', 'no-editor', 'gone', 'text-mismatch',
  'not-anchored', 'renderer-error', 'blocked', 'unconfirmed', 'busy', 'queue-occupied',
  'nav-failed', 'ui-timeout']);

async function runGoalCommand(sessionId, arg, opts = {}) {
  const budgetMs = Number(opts.waitMs) > 0 ? Math.min(Number(opts.waitMs), MAX_WAIT_MS) : DEFAULT_WAIT_MS;
  const backoffs = [2000, 5000, 10000, 20000, 30000];
  const maxAttempts = opts.dryRun ? 3 : (Number(opts.maxAttempts) > 0 ? Number(opts.maxAttempts) : 5);
  const t0 = Date.now();
  const tried = [];
  let last = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      last = await runGoalCommandOnce(sessionId, arg, { ...opts, waitMs: Math.max(30000, budgetMs - (Date.now() - t0)) });
    } catch (e) {
      const msg = String((e && e.message) || e);
      const kind = /Script failed to execute|exceptionId|exceptionDetails/.test(msg) ? 'renderer-error'
        : /eval timeout|cdp connect timeout|RELAYMOTE_TIMEOUT|WebSocket|socket/i.test(msg) ? 'ui-timeout'
        : 'error';
      last = { ok: false, result: kind,
               sessionId, error: msg.slice(0, 400),
               message: 'The page script failed while driving the composer. This is usually a heavy, slow session losing a race; it is retried automatically.' };
    }
    tried.push({ attempt, result: last.result, at: new Date().toISOString() });
    if (last.ok) break;
    if (!RETRYABLE.has(last.result)) break;
    if (attempt >= maxAttempts) break;
    const wait = backoffs[Math.min(attempt - 1, backoffs.length - 1)];
    if (Date.now() - t0 + wait > budgetMs) break;
    await sleep(wait);
  }
  if (tried.length > 1) {
    last.attempts = tried;
    last.attemptCount = tried.length;
    if (!last.ok && !last.message) last.message = `Failed ${tried.length} times (${tried.map(t => t.result).join(', ')}).`;
  }
  return last;
}

async function looksGoaled(sessionId) {
  const r = await readGoalOutputs(sessionId);
  if (!r.ok) return { known: false, active: false };
  for (let i = r.lines.length - 1; i >= 0; i--) {
    const t = String(r.lines[i].text || '').replace(/`/g, '').trim();
    if (/^No goal set\b/i.test(t) || /^Goal (cleared|achieved|met|failed)\b/i.test(t)) return { known: true, active: false };
    if (/^Goal (set|active)\b/i.test(t)) return { known: true, active: true, since: r.lines[i].at, verdict: t };
  }
  return { known: true, active: false };
}

const gate = fn => desktop.gated('goal', fn);

const GATE_WAIT_MS = Number(process.env.RELAYMOTE_GOAL_GATE_WAIT_MS || 25000);
const withGate = opts => ({ idleMaxWaitMs: GATE_WAIT_MS, ...opts });

const setGoalGated = gate((sessionId, condition, opts = {}) =>
  String(condition || '').trim()
    ? runGoalCommand(sessionId, condition, opts)
    : Promise.resolve({ ok: false, result: 'EMPTY_CONDITION' }));
const setGoal = (sessionId, condition, opts = {}) => setGoalGated(sessionId, condition, withGate(opts));

const goalStatusGated = gate((sessionId, opts = {}) => runGoalCommand(sessionId, '', opts));
const goalStatus = (sessionId, opts = {}) => goalStatusGated(sessionId, withGate(opts));

const clearGoalGated = gate((sessionId, opts = {}) => runGoalCommand(sessionId, 'clear', opts));
const clearGoal = (sessionId, opts = {}) => clearGoalGated(sessionId, withGate(opts));

module.exports = { setGoal, goalStatus, clearGoal, runGoalCommand, runGoalCommandOnce, typeSlashCommand, pressSend,
                   readGoalOutputs, classifyVerdict, looksGoaled, RETRYABLE,
                   MAX_CONDITION, DEFAULT_WAIT_MS, MAX_WAIT_MS };
