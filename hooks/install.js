// hooks/install.js — `baton hooks install | remove | status [--dry-run]`.
//
// Adds or removes Relaymote's optional finish-the-task Stop hook in <CLAUDE_CONFIG_DIR>/settings.json
// (default ~/.claude/settings.json). It is never installed by default.
//   - Every other hook and setting in that file is left exactly as it was.
//   - --dry-run prints what would change and writes nothing.
//   - Before any write the current file is copied to settings.json.baton-backup-<timestamp>.
//   - A settings.json that is not valid JSON is refused, never overwritten.
//   - Installing twice changes nothing; remove takes out only Relaymote's entry.
// install also switches modules.finishHook on in Relaymote's settings; remove switches it off.
'use strict';
const fs = require('fs');
const path = require('path');
const config = require('../lib/config');

const HOOK = path.join(__dirname, 'finish-the-task.js');
const MARK = 'finish-the-task.js';

const settingsFile = () => path.join(config.CLAUDE_HOME, 'settings.json');
const command = () => `"${process.execPath}" "${HOOK}"`;
const isOurs = h => !!(h && typeof h.command === 'string' && h.command.replace(/\\/g, '/').includes('/hooks/' + MARK));

function read(file) {
  if (!fs.existsSync(file)) return { exists: false, json: {} };
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.trim()) return { exists: true, json: {} };
  try {
    const json = JSON.parse(raw);
    if (!json || typeof json !== 'object' || Array.isArray(json)) return { exists: true, error: 'settings.json is not a JSON object' };
    return { exists: true, json };
  } catch (e) { return { exists: true, error: 'settings.json is not valid JSON (' + e.message + ') — refusing to touch it' }; }
}

function installed(json) {
  const stop = json && json.hooks && Array.isArray(json.hooks.Stop) ? json.hooks.Stop : [];
  return stop.some(g => g && Array.isArray(g.hooks) && g.hooks.some(isOurs));
}

/** Pure: the settings object after the action, and whether anything changed. */
function transform(json, action) {
  const next = JSON.parse(JSON.stringify(json || {}));
  const had = installed(next);
  if (action === 'install') {
    if (had) return { next, changed: false };
    next.hooks = next.hooks && typeof next.hooks === 'object' ? next.hooks : {};
    next.hooks.Stop = Array.isArray(next.hooks.Stop) ? next.hooks.Stop : [];
    next.hooks.Stop.push({ hooks: [{ type: 'command', command: command(), timeout: 10 }] });
    return { next, changed: true };
  }
  if (action === 'remove') {
    if (!had) return { next, changed: false };
    next.hooks.Stop = next.hooks.Stop
      .map(g => (g && Array.isArray(g.hooks)) ? { ...g, hooks: g.hooks.filter(h => !isOurs(h)) } : g)
      .filter(g => !(g && Array.isArray(g.hooks) && g.hooks.length === 0));
    if (!next.hooks.Stop.length) delete next.hooks.Stop;
    if (!Object.keys(next.hooks).length) delete next.hooks;
    return { next, changed: true };
  }
  throw new Error('unknown action ' + action);
}

/** Run an action. opts: { dryRun, file, now }. Never throws for a bad settings file; returns ok:false. */
function run(action, opts = {}) {
  const file = opts.file || settingsFile();
  const cur = read(file);
  if (cur.error) return { ok: false, action, file, error: 'BAD_SETTINGS', message: cur.error };
  if (action === 'status') return { ok: true, action, file, installed: installed(cur.json), moduleOn: !!config.mod('finishHook'), hook: HOOK };
  const { next, changed } = transform(cur.json, action);
  const out = { ok: true, action, file, changed, dryRun: !!opts.dryRun, installed: installed(next) };
  if (!changed) { out.note = action === 'install' ? 'Already installed; nothing to change.' : 'Not installed; nothing to remove.'; }
  if (opts.dryRun) { out.wouldWrite = changed ? next : undefined; return out; }
  if (changed) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (cur.exists) {
      const stamp = new Date(opts.now || Date.now()).toISOString().replace(/[:.]/g, '-');
      out.backup = file + '.baton-backup-' + stamp;
      fs.copyFileSync(file, out.backup);
    }
    const tmp = file + '.baton-tmp';
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
    fs.renameSync(tmp, file);
  }
  config.set({ modules: { finishHook: action === 'install' } });
  out.moduleOn = !!config.mod('finishHook');
  return out;
}

/** CLI: baton hooks [install|remove|status] [--dry-run] */
function cli(argv) {
  const action = (argv.find(a => !a.startsWith('-')) || 'status').toLowerCase();
  if (!['install', 'remove', 'status'].includes(action)) { console.log('usage: baton hooks install | remove | status [--dry-run]'); return 2; }
  const r = run(action, { dryRun: argv.includes('--dry-run') });
  if (!r.ok) { console.log(r.message); process.exitCode = 1; return 1; }
  if (action === 'status') { console.log(`finish-the-task Stop hook: ${r.installed ? 'installed' : 'not installed'} in ${r.file}; module ${r.moduleOn ? 'on' : 'off'}.`); return 0; }
  if (r.dryRun) {
    console.log(r.changed ? `Dry run — would ${action === 'install' ? 'add the Stop hook to' : 'remove the Stop hook from'} ${r.file} (a backup is taken first). Nothing written.` : 'Dry run — ' + r.note);
    if (r.changed) console.log(JSON.stringify((r.wouldWrite && r.wouldWrite.hooks) || {}, null, 2));
    return 0;
  }
  console.log(r.changed ? `${action === 'install' ? 'Installed' : 'Removed'} the finish-the-task Stop hook in ${r.file}.` + (r.backup ? ` Backup: ${r.backup}` : '') : r.note);
  console.log(`modules.finishHook is ${r.moduleOn ? 'on' : 'off'}. New sessions pick the hook up; running ones on their next start.`);
  return 0;
}

module.exports = { run, transform, installed, isOurs, cli, HOOK, settingsFile };
