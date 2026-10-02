// Claude Desktop's usage control and panel: the shapes we read. When Desktop renames them again,
// this fails here rather than on the phone as "Could not read usage from the desktop".
const { parse, LABEL_RE, FIND_JS } = require('../mobile/usage.js');
let fails = 0;
const check = (ok, what, got) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) { fails++; console.log('     ', JSON.stringify(got)); } };

for (const l of ['Usage, Weekly · all models: 44%, Resets Mon 9:00 AM', 'Usage: Weekly · all models: 44%'])
  check(LABEL_RE.test(l), 'control label is found: ' + l.slice(0, 20), l);
check(!LABEL_RE.test('building an app for limiting instagram usage'), 'a chat title mentioning usage is not the control');

const label = 'Usage, Weekly · all models: 44%, Resets Mon 9:00 AM';
const panel = 'UsagePlan usage limits · Max (20x)Session limitResets in 1 hr 28 min16%Weekly · all modelsResets Mon 9:00 AM44%Weekly · FableResets Mon 9:00 AM2%';
let u = parse(panel, label);
check(u.plan === 'Max (20x)', 'plan', u.plan);
check(u.fiveHour && u.fiveHour.pct === 16 && /1 hr 28 min/.test(u.fiveHour.resets), 'session limit (Oct 2026 wording)', u.fiveHour);
check(u.weekly && u.weekly.pct === 44, 'weekly all models', u.weekly);
u = parse('Plan usage limits · Pro5-hour limitResets 3 PM20%Weekly · all modelsResets Mon10%', '');
check(u.fiveHour && u.fiveHour.pct === 20 && u.plan === 'Pro', 'older "5-hour limit" wording still parses', u);
u = parse('', label);
check(u.weekly && u.weekly.pct === 44, 'weekly from the label alone (no panel)', u.weekly);

// The script that actually runs inside Desktop finds the control (and skips a chat title).
const fake = (l, vis) => ({ getAttribute: () => l, offsetParent: vis ? {} : null });
global.document = { querySelectorAll: () => [fake('building an app for limiting instagram usage', true), fake(label, false), fake(label, true)] };
global.window = {};
check(eval(FIND_JS) === label && window.__relaymoteUsage, 'the in-Desktop script picks the visible usage control', null);
delete global.document; delete global.window;

if (fails) { console.error(fails + ' failed'); process.exit(1); }
console.log('usage-parse: all checks passed');
