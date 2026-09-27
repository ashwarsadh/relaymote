#!/usr/bin/env node
'use strict';
const http = require('http');
const registry = require('./lib/registry');
const router = require('./lib/router');
const desktop = require('./lib/desktop');

const PORT = require('./lib/config').get().port;
const args = process.argv.slice(2);
const cmd = (args[0] || 'ls').toLowerCase();

function api(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port: PORT, path, method, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} },
      res => { let s = ''; res.on('data', c => s += c); res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { reject(new Error(s.slice(0, 200))); } }); });
    r.on('error', reject); r.setTimeout(30000, () => r.destroy(new Error('timeout')));
    if (data) r.write(data); r.end();
  });
}

const C = { dim: s => `\x1b[2m${s}\x1b[0m`, b: s => `\x1b[1m${s}\x1b[0m`, g: s => `\x1b[32m${s}\x1b[0m`,
            r: s => `\x1b[31m${s}\x1b[0m`, y: s => `\x1b[33m${s}\x1b[0m`, c: s => `\x1b[36m${s}\x1b[0m` };
const colorStatus = s => s === 'done' ? C.g(s) : s === 'failed' ? C.r(s) : s === 'running' ? C.c(s) : s === 'queued' ? C.y(s) : s;

(async () => {
  switch (cmd) {
    case 'run': case 'do': {
      const prompt = args.slice(1).join(' ');
      if (!prompt) return console.error('usage: relaymote run <task text>');
      const out = await api('POST', '/api/task', { prompt });
      if (!out.ok) return console.error('error:', out.error);
      const t = out.task;
      console.log(`${C.b(t.id)}  ${t.title}`);
      console.log(`  routed -> ${C.c(t.model + '/' + t.effort)}${t.lean ? ' (lean)' : ''}  ${t.type}/${t.complexity}  mode=${t.mode}`);
      if (t.reuseOf) console.log(`  reusing context ${C.dim(t.reuseOf.slice(0, 8))}`);
      break;
    }
    case 'preview': case 'route': {
      const prompt = args.slice(1).join(' ');
      const d = router.route(prompt);
      console.log(`${C.c(d.model + '/' + d.effort)}${d.lean ? ' (lean)' : ''}  mode=${d.mode}  ${d.type}/${d.complexity}  conf=${d.confidence.toFixed(2)}${d.isolate ? '  isolated' : ''}`);
      console.log(C.dim('  ' + d.reason));
      break;
    }
    case 'ls': case 'list': {
      let tasks;
      try { tasks = (await api('GET', '/api/state')).tasks; }
      catch { tasks = registry.allTasks(); console.log(C.dim('(daemon down — reading registry directly)')); }
      if (!tasks.length) return console.log('no tasks');
      console.log(C.b('id     status    model/effort    title'));
      for (const t of tasks.slice(0, 30)) {
        const esc = (t.escalations || []).length ? C.y(` ↑${t.escalations.length}`) : '';
        console.log(`${t.id.padEnd(6)} ${colorStatus(t.status).padEnd(18)} ${String((t.model || '-') + '/' + (t.effort || '-')).padEnd(15)} ${t.title.slice(0, 46)}${esc}`);
        if (t.status === 'failed' && t.error) console.log(C.r('       ! ' + String(t.error).slice(0, 100)));
      }
      break;
    }
    case 'show': {
      const t = registry.getTask(args[1]);
      if (!t) return console.error('no such task');
      console.log(JSON.stringify(t, null, 2));
      break;
    }
    case 'stop': {
      // One task only. Stopping the whole daemon is `relaymote stop` with no id (bin/relaymote.js).
      if (!args[1]) return console.error('usage: relaymote stop <task-id>   (a bare `relaymote stop` stops the daemon)');
      const r = await api('POST', `/api/task/${encodeURIComponent(args[1])}/stop?by=cli`);
      if (r && r.ok && !r.task) return console.error('no such task: ' + args[1]);
      console.log(JSON.stringify(r, null, 2)); break;
    }
    case 'escalate':
      if (!args[1]) return console.error('usage: relaymote escalate <task-id>');
      console.log(JSON.stringify(await api('POST', `/api/task/${encodeURIComponent(args[1])}/escalate`), null, 2)); break;
    case 'prune':     console.log(await api('POST', `/api/prune?days=${args[1] || 14}`)); break;
    case 'health':    console.log(JSON.stringify(await api('GET', '/api/health'), null, 2)); break;
    case 'resume': {
      const sub = (args[1] || 'status').toLowerCase();
      if (sub === 'status') {
        let s; try { s = await api('GET', '/api/resume'); } catch { s = require('./lib/resume').status(); s.daemon = 'unreachable'; }
        console.log(`${C.b('session-limit resume')} ${s.enabled ? C.g('enabled') : C.r('disabled')}  next due: ${s.nextDueAt || C.dim('nothing')}  last run: ${s.lastRunAt || C.dim('never')}`);
        for (const x of s.stuck || []) console.log(`  ${x.due ? C.y('DUE ') : C.dim('wait')} ${x.sessionId}  ${C.b(String(x.title).slice(0, 50))}  ${C.dim(x.error)}  due ${x.dueAt}${x.skip ? '  ' + C.r(x.skip) : ''}`);
        if (!(s.stuck || []).length) console.log(C.dim('  no session is stopped by a usage limit'));
        for (const l of (s.recent || []).slice(0, 8)) console.log(`  ${C.dim(l.at)} ${l.ok ? C.g('RESUMED') : C.r(l.result)} ${l.sessionId} ${String(l.title).slice(0, 40)} ${C.dim(l.mode || '')}`);
        break;
      }
      const ids = args.slice(2).filter(x => !x.startsWith('--'));
      const body = { source: 'cli', session_ids: ids.length ? ids : undefined, force: sub === 'force' || args.includes('--force'),
                     dry_run: args.includes('--dry-run'), idle: args.includes('--no-idle') ? false : undefined, crash: sub === 'crash' };
      console.log(JSON.stringify(await api('POST', '/api/resume', body), null, 2));
      break;
    }
    case 'sessions': {
      const snap = desktop.loadSnapshot();
      if (!snap) return console.log('no snapshot yet (is the daemon running?)');
      const groups = snap.groups || [];
      console.log(C.b(`${snap.sessions.length} sessions in ${groups.length} groups`) + C.dim('  (snapshot ' + snap.at + ')'));
      for (const g of groups) {
        console.log(`\n${C.b(g.group)} ${C.dim('(' + g.sessions.length + ')')}`);
        for (const s of g.sessions.slice(0, 12)) {
          const mark = s.state === 'awaiting_input' ? C.y('● question') : s.state === 'unread' ? C.c('● unread ')
            : s.state === 'running' ? C.g('● running') : s.state === 'archived' ? C.dim('  archived') : C.dim('  idle    ');
          const note = s.doNotOpen ? C.dim('  [protected]') : s.archiveCandidate ? C.dim('  [archivable: ' + s.archiveReason + ']') : '';
          console.log(`  ${mark}  ${String(s.title).slice(0, 52)}${note}`);
        }
      }
      const attn = desktop.needsAttention(snap.sessions);
      if (attn.length) console.log('\n' + C.y(`${attn.length} session(s) need your decision`));
      const arch = snap.sessions.filter(s => s.archiveCandidate);
      if (arch.length) console.log(C.dim(`${arch.length} session(s) eligible for archiving — run: relaymote archivable`));
      break;
    }
    case 'archivable': {
      const snap = desktop.loadSnapshot();
      if (!snap) return console.log('no snapshot');
      const arch = snap.sessions.filter(s => s.archiveCandidate);
      if (!arch.length) return console.log('nothing eligible for archiving');
      console.log(C.b(`${arch.length} archive candidate(s):`));
      for (const s of arch) console.log(`  ${s.sessionId}  ${String(s.title).slice(0, 50)}  ${C.dim(s.archiveReason)}`);
      console.log(C.dim('\nArchiving stops the session and cleans its worktree, so it is NOT done automatically.'));
      console.log(C.dim('Ask Claude to archive these, or use the Desktop UI.'));
      break;
    }
    default:
      console.log(`relaymote — Claude Code orchestrator

  relaymote run <task>        submit a task (auto-routed to model+effort)
  relaymote preview <task>    show the routing decision without spending anything
  relaymote ls                list tasks (works even if the daemon is down)
  relaymote show <id>         full task record
  relaymote stop <id>         kill ONE running worker (a bare "relaymote stop" stops the daemon)
  relaymote escalate <id>     force a task up one rung
  relaymote sessions          Desktop sessions by group, with dots (passive read)
  relaymote archivable        sessions eligible for archiving
  relaymote health            daemon health
  relaymote prune [days]      drop old finished tasks

dashboard (this computer only): http://127.0.0.1:${PORT}/`);
  }
})().catch(e => { console.error('error:', e.message); process.exit(1); });
