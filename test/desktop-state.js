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
check(/RELAYMOTE_NO_LAUNCH === '1' \|\| process\.env\.RELAYMOTE_NO_SEND === '1'/.test(src) && /2 \* 60000/.test(src) && /launches\.length >= 3/.test(src), 'auto-open: never in tests, after 2 min gone, at most 3 an hour');
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

fs.rmSync(tmp, { recursive: true, force: true });
if (fails) { console.error(fails + ' failed'); process.exit(1); }
console.log('desktop-state: all checks passed');
