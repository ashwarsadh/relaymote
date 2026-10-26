// chip-background-start.js — 26-Oct, Ashwar: "relaymote shud hv ability to also self start such tasks too".
// Real server.js against a fake Desktop whose bridge holds suggested-task chips. The phone lists every waiting
// chip and starts one by taskId; the Conductor's own chips start by themselves; a chip marked optional waits.
// The PC is in use throughout (idle gate never met) and every sidebar-row click is recorded: none may happen.
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('./mobile-harness');
const { check, wait } = H;

(async () => {
  const boardDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'cbs-board-'));
  const fake = await H.fakeDesktop();
  const w = H.world('cbs', { settings: { cdpPort: fake.port, idleGateSeconds: 999999, board: { dir: boardDir }, newSession: { model: 'Opus 5.5', effort: 'medium' },
    modules: { autoResume: false, orchestrator: false, chipAutostart: true, masterNotify: false, organizer: false, routines: false } } });
  const [A, B] = w.sessions();          // A = the Conductor, B = an ordinary session
  const chips = {
    [A.sessionId]: [{ id: 'task_cond', title: 'Memento · packing list Particulars on one line', tldr: 'Fix the packing list', prompt: 'do it', createdAt: 2 },
                    { id: 'task_opt', title: 'Tidy the docs', tldr: 'Optional: only if you want', prompt: 'maybe', createdAt: 1 }],
    [B.sessionId]: [{ id: 'task_b', title: 'Probe chip: reply OK', tldr: 'a probe', prompt: 'reply OK', createdAt: 3 }],
  };
  const started = [], titles = {};
  const LS = fake.renderer['claude.web'].LocalSessions;
  const own = (id) => ({ sessionId: id, title: id === A.sessionId ? 'Conductor' : 'Ordinary', cwd: 'C:/work', model: 'claude-opus-5-5', effort: 'high',
                         permissionMode: 'bypassPermissions', isArchived: false, backgroundTaskSuggestions: chips[id] || [] });
  LS.getSessionList = async () => [A.sessionId, B.sessionId].map(own).concat(started.map(s => ({ sessionId: s.id, title: titles[s.id] })));
  LS.getSession = async (id) => (chips[id] ? own(id) : started.find(s => s.id === id) ? { sessionId: id, title: titles[id], spawnedFrom: started.find(s => s.id === id).spawnedFrom } : null);
  LS.start = async (args) => {
    const id = 'local_child_' + args.spawnedFrom.taskId;
    started.push({ id, ...args });
    if (args.spawnedFrom.pendingPop) chips[args.spawnedFrom.sessionId] = chips[args.spawnedFrom.sessionId].filter(c => c.id !== args.spawnedFrom.taskId);
    return { sessionId: id };
  };
  LS.updateSession = async (id, patch) => { if (patch.title) titles[id] = patch.title; };
  fs.writeFileSync(path.join(boardDir, 'last-conductor.txt'), A.sessionId);
  fs.writeFileSync(path.join(boardDir, 'principals.json'), JSON.stringify({ default: 'ashwar', principals: { ashwar: { name: 'Ashwar', conductor: null, sees: 'all' } } }));
  const clicks = [];
  fake.renderer.location.href = 'https://claude.ai/claude-code-desktop/' + B.sessionId;
  const rowStub = (id) => ({ getAttribute: (n) => (n === 'data-row-key' ? 'code:' + id : null), querySelector: () => null, querySelectorAll: () => [] });
  fake.renderer.document.querySelectorAll = (sel) => (/data-row-key/.test(String(sel)) ? [rowStub(A.sessionId), rowStub(B.sessionId)] : []);
  fake.renderer.document.querySelector = (sel) => {
    const m = /data-row-key="code:([^"]+)"/.exec(String(sel));
    return m ? { click() { clicks.push(m[1]); }, scrollIntoView() {} } : null;
  };
  const d = await H.boot(w, { RELAYMOTE_CHIPWATCH_MS: '1500' });
  try {
    // The Conductor's chip starts by itself, while the PC is in use; the optional one waits.
    for (let i = 0; i < 40 && !started.some(s => s.spawnedFrom.taskId === 'task_cond'); i++) await wait(250);
    const sc = started.find(s => s.spawnedFrom.taskId === 'task_cond');
    check(!!sc && sc.spawnedFrom.sessionId === A.sessionId && sc.spawnedFrom.pendingPop === true && sc.message === 'do it',
      "the Conductor's chip starts by itself, linked to the Conductor (spawnedFrom + pendingPop), with the chip's prompt", sc);
    check(sc && sc.model === 'claude-opus-5-5' && sc.effort === 'medium',
      'the default tier is stored as a label ("Opus 5.5"); the start carries the model id', sc && { model: sc.model, effort: sc.effort });
    check(titles['local_child_task_cond'] ==='Memento · packing list Particulars on one line', "the new session carries the chip's title", titles);
    await wait(3500);
    check(!started.some(s => s.spawnedFrom.taskId === 'task_opt'), 'a chip marked optional is not started by itself');
    check(!started.some(s => s.spawnedFrom.taskId === 'task_b'), "an ordinary session's chip is not started by itself");
    const cw = JSON.parse(fs.readFileSync(path.join(w.home, 'state', 'chipwatch.json'), 'utf8'));
    check(cw.ticks >= 2 && cw.lastTick && cw.lastTick.at && (cw.lastTick.held || []).some(h => h.taskId === 'task_opt'),
      'every tick leaves its outcome on disk (why a chip was or was not started)', { ticks: cw.ticks, lastTick: cw.lastTick });
    check(/chipwatch: .*task_opt/.test(d.output()), 'a tick that holds a chip says so in the log', d.output().split('\n').filter(l => /chipwatch/.test(l)).slice(-3));

    // The phone sees every waiting chip, wherever it is.
    let r = await d.req('/api/chips/all');
    const ids = r.json.ok ? r.json.sessions.flatMap(s => s.chips.map(c => c.taskId)) : [];
    check(r.status === 200 && ids.includes('task_b') && ids.includes('task_opt') && !ids.includes('task_cond'),
      'the phone lists the chips still waiting in any session (started ones gone)', r.json);
    const opt = r.json.sessions && r.json.sessions.flatMap(s => s.chips).find(c => c.taskId === 'task_opt');
    check(opt && opt.optional === true, 'the optional chip is marked optional', opt);

    // Start from the phone, by taskId: background, no click, front session unchanged.
    r = await d.req('/api/chip/start', { method: 'POST', body: { sessionId: B.sessionId, taskId: 'task_b', title: 'Probe chip: reply OK' } });
    check(r.status === 200 && r.json.ok && r.json.startedSessionId === 'local_child_task_b' && r.json.transport === 'background',
      'Start on the phone starts the chip in the background', r.json);
    r = await d.req('/api/chip/start', { method: 'POST', body: { sessionId: B.sessionId, taskId: 'task_b' } });
    check(r.status === 410 && r.json.error === 'NO_CHIP', 'a chip already started answers 410 NO_CHIP, not a second session', r.json);
    check(clicks.length === 0, 'no session row was clicked on the PC at any point', clicks);
    check(/claude-code-desktop\/local_/.test(fake.renderer.location.href) && fake.renderer.location.href.endsWith(B.sessionId), 'the PC still shows the session he was in', fake.renderer.location.href);
  } finally { await d.stop(); fake.close(); try { fs.rmSync(boardDir, { recursive: true, force: true }); } catch {} }
  w.cleanup();
  H.finish(null);
})().catch(e => { console.error(e); process.exit(1); });
