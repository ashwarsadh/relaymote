// index.js — transcript intelligence + routing (lib/transcripts, projects, digests, aliases, ostasks,
// index-views, owner) against a temp fixture: fake Desktop registry rows + fake transcripts with a
// compaction, an AskUserQuestion, a buried notice, a transcript-only (cli_) session and a resumed chain.
// Never touches real data: APPDATA / CLAUDE_CONFIG_DIR / BATON_HOME all point into a temp folder.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-index-'));
process.env.APPDATA = path.join(TMP, 'appdata');
process.env.CLAUDE_CONFIG_DIR = path.join(TMP, 'claude');
process.env.BATON_HOME = path.join(TMP, 'baton');
delete process.env.BATON_STATE_DIR;

let failed = 0;
const check = (ok, name, extra) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };

const STORE = path.join(TMP, 'appdata', 'Claude', 'claude-code-sessions', 'acct', 'org');
const PROJ = path.join(TMP, 'claude', 'projects');
fs.mkdirSync(STORE, { recursive: true });
fs.mkdirSync(PROJ, { recursive: true });
const repo = n => { const d = path.join(TMP, 'repos', n); fs.mkdirSync(path.join(d, '.git'), { recursive: true }); return d; };
const ALPHA = repo('alpha'), BETA = repo('beta'), GAMMA = repo('gamma'), DELTA = repo('delta');
const slug = cwd => cwd.replace(/[^A-Za-z0-9]/g, '-');
const now = Date.now();
const T = mins => new Date(now - mins * 60000).toISOString();
const uuid = () => crypto.randomUUID();

// ---- transcript line builders (shapes as Claude Code writes them)
const head = (cwd, sid) => ({ parentUuid: null, isSidechain: false, userType: 'external', cwd, sessionId: sid, version: '2.0.0', gitBranch: 'main' });
const U = (cwd, sid, content, mins, extra = {}) => JSON.stringify({ ...head(cwd, sid), type: 'user', message: { role: 'user', content }, uuid: uuid(), timestamp: T(mins), ...extra });
const A = (cwd, sid, content, mins, extra = {}) => JSON.stringify({ ...head(cwd, sid), message: { id: 'm' + uuid(), type: 'message', role: 'assistant', model: 'claude-test-1', content }, type: 'assistant', uuid: uuid(), timestamp: T(mins), ...extra });
const txt = t => [{ type: 'text', text: t }];
const SYS = (subtype, mins) => JSON.stringify({ parentUuid: null, isSidechain: false, type: 'system', subtype, content: subtype, timestamp: T(mins) });

let n = 0;
const ids = {};
function session(key, title, cwd, lines, reg = {}) {
  const id = 'local_' + String(++n).padStart(8, '0') + '-aaaa-4000-8000-' + String(n).padStart(12, '0');
  const cli = reg.cliSessionId === undefined ? uuid() : reg.cliSessionId;
  ids[key] = { id, cli, cwd };
  const d = { sessionId: id, cliSessionId: cli, title, cwd, model: 'claude-test-1', isArchived: false,
    createdAt: now - 3 * 3600000, lastActivityAt: now - 60000 * n, completedTurns: 2, ...reg };
  if (d.cliSessionId === null) delete d.cliSessionId;
  fs.writeFileSync(path.join(STORE, id + '.json'), JSON.stringify(d));
  if (lines && cli) writeTranscript(cwd, cli, lines(cwd, cli));
  return id;
}
function writeTranscript(cwd, cli, lines) {
  fs.mkdirSync(path.join(PROJ, slug(cwd)), { recursive: true });
  fs.writeFileSync(path.join(PROJ, slug(cwd), cli + '.jsonl'), lines.join('\n') + '\n');
}
const tpath = key => path.join(PROJ, slug(ids[key].cwd), ids[key].cli + '.jsonl');

// 1. master of alpha: a compaction, an api error, a Skill call, ends on a CRITICAL question
session('master', 'Alpha master', ALPHA, (c, s) => [
  U(c, s, 'Coordinate the alpha release pipeline work', 100),
  A(c, s, txt('Starting the release pipeline plan.'), 99),
  SYS('compact_boundary', 98),
  U(c, s, 'continue with the release pipeline', 97),
  A(c, s, [{ type: 'tool_use', id: 't1', name: 'Skill', input: { skill: 'deploy-helper' } }], 96),
  U(c, s, [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }], 95),
  SYS('api_error', 94),
  A(c, s, txt('The build is green. Shall I deploy to production now?'), 93),
]);
// three children spawned from the master -> fleet; one asks with AskUserQuestion (NARROW)
const kid = (key, title, lines, extra = {}) => session(key, title, ALPHA, lines, { spawnedFrom: { sessionId: ids.master.id }, ...extra });
kid('askq', 'Alpha child: pick a colour', (c, s) => [
  U(c, s, 'Choose the theme colour for the dashboard', 80),
  A(c, s, [{ type: 'text', text: 'Two good options.' }, { type: 'tool_use', id: 'q1', name: 'AskUserQuestion', input: { questions: [{ question: 'Which colour do you prefer, teal or amber?' }] } }], 79),
]);
kid('buried', 'Alpha child: schema migration', (c, s) => [
  U(c, s, 'Plan the schema migration for the orders table', 70),
  A(c, s, txt('The migration plan is ready. Should I run the migration now?'), 69),
  U(c, s, '<cross-session-message from="x" name="helper">Status from helper: nightly build finished</cross-session-message>', 68),
  A(c, s, txt('Noted the helper status.'), 67),
  U(c, s, '[Relaymote] Fleet update for project "alpha" — 1 event.', 66),
  A(c, s, txt('Acknowledged.'), 65),
]);
kid('open', 'Alpha child: docs sweep', (c, s) => [
  U(c, s, 'Sweep the docs for stale links', 60),
  A(c, s, txt('Fixed 12 links. Next steps: the remaining 3 pages still need review.'), 59),
], { forkedFromSessionId: 'local_fork-src', scheduledTaskId: 'nightly-docs', error: 'boom: exited 1', contextExceededCount: 2 });
// resumed chain: prior transcript + current one
const prior = uuid();
writeTranscript(ALPHA, prior, [U(ALPHA, prior, 'Original request about the parser cache', 300), A(ALPHA, prior, txt('Parser cache done. PARSER-CACHE-7731 fixed.'), 299)]);
session('resumed', 'Resumed parser work', ALPHA, (c, s) => [
  U(c, s, 'Resume: finish the parser cache tests', 50),
  A(c, s, txt('All done. Tests pass. PARSER-CACHE-7731 verified.'), 49),
], { priorCliSessionIds: [prior] });
// beta: unanswered + running + a title that needs escaping in map.html
session('unans', 'Beta deploy pipeline cleanup </script><b>x', BETA, (c, s) => [
  U(c, s, 'Set up the deploy pipeline for beta', 40),
  A(c, s, txt('Pipeline configured.'), 39),
  U(c, s, 'now add the staging deploy pipeline step', 38),
]);
session('running', 'Beta runner', BETA, (c, s) => [U(c, s, 'long job on the deploy pipeline', 30), A(c, s, txt('Working on it.'), 29)]);
// gamma: ended; a sidechain line that must be ignored
session('ended', 'Gamma deploy pipeline cleanup', GAMMA, (c, s) => [
  U(c, s, 'Clean up gamma temp files', 20),
  A(c, s, txt('Done. Removed the temp files.'), 19),
  U(c, s, 'SIDECHAIN SECRET PROMPT', 18, { isSidechain: true }),
]);
// delta: a session with no transcript at all
session('bare', 'Delta notes', DELTA, null, { cliSessionId: null });
// transcript-only (headless / deleted): no Desktop row
const orphan = uuid();
writeTranscript(GAMMA, orphan, [JSON.stringify({ type: 'ai-title', aiTitle: 'Headless gamma audit', sessionId: orphan }),
  U(GAMMA, orphan, 'Audit gamma dependencies', 15), A(GAMMA, orphan, txt('Audit complete. PARSER-CACHE-7731 not present.'), 14)]);

// side inputs
fs.writeFileSync(path.join(ALPHA, 'PLAN.md'), '# Alpha plan\n- [ ] ship the release\n- [x] write tests\n- [ ] update changelog\n');
fs.writeFileSync(path.join(ALPHA, 'CLAUDE.md'), '# alpha\n\nThe alpha service. Never touch prod config.\n');
fs.mkdirSync(path.join(PROJ, slug(ALPHA), 'memory'), { recursive: true });
fs.writeFileSync(path.join(PROJ, slug(ALPHA), 'memory', 'MEMORY.md'), '# Memory\n- [Release rule](rule.md): tag before deploy\n');
fs.mkdirSync(path.join(TMP, 'claude', 'skills', 'demo-skill'), { recursive: true });
fs.writeFileSync(path.join(TMP, 'claude', 'skills', 'demo-skill', 'SKILL.md'), '---\nname: demo-skill\ndescription: "A demo skill for tests"\n---\n');

const config = require('../lib/config');
fs.mkdirSync(config.STATE, { recursive: true });
fs.writeFileSync(path.join(config.STATE, 'desktop-snapshot.json'), JSON.stringify({ sessions: [
  { sessionId: ids.running.id, running: true }, { sessionId: ids.ended.id, unread: true } ] }));
// skipSlugs: [] — the fixture lives in the OS temp folder, which the default list skips as throwaway probes
config.set({ conductorSession: ids.master.id, index: { ctxFull: 300, ctxTight: 150, skipSlugs: [] } });

const projects = require('../lib/projects');
const TR = require('../lib/transcripts');
const V = require('../lib/index-views');
const AL = require('../lib/aliases');
const DG = require('../lib/digests');
const OT = require('../lib/ostasks');
const owner = require('../lib/owner');

const SCHTASKS = '"HostName","TaskName","Next Run Time","Status","Logon Mode","Last Run Time","Last Result","Author","Task To Run","Start In","Comment","Scheduled Task State","Idle Time","Power Management","Run As User","Delete Task If Not Rescheduled","Stop Task If Runs X Hours and X Mins","Schedule","Schedule Type","Start Time","Start Date","End Date","Days","Months","Repeat: Every","Repeat: Until: Time","Repeat: Until: Duration","Repeat: Stop If Still Running"\r\n' +
  `"PC","\\Beta sync","N/A","Ready","Interactive only","N/A","0","me","node ${BETA}\\sync.js","N/A","N/A","Enabled","","","me","","","","Daily","","","","","","0 Hour(s), 30 Minute(s)","","",""\r\n` +
  '"PC","\\Microsoft\\Windows\\Defrag","N/A","Ready","","N/A","0","MS","defrag.exe","","","Enabled","","","SYSTEM","","","","Weekly","","","","","","N/A","","",""\r\n' +
  '"PC","\\Mystery","N/A","Ready","","N/A","0","me","wscript.exe //B C:\\\\tools\\\\hidden.vbs","","","Enabled","","","me","","","","At logon time","","","","","","N/A","","",""\r\n';

(async () => {
  // ---------------------------------------------------------------- build
  let ix = await projects.build({ full: true, osTasks: 'force', osReader: async () => OT.parseSchtasksCsv(SCHTASKS) });
  const S = ix.sessions, s = k => S[ids[k].id];
  check(ix.counts.sessions === 9 && ix.counts.cli_only === 1, 'Desktop rows and transcript-only sessions counted', JSON.stringify(ix.counts));
  check(S['cli_' + orphan] && S['cli_' + orphan].in_sidebar === false && S['cli_' + orphan].title === 'Headless gamma audit' && S['cli_' + orphan].project === 'gamma',
    'transcript-only session indexed as cli_<uuid> with its ai-title and project');
  check(s('master').cli === ids.master.cli && s('master').id.startsWith('local_'), 'both ids recorded: local_ id and CLI uuid');
  check(JSON.stringify(s('resumed').cli_chain) === JSON.stringify([prior, ids.resumed.cli]) && s('resumed').prompts[0].startsWith('Original request'),
    'resumed chain: priorCliSessionIds + current, prior prompts first');
  check(!S['cli_' + prior], 'a prior transcript of a chain is not a separate cli_ session');
  check(s('master').compactions === 1 && s('master').errors === 1 && s('master').skills['deploy-helper'] === 1 && s('master').model === 'claude-test-1',
    'compactions, api errors, skills and model read from the transcript');
  check(s('master').first_prompt.startsWith('Coordinate') && /deploy to production/.test(s('master').final_text) && s('master').last_role === 'assistant',
    'first prompt, final answer and last role');
  check(!s('ended').prompts.some(p => /SIDECHAIN/.test(p)), 'sidechain turns ignored');
  check(s('open').forked_from === 'local_fork-src' && s('open').scheduled_task === 'nightly-docs' && /boom/.test(s('open').error) && s('open').turns === 2,
    'registry extras: forkedFrom, scheduledTaskId, error, completedTurns');

  // pending classifier
  check(s('master').pending === 'asks' && s('master').critical, 'asks + critical (deploy to production)', s('master').ask);
  check(s('askq').pending === 'asks' && s('askq').asked_user_question && s('askq').awaiting_signal === 'narrow', 'AskUserQuestion -> asks, NARROW awaiting');
  check(s('master').awaiting_signal === 'broad', 'an ask read only from the final text is BROAD, not narrow');
  check(s('buried').pending === 'buried' && /run the migration/.test(s('buried').buried_ask) && s('buried').buried_notices === 2 && /helper/.test(s('buried').buried_by),
    'buried question: the ask, the notice that hid it, notice count', s('buried').buried_by);
  check(s('unans').pending === 'unanswered', 'unanswered: a prompt sitting with no reply');
  check(s('open').pending === 'open', 'open: ended stating remaining work');
  check(s('ended').pending === 'ended' && s('ended').unread === true, 'ended (and snapshot dots carried)');
  check(s('running').pending === 'running', 'running from the Desktop snapshot');
  const w = V.waiting(ix, 7);
  check(w.narrow === 1 && w.broad === 3, 'narrow and broad awaiting counted separately, never summed', JSON.stringify(w));

  // context
  check(s('master').est_ctx_tokens < s('buried').est_ctx_tokens, 'context resets at a compaction boundary');
  const full = Object.values(S).find(x => x.ctx_flag === 'FULL' && !x.compactions && !x.context_exceeded);
  check(full && full.ctx_verified === false && /NOT verified/.test(full.ctx_note), 'FULL by byte estimate alone is labelled NOT verified');
  check(s('open').ctx_flag === 'FULL' && s('open').ctx_verified && /overflow/.test(s('open').ctx_note), 'contextExceededCount forces FULL and verifies it');
  check(ix.thresholds.ctxFull === 300 && /not a liveness signal/.test(ix.thresholds.note), 'thresholds from settings, documented as a hint');

  // fleet + masters + groups
  check(s('master').children.length === 3 && s('master').is_master && s('askq').spawned_from === ids.master.id, 'fleet tree from spawnedFrom; master by title and >= 3 children');
  const noClaimMaster = Object.values(S).filter(x => x.is_master).map(x => x.id);
  check(noClaimMaster.length === 1, 'only the real master is flagged');
  const grp = ix.groups['(unknown)'] || ix.groups.Ungrouped;
  check(grp && grp.living_masters.includes(ids.master.id), 'group roll-up lists its living masters');
  check(ix.projects.alpha.living_masters[0] === ids.master.id, 'per-project living masters');
  const tr = V.tree(ix, ids.master.id.slice(6, 14));
  check(tr.ok && tr.lines.length === 4 && /^  /.test(tr.lines[1]), 'tree <id> prints the fleet indented');
  check(V.masters(ix).byGroup && /Alpha master/.test(V.masters(ix).text), 'masters view');

  // side inputs
  const alpha = ix.projects.alpha;
  check(alpha.plan_files.length === 1 && alpha.plan_files[0].open === 2 && alpha.plan_files[0].done === 1, 'plan file: open/done checkboxes');
  check(alpha.memory.length === 1 && /Release rule/.test(alpha.memory[0]) && /alpha service/.test(alpha.claude_md), 'memory index head and CLAUDE.md head');
  check(ix.skills.length === 1 && ix.skills[0].description === 'A demo skill for tests', 'installed skills listed');
  const beta = ix.os_tasks.rows.find(t => t.name === 'Beta sync');
  check(ix.os_tasks.rows.length === 2 && beta && beta.owner === 'beta' && beta.console && beta.fires === 'recurring', 'OS tasks: Microsoft skipped, owner from project root, console verdict');
  check(ix.os_tasks.rows.find(t => t.name === 'Mystery').console === false, 'a hidden wrapper (.vbs //B) is not a console flash');
  config.set({ index: { taskOwners: { 'c:\\tools': 'toolbox' } } });
  check(OT.attribute([{ name: 'm', action: 'wscript.exe //B C:\\tools\\hidden.vbs', fires: 'logon', console: false }])[0].owner === 'toolbox', 'taskOwners path map attributes a task outside every project');
  check(OT.parseCrontab('# c\nMAILTO=x\n*/5 * * * * /usr/bin/backup.sh\n@reboot /opt/x/start\n').length === 2, 'crontab parsed (best effort)');
  check(OT.parsePlist('<plist><dict><key>Label</key><string>com.x.sync</string><key>ProgramArguments</key><array><string>/usr/bin/node</string><string>/r/s.js</string></array><key>StartInterval</key><integer>300</integer></dict></plist>').fires === 'recurring', 'launchd plist parsed (best effort)');

  // tags
  check(s('master').tags.length > 0 && s('master').tags.every(t => t.length >= 4), 'tf-idf auto tags');
  let r = AL.tag(ix, ids.master.id.slice(6, 14), 'Release, urgent');
  check(r.ok && r.tags.join() === 'release,urgent', 'manual tag added');
  r = AL.tag(ix, '0000', 'x');
  check(!r.ok && r.error === 'REFUSED' && r.matches.length > 1, 'tag REFUSES an ambiguous reference');

  // views
  const md = fs.readFileSync(projects.INDEX_MD, 'utf8');
  check(md.split('\n')[0] === 'Conductor id: ' + ids.master.id, 'INDEX.md first line is "Conductor id: <id>"');
  check(/## Masters/.test(md) && /## Waiting on a human/.test(md) && /## Scheduled tasks/.test(md) && /## Skills installed/.test(md) && /## alpha/.test(md), 'INDEX.md sections');
  check(fs.existsSync(path.join(projects.WIKI_DIR, 'alpha.md')) && /BURIED QUESTION/.test(fs.readFileSync(path.join(projects.WIKI_DIR, 'alpha.md'), 'utf8')), 'per-project wiki page');
  const map = fs.readFileSync(projects.MAP_HTML, 'utf8');
  check(/<input id="q"/.test(map) && (map.match(/<\/script>/g) || []).length === 1, 'map.html is self-contained and a title cannot break out of its script');
  const ro = owner.readIndex();
  check(ro && ro.sessions[ids.master.id] && ro.sessions[ids.master.id].cli === ids.master.cli, 'owner.js reads the richer index');

  // reports
  const pg = V.progress(ix, 'alpha');
  check(pg.ok && /\[ \] ship the release/.test(pg.text) && pg.sessions.some(x => x.pending === 'buried'), 'progress: plan items and each session plan -> state -> pending');
  check(!V.progress(ix, 'nope').ok, 'progress refuses an unknown project');
  const bu = V.buried(ix, 30);
  check(bu.count === 1 && bu.rows[0].id === ids.buried.id, 'buried report');
  const cd = V.card(ix, ids.resumed.cli.slice(0, 8));
  check(cd.ok && cd.cards[0].id === ids.resumed.id && cd.cards[0].context.label, 'session card found by CLI uuid prefix');

  // ---------------------------------------------------------------- incremental cache
  ix = await projects.build({ full: true });
  check(ix.transcripts.parsed === 0 && ix.transcripts.resumed === 0 && ix.transcripts.cached === ix.transcripts.files, 'second build reads nothing (all cached)', JSON.stringify(ix.transcripts));
  check(ix.sessions[ids.master.id].tags[0] === 'release', 'manual tags lead after a rebuild');
  fs.appendFileSync(tpath('ended'), U(GAMMA, ids.ended.cli, 'one more thing: archive the logs?', 5) + '\n' + A(GAMMA, ids.ended.cli, txt('Want me to archive them?'), 4) + '\n');
  ix = await projects.build({ full: true });
  check(ix.transcripts.resumed === 1 && ix.transcripts.parsed === 0, 'an appended transcript resumes from its offset', JSON.stringify(ix.transcripts));
  const inc = ix.sessions[ids.ended.id], fresh = TR.parseFile(tpath('ended'));
  check(inc.prompts.join('|') === fresh.prompts.join('|') && inc.final_text === fresh.final_text && inc.pending === 'asks', 'incremental result equals a full parse');
  const orig = fs.readFileSync(tpath('open'), 'utf8');
  fs.writeFileSync(tpath('open'), orig.replace('Sweep the docs', 'Sweap the dogs'));
  ix = await projects.build({ full: true });
  check(ix.transcripts.parsed === 1 && ix.sessions[ids.open.id].first_prompt.startsWith('Sweap the dogs'), 'a rewritten transcript (fingerprint moved) is re-read from zero');
  fs.writeFileSync(TR.cacheFile(), '{}');
  ix = await projects.build({ budgetMs: 0 });
  check(ix.transcripts.pending > 0 && ix.transcripts.parsed === 0, 'budget exhausted: new work is deferred, not done', JSON.stringify(ix.transcripts));
  ix = await projects.build({ full: true });

  // ---------------------------------------------------------------- settings-driven vocab
  config.set({ index: { criticalWords: ['frobnicate'], noticePatterns: ['<<ping>>'] } });
  check(!TR.isCritical('Shall I deploy to production?') && TR.isCritical('ok to frobnicate?'), 'criticalWords replaces the generic list');
  const pingCli = uuid();
  writeTranscript(DELTA, pingCli, [U(DELTA, pingCli, 'q', 12), A(DELTA, pingCli, txt('Do you want the long report?'), 11), U(DELTA, pingCli, '<<ping>> heartbeat', 10)]);
  check(TR.parseFile(path.join(PROJ, slug(DELTA), pingCli + '.jsonl')).buried, 'noticePatterns: a configured notice buries an ask');
  config.set({ index: { criticalWords: null, noticePatterns: [] } });

  // ---------------------------------------------------------------- aliases, dispatches, routing
  check(Object.keys(AL.load()).filter(k => !k.startsWith('_')).length === 0, 'aliases ship EMPTY');
  let rt = owner.resolve('deploy pipeline cleanup');
  check(!rt.ok && rt.ambiguous && rt.between.length === 2 && /AMBIGUOUS/.test(rt.refusal), 'AMBIGUOUS route refuses to guess', rt.refusal || JSON.stringify(rt).slice(0, 160));
  const chk = owner.check('deploy pipeline cleanup', ids.unans.id);
  check(chk.allow && chk.ambiguous, 'check() allows a target that is one of the two ambiguous lanes');
  check(!owner.check('deploy pipeline cleanup', ids.master.id).allow, 'check() refuses a target outside the ambiguous pair');
  check(!AL.learn('', 'x').ok && AL.learn('pipeline', 'beta').ok, 'learn refuses an empty keyword; learns a real one');
  rt = owner.resolve('deploy pipeline cleanup');
  check(rt.ok && rt.project === 'beta' && rt.aliases.includes('pipeline'), 'an alias boost settles the route', rt.ok ? rt.title : rt.refusal);
  rt = owner.resolve(`please continue in ${ids.ended.id.slice(6, 14)} about the deploy pipeline`);
  check(rt.ok && rt.explicit && rt.owner === ids.ended.id, 'a session the user NAMES always wins');
  rt = owner.resolve('audit the gamma dependencies', { session: 'cli_' + orphan });
  check(rt.ok && rt.deliverable === false && /no Desktop row/.test(rt.warning), 'a named transcript-only session is returned with deliverable:false');
  check(/no Desktop row/.test(owner.disqualify(S['cli_' + orphan]) || ''), 'transcript-only sessions never win a scored route');
  check(!AL.logDispatch('', 'x').ok, 'dispatch log refuses a row without a query');
  AL.logDispatch('changelog release notes wording', ids.open.id, 'docs lane', false);
  AL.logDispatch('changelog release notes wording', ids.resumed.id, 'user corrected', true);
  const le = AL.learned('fix the changelog release notes');
  check(le.get(ids.resumed.id) === 2 * le.get(ids.open.id), 'a confirmed dispatch weighs twice a guess');
  check(AL.dispatches(5, ix).length === 2 && AL.dispatches(5, ix)[1].title === 'Resumed parser work', 'dispatches list with titles');
  rt = owner.resolve('the beta sync job flashes a console');
  check(rt.scheduledTasks && rt.scheduledTasks[0].name === 'Beta sync', 'scheduled-task hits reported with the route');

  // ---------------------------------------------------------------- transcript grep (who touched this?)
  const wt = await owner.whoTouched('PARSER-CACHE-7731');
  check(wt.ok && wt.sessions[0].id === ids.resumed.id && wt.sessions[0].hits === 2 && wt.sessions.some(x => x.id === 'cli_' + orphan),
    'whoTouched ranks by hit count and sums a resumed chain', JSON.stringify(wt.sessions.map(x => [x.id.slice(0, 14), x.hits])));
  const miss = await owner.whoTouched('NO-SUCH-TOKEN-XYZ');
  check(miss.ok && miss.sessions.length === 0 && /fact about the PATTERN/.test(miss.note), 'a miss says it proves nothing');
  check(!(await owner.whoTouched('ab')).ok, 'grep refuses a pattern under 3 characters');
  rt = await owner.resolveWithGrep('who owns the parser cache bug', { grep: 'PARSER-CACHE-7731' });
  check(rt.ok && rt.owner === ids.resumed.id && rt.grep.top[0].hits === 2 && rt.why.some(x => /transcript hit/.test(x)), 'route uses transcript hits as a ranking signal');

  // ---------------------------------------------------------------- digests
  config.set({ index: { ownerLabel: 'OWNER' } });
  let d = DG.update(ids.buried.id);
  let text = DG.read(ids.buried.id);
  check(d.ok && /## .* OWNER\nPlan the schema/.test(text) && /RELAY — message from "helper"/.test(text) && /ASSISTANT \(latest\)/.test(text), 'digest: owner label, relays one line, provisional last answer');
  d = DG.update(ids.askq.id);
  check(/\[asked: Which colour/.test(DG.read(ids.askq.id)), 'digest: AskUserQuestion as [asked: …]');
  DG.update(ids.master.id);
  check(!/tool_result|"ok"/.test(DG.read(ids.master.id)), 'digest drops tool traffic');
  DG.update(ids.resumed.id);
  const rtxt = DG.read(ids.resumed.id);
  check(rtxt.indexOf('Original request') > 0 && rtxt.indexOf('Original request') < rtxt.indexOf('Resume: finish'), 'digest: resumed chain digested in order');
  const before = DG.readDelta(ids.buried.id, 0).offset;
  const latestBefore = (DG.read(ids.buried.id).match(/ASSISTANT \(latest\)/g) || []).length;
  fs.appendFileSync(tpath('buried'), U(ALPHA, ids.buried.cli, 'yes run it', 3) + '\n' + A(ALPHA, ids.buried.cli, txt('Migration ran.'), 2) + '\n');
  DG.update(ids.buried.id);
  const delta = DG.readDelta(ids.buried.id, before - 200);
  const all = DG.read(ids.buried.id);
  check((all.match(/Acknowledged\./g) || []).length === 1 && /yes run it/.test(all) && /ASSISTANT \(latest\)\nMigration ran/.test(all) && latestBefore === 1,
    'provisional answer corrected, never duplicated');
  check(delta.offset > before && /Migration ran/.test(delta.text), 'readDelta returns what was added');
  check(DG.turns(ids.buried.id).some(t => t.kind === 'OWNER' && /yes run it/.test(t.body)), 'turns() parses the digest');
  check(!DG.update('local_nope').ok && !DG.update(ids.bare.id).ok, 'update refuses an unknown session and one with no transcript');
  check(DG.stats().n >= 4, 'digest stats');

  // ---------------------------------------------------------------- newproject
  r = projects.newProject('Shiny Thing', 'Try things');
  check(!r.ok && r.error === 'REFUSED' && /projectsRoot/.test(r.message), 'newproject REFUSES when projectsRoot is unset');
  config.set({ index: { projectsRoot: path.join(TMP, 'repos') } });
  check(!projects.newProject('../escape').ok && !projects.newProject('a/b').ok, 'newproject refuses a name that is not a plain folder');
  r = projects.newProject('Shiny Thing', 'Try things');
  check(r.ok && r.created && /Try things/.test(fs.readFileSync(path.join(r.folder, 'CLAUDE.md'), 'utf8')) && AL.load().shiny, 'newproject creates the folder, seeds CLAUDE.md, learns an alias');
  fs.writeFileSync(path.join(r.folder, 'CLAUDE.md'), 'mine');
  r = projects.newProject('Shiny Thing', 'other');
  check(r.ok && r.existed && fs.readFileSync(path.join(r.folder, 'CLAUDE.md'), 'utf8') === 'mine', 'an existing project folder is never overwritten');

  // ---------------------------------------------------------------- `baton index …` CLI
  const CLI = require('../lib/index-cli');
  const cli = async (...a) => { const out = [], orig = console.log; console.log = (...x) => out.push(x.join(' ')); try { await CLI.run(a); } finally { console.log = orig; } return out.join('\n'); };
  check(/baton index <verb>/.test(await cli('help')), 'cli: help lists the verbs');
  check(/Conductor|Masters|master/i.test(await cli('masters')), 'cli: masters');
  check((await cli('session', ids.master.id.slice(6, 14))).includes(ids.master.id.slice(6, 14)), 'cli: session card by 8-hex id');
  const cr = JSON.parse(await cli('route', 'deploy pipeline cleanup'));
  check(cr.ok && cr.project === 'beta' && cr.aliases.includes('pipeline'), 'cli: route uses the learned alias (settled the earlier AMBIGUOUS pair)');
  check(/REFUSED/.test(await cli('digest', 'zzzz-no-such')), 'cli: digest refuses an unmatched id');
  check(/"ok": false/.test(await cli('learn', '', 'x')), 'cli: learn refuses an empty keyword');

  // ---------------------------------------------------------------- module off
  config.set({ modules: { transcriptIndex: false } });
  ix = await projects.build();
  check(!ix.sessions[ids.master.id].prompts.length && !ix.counts.cli_only, 'transcriptIndex off: no transcript reading');

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
