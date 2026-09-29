// mobile-tts-audio.js — g808: read-aloud kept stopping when the screen locked (Chrome silences
// speechSynthesis for a hidden page) and after a phone call, and had no way to move position.
// The desktop now speaks to a cached WAV and the phone plays it through <audio> + Media Session.
'use strict';
const H = require('./mobile-harness');
const W = H.world('ttsaudio', { env: true });
const { check } = H;
const fs = require('fs');
const tts = require('../mobile/tts');

const app = H.src('mobile/public/app.js');
const ix = H.src('mobile/index.js');

console.log('--- server ---');
check(/p === '\/api\/tts'/.test(ix) && /tts\.synth\(body\.text\)/.test(ix), 'POST /api/tts synthesises the text');
check(/p === '\/api\/tts-audio'/.test(ix) && /sentfiles\.stream\(req, res, file, st\.size\)/.test(ix), 'GET /api/tts-audio streams the WAV with Range (needed to seek on the phone)');
const readOk = ix.slice(ix.indexOf('const READ_OK'), ix.indexOf('const WRITE_OK'));
check(!/\/api\/tts/.test(readOk), 'a scoped sub-user cannot spend desktop time on speech');
check(tts.fileOf('../../etc/passwd') === null && tts.fileOf('zz') === null && /\.wav$/.test(tts.fileOf('a'.repeat(40))), 'the audio key is 40 hex chars only: no path can be smuggled in');

(async () => {
  const bad = await tts.synth('   ');
  check(bad.ok === false && bad.error === 'NO_TEXT', 'empty text is refused, not synthesised');
  if (process.platform === 'win32' || process.platform === 'darwin') {
    const r = await tts.synth('Read aloud test. One two three.');
    check(r.ok && r.bytes > 20000, 'the desktop turns text into speech', r);
    const f = tts.fileOf(r.key);
    const head = fs.readFileSync(f).subarray(0, 12).toString('latin1');
    check(/^RIFF....WAVE$/s.test(head) || head.startsWith('RIFF'), 'and it is a WAV the phone can play');
    const again = await tts.synth('Read aloud test. One two three.');
    check(again.ok && again.cached === true && again.key === r.key, 'the same text is served from the cache, no second synth');
  } else console.log('skip: no speech engine assumed on this platform');

  console.log('--- phone ---');
  check(/new Audio\(\)/.test(app) && /a\.src = '\/api\/tts-audio\?k='/.test(app), 'the phone plays the desktop audio through an <audio> element');
  check(/navigator\.mediaSession\.setActionHandler/.test(app) && /'seekto'/.test(app) && /'play'/.test(app) && /'pause'/.test(app), 'Media Session play, pause and seek: lock-screen and Bluetooth controls');
  check(/type="range"/.test(app) && /data-tts="play"/.test(app) && /data-tts="stop"/.test(app) && /data-tts="back"/.test(app) && /data-tts="fwd"/.test(app), 'visible seek bar, Play/Pause, Stop and 15 s back/forward');
  check(/baton\.ttsPos/.test(app) && /ttsPosSave\(tts\.hash/.test(app) && /Resuming from/.test(app), 'the position is saved per message and used to resume after a reload');
  check(/addEventListener\('pause'/.test(app) && /ttsInterrupted\(\)/.test(app) && /tts\.userPaused/.test(app), 'a pause he did not ask for (a call) is recognised as an interruption');
  check(/setInterval\(ttsTryResume, 4000\)/.test(app) && /function ttsHold\(\)/.test(app) && /clearInterval\(tts\.retry\)/.test(app), 'it retries to resume, and the timer exists only while interrupted');
  check(/'visibilitychange', 'focus', 'pageshow'/.test(app), 'it also resumes the moment the page comes back');
  check(/speechSynthesis\.speak\(u\)/.test(app) && /tts\.mode = 'synth'/.test(app), 'the phone voice is only the fallback when the desktop has no speech engine');

  // The state machine, run for real against fakes.
  const vm = require('vm');
  const start = app.indexOf('const tts = {'), end = app.indexOf('/* Find in this session (g784');
  const src = app.slice(start, end);
  const log = [];
  const audio = { paused: true, ended: false, duration: 100, currentTime: 0, playbackRate: 1, _l: {},
    addEventListener(n, f) { (this._l[n] = this._l[n] || []).push(f); }, removeEventListener() {}, setAttribute() {},
    play() { this.paused = false; log.push('play'); (this._l.play || []).forEach(f => f()); return Promise.resolve(); },
    pause() { if (this.paused) return; this.paused = true; log.push('pause'); (this._l.pause || []).forEach(f => f()); },
    removeAttribute() {}, load() {} };
  const store = {};
  const timers = [];
  const el = { classList: { add() {}, remove() {} }, isConnected: true, offsetHeight: 100, getBoundingClientRect: () => ({ top: 0 }),
    cloneNode() { return { querySelectorAll: () => [{ remove() {}, replaceWith() {} }], innerText: 'Hello there. This is a long enough message.' }; } };
  const bar = { querySelector: () => ({ textContent: '', value: '', title: '', addEventListener() {} }), classList: { toggle() {}, add() {}, remove() {} }, addEventListener() {}, innerHTML: '' };
  const ctx = {
    console, Date, Math, Number, String, JSON, Object, Promise, isFinite, URL: { createObjectURL: () => 'blob:x' }, Blob: function () {},
    ArrayBuffer, DataView, setTimeout: (f) => { timers.push(f); return timers.length; }, clearInterval() {}, clearTimeout() {},
    setInterval: (f, ms) => { log.push('interval ' + ms); return 7; },
    localStorage: { getItem: k => store[k] || null, setItem: (k, v) => { store[k] = v; } },
    document: { getElementById: () => bar, createElement: () => bar, body: { appendChild() {} }, querySelectorAll: () => [], hidden: false },
    window: { addEventListener() {} }, Audio: function () { return audio; }, navigator: {}, MediaMetadata: function () {},
    $: () => ({ scrollTop: 0, clientHeight: 500, getBoundingClientRect: () => ({ top: 0 }), scrollTo() {} }), state: { meta: { title: 't' } },
    toast: (m) => log.push('toast ' + m),
    api: async () => ({ ok: true, key: 'k'.repeat(40) }),
    speechSynthesis: undefined, SpeechSynthesisUtterance: undefined, TTS_OK: false,
  };
  ctx.navigator.mediaSession = { setActionHandler(n, f) { ctx._h = ctx._h || {}; ctx._h[n] = f; }, setPositionState() {} };
  vm.createContext(ctx);
  vm.runInContext(src + '\nthis.T = { tts, ttsStart, ttsStop, ttsToggle, ttsHash, ttsPosLoad, ttsPosSave };', ctx);
  const T = ctx.T;

  T.ttsPosSave(T.ttsHash('Hello there. This is a long enough message.'), 42);
  const started = T.ttsStart(el);
  await new Promise(r => setImmediate(r));
  (audio._l.loadedmetadata || []).forEach(f => f());
  await started;
  check(log.includes('play') && audio.src === '/api/tts-audio?k=' + 'k'.repeat(40), 'starting a read plays the desktop audio');
  check(audio.currentTime === 42, 'it resumed from the saved position, not from the start', audio.currentTime);
  log.length = 0;
  audio.pause();                                   // what a phone call does: the page did not ask for it
  check(log.includes('interval 4000') && T.tts.userPaused === false, 'a call pauses the audio -> it is treated as an interruption and a resume retry begins');
  audio.play();                                    // the call ended and the audio came back
  check(T.tts.retry === null, 'once it plays again the retry timer is cleared');
  log.length = 0;
  ctx._h.pause();                                  // lock-screen Pause is his own request
  check(T.tts.userPaused === true && !log.some(l => l.startsWith('interval')), 'his own pause is never auto-resumed');
  ctx._h.play();
  check(audio.paused === false && T.tts.userPaused === false, 'lock-screen Play resumes');
  ctx._h.seekto({ seekTime: 10 });
  check(audio.currentTime === 10, 'the lock-screen seek bar moves the position');
  T.ttsStop();
  check(T.tts.el === null && audio.paused, 'Stop ends it');
  H.finish(W);
})();
