// send-unqueued.js — 03-Nov: 12 phone sends in two days took 6-10 min (Ashwar 30-Oct: "shud be isntant"). Each sat in
// the UI queue behind a step stuck for 300 s, though the app's own channel (sendMessageBackground) clicks nothing.
// Here the UI queue never moves: a send must still go through the app's own channel within seconds, and only fall
// back to the queue when that channel refuses it.
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
process.env.CLAUDE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-unq-'));
process.env.RELAYMOTE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-unq-home-'));
process.env.RELAYMOTE_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-unq-state-'));
process.env.RELAYMOTE_BG_SEND_MS = '1500';
let fails = 0;
const check = (ok, what, got) => { console.log((ok ? 'ok   ' : 'FAIL ') + what + (got !== undefined ? '  ' + JSON.stringify(got) : '')); if (!ok) fails++; };

const desktop = require('../lib/desktop.js');
const calls = [];
let bgReply = async () => ({ ok: true, result: 'sent', transport: 'background', delivery: 'generating' });
desktop.serializeUi = () => new Promise(() => {});                       // a stuck UI step holds the queue for ever
desktop.readAppliedModel = async () => ({ ok: true, running: false });
desktop.sendMessageBackground = async (id, text) => { calls.push(['bg', id, text]); return bgReply(); };

desktop.sendMessage = async (...a) => { calls.push(['queued', a[0]]); return { ok: true, transport: "composer" }; };

const { doSend } = require('../mobile/index.js');
const within = (p, ms) => Promise.race([p, new Promise(r => setTimeout(() => r('TIMED_OUT'), ms))]);

(async () => {
  let t0 = Date.now();
  let out = await within(doSend('local_unq1', 'hello from the phone', []), 5000);
  check(out !== 'TIMED_OUT' && out.ok && out.transport === 'background', 'stuck UI queue: the send goes through the app\'s own channel', out);
  check(Date.now() - t0 < 3000, 'and it takes seconds, not the queue\'s 300 s', Date.now() - t0);
  check(calls.length === 1 && calls[0][0] === 'bg', 'nothing waited in the UI queue', calls);

  calls.length = 0;
  bgReply = async () => ({ ok: false, result: 'no-bridge' });
  out = await within(doSend('local_unq2', 'second message', []), 2500);
  check(out === 'TIMED_OUT' && calls.some(c => c[0] === 'bg'), 'a refused background send falls back to the queue (here held, as the queue is stuck)', { out, calls });

  calls.length = 0;
  bgReply = () => new Promise(() => {});                                 // the channel itself hangs: cut at BG_SEND_MS
  t0 = Date.now();
  out = await within(doSend('local_unq3', 'third message', []), 4000);
  check(out === 'TIMED_OUT' && calls.length === 1, 'a hung background send is cut after RELAYMOTE_BG_SEND_MS and handed to the queue', { out, calls });

  console.log(fails ? `\n${fails} FAILED` : '\nall ok');
  process.exit(fails ? 1 : 0);
})();
