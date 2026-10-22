// principal-touch.js — g1875: Sagar's phone lists his Conductor plus the sessions he (or his Conductor) acted
// on in the last 7 days; Ashwar's list tags them and can show / fold / hide the ones Sagar started.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

let failed = 0;
const check = (ok, name, extra) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra !== undefined && !ok ? '  ' + JSON.stringify(extra).slice(0, 400) : ''}`); if (!ok) failed++; };

process.env.RELAYMOTE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-touch-'));
const T = require('../mobile/principal-touch');
const P = require('../mobile/principals');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'touch-dir-'));
T._reset(path.join(dir, 'ledger.json'));

const id = (n) => 'local_' + String(n).padStart(8, '0') + '-0000-4000-8000-000000000000';
const SAGAR_C = id(1), ASH_C = id(2), SHARED = id(3), STARTED = id(4), QUOTED = id(5), OLD = id(6), UNTOUCHED = id(7), PHONE = id(8);
fs.writeFileSync(path.join(dir, 'principals.json'), JSON.stringify({ default: 'ashwar', principals: {
  ashwar: { name: 'Ashwar', conductor: null }, sagar: { name: 'Sagar', conductor: SAGAR_C, sees: 'own' } } }));
fs.writeFileSync(path.join(dir, 'INDEX.md'), 'Conductor id: ' + ASH_C + '\n');

const now = Date.now(), iso = (ms) => new Date(ms).toISOString();
const tu = (ts, tid, name, input) => JSON.stringify({ type: 'assistant', timestamp: iso(ts), message: { content: [{ type: 'tool_use', id: tid, name, input }] } });
const tr = (ts, tid, text) => JSON.stringify({ type: 'user', timestamp: iso(ts), message: { content: [{ type: 'tool_result', tool_use_id: tid, content: text }] } });
const lines = [
  tu(now - 3600e3, 't1', 'mcp__ccd_session_mgmt__send_message', { session_id: SHARED, message: 'see also ' + QUOTED }),
  tr(now - 3600e3, 't1', 'delivered'),
  tu(now - 1800e3, 't2', 'mcp__ccd_session__start_session', { title: 'x', prompt: 'context: ' + QUOTED }),
  tr(now - 1800e3, 't2', 'Started session ' + STARTED + '.'),
  tu(now - 9 * 86400e3, 't3', 'SendMessage', { to: OLD, message: 'old' }),
  tu(now - 600e3, 't4', 'SendMessage', { to: ASH_C, message: 'Sagar asks: needs Ashwar tap' }),
  tu(now - 500e3, 't5', 'mcp__ccd_session_mgmt__list_events', { session_id: UNTOUCHED }),
];
const tfile = path.join(dir, 'sagar-conductor.jsonl');
fs.writeFileSync(tfile, lines.join('\n') + '\n');
T.refresh(dir, (sid) => (sid === SAGAR_C ? tfile : null), { force: true });

const list = [SAGAR_C, ASH_C, SHARED, STARTED, QUOTED, OLD, UNTOUCHED, PHONE].map((x, i) => ({ id: x, title: 't' + i }));
const sag = P.resolve(dir, 'sagar'), ash = P.resolve(dir, '');
const ids = (l) => l.map(s => s.id).sort().join(',');
check(ids(T.view(list, sag, dir)) === [SAGAR_C, SHARED, STARTED].sort().join(), "Sagar sees his Conductor + what he sent to/started in 7 days", T.view(list, sag, dir).map(s => s.id));
check(!T.view(list, sag, dir).some(s => s.id === QUOTED), 'an id merely quoted in a message or a prompt is not a touch');
check(!T.view(list, sag, dir).some(s => s.id === UNTOUCHED), 'reading a session (list_events) is not a touch');
check(!T.view(list, sag, dir).some(s => s.id === ASH_C), "Ashwar's Conductor never lands on Sagar's list, even when he escalates to it");
check(!T.view(list, sag, dir).some(s => s.id === OLD), 'a session untouched for over a week hides again');

// It comes back the moment his Conductor touches it again (incremental read from the saved offset).
fs.appendFileSync(tfile, tu(now, 't6', 'SendMessage', { to: OLD, message: 'again' }) + '\n');
T.refresh(dir, (sid) => (sid === SAGAR_C ? tfile : null), { force: true });
check(T.view(list, sag, dir).some(s => s.id === OLD), 'touched again -> shows again');

// Sagar's own phone actions (X-Relaymote-As: sagar) count too.
T.note(PHONE, 'sagar', { started: true });
check(T.view(list, sag, dir).some(s => s.id === PHONE), 'a session he started from his phone is his');

// Ashwar: everything, tagged; started-by-Sagar rows are othersOnly, shared ones are not.
const av = T.view(list, ash, dir);
const row = (x) => av.find(s => s.id === x);
check(av.length === list.length, "Ashwar's list keeps every session");
check(row(SHARED).by && row(SHARED).by[0].name === 'Sagar' && !row(SHARED).othersOnly, 'shared session: Sagar tag, stays visible', row(SHARED));
check(row(STARTED).othersOnly && row(SAGAR_C).othersOnly, 'Sagar-started sessions and his Conductor are othersOnly', [row(STARTED), row(SAGAR_C)]);
check(!row(UNTOUCHED).by && !row(ASH_C).by, 'untouched sessions carry nothing');

// The ledger survives a restart (re-read from disk) without re-counting the transcript.
T._reset(path.join(dir, 'ledger.json'));
check(T.view(list, sag, dir).some(s => s.id === STARTED), 'ledger persists across restarts');

// 22-Oct, Ashwar: "i sent 2 commands by msitake to ajay conductor ... can hide those session from ajay unless
// ajay sends prompt related to cad". A release takes it off his list, durably, until his Conductor acts again.
{
  check(T.view(list, sag, dir).some(s => s.id === SHARED), 'control: before the release Sagar sees SHARED');
  const r = T.release(SHARED, 'sagar');
  check(r.ok && r.had && !T.view(list, sag, dir).some(s => s.id === SHARED), 'released -> gone from his list', r);
  check(!(T.view(list, ash, dir).find(s => s.id === SHARED) || {}).by, "Ashwar's list no longer tags it as Sagar's");
  // A full re-read of his Conductor's transcript (ledger offsets lost) must not bring the old touch back.
  const L = JSON.parse(fs.readFileSync(path.join(dir, 'ledger.json'), 'utf8'));
  L.files = {}; fs.writeFileSync(path.join(dir, 'ledger.json'), JSON.stringify(L));
  T._reset(path.join(dir, 'ledger.json'));
  T.refresh(dir, (sid) => (sid === SAGAR_C ? tfile : null), { force: true });
  check(!T.view(list, sag, dir).some(s => s.id === SHARED), 'after a restart and a full transcript re-read it stays released');
  check(T.view(list, sag, dir).some(s => s.id === STARTED), 'other sessions are untouched by the release');
  // His Conductor sends to it again -> back.
  fs.appendFileSync(tfile, tu(Date.now() + 1000, 't7', 'SendMessage', { to: SHARED, message: 'CAD prompt' }) + '\n');
  T.refresh(dir, (sid) => (sid === SAGAR_C ? tfile : null), { force: true });
  check(T.view(list, sag, dir).some(s => s.id === SHARED), 'touched again by his Conductor after the release -> shows again');
  const idx = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'index.js'), 'utf8');
  check(/p === '\/api\/principal\/release'/.test(idx) && !/WRITE_OK[\s\S]{0,400}\/api\/principal\/release/.test(idx),
    'the release route exists and is not open to a scoped login');
}

// The owner's chip: show / fold / hide, taken from app.js as written.
const app = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'public', 'app.js'), 'utf8');
const fn = app.slice(app.indexOf('function applyFold'), app.indexOf('function renderSessions'));
const ctx = { state: {} }; vm.createContext(ctx); vm.runInContext(fn + '; this.applyOthers = applyOthers;', ctx);
const sample = [{ id: 'a' }, { id: 'b', by: [{ name: 'Sagar' }] }, { id: 'c', by: [{ name: 'Sagar', started: true }], othersOnly: true }];
const r = (m) => ctx.applyOthers(sample, m);
check(r('show').rows.length === 3 && !r('show').folded.length, 'Others: shown -> all rows');
check(r('fold').rows.map(s => s.id).join() === 'a,b' && r('fold').folded.map(s => s.id).join() === 'c', 'Others: folded -> his own sessions in one group, shared stay');
check(r('hide').rows.map(s => s.id).join() === 'a,b' && !r('hide').folded.length, 'Others: hidden -> his own sessions gone, shared stay');

console.log(failed ? `\n${failed} FAILED` : '\nall principal-touch checks passed');
process.exit(failed ? 1 : 0);
