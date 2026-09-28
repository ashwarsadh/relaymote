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

console.log('--- the suggestion is offered only when the session is idle (29-Sep) ---');
check(/if \(state\.question \|\| state\._suggLive\) \{ el\.classList\.add\('hidden'\)/.test(app) && /state\._suggLive = isLive\(\);/.test(app),
  'while the session works, the suggested-reply strip is hidden');
check(/isLive\(\) !== state\._suggLive\) renderSuggestion\(state\.meta\)/.test(app) && /renderLog\(state\.messages \|\| \[\], true\); renderSuggestion\(state\.meta\); \}/.test(app),
  'it comes back when the turn ends (and hides when one starts)');

console.log('--- g780: sending, and a growing reply, never move him (29-Sep 00:55 / 01:05) ---');
{
  const sendLine = app.split('\n').find(l => /if \(state\.open === id\) \{ \$\('input'\)\.value = ''/.test(l)) || '';
  check(sendLine && !/scrollToBottomNext = true/.test(sendLine), 'sending does not force the view to the bottom (at the bottom it follows anyway)', sendLine.trim());
  const vm = require('vm');
  const grab = (name) => { const i = app.indexOf('function ' + name + '('); const rest = app.slice(i); return rest.slice(0, rest.search(/\n\}\n/) + 2); };
  const ctx = { CLAMP_AT: 20, speakBtn: () => '' };
  vm.createContext(ctx);
  vm.runInContext(grab('hash') + grab('clampable') + ';globalThis.C = clampable;', ctx);
  const ck = (h) => (/data-ck="([^"]+)"/.exec(h) || [])[1];
  const t1 = 'a long reply that is still being written', t2 = t1 + '\n\nand then it grew a second paragraph';
  const a = ck(ctx.C(t1, t1, 'msg assistant', '2026-09-29T00:50:00Z')), b = ck(ctx.C(t2, t2, 'msg assistant', '2026-09-29T00:50:00Z'));
  check(a && a === b, 'a reply that grows keeps its clamp key, so an expanded reply stays expanded', [a, b]);
  check(ck(ctx.C(t1, t1, 'msg user', '2026-09-29T00:50:00Z')) !== a, 'his bubble and the reply at the same second do not share a key');
  check(ck(ctx.C(t1, t1, 'msg assistant', '2026-09-29T00:51:00Z')) !== a, 'two replies are two keys');
  check(/clampable\(md\(m\.text\), m\.text, 'msg assistant', m\.ts\)/.test(app), 'the assistant bubble passes its identity');
}
{
  // Measured on his phone: a sent video above him re-entered at no size on every render, so the page
  // jumped by its height and back every 2.5 s. Once loaded, its size is reserved on every re-render.
  const vm = require('vm');
  const grab = (name) => { const i = app.indexOf('function ' + name + '('); const rest = app.slice(i); return rest.slice(0, rest.search(/\n\}\n/) + 2); };
  const ctx = { state: { open: 's1' }, htmlCache: new Map([['x', 1]]), esc: (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;') };
  vm.createContext(ctx);
  vm.runInContext('const mediaDims = new Map();' + grab('learnMedia') + grab('sentFileHtml') + ';globalThis.L = learnMedia; globalThis.S = sentFileHtml;', ctx);
  const t = { files: ['C:/x/clip.mp4', 'C:/x/shot.png'] };
  const before = ctx.S(t);
  check(!/aspect-ratio/.test(before) && !/width="/.test(before), 'control: before any load, no size is invented');
  const url = (n) => '/api/sent-file?session=s1&path=' + encodeURIComponent('C:/x/' + n);
  ctx.L({ target: { getAttribute: () => url('clip.mp4'), videoWidth: 1280, videoHeight: 720 } });
  ctx.L({ target: { getAttribute: () => url('shot.png'), naturalWidth: 800, naturalHeight: 1600 } });
  const after = ctx.S(t);
  check(/<video[^>]*style="aspect-ratio:1280 \/ 720"/.test(after), 'after its metadata loads, the video is re-rendered with its shape reserved', after.slice(0, 160));
  check(/<img[^>]*width="800" height="1600"/.test(after), 'and an image with its size');
  check(ctx.htmlCache.size === 0, 'cached bubbles built without the size are dropped');
  check(/addEventListener\('loadedmetadata', learnMedia, true\)/.test(app) && /addEventListener\('load', learnMedia, true\)/.test(app), 'the log learns sizes from load events (capture: they do not bubble)');
}

console.log('--- a model label is text only (29-Sep: a box beside "Sonnet 5.5") ---');
{
  const d = require('../lib/desktop');
  const picked = 'Sonnet 5.5\uE08F';                 // what the picker row actually read
  check(d.cleanLabel(picked) === 'Sonnet 5.5', 'the badge glyph is dropped from the label', JSON.stringify(d.cleanLabel(picked)));
  check(d.sameModel('Sonnet 5.5', picked) && d.sameModel('claude-sonnet-5-5', picked), 'and the row still matches by name and by id (a switch can find it)');
  check(!d.sameModel('Sonnet 5', picked), 'control: Sonnet 5 is not Sonnet 5.5');
  check(d.cleanLabel('Opus\u200b 5.5') === 'Opus 5.5', 'zero-width marks go too');
  check(/models\.map\(m => \(\{ \.\.\.m, name: cleanLabel\(m\.name\) \}\)\)/.test(H.src('lib/desktop.js')), 'the picker list is cleaned where it is read');
  check(/j\.models\.map\(desktop\.cleanLabel\)/.test(H.src('mobile/index.js')), 'a list cached before the fix is cleaned on load');
  check(/p\{Co\}/.test(app.slice(app.indexOf('const shortModel'), app.indexOf('const shortModel') + 300)), 'the phone strips them from any label it shows');
  // 29-Sep: labels must stay clean for models that ship later, with no code change.
  const cp = (x) => String.fromCodePoint(x);
  check(d.cleanLabel('Opus 6 ' + cp(0xF8A1)) === 'Opus 6', 'a fake future label "Opus 6 <private-use glyph>" reads as "Opus 6"', d.cleanLabel('Opus 6 ' + cp(0xF8A1)));
  check(d.cleanLabel('Fable ' + cp(0xF0001) + '6.1 ' + cp(0x1F195)) === 'Fable 6.1', 'supplementary private use and emoji badges go too');
  check(d.cleanLabel('Sonnet^5`') === 'Sonnet^5`', 'control: ASCII ^ and ` survive');
  const live = [{ id: 'claude-opus-5-5', label: 'Opus 5.5' }, { id: 'claude-sonnet-5', label: 'Sonnet 5' },
                { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' + cp(0xE08F) }, { id: 'claude-opus-6', label: 'Opus 6 ' + cp(0xF8A1) }];
  check(d.chooseModel(live, 'sonnet').id === 'claude-sonnet-5-5', '"sonnet" is the newest Sonnet in the LIVE list');
  check(d.chooseModel(live, 'opus').id === 'claude-opus-6' && d.chooseModel(live, 'Opus 6').id === 'claude-opus-6', 'a model that ships later is found with no code change');
  check(d.chooseModel(live, 'claude-sonnet-5').id === 'claude-sonnet-5', 'control: an exact older version is still exactly that');
  {
    const sui = H.src('mobile/public/settings-ui.js');
    const def = sui.slice(sui.indexOf('var asLabel = function'), sui.indexOf('};', sui.indexOf('var asLabel = function')) + 2);
    const c = { modelList: ['Opus 5.5', 'Sonnet 5.5', 'Haiku 4.5'] }; require('vm').createContext(c); require('vm').runInContext(def + ';globalThis.A = asLabel;', c);
    check(c.A('claude-sonnet-5-5') === 'Sonnet 5.5' && c.A('claude-haiku-4-5-20251001') === 'Haiku 4.5' && c.A('Opus 5.5') === 'Opus 5.5',
          'Settings shows a stored model id as the picker label (no duplicate raw option)', [c.A('claude-sonnet-5-5'), c.A('claude-haiku-4-5-20251001')]);
    check(c.A('claude-opus-9') === 'claude-opus-9', 'control: an id the picker does not offer stays visible as itself');
    check((sui.match(/asLabel\((cur|n)\.model\)/g) || []).length === 2, 'both the new-session default and every difficulty level use it');
  }
  check(/chooseModel\(live\.models\.map/.test(H.src('lib/desktop.js')), 'setModel resolves a bare family against the live list');
  check(/return modelsVal \|\| \[\];/.test(H.src('mobile/index.js')), 'no hardcoded model names: the list is only what the picker offers');
  {
    const vm = require('vm');
    const line = app.slice(app.indexOf('const shortModel'), app.indexOf('\n', app.indexOf("replace(/-latest$/")) + 1);
    const c = {}; vm.createContext(c); vm.runInContext(line + ';globalThis.S = shortModel;', c);
    check(c.S('Opus 6 ' + cp(0xF8A1)) === 'Opus 6' && c.S('claude-sonnet-5-5') === 'sonnet-5-5', 'the phone shows the same clean name', c.S('Opus 6 ' + cp(0xF8A1)));
  }
}

H.finish(W);
