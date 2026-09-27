'use strict';
// reaper.js — release the CLI process of a Desktop session that has been idle for hours.
//
// Every open session keeps a CLI process (with its MCP servers) of roughly 400 MB, used or not. After
// three idle hours its 1-hour prompt cache is long cold, so releasing it costs nothing in tokens: the
// next message respawns the CLI with --resume from the transcript, exactly as after an app restart.
//
// HOW: the app's OWN teardown (LocalSessionManager.teardownQuery), reached through the bridge — never
// a process kill. An external kill is a "process loss" the app reports and may try to recover;
// teardown is the path the app takes itself when a query ends, so the session is left the way a
// just-launched app leaves it: record intact, no process.
//
// GUARDS (all must hold, checked inside the app at the moment of release):
//   not running · not awaiting input · CLI provably idle · idle >= idleHours · not unread · no
//   unfinished goal owned by it · not in an await watch (neither the parked master nor anything it
//   waits on) · nothing queued, held or deferred · no background task, cron or wakeup pending · not
//   SSH/WSL · not a scheduled-task session · not archived or stopping · not on Remote Control.
//
// REMOTE CONTROL IS PERMANENT, NOT A SETTING. Teardown CLEARS remoteControlEnabled and bridgeSessionId:
// a released RC session vanishes from the phone, and nothing on the phone can wake it. A message sent
// from the desktop brings it back, but on a NEW bridge id, which orphans the old claude.ai entry. So a
// session with remoteControlEnabled, remoteControlProcess or a bridgeSessionId is never released, and
// no option, flag or caller can change that. (0.2.4 had a spareRemoteControl setting; 0.2.5 removed it.)
//
// MODE: module `reaper` off (default) = nothing runs. On: 'dry' for reaper.dryHours from the daemon's
// first tick (state/reaper.json dryUntil) — it only logs what it WOULD release — then 'live' by itself.
// state/reaper.json mode 'dry' | 'live' | 'off' pins it. Log: state/reaper.jsonl (bounded).
//
//   relaymote reaper [--dry|--live] [session ids]    one pass now, printed
const fs = require('fs');
const path = require('path');
const config = require('./config');
const bridge = require('./bridge');

const DEFAULTS = { idleHours: 3, dryHours: 24, maxPerTick: 6 };
const CFG = () => path.join(config.STATE, 'reaper.json');
const LOG = () => path.join(config.STATE, 'reaper.jsonl');
const TEARDOWN_REASON = 'baton-idle-reaper';

function readJson(f, dflt) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return dflt; } }

function settings() { return { ...DEFAULTS, ...((config.get() || {}).reaper || {}) }; }

/**
 * The effective mode. The dry clock starts at the first tick that may START it (the daemon's), never
 * at a manual CLI run: `startClock` is false for those.
 */
function state(now = Date.now(), { startClock = true } = {}) {
  const s = settings();
  let c = readJson(CFG(), null);
  if (!c && startClock) {
    c = { mode: 'auto', dryUntil: now + s.dryHours * 3600e3, startedAt: new Date(now).toISOString() };
    try { fs.writeFileSync(CFG(), JSON.stringify(c, null, 2)); } catch {}
  }
  c = c || { mode: 'auto', dryUntil: null };
  const mode = c.mode === 'off' ? 'off' : c.mode === 'live' ? 'live' : c.mode === 'dry' ? 'dry'
    : (c.dryUntil && now >= c.dryUntil) ? 'live' : 'dry';
  return { ...s, mode, dryUntil: c.dryUntil || null };
}

function log(row) {
  try {
    fs.appendFileSync(LOG(), JSON.stringify(row) + '\n');
    const lines = fs.readFileSync(LOG(), 'utf8').split('\n').filter(Boolean);
    if (lines.length > 4000) fs.writeFileSync(LOG(), lines.slice(-3000).join('\n') + '\n');
  } catch {}
}

/** Session ids that must never be released for reasons the app itself cannot see. */
function protectedIds() {
  const ids = new Set();
  try {
    const goals = require('./goals');
    for (const g of goals.load().goals || []) {
      if (g && g.ownerSessionId && !goals.FINISHED.includes(g.status)) ids.add(g.ownerSessionId);
    }
  } catch {}
  try {
    for (const w of require('./await').list()) {
      if (w.resolvedAt) continue;
      if (w.masterSessionId) ids.add(w.masterSessionId);
      for (const x of (w.waitingOn || [])) ids.add(typeof x === 'string' ? x : (x && (x.id || x.sessionId)));
    }
  } catch {}
  ids.delete(undefined); ids.delete(null); ids.delete('');
  return ids;
}

// Evaluated inside the Desktop main process. One row per session that HAS a CLI, with the verdict and
// every reason it was spared. `act` releases the ones that pass (live mode only).
const PAGE = (opts) => `(function(){
  var m=globalThis.${bridge.PIN}, o=${JSON.stringify(opts)}, now=Date.now(), out=[], done=0;
  var sz=function(x){ if(!x) return 0; if(typeof x.size==='number') return x.size; if(Array.isArray(x)) return x.length; if(typeof x==='object') return Object.keys(x).length; return 0; };
  m.sessions.forEach(function(s,id){
    if(!s.query) return;
    if(o.only && o.only.indexOf(id)<0) return;
    var why=[];
    if(s.isRunning) why.push('running');
    try{ if(m.hasPendingUserInput(s)) why.push('awaiting-input'); }catch(e){ why.push('input-unknown'); }
    try{ if(!m.isCliProvablyIdle(s)) why.push('cli-not-provably-idle'); }catch(e){ why.push('idle-unknown'); }
    var last=Math.max(s.lastActivityAt||0,s.lastCliMessageAt||0,s.lastWorkFrameAt||0,s.latestUserFrameAt||0);
    var idleH=(now-last)/3600e3;
    if(idleH<o.idleHours) why.push('idle<'+o.idleHours+'h');
    if((s.lastActivityAt||0)>(s.lastFocusedAt||0)+60e3) why.push('unread');
    if(o.protect.indexOf(id)>=0) why.push('goal-or-await');
    if(s.isArchived) why.push('archived');
    if(s.isStopping) why.push('stopping');
    if(sz(s.deferredSends)||sz(s.heldAcrossLoss)||sz(s.heldTurnStarts)||sz(s.heldSteers)) why.push('queued-input');
    if(sz(s.activeBackgroundTasks)||sz(s.activeCronJobs)||sz(s.pendingCronCreates)||s.pendingLoopWakeup||sz(s.pendingScheduleWakeupIds)) why.push('background-work');
    if(s.remoteControlEnabled||s.remoteControlProcess||s.bridgeSessionId) why.push('remote-control');   // PERMANENT, see header
    if(s.sshConfig||s.wslConfig) why.push('ssh-or-wsl');
    if(s.scheduledTaskId) why.push('scheduled-task');
    if(o.self && o.self.indexOf(id)>=0) why.push('self');
    var row={id:id,title:String(s.title||'').slice(0,60),cliPid:s.cliPid||null,idleH:Math.round(idleH*10)/10,why:why,reaped:false};
    if(!why.length && o.act && done<o.max){
      try{ m.teardownQuery(s,'exited',{teardownReason:${JSON.stringify(TEARDOWN_REASON)}}); row.reaped=true; done++;
           try{ m.emitSessionUpdated && m.emitSessionUpdated(s); }catch(e){} }
      catch(e){ row.error=String(e&&e.message||e).slice(0,200); }
    }
    out.push(row);
  });
  return JSON.stringify(out);
})()`;

/** Working set of each CLI plus its whole process tree, in MB. Windows only; elsewhere {} (unknown). */
function memMb(pids) {
  const want = pids.filter(Boolean).map(Number).filter(Number.isFinite);
  if (!want.length || process.platform !== 'win32') return {};
  try {
    const ps = `$k=@{};Get-CimInstance Win32_Process|%{$k[[int]$_.ParentProcessId]+=@($_)};function T($i){$s=0;foreach($c in $k[[int]$i]){$s+=$c.WorkingSetSize+(T $c.ProcessId)};$s};` +
      want.map(p => `$p=Get-Process -Id ${p} -EA SilentlyContinue;if($p){'${p} '+[int](($p.WorkingSet64+(T ${p}))/1MB)}`).join(';');
    const out = require('child_process').execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    const r = {};
    for (const l of out.split(/\r?\n/)) { const [a, b] = l.trim().split(' '); if (a && b) r[a] = Number(b); }
    return r;
  } catch { return {}; }
}

// Runtime.evaluate answers { result: { value }, exceptionDetails? }; a script that threw inside the app
// must fail the pass, never read as "no sessions".
async function run(conn, src) {
  const r = await conn.evaluate(src);
  if (r && r.exceptionDetails) throw new Error('PAGE_THREW: ' + String((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text).slice(0, 300));
  const v = r && r.result && r.result.value;
  if (typeof v !== 'string') throw new Error('PAGE_NO_VALUE: ' + JSON.stringify(r).slice(0, 200));
  return JSON.parse(v);
}

/**
 * One pass. opts.mode overrides the effective mode ('dry'|'live'); opts.only limits it to the given
 * session ids; opts.self = ids never to touch; opts.startClock=false for a manual run.
 */
async function tick(opts = {}) {
  const st = state(Date.now(), { startClock: opts.startClock !== false });
  const mode = opts.mode || st.mode;
  if (mode === 'off') return { mode, clis: 0, eligible: 0, reaped: 0, mb: 0, rows: [] };
  const protect = [...protectedIds()];
  const conn = await bridge.connectRaw(await bridge.wsUrl(), 30000);
  let rows;
  try {
    const loc = await bridge.locate(conn);
    if (!loc.found) throw new Error('NO_BRIDGE: ' + loc.reason);
    const pageOpts = {
      idleHours: Number(opts.idleHours || st.idleHours), protect, only: opts.only || null,
      self: opts.self || [], act: mode === 'live', max: Number(opts.max || st.maxPerTick),
    };
    // Measure before acting: after teardown the pid is gone.
    const pre = await run(conn, PAGE({ ...pageOpts, act: false }));
    const mb = memMb(pre.filter(r => !r.why.length).map(r => r.cliPid));
    rows = mode === 'live' ? await run(conn, PAGE(pageOpts)) : pre;
    for (const r of rows) r.mb = mb[r.cliPid] || null;
  } finally { conn.close(); }
  const at = new Date().toISOString();
  const eligible = rows.filter(r => !r.why.length);
  for (const r of eligible) log({ at, mode, action: mode === 'live' ? (r.reaped ? 'REAPED' : r.error ? 'FAILED' : 'CAPPED') : 'WOULD-REAP', ...r });
  const summary = { at, mode, clis: rows.length, eligible: eligible.length, reaped: rows.filter(r => r.reaped).length,
    mb: eligible.reduce((s, r) => s + (r.mb || 0), 0) };
  log({ at, mode, action: 'TICK', ...summary });
  return { ...summary, rows };
}

function format(r) {
  const lines = r.rows.map(x => `${x.reaped ? 'REAPED' : x.why.length ? 'spare ' : 'ELIG  '} ${x.id.slice(0, 14)} ${String(x.idleH).padStart(5)}h ${String(x.mb || '').padStart(4)}MB ${x.title.slice(0, 40)} ${x.why.join(',')}`);
  lines.push(JSON.stringify({ mode: r.mode, clis: r.clis, eligible: r.eligible, reaped: r.reaped, mb: r.mb }));
  return lines.join('\n');
}

/** `relaymote reaper [--dry|--live] [ids]`: one pass now. Never starts the dry clock. */
async function cli(args) {
  const only = args.filter(x => !x.startsWith('--'));
  const mode = args.includes('--live') ? 'live' : args.includes('--dry') ? 'dry' : undefined;
  if (args.includes('--rc-too')) console.log('--rc-too was removed in 0.2.5: a Remote Control session is never released (it would vanish from the phone).');
  const r = await tick({ mode, startClock: false, only: only.length ? only : null });
  console.log(format(r));
  return r;
}

module.exports = { tick, state, settings, protectedIds, cli, format, DEFAULTS, PAGE, TEARDOWN_REASON };

if (require.main === module) cli(process.argv.slice(2)).catch(e => { console.error('ERR ' + e.message); process.exit(1); });
