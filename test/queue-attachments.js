// A queued message with attachments gets the same Send now and × as a plain one; a long wait shows
// how long; and the running flag comes from Desktop's session API, not only a sidebar label.
const fs = require('fs'), path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
let fails = 0;
const check = (ok, what, got) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) { fails++; if (got !== undefined) console.log('     ', got); } };

const index = read('mobile', 'index.js');
const send = index.slice(index.indexOf('async function doSend'), index.indexOf('const startedAt = Date.now();', index.indexOf('async function doSend')));
check(send.includes('desktop.sendQueued(id, body)'), 'doSend still tries the bridge while the session runs');
check(!/if\s*\(\s*!\s*\(\s*Array\.isArray\(attachments\)/.test(send), 'attachments do not skip the bridge (so they get a handle)', send.slice(0, 400));

const app = read('mobile', 'public', 'app.js');
check(!/ATT_QUEUED_NOTE|no Send now or ×/.test(app), 'no "no Send now or × for a message with an attachment" note');
const src = app.slice(app.indexOf('function waitedNote'), app.indexOf('\n}\n', app.indexOf('function waitedNote')) + 2);
const waitedNote = new Function(src + '\nreturn waitedNote;')();
check(waitedNote(90e3) === '', 'under 2 minutes says nothing', waitedNote(90e3));
check(/waiting 2m/.test(waitedNote(125e3)), 'past 2 minutes shows the wait', waitedNote(125e3));
check(/waiting 3h 05m/.test(waitedNote((3 * 60 + 5) * 60e3)), 'hours read as h mm', waitedNote((3 * 60 + 5) * 60e3));
check((app.match(/waitedNote\(/g) || []).length >= 5, 'every queued line carries it (outbox, held, pending, transcript)');

const server = read('server.js');
check(/desktop\.readRunningAll\(/.test(server) && /s\.running = truth\[s\.id\]/.test(server), 'refresh takes running from Desktop\'s session API');
check(typeof require('../lib/desktop.js').readRunningAll === 'function', 'desktop exports readRunningAll');

// A held message's text is in the transcript at once as a queue "enqueue" row. That is not delivery:
// confirming on it dropped the message from the outbox and with it Send now and ×.
const ob = require('../mobile/outbox.js');
const tail = [
  JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: '@C:\\up\\a.jpg\nplease look at this' }),
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } }),
].join('\n');
const needle = ob.needleFor('@C:\\up\\a.jpg\nplease look at this');
check(!ob.norm(ob.unescapeTranscript(ob.withoutQueueOps(tail))).includes(needle), 'an enqueue row alone does not confirm delivery');
const delivered = tail + '\n' + JSON.stringify({ type: 'user', message: { content: '@C:\\up\\a.jpg\nplease look at this' } });
check(ob.norm(ob.unescapeTranscript(ob.withoutQueueOps(delivered))).includes(needle), 'the delivered user row still confirms it');
check(/withoutQueueOps\(readText\(/.test(read('mobile', 'outbox.js')), 'reconcile reads the transcript without queue rows');
check(/const held = \(state\.outbox/.test(app), 'a held message is drawn once, from the outbox, with its controls');

if (fails) { console.error(fails + ' failed'); process.exit(1); }
console.log('queue-attachments: all checks passed');
