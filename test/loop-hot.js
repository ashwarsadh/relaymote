// loop-hot.js — 07-Nov: the event loop stalled 7-17 s every 10 minutes (loop-watch named config.get's stat and digests.read).
// The Board build's inbox pass parsed a digest per open card and stat'ed settings per heading: 125,000 stats on live data.
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-hot-'));
process.env.RELAYMOTE_HOME = path.join(dir, 'home');
fs.mkdirSync(process.env.RELAYMOTE_HOME, { recursive: true });
let fails = 0;
const check = (ok, what, got) => { console.log((ok ? 'ok   ' : 'FAIL ') + what + (got !== undefined ? '  ' + JSON.stringify(got) : '')); if (!ok) fails++; };
const turn = () => new Promise(setImmediate);
const realStat = fs.statSync, realRead = fs.readFileSync;

(async () => {
  const config = require('../lib/config'), D = require('../lib/digests'), I = require('../lib/inbox');
  fs.mkdirSync(D.DIR(), { recursive: true });

  // config.get: one stat per loop turn, and still live.
  await turn(); config.get(); await turn();
  let stats = 0;
  fs.statSync = function (p, ...a) { if (p === config.SETTINGS_FILE) stats++; return realStat.call(fs, p, ...a); };
  for (let i = 0; i < 5000; i++) config.get();
  fs.statSync = realStat;
  check(stats === 1, '5,000 config.get in one turn: one stat', stats);
  config.set({ port: 1234 }, 'test');
  check(config.get().port === 1234, 'config.set is seen at once, in the same turn');
  await turn();
  const raw = JSON.parse(realRead(config.SETTINGS_FILE, 'utf8')); raw.port = 4321;
  fs.writeFileSync(config.SETTINGS_FILE, JSON.stringify(raw));
  const later = new Date(Date.now() + 5000); fs.utimesSync(config.SETTINGS_FILE, later, later);
  await turn();
  check(config.get().port === 4321, 'another process editing settings.json is seen on the next turn', config.get().port);

  // digests.turns: owner once, not per heading.
  const sid = 'local_hot', who = String((config.get().index || {}).ownerLabel || 'USER');
  let body = '# t\n';
  for (let i = 0; i < 3000; i++) body += `## 2026-11-07 10:${String(i % 60).padStart(2, '0')} ${i % 2 ? 'ASSISTANT' : who}: x${i}\n`;
  fs.writeFileSync(D.digestPath(sid), body);
  const realGet = config.get; let gets = 0;
  config.get = function () { gets++; return realGet.apply(this, arguments); };
  const ts = D.turns(sid);
  config.get = realGet;
  check(ts.length === 3000 && ts[0].kind === 'OWNER' && ts[1].kind === 'ASSISTANT', 'turns still classifies every heading', ts.length);
  check(gets <= 2, 'and asks settings for the owner once, not per heading', gets);

  // read(sid, tail): same answer, without reading the file; multi-byte text survives the cut.
  fs.writeFileSync(D.digestPath('local_u'), 'अ'.repeat(5000) + '\u{1F600}'.repeat(3000) + 'end');
  const whole = realRead(D.digestPath('local_u'), 'utf8');
  let reads = 0;
  fs.readFileSync = function (p, ...a) { if (String(p).includes('local_u')) reads++; return realRead.call(fs, p, ...a); };
  const same = [10, 1001, 4000, 7000, 999999].every(n => D.read('local_u', n) === whole.slice(-n));
  fs.readFileSync = realRead;
  check(same, 'read(sid, tail) equals slice(-tail), on Devanagari and emoji');
  check(reads === 0, 'without reading the whole file', reads);
  check(D.read('local_none', 10) === '', 'a missing digest is empty');

  // autoResolve: one parse per session per pass; none when the digest predates the card.
  const dp = D.digestPath(sid);
  for (let i = 0; i < 6; i++) I.add('hot card ' + i, { session: sid, source: 'test' });
  let parses = 0;
  const count = () => { parses = 0; fs.readFileSync = function (p, ...a) { if (p === dp) parses++; return realRead.call(fs, p, ...a); }; };
  const old = new Date(Date.now() - 86400000); fs.utimesSync(dp, old, old);
  count(); I.autoResolve({}); fs.readFileSync = realRead;
  check(parses === 0, 'digest last written before the cards: not read at all', parses);
  const soon = new Date(Date.now() + 3600000); fs.utimesSync(dp, soon, soon);
  count(); I.autoResolve({}); fs.readFileSync = realRead;
  check(parses === 1, 'six cards on a written session: parsed once', parses);

  // updateAll lets the loop run between sessions.
  const tr = path.join(dir, 't.jsonl'); fs.writeFileSync(tr, '');
  const sessions = {}, byCli = new Map();
  for (let i = 0; i < 1500; i++) { const c = 'c' + i; sessions['local_s' + i] = { cli: c, title: 'x' }; byCli.set(c, { path: tr }); }
  let turns = 0, on = true;
  const spin = () => { if (on) { turns++; setImmediate(spin); } };
  spin();
  const p = D.updateAll(sessions, byCli);
  check(p && typeof p.then === 'function', 'updateAll is asynchronous');
  await p; on = false;
  check(turns > 1, 'and the loop ran during it', turns);
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
