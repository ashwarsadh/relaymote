// directions.js — instruction recovery and DIRECTIVES.md generation on temp fixtures. Never reads a real
// digest, never writes outside the temp folder.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-directions-'));
process.env.APPDATA = path.join(TMP, 'appdata');
process.env.CLAUDE_CONFIG_DIR = path.join(TMP, 'claude');
process.env.RELAYMOTE_HOME = path.join(TMP, 'relaymote');
delete process.env.RELAYMOTE_STATE_DIR;

let failed = 0;
const check = (ok, name, extra) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };

const config = require('../lib/config');
const D = require('../lib/digests');
const X = require('../lib/directions');

const DIG = D.DIR();
fs.mkdirSync(DIG, { recursive: true });
const folderA = path.join(TMP, 'projects', 'alpha');
const folderB = path.join(TMP, 'projects', 'beta');
const folderH = path.join(TMP, 'projects', 'handmade');
for (const f of [folderA, folderB, folderH]) fs.mkdirSync(f, { recursive: true });

const index = {
  sessions: {
    s_alpha1: { project: 'alpha' },
    s_alpha2: { project: 'alpha', spawned_from: 'local_parent' },
    s_beta1: { project: 'beta' },
    s_hand1: { project: 'handmade' },
    s_gone1: { project: 'gone' },
  },
  projects: { alpha: { path: folderA }, beta: { path: folderB }, handmade: { path: folderH }, gone: { path: path.join(TMP, 'projects', 'nope') } },
};
function digest(sid, project, title, turns) {
  const body = turns.map(([ts, label, text]) => `## ${ts} ${label}\n${text}\n\n`).join('');
  fs.writeFileSync(D.digestPath(sid), `# ${title}\nsession: ${sid} · project: ${project} · group: ? · cli: ?\nkept: …\n\n` + body);
}
const long = (seed, n = 500) => (seed + ' ').repeat(Math.ceil(n / (seed.length + 1))).slice(0, n).trim();
const SECRET = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';

digest('s_alpha1', 'alpha', 'Alpha work', [
  ['2026-09-20 10:00', 'USER', 'Please make the export page faster, it takes ages to load and I need it by Friday.'],
  ['2026-09-20 10:01', 'ASSISTANT', 'Done.'],
  ['2026-09-20 10:02', 'USER', 'ok'],
  ['2026-09-20 10:03', 'USER', '[board] answer #4 yes'],
  ['2026-09-20 10:04', 'USER', `here is the key for the sandbox: api_key: ${SECRET} and password: hunter2hunter please wire it`],
  ['2026-09-20 10:05', 'USER via Conductor', '[Conductor relay] add a dark mode toggle to the settings screen and keep the default light'],
  ['2026-09-20 10:06', 'USER', 'also rename the export button to Download <cross-session-message from="x">Another session says hi</cross-session-message>'],
  ['2026-09-20 10:07', 'USER', 'do it <task-notification>worker finished</task-notification>'],
  ['2026-09-20 10:08', 'USER', '<system-reminder>machine text</system-reminder> nothing of mine'],
  ['2026-09-20 10:09', 'USER', 'Please make the export page faster, it takes ages to load and I need it by Friday.'],
  ['2026-09-20 10:10', 'USER', 'I keep seeing ' + long('noise in the log', 260) + ' so never add Report to the Conductor lines, and local_deadbeef should ignore those.'],
]);
digest('s_alpha2', 'alpha', 'Spawned worker', [
  ['2026-09-21 09:00', 'USER', 'BRIEF: build the importer. Read the spec first. This text was written by the master.'],
  ['2026-09-21 09:30', 'USER', 'and when you are done also add a progress bar to the importer'],
]);

const tokensProse = 'tokenization of long words like internationalisationization is fine and the token count matters';
check(X.redact(tokensProse) === tokensProse, 'redaction: prose around the word token is untouched');
const red = X.redact(`client_secret = "${SECRET}" and client id ${SECRET.slice(0, 30)} and password: hunter2hunter`);
check(!red.includes(SECRET) && !red.includes(SECRET.slice(0, 30)) && !red.includes('hunter2hunter'), 'redaction: labelled client secret / client id / password removed');
check(red.includes(`[REDACTED-${SECRET.length}-CHARS]`) && red.includes('[REDACTED-30-CHARS]') && red.includes('[REDACTED-13-CHARS]'), 'redaction: length kept', red);
check(X.redact('my_label: ' + SECRET, ['my[ _]?label']).includes('[REDACTED-'), 'redaction: extra label from config');

// ---------------------------------------------------------------- recovery
const rec = X.recover({ index });
const alpha = rec.projects.alpha.items.map(i => i.text);
const exl = rec.excluded;
check(alpha.some(t => t.startsWith('add a dark mode toggle')) && rec.projects.alpha.items.find(i => i.via), 'relayed-verbatim ("via Conductor") turn kept, label stripped, marked via');
check(!alpha.some(t => t.includes('BRIEF: build the importer')), 'spawned brief (first turn of a spawned session) dropped');
check(alpha.some(t => t.includes('add a progress bar')), 'later turns of a spawned session kept');
check(exl.some(e => e.kind === 'brief' && e.text.includes('BRIEF: build')), 'spawned brief recorded in the exclusions');
check(alpha.includes('also rename the export button to Download'), 'envelope cut: words before the envelope kept, envelope gone');
check(exl.some(e => e.kind === 'envelope-cut' && e.why.includes('<cross-session-message')), 'envelope cut recorded with what matched');
check(!alpha.some(t => t.startsWith('do it')) && exl.some(e => e.kind === 'machine' && e.text.startsWith('do it')), 'short prefix (<15 chars) + envelope is dropped as machine, recorded');
check(!alpha.some(t => t.includes('machine text')) && !alpha.some(t => t.includes('nothing of mine')), 'block that begins with a machine tag dropped');
check(alpha.some(t => t.startsWith('I keep seeing')), 'a message that QUOTES a machine tag after its head is kept');
check(exl.some(e => e.kind === 'ack' && e.text === 'ok') && !alpha.includes('ok'), 'acknowledgement dropped and recorded');
check(exl.some(e => e.kind === 'board') && !alpha.some(t => t.startsWith('[board]')), 'board reply dropped and recorded');
check(alpha.filter(t => t.startsWith('Please make the export page faster')).length === 1 && exl.some(e => e.kind === 'duplicate' && e.why.includes('2026-09-20 10:00')), 'per-project duplicate dropped, names the original');
check(alpha.some(t => t.includes(`[REDACTED-${SECRET.length}-CHARS]`)) && !alpha.some(t => t.includes(SECRET)) && !exl.some(e => String(e.text).includes(SECRET)), 'credentials redacted in kept AND excluded text');

// pages: written, and pages of vanished projects deleted
fs.mkdirSync(X.DIR(), { recursive: true });
fs.writeFileSync(path.join(X.DIR(), 'vanished-project.md'), 'old');
const pg = X.writePages(rec);
check(fs.existsSync(path.join(X.DIR(), 'alpha.md')) && fs.existsSync(path.join(X.DIR(), 'INDEX.md')) && fs.existsSync(path.join(X.DIR(), '_excluded.md')), 'direction pages + INDEX.md + _excluded.md written');
check(!fs.existsSync(path.join(X.DIR(), 'vanished-project.md')) && pg.removed.includes('vanished-project.md'), 'page of a vanished project deleted');
check(fs.readFileSync(path.join(X.DIR(), '_excluded.md'), 'utf8').includes('| brief | spawned-session first turn'), '_excluded.md names what matched');

// ---------------------------------------------------------------- window
const S = X.settings();
const mk = (date, n = 500) => ({ ts: date + ' 12:00', text: long('w' + date, n) });
const days = n => new Date(Date.parse('2026-09-20T00:00:00Z') - n * 86400000).toISOString().slice(0, 10);
const fat = []; for (let i = 0; i < 30; i++) fat.push(mk(days(i), 4000));   // ~117 KB over 30 days
const wf = X.chooseWindow(fat, S);
check(wf.days < 30 && wf.kb <= S.activeKb && wf.days >= S.minDays, 'window SHRINKS until ACTIVE <= activeKb', `days=${wf.days} kb=${wf.kb.toFixed(1)}`);
const huge = [mk(days(0), 60000), mk(days(1), 60000)];
check(X.chooseWindow(huge, S).days === S.minDays, 'window never shrinks below minDays');
const thin = [mk(days(0)), mk(days(40)), mk(days(50)), mk(days(60)), mk(days(70)), mk(days(200))];
const wt = X.chooseWindow(thin, S);
check(wt.days === 70 && wt.active.length === 5, 'window WIDENS until >= minItems', `days=${wt.days} n=${wt.active.length}`);
check(X.chooseWindow([mk(days(0)), mk(days(300))], S).days === S.maxDays, 'window never widens past maxDays');

// ---------------------------------------------------------------- generation, pinning, sweep
const betaTurns = [['2026-09-19 08:00', 'USER', 'BETA-NEW ' + long('recent directive about beta')]];
for (let i = 0; i < 6; i++) betaTurns.push([`2026-09-1${i} 09:0${i}`, 'USER', `BETA-RECENT-${i} ` + long('recent')]);
betaTurns.push(['2026-03-01 07:30', 'USER', 'BETA-ANCIENT ' + long('an old directive nobody should lose')]);
betaTurns.push(['2026-03-02 07:31', 'USER', 'BETA-ANCIENT-2 ' + long('another old one')]);
digest('s_beta1', 'beta', 'Beta work', betaTurns);
digest('s_gone1', 'gone', 'Gone', [['2026-09-18 08:00', 'USER', 'a directive for a project whose folder was removed']]);
digest('s_hand1', 'handmade', 'Hand', [['2026-09-18 08:00', 'USER', 'a directive for the handmade project, long enough to count']]);
const handText = '# My own directives\n\nwritten by hand, no marker.\n';
fs.writeFileSync(path.join(folderH, 'DIRECTIVES.md'), handText);

let r = X.run({ index });
const betaFile = path.join(folderB, 'DIRECTIVES.md');
const res = n => r.results.find(x => x.project === n) || {};
check(r.ok && res('beta').status === 'written' && res('alpha').status === 'written', 'run writes DIRECTIVES.md for projects with a folder', r.lines.join(' / '));
check(res('handmade').status === 'kept-hand-written' && fs.readFileSync(path.join(folderH, 'DIRECTIVES.md'), 'utf8') === handText, 'GUARD: hand-written DIRECTIVES.md (no marker) never overwritten');
check(res('gone').status === 'no-folder', 'project whose folder is missing is skipped');
let bt = fs.readFileSync(betaFile, 'utf8');
check(bt.includes(X.MARKER) && bt.trimEnd().endsWith(X.SENTINEL) && X.bodyIntact(bt), 'generated file carries marker, body hash and sentinel');
check(bt.includes('### AS AT') && bt.includes('relaymote directives "beta"') && bt.includes('Provenance and coverage') && bt.includes('How this file works'), 'header: AS AT, re-run command, provenance, how to use');
check(bt.indexOf('BETA-NEW') < bt.indexOf('BETA-RECENT-5') && bt.indexOf('BETA-RECENT-5') < bt.indexOf('BETA-RECENT-0'), 'newest first');
const earlierAt = bt.indexOf('## Earlier');
check(bt.indexOf('`2026-03-01 07:30`') > earlierAt && !/### 2026-03-01 07:30/.test(bt), 'old directive is a one-line stub in Earlier (not pinned yet)');
check(bt.includes('*None recorded yet.'), 'no known-status file -> the empty-state line');

// pinning via hand edits + known status; hand edits survive a regen
const edit0 = 'CORRECTION: 2026-03-01 07:30 is SUPERSEDED by 2026-09-19 08:00.\n';
fs.writeFileSync(betaFile, bt + edit0);
const edit = bt.slice(bt.indexOf(X.SENTINEL) + X.SENTINEL.length) + edit0;   // everything after the sentinel, byte for byte
fs.mkdirSync(path.join(folderB, '.relaymote'), { recursive: true });
fs.writeFileSync(path.join(folderB, '.relaymote', 'known-status.json'), JSON.stringify([
  { ask: 'old ask | with a pipe', date: '2026-03-02 07:31', status: 'open', evidence: 'none yet' }]));
betaTurns.push(['2026-09-20 11:00', 'USER', 'BETA-NEWEST ' + long('arrived after the first run')]);
digest('s_beta1', 'beta', 'Beta work', betaTurns);
r = X.run({ index, only: ['beta'] });
bt = fs.readFileSync(betaFile, 'utf8');
check(r.ok && res('beta').status === 'written' && res('beta').restored > 0, 'regen reports hand edits restored', r.lines.join(' / '));
check(bt.endsWith(X.SENTINEL + edit) && bt.includes('BETA-NEWEST'), 'hand edits below the sentinel survive a regen (and new messages arrive)');
check(!fs.existsSync(path.join(folderB, '.relaymote', X.SIDE_NAME)), 'sidecar deleted after a confirmed restore');
check(/### 2026-03-01 07:30 · .*PINNED/.test(bt) && /### 2026-03-02 07:31 · .*PINNED/.test(bt), 'timestamps cited in a hand edit / known status render in full, PINNED');
check(bt.includes('| old ask \\| with a pipe | 2026-03-02 07:31 | **open** | none yet |'), 'known-status file rendered as a table (pipes escaped)');
check(r.results.length === 1 && fs.readFileSync(path.join(folderH, 'DIRECTIVES.md'), 'utf8') === handText, 'project filter limits the run');

// edited ABOVE the sentinel -> not regenerated
fs.writeFileSync(betaFile, bt.replace('## How this file works', '## How this file works (my note)'));
r = X.run({ index, only: ['beta'] });
check(res('beta').status === 'kept-edited-above' && fs.readFileSync(betaFile, 'utf8').includes('(my note)'), 'GUARD: a generated file edited above the sentinel is not regenerated');
check(!r.ok && r.written === 0 && r.lines.some(l => l.startsWith('NOTHING WRITTEN')), 'a run that writes nothing reports failure');
fs.writeFileSync(betaFile, bt);

// failed restore: the write fails -> sidecar kept, failure reported; next run restores from it
r = X.run({ index, only: ['beta'], writeFile: () => { throw new Error('disk full (test)'); } });
const side = path.join(folderB, '.relaymote', X.SIDE_NAME);
check(!r.ok && r.failed === 1 && res('beta').status === 'restore-failed', 'failed restore reports failure', r.lines.join(' / '));
check(fs.existsSync(side) && fs.readFileSync(side, 'utf8') === edit, 'failed restore KEEPS the sidecar with the hand edits');
r = X.run({ index, only: ['beta'] });
check(r.ok && fs.readFileSync(betaFile, 'utf8').endsWith(X.SENTINEL + edit) && !fs.existsSync(side), 'next run re-attaches a leftover sidecar, then deletes it');

// a sidecar with nothing to go back into stays and fails the run
fs.writeFileSync(path.join(folderH, '.keep'), '');
const onlyAcks = { sessions: { s_q: { project: 'quiet' } }, projects: { quiet: { path: path.join(TMP, 'projects', 'quiet') } } };
fs.mkdirSync(path.join(TMP, 'projects', 'quiet', '.relaymote'), { recursive: true });
fs.writeFileSync(path.join(TMP, 'projects', 'quiet', '.relaymote', X.SIDE_NAME), '\nkeep me\n');
digest('s_q', 'quiet', 'Quiet', [['2026-09-20 10:00', 'USER', 'ok']]);
r = X.run({ index: onlyAcks, only: ['quiet'] });
check(!r.ok && res('quiet').status === 'restore-failed' && fs.existsSync(path.join(TMP, 'projects', 'quiet', '.relaymote', X.SIDE_NAME)), 'no messages + leftover sidecar -> restore-failed, sidecar kept');

// conflict between a leftover sidecar and different edits in the file
fs.writeFileSync(side, '\nsomething else\n');
r = X.run({ index, only: ['beta'] });
check(res('beta').status === 'conflict' && fs.readFileSync(betaFile, 'utf8').endsWith(edit) && fs.existsSync(side), 'GUARD: sidecar vs different in-file edits -> nothing touched, reported');
fs.unlinkSync(side);

// dry run writes nothing
const before = fs.readFileSync(betaFile, 'utf8');
const pageBefore = fs.statSync(path.join(X.DIR(), 'beta.md')).mtimeMs;
fs.unlinkSync(path.join(folderA, 'DIRECTIVES.md'));
r = X.run({ index, dryRun: true });
check(r.ok && res('alpha').status === 'would-write' && !fs.existsSync(path.join(folderA, 'DIRECTIVES.md')) && fs.readFileSync(betaFile, 'utf8') === before
  && fs.statSync(path.join(X.DIR(), 'beta.md')).mtimeMs === pageBefore, '--dry-run writes nothing');

// module guard + daily tick
check(X.run({ index, requireModule: true }).error === 'MODULE_OFF', 'GUARD: requireModule refuses while the directives module is off');
check(X.tick({ index }) === null, 'tick does nothing while the module is off');
config.set({ modules: { directives: true }, directives: { runAt: '05:00' } });
const at = (h, m, d = 22) => new Date(2026, 8, d, h, m);
check(!X.isDue(at(4, 59), '05:00', null) && X.isDue(at(5, 0), '05:00', null) && !X.isDue(at(9, 0), '05:00', '2026-09-22') && X.isDue(at(5, 1, 23), '05:00', '2026-09-22'), 'isDue: once per local day at/after runAt');
check(X.tick({ index, now: at(4, 0) }) === null, 'tick before runAt does nothing');
const t1 = X.tick({ index, now: at(5, 30) });
check(t1 && t1.ok && fs.existsSync(path.join(folderA, 'DIRECTIVES.md')), 'tick at/after runAt runs and writes');
check(X.tick({ index, now: at(6, 0) }) === null, 'tick runs once per day');
check(X.run({ index, requireModule: true, dryRun: true }).ok, 'requireModule passes once the module is on');

fs.rmSync(TMP, { recursive: true, force: true });
console.log(failed ? `\n${failed} FAILED` : '\nall directions tests passed');
process.exit(failed ? 1 : 0);
