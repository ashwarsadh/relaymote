// mobile-burst-tts-held.js — three phone-app behaviours asked for on 28-Sep:
//  g770  a burst of "Finished" alerts is ONE notification (same tag, later ones renotify:false);
//  g757  a read-aloud button on each message, using only the device's speechSynthesis;
//  g775  "Open session" from the board HOLDS the queued replies; a card offers Send all.
'use strict';
const H = require('./mobile-harness');
const W = H.world('burst', { demo: false });
const { check } = H;
const alerts = require('../mobile/alerts');

console.log('--- g770: a burst of finishes is one notification ---');
alerts._resetBurst();
const T = Date.parse('2026-09-28T12:00:00Z');
const ev = (title) => ({ id: title, kind: 'done', title, body: 'Finished', tag: 'sess-' + title, url: '/?s=' + title });
const a = alerts.coalesceDone(ev('alpha'), T);
const b = alerts.coalesceDone(ev('beta'), T + 20e3);
const c = alerts.coalesceDone(ev('gamma'), T + 50e3);
check(a.renotify === true && a.title === 'alpha' && a.url === '/?s=alpha', 'the first finish is an ordinary alert, sent at once', a);
check(b.tag === a.tag && c.tag === a.tag, 'finishes within a minute share one tag, so the phone keeps ONE notification');
check(b.renotify === false && c.renotify === false, 'later finishes replace it silently (no second buzz)');
check(c.title === '3 sessions finished' && /alpha · beta · gamma/.test(c.body) && c.url === '/', 'the replacement names all of them', c);
const d = alerts.coalesceDone(ev('delta'), T + 50e3 + 61e3);
check(d.tag !== a.tag && d.renotify === true && d.title === 'delta', 'after a quiet minute a new burst starts (new tag: never replaces an unread older one)');
const w = alerts.coalesceDone({ id: 'x', kind: 'awaiting', title: 'x', tag: 'sess-x' }, T + 111e3 + 1e3);
check(w.tag === 'sess-x' && w.renotify === undefined, '"Needs your input" is never coalesced');
const many = []; alerts._resetBurst();
for (let i = 0; i < 6; i++) many.push(alerts.coalesceDone(ev('s' + i), T + i * 1e3));
check(/^… s2 · s3 · s4 · s5$/.test(many[5].body) && many[5].title === '6 sessions finished', 'a long burst shows the latest four and says there were more', many[5].body);
check(/renotify: d\.renotify !== false/.test(H.src('mobile/public/sw.js')), 'the service worker honours renotify:false');
check(/alerts\.deliver\(pushEvt, log\)/.test(H.src('mobile/index.js')) && /sseSend\(c, 'alert', evt\)/.test(H.src('mobile/index.js')),
  'the phone push goes through the coalescer; the in-app alert keeps its own session link');

console.log('--- g757: read aloud ---');
const app = H.src('mobile/public/app.js');
check(/speechSynthesis\.speak\(u\)/.test(app) && !/https?:\/\/[^'"\s]*(tts|speech)/i.test(app), 'speech comes from the device speechSynthesis; nothing is fetched');
check(/function speakBtn/.test(app) && /\$\{speakBtn\(cls\)\}/.test(app), 'every assistant/user bubble gets the button (via clampable)');
check(/data-tts="slower"/.test(app) && /data-tts="faster"/.test(app) && /data-tts="stop"/.test(app), 'the bar has slower, faster and stop');
check(/function ttsFollow/.test(app) && /userScrollAt/.test(app), 'the message scrolls with the voice, and a manual scroll pauses the follow');
check(/TTS_OK && \//.test(app), 'no button where the browser has no speech engine');

console.log('--- g775: Open session holds the board queue ---');
const board = H.src('mobile/public/board-ui.js');
const openBlock = board.slice(board.indexOf("const open = e.target.closest('[data-open]')"), board.indexOf("hideSheet($('view-board'));", board.indexOf("const open = e.target.closest('[data-open]')")) + 30);
check(/setHeld\(true\)/.test(openBlock) && openBlock.indexOf('setHeld(true)') < openBlock.indexOf('hideSheet'), 'Open session sets the hold BEFORE the board hides (the close observer sees it)');
check(/flush\('board-closed'\)/.test(board) && /B\.queue\.length && !isHeld\(\)\) flush\('board-closed'\)/.test(board), 'closing while held sends nothing; closing otherwise sends as before');
check(/!isHeld\(\)\) flush\('reopen'\)/.test(board) && /!isHeld\(\)\) flush\('resume'\)/.test(board), 'a reload or return to the app while held does not send either');
check(/setHeld\(false\);\s*\n\s*showSheet\(\$\('view-board'\)\)/.test(board), 'opening the board again releases the hold');
check(/\$\('board-held-send'\)\.onclick = \(\) => flush\('send-all-held'\)/.test(board) && /id="board-held-send"/.test(H.src('mobile/public/index.html')), 'the card has Send all, wired to the same flush');

H.finish(W);
