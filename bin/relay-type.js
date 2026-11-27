#!/usr/bin/env node
'use strict';
// relay-type <session_id> "<text>" --as <conductor session id> --token <token>
// Types <text> into a Claude Desktop session AS A NORMAL USER MESSAGE (the same LocalSessions.sendMessage call the message box
// makes, over the Electron debug port - no screenshots, no clicking) and says whether a turn started.
// Ashwar 27-Nov, via the Conductor: "for me yourself you can use the Electron app, fill in in the text box, open that lane and press send".
//
// Guard (honest limits): every lane runs as the same Windows user, so no file can truly keep a lane out. The guard is therefore
//   (1) --as must be the registered Conductor (~/.claude/conductor/last-conductor.txt), (2) --token must equal the contents of
//   ~/.claude/conductor/relay-type.token (created by `relay-type --init`, never printed), (3) every use, allowed or refused, is
//   appended to ~/.claude/conductor/relay-type.log (JSON lines: time IST, caller, session, exact text, result), (4) empty text and
//   text over 2000 characters are refused. A lane that reads the token file has stepped outside its brief and the log shows it.
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const DIR = path.join(os.homedir(), '.claude', 'conductor');
const TOKEN = path.join(DIR, 'relay-type.token'), LOG = path.join(DIR, 'relay-type.log'), MAX = 2000;

const argv = process.argv.slice(2), flags = {}, rest = [];
for (let i = 0; i < argv.length; i++) { if (argv[i].startsWith('--')) { const k = argv[i].slice(2); flags[k] = ['init', 'dry'].includes(k) ? true : argv[++i]; } else rest.push(argv[i]); }
const ist = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().replace('Z', '+05:30');
const log = (o) => { try { fs.mkdirSync(DIR, { recursive: true }); fs.appendFileSync(LOG, JSON.stringify({ at: ist(), ...o }) + '\n'); } catch {} };
const done = (o, code = 0) => { console.log(JSON.stringify(o)); process.exit(code); };

(async () => {
  if (flags.init) {
    if (fs.existsSync(TOKEN)) done({ ok: true, note: 'token already exists', file: TOKEN });
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(TOKEN, crypto.randomBytes(24).toString('hex'), { mode: 0o600 });
    log({ event: 'init' });
    done({ ok: true, file: TOKEN, note: 'pass its contents as --token' });
  }
  const [sid, ...t] = rest, text = t.join(' ');
  const base = { caller: flags.as || '', session: sid || '', text };
  let cond = ''; try { cond = fs.readFileSync(path.join(DIR, 'last-conductor.txt'), 'utf8').trim(); } catch {}
  let tok = ''; try { tok = fs.readFileSync(TOKEN, 'utf8').trim(); } catch {}
  const refuse = (why) => { log({ ...base, result: 'refused', why }); done({ ok: false, error: why }, 2); };
  if (!tok) refuse('NO_TOKEN_FILE (run relay-type --init)');
  if (!cond || flags.as !== cond) refuse('NOT_THE_CONDUCTOR');
  if (!flags.token || flags.token.length !== tok.length || !crypto.timingSafeEqual(Buffer.from(flags.token), Buffer.from(tok))) refuse('BAD_TOKEN');
  if (!/^local_[0-9a-f-]{36}$/.test(sid || '')) refuse('BAD_SESSION_ID (use the local_… id)');
  if (!text.trim()) refuse('EMPTY_TEXT');
  if (text.length > MAX) refuse('TEXT_TOO_LONG (max ' + MAX + ')');
  if (flags.dry) { log({ ...base, result: 'dry-run' }); done({ ok: true, dry: true }); }
  const desktop = require('../lib/desktop');
  let r;
  try { r = await desktop.sendQueued(sid, text); } catch (e) { r = { ok: false, error: 'THREW', detail: String(e && e.message || e).slice(0, 200) }; }
  log({ ...base, result: r.ok ? 'sent' : 'failed', detail: r });
  done(r.ok ? { ok: true, session: sid, uuid: r.uuid, turn: r.running ? 'queued behind the running turn; starts when it ends' : 'started', logged: LOG } : { ok: false, ...r }, r.ok ? 0 : 1);
})().catch(e => done({ ok: false, error: String(e && e.message || e) }, 1));
