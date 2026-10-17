// live-settings.js — Settings › Now reads every value live from its file, marks defaults, and says who
// changed what (17-Oct: the menu showed the goal chaser OFF while the Conductor's ran at full speed).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-live-'));
const cd = path.join(dir, 'conductor'), ag = path.join(dir, 'ago');
fs.mkdirSync(cd); fs.mkdirSync(ag);
process.env.RELAYMOTE_HOME = path.join(dir, 'home');
process.env.RELAYMOTE_CONDUCTOR_DIR = cd;
process.env.RELAYMOTE_AGO_STATE = ag;
process.env.CLAUDE_CONFIG_DIR = path.join(dir, 'claude');
fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR);
fs.mkdirSync(process.env.RELAYMOTE_HOME, { recursive: true });

let failed = 0;
const check = (ok, name, extra) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra !== undefined ? '  ' + JSON.stringify(extra) : ''}`); if (!ok) failed++; };
const W = (f, o) => fs.writeFileSync(f, typeof o === 'string' ? o : JSON.stringify(o, null, 2));
const bump = f => { const t = new Date(Date.now() + 5000); fs.utimesSync(f, t, t); };

const config = require('../lib/config');
W(config.SETTINGS_FILE, { levels: { easy: { model: 'claude-haiku-5-5', effort: 'low' } }, modules: { goalChaser: false, chipAutostart: true } });
const future = new Date(Date.now() + 864e5).toISOString();
W(path.join(cd, 'goals-config.json'), { auto_chase: true, chase_per_cycle: 15, full_speed_until: future, _full_speed_note: 'Ashwar: full speed' });
W(path.join(cd, 'last-conductor.txt'), 'local_aaaaaaaa-1111-2222-3333-444444444444');
W(path.join(cd, 'principals.json'), { default: 'ashwar', principals: { ashwar: { name: 'Ashwar', admin: true, conductor: null, sees: 'all' },
  sagar: { name: 'Sagar', enabled: true, sees: 'own', conductor: 'local_bbbbbbbb-1111', phone: '+91 secret' } } });
W(path.join(cd, 'wake_gate.jsonl'), JSON.stringify({ ts: new Date().toISOString(), to: 'local_x', action: 'send', why: 'warm' }) + '\n');
W(path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json'), { hooks: { PreToolUse: [{ hooks: [{ command: 'python wake-gate.py' }] }] } });
W(path.join(ag, 'master-audit.log'), `[${new Date().toISOString()}] SPAWN by local_m: t1 claude-opus-5-5/high via=gui "x"\n`);

const L = require('../lib/live-settings');
const sec = (r, id) => r.sections.find(s => s.id === id);
const rowOf = (r, id, key) => sec(r, id).rows.find(x => x.key === key);

let r = L.read({ titleOf: id => (id.includes('aaaaaaaa') ? 'Conductor — test' : '') });
const ch = sec(r, 'chaser');
check(ch.status.on === true && ch.status.fullSpeed === true, 'the Conductor chaser reads ON + FULL SPEED from goals-config.json', ch.status);
check(rowOf(r, 'chaser', 'modules.goalChaser').value === false, 'Relaymote’s own chaser shown beside it, separately');
check(ch.notes.some(n => /full speed/.test(n.text)), 'the file’s notes come along');
check(rowOf(r, 'chaser', 'quiet_hours').value === undefined && rowOf(r, 'chaser', 'quiet_hours').isDefault, 'a key absent from the file is marked default, never invented');
check(rowOf(r, 'models', 'levels.easy.model').value === 'claude-haiku-5-5' && !rowOf(r, 'models', 'levels.easy.model').isDefault, 'model tiers from settings.json');
check(rowOf(r, 'models', 'tierOverrideHours').isDefault === true, 'and settings.json defaults are flagged as defaults');
check(sec(r, 'wakegate').status.installed === true && sec(r, 'wakegate').status.last24h.send === 1, 'wake gate: hook installed, 24 h counts');
const co = sec(r, 'conductor').status;
check(co.conductor.includes('aaaaaaaa') && co.conductorTitle === 'Conductor — test', 'Conductor id from last-conductor.txt, with its title');
check(co.principals.length === 2 && co.principals[1].conductor === 'local_bbbbbbbb-1111', 'principals listed with their own Conductor (Sagar’s view intact)');
check(JSON.stringify(r).indexOf('secret') < 0, 'nothing but name/enabled/sees/conductor/admin leaves principals.json');
check(sec(r, 'dispatch').status.spawns24h === 1 && /GUI/.test(sec(r, 'dispatch').status.route), 'dispatch: GUI route, AGO spawns counted');
check(r.recent.length === 0, 'first read only takes the snapshot');

config.set({ newSession: { model: 'Opus 5.5' } }, 'phone (sagar)');
r = L.read();
check(r.recent.length === 1 && r.recent[0].by === 'phone (sagar)' && r.recent[0].changes[0].k === 'newSession.model', 'config.set records who changed what', r.recent);
check(rowOf(r, 'models', 'newSession.model').changed.by === 'phone (sagar)', 'and the row names who changed it');

const g = JSON.parse(fs.readFileSync(path.join(cd, 'goals-config.json'), 'utf8')); g.chase_per_cycle = 6;
W(path.join(cd, 'goals-config.json'), g); bump(path.join(cd, 'goals-config.json'));
r = L.read();
check(r.recent.length === 2 && r.recent[0].file === 'goals-config.json' && /on disk/.test(r.recent[0].by), 'an agent’s direct file edit is caught', r.recent[0]);
check(rowOf(r, 'chaser', 'chase_per_cycle').value === 6 && rowOf(r, 'chaser', 'chase_per_cycle').changed.from === 15, 'and shows at once, with the old value');
r = L.read();
check(r.recent.length === 2, 'no duplicate rows on a re-read');

fs.unlinkSync(path.join(cd, 'goals-config.json'));
r = L.read();
check(/not found/.test(sec(r, 'chaser').error || ''), 'a missing file says so instead of showing defaults');

// The phone UI: the dead entries are gone, Now leads.
const src = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const html = src('mobile/public/index.html'), ui = src('mobile/public/settings-ui.js');
check(!/btn-tasks|btn-goals|view-tasks|goals-ui\.js/.test(html), 'Task queue and Goals are gone from the menu');
check(/\['now', 'Now'\]/.test(ui) && /section = sec \|\| 'now'/.test(ui), 'Settings opens on Now');
check(!/'claude-cli', 'Claude CLI/.test(ui) && !/Headless workers at once/.test(ui), 'no CLI engine or headless worker fields');
{ const app = src('mobile/public/app.js');
  check(/SEND_BY_BOX = \{ 'input': 'btn-send', 'answer-text': 'answer-send', 'new-prompt': 'btn-create' \}/.test(app)
    && /e\.ctrlKey \|\| e\.metaKey/.test(app) && /e\.repeat/.test(app) && /qother/.test(app), 'Ctrl/Cmd+Enter sends from every box that sends, once per press'); }
check(/id="theme-seg"/.test(html) && /data-theme/.test(src('mobile/public/style.css')), 'Display has a light/dark/system theme');

try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
