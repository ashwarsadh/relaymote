// working-first.js — 27-Oct, Ashwar: "I don't see the blue dot session, which is working. The blue dot ones should
// appear above the yellow dot ones." The doorbell session was running, but Desktop's file still dated it 7 days back,
// so the list (sorted by that date, cut at the phone's 80) never carried it. Real server.js in a temp world.
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('./mobile-harness');
const { check } = H;

(async () => {
  const w = H.world('wfirst');
  const [base] = w.sessions();
  const now = Date.now(), DAY = 86400e3;
  const mk = (id, extra) => fs.writeFileSync(path.join(w.store, id + '.json'), JSON.stringify({ ...base, sessionId: id, ...extra }));
  // 100 idle sessions, all newer than the running one's stale date.
  for (let i = 0; i < 100; i++) mk(`local_idle${i}`, { cliSessionId: `cli-idle${i}`, title: `Idle ${i}`, lastActivityAt: now - i * 60e3 });
  mk('local_waiting', { cliSessionId: 'cli-waiting', title: 'Waiting for him', lastActivityAt: now - 2 * DAY });
  mk('local_doorbell', { cliSessionId: 'cli-doorbell', title: 'Doorbell · app not working', lastActivityAt: now - 7 * DAY });
  // Its transcript was written a minute ago (the session is working).
  const proj = path.join(w.claude, 'projects', String(base.cwd).replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(proj, { recursive: true });
  const tf = path.join(proj, 'cli-doorbell.jsonl');
  fs.writeFileSync(tf, '{"type":"user","message":{"role":"user","content":"hi"}}\n');
  const t = (now - 60e3) / 1000; fs.utimesSync(tf, t, t);
  fs.mkdirSync(path.join(w.home, 'state'), { recursive: true });
  fs.writeFileSync(path.join(w.home, 'state', 'desktop-snapshot.json'), JSON.stringify({ at: now, sessions: [
    { sessionId: 'local_doorbell', running: true, awaiting: false, unread: false, statusDot: 'Running' },
    { sessionId: 'local_waiting', running: false, awaiting: true, unread: false, statusDot: 'Awaiting input' },
  ] }));

  const d = await H.boot(w);
  try {
    const r = await d.req('/api/sessions?limit=80');
    const ids = (r.json.sessions || []).map(s => s.id);
    check(r.status === 200 && ids[0] === 'local_doorbell', 'the working session is first, though Desktop dates it 7 days back', ids.slice(0, 4));
    check(ids[1] === 'local_waiting', 'the waiting session is next, above 100 newer idle ones', ids.slice(0, 4));
    const row = r.json.sessions[0] || {};
    check(row.running && now - row.at < 5 * 60e3 && !row.stalled, "its time is the transcript's last write, so it is not shown as stalled", { at: row.at, stalled: row.stalled });
    // 29-Oct: a starred session the phone keeps is never cut, however old (the phone puts starred on top).
    const k = await d.req('/api/sessions?limit=5&keep=local_idle99');
    check((k.json.sessions || []).some(s => s.id === 'local_idle99'), 'a starred session older than the cut still reaches the phone', (k.json.sessions || []).map(s => s.id));
  } finally { await d.stop(); w.cleanup(); }
  H.finish(null);
})().catch(e => { console.error(e); process.exit(1); });
