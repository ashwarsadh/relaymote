// principals.js — g1870: one Conductor per principal on one account. A phone set to Sagar sees only his
// goals and asks (and the sessions serving them), his board taps go to Sagar Conductor and nowhere else,
// and a cold open lands on his Conductor. A phone with no principal (Ashwar's) sees everything.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

let failed = 0;
const check = (ok, name, extra) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra !== undefined && !ok ? '  ' + JSON.stringify(extra).slice(0, 300) : ''}`); if (!ok) failed++; };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'principals-'));
fs.writeFileSync(path.join(dir, 'principals.json'), JSON.stringify({ default: 'ashwar', principals: {
  ashwar: { name: 'Ashwar', conductor: null, sees: 'all' },
  sagar: { name: 'Sagar', conductor: 'local_S', sees: 'own' } } }));
const board = {
  goals: [{ id: 'g1', session: 'local_A1', status: 'open' }, { id: 'g2', session: 'local_B1', status: 'open', principal: 'sagar' },
          { id: 'g3', session: 'local_B2', status: 'done', principal: 'sagar' }],
  inbox: [{ n: 1, text: 'ashwar ask', status: 'open' }, { n: 2, text: 'sagar ask', status: 'open', principal: 'sagar', session: 'local_B3' }],
  inbox_waiting: [], inbox_resolved: [],
  rows: [{ id: 'local_A1', project: 'tally' }, { id: 'local_B1', project: 'naaptol' }, { id: 'local_B2', project: 'x' },
         { id: 'local_B3', project: 'memento' }, { id: 'local_S', project: 'development' }],
};

const P = require('../mobile/principals');
const sag = P.resolve(dir, 'Sagar'), ash = P.resolve(dir, ''), junk = P.resolve(dir, 'nobody');
check(sag.key === 'sagar' && sag.own && sag.conductor === 'local_S', 'Sagar resolves to his own Conductor and own board', sag);
check(ash.key === 'ashwar' && !ash.own && ash.conductor === null, 'no principal = Ashwar, sees all, default Conductor', ash);
check(junk.key === 'ashwar', 'an unknown ?as= falls back to the default, never to someone else', junk);

const n = P.narrow(board, sag, 'ashwar');
check(n.goals.map(g => g.id).join() === 'g2,g3', "Sagar's board: only his goals", n.goals);
check(n.inbox.map(r => r.n).join() === '2', "Sagar's board: only his asks", n.inbox);
check(n.rows.map(r => r.id).sort().join() === 'local_B1,local_B3,local_S', "Sagar's rows: his open goals' owners, his asks' sessions, his Conductor (not a closed goal's owner)", n.rows);
check(P.narrow(board, ash, 'ashwar') === board, "Ashwar's board is untouched (sees all)");

// Board taps from Sagar's phone go to Sagar Conductor; Ashwar's go to the default Conductor.
(async () => {
  process.env.RELAYMOTE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-home-'));
  const cfg = require('../lib/config');
  const s = cfg.get(); s.board = { dir }; // the board module reads its folder from settings at load
  fs.writeFileSync(path.join(dir, 'board.json'), JSON.stringify({ ...board, conductor: 'local_ASH' }));
  const B = require('../mobile/board');
  const sentTo = [];
  B._setSender(async (sid) => { sentTo.push(sid); return { ok: true, delivered: true }; });
  B._setConductorState(async (_b, o) => ({ id: (o && o.id) || 'local_ASH', ok: true }));
  const r1 = await B.actBatch({ items: [{ kind: 'done', id: '#2' }], as: 'sagar' });
  const r2 = await B.actBatch({ items: [{ kind: 'done', id: '#1' }], as: 'sagar' });
  const r3 = await B.actBatch({ items: [{ kind: 'done', id: '#1' }] });
  if (B.CONDUCTOR_DIR !== dir) { console.log('skip board send checks: board dir is ' + B.CONDUCTOR_DIR); }
  else {
    check(r1.code === 200 && sentTo[0] === 'local_S', "Sagar's tap on his ask goes to Sagar Conductor", { r1, sentTo });
    check(r2.code === 400, "Sagar's phone cannot tap an item that is not his", r2);
    check(r3.code === 200 && sentTo[1] === 'local_ASH', "Ashwar's tap still goes to his Conductor", { r3, sentTo });
    const vs = (await B.view({ as: 'sagar' })).body, va = (await B.view({})).body;
    check(vs.goals.map(g => g.id + ':' + g.principal).join() === 'g2:sagar,g3:sagar' && vs.principal.own, "Sagar's view: his goals, principal field kept", vs.goals);
    check(va.goals.length === 3 && !va.principal.own, "Ashwar's view: every goal", va.goals.length);
  }

  // Cold open: a Sagar phone lands on his Conductor; resume still wins.
  const app = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'public', 'app.js'), 'utf8');
  const fn = app.slice(app.indexOf('function pickFirstScreen'), app.indexOf('async function firstScreen'));
  const ctx = { RESUME_MS: 30 * 60000 }; vm.createContext(ctx); vm.runInContext(fn + '; this.pick = pickFirstScreen;', ctx);
  const list = [{ id: 'local_PC', active: true, at: 5 }, { id: 'local_S', at: 1 }];
  check(ctx.pick(null, list, { home: 'local_S' }).id === 'local_S', 'cold open on a Sagar phone -> Sagar Conductor');
  check(ctx.pick(null, list, {}).id === 'local_PC', 'cold open with no principal -> the PC session, as before');
  check(ctx.pick({ kind: 'chat', id: 'local_PC', at: Date.now() }, list, { home: 'local_S' }).why === 'resume', 'reopen within 30 min still resumes where he was');
  check(ctx.pick(null, list, { home: 'local_GONE' }).id === 'local_PC', 'a home session that is gone falls back to the old rule');

  console.log(failed ? `\n${failed} FAILED` : '\nall principals checks passed');
  process.exit(failed ? 1 : 0);
})();
