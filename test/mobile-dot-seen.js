// mobile-dot-seen.js — 29-Sep: a "needs you" dot stayed on a session he had opened in the app and
// cleared only later. The Desktop had raised it from its own post-turn classifier ("blocked"), and
// opening the session there does not clear it either. Opening it in the app now marks that TURN seen.
'use strict';
const H = require('./mobile-harness');
const W = H.world('dotseen', { env: true });
const { check } = H;
const sessions = require('../mobile/sessions');

const s = { id: 'local_a', title: 'worker', turnMark: 'uuid-turn-1' };
const snap = (o) => ({ sessions: [Object.assign({ sessionId: 'local_a', awaiting: true, running: false, unread: false }, o)] });
const dec = (list, sn) => sessions.decorate(list, sn)[0];

check(dec([s], snap()).awaiting === true, 'control: the Desktop says awaiting, so the dot is up');
const v0 = sessions.ackVersion();
check(sessions.ackDot('local_a', 'uuid-turn-1') && sessions.ackVersion() > v0, 'opening it records the turn as seen (and invalidates cached lists)');
const d1 = dec([s], snap());
check(d1.awaiting === false && d1.dot === null && d1.seen === true, 'the dot for that turn is down at once, before any Desktop sync', d1);
check(dec([s], snap({ awaiting: false, unread: true })).unread === false, 'an unread dot for the same turn is down too');
const next = Object.assign({}, s, { turnMark: 'uuid-turn-2' });
check(dec([next], snap()).awaiting === true, 'a NEW turn that needs him raises the dot again');
check(dec([s], snap({ running: true })).running === true, 'control: a running session is never hidden');
check(dec([Object.assign({}, s, { turnMark: null })], snap()).awaiting === true, 'no turn identity: nothing is hidden');

const fs = require('fs'), path = require('path');
const saved = JSON.parse(fs.readFileSync(path.join(require('../lib/config').STATE, 'dot-seen.json'), 'utf8'));
check(saved.local_a && saved.local_a.mark === 'uuid-turn-1', 'the seen turn survives a restart (persisted)');

const app = H.src('mobile/public/app.js');
check(/if \(state\.open !== id \|\| state\.question \|\| state\.permission\) return;/.test(app), 'an open question or permission prompt keeps its dot (he still has to answer)');
check(/api\('\/api\/seen\?id=' \+ encodeURIComponent\(id\)\)/.test(app) && /r\.awaiting = false; r\.unread = false; r\.dot = null/.test(app), 'the app clears the dot locally and tells the server');
const ix = H.src('mobile/index.js');
check(/p === '\/api\/seen'/.test(ix) && /sessions\.ackVersion\(\)/.test(ix), 'the server endpoint exists and the poll re-decorates after a seen');
const readOk = ix.slice(ix.indexOf('const READ_OK'), ix.indexOf('const WRITE_OK'));
check(!/\/api\/seen/.test(readOk), 'a scoped sub-user cannot clear dots (they are shared)');
check(/turnMark: d\.lastAssistantUuid/.test(H.src('mobile/sessions.js')) && /status_category === 'blocked'/.test(H.src('mobile/sessions.js')), 'the turn is the Desktop record\'s last assistant message; a classifier "blocked" is recorded for the log');
H.finish(W);
