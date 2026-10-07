// g1409: "once a part is playing, it scrolls down to the end of the entire message, and when that part
// is done and the next part has to start ... it remains at the bottom instead of the correct position".
// A long reply is read in parts, and the screen followed progress through the PART as if it were the
// whole message. The real functions are run over a long multi-part message: where the screen aims must
// only move forward, and each part may move it only across its own share of the text.
const fs = require('fs'), path = require('path');
const app = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'public', 'app.js'), 'utf8');
let fails = 0;
const check = (ok, what, got) => { console.log((ok ? 'ok   ' : 'FAIL ') + what + (got !== undefined ? '  ' + JSON.stringify(got) : '')); if (!ok) fails++; };

const grab = (name) => { const s = app.indexOf('function ' + name + '('); let d = 0, i = app.indexOf('{', s);
  for (; i < app.length; i++) { if (app[i] === '{') d++; else if (app[i] === '}' && --d === 0) break; } return app.slice(s, i + 1); };
const tts = { mode: 'audio', parts: null, pi: 0, full: '', audio: { duration: 0, currentTime: 0 } };
const f = new Function('tts', [grab('ttsSplit'), grab('ttsFrac'), grab('ttsMsgFrac')].join('\n') + '\nreturn { ttsSplit, ttsMsgFrac };');
const { ttsSplit, ttsMsgFrac } = f(tts);

const sentence = (i) => `Sentence number ${i} explains one more step of the long reply in plain words. `;
const full = Array.from({ length: 60 }, (_, i) => sentence(i)).join('').trim();
tts.full = full; tts.parts = ttsSplit(full);
check(tts.parts.length >= 4, 'the long reply is read in several parts', tts.parts.length);

const trace = [];
tts.parts.forEach((p, k) => {
  tts.pi = k; tts.audio.duration = 30;
  for (const s of [0, 10, 20, 30]) { tts.audio.currentTime = s; trace.push({ k, s, at: ttsMsgFrac() }); }
});
const ats = trace.map(x => x.at);
check(ats.every((v, i) => i === 0 || v >= ats[i - 1] - 1e-9), 'the screen only moves forward through the message, never back to the top of it');
const firstEnd = trace.find(x => x.k === 0 && x.s === 30).at;
check(firstEnd < 0.2, 'the end of part 1 is near the TOP of the message, not its end (it ran to the bottom)', +firstEnd.toFixed(3));
for (let k = 1; k < tts.parts.length; k++) {
  const endPrev = trace.find(x => x.k === k - 1 && x.s === 30).at, startNext = trace.find(x => x.k === k && x.s === 0).at;
  if (Math.abs(endPrev - startNext) > 0.01) { check(false, `part ${k + 1} starts where part ${k} ended`, [endPrev, startNext]); break; }
  if (k === tts.parts.length - 1) check(true, 'each part starts where the one before it ended (no jump, no sticking at the bottom)');
}
check(Math.abs(ats[ats.length - 1] - 1) < 1e-9, 'the last part ends at the end of the message');

// A tail read (text added to the bubble after it began) sits at the END of the bubble.
tts.full = full + ' ' + 'Added later. '.repeat(10).trim();
tts.parts = ttsSplit('Added later. '.repeat(10).trim()); tts.pi = 0; tts.audio.currentTime = 0;
check(ttsMsgFrac() > 0.9, 'a reply added to the bubble is followed at the bottom of the bubble', +ttsMsgFrac().toFixed(3));

check(/ttsMsgFrac\(\) \* el\.offsetHeight/.test(app), 'the screen follows the whole-message position');

if (fails) { console.error(fails + ' failed'); process.exit(1); }
console.log('tts-scroll: all checks passed');
