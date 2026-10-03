// g1085: a delivered message with a pasted "@mention" line was never confirmed, so after 15 min it
// came back at the bottom as "delivered, waiting for a reply" with Send again, and that button's
// already-landed check said no. Only LEADING "@<path>" lines are attachments; any other "@" line is text.
const fs = require('fs'), os = require('os'), path = require('path');
process.env.RELAYMOTE_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-ob-'));
const ob = require('../mobile/outbox.js');
let fails = 0;
const check = (ok, what, got) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) { fails++; if (got !== undefined) console.log('     ', JSON.stringify(got)); } };
const NL = String.fromCharCode(10), BS = String.fromCharCode(92);

const text = ['** PAYMENT FAILURE **', '@\u2068Sam Lee\u2069 card ..1234: autopay failed. Due 04-Oct, Rs 1,000.', '', 'Do not show my balance in such messages.'].join(NL);
const row = JSON.stringify({ type: 'user', timestamp: '2026-10-03T04:06:35Z', message: { role: 'user', content: text } });
const later = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Noted.' }] } });
const tail = [row, later].join(NL);
const hay = ob.norm(ob.unescapeTranscript(ob.withoutQueueOps(tail)));

check(hay.includes(ob.needleFor(text)), 'a message with an @mention line is found once delivered', ob.needleFor(text));
check(ob.needleFor('@C:' + BS + 'up' + BS + 'a.jpg' + NL + 'please look') === 'please look', 'a leading attachment path is still skipped');
check(ob.needleFor('@/tmp/x.png' + NL + '@C:' + BS + 'b.jpg' + NL + 'hi there') === 'hi there', 'several leading attachment lines are skipped');
check(ob.needleFor('@Sam can you check') === '@Sam can you check', 'a message that starts with a mention keeps it');

// End to end through reconcile: the entry confirms instead of going suspect 26 min later.
ob.add({ id: 'ob_t1', session: 's1', text, delivery: 'generating' });
const r = ob.reconcile(() => tail, Date.now() + 26 * 60e3, () => false);   // 26 min later, as on his screen
check(r.confirmed.some(x => x.id === 'ob_t1') && !r.suspect.length, 'reconcile confirms it, nothing goes "waiting for a reply"', { c: r.confirmed.map(x => x.id), s: r.suspect.map(x => x.id) });

// No automatic re-send: every call that re-sends an outbox entry sits inside a click handler.
const app = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'public', 'app.js'), 'utf8');
const resends = [...app.matchAll(/send\(\{ id: e\.session, text: e\.text \}\)/g)].map(m => app.slice(Math.max(0, m.index - 900), m.index));
check(resends.length === 2 && resends.every(s => /\.onclick = /.test(s) && /alreadyLanded\(/.test(s)), 'Send again re-sends only from a tap, after an already-landed check', resends.length);
const idx = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'index.js'), 'utf8');
const tick = idx.slice(idx.indexOf('async function outboxTickInner'), idx.indexOf('\n}\n', idx.indexOf('async function outboxTickInner')));
check(!/doSend|sendQueued|sendMessage/.test(tick), 'the server outbox tick never sends; a suspect entry only raises an alert');
check(/spoken\(t\)/.test(app), 'the client hides an outbox entry by the same needle rule');

fs.rmSync(process.env.RELAYMOTE_STATE_DIR, { recursive: true, force: true });
if (fails) { console.error(fails + ' failed'); process.exit(1); }
console.log('outbox-mention: all checks passed');
