#!/usr/bin/env node
// relaymote — command line entry point.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const config = require('../lib/config');
const args = process.argv.slice(2);
const cmd = (args[0] || 'help').toLowerCase();
const WIN = process.platform === 'win32';
const TASK = 'Relaymote';

const C = { b: s => `\x1b[1m${s}\x1b[0m`, g: s => `\x1b[32m${s}\x1b[0m`, r: s => `\x1b[31m${s}\x1b[0m`,
            y: s => `\x1b[33m${s}\x1b[0m`, d: s => `\x1b[2m${s}\x1b[0m`, c: s => `\x1b[36m${s}\x1b[0m` };

function get(port, p, timeout = 3000) {
  return new Promise(resolve => {
    const r = http.get({ host: '127.0.0.1', port, path: p, timeout }, res => {
      let s = ''; res.on('data', c => s += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(s) }); } catch { resolve({ status: res.statusCode, body: s }); } });
    });
    r.on('error', () => resolve(null)); r.on('timeout', () => { r.destroy(); resolve(null); });
  });
}
function post(port, p) {
  return new Promise(resolve => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', timeout: 5000 }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    r.on('error', () => resolve(null)); r.end();
  });
}
const running = async () => { const r = await get(config.get().port, '/api/health'); return !!(r && r.body && r.body.app === 'relaymote'); };
const token = () => { try { return JSON.parse(fs.readFileSync(path.join(config.MOBILE, 'secret.json'), 'utf8')).token; } catch { return null; } };
const appUrl = () => `http://127.0.0.1:${config.get().appPort}/?k=${encodeURIComponent(token() || '')}`;
function openBrowser(url) {
  if (WIN) spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
}
const cdpUp = () => get(config.get().cdpPort, '/json/version', 1500).then(r => !!r);

const portClash = async () => !(await running()) && !!(await get(config.get().port, '/'));
const clashHelp = () => `Port ${config.get().port} is used by another program. Pick free ports: set "port" and "appPort" in ${config.SETTINGS_FILE}, then run "relaymote start".`;

async function startBackground() {
  if (await running()) { console.log(C.g('Relaymote is already running.')); return true; }
  if (await portClash()) { console.log(C.r(clashHelp())); return false; }
  // Through the stderr-keeping wrapper (lib/launch.js): rotation at 10 MB, launch and exit lines.
  const launch = require('../lib/launch');
  launch.clearStopped();
  const { log: logFile } = launch.spawnDaemon();
  for (let i = 0; i < 40; i++) { await new Promise(r => setTimeout(r, 250)); if (await running()) { console.log(C.g('Relaymote started.')); return true; } }
  console.log(C.r('Relaymote did not answer within 10s. See ' + logFile + ' and ' + path.join(config.STATE, 'relaymote.log')));
  return false;
}

async function doctor() {
  const ok = (b, msg, fix) => console.log(`${b ? C.g('✔') : C.r('✘')} ${msg}${!b && fix ? C.d('\n    → ' + fix) : ''}`);
  const major = Number(process.versions.node.split('.')[0]);
  ok(major >= 18, `Node.js ${process.versions.node}`, 'Install Node.js 18 or newer.');
  let wsOk = true; try { require.resolve('ws'); } catch { wsOk = false; }
  ok(wsOk, 'dependencies installed', 'Run `npm install` in ' + ROOT);
  const claudeDir = path.join(config.APPDATA, 'Claude');
  ok(fs.existsSync(claudeDir), 'Claude Desktop data found', 'Install Claude Desktop and sign in: https://claude.ai/download');
  if (fs.existsSync(claudeDir)) ok(devMode(false), 'Claude Desktop Developer Mode on', 'Run `relaymote setup`, or in Claude Desktop: Help > Troubleshooting > Enable Developer Mode.');
  const cdp = await cdpUp();
  ok(cdp, `Claude Desktop debugger on port ${config.get().cdpPort}`, 'In Claude Desktop: Help > Troubleshooting > Enable Developer Mode, then Developer > Enable Main Process Debugger. Or run `relaymote debugger`.');
  const up = await running();
  ok(up, 'Relaymote daemon running', (await portClash()) ? clashHelp() : 'Run `relaymote start`.');
  let mcp = false;
  try { const j = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8')); mcp = !!(j.mcpServers && j.mcpServers.relaymote); } catch {}
  ok(mcp, 'MCP server registered with Claude Code (orchestrator tools)', 'Run `relaymote mcp install`.');
  const tunnel = require('../lib/tunnel');
  const mode = config.get().remote.mode;
  if (mode.startsWith('cloudflare')) ok(!!tunnel.binary(), 'cloudflared installed', WIN ? 'winget install Cloudflare.cloudflared' : 'brew install cloudflared');
  if (config.get().idleGateSeconds > 0) {
    const idle = require('../lib/idle');
    for (let i = 0; i < 12 && idle.idleMs() === null; i++) await new Promise(r => setTimeout(r, 250));
    const st = idle.status(); idle.stop();
    ok(st.known, `idle detection (${st.method})`, (st.error || 'no reading') + ' — until it works Relaymote treats you as ACTIVE and waits. ' +
      (process.platform === 'linux' ? 'Install xprintidle, or ' : '') + 'set "idleGateSeconds": 0 to run UI actions without waiting.');
  }
  if (WIN) {
    const a = require('../lib/heal').checkScheduledTask();
    ok(a.healthy, `autostart: ${a.detail}`, 'Run `relaymote autostart`.');
  }
  const stopped = require('../lib/launch').stoppedByUser();
  if (stopped && !up) console.log(C.d(`  (you stopped Relaymote at ${stopped.at} via ${stopped.by}; the tray and watchdog leave it stopped until \`relaymote start\`)`));
  console.log(C.d(`\ndata: ${config.DATA}`));
}

async function pairCmd() {
  if (!(await running())) { console.log(C.y('Relaymote is not running — starting it…')); if (!(await startBackground())) return; }
  const r = await get(config.get().appPort, '/api/pair?k=' + encodeURIComponent(token() || ''), 8000);
  const links = (r && r.body && r.body.links) || [];
  if (!links.length) return console.log(C.r('Could not read pairing links.'));
  const pair = require('../lib/pair');
  const best = links[0];
  console.log(C.b(`\nScan with your phone camera (${best.label}):\n`));
  console.log(await pair.qrTerminal(best.url));
  for (const l of links) console.log(`  ${C.c(l.label.padEnd(22))} ${l.url}`);
  if (best.kind === 'local') console.log(C.y('\nOnly reachable from this computer. For your phone, choose Remote access in Settings (Cloudflare, Tailscale or Wi-Fi).'));
  console.log(C.d('\nThe link contains your access key. Treat it like a password.'));
}

function mcpInstall(remove) {
  const script = path.join(ROOT, 'mcp', 'relaymote-mcp.js');
  const argv = remove ? ['mcp', 'remove', '--scope', 'user', 'relaymote'] : ['mcp', 'add', '--scope', 'user', 'relaymote', '--', process.execPath, script];
  const r = spawnSync('claude', argv, { stdio: 'inherit', shell: WIN, windowsHide: true });
  if (r.status === 0) return console.log(C.g(remove ? 'Removed.' : 'Registered MCP server "relaymote". Restart Claude Desktop to load the tools.'));
  if (remove) return console.log(C.y('The `claude` CLI was not found or refused. If ~/.claude.json lists "relaymote" under "mcpServers", delete that entry by hand.'));
  console.log(C.y('The `claude` CLI was not found or refused. Add this to ~/.claude.json under "mcpServers" instead:'));
  console.log(JSON.stringify({ relaymote: { type: 'stdio', command: process.execPath, args: [script] } }, null, 2));
}

function autostart(action) {
  if (!WIN) {
    console.log('Autostart is automated on Windows only. On macOS/Linux, add `' + process.execPath + ' ' + path.join(ROOT, 'server.js') + '` to your login items (launchd / systemd --user).');
    return;
  }
  // scripts/register-autostart.ps1 does the work and reports what it ACTUALLY registered: the "Relaymote"
  // sign-in task (restart on failure, IgnoreNew) or, without admin rights, the per-user Run key; plus
  // the 10-minute "Relaymote Watchdog" task. --headless: daemon only, as S4U when Windows allows it.
  // The result is recorded in state/autostart.json so `relaymote status` and heal describe the truth.
  const act = action === 'remove' ? 'remove' : action === 'status' ? 'status' : 'install';
  const psArgs = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'scripts', 'register-autostart.ps1'),
    '-Action', act, '-Mode', args.includes('--headless') ? 'headless' : 'tray'];
  if (args.includes('--dry-run')) psArgs.push('-DryRun');
  const r = spawnSync('powershell.exe', psArgs, { encoding: 'utf8', windowsHide: true, timeout: 120000 });
  let out = null;
  try { out = JSON.parse(String(r.stdout || '').trim().split(/\r?\n/).pop()); } catch {}
  if (!out) return console.log(C.r('Could not run register-autostart.ps1: ' + String(r.stderr || r.error || r.stdout || '').trim().slice(0, 300)));
  if (act === 'status') {
    console.log(`sign-in task: ${out.task ? out.task.state + ' (' + out.task.logonType + ', last result ' + out.task.lastResult + ')' : C.d('none')}`);
    console.log(`watchdog task: ${out.watchdogTask ? out.watchdogTask.state + ' (' + out.watchdogTask.logonType + ')' : C.d('none')}`);
    console.log(`Run key: ${out.runKey ? 'set' : C.d('not set')}`);
    return;
  }
  if (!out.dryRun) {
    try { fs.writeFileSync(path.join(config.STATE, 'autostart.json'), JSON.stringify({ ...out, at: new Date().toISOString() }, null, 2)); } catch {}
  }
  for (const n of out.notes || []) console.log(C.y(n));
  for (const e of out.errors || []) console.log(C.d('  ' + e));
  if (act === 'remove') return console.log(out.plan.length ? C.g((out.dryRun ? 'Would remove: ' : 'Removed: ') + out.plan.join('; ')) : 'Autostart was not set.');
  if (out.dryRun) return console.log('Would set up:\n  ' + out.plan.join('\n  '));
  if (!out.ok) return console.log(C.r('Could not set up autostart (scheduled task and Run key both refused).'));
  const what = args.includes('--headless') ? 'The Relaymote daemon' : 'Relaymote (with its tray icon)';
  console.log(C.g(`${what} will start when you sign in (${out.logon === 'task' ? 'scheduled task' + (out.s4u ? ', S4U' : '') : 'Run key'})` +
    (out.watchdog ? ', and a watchdog checks every 10 minutes.' : '.')) + (args.includes('--headless') ? '' : ' Start it now with `relaymote tray`.'));
}

function tray() {
  if (!WIN) return console.log('The tray icon is Windows-only for now. Use `relaymote open`.');
  const ps = path.join(ROOT, 'scripts', 'tray.ps1');
  require('../lib/launch').spawnHidden('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', ps]);
  console.log(C.g('Tray icon started (look for the relaymote in the notification area).'));
}

// Claude Desktop keeps Help > Troubleshooting > Enable Developer Mode as {"allowDevTools": true} in
// developer_settings.json and reads it at launch. Returns true (on), 'changed' (just turned on) or false.
function devMode(enable) {
  const f = path.join(config.APPDATA, 'Claude', 'developer_settings.json');
  let j = {}; try { j = JSON.parse(fs.readFileSync(f, 'utf8')) || {}; } catch {}
  if (j.allowDevTools === true) return true;
  if (!enable || !fs.existsSync(path.dirname(f))) return false;
  try { fs.writeFileSync(f, JSON.stringify({ ...j, allowDevTools: true }, null, 2)); return 'changed'; }
  catch (e) { console.log(C.r('Could not turn on Developer Mode: ' + e.message)); return false; }
}

async function setup() {
  console.log(C.b('\nRelaymote setup\n'));
  await doctor();
  if (!(await cdpUp()) && devMode(true) === 'changed') {
    console.log(C.y('\nTurned on Claude Desktop Developer Mode. Quit Claude Desktop (tray icon › Quit) and open it again, then run `relaymote debugger`' +
      (WIN ? ' — or just leave it: Relaymote switches the debugger on by itself once Claude Desktop is signed in (a 3-2-1 countdown shows on screen first).' : '.')));
  } else if (!(await cdpUp()) && WIN) {
    console.log(C.y('\nTrying to switch on the Claude Desktop debugger for you (Claude will come to the front briefly)…'));
    spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'scripts', 'enable-debugger.ps1')], { stdio: 'inherit', windowsHide: true });
  }
  let mcp = false;
  try { const j = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8')); mcp = !!(j.mcpServers && j.mcpServers.relaymote); } catch {}
  if (!mcp) mcpInstall(false);
  if (WIN && !args.includes('--no-autostart')) autostart('install');
  await startBackground();
  if (WIN) tray();
  console.log(C.b('\nDone. Opening Relaymote — use Settings › Pair a phone to connect your phone.'));
  openBrowser(appUrl());
}

function help() {
  console.log(`${C.b('relaymote')} — your Claude Code sessions, in your pocket

${C.b('Everyday')}
  relaymote setup              one-time setup: checks, Developer Mode + debugger, MCP tools, autostart
                           (--no-autostart to skip that), opens the app
  relaymote open               open the app on this computer
  relaymote pair               show the QR code / link that signs your phone in
  relaymote status             is everything working? (alias: doctor)

${C.b('Daemon')}
  relaymote start              start in the background     (relaymote start --foreground to debug)
  relaymote stop | restart     stop the daemon (it stays stopped until relaymote start)
  relaymote tray               Windows tray icon (open, pair, settings, restart, quit)
  relaymote autostart [remove|status] start with Windows (tray + daemon) with a 10-minute watchdog
                           (--headless: daemon only, S4U when allowed; --dry-run: show the plan)
  relaymote debugger           switch on Claude Desktop's main-process debugger (Windows)
  relaymote mcp install|remove register the orchestrator tools with Claude Code
  relaymote hooks install|remove|status [--dry-run]   optional Stop hook: sessions may not end on a question
  relaymote reaper [--dry|--live] [ids]              one idle-CLI reaper pass now (default: its current mode)
  relaymote update [--apply|--status]                is a newer release out? --apply installs it now (Windows installer copies)
                           they can answer themselves (never installed by default; backs up settings.json)
  relaymote accounts           the Claude accounts on this computer and what a sync would change
  relaymote accounts sync [--apply] [--two-way] [--to <n>]   preview (default) or write the account sync
                           --fold: also fold sidebar groups across accounts; --copy-only: no archive/details;
                           --allow-delete (with --two-way): carry deletions
  relaymote accounts undo [journal] · journals · hold on|off · freeze|unfreeze <record id> · frozen
  relaymote accounts first-run baseline|archived-wins · groups-backups · groups-restore <stamp|latest>
  relaymote accounts forget <scope> <group id>   a group deleted on purpose is never restored
  relaymote accounts import-migrate [dir] [--apply] [--merge]   take over another sync tool's history
  relaymote accounts launch-hook install|remove|status   start Claude through Relaymote (repair first) · verify

${C.b('Remote access')}   (also in Settings › Remote access)
  relaymote tunnel quick                random https://….trycloudflare.com address, no account
  relaymote tunnel login                authorise this computer with your Cloudflare account
  relaymote tunnel setup <hostname>     fixed address, e.g. relaymote.example.com
  relaymote tunnel off | status

${C.b('Orchestrator')}
  relaymote run <task> · preview <task> · ls · show <id> · stop <id> · escalate <id>
  relaymote sessions · archivable · health · prune [days]
  relaymote salvage [file] [--apply]      recover tasks from a quarantined registry.json.corrupt-*
  relaymote index build|route|who|session|tree|masters|progress|buried|learn|tag|log|tasks|newproject|digest
                                      project index + transcript intelligence (\`relaymote index help\`)
  relaymote hygiene [compact [--send] [--cap N] | show]   what each session's context needs (HYGIENE.md); compact = last-warm-cycle /compact
  relaymote archive-candidates [days]     sessions safe to archive, with reasons (never archives; default 14 days)
  relaymote wakes [hours] | log [hours] | rollup [--force]   warm vs cold wakes; the wakes Relaymote itself sent
  relaymote summarize [--cap N] [--budget-min M] [--days D] [--dry-run]   5-line overview per changed session
  relaymote roles [--budget N] [--one <id>] [--stats]   the roles DB owner routing reads (free heuristic without an engine)
  relaymote engine [status|test]          the model engine (off by default; Settings › Model engine)
  relaymote directives [--dry-run] [project…]   your own words per project from the digests → <project>/DIRECTIVES.md
                                      (never overwrites a hand-written file; hand edits below the last line survive)
  relaymote inbox [--all] · add <text> [--session <id>] [--log] · ask <n> decide|do|fyi <text> · done|drop|wait <n>
                                      things only you can do (\`relaymote inbox help\`)
  relaymote goal list|show|add|progress|done|verify|judged|collected|health   the goal register (\`relaymote goal help\`)
  control dashboard: http://127.0.0.1:${config.get().port}/  (this computer only)

${C.d('data: ' + config.DATA)}`);
}

async function accountsCmd() {
  const sync = require('../lib/account-sync');
  const sub = (args[1] || 'list').toLowerCase();
  const opt = n => { const i = args.indexOf(n); return i > 0 ? args[i + 1] : null; };
  if (sub === 'undo') {
    const r = await sync.undo(args[2] || sync.journals()[0]);
    (r.lines || []).forEach(l => console.log(C.d('  ' + l)));
    return console.log(r.ok ? C.g('Undone: ' + r.reversed + ' of ' + r.of + ' change(s) reversed.') : C.r(r.message || r.error));
  }
  const say = r => { (r.lines || []).forEach(l => console.log('  ' + l)); console.log(r.ok === false ? C.r(r.message || r.error || 'failed') : C.g(r.message || 'Done.')); };
  const lnch = () => require('../lib/account-sync/launch');
  switch (sub) {
    case 'journals': return sync.journals().slice(0, 20).forEach(j => console.log('  ' + j));
    case 'hold': return say({ ...sync.setHold(args[2] !== 'off'), message: 'Session-detail sync is ' + (args[2] !== 'off' ? 'ON HOLD' : 'running') + '.' });
    case 'freeze': return say(sync.freeze(args[2], args.slice(3).join(' ')));
    case 'unfreeze': return say(sync.unfreeze(args[2]));
    case 'frozen': return Object.entries(sync.core.frozenIds()).forEach(([id, why]) => console.log('  ' + id + '  ' + C.d(why)));
    case 'first-run': {
      if (!['baseline', 'archived-wins'].includes(args[2])) return console.log(C.r('first-run baseline|archived-wins'));
      config.set({ accounts: { firstRunMode: args[2] } }); return console.log(C.g('First-run mode: ' + args[2]));
    }
    case 'groups-backups': return sync.groupBackups().forEach(b => console.log('  ' + b.stamp + '  ' + C.d((b.store || '1p') + ' ' + (b.reason || '') + ' ' + (b.at || ''))));
    case 'groups-restore': return say(await sync.restoreGroups(args[2] || 'latest'));
    case 'forget': return say(sync.forgetGroup(args[2], args[3]));
    case 'import-migrate': {
      const dir = args[2] && !args[2].startsWith('--') ? args[2] : path.join(config.CLAUDE_HOME, 'migrate');
      return say(await sync.importMigrate(dir, { apply: args.includes('--apply'), merge: args.includes('--merge') }));
    }
    case 'launch': return say(await lnch().launchThroughRelaymote({ pass: () => sync.bootPass({ force: true, trigger: 'launch' }) }));
    case 'launch-hook': {
      const v = (args[2] || 'status').toLowerCase();
      const r = v === 'install' ? await lnch().hookInstall() : v === 'remove' ? await lnch().hookRemove() : await lnch().hookStatus();
      if (v === 'status') return console.log(r.supported ? (r.installed ? C.g('Claude Desktop starts through Relaymote.') + C.d(' Undo: relaymote accounts launch-hook remove') : 'Claude Desktop starts on its own.') : r.message);
      return say(r);
    }
    case 'verify': {
      const p = sync.verify.pending(), v = sync.verify.verdict();
      if (p) console.log(C.y('A relaunch check is waiting (armed ' + p.at + ').'));
      if (v) console.log((v.ok === true ? C.g('Last relaunch check: OK') : v.ok === false ? C.r('Last relaunch check: FAILED - Claude Desktop replaced the groups written')
        : C.y('Last relaunch check: not done - Claude Desktop was not reopened in time')) + C.d(' (' + v.at + ')'));
      return p || v ? undefined : console.log('No group write to check.');
    }
  }
  const first = await sync.status();
  const pick = opt('--to');
  const target = pick ? (first.scopes[Number(pick) - 1] || first.scopes.find(s => s.key.startsWith(pick)) || {}).key : null;
  if (pick && !target) return console.log(C.r('No account ' + pick + '. Run "relaymote accounts" to see the numbers.'));
  const r = sub === 'sync'
    ? await sync.run({ apply: args.includes('--apply'), mode: args.includes('--two-way') ? 'two-way' : undefined, target,
        ...(args.includes('--fold') ? { foldGroups: true } : {}), ...(args.includes('--copy-only') ? { syncArchive: false, syncState: false } : {}),
        ...(args.includes('--allow-delete') ? { allowDelete: true } : {}) })
    : first;
  console.log(C.d(r.writableNote || ''));
  r.scopes.forEach((s, i) => {
    const drift = Object.entries(s.changes).filter(([, n]) => n).map(([k, n]) => n + ' ' + k).join(', ');
    const wait = Object.entries(s.pending).filter(([, n]) => n).map(([k, n]) => n + ' ' + k).join(', ');
    console.log(`${i + 1}. ${C.b(s.label)}${s.active ? C.g(' (in use)') : ''}${s.included ? '' : C.d(' (not synced)')}  ${C.d(s.role)}`);
    console.log(`   ${s.records} sessions, ${s.archived} archived, ${s.routines} routines, ${s.groups} groups` +
      (drift ? (r.applied ? C.g('  written: ' + drift) : C.y('  to bring in: ' + drift)) : '') + (wait ? C.d('  waits for Desktop to close: ' + wait) : ''));
  });
  if (!r.ok) return console.log(C.r(r.lines[0] || r.error));
  if (r.applied) console.log(C.g(`Written: ${r.changeCount} change(s).`) + (r.applied.journal ? C.d(' Undo: relaymote accounts undo ' + r.applied.journal) : ''));
  else if (sub === 'sync') console.log(r.changeCount ? C.y(`Preview only: ${r.changeCount} change(s). Add --apply to write them.`) : C.g('Nothing to change.'));
  if (r.pendingCount) console.log(C.d(r.pendingCount + ' change(s) wait until Claude Desktop is closed.'));
}

(async () => {
  switch (cmd) {
    case 'help': case '-h': case '--help': return help();
    case '--version': case 'version': return console.log(require('../package.json').version);
    case 'start':
      if (args.includes('--foreground') || args.includes('-f')) return require('../server.js');
      return void (await startBackground());
    case 'stop': {
      // `relaymote stop <task-id>` stops ONE worker (cli.js); only a bare `relaymote stop` stops the daemon.
      if (args[1] && !args[1].startsWith('-')) {
        process.argv = [process.argv[0], path.join(ROOT, 'cli.js'), ...args];
        return require('../cli.js');
      }
      // Only ask Relaymote to shut down: never POST /api/shutdown at another program on the same port.
      const s = (await running()) && await post(config.get().port, '/api/shutdown');
      // Remembered, so the tray's health poll and the 10-minute watchdog leave it stopped.
      if (s) require('../lib/launch').markStopped('relaymote stop');
      return console.log(s ? C.g('Stopping…') + C.d(' (it stays stopped until `relaymote start`)') : C.y('Relaymote was not running.'));
    }
    case 'salvage': {
      const r = require('../lib/salvage').run({ src: args[1] && !args[1].startsWith('-') ? args[1] : undefined, apply: args.includes('--apply') || args.includes('--write') });
      if (!r.ok) return console.log(C.r(`${r.error}: ${r.message || r.src || ''}`) + (r.padding ? C.d(`\n  ${r.padding} of ${r.chars} chars were padding — nothing was written before the cut.`) : ''));
      console.log(`source : ${r.src}\nmethod : ${r.method}  (${r.padding} chars of trailing padding)\nfound  : ${r.recovered} task(s); live registry has ${r.liveBefore}`);
      if (Object.keys(r.renumbered).length) console.log(C.y('renumbered (id already taken by a newer task): ' + Object.entries(r.renumbered).map(([a, b]) => a + '→' + b).join(', ')));
      console.log(r.applied ? C.g(`Wrote ${r.total} task(s) to ${r.wrote} (${r.added} added).`)
        : C.y(`Dry run: would add ${r.added} task(s) (${r.alreadyPresent} already present), ${r.total} in total. Add --apply to write.`));
      if (r.applied && await running()) console.log(C.d('The daemon picks the change up on its next read.'));
      return;
    }
    case 'restart':
      if (await running()) await post(config.get().port, '/api/shutdown');
      for (let i = 0; i < 60 && await running(); i++) await new Promise(r => setTimeout(r, 250));
      return void (await startBackground());
    case 'open':
      if (!(await running())) await startBackground();
      return openBrowser(appUrl());
    case 'pair': return pairCmd();
    case 'status': case 'doctor': return doctor();
    case 'setup': return setup();
    case 'tray': return tray();
    case 'autostart': return autostart(args[1]);
    case 'debugger':
      if (!WIN) return console.log('In Claude Desktop: Developer > Enable Main Process Debugger.');
      return void spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'scripts', 'enable-debugger.ps1')], { stdio: 'inherit', windowsHide: true });
    case 'mcp': return mcpInstall(args[1] === 'remove');
    case 'hooks': return void require('../hooks/install').cli(args.slice(1));
    case 'reaper': return void (await require('../lib/reaper').cli(args.slice(1)));
    case 'update': return void (await require('../lib/updater').cli(args.slice(1)));
    case 'accounts': return accountsCmd();
    case 'index': return require('../lib/index-cli').run(args.slice(1));
    case 'hygiene': return void (await require('../lib/hygiene').cli(args.slice(1)));
    case 'archive-candidates': {
      const r = require('../lib/archive').report({ days: /^\d+$/.test(args[1] || '') ? Number(args[1]) : undefined });
      if (r.error) return console.log(C.r(r.error + ' — run `relaymote index build` first'));
      for (const c of r.candidates) console.log(`  ${c.sessionId}  ${String(c.title).slice(0, 50)}  ${C.d(c.reason)}`);
      return console.log(`${r.count} candidate(s), ${r.heldBack.length} held back. ${C.d('Written: ' + r.report + ' — archive only what the user approves.')}`);
    }
    case 'wakes': {
      const W = require('../lib/wakes');
      const n = Number(args[2] || args[1]) > 0 ? Number(args[2] || args[1]) : 24;
      if (args[1] === 'log') return console.log(JSON.stringify(W.forwardLog({ hours: n }), null, 2));
      if (args[1] === 'rollup') return console.log(JSON.stringify(W.rollup({ force: args.includes('--force') }) || { skipped: 'already rolled up in the last 24 h (--force to add one)' }, null, 2));
      return console.log(JSON.stringify(W.daily({ hours: n }), null, 2));
    }
    case 'summarize': return require('../lib/summarize').cli(args.slice(1));
    case 'roles': return require('../lib/roles').cli(args.slice(1));
    case 'engine': return require('../lib/engine').cli(args.slice(1));
    case 'directives': {
      const r = require('../lib/directions').run({ dryRun: args.includes('--dry-run'), only: args.slice(1).filter(a => !a.startsWith('--')) });
      if (r.error) { console.log(C.r(`${r.error}: ${r.message}`)); process.exitCode = 1; return; }
      const R = r.recovery;
      console.log(C.d(`digests ${R.digests} · owner turns ${R.owner_turns} · kept ${R.kept} (via Conductor ${R.via_conductor}, envelope splits ${R.envelope_split}) · ` +
        `dropped: ack ${R.ack}, board ${R.board}, machine ${R.machine}, duplicate ${R.duplicate}, brief ${R.brief} · redacted ${R.redacted}`));
      for (const l of r.lines) console.log('  ' + l);
      if (r.pages) console.log(C.d(`direction pages: ${r.pages.dir}`));
      console.log(r.ok ? C.g(r.dryRun ? `Dry run: ${r.written} file(s) would be written.` : `${r.written} DIRECTIVES.md written.`) : C.r(`FAILED: ${r.written} written, ${r.failed} failed.`));
      if (!r.ok) process.exitCode = 1;
      return;
    }
    case 'inbox': case 'goal': {
      const r = require(args[0] === 'inbox' ? '../lib/inbox' : '../lib/goals').cli(args.slice(1));
      if (r.text) (r.code ? console.error : console.log)(r.text);
      process.exitCode = r.code || 0;
      return;
    }
    case 'tunnel': {
      const tunnel = require('../lib/tunnel');
      const sub = (args[1] || 'status').toLowerCase();
      if (sub === 'quick') { config.set({ remote: { mode: 'cloudflare-quick' } }); console.log('Remote access: Cloudflare quick tunnel. Restart Relaymote (`relaymote restart`), then `relaymote pair`.'); return; }
      if (sub === 'off') { config.set({ remote: { mode: 'off' } }); return console.log('Remote access off. `relaymote restart` to apply.'); }
      if (sub === 'login') { const r = await tunnel.login(); if (r.loginUrl) { console.log('Opening: ' + r.loginUrl); openBrowser(r.loginUrl); } else console.log(r); return; }
      if (sub === 'setup') { const r = await tunnel.setupNamed(args[2], args[3]); tunnel.stop(); console.log(r.ok ? C.g(`Ready: https://${r.hostname} — run \`relaymote restart\`, then \`relaymote pair\`.`) : C.r(r.error + (r.detail ? '\n' + r.detail : ''))); return; }
      const st = await get(config.get().appPort, '/api/tunnel?k=' + encodeURIComponent(token() || ''));
      return console.log(JSON.stringify((st && st.body && st.body.tunnel) || tunnel.status(), null, 2));
    }
    default:
      process.argv = [process.argv[0], path.join(ROOT, 'cli.js'), ...args];
      return require('../cli.js');
  }
})().catch(e => { console.error(C.r('error: ' + e.message)); process.exit(1); });
