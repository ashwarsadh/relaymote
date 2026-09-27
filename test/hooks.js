// hooks.js — the optional finish-the-task Stop hook and its installer. Temp RELAYMOTE_HOME and
// CLAUDE_CONFIG_DIR only; the real ~/.claude/settings.json is never read or written.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-hooks-'));
process.env.RELAYMOTE_HOME = path.join(TMP, 'relaymote');
process.env.CLAUDE_CONFIG_DIR = path.join(TMP, 'claude');
delete process.env.RELAYMOTE_STATE_DIR;
fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });

let failed = 0;
const check = (ok, name, extra) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };

const config = require('../lib/config');
const hook = require('../hooks/finish-the-task');
const inst = require('../hooks/install');
const HOOK = path.join(__dirname, '..', 'hooks', 'finish-the-task.js');

// ------------------------------------------------------------------ transcripts
let n = 0;
function transcript(lines) {
  const f = path.join(TMP, `t${++n}.jsonl`);
  fs.writeFileSync(f, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return f;
}
const user = text => ({ type: 'user', message: { role: 'user', content: text } });
const toolResult = () => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] } });
const said = text => ({ type: 'assistant', message: { role: 'assistant', model: 'm', content: [{ type: 'text', text }] } });
const askTool = () => ({ type: 'assistant', message: { role: 'assistant', model: 'm', content: [{ type: 'tool_use', name: 'AskUserQuestion', input: {} }] } });

const ask = transcript([user('fix the build'), said('I fixed two of the three failures. Want me to fix the last one too?')]);
const offer = transcript([user('tidy the docs'), said('Docs are tidied. Let me know if you would like the changelog updated as well')]);
const done = transcript([user('run the tests'), said('All 41 tests pass; the report is in out/report.txt.')]);
const critical = transcript([user('clean up'), said('The old branches are merged. Shall I delete the 12 remote branches?')]);
const money = transcript([user('renew'), said('The renewal is ready. Should I pay the $49 now?')]);
const viaTool = transcript([user('choose'), said('Two designs are possible.'), askTool()]);
const afterTool = transcript([user('go'), said('Should I continue with step two?'), toolResult()]);
const reset = transcript([said('Should I continue?'), user('yes, and also rename the file'), said('Renamed; all done.')]);
const sidechain = transcript([user('go'), said('Finished.'), { ...said('Want me to do more?'), isSidechain: true }]);

// The module is OFF by default: the hook is a no-op until installed.
check(hook.decide({ transcript_path: ask }).block === false && hook.decide({ transcript_path: ask }).why === 'disabled', 'default: module off, the hook allows every stop');
const on = { enabled: true };
const d1 = hook.decide({ transcript_path: ask }, on);
check(d1.block === true && /do not end your turn on a question/.test(d1.reason), 'blocks a stop on an answerable question (the hook fires)');
check(hook.decide({ transcript_path: offer }, on).block === true, 'blocks on an offer ("let me know if…")');
check(hook.decide({ transcript_path: viaTool }, on).block === true, 'blocks when the turn ended on AskUserQuestion');
check(hook.decide({ transcript_path: afterTool }, on).block === true, 'a tool-result line does not reset the last assistant text');
check(hook.decide({ transcript_path: done }, on).block === false, 'allows a plain completion statement');
check(hook.decide({ transcript_path: critical }, on).block === false, 'allows a critical question (deletion) to stand');
check(hook.decide({ transcript_path: money }, on).block === false, 'allows a money question to stand');
check(hook.decide({ transcript_path: reset }, on).block === false, 'a real user prompt resets: only the last stretch counts');
check(hook.decide({ transcript_path: sidechain }, on).block === false, 'sidechain (subagent) lines are ignored');
check(hook.decide({ transcript_path: ask, stop_hook_active: true }, on).block === false, 'the second stop is always allowed');
check(hook.decide({ transcript_path: path.join(TMP, 'missing.jsonl') }, on).block === false, 'fail-open on a missing transcript');
check(hook.decide({ transcript_path: done }, { ...on, extraAskPatterns: ['report is in'] }).block === true, 'extraAskPatterns widen what counts as an ask');
check(hook.decide({ transcript_path: ask }, { ...on, extraCriticalPatterns: ['last one'] }).block === false, 'extraCriticalPatterns let a configured question stand');
check(hook.decide({ transcript_path: ask }, { ...on, reason: 'Custom rule.' }).reason === 'Custom rule.', 'the block reason is configurable');
check(hook.decide({ transcript_path: ask }, { ...on, extraAskPatterns: ['(unclosed'] }).block === true, 'an invalid extra pattern is ignored, not fatal');

// The real process: stdin in, JSON out.
function runHook(input) {
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), env: process.env, encoding: 'utf8' });
  return { status: r.status, out: (r.stdout || '').trim() };
}
let p = runHook({ transcript_path: ask });
check(p.status === 0 && p.out === '', 'process: module off -> exits 0 with no output');
config.set({ modules: { finishHook: true } });
p = runHook({ transcript_path: ask });
let j = null; try { j = JSON.parse(p.out); } catch {}
check(p.status === 0 && j && j.decision === 'block' && !!j.reason, 'process: module on -> prints {"decision":"block"}');
p = runHook({ transcript_path: done });
check(p.status === 0 && p.out === '', 'process: a finished turn is allowed');
const garbage = spawnSync(process.execPath, [HOOK], { input: 'not json', env: process.env, encoding: 'utf8' });
check(garbage.status === 0 && !garbage.stdout.trim(), 'process: garbage input fails open');
config.set({ modules: { finishHook: false } });

// ------------------------------------------------------------------ installer
const SETTINGS = path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json');
check(inst.settingsFile() === SETTINGS, 'installer targets <CLAUDE_CONFIG_DIR>/settings.json');
const theirs = { model: 'x', hooks: {
  Stop: [{ hooks: [{ type: 'command', command: 'python their-own-stop-hook.py' }] }],
  PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre' }] }],
} };
fs.writeFileSync(SETTINGS, JSON.stringify(theirs, null, 2));
const before = fs.readFileSync(SETTINGS, 'utf8');

let r = inst.run('install', { dryRun: true });
check(r.ok && r.changed && r.dryRun && fs.readFileSync(SETTINGS, 'utf8') === before, 'dry run: reports the change, writes nothing');
check(!config.mod('finishHook'), 'dry run: module stays off');
check(fs.readdirSync(process.env.CLAUDE_CONFIG_DIR).length === 1, 'dry run: no backup written');

r = inst.run('install');
const after = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
check(r.ok && r.changed && inst.installed(after), 'install: the Stop hook is added');
check(after.model === 'x' && after.hooks.PreToolUse.length === 1 && after.hooks.Stop.some(g => g.hooks.some(h => h.command === 'python their-own-stop-hook.py')), 'install: every other setting and hook is preserved');
check(r.backup && fs.existsSync(r.backup) && fs.readFileSync(r.backup, 'utf8') === before, 'install: a byte-identical backup was taken first');
check(config.mod('finishHook'), 'install: modules.finishHook switched on');
const ours = after.hooks.Stop.flatMap(g => g.hooks).find(inst.isOurs);
check(ours && ours.type === 'command' && ours.command.includes('finish-the-task.js') && ours.timeout === 10, 'install: entry is a command hook with a timeout');

r = inst.run('install');
const again = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
check(r.ok && !r.changed && again.hooks.Stop.flatMap(g => g.hooks).filter(inst.isOurs).length === 1, 'install twice: no duplicate entry');

r = inst.run('remove', { dryRun: true });
check(r.ok && r.changed && inst.installed(JSON.parse(fs.readFileSync(SETTINGS, 'utf8'))), 'remove dry run: writes nothing');
r = inst.run('remove');
const removed = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
check(r.ok && r.changed && !inst.installed(removed), 'remove: our entry is gone');
check(JSON.stringify(removed) === JSON.stringify(theirs), 'remove: the file is back to exactly what the user had');
check(!config.mod('finishHook'), 'remove: module switched off');
r = inst.run('remove');
check(r.ok && !r.changed, 'remove when not installed: nothing to do');

// Fresh machine (no settings.json) and a corrupt one.
fs.unlinkSync(SETTINGS);
r = inst.run('install');
check(r.ok && r.changed && !r.backup && inst.installed(JSON.parse(fs.readFileSync(SETTINGS, 'utf8'))), 'install with no settings.json creates it (nothing to back up)');
inst.run('remove');
check(!fs.existsSync(SETTINGS) || !JSON.parse(fs.readFileSync(SETTINGS, 'utf8')).hooks, 'remove leaves no empty hooks object behind');
fs.writeFileSync(SETTINGS, '{ "model": "x", ');
r = inst.run('install');
check(!r.ok && r.error === 'BAD_SETTINGS' && fs.readFileSync(SETTINGS, 'utf8') === '{ "model": "x", ', 'a corrupt settings.json is refused, never overwritten (the guard fires)');

// The CLI path.
fs.writeFileSync(SETTINGS, '{}');
const cli = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'relaymote.js'), 'hooks', 'install', '--dry-run'], { env: process.env, encoding: 'utf8' });
check(cli.status === 0 && /Dry run/.test(cli.stdout) && fs.readFileSync(SETTINGS, 'utf8') === '{}', 'relaymote hooks install --dry-run: prints the plan, writes nothing');
const st = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'relaymote.js'), 'hooks', 'status'], { env: process.env, encoding: 'utf8' });
check(st.status === 0 && /not installed/.test(st.stdout), 'relaymote hooks status');

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
console.log(failed ? `\n${failed} FAILED` : '\nall hook tests passed');
process.exit(failed ? 1 : 0);
