// g1518: Haiku 5.5 is the model for easy work now (levels.easy = claude-haiku-5-5 / low). Relaymote
// treated EVERY Haiku as having no effort setting (true of Haiku 4.5), so "low" was silently dropped on
// new sessions and the phone hid the effort picker. Measured in Claude Desktop: a Haiku 5.5 session
// records effort "low" at start and keeps a later change to "medium". Only Haiku 4.x has none.
const fs = require('fs'), path = require('path');
const app = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'public', 'app.js'), 'utf8');
const ns = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'newsession.js'), 'utf8');
let fails = 0;
const check = (ok, what, got) => { console.log((ok ? 'ok   ' : 'FAIL ') + what + (got !== undefined ? '  ' + JSON.stringify(got) : '')); if (!ok) fails++; };

// a top-level `const X = ...` statement, which may run over several lines (up to the line ending in ';')
const stmt = (name) => { const i = app.indexOf('const ' + name + ' ='); let j = i;
  while (true) { const e = app.indexOf('\n', j); const line = app.slice(j, e).replace(/\s*\/\/.*$/, ''); j = e + 1; if (/;\s*$/.test(line)) return app.slice(i, e); } };
const f = new Function([stmt('shortModel'), stmt('modelId'), stmt('MODEL_HAS_EFFORT')].join('\n') + '\nreturn { modelId, MODEL_HAS_EFFORT };')();
const has = (m) => f.MODEL_HAS_EFFORT(f.modelId(m));
check(has('Haiku 5.5') && has('claude-haiku-5-5'), 'the phone offers an effort for Haiku 5.5');
check(!has('Haiku 4.5') && !has('claude-haiku-4-5-20251001'), 'and still none for Haiku 4.5');
check(has('Sonnet 5.5') && has('Opus 5.5'), 'the other models are unchanged');
check(/MODEL_HAS_EFFORT\(modelId\(state\.newModel\)\)/.test(app) && /MODEL_HAS_EFFORT\(modelId\(modelShown\)\)/.test(app),
  'the pickers pass the versioned id, not the bare family word (which cannot tell 4.5 from 5.5)');

const rx = /const wantEffort = effort && !(\/[^\n]+?\/i)\.test/.exec(ns);
const noEffort = rx && new Function('return ' + rx[1])();
check(!!noEffort && !noEffort.test('claude-haiku-5-5') && noEffort.test('claude-haiku-4-5-20251001'),
  'a new session on Haiku 5.5 is started with the effort asked for (levels.easy "low")');

if (fails) { console.error(fails + ' failed'); process.exit(1); }
console.log('haiku-effort: all checks passed');
