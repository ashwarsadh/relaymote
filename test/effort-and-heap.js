// g1133: an effort change from the phone flickered back and showed "effort not found" although Desktop
// had taken it. The change went through the click-driven UI queue, the answer came back later over SSE,
// and the session list (built from Desktop's on-disk record, written late) kept serving the old value.
// It is now one LocalSessions.setEffort call, read back from Desktop and answered in the same request.
// g1132: the daemon's heap reached 2.5 GB. A stream whose reader stopped reading buffered without end,
// and nothing told retained memory from garbage.
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
let fails = 0;
const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) fails++; };
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

const desk = read('lib', 'desktop.js');
const br = desk.slice(desk.indexOf('async function setEffortBridge'), desk.indexOf('async function setEffort(sessionId'));
const e2c = desk.slice(desk.indexOf('const EFFORT_TO_CLI'), desk.indexOf('const EFFORT_TO_CLI') + 200);
check(/extra: 'xhigh'/.test(e2c), "the phone's \"extra\" is sent as Desktop's real value xhigh");
check(/setTierBackground\('effort'/.test(br), 'it uses the one background setter (no second implementation)');
const tb = desk.slice(desk.indexOf('async function setTierBackground'), desk.indexOf('async function setTierBackground') + 4000);
check(/ultracode:false/.test(tb) && /okFinal/.test(tb), '...which switches Ultracode off before a level and fails unless Desktop reports the level');
check(/NO_BRIDGE_OR_SESSION' \? 'Desktop has no such session/.test(br), 'a missing session is said plainly');
check(/error === 'NO_BRIDGE'\) return \{ ok: false, bridged: false/.test(br), 'only an unreachable bridge falls back to the UI');

const idx = read('mobile', 'index.js');
const route = idx.slice(idx.indexOf("if (p === '/api/effort')"), idx.indexOf("if (p === '/api/effort')") + 2200);
check(/setEffortBridge/.test(route) && /sync: true/.test(route), 'the route answers in the same request (no queued job, no late SSE result)');
check(/out\.bridged === false\) return uiJob/.test(route), 'only a value the bridge cannot set goes through the UI queue');
check(/json\(res, out && out\.ok \? 200 : 400/.test(route), 'a genuine failure is a 400 carrying the reason');
check(/effortOverlay\.set/.test(route), 'a confirmed change is remembered until Desktop rewrites its record');
check(/effort: effortFor\(s\)/.test(idx), 'the session list serves the confirmed effort, so the header cannot show the old one');

// effortFor: functional check of the overlay rules.
const ef = idx.slice(idx.indexOf('const effortOverlay'), idx.indexOf('const effortOverlay') + 600).split('\n').slice(0, 9).join('\n');
const fn = new Function('normEffort', ef + '\nreturn { effortOverlay, effortFor };')(v => v === 'xhigh' ? 'extra' : v);
fn.effortOverlay.set('a', { effort: 'max', at: Date.now() });
check(fn.effortFor({ id: 'a', effort: 'high' }) === 'max', 'while the record is stale, the confirmed value is served');
check(fn.effortFor({ id: 'a', effort: 'max' }) === 'max' && !fn.effortOverlay.has('a'), 'once the record agrees, the overlay is dropped');
fn.effortOverlay.set('b', { effort: 'low', at: Date.now() - 11 * 60000 });
check(fn.effortFor({ id: 'b', effort: 'xhigh' }) === 'extra', 'an old overlay never outlives the record (a change made on the PC wins)');

const app = read('mobile', 'public', 'app.js');
const sync = app.slice(app.indexOf('if (d && d.sync)'), app.indexOf('if (d && d.sync)') + 500);
check(/state\.meta\[field\] = m\[field\]/.test(sync) && /renderHeader\(m\)/.test(sync), 'the phone updates header and picker from the confirmed answer at once');
check(/set to /.test(sync) && !/not found/.test(sync), 'a success says "set to", never an error');

const segFn = app.slice(app.indexOf('function seg('), app.indexOf('function seg(') + 900);
check(!/toast\(v \+ ' set'\)/.test(segFn), 'no blanket success toast after a pick (it covered a true failure with "set")');
const pk = app.slice(app.indexOf('const pick = (endpoint'), app.indexOf('const pick = (endpoint') + 3000);
check(/toast\(op \+ ' failed: ' \+ e\.message, true\);\s*undo\(\);/.test(pk), 'a genuine failure toasts the reason and undoes the change');
check(/const undo = [\s\S]{0,120}tierOverride\[field\] = was/.test(pk),
      '...including the 20 s override the sheet prefers, so the PICKER goes back too, not only the header');

// g1132
const sse = idx.slice(idx.indexOf('function sseSend'), idx.indexOf('function sseSend') + 700);
check(/writableLength/.test(sse) && /clients\.delete\(c\)/.test(sse) && /destroy\(\)/.test(sse), 'a stream that stopped reading is dropped, not buffered without end');
const srv = read('server.js');
check(/--expose-gc/.test(srv) && /after full gc/.test(srv), 'the heartbeat logs what survives a full collection');

check(/heap-snapshot.request/.test(srv) && /writeHeapSnapshot/.test(srv), 'a heap snapshot can be asked for without restarting the daemon');

if (fails) { console.error(fails + ' failed'); process.exit(1); }
console.log('effort-and-heap: all checks passed');
