// no-window-switch-principal.js — 26-Oct, Ashwar: "while i am typing here my window switches to ajay conductor while he
// uses relaymote". Ajay's phone, looking at his awaiting Conductor, asked /api/permission, and readPermission CLICKED
// that session open on Ashwar's PC (no idle check, no principal check, no restore). /api/answer and
// /api/permission/answer clicked it too. Real server.js against a fake Desktop that records every session-row click.
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('./mobile-harness');
const { check, wait } = H;

const row = (o) => JSON.stringify(Object.assign({ timestamp: new Date().toISOString(), uuid: require('crypto').randomUUID() }, o)) + '\n';

async function run(tag, idleGateSeconds, fn) {
  const boardDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'nws-board-'));
  const fake = await H.fakeDesktop();
  const w = H.world('nws-' + tag, { settings: { cdpPort: fake.port, idleGateSeconds, board: { dir: boardDir } } });
  const all = w.sessions();
  const [A, B] = all;
  for (const s of [A, B]) fake.sessions[s.sessionId] = { model: 'claude-opus-5-5', effort: 'high', transcript: [] };
  fs.writeFileSync(path.join(boardDir, 'principals.json'), JSON.stringify({ default: 'ashwar', principals: {
    ashwar: { name: 'Ashwar', conductor: null, sees: 'all' }, ajay: { name: 'Ajay', conductor: A.sessionId, sees: 'own' } } }));
  // A's transcript ends on a tool call still waiting for approval: the case that used to open it on the PC.
  const projects = path.join(w.claude, 'projects');
  for (const d of fs.readdirSync(projects)) {
    const f = path.join(projects, d, A.cliSessionId + '.jsonl');
    if (fs.existsSync(f)) fs.appendFileSync(f, row({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_wait', name: 'Bash', input: { command: 'dir' } }] } }));
  }
  // Every click on a sidebar row is recorded; the PC "shows" B, where Ashwar is typing.
  const clicks = [];
  fake.renderer.location.href = 'https://claude.ai/claude-code-desktop/' + B.sessionId;
  const rowStub = (id) => ({ getAttribute: (n) => (n === 'data-row-key' ? 'code:' + id : null), querySelector: () => null, querySelectorAll: () => [] });
  fake.renderer.document.querySelectorAll = (sel) => (/data-row-key/.test(String(sel)) ? [rowStub(A.sessionId), rowStub(B.sessionId)] : []);
  fake.renderer.document.querySelector = (sel) => {
    const m = /data-row-key="code:([^"]+)"/.exec(String(sel));
    return m ? { click() { clicks.push(m[1]); }, scrollIntoView() {} } : null;
  };
  const d = await H.boot(w);
  // The idle probe starts on first use and 'unknown' counts as in use: warm it on B (nothing waits there, so no click).
  await d.req('/api/permission?id=' + encodeURIComponent(B.sessionId));
  await wait(4000);
  try { await fn({ d, A, B, clicks, fake }); }
  finally { await d.stop(); fake.close(); try { fs.rmSync(boardDir, { recursive: true, force: true }); } catch {} }
  w.cleanup();
}

(async () => {
  // PC in use (Ashwar typing): nothing the phone asks for opens a session on the PC.
  await run('busy', 999999, async ({ d, A, clicks }) => {
    let r = await d.req('/api/permission?id=' + encodeURIComponent(A.sessionId));
    check(r.status === 202, 'the phone asks what is waiting in an awaiting session', r.status);
    await wait(3000);
    check(clicks.length === 0, 'PC in use: reading it does not open that session on the PC', clicks);
    r = await d.req('/api/permission/answer', { method: 'POST', body: { id: A.sessionId, kind: 'allow' } });
    await wait(1000);
    check(r.status === 409 && r.json.error === 'PC_IN_USE' && clicks.length === 0, 'PC in use: an Allow tap is held (409 PC_IN_USE), the session is not opened', { status: r.status, body: r.json, clicks });
  });
  // PC idle, but the phone is Ajay's: his Conductor is still never opened on Ashwar's PC; his answer goes as a message.
  await run('ajay', 0.001, async ({ d, A, clicks, fake }) => {
    const as = { 'X-Relaymote-As': 'ajay' };
    await d.req('/api/permission?id=' + encodeURIComponent(A.sessionId), { headers: as });
    await wait(3000);
    check(clicks.length === 0, "Ajay's phone reading his awaiting Conductor does not open it on Ashwar's PC", clicks);
    await d.req('/api/answer', { method: 'POST', headers: as, body: { id: A.sessionId, answers: [{ labels: ['Yes'] }] } });
    await wait(4000);
    const sent = fake.calls.filter(c => c[0] === 'sendMessage' && c[1] === A.sessionId);
    check(clicks.length === 0, "Ajay's answer does not open the session on the PC", clicks);
    if (!sent.length) console.log(d.output().split(String.fromCharCode(10)).slice(-40).join(String.fromCharCode(10)));
    check(sent.length >= 1, 'his answer reached the session in the background, as a message', sent.map(c => String(c[2]).slice(0, 60)));
  });
  // Control: the owner with the PC idle still gets the read (the test does see a click when one happens).
  await run('owner-idle', 0.001, async ({ d, A, clicks }) => {
    const ev = d.stream('nws-owner');
    await wait(800);
    await d.req('/api/permission?id=' + encodeURIComponent(A.sessionId), { headers: { 'X-Baton-Client': 'nws-owner' } });
    for (let i = 0; i < 40 && !clicks.length; i++) await wait(250);
    if (!clicks.length) console.log('uiresult:', JSON.stringify(ev.filter(e => e.event === 'uiresult')));
    check(clicks.includes(A.sessionId), 'control: owner, PC idle, a tool waiting -> the read may open it (and puts the view back)', clicks);
  });
  H.finish(null);
})().catch(e => { console.error(e); process.exit(1); });
