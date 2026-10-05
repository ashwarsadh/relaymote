// g1252: "back-to-back messages from you ... it stops playing after playing one message". Every chat
// update rebuilds #log, so the bubble being read was replaced by a copy; "the next one after it" was
// looked up by position in the page, found nothing, and read-on stopped. The real client functions are
// run here against a log that is rebuilt while a message plays. Also: his own message gets its own cue.
const fs = require('fs'), path = require('path');
const app = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'public', 'app.js'), 'utf8');
let fails = 0;
const check = (ok, what, got) => { console.log((ok ? 'ok   ' : 'FAIL ') + what + (got !== undefined ? '  ' + JSON.stringify(got) : '')); if (!ok) fails++; };

const start = app.indexOf('const ttsBeepUrl = {};');
const end = app.indexOf('function ttsSilent()');
check(start > 0 && end > start, 'the read-on code is found');

let log = [];
function build(msgs) {   // a fresh set of elements, as log.innerHTML = html makes
  for (const m of log) m.isConnected = false;
  log = msgs.map(([role, text]) => {
    const cls = new Set(['msg', role]);
    return { text, isConnected: true, querySelector: s => (s === '.speak' ? {} : null),
      classList: { contains: c => cls.has(c), add: c => cls.add(c), remove: c => cls.delete(c) } };
  });
}
const document = { querySelectorAll: () => log };
const tts = { el: null, full: '', idx: -1, beeps: [], waiting: false, mode: 'audio' };
const W = { live: false, stopped: 0 };
const audio = { play: () => undefined };
const ttsText = el => el.text;
URL.createObjectURL = () => 'blob:x';
const f = new Function('document', 'tts', 'ttsText', 'isLive', 'ttsPosForget', 'ttsStop', 'ttsPaint', 'ttsAudio', 'ttsStart',
  app.slice(start, end) + '\nreturn { ttsSpeakable, ttsRelink, ttsNextMsg, ttsReadOn, ttsWake };');
const { ttsSpeakable, ttsNextMsg, ttsReadOn, ttsWake } = f(document, tts, ttsText, () => W.live, () => {},
  () => { W.stopped++; tts.el = null; tts.waiting = false; }, () => {}, () => audio, () => {});
const play = (el) => { tts.el = el; tts.full = ttsText(el); tts.idx = ttsSpeakable().indexOf(el); };

const convo = [['user', 'Start the report please'], ['assistant', 'Reply one: starting now.'], ['assistant', 'Reply two: half done.']];
build(convo);
play(log[1]);
// While reply one plays, reply three arrives: the whole log is rebuilt.
build(convo.concat([['assistant', 'Reply three: finished.']]));
let n = ttsNextMsg(tts.el);
check(!!n && n.text === 'Reply two: half done.', 'after the log is rebuilt mid-read, the next message is still found', n && n.text);
check(tts.el.isConnected && tts.el.text === 'Reply one: starting now.', 'the bubble being read is re-found in the new log');
play(n);
build(convo.concat([['assistant', 'Reply three: finished.'], ['user', 'thanks, now send it']]));
n = ttsNextMsg(tts.el);
check(!!n && n.text === 'Reply three: finished.', 'and again: three back-to-back replies chain without a tap', n && n.text);
play(n);
n = ttsNextMsg(tts.el);
check(!!n && n.classList.contains('user'), 'his own later message is next in line');

// A reply still being written grows between renders: matched by how it began.
build([['assistant', 'A long answer that is still being streamed in, part one']]);
play(log[0]);
build([['assistant', 'A long answer that is still being streamed in, part one and more text'], ['assistant', 'Next']]);
n = ttsNextMsg(tts.el);
check(!!n && n.text === 'Next', 'a reply that grew while it was read is still followed by the next one');

// Two identical short replies: the one at the old position is kept, not the first copy.
build([['assistant', 'Done.'], ['assistant', 'Done.'], ['assistant', 'After']]);
play(log[1]);
build([['assistant', 'Done.'], ['assistant', 'Done.'], ['assistant', 'After']]);
n = ttsNextMsg(tts.el);
check(!!n && n.text === 'After', 'identical replies resolve by position, so none is read twice', n && n.text);

// One turn's replies share ONE bubble: a reply added to the bubble being read is read next, not lost.
build([['user', 'Go'], ['assistant', 'Reply one.']]);
play(log[1]); W.live = true;
build([['user', 'Go'], ['assistant', 'Reply one.\n\nReply two, added while reply one was read.']]);
ttsReadOn();
check(!!tts.beepNext && tts.beepNext.tail === 'Reply two, added while reply one was read.', 'text added to the bubble being read is queued next (it was skipped, and read-on stopped)', tts.beepNext && tts.beepNext.tail);
check(tts.beeps[tts.beeps.length - 1] === 'reply', 'with the reply cue');

// Nothing new yet, but the session is still working: wait, then go on when the next message lands.
build([['user', 'Go'], ['assistant', 'Only reply so far.']]);
play(log[1]); tts.beepNext = null; W.stopped = 0;
ttsReadOn();
check(tts.waiting && W.stopped === 0 && !!tts.el, 'while the session is still working and nothing new has come, read-on waits instead of stopping');
build([['user', 'Go'], ['assistant', 'Only reply so far.'], ['user', 'my next message']]);
ttsWake();
check(!tts.waiting && !!tts.beepNext && tts.beepNext.el.text === 'my next message' && tts.beeps[tts.beeps.length - 1] === 'user', 'the next message arriving wakes it, with HIS cue for his own message', tts.beeps.slice(-1));
build([['user', 'Go'], ['assistant', 'Last.']]); play(log[1]); tts.beepNext = null; W.stopped = 0;
ttsReadOn(); W.live = false; ttsWake();
check(W.stopped === 1, 'when the turn ends with nothing new, it stops');

// The two cues differ.
const tones = /const TTS_TONES = (\{[^\n]*\});/.exec(app);
const T = tones && new Function('return ' + tones[1])();
check(!!T && T.reply && T.user && JSON.stringify(T.reply) !== JSON.stringify(T.user), 'a reply and his own message have different cues', T);
check(/next\.classList\.contains\('user'\) \? 'user' : 'reply'/.test(app) && /a\.src = ttsBeep\(kind\)/.test(app), 'read-on picks the cue by who wrote the next message');
check(/log\.innerHTML = html[^\n]*\n\s*if \(tts\.el\) \{ ttsRelink\(\); ttsWake\(\); \}/.test(app), 'every log rebuild re-finds the bubble being read');

if (fails) { console.error(fails + ' failed'); process.exit(1); }
console.log('tts-readon: all checks passed');
