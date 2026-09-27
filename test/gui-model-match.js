'use strict';
// g498: GUI dispatch at the router's own default model failed. "claude-opus-5-5" was prefix-matched
// against the menu text "Opus 5.5" (GUI_MODEL_NOT_OFFERED); the effort control was looked for by a
// button TEXT that no longer carries the word "Effort" (GUI_NO_EFFORT_CONTROL, so every GUI worker
// ran at the default effort); and a model failure spread its result object over task.model, so the
// retry asked for "[object Object]" -- which "passed" only because /^[object object]/ is a
// character class that matches the O of "Opus".
// Ported from AGO g498 (g378). AGO live proof: t1331, Opus 5.5 / Low on attempt 1.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const g = require(path.join(__dirname, '..', 'lib', 'gui-worker.js'));
const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'gui-worker.js'), 'utf8');
let n = 0;
const ok = (c, name) => { assert.ok(c, name); n++; console.log('ok ' + name); };

const cases = [
  ['claude-opus-5-5', 'Opus 5.5', true], ['claude-opus-5-5', 'Opus 5', false],
  ['claude-opus-5', 'Opus 5', true], ['claude-opus-5', 'Opus 5.5', false],
  ['opus', 'Opus 5.5', true], ['claude-haiku-4-5-20251001', 'Haiku 4.5', true],
  ['claude-fable-5-1', 'Fable 5.1', true], ['claude-sonnet-5', 'Sonnet 5', true],
  ['claude-sonnet-5', 'Sonnet 4.5', false], ['claude-opus-5-5[1m]', 'Opus 5.5', true],
  ['Opus 5.5', 'Opus 5.5', true], ['claude-opus-5-5', 'Fable 5.1', false],
];
for (const [id, label, want] of cases) {
  ok(new RegExp(g.modelLabelRx(id), 'i').test(label) === want, `${id} ${want ? 'matches' : 'does not match'} "${label}"`);
}
ok(!/, \{ model \}\)/.test(src) && /guiModelResult: model/.test(src), 'a model failure no longer overwrites task.model');
ok(/typeof model !== 'string'\) return \{ ok: false, error: 'GUI_BAD_MODEL'/.test(src), 'a non-string model is refused, never stringified to "[object Object]"');
ok(/data-cds="ModelSelectorEffort"/.test(src) && /l\.indexOf\('effort'\)===0/.test(src), 'the effort control is found by data-cds / aria-label, as desktop.setEffort does');
ok(!/EFFORT_LABEL/.test(src) && /desktop\.sameEffort\(now, key\)/.test(src), 'effort is verified by name, so "high" never passes as "Extra high"');
console.log(`\n${n}/${n} passed`);
