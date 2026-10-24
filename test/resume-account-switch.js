'use strict';
// #2112 (24-Oct): a weekly limit ("resets Oct 25, 3:30pm") cut 6 sessions at 16:58 IST on 23-Oct; the account
// was switched at 17:12 and none of the cut work was continued, because resume waited ~46 h for the parsed
// reset. A switch to another account after the stop now makes the session due at once.
const fs = require('fs'), os = require('os'), path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-resw-'));
process.env.RELAYMOTE_STATE_DIR = dir;
const resume = require('../lib/resume');
let fails = 0;
const check = (ok, what, got) => { console.log((ok ? 'ok   ' : 'FAIL ') + what + (ok || got === undefined ? '' : '  ' + JSON.stringify(got))); if (!ok) fails++; };

const stopAt = Date.parse('2026-10-23T11:28:00Z');        // 16:58 IST
const switchAt = Date.parse('2026-10-23T11:42:31Z');      // 17:12 IST
const row = { sessionId: 'local_lim1', title: 'cut by the weekly limit', cwd: 'C:/x', cliSessionId: null,
  error: "You've hit your weekly limit · resets Oct 25, 3:30pm (Asia/Kolkata)", errorAt: stopAt };
resume._setRowSource(() => [row]);
const writeScope = (v) => fs.writeFileSync(path.join(dir, 'account-scope.json'), JSON.stringify(v));

writeScope({ scope: 'A/1', since: stopAt - 864e5 });
let c = resume.candidates(switchAt + 60e3)[0];
check(c && !c.due && c.resetSource !== 'account-switch', 'no switch: it waits for the parsed reset (Oct 25)', c && c.waitingReason);

writeScope({ scope: 'B/2', previous: 'A/1', since: switchAt, switchedAt: switchAt });
c = resume.candidates(switchAt + 10e3)[0];
check(c && !c.due && c.resetSource === 'account-switch', 'switched after the stop: due 30 s after the switch, not on Oct 25', c);
c = resume.candidates(switchAt + 31e3)[0];
check(c && c.due, 'and due once that grace has passed', c && c.waitingReason);

writeScope({ scope: 'B/2', previous: 'A/1', since: stopAt - 3600e3, switchedAt: stopAt - 3600e3 });
c = resume.candidates(stopAt + 60e3)[0];
check(c && !c.due && c.resetSource !== 'account-switch', 'a switch BEFORE the stop does not lift it (that account hit the limit)', c);

row.error = 'API Error: Repeated 529 Overloaded errors (rate limited)'; row.kind = undefined;
writeScope({ scope: 'B/2', previous: 'A/1', since: switchAt, switchedAt: switchAt });
c = resume.candidates(switchAt + 31e3)[0];
check(!c || c.resetSource !== 'account-switch', 'a rate limit is not treated as an account limit');

resume._setRowSource(null);
fs.rmSync(dir, { recursive: true, force: true });
if (fails) { console.error(fails + ' failed'); process.exit(1); }
console.log('resume-account-switch: all checks passed');
