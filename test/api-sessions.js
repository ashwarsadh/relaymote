// api-sessions.js — sessions the claude-api service runs for apps never notify, never show an unread/awaiting
// dot, and the phone's "API" chip shows / folds / hides them (hidden by default). Ashwar 14-Oct-2026.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

let failed = 0;
const check = (ok, name, extra) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra !== undefined && !ok ? '  ' + JSON.stringify(extra).slice(0, 300) : ''}`); if (!ok) failed++; };

process.env.RELAYMOTE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-api-'));
const config = require('../lib/config');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-state-'));
const stateFile = path.join(dir, 'sessions.json');
config.get().apiSessions = { stateFile };
fs.writeFileSync(stateFile, JSON.stringify({ grading: { session: 'local_API1' }, mail: { session: 'local_API2' } }));

const A = require('../mobile/api-sessions');
check(A.isApi({ id: 'local_API1', title: 'whatever' }), 'an id in the claude-api state file is an API session');
check(A.isApi({ id: 'local_OLD', title: 'API: grading (2026-10-12)' }) && A.isApi({ id: 'x', title: 'API · grading' }), 'a title starting "API:" or "API ·" is one');
check(!A.isApi({ id: 'local_ME', title: 'Apiary notes' }) && !A.isApi({ id: 'y', title: 'RAPID API fix' }), 'other titles are not');
fs.writeFileSync(stateFile, JSON.stringify({ grading: { session: 'local_API3' } }));
const t = Date.now() / 1000 + 5; fs.utimesSync(stateFile, t, t);
check(A.isApi({ id: 'local_API3' }) && !A.isApi({ id: 'local_API1' }), 'the state file is re-read when it changes');
fs.writeFileSync(path.join(dir, 'api-sessions.json'), JSON.stringify({ local_API5: { app: 'pattern3d', title: 'API · pattern3d' } }));
check(A.isApi({ id: 'local_API5', title: 'renamed' }) && A.isApi({ id: 'local_API3' }), 'a key of api-sessions.json is one too');

// decorate: an API session never carries an unread / awaiting dot; a person's session still does.
const sessions = require('../mobile/sessions');
const snap = { sessions: [
  { sessionId: 'local_API3', unread: true, awaiting: true, running: false, statusDot: 'Awaiting input' },
  { sessionId: 'local_ME', unread: true, awaiting: true, running: false, statusDot: 'Awaiting input' },
  { sessionId: 'local_API4', unread: false, awaiting: false, running: true, statusDot: 'Running' },
] };
const out = sessions.decorate([{ id: 'local_API3', title: 'g' }, { id: 'local_ME', title: 'mine' }, { id: 'local_API4', title: 'API: mail (2026-10-14)' }], snap);
const by = Object.fromEntries(out.map(s => [s.id, s]));
check(by.local_API3.api && !by.local_API3.unread && !by.local_API3.awaiting && !by.local_API3.dot, 'API session: no unread, no awaiting, no dot', by.local_API3);
check(!by.local_ME.api && by.local_ME.unread && by.local_ME.awaiting, "a person's session keeps its dots", by.local_ME);
check(by.local_API4.api && by.local_API4.running && by.local_API4.dot === 'Running', 'a running API session still shows it is running', by.local_API4);

// Alerts: attentionState returns null for an API session, so no SSE alert and no push is ever raised.
const ix = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'index.js'), 'utf8');
const src = ix.slice(ix.indexOf('function attentionState('), ix.indexOf('\n}\n', ix.indexOf('function attentionState(')) + 3);
const ctx = { wasRunning: new Map([['a', true]]) }; vm.createContext(ctx); vm.runInContext(src + ';this.f = attentionState;', ctx);
check(ctx.f({ id: 'a', api: true, unread: true, awaiting: true, running: false }) === null, 'attentionState: an API session never alerts (awaiting, unread or just finished)');
check(ctx.f({ id: 'a', unread: true }) === 'done', 'control: a person\'s finished session still alerts');

// The phone: the API chip defaults to hidden; fold groups them; Others still applies to non-API rows.
const app = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'public', 'app.js'), 'utf8');
const fsrc = app.slice(app.indexOf('const FOLDS = ['), app.indexOf('function renderSessions'));
const store = {};
const c2 = { state: {}, localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; } } };
vm.createContext(c2); vm.runInContext(fsrc + ';this.FOLDS = FOLDS; this.foldMode = foldMode; this.applyFold = applyFold;', c2);
const api = c2.FOLDS.find(f => f.key === 'api');
check(c2.foldMode(api) === 'hide', 'the API chip starts hidden');
const list = [{ id: '1' }, { id: '2', api: true }, { id: '3', othersOnly: true }];
check(c2.applyFold(list, 'hide', api.is).rows.map(s => s.id).join() === '1,3', 'API hidden -> only non-API rows');
const f = c2.applyFold(list, 'fold', api.is);
check(f.rows.length === 2 && f.folded.map(s => s.id).join() === '2', 'API folded -> one API group');
check(c2.applyFold(list, 'show', api.is).rows.length === 3, 'API shown -> all rows');
store['baton.apiSessions'] = 'show';
check(c2.foldMode(api) === 'show', 'the choice is remembered on the phone');

console.log(failed ? `\n${failed} FAILED` : '\nall api-sessions checks passed');
process.exit(failed ? 1 : 0);
