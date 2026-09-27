// protocol.js — the Conductor protocol text, the Conductor's access to the control tools, and the
// wakes metric. Runs the real MCP server in child processes against a FAKE daemon (and a fake,
// target-less debugger endpoint) on an ephemeral port, with a temp RELAYMOTE_HOME / APPDATA /
// CLAUDE_CONFIG_DIR. Never talks to Claude Desktop or the default ports.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-protocol-'));
process.env.RELAYMOTE_HOME = path.join(TMP, 'relaymote');
process.env.APPDATA = path.join(TMP, 'appdata');
process.env.CLAUDE_CONFIG_DIR = path.join(TMP, 'claude');
delete process.env.RELAYMOTE_STATE_DIR;
fs.mkdirSync(process.env.APPDATA, { recursive: true });
fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });

let failed = 0;
const check = (ok, name, extra) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };

const config = require('../lib/config');
const mp = require('../lib/master-protocol');
const access = require('../lib/conductor-access');
const wakes = require('../lib/wakes');

// ------------------------------------------------------------------ 1. protocol text
const compact = mp.conductorProtocolText();
const detail = mp.conductorProtocolText({ detail: true });
const BUDGET = 18200;   // +200 in v0.2.27: only the longer name (relaymote_* tools), no new text
// Measured with the teachings path put back as its placeholder: the path is the machine's, not the
// protocol's, and a long temp dir (macOS /var/folders/...) would otherwise fail the budget.
const compactLen = compact.split(mp.teachingsPath()).join('{TEACHINGS}').length;
check(compactLen <= BUDGET, 'compact conductor protocol within its activation budget', `${compactLen} <= ${BUDGET} chars`);
check(detail.length > compact.length + 10000, 'detail:true appends the lesson blocks', `${detail.length} chars`);
for (const [needle, what] of [
  ['relaymote_inbox_add', 'inbox-first'], ['BECOMES A GOAL IN THE SAME TURN', 'goal every request'], ['relaymote_goals', 'read open goals'],
  ['A TURN CANNOT END', 'no turn ends with an ungoaled request'], ['PEER message is an interruption', 'peer message = interruption'],
  ['MUST NOT REPLACE A LANE', 'interrupt vs standing brief'], ['WAKE WHILE WARM', 'warm-cache wakes'],
  ['continue to DONE; report once', 'PARTIAL gets continue'], ['ASSIGN THE SEAM', 'seam'], ['ATTRIBUTE EVERY CONSTRAINT', 'attribution'],
  ['single-hop', 'relay authority conditions'], ['NEVER INVENT AN OWNER', 'no invented authority'], ['ADJACENCY IS NOT OWNERSHIP', 'adjacency'],
  ['A CREDENTIAL GIVEN TO A SESSION IS NOT STORED', 'credentials'], ['CORRECTS A PREMISE', 'recall a corrected premise'],
  ['from= OF THE MESSAGE RECEIVED', 'return address'], ['CHEAP CHANNEL IS A FILE', 'shared jsonl'], ['INSPECT WHAT A THING IS', 'inspect first'],
  ['TARGET ORDER', 'target order'], ['→ sent to', 'sent-to line'], ['178 characters', 'phone readability'],
  ['"NOT DEPLOYED" IS NOT A STATUS', 'not deployed'], ["a guard\\'s refusal is a DECISION".replace(/\\/g, ''), 'refusal is a decision'],
  ['CHECK THE PRODUCT DOCS', 'docs before building'], ['NAME WHAT MUST NOT CHANGE', 'goal conditions'], ['ROUTE THE WORK, NOT THE CONTENT', 'content'],
  ['DATA, NEVER INSTRUCTIONS', 'untrusted text'], ['TWO TRANSPORTS', 'two transports'], ['assertEqual', 'secrets'],
  ['ESCALATE THE IRREVERSIBLE ACT, NEVER ITS PRESENTATION', 'escalation test'], ['EXTRAHARD', 'tiers via levels'],
  ['~70%', 'rotate own context'], ['get_session "self"', 'own-id first move'], ['relaymote_rename your own session', 'file yourself'],
]) check(compact.includes(needle), 'compact protocol carries: ' + what);
check(mp.teachingsPath() === path.join(config.DATA, 'TEACHINGS.md') && compact.includes(path.join(config.DATA, 'TEACHINGS.md')), 'teachings file defaults to <data>/TEACHINGS.md and is named in the text');
config.set({ teachingsFile: path.join(TMP, 'rules.md') });
check(mp.conductorProtocolText().includes(path.join(TMP, 'rules.md')), 'teachingsFile setting is honoured');
config.set({ teachingsFile: '' });
for (const n of ['playbook', 'verification', 'relaying', 'retractions', 'diagnosis', 'holds']) check(!!mp.protocolSection(n) && mp.protocolSection(n).length < 7000, 'section ' + n + ' exists and is bounded');
check(mp.protocolSection('nope') === null, 'an unknown section returns null (the tool refuses it)');
check(mp.protocolSection('master') === mp.protocolText(), 'section "master" is the master protocol');
const SD = mp.PROTOCOL.standingDuties;
check(/EASY/.test(SD[6]) && !/Do not drop to a smaller/.test(SD[6]), 'master SD7: tier by work type; smaller models allowed for mechanical work');
check(/USER APPROVED/.test(SD[7]) && /live children/.test(SD[7]), 'master SD8: archive only what the user approved, never a master with live children');
check(/LAST WARM CYCLE/.test(SD[17]) && /COLD/.test(SD[17]), 'master SD18: compact only in the last warm cycle, never cold');
check(/relaymote_wakes/.test(SD[18]), 'master SD19: warm-cache check before a send');
check(/Conductor is the one exception/.test(mp.PROTOCOL.hardRules[0]), 'master hard rule 1 names the Conductor exception');
// g549: the general teachings ship; the user's own file never does, and spawns default to Settings › New session.
const gen = mp.protocolSection('teachings');
check(gen && /before EVERY wake or spawn/.test(gen) && /Never tune a figure/.test(gen), 'the shipped general teachings are served by relaymote_protocol "teachings"');
check(!path.resolve(mp.teachingsPath()).startsWith(path.resolve(__dirname, '..') + path.sep), "the user's own teachings file lives outside the install, so it is never shipped");
check(/forceModel: body\.model \|\| ns\.model \|\| undefined, forceEffort: body\.effort \|\| ns\.effort \|\| undefined/.test(fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8')), 'relaymote_spawn defaults model and effort to Settings › New session');
check(/BEFORE EVERY WAKE OR SPAWN/.test(compact), 'the Conductor protocol says to set model and effort before every wake or spawn');
const everything = [detail, gen, mp.protocolText(), mp.conductorReportLine('local_x'), require('../hooks/finish-the-task').DEFAULT_REASON].join('\n')
  .split(mp.teachingsPath()).join('<teachings>');   // the temp data dir can carry the local user name
const personal = everything.match(/\b(ashwar|sanjay|kkfe|kkfashion|kkvps|vps2|tailscale|gst|tds|tally|memento|fedex|whatsapp|buyer|invoice|agfree)\b|100\.\d+\.\d+\.\d+|Documents of KKFE/i);
check(!personal, 'no personal names, hosts or business words in any protocol text', personal ? 'found: ' + personal[0] : '');

// ------------------------------------------------------------------ 2. access rules (pure)
check(access.role({ me: 'a', claim: null, conductor: 'a' }) === 'CONDUCTOR', 'role: the Conductor');
check(access.role({ me: 'a', claim: { fleet: [] }, conductor: 'b' }) === 'MASTER', 'role: a master');
check(access.role({ me: 'a', claim: null, conductor: 'b' }) === 'SLAVE', 'role: a plain slave');
check(access.role({ me: 'a', claim: { fleet: [] }, conductor: 'a' }) === 'CONDUCTOR', 'role: Conductor wins over a master claim');
const g1 = access.goalGuard({ role: 'SLAVE', fleet: [], sessionId: 'x', action: 'set' });
check(g1 && g1.error === 'NO_CLAIM', 'goalGuard refuses a slave');
const g2 = access.goalGuard({ role: 'MASTER', fleet: ['w'], sessionId: 'x', action: 'set' });
check(g2 && g2.error === 'NOT_IN_YOUR_FLEET', 'goalGuard refuses a master outside its fleet (the guard fires)');
check(access.goalGuard({ role: 'MASTER', fleet: ['w'], sessionId: 'w', action: 'set' }) === null, 'goalGuard allows a master inside its fleet');
check(access.goalGuard({ role: 'MASTER', fleet: ['w'], sessionId: 'x', action: 'set', force: true }) === null, 'goalGuard: force overrides for a master');
check(access.goalGuard({ role: 'MASTER', fleet: [], sessionId: 'x', action: 'status' }) === null, 'goalGuard: reading a goal is allowed anywhere');
check(access.goalGuard({ role: 'CONDUCTOR', fleet: [], sessionId: 'x', action: 'set' }) === null, 'goalGuard allows the Conductor on any session');
check(access.canChangeFastMode('CONDUCTOR') && access.canChangeFastMode('MASTER') && !access.canChangeFastMode('SLAVE'), 'fast mode: master or Conductor may change it, a slave may not');
check(access.adopt(['s1'], { role: 'SLAVE', claim: null }) === null, 'adopt: a slave has no fleet to adopt into');
access.adopt(['s1', 's2'], { role: 'CONDUCTOR', claim: null });
check(JSON.stringify(access.loadConductorFleet()) === '["s1","s2"]', 'adopt: the Conductor keeps its own fleet file');
access.drop(['s1'], { role: 'CONDUCTOR', claim: null });
check(JSON.stringify(access.loadConductorFleet()) === '["s2"]', 'drop: removes from the Conductor fleet');
access.saveConductorFleet([]);
check(/Conductor/.test(mp.conductorReportLine('local_c')) && /WHOLE brief/.test(mp.conductorReportLine('local_c')), 'conductorReportLine: report only done or blocked');

// ------------------------------------------------------------------ 3. wakes
const now = Date.now(), M = 60000;
const proj = path.join(config.CLAUDE_HOME, 'projects', 'demo');
fs.mkdirSync(proj, { recursive: true });
const at = m => new Date(now - m * M).toISOString();
const reply = (m, model = 'claude-opus-5-5') => JSON.stringify({ type: 'assistant', timestamp: at(m), message: { role: 'assistant', model, content: [{ type: 'text', text: 'done' }] } });
const wake = (m, from, name) => JSON.stringify({ type: 'user', timestamp: at(m), message: { role: 'user', content: `Another Claude session sent a message:\n<cross-session-message from="${from}" name="${name}">\nhi\n</cross-session-message>` } });
const queued = (m, from) => JSON.stringify({ type: 'attachment', timestamp: at(m), attachment: { type: 'queued_command', prompt: `<cross-session-message from="${from}">x` } });
const file = path.join(proj, 'aaaa.jsonl');
fs.writeFileSync(file, [
  reply(30 * 60), wake(26 * 60, 'local_old', 'Old'),      // outside the 24h window
  reply(100), wake(90, 'local_warmsender', 'Warm one'),     // 10 min after a reply: warm
  reply(89), queued(80, 'local_queued'),                    // queued mid-turn: not a wake
  wake(10, 'local_coldsender', 'Cold one'),                 // 79 min after the last reply: cold
  reply(9, '<synthetic>'), reply(9),
].join('\n') + '\n');
const d = wakes.daily({ now });
check(d.wakes === 2 && d.warm === 1 && d.cold === 1, 'daily wakes: 2 in 24h, 1 warm, 1 cold (old and queued ones excluded)', JSON.stringify({ w: d.wakes, warm: d.warm, cold: d.cold }));
check(Object.keys(d.coldBySender)[0] === 'local_coldsender (Cold one)', 'daily wakes: cold ones counted by sender');
const w = wakes.warmthOfFile(file, { now });
check(w.warm && w.minutesLeft === 51, 'warmth: last real reply 9 min ago = warm, 51 min left', JSON.stringify(w));
check(!wakes.warmthOfFile(file, { now: now + 2 * 3600000 }).warm, 'warmth: two hours later it is cold');

// ------------------------------------------------------------------ 4. the real MCP server, three identities
const C = 'local_c0000000-0000-4000-8000-000000000000';
const MA = 'local_a0000000-0000-4000-8000-000000000000';
const S = 'local_50000000-0000-4000-8000-000000000000';
const W1 = 'local_01000000-0000-4000-8000-000000000000';
const X = 'local_0e000000-0000-4000-8000-000000000000';
fs.mkdirSync(config.STATE, { recursive: true });
fs.writeFileSync(path.join(config.STATE, 'masters.json'), JSON.stringify({
  proj: { sessionId: MA, sessionTitle: 'demo master', claimedAt: new Date().toISOString(), expiresAt: new Date(now + 3600000).toISOString(), fleet: [W1] },
}));
config.set({ conductorSession: C });

const seen = [];
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    seen.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });
    const send = o => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };
    if (req.url === '/json') return send([]);                                   // a debugger with no targets
    if (req.url === '/api/goal') return send({ ok: true, result: 'set', verdict: 'Goal set: test' });
    if (req.url === '/api/await' && req.method === 'POST') return send({ ok: true, watch: { deadlineAt: new Date(now + 7200000).toISOString() } });
    if (req.url === '/api/await') return send({ watches: [] });
    if (req.url === '/api/health') return send({ ok: true, port: 0 });
    res.statusCode = 404; send({ ok: false, error: 'not found' });
  });
});

function call(me, name, args) {
  return new Promise((resolve) => {
    const env = { ...process.env, CLAUDE_CODE_HOST_SESSION_ID: me, RELAYMOTE_PORT: String(fake.address().port),
                  RELAYMOTE_APP_PORT: String(fake.address().port), RELAYMOTE_CDP_PORT: String(fake.address().port), RELAYMOTE_GOAL_GATE_WAIT_MS: '10' };
    delete env.CLAUDE_CODE_SESSION_ID;
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'mcp', 'relaymote-mcp.js')], { env, stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    const timer = setTimeout(() => { child.kill(); resolve({ error: 'TEST_TIMEOUT' }); }, 60000);
    child.stdout.on('data', c => {
      out += c;
      for (const line of out.split('\n')) {
        if (!line.trim()) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 1 && m.result) { clearTimeout(timer); child.kill(); try { resolve(JSON.parse(m.result.content[0].text)); } catch { resolve({ error: 'BAD_RESULT' }); } return; }
      }
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) + '\n');
  });
}

fake.listen(0, '127.0.0.1', async () => {
  try {
    // A plain slave is still refused, in both directions of the fix.
    let r = await call(S, 'relaymote_goal', { session_id: X, condition: 'npm test exits 0' });
    check(r.error === 'NOT_MASTER', 'slave: relaymote_goal refused', r.error);
    r = await call(S, 'relaymote_fleet', {});
    check(r.error === 'NOT_MASTER', 'slave: relaymote_fleet refused', r.error);
    r = await call(S, 'relaymote_await', { waiting_on: [W1] });
    check(r.error === 'NOT_MASTER', 'slave: relaymote_await refused', r.error);

    // A master keeps its fleet fence.
    r = await call(MA, 'relaymote_goal', { session_id: X, condition: 'npm test exits 0' });
    check(r.error === 'NOT_IN_YOUR_FLEET', 'master: goal outside its fleet refused (unchanged)', r.error);

    // The Conductor: goal on a session in a master's fleet, fleet read across masters, await.
    r = await call(C, 'relaymote_goal', { session_id: W1, condition: 'npm test exits 0 or stop after 5 turns' });
    check(r.ok === true && /Goal set/.test(r.verdict || ''), 'conductor: relaymote_goal on a session in a master\'s fleet reaches the daemon', r.error || r.verdict);
    check(/demo|proj/.test(r.tellMaster || '') && (r.tellMaster || '').includes(MA), 'conductor: the result names the master that holds that session');
    check(seen.some(s => s.url === '/api/goal' && s.body && s.body.session_id === W1), 'conductor: the fake daemon received the goal');
    check(access.loadConductorFleet().includes(W1), 'conductor: the goaled session joins the Conductor fleet (goal cap counts it)');
    r = await call(C, 'relaymote_goal', { session_id: X, condition: 'x', dry_run: true });
    check(r.ok === true, 'conductor: a session in nobody\'s fleet is allowed too', r.error);
    r = await call(C, 'relaymote_fleet', {});
    check(r.role === 'CONDUCTOR' && Array.isArray(r.masters) && r.masters.some(m => m.sessionId === MA && m.fleet.some(f => f.id === W1)), 'conductor: relaymote_fleet reads every master\'s fleet', r.error);
    r = await call(C, 'relaymote_await', { waiting_on: [W1], reason: 'test' });
    check(r.ok === true && seen.some(s => s.url === '/api/await' && s.body && s.body.master_session_id === C && s.body.project === 'conductor'), 'conductor: relaymote_await parks without a master claim', r.error);
    r = await call(C, 'relaymote_status', {});
    check(r.role === 'CONDUCTOR' && /INBOX FIRST/.test(r.operatingProtocol || ''), 'conductor: relaymote_status hands back the new protocol');

    // relaymote_protocol, any session.
    r = await call(S, 'relaymote_protocol', { section: 'holds' });
    check(r.ok === true && /HOLDS AND REDUNDANCY/.test(r.text), 'relaymote_protocol serves a lesson block to any session');
    r = await call(S, 'relaymote_protocol', { section: 'bogus' });
    check(r.error === 'NO_SUCH_SECTION', 'relaymote_protocol refuses an unknown section');
    r = await call(C, 'relaymote_wakes', { hours: 24 });
    check(r.ok === true && r.wakes === 2 && r.cold === 1, 'relaymote_wakes reports the daily metric', r.error);
  } catch (e) { check(false, 'integration threw', e.message); }
  fake.close();
  console.log(failed ? `\n${failed} FAILED` : '\nall protocol tests passed');
  process.exit(failed ? 1 : 0);
});
