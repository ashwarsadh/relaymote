// g1587: after a PC restart Claude Desktop came back signed out and the phone said only "desktop link
// down". Each cause now has its own state and words, and Relaymote repairs what it can (opens Claude,
// switches Developer Mode on). g1588: "list failed 530" / "send failed 502" are plain sentences.
const fs = require('fs'), os = require('os'), path = require('path');
let fails = 0;
const check = (ok, what, got) => { console.log((ok ? 'ok   ' : 'FAIL ') + what + (ok || got === undefined ? '' : '  ' + JSON.stringify(got))); if (!ok) fails++; };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-desk-'));
process.env.APPDATA = path.join(tmp, 'appdata');
process.env.RELAYMOTE_HOME = path.join(tmp, 'home');
process.env.RELAYMOTE_NO_LAUNCH = '1';
fs.mkdirSync(path.join(process.env.APPDATA, 'Claude'), { recursive: true });
const ds = require('../lib/desktop-state');

const c = (f) => ds.classify({ now: Date.now(), ...f });
check(c({ cdp: true }) === 'ok', 'link up: no banner');
check(c({ cdp: false, running: false, exe: null }) === 'missing', 'Claude.exe not found: says so and how to install');
check(c({ cdp: false, running: false, exe: 'C:/x/claude.exe', launches: [] }) === 'starting', 'Claude not running: Relaymote is opening it');
check(c({ cdp: false, running: false, exe: 'C:/x/claude.exe', launches: [Date.now(), Date.now(), Date.now()] }) === 'wont-launch', 'opened three times and still not running: will not start');
check(c({ cdp: false, running: true, debugger: { code: 10 } }) === 'signed-out', 'running on its Sign In screen: not logged in');
check(c({ cdp: false, running: true, debugger: { code: 3 }, devMode: true }) === 'dev-off', 'no Developer menu: developer option off');
check(c({ cdp: false, running: true, devMode: false }) === 'dev-off', 'developer setting off in the file: developer option off');
check(c({ cdp: false, running: true, debugger: { code: 9 }, devMode: true }) === 'locked', 'PC locked: says unlock');
check(c({ cdp: false, running: true, debugger: { code: 8 }, devMode: true }) === 'disconnected', 'Remote Desktop closed: says connect once');
check(c({ cdp: false, running: true, debugger: { code: 5 }, devMode: true }) === 'link-off', 'anything else: link off, retrying');
check(ds.TEXT['signed-out'].title === 'Relaymote is connected, but Claude is not logged in' && /Log in to Claude/.test(ds.TEXT['signed-out'].text), 'the signed-out words are his: connected, but Claude is not logged in — log in');
check(/developer option is off/.test(ds.TEXT['dev-off'].title), 'the developer-off words name the developer option');

check(ds.ensureDevMode() === true && ds.devModeOn() === true, 'Relaymote switches Developer Mode on by itself');
check(ds.ensureDevMode() === false, 'and leaves it alone when it is already on');

process.env.RELAYMOTE_SIM_DESKTOP = 'signed-out';
check(ds.get().state === 'signed-out' && ds.get().title === ds.TEXT['signed-out'].title, 'the simulation seam pins a state (demo screenshots)');
delete process.env.RELAYMOTE_SIM_DESKTOP;

// tick() never opens Claude in a test, and opens it only after two minutes gone, at most 3 times an hour.
const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'desktop-state.js'), 'utf8');
check(/RELAYMOTE_NO_LAUNCH === '1' \|\| process\.env\.RELAYMOTE_NO_SEND === '1'/.test(src) && /2 \* 60000/.test(src) && /recent\.length >= 3/.test(src), 'auto-open: never in tests, after 2 min gone, at most 3 an hour');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
check(/deskState\.tick\(\{ running: !!pid/.test(server) && /deskState\.note\(\{ debugger:/.test(server), 'the server feeds every debugger outcome into the state');
const mob = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'index.js'), 'utf8');
check((mob.match(/desktop: deskNow\(\),/g) || []).length === 3, 'the phone gets the state with boot, every list poll and the desktop check');

// The phone's words for a PC it cannot reach.
const app = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'public', 'app.js'), 'utf8');
const blk = app.slice(app.indexOf('const CONN_TITLE = {'), app.indexOf('const isPcDownStatus') ) + app.slice(app.indexOf('const isPcDownStatus'), app.indexOf('\n', app.indexOf('const isPcDownStatus')));
const f = new Function('navigator', blk + '\nreturn { connErr, isPcDownStatus };')({ onLine: true });
check(f.isPcDownStatus(530) && f.isPcDownStatus(502) && f.isPcDownStatus(524) && !f.isPcDownStatus(500), '530 / 502 / 52x mean the PC cannot be reached');
check(/^Your PC can't be reached/.test(f.connErr('pc-down', 530).message) && /\(code 530\)$/.test(f.connErr('pc-down', 530).message), '"list failed 530" is now "Your PC can\'t be reached …" (code kept at the end)');
const off = new Function('navigator', blk + '\nreturn connErr;')({ onLine: false })('net');
check(off.kind === 'offline' && /^Your phone is offline/.test(off.message), 'with the phone offline it says the phone is offline');
check(/if \(!msg && isPcDownStatus\(r\.status\)\) throw connErr\('pc-down', r\.status\)/.test(app), 'apiOnce maps those statuses instead of throwing the bare number');
check(!/toast\('List failed: ' \+ e\.message/.test(app), 'no more "List failed: 530" toast; it goes to the banner');
check(/This phone needs pairing/.test(app) && /pairingPage\(\)/.test(mob), 'no valid pairing: the pairing screen, which he can complete himself');

// g1638: "so claude exited relaymote didnt restart it of i used the app". Opening the app or sending
// reopens Desktop — once, in Relaymote's own session — and the CLI's claude.exe never counts as Desktop.
(async () => {
  check(/-notmatch "\\\\\\\\claude-code\\\\\\\\"/.test(src) && /\$_\.SessionId -eq \$me/.test(src) && /AnthropicClaude/.test(src),
        'the probe counts only the Desktop app (not the Claude Code CLI, also claude.exe) and only in Relaymote\'s own session');
  check(c({ cdp: false, running: false, exe: 'x', launchedAt: Date.now() - 30000 }) === 'restarting'
        && c({ cdp: false, running: true, debugger: { code: 1 }, devMode: true, launchedAt: Date.now() - 30000 }) === 'restarting',
        'just reopened: "Restarting Claude…" until the link is back');
  check(c({ cdp: false, running: true, debugger: { code: 10 }, launchedAt: Date.now() - 30000 }) === 'signed-out', 'reopened onto the Sign In screen still says: log in');
  check(ds.TEXT.restarting.title === 'Restarting Claude…', 'the words are "Restarting Claude…"');

  delete process.env.RELAYMOTE_NO_LAUNCH;
  ds._s.exe = 'C:/fake/AnthropicClaude/claude.exe';
  let launched = 0, desk = { session: 3, main: [], count: 0, explorer: true };
  ds._seams(() => desk, () => { launched++; });
  const rs = await Promise.all([ds.wake({ why: 'app opened' }), ds.wake({ why: 'app opened' }), ds.wake({ why: 'message sent' })]);
  check(launched === 1 && rs.every(r => r.ok), 'three opens at once: Desktop is started ONCE', { launched, rs });
  check(ds.get().state === 'restarting', 'and the phone is told "Restarting Claude…"', ds.get().state);
  ds._s.lastWakeProbe = 0;
  await ds.wake({ why: 'app opened' });
  check(launched === 1, 'a second open within 90 s does not start it again');
  ds._s.launchedAt = Date.now() - 100000; ds._s.lastWakeProbe = 0; desk = { session: 3, main: [4242], count: 5, explorer: true };
  const up = await ds.wake({ why: 'app opened' });
  check(launched === 1 && up.running, 'Desktop already running in this session: nothing is started');
  ds._s.lastWakeProbe = 0; desk = { session: 0, main: [], count: 0, explorer: false };
  const s0 = await ds.wake({ why: 'app opened' });
  check(launched === 1 && s0.error === 'no-desktop-session', 'Relaymote in a session with no desktop (session 0 / a service): it refuses, never opens Claude where nobody sees it');
  const mob2 = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'index.js'), 'utf8');
  check(/if \(p === '\/api\/bootstrap'\) \{\n    await cdpCached\(\); wakeDesktop\('app opened'\);/.test(mob2) && /error: 'DESKTOP_RESTARTING'/.test(mob2), 'opening the app and sending both wake it; a send meanwhile is held, not failed');
  check(app.includes("if (e.code === 'DESKTOP_RESTARTING')") && app.includes('state.deskPoll = setInterval('), 'the phone keeps the message waiting and re-checks every 8 s, so it reconnects by itself');
  ds._seams(null, null);
  // "didnt auto enable dev mode after i restarted the app myself": every Desktop start gets a quick burst.
  check(/setInterval\(\(\) => \{ desktopWatch\(\)/.test(server) && /if \(pid !== debuggerPid\) newDesktop\(pid\)/.test(server) && /const BURST_MS = \[8000/.test(server),
        'any new Desktop (his restart, a relaunch, a reboot) is seen within 10 s and its link switched on in a burst of quick tries');
  check(/debuggerNext = early \? 0 : Date\.now\(\) \+ 10 \* 60000/.test(server) && /debuggerTries\+\+/.test(server), 'a miss in the first 3 min is retried in seconds, still at most 3 failed clicks a run');
  // g1662: after a reboot one UI step hung and the switch-on queued behind it; opening the app did nothing.
  check(!/serialise\(debuggerTick\)/.test(server) && /setInterval\(runDebuggerTick, 60000\)/.test(server) && /lastCdpOk = await desktop\.cdpAvailable\(\)/.test(server),
        'the debugger switch-on never waits in the UI queue and reads the link itself');
  check(/deskState\.onAppOpen\(\)/.test(mob) || /deskState\.onAppOpen\(\)/.test(fs.readFileSync(path.join(__dirname, '..', 'mobile', 'index.js'), 'utf8')), 'opening the app with Desktop up and the link off tries the switch-on at once');
  check(/debuggerNext = 0; debuggerTries = 0; runDebuggerTick\(\)/.test(server) && /< 60000\) return;/.test(server), 'even after misses, at most once a minute');
  const dsk = fs.readFileSync(path.join(__dirname, '..', 'lib', 'desktop.js'), 'utf8');
  const heal = fs.readFileSync(path.join(__dirname, '..', 'lib', 'heal.js'), 'utf8');
  check(/UI_STEP_MAX_MS = 300000/.test(dsk) && /Promise\.race\(\[Promise\.resolve\(\)\.then\(fn\), stuck\]\)/.test(dsk), 'no UI step holds the queue past 5 min, and the stuck one is named');
  check(/taskkill', \['\/PID', String\(child\.pid\), '\/T', '\/F'\]/.test(heal) && /}, 75000\);/.test(heal), 'a switch-on run is killed and answered at 75 s even if its pipes stay open');
  check(/pid === null && deskState\.ensureDevMode\(\)/.test(server), 'Developer Mode is switched on while Desktop is closed, so the next start reads it');

  fs.rmSync(tmp, { recursive: true, force: true });
  if (fails) { console.error(fails + ' failed'); process.exit(1); }
  console.log('desktop-state: all checks passed');
})();
