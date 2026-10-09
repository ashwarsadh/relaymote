// g1078: text typed while a session is thinking must stay in the box. A render used to retire "the
// draft" when its text appeared in any message, and the draft was what he was typing, so "the" (or
// "A", one keystroke in) matched and the box emptied. This runs the client's own draft code against a
// fake box and storage: a render, the turn ending, a re-open and a failed send must all leave it.
const fs = require('fs'), path = require('path');
let fails = 0;
const check = (ok, what, got) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) { fails++; if (got !== undefined) console.log('     ', JSON.stringify(got)); } };

const app = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'public', 'app.js'), 'utf8');
// The draft helpers run from `const draftKey` to the blank line after restoreFailed; retireSpentDraft is
// its own function further down.
const block = app.slice(app.indexOf('const draftKey = '), app.indexOf('\n}\n', app.indexOf('function restoreFailed')) + 3);
const retire = app.slice(app.indexOf('// Retires the SENT record'), app.indexOf('\n}\n', app.indexOf('function retireSpentDraft')) + 3);

const store = new Map();
const localStorage = { getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
const box = { value: '' };
const state = { open: 'local_a' };
const env = new Function('localStorage', 'state', '$', 'autosize',
  block + '\n' + retire + '\nreturn { saveDraft, loadDraft, clearDraft, markUnsent, loadUnsent, retireSpentDraft, restoreFailed };');
const d = env(localStorage, state, () => box, () => {});

const type = (t) => { box.value = t; d.saveDraft(state.open, t); };   // what the input listener does
const msgs = [
  { role: 'user', text: 'check the meter bills' },
  { role: 'assistant', text: 'A note: the reader keeps the earlier reply and the meter checks re-run.' },
];

// The bug, keystroke by keystroke: "A", "Al", ... each followed by a render, as a streaming turn does.
for (const t of ['A', 'Al', 'Also', 'Also check the']) { type(t); d.retireSpentDraft(msgs); }
check(box.value === 'Also check the', 'typing during a streaming turn: the box keeps every keystroke', box.value);
check(d.loadDraft('local_a') === 'Also check the', 'and the saved draft matches the box', d.loadDraft('local_a'));

type('the'); d.retireSpentDraft(msgs);
check(box.value === 'the' && d.loadDraft('local_a') === 'the', 'a word that is in a reply does not empty the box', box.value);

// Send: the box and draft clear, the sent text is held apart until it shows up as his message.
type('stop the meter job');
box.value = ''; d.clearDraft('local_a'); d.markUnsent('local_a', 'stop the meter job');
type('and the');                                           // he starts the next message at once
d.retireSpentDraft(msgs);
check(box.value === 'and the', 'typing right after a send is kept', box.value);
check(d.loadUnsent('local_a') === 'stop the meter job', 'the sent text is still held until it is delivered');
d.retireSpentDraft(msgs.concat([{ role: 'user', text: 'stop the meter job' }]));
check(d.loadUnsent('local_a') === '' && box.value === 'and the', 'delivery retires the sent record, not the new draft', { unsent: d.loadUnsent('local_a'), box: box.value });

// A failed send comes back only into an empty box; it never overwrites what he typed since.
d.markUnsent('local_a', 'first');
d.restoreFailed('local_a', 'first');
check(box.value === 'and the', 'a failed send does not overwrite new typing', box.value);
box.value = ''; d.clearDraft('local_a');
d.restoreFailed('local_a', 'first');
check(box.value === 'first' && d.loadDraft('local_a') === 'first', 'a failed send returns to an empty box and the draft', box.value);

// Refresh / reconnect / turn end: the open path restores the box from the draft.
const open = app.slice(app.indexOf('    const cur = $(\'input\').value;\n    const draft = loadDraft(id);'), app.indexOf('  autosize();\n  updateCommandList();'));
check(/else \$\('input'\)\.value = draft;/.test(open), 'opening a session (refresh, reconnect) puts the saved draft back in the box');
check(!/clearDraft\(/.test(retire) && !/\$\('input'\)\.value = ''/.test(retire), 'the render-time retire never touches the box or the draft');
// send() itself: the text goes into the phone's outbox (g1588), never back into the draft
const sendFn = app.slice(app.indexOf('async function send('), app.indexOf("/* ---- The phone's outbox"));
const has = (hay, needle) => hay.includes(needle);
check(!has(sendFn, 'saveDraft(id, text)'), 'a send no longer writes the sent text into the draft');

// g1518b -> g1588: a send that fails is never removed. It stays in the outbox, shown with its reason and
// Send now / Edit / Discard, and is retried by itself (test/phone-outbox.js runs that code).
check(has(sendFn, 'obAdd(id, text, atts);') && has(sendFn, 'clearDraft(id);'), 'the message moves from the box into the outbox in one step');
check(has(app, "'waiting to send — ' + esc(it.error)") && has(app, "b('obx-now', 'Send now')") && has(app, "b('obx-edit', 'Edit')"), 'a message that could not be sent shows why, with Send now and Edit');
check(has(app, 'function obEdit(') && has(app, "it.text + '\\n\\n' + cur"), 'Edit puts it back in the box without overwriting what he typed since');
const onResult = app.slice(app.indexOf("es.addEventListener('sendresult'"), app.indexOf("es.addEventListener('alert'"));
check(has(onResult, "lost.state = 'stuck'"), 'a send the PC accepted and then failed also stays, as "not sent"');

if (fails) { console.error(fails + ' failed'); process.exit(1); }
console.log('composer-draft: all checks passed');
