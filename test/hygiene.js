// hygiene.js — context hygiene verdicts, the auto-/compact guards, archive candidates and wake measurement,
// all against a temp RELAYMOTE_HOME / CLAUDE_CONFIG_DIR with stubbed bridges. Never talks to Claude Desktop.
// Every guard is shown FIRING (a case where it refuses), not only passing.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-hygiene-'));
process.env.RELAYMOTE_HOME = path.join(TMP, 'relaymote');
process.env.CLAUDE_CONFIG_DIR = path.join(TMP, 'claude');
process.env.APPDATA = path.join(TMP, 'appdata');
delete process.env.RELAYMOTE_STATE_DIR;

let failed = 0;
const check = (ok, name, extra) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra !== undefined && !ok ? '  ' + JSON.stringify(extra).slice(0, 400) : ''}`); if (!ok) failed++; };

const config = require('../lib/config');
const hygiene = require('../lib/hygiene');
const archive = require('../lib/archive');
const wakes = require('../lib/wakes');

const NOW = Date.parse('2026-06-10T12:00:00Z');
const MIN = 60000, HOUR = 3600000, DAY = 86400000;
const isoAt = t => new Date(t).toISOString();
const PROJ = path.join(config.CLAUDE_HOME, 'projects');

// ------------------------------------------------------------------ fixtures
function writeTranscript(slug, cli, records) {
  const dir = path.join(PROJ, slug);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, cli + '.jsonl');
  fs.writeFileSync(f, records.map(r => JSON.stringify(r)).join('\n') + '\n');
  return f;
}
const reply = (t, usage) => ({ type: 'assistant', timestamp: isoAt(t), message: { model: 'claude-x', role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: usage || {} } });
const toolUse = (t, name, input) => ({ type: 'assistant', timestamp: isoAt(t), message: { model: 'claude-x', role: 'assistant', content: [{ type: 'tool_use', id: 'x', name, input }] } });
const userMsg = (t, text, extra = {}) => ({ type: 'user', timestamp: isoAt(t), message: { role: 'user', content: text }, ...extra });

const repo = path.join(TMP, 'repos', 'alpha');
fs.mkdirSync(repo, { recursive: true });
const BIG = 'x'.repeat(3000);

let n = 0;
function sess(over = {}) {
  n++;
  const id = over.id || `local_${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
  return { id, cli: 'cli-' + n, cli_chain: ['cli-' + n], slug: 'slug-alpha', title: 'Session ' + n, project: 'alpha', projectPath: repo, cwd: repo,
    in_sidebar: true, archived: false, running: false, awaiting: false, unread: false, asked_user_question: false, pending: 'open',
    est_ctx_tokens: 500000, compactions: 0, ctx_flag: 'FULL', createdAt: NOW - 2 * DAY, last: isoAt(NOW - 40 * MIN), group: 'alpha',
    children: [], spawned_from: null, tags: [], final_text: '', ...over };
}
const cfg = hygiene.settings({ autoCompact: false });
const passGate = () => ({ ok: true, why: 'stub: state on disk' });
const failGate = () => ({ ok: false, why: 'stub: nothing written' });

// ------------------------------------------------------------------ 1. verdicts
(function verdicts() {
  const c = (over, opts = {}) => hygiene.classify(sess(over), cfg, NOW, { stateGate: passGate, ...opts }).verdict;
  check(c({ running: true }) === 'HOLD-RUNNING', 'running -> HOLD-RUNNING (guard a fires before any threshold)');
  check(c({ awaiting: true }) === 'HOLD-AWAITING', 'own awaiting flag -> HOLD-AWAITING (guard b, narrow)');
  check(c({ asked_user_question: true }) === 'HOLD-AWAITING', 'unanswered AskUserQuestion -> HOLD-AWAITING');
  check(c({ pending: 'asks' }) === 'HOLD-ASK-PENDING', 'turn ended on an ask -> HOLD-ASK-PENDING (broad, counted apart)');
  check(c({ pending: 'asks' }, { moved: true }) === 'COMPACT', 'a stale ask flag is overridden only by MOVEMENT (transcript grew)');
  check(hygiene.awaitingSignal({}) === 'narrow', 'flags ABSENT read as narrow awaiting — unknown is never "not waiting"');
  check(c({ est_ctx_tokens: 100000 }) === 'OK', 'under the tight threshold -> OK');
  check(c({ last: isoAt(NOW - 9 * DAY) }) === 'ARCHIVE', 'dormant past dormantDays -> ARCHIVE, never compacted');
  check(c({ est_ctx_tokens: 300000 }) === 'OK', 'between tight and full, active -> OK');
  check(c({ pending: 'ended' }) === 'NEW-SESSION', 'task ended over the threshold -> NEW-SESSION');
  check(hygiene.classify(sess({}), cfg, NOW, { stateGate: failGate }).verdict === 'WRITE-STATE-FIRST', 'state not on disk -> WRITE-STATE-FIRST (guard c)');
  check(c({ compactions: 2 }) === 'ROTATE', 'compacted maxCompactions times -> ROTATE');
  check(c({}) === 'COMPACT', 'mid-task, over threshold, state on disk -> COMPACT');
})();

// ------------------------------------------------------------------ 2. the state gate, from the transcript's tool calls
(function stateGateReal() {
  const created = NOW - 2 * DAY;
  const statePath = path.join(repo, 'STATE.md');
  const mk = (records, over = {}) => { const s = sess({ createdAt: created, ...over }); writeTranscript(s.slug, s.cli, records); return s; };
  const G = (s, c = cfg) => hygiene.stateGate(s, c, { fresh: true });

  const noFile = mk([toolUse(created + HOUR, 'Write', { file_path: path.join(repo, 'NOTES2.md'), content: BIG })]);
  fs.writeFileSync(path.join(repo, 'NOTES2.md'), BIG);
  check(!G(noFile).ok && /no .*STATE\.md/.test(G(noFile).why), 'no named state file in the project -> refused', G(noFile));

  fs.writeFileSync(statePath, BIG);
  const readOnly = mk([toolUse(created + HOUR, 'Bash', { command: 'wc -c STATE.md && cat STATE.md' })]);
  check(!G(readOnly).ok, 'a READ of STATE.md (wc/cat) is not authorship -> refused', G(readOnly));

  const wrote = mk([toolUse(created + HOUR, 'Write', { file_path: statePath, content: BIG })]);
  check(G(wrote).ok, 'Write of a >=2 KB STATE.md after the session started -> passes', G(wrote));

  const heredoc = mk([toolUse(created + HOUR, 'Bash', { command: "cat > STATE.md <<'EOF'\nstuff\nEOF" })]);
  check(G(heredoc).ok, 'a shell write operator (cat > STATE.md) counts as authorship', G(heredoc));

  const small = path.join(repo, 'HANDOFF.md');
  fs.writeFileSync(small, 'tiny');
  const onlySmall = mk([toolUse(created + HOUR, 'Edit', { file_path: small })]);
  check(!G(onlySmall).ok && /too small/.test(G(onlySmall).why), 'the only doc it wrote is < minStateBytes -> refused', G(onlySmall));

  const outside = path.join(TMP, 'elsewhere', 'STATE.md');
  fs.mkdirSync(path.dirname(outside), { recursive: true }); fs.writeFileSync(outside, BIG);
  const wroteOutside = mk([toolUse(created + HOUR, 'Write', { file_path: outside })]);
  check(!G(wroteOutside).ok, 'a doc written OUTSIDE the project is not this project\'s state -> refused', G(wroteOutside));

  const gone = mk([toolUse(created + HOUR, 'Write', { file_path: path.join(repo, 'DELETED.md') })]);
  check(!G(gone).ok && /not on disk/.test(G(gone).why), 'a doc it wrote that is no longer on disk -> refused, never "0 bytes"', G(gone));

  const past = new Date(created - DAY);
  fs.utimesSync(statePath, past, past);
  fs.utimesSync(small, past, past);                        // HANDOFF.md is a named state file too
  check(!G(wrote).ok && /predates/.test(G(wrote).why), 'every named state file older than the session -> refused (this session\'s work is not on disk)', G(wrote));
  fs.utimesSync(statePath, new Date(), new Date());

  const cfgNames = hygiene.settings({ stateFiles: ['JOURNAL.md'] });
  check(!G(wrote, cfgNames).ok, 'the state-file name list is configurable (STATE.md not in it -> refused)');
})();

// ------------------------------------------------------------------ 3. the cache window
(function window() {
  const W = (w) => hygiene.compactWindow(w, cfg).window;
  check(W({ known: false }) === 'unknown', 'cache state unknown -> never compacted on a guess');
  check(W({ known: true, warm: false, ageMin: 90 }) === 'cold', 'cold -> held (compacting re-reads the context uncached)');
  check(W({ known: true, warm: true, ageMin: 10 }) === 'too-early', 'warm but idle 10 min -> wait for the last warm cycle');
  check(W({ known: true, warm: true, ageMin: 40 }) === 'ready', 'warm, idle 40 min -> its last warm cycle');
  check(W({ known: true, warm: true, ageMin: 57 }) === 'cold', 'idle past compactUntilMinutes -> treated as cold');
})();

// ------------------------------------------------------------------ 4. the auto-/compact guards (port of test_compact_guard)
async function guards() {
  const S = {};
  const add = (over) => { const s = sess(over); S[s.id] = s; return s; };
  const idle = add({ title: 'idle warm' });
  const running = add({ title: 'running in app' });
  const waiting = add({ title: 'awaiting in app' });
  const bogus = add({ title: 'unknown to app' });
  const index = { builtAt: isoAt(NOW - 5 * MIN), sessions: S };
  const warmAll = () => ({ known: true, warm: true, ageMin: 40, minutesLeft: 20 });
  const appStates = { [idle.id]: 'idle', [running.id]: 'running', [waiting.id]: 'awaiting' };
  const confirm = async (id) => appStates[id] ? { state: appStates[id], confirmed: true } : { state: 'unknown', confirmed: false };
  const typed = [];
  const compact = async (id) => { typed.push(id); return { ok: true, result: 'sent', route: 'composer' }; };
  const logged = [];
  const base = { index, now: NOW, stateGate: passGate, warmth: warmAll, moved: () => ({ moved: false }), confirm, compact, isIdle: () => true, logWake: r => logged.push(r) };

  let h = hygiene.scan({ ...base, cfg: hygiene.settings({ compactPerCycle: 10 }) });
  let r = await hygiene.doCompact(h, { ...base, cap: 10 });
  check(typed.includes(idle.id), '(1) the confirmed-idle, warm, state-on-disk session IS compacted', r);
  check(!typed.includes(running.id), '(2) the app says RUNNING -> refused', r.held);
  check(!typed.includes(waiting.id), '(2) the app says AWAITING input -> refused', r.held);
  check(!typed.includes(bogus.id), '(2) the app does not know it (unconfirmed) -> refused', r.held);
  check(logged.length === 1 && logged[0].kind === 'compact' && logged[0].to === idle.id, 'the compact wake is logged with its sender and warmth', logged);
  check(r.held.some(x => x.id === idle.id) === false && r.sent.length === 1, 'exactly one send');

  // (3) never twice inside recompactHours
  typed.length = 0;
  r = await hygiene.doCompact(h, { ...base, cap: 10 });
  check(typed.length === 0 && r.held.some(x => x.id === idle.id && /never twice/.test(x.why)), '(3) the same session is never re-compacted inside recompactHours', r.held);

  // fresh state for the rest
  fs.rmSync(hygiene.STATE(), { force: true });

  // (4) bridge DOWN: nothing is confirmed, nothing is sent
  typed.length = 0;
  r = await hygiene.doCompact(h, { ...base, cap: 10, confirm: async () => { throw new Error('NO_BRIDGE'); } });
  check(typed.length === 0, '(4) the app cannot be reached -> NOTHING is sent (silence is never consent)', r.held);

  // (5) cold / unknown cache -> not even planned
  typed.length = 0;
  const hCold = hygiene.scan({ ...base, warmth: () => ({ known: true, warm: false, ageMin: 180 }) });
  r = await hygiene.doCompact(hCold, { ...base, cap: 10 });
  check(typed.length === 0 && r.ready === 0, '(5) a COLD session is never compacted', r.held);
  const hUnknown = hygiene.scan({ ...base, warmth: () => ({ known: false }) });
  r = await hygiene.doCompact(hUnknown, { ...base, cap: 10 });
  check(typed.length === 0 && r.ready === 0, '(5) cache state UNKNOWN is never compacted');

  // (6) state gone at send time (the index said yes, the disk now says no)
  typed.length = 0;
  r = await hygiene.doCompact(h, { ...base, cap: 10, stateGate: failGate });
  check(typed.length === 0 && r.held.some(x => /state not on disk/.test(x.why)), '(6) state re-checked at send time; missing -> refused', r.held);

  // (7) you are using the computer
  typed.length = 0;
  r = await hygiene.doCompact(h, { ...base, cap: 10, isIdle: () => false });
  check(typed.length === 0 && r.held.some(x => /using the computer/.test(x.why)), '(7) user active -> nothing typed into the Desktop', r.held);

  // (8) running / awaiting in the INDEX never reach the compactor, whatever the app says
  typed.length = 0;
  const S2 = { a: sess({ id: 'local_run', running: true }), b: sess({ id: 'local_wait', awaiting: true }) };
  const h2 = hygiene.scan({ ...base, index: { builtAt: isoAt(NOW), sessions: S2 } });
  r = await hygiene.doCompact(h2, { ...base, cap: 10, confirm: async () => ({ state: 'idle', confirmed: true }) });
  check(typed.length === 0 && r.ready === 0, '(8) HOLD-RUNNING / HOLD-AWAITING never reach the compactor even if the app says idle');

  // (9) cap per cycle
  typed.length = 0;
  const S3 = {};
  for (let i = 0; i < 4; i++) { const s = sess({ id: 'local_cap' + i, est_ctx_tokens: 500000 + i }); S3[s.id] = s; }
  const h3 = hygiene.scan({ ...base, index: { builtAt: isoAt(NOW), sessions: S3 } });
  r = await hygiene.doCompact(h3, { ...base, cap: 2, confirm: async () => ({ state: 'idle', confirmed: true }) });
  check(typed.length === 2 && typed[0] === 'local_cap3' && r.held.filter(x => /over the cap/.test(x.why)).length === 2, '(9) at most compactPerCycle sends, largest first', { typed, held: r.held });
  fs.rmSync(hygiene.STATE(), { force: true });

  // (10) a failed type is recorded, reported, and not retried at once
  typed.length = 0;
  r = await hygiene.doCompact(h, { ...base, cap: 10, compact: async () => ({ ok: false, result: 'command-not-offered' }) });
  check(r.failed.length === 1 && r.failed[0].result === 'command-not-offered', '(10) a composer failure is reported, never counted as sent', r);
  r = await hygiene.doCompact(h, { ...base, cap: 10 });
  check(typed.length === 0 && r.held.some(x => /last attempt failed/.test(x.why)), '(10) and not retried inside retryFailedMinutes', r.held);
  const ev = hygiene.recentEvents(NOW, 1).map(e => e.kind);
  check(ev.includes('compact-failed'), '(10) the failure is an event in hygiene-events.jsonl', ev);
  fs.rmSync(hygiene.STATE(), { force: true });

  // (11) deferred verification: VERIFIED when compactions rise; SILENT FAILURE when they do not
  typed.length = 0;
  hygiene.diffAndRecord(hygiene.scan(base));                      // seed
  r = await hygiene.doCompact(hygiene.scan(base), { ...base, cap: 10 });
  const later = NOW + 30 * MIN;
  const Sv = JSON.parse(JSON.stringify(S));
  Sv[idle.id].compactions = 1; Sv[idle.id].est_ctx_tokens = 20000;
  let hv = hygiene.scan({ ...base, now: later, index: { builtAt: isoAt(later), sessions: Sv } });
  hygiene.diffAndRecord(hv);
  check((hv.events_now || []).some(e => e.kind === 'compact-verified' && e.id === idle.id), '(11) a later scan that sees the compaction count rise VERIFIES the send', hv.events_now);
  fs.rmSync(hygiene.STATE(), { force: true });
  hygiene.diffAndRecord(hygiene.scan(base));
  await hygiene.doCompact(hygiene.scan(base), { ...base, cap: 10 });
  const much = NOW + 7 * HOUR;
  hv = hygiene.scan({ ...base, now: much, index: { builtAt: isoAt(much), sessions: S } });
  hygiene.diffAndRecord(hv);
  check(hv.unverified.length === 1 && (hv.events_now || []).some(e => e.kind === 'compact-unverified'), '(11) no compaction after verifyAfterHours -> reported as a SILENT FAILURE', hv.unverified);
  hv = hygiene.scan({ ...base, now: much + HOUR, index: { builtAt: isoAt(much), sessions: S } });
  hygiene.diffAndRecord(hv);
  check(!(hv.events_now || []).some(e => e.kind === 'compact-unverified'), '(11) the silent failure is reported ONCE, not every cycle');
  fs.rmSync(hygiene.STATE(), { force: true });

  // (12) the module switch: autoCompact off -> the cycle never types anything
  typed.length = 0;
  const out = await hygiene.cycle({ ...base, force: true, settings: { autoCompact: false }, rollup: false, archive: false });
  check(out.ok && typed.length === 0 && out.compact === null, '(12) module autoCompact OFF (the default) -> no sends', out);
  check(config.DEFAULTS.modules.autoCompact === false, '(12) autoCompact defaults to OFF');
  typed.length = 0;
  const on = await hygiene.cycle({ ...base, force: true, settings: { autoCompact: true }, rollup: false, archive: false });
  check(on.ok && typed.length === 1, '(12) module on -> the cycle compacts the one eligible session', on);
  const staleIx = await hygiene.cycle({ ...base, force: true, settings: { autoCompact: true }, rollup: false, archive: false,
    index: { builtAt: isoAt(NOW - 5 * HOUR), sessions: S } });
  check(staleIx.ok && staleIx.compact.sent === 0, '(12) a stale index (older than 3 cycles) -> no compaction on an old picture', staleIx);
  fs.rmSync(hygiene.STATE(), { force: true });
}

// ------------------------------------------------------------------ 5. never via sendMessage: the composer route
async function route() {
  check(hygiene.COMPACT_ROUTE === 'composer', 'the /compact route is the composer');
  const desktop = require('../lib/desktop');
  const bridge = require('../lib/bridge');
  const goal = require('../lib/goal');
  const saved = {};
  const stub = (obj, name, fn) => { saved[name] = saved[name] || [obj, obj[name]]; obj[name] = fn; };
  const sends = [], slash = [], pressed = [];
  let busy = 'idle';
  stub(bridge, 'sendMessage', async (...a) => { sends.push(a); return { ok: true }; });
  stub(desktop, 'sendMessage', async (...a) => { sends.push(a); return { ok: true }; });
  stub(desktop, 'connect', async () => ({ evaluate: async () => busy, close() {} }));
  stub(desktop, 'wsUrl', async () => 'ws://stub');
  stub(desktop, 'pickChat', async () => 'CID');
  stub(desktop, 'ensureSessionOpen', async () => ({ ok: true, restore: null }));
  stub(desktop, 'dismissStrayMenus', async () => {});
  stub(desktop, 'parkComposer', async () => 'ok');
  stub(desktop, 'releaseComposer', async () => {});
  stub(desktop, 'restoreActive', async () => {});
  stub(goal, 'typeSlashCommand', async (conn, CID, sid, cmd, rest) => { slash.push([sid, cmd, rest]); return { ok: true, result: 'ready' }; });
  stub(goal, 'pressSend', async (conn, CID, sid) => { pressed.push(sid); return { ok: true, result: 'sent' }; });
  try {
    const r = await hygiene.composerCompact('local_route');
    check(r.ok && slash.length === 1 && slash[0][1] === 'compact' && pressed.length === 1, 'composerCompact TYPES /compact as a slash command and presses Send', { r, slash });
    check(sends.length === 0, 'NEVER via sendMessage: no message send of any kind', sends);
    busy = 'busy'; slash.length = 0;
    const r2 = await hygiene.composerCompact('local_route');
    check(!r2.ok && r2.result === 'running' && slash.length === 0, 'the composer shows a live turn -> refused before typing (never queued behind work)', r2);
    busy = 'queued';
    const r3 = await hygiene.composerCompact('local_route');
    check(!r3.ok && r3.result === 'queue-occupied', 'a message already queued -> refused (the one queue slot is not overwritten)', r3);
    busy = 'idle';
    stub(goal, 'typeSlashCommand', async () => ({ ok: false, result: 'command-not-offered' }));
    pressed.length = 0;
    const r4 = await hygiene.composerCompact('local_route');
    check(!r4.ok && r4.result === 'command-not-offered' && pressed.length === 0, 'the app did not offer /compact as a command -> nothing is sent as prose', r4);
  } finally { for (const [name, [obj, fn]] of Object.entries(saved)) obj[name] = fn; }
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'hygiene.js'), 'utf8');
  check(!/sendMessage\s*\(/.test(src), 'lib/hygiene.js contains no sendMessage call at all');
}

// ------------------------------------------------------------------ 6. the cycle's files, and the refusal to report zeros
async function files() {
  let threw = null;
  try { hygiene.scan({ index: { sessions: {} } }); } catch (e) { threw = e; }
  check(threw instanceof hygiene.IndexUnreadable, 'an empty index throws IndexUnreadable instead of reporting zeros');
  fs.rmSync(hygiene.REPORT_JSON(), { force: true });
  const r0 = await hygiene.cycle({ force: true, index: null, rollup: false, archive: false });
  check(!r0.ok && /DID NOT RUN/.test(r0.error) && !fs.existsSync(hygiene.REPORT_JSON()), 'the cycle writes NO hygiene.json on an unreadable index', r0);

  const S = {};
  const a = sess({ id: 'local_files_a' }); S[a.id] = a;
  const b = sess({ id: 'local_files_b', awaiting: true }); S[b.id] = b;
  const boardDir = path.join(TMP, 'board');
  const r = await hygiene.cycle({ force: true, index: { builtAt: isoAt(NOW), sessions: S }, now: NOW, stateGate: passGate,
    warmth: () => ({ known: true, warm: true, ageMin: 40 }), moved: () => ({ moved: false }), rollup: false, archive: false, boardDir });
  const conductor = path.join(config.DATA, 'conductor');
  for (const f of ['hygiene.json', 'HYGIENE.md', 'hygiene-state.json', 'hygiene-events.jsonl']) check(fs.existsSync(path.join(conductor, f)), `writes ${f} under <data>/conductor`);
  check(fs.existsSync(path.join(boardDir, 'hygiene.json')), 'writes a hygiene.json copy into the board folder (the board reads it)');
  const j = JSON.parse(fs.readFileSync(hygiene.REPORT_JSON(), 'utf8'));
  check(j.counts.COMPACT === 1 && j.counts['HOLD-AWAITING'] === 1 && j.funnel && j.funnel.reached_state_gate === 1, 'hygiene.json carries counts and the funnel', j.counts);
  const md = fs.readFileSync(hygiene.REPORT_MD(), 'utf8');
  check(/NARROW/.test(md) && /BROAD/.test(md) && /WHY THAT COMPACT NUMBER/.test(md), 'HYGIENE.md separates narrow/broad awaiting and prints the funnel');
  const again = await hygiene.cycle({ now: NOW + MIN, module: true, index: { builtAt: isoAt(NOW), sessions: S }, rollup: false, archive: false });
  check(again.skipped === 'interval', 'a second cycle inside intervalMinutes is skipped', again);
  const noState = { x: sess({ id: 'local_nostate', projectPath: path.join(TMP, 'empty-proj'), cwd: path.join(TMP, 'empty-proj') }) };
  fs.mkdirSync(path.join(TMP, 'empty-proj'), { recursive: true });
  const hn = hygiene.scan({ index: { sessions: noState }, now: NOW, stateGate: passGate, warmth: () => ({ known: false }) });
  check(hygiene.nothingWrittenDown(hn).length === 1, 'NOTHING WRITTEN DOWN lists an over-threshold session whose project has no state file');
  if (r.ok === false) check(false, 'cycle ran', r);
}

// ------------------------------------------------------------------ 7. archive candidates
function archiveTests() {
  const S = {};
  const put = (over) => { const s = sess({ pending: 'ended', est_ctx_tokens: 50000, ctx_flag: 'ok', last: isoAt(NOW - 20 * DAY), ...over }); S[s.id] = s; return s; };
  const disp = put({ id: 'local_disp0001', title: 'probe the parser' });
  const young = put({ id: 'local_young001', title: 'test something', last: isoAt(NOW - 5 * DAY) });
  const run = put({ id: 'local_run00001', title: 'scratch run', running: true });
  const unread = put({ id: 'local_unread01', title: 'scratch unread', unread: true });
  const asks = put({ id: 'local_asks0001', title: 'scratch asks', pending: 'asks' });
  const unknown = put({ id: 'local_unknown1', title: 'scratch unknown', running: null, awaiting: null, unread: null });
  const master = put({ id: 'local_master01', title: 'tmp master' });
  const kid = put({ id: 'local_kid00001', title: 'kid work', spawned_from: master.id, last: isoAt(NOW - 1 * DAY), pending: 'open' });
  master.children = [kid.id];
  const oldW = put({ id: 'local_oldwork1', title: 'Payments ledger reconcile export pipeline' });
  const newW = put({ id: 'local_newwork1', title: 'Payments ledger reconcile export pipeline v2', last: isoAt(NOW - 1 * DAY), pending: 'open' });
  const lookW = put({ id: 'local_lookal01', title: 'Payments ledger reconcile export pipeline redo' });
  const gone = put({ id: 'local_orphan01', title: 'worker for search', spawned_from: 'local_nosuchmaster' });
  const signed = put({ id: 'local_signed01', title: 'worker for docs', spawned_from: 'local_newwork1', final_text: 'All three parts are done. Reported to the master.' });
  const full = put({ id: 'local_full0001', title: 'long analysis', ctx_flag: 'FULL', est_ctx_tokens: 900000 });
  const fullAsks = put({ id: 'local_fullask1', title: 'long analysis two', ctx_flag: 'FULL', est_ctx_tokens: 900000, pending: 'open' });
  const index = { sessions: S };
  const digestText = (o) => o.id === newW.id ? { text: 'continuing the work of ' + oldW.id.replace('local_', '').slice(0, 8) + ' ...', source: 'digest' } : { text: '', source: null };

  const res = archive.collect({ index, snapshot: null, now: NOW, digestText });
  const listed = new Map(res.rows.map(r => [r.s.id, r.reasons.map(x => x.code)]));
  const heldBy = new Map(res.held.map(r => [r.s.id, r.why]));
  check(listed.has(disp.id) && listed.get(disp.id).includes('disposable'), 'DISPOSABLE: a probe title, idle > idleDays, ended -> listed', [...listed]);
  check(!listed.has(young.id), 'idle <= idleDays (default 14) -> never listed');
  check(res.cfg.idleDays === 14, 'idleDays defaults to 14');
  check(!listed.has(run.id) && /running/.test(heldBy.get(run.id) || ''), 'running -> held back, never listed');
  check(!listed.has(unread.id) && /unread/.test(heldBy.get(unread.id) || ''), 'unread -> held back (unseen work is never archived away)');
  check(!listed.has(asks.id) && /asking/.test(heldBy.get(asks.id) || ''), 'last turn did not END (still asking) -> held back');
  check(!listed.has(unknown.id) && /unknown/.test(heldBy.get(unknown.id) || ''), 'live state UNKNOWN (no snapshot, null flags) -> held back');
  check(!listed.has(master.id) && /live child/.test(heldBy.get(master.id) || ''), 'a master with a live child is NEVER listed');
  check(listed.has(oldW.id) && listed.get(oldW.id)[0] === 'superseded', 'SUPERSEDED: newer same-project session, Jaccard >= 0.6, and its digest names this one', [...listed]);
  check(!(listed.get(lookW.id) || []).includes('superseded'), 'a look-alike the newer digest does NOT name or repeat -> not superseded');
  check((listed.get(gone.id) || []).includes('worker-done'), 'WORKER-DONE: its master is gone');
  check((listed.get(signed.id) || []).includes('worker-done'), 'WORKER-DONE: it ended on a completion report');
  check((listed.get(full.id) || []).includes('context-full'), 'CONTEXT-FULL-AND-ENDED: full and ended');
  check(!listed.has(fullAsks.id), 'context full but NOT ended -> not listed');

  const snap = { sessions: Object.values(S).map(s => ({ sessionId: s.id, running: s.id === disp.id, awaiting: false, unread: false, isArchived: false })) };
  const res2 = archive.collect({ index, snapshot: snap, now: NOW, digestText });
  check(!res2.rows.some(r => r.s.id === disp.id), 'the live Desktop snapshot wins: running there -> held back even if the index says idle');
  check(res2.held.some(r => r.s.id === unknown.id) === false && res2.rows.some(r => r.s.id === unknown.id), 'with a snapshot row the live state is known again');

  const file = path.join(TMP, 'ARCHIVE-CANDIDATES.md');
  const out = archive.report({ index, snapshot: null, now: NOW, digestText, file });
  check(typeof out.count === 'number' && Array.isArray(out.candidates) && out.candidates.every(c => c.sessionId && 'title' in c && 'group' in c && 'idleDays' in c && typeof c.reason === 'string')
    && typeof out.protectedFromArchiving === 'number' && typeof out.note === 'string', 'the JSON keeps the old tool shape (count, candidates[sessionId,title,group,idleDays,reason], protectedFromArchiving, note)', out);
  const md = fs.readFileSync(file, 'utf8');
  check(/show the user the list first; archive only what they approve/i.test(md), 'the report carries the instruction: show the list first, archive only what is approved');
  check(/## SUPERSEDED/.test(md) && /## Ready calls/.test(md) && /relaymote_archive\(session_ids=/.test(md) && /## Held back/.test(md), 'per-reason sections, ready calls and a held-back list');
  const custom = archive.collect({ index, snapshot: null, now: NOW, digestText, settings: { disposablePatterns: ['^long'] } });
  check(!custom.rows.some(r => r.s.id === disp.id && r.reasons.some(x => x.code === 'disposable')) && custom.rows.some(r => r.s.id === full.id && r.reasons.some(x => x.code === 'disposable')),
    'disposable title patterns come from config (an array replaces the built-in list)');
}

// ------------------------------------------------------------------ 8. wakes
function wakesTests() {
  const t0 = NOW - 3 * HOUR;
  const f = writeTranscript('slug-wakes', 'cli-wakes', [
    reply(t0),
    userMsg(t0 + 10 * MIN, '<cross-session-message from="local_aaaa" name="Master">hi</cross-session-message>'),
    reply(t0 + 11 * MIN, { cache_read_input_tokens: 9000, cache_creation_input_tokens: 100 }),
    userMsg(t0 + 100 * MIN, 'plain text from a peer', { origin: { kind: 'peer', from: 'local_bbbb' } }),
    reply(t0 + 101 * MIN, { cache_read_input_tokens: 0, cache_creation_input_tokens: 190000 }),
    userMsg(t0 + 110 * MIN, '[Relaymote goals] 1 goal for this session, in one message so you are woken once.'),
    reply(t0 + 111 * MIN),
    userMsg(t0 + 112 * MIN, 'the user typing'),
  ]);
  const sc = wakes.scanTranscript(f, {});
  check(sc.wakes.length === 3, 'wakes found: cross-session text, origin peer, and Relaymote\'s own message (a human turn is not a wake)', sc.wakes);
  check(sc.wakes[0].from === 'local_aaaa' && sc.wakes[0].warm && sc.wakes[0].cacheRead === 9000, 'a warm wake with its woken turn\'s REAL cache tokens', sc.wakes[0]);
  check(sc.wakes[1].from === 'local_bbbb' && !sc.wakes[1].warm && sc.wakes[1].cacheWrite === 190000, 'an origin-peer wake after 89 min is COLD and shows the cache re-write', sc.wakes[1]);
  check(sc.wakes[2].from === 'relaymote:chase', 'Relaymote\'s own chase is labelled as its sender');
  const d = wakes.daily({ now: NOW, hours: 24 });
  check(d.wakes >= 3 && d.cold >= 1 && d.cacheTokens.coldWrite >= 190000 && d.relaymote.warm >= 1, 'daily(): warm/cold, cold by sender, cache tokens, Relaymote\'s share', d);

  const log = path.join(TMP, 'wl.jsonl'), chase = path.join(TMP, 'chase.jsonl');
  wakes.logWake({ file: log, to: 'local_x', kind: 'compact', warmth: { known: true, warm: true, ageMin: 40 }, now: NOW - HOUR });
  wakes.logWake({ file: log, to: 'local_y', kind: 'notify', warmth: { known: true, warm: false, ageMin: 200 }, now: NOW - HOUR });
  wakes.logWake({ file: log, to: 'local_z', kind: 'notify', warmth: {}, now: NOW - 2 * DAY });
  fs.writeFileSync(chase, [{ at: isoAt(NOW - HOUR), kind: 'warm', ok: true, warm: true }, { at: isoAt(NOW - HOUR), kind: 'keepalive', ok: true, warm: true },
    { at: isoAt(NOW - HOUR), kind: 'cold', ok: true, warm: false }, { at: isoAt(NOW - HOUR), kind: 'spawn', ok: true }, { at: isoAt(NOW - HOUR), kind: 'warm', ok: false, warm: true }]
    .map(x => JSON.stringify(x)).join('\n') + '\n');
  const fw = wakes.forwardLog({ now: NOW, file: log, chaseLog: chase });
  check(fw.byKind.compact.warm === 1 && fw.byKind.notify.cold === 1 && fw.byKind.chase.warm === 1 && fw.byKind.chase.cold === 1 && fw.byKind.keepalive.warm === 1
    && !fw.byKind.spawn && fw.total.warm + fw.total.cold + fw.total.unknown === 5, 'forward log: compact/notify from wakes.jsonl + chase/keepalive from chase.jsonl; spawns, failures and old rows excluded', fw);
  const daily = path.join(TMP, 'daily.jsonl');
  const r1 = wakes.rollup({ now: NOW, file: daily, wakeLog: log, chaseLog: chase, measure: () => ({ wakes: 3, warm: 2, cold: 1 }) });
  const r2 = wakes.rollup({ now: NOW + HOUR, file: daily, wakeLog: log, chaseLog: chase, measure: () => ({ wakes: 0 }) });
  const r3 = wakes.rollup({ now: NOW + HOUR, file: daily, force: true, wakeLog: log, chaseLog: chase, measure: () => ({ wakes: 0 }) });
  check(r1 && r1.forward && r1.wakes === 3 && r2 === null && r3, 'rollup(): one line a day (a second inside 24 h is refused unless forced)');
  check(fs.readFileSync(daily, 'utf8').trim().split('\n').length === 2 && wakes.lastRollup(daily).at === isoAt(NOW + HOUR), 'wakes-daily.jsonl holds the roll-ups; lastRollup reads the newest');
}
async function instrumentTest() {
  fs.rmSync(wakes.WAKELOG(), { force: true });
  const w = wakes.instrument(async (sid) => ({ ok: sid !== 'local_fail' }), 'notify', { warmth: async () => ({ known: true, warm: true, ageMin: 3 }) });
  await w('local_ok', '[Relaymote] Fleet update\nmore');
  await w('local_fail', 'x');
  const rows = fs.readFileSync(wakes.WAKELOG(), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  check(rows.length === 1 && rows[0].to === 'local_ok' && rows[0].kind === 'notify' && rows[0].inside === true && rows[0].what === '[Relaymote] Fleet update',
    'instrument(): a successful send is logged with its warmth (inside the window); a failed send is not', rows);
}

(async () => {
  try {
    await guards();
    await route();
    await files();
    archiveTests();
    wakesTests();
    await instrumentTest();
  } catch (e) { check(false, 'threw: ' + (e && e.stack || e)); }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  console.log(failed ? `\n${failed} FAILED` : '\nall hygiene tests passed');
  process.exit(failed ? 1 : 0);
})();
