// test/models.js - model and effort identity, everywhere Relaymote compares them.
//
// A family compare ("opus" === "opus") must never stand in for an identity compare. It lit BOTH
// "Opus 5.5" and "Opus 5" on the phone's session sheet for a session on claude-opus-5-5, and it
// hid three more faults:
//   - lib/desktop.js modelMatcher: a family PREFIX, so set_model "Opus 5" clicked the first opus item
//     (Opus 5.5) and then verified it with the same prefix, a wrong switch reported as success;
//   - lib/desktop.js setEffort verify: new RegExp('high') also matched "Extra high";
//   - mobile app.js confirm-switch: opus-5 -> opus-5-5 was treated as "same model, no dialog".
//
//   node test/models.js
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log(`  ok   ${name}`); pass++; } catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; } }

// The five models the desktop offers, each as label / raw session id / 1M-context id.
const MODELS = [
  { label: 'Opus 5.5', id: 'claude-opus-5-5', big: 'claude-opus-5-5[1m]' },
  { label: 'Opus 5', id: 'claude-opus-5', big: 'claude-opus-5[1m]' },
  { label: 'Fable 5.1', id: 'claude-fable-5-1', big: 'claude-fable-5-1' },
  { label: 'Sonnet 5', id: 'claude-sonnet-5', big: 'claude-sonnet-5[1m]' },
  { label: 'Haiku 4.5', id: 'claude-haiku-4-5-20251001', big: 'claude-haiku-4-5' },
];
const LABELS = MODELS.map(m => m.label);

// ---------------------------------------------------------------- lib/desktop.js ------------------
const D = require(path.join(__dirname, '..', 'lib', 'desktop.js'));
const SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'desktop.js'), 'utf8');
console.log('\n-- lib/desktop.js --');

t('sameModel: every label equals its own ids and NO other model (5x5)', () => {
  for (const a of MODELS) for (const b of MODELS) {
    for (const v of [b.id, b.big]) {
      assert.strictEqual(D.sameModel(a.label, v), a === b, `${a.label} vs ${v}`);
    }
  }
});
t('modelMatcher: each label matches exactly ONE menu item (the screenshot case: Opus 5 != Opus 5.5)', () => {
  for (const m of MODELS) {
    const hits = LABELS.filter(l => D.modelMatcher(m.label).test(l));
    assert.deepStrictEqual(hits, [m.label], `${m.label} matched ${JSON.stringify(hits)}`);
  }
});
t('modelMatcher: a raw id also resolves to exactly its own label', () => {
  for (const m of MODELS) assert.deepStrictEqual(LABELS.filter(l => D.modelMatcher(m.id).test(l)), [m.label]);
});
t('modelMatcher: a bare family alias still works ("opus" -> both opus labels, never another family)', () => {
  assert.deepStrictEqual(LABELS.filter(l => D.modelMatcher('opus').test(l)), ['Opus 5.5', 'Opus 5']);
  assert.deepStrictEqual(LABELS.filter(l => D.modelMatcher('haiku').test(l)), ['Haiku 4.5']);
});
// The PAGE-SIDE pick runs inside the desktop, so lift its exact norm() and predicate from the source.
t('page-side menu pick: exact for versions, first-of-family for a bare alias', () => {
  const m = /var norm=(function\(s\)\{[^\n]+\});/.exec(SRC);
  assert.ok(m, 'page-side norm() not found in lib/desktop.js');
  const norm = eval('(' + m[1] + ')');
  const pick = (want, bare) => LABELS.find(n => bare ? norm(n).split('-')[0] === want : norm(n) === want);
  for (const x of MODELS) {
    const mm = D.modelMatcher(x.label);
    assert.strictEqual(pick(mm.source, mm.bare), x.label, `menu pick for ${x.label}`);
  }
  const a = D.modelMatcher('opus');
  assert.strictEqual(pick(a.source, a.bare), 'Opus 5.5', 'bare "opus" takes the first opus, the desktop default');
});
t('sameEffort: exact names, CLI and label aliases; "high" is NOT "Extra high"', () => {
  const E = ['low', 'medium', 'high', 'extra', 'max', 'ultracode'];
  for (const a of E) for (const b of E) assert.strictEqual(D.sameEffort(a, b), a === b, `${a} vs ${b}`);
  assert.strictEqual(D.sameEffort('Extra high', 'high'), false);
  assert.strictEqual(D.sameEffort('Extra high', 'extra'), true);
  assert.strictEqual(D.sameEffort('xhigh', 'Extra'), true);
  assert.strictEqual(D.sameEffort('Effort: Medium', 'medium'), true);
});
t('no family/prefix/substring model or effort compare left in setModel/setEffort', () => {
  assert.ok(!/indexOf\(fam\)===0/.test(SRC), 'page-side family prefix still present');
  assert.ok(!/new RegExp\(key, 'i'\)\.test\(now/.test(SRC), 'effort substring verify still present');
  assert.ok(!/startsWith\(family\)/.test(SRC), 'family prefix matcher still present');
});

// ---------------------------------------------------------------- mobile/public/app.js ------------
console.log('\n-- mobile/public/app.js --');
const APP = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'public', 'app.js'), 'utf8');
function lift(name) {
  const m = new RegExp('^const ' + name + ' = [\\s\\S]*?;\\r?\\n(?=[^\\s}])', 'm').exec(APP);   // app.js is CRLF; a line starting "}" is still inside
  if (!m) throw new Error('app.js: const ' + name + ' not found');
  return m[0];
}
const A = new Function(['shortModel', 'modelFamily', 'modelId', 'sameModel', 'pickByFamily'].map(lift).join('\n') +
  '\nreturn { modelId, sameModel, pickByFamily };')();

t('app sameModel: 5x5 identity, labels vs raw and [1m] ids', () => {
  for (const a of MODELS) for (const b of MODELS) for (const v of [b.id, b.big]) {
    assert.strictEqual(A.sameModel(a.label, v), a === b, `${a.label} vs ${v}`);
  }
});
t('app highlight: a session on each model lights EXACTLY ONE button (the screenshot bug)', () => {
  for (const m of MODELS) {
    for (const v of [m.id, m.big]) {
      const hit = A.pickByFamily(LABELS, v);
      const lit = LABELS.filter(l => l === hit);
      assert.deepStrictEqual(lit, [m.label], `${v} lit ${JSON.stringify(lit)}`);
    }
  }
});
t('app: opus-5 -> opus-5-5 is a model SWITCH (the confirm dialog must show)', () => {
  assert.strictEqual(A.sameModel('claude-opus-5', 'Opus 5.5'), false);
  assert.ok(/field === 'model' && was && !sameModel\(was, v\)/.test(APP), 'confirm-switch still compares families');
});
t('app: renderTier no longer toggles by family', () => {
  assert.ok(!/toggle\('on', modelFamily\(b\.textContent\) === modelFamily/.test(APP), 'family toggle still present');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
