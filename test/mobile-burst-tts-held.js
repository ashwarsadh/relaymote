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

console.log('--- a web app left open is told a new version is ready ---');
check(/function updateBanner\(server\)/.test(app) && /updateBanner\(server\);/.test(app), 'a stale build raises the top banner, not only the drawer line');
check(/if \(d\.version\) state\.boot\.version = d\.version;/.test(app) && /version: APP_VERSION,/.test(H.src('mobile/index.js')), 'the banner names the version the desktop now runs');
check(/upd-go[\s\S]{0,80}location\.reload\(\)/.test(app), 'Reload loads the new build');
check(/\/\* build \$\{v\} \*\//.test(H.src('mobile/index.js')), 'sw.js is stamped with the build, so every release also triggers the service-worker reload');

console.log('--- g780: the view holds still; the count is of readable replies ---');
check(!/seenMsgIds\.has\(id\) && !id\.startsWith\('user:'\)\) logNew\+\+/.test(app), 'the old per-row count (every tool step counted) is gone');
check(/m\.role !== 'assistant' \|\| !\(m\.text \|\| m\.ask\)/.test(app) && /!stick && seenReplyTs && t > seenReplyTs\) logNew\+\+/.test(app),
  'only assistant text newer than the last seen counts (steps, Working rows and older history never do)');
check(/new ResizeObserver\(holdView\)/.test(app) && /logRO\.observe\(log\);\s*for \(const el of log\.children\) logRO\.observe\(el\);/.test(app),
  'every layout change after a render is answered: the log box and each row are observed');
check(/else if \(logAtBottom\) \{\s*if \(log\.scrollHeight - log\.clientHeight - log\.scrollTop > 1\) setScrollTop\(log, log\.scrollHeight\);/.test(app),
  'at the bottom, late growth keeps him at the bottom (it used to leave the newest text below the edge)');
check(/restoreAnchor\(log, heldAnchor, true\)/.test(app) && /screen: r\.top/.test(app), 'higher up, what he is reading keeps its place ON SCREEN, even when a bar appears above the log');
check(/if \(typeof observeLog === 'function'\) observeLog\(\);/.test(app), 'each render re-observes the new rows');
check(/Date\.now\(\) - lastDoneBuzz < 60000/.test(app), 'in the open app, a burst of "Finished" banners buzzes once a minute at most');

console.log('--- a queued placeholder never outlives its delivery (29-Sep screenshot) ---');
{
  const vm = require('vm');
  const grab = (name) => { const i = app.indexOf('function ' + name + '('); const rest = app.slice(i); return rest.slice(0, rest.search(/\n\}\n/) + 2); };
  const ctx = { state: {}, scrollToBottomNext: false, logAtBottom: false };
  vm.createContext(ctx);
  vm.runInContext(grab('reconcileQueued') + grab('applyTail') + ';globalThis.R = reconcileQueued; globalThis.A = applyTail;', ctx);
  const text = 'I think you are confused. The cache is 60 minutes long';
  // What the phone held: the placeholder caught in the 15 ms before delivery, then later rows.
  const held = [{ role: 'assistant', ts: '18:00', text: 'a' }, { role: 'user', ts: '18:05:22.433', text, queued: true },
                { role: 'user', ts: '18:05:22.448', text }, { role: 'assistant', ts: '18:06', text: 'b' }, { role: 'assistant', ts: '18:07', text: 'c' }];
  check(ctx.R(held).filter(m => m.text === text).length === 1 && !ctx.R(held).some(m => m.queued), 'a placeholder whose text has arrived is dropped');
  ctx.state.messages = [{ role: 'assistant', ts: '17:59', text: 'z' }, { role: 'user', ts: '18:05:22.433', text, queued: true },
                        { role: 'assistant', ts: '18:06', text: 'b' }, { role: 'assistant', ts: '18:07', text: 'c' }];
  const merged = ctx.A([{ role: 'assistant', ts: '18:06', text: 'b' }, { role: 'assistant', ts: '18:07', text: 'c' }, { role: 'assistant', ts: '18:08', text: 'd' }]);
  check(!merged.some(m => m.queued) && merged.length === 4, 'scrolled up, a later window no longer carries a stale placeholder in the kept prefix', merged.map(m => m.ts));
  const stillQueued = ctx.R([{ role: 'assistant', ts: '18:00', text: 'a' }, { role: 'user', ts: '18:01', text: 'not yet delivered', queued: true }]);
  check(stillQueued.some(m => m.queued), 'a message that is genuinely still queued keeps its placeholder');
  check(/messages = reconcileQueued\(messages\);/.test(app), 'every render reconciles');
}

H.finish(W);
