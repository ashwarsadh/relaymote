// mcp.js — the Relaymote MCP server over real stdio JSON-RPC: handshake, tool list, the slave/master gate
// (every control tool refused for a slave, the slave-safe ones open), claiming, a second session
// refused, takeover, release, and the audit log. Offline: temp BATON_HOME, spare ports with no daemon
// on them, fake session ids. Nothing here reaches Claude Desktop or a real session.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-mcp-'));
const PORT = 20000 + Math.floor(Math.random() * 800);
const HOME = path.join(TMP, 'baton');
const PROJECT = path.join(TMP, 'project');
fs.mkdirSync(PROJECT, { recursive: true });

let failed = 0, passed = 0;
const check = (ok, name, extra) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && extra !== undefined ? '  ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)).slice(0, 400) : ''}`);
  if (ok) passed++; else failed++;
};

function server(sessionId) {
  const env = { ...process.env, BATON_HOME: HOME, BATON_PORT: String(PORT), BATON_APP_PORT: String(PORT + 900), BATON_CDP_PORT: '9',
    APPDATA: path.join(TMP, 'appdata'), CLAUDE_CONFIG_DIR: path.join(TMP, 'claude') };
  delete env.BATON_STATE_DIR; delete env.CLAUDE_CODE_SESSION_ID;
  if (sessionId) env.CLAUDE_CODE_HOST_SESSION_ID = sessionId; else delete env.CLAUDE_CODE_HOST_SESSION_ID;
  const child = spawn(process.execPath, [path.join(ROOT, 'mcp', 'baton-mcp.js')], { cwd: PROJECT, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '', seq = 0; const waiting = new Map();
  child.stdout.on('data', d => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id != null && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
    }
  });
  child.stderr.on('data', () => {});
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq;
    const t = setTimeout(() => { waiting.delete(id); reject(new Error('timeout ' + method)); }, 20000);
    waiting.set(id, m => { clearTimeout(t); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const call = async (name, args) => {
    const m = await rpc('tools/call', { name, arguments: args || {} });
    let body = null; try { body = JSON.parse(m.result.content[0].text); } catch {}
    return { isError: m.result && m.result.isError, body };
  };
  return { child, rpc, call, close: () => { try { child.stdin.end(); child.kill(); } catch {} } };
}

(async () => {
  const A = server('local_mcp_test_a');
  const init = await A.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'core-test', version: '0' } });
  check(init.result && init.result.serverInfo.name === 'baton', 'initialize: serverInfo names baton', init.result && init.result.serverInfo);
  check(/SLAVE by default/.test(init.result.instructions), 'the handshake tells every session it is a SLAVE by default');
  const list = await A.rpc('tools/list', {});
  const names = list.result.tools.map(t => t.name);
  for (const n of ['baton_status', 'baton_become_master', 'baton_release_master', 'baton_route_preview', 'baton_spawn', 'baton_tasks', 'baton_escalate', 'baton_stop', 'baton_list_sessions']) {
    check(names.includes(n), `tools/list includes ${n}`);
  }
  check(list.result.tools.every(t => t.inputSchema && t.inputSchema.type === 'object' && t.description), 'every tool has a description and an object schema');

  const st = await A.call('baton_status');
  check(st.body && st.body.role === 'SLAVE', 'status: a fresh session is a SLAVE', st.body && st.body.role);

  const CONTROL = [['baton_spawn', { prompt: 'do something' }], ['baton_list_sessions', {}], ['baton_tasks', {}], ['baton_escalate', { taskId: 't0001' }],
    ['baton_stop', { taskId: 't0001' }], ['baton_fleet', {}], ['baton_archive_candidates', {}], ['baton_set_model', { sessionIds: ['local_x'], model: 'claude-opus-5-5' }], ['baton_prepare_wake', { session_ids: ['local_x'] }]];
  if (names.includes('baton_goal_add')) CONTROL.push(['baton_goal_add', { title: 'x' }]);
  for (const [n, args] of CONTROL) {
    if (!names.includes(n)) { check(false, `${n} exists to be gated`); continue; }
    const r = await A.call(n, args);
    check(r.isError && r.body.error === 'NOT_MASTER', `a slave calling ${n} is refused NOT_MASTER (guard fires)`, r.body);
  }
  const unknown = await A.call('baton_does_not_exist');
  check(unknown.body.error === 'UNKNOWN_TOOL', 'an unknown tool is reported, not run');
  const pv = await A.call('baton_route_preview', { prompt: 'audit every file in the codebase for security issues' });
  check(!pv.isError && pv.body && JSON.stringify(pv.body).includes('high'), 'baton_route_preview is open to a slave and routes offline', pv.body);

  const noQuote = await A.call('baton_become_master', { user_instruction: 'ok' });
  check(noQuote.body.error === 'INSTRUCTION_REQUIRED', 'claiming without quoting the user is refused (guard fires)');
  const claim = await A.call('baton_become_master', { user_instruction: 'please act as the master for this project', project: 'demo' });
  check(claim.body.ok && claim.body.role === 'MASTER' && claim.body.project === 'demo' && !!claim.body.operatingProtocol, 'claiming with a quote makes it MASTER and returns the operating protocol', claim.body.error);
  const tasks = await A.call('baton_tasks', {});
  check(!(tasks.body && tasks.body.error === 'NOT_MASTER'), 'a master passes the gate for baton_tasks', tasks.body);
  const masters = JSON.parse(fs.readFileSync(path.join(HOME, 'state', 'masters.json'), 'utf8'));
  check(masters.demo && masters.demo.sessionId === 'local_mcp_test_a', 'the claim is written to masters.json');

  const B = server('local_mcp_test_b');
  await B.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'core-test', version: '0' } });
  const clash = await B.call('baton_become_master', { user_instruction: 'be the master please', project: 'demo' });
  check(clash.body.error === 'ALREADY_CLAIMED' && clash.body.currentMaster.sessionId === 'local_mcp_test_a', 'a second session cannot silently take a claimed project', clash.body.error);
  const other = await B.call('baton_become_master', { user_instruction: 'be the master of the other project', project: 'other' });
  check(other.body.ok, 'another project can have its own master at the same time');
  await B.call('baton_release_master');
  const take = await B.call('baton_become_master', { user_instruction: 'take over the demo project', project: 'demo', takeover: true });
  check(take.body.ok && take.body.claim.takeoverFrom === 'local_mcp_test_a', 'takeover:true moves the claim and records who lost it');
  const demoted = await A.call('baton_tasks', {});
  check(demoted.body && demoted.body.error === 'NOT_MASTER', 'the previous master is demoted to SLAVE at once (guard fires)', demoted.body);
  check((await A.call('baton_status')).body.role === 'SLAVE', '…and its status says so');
  const rel = await B.call('baton_release_master');
  check(rel.body.ok && rel.body.role === 'SLAVE' && !JSON.parse(fs.readFileSync(path.join(HOME, 'state', 'masters.json'), 'utf8')).demo, 'release returns it to SLAVE and frees the project');
  check((await B.call('baton_spawn', { prompt: 'x' })).body.error === 'NOT_MASTER', 'after release the control tools are refused again');

  const N = server(null);
  await N.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'core-test', version: '0' } });
  const anon = await N.call('baton_become_master', { user_instruction: 'please act as the master' });
  check(anon.body.error === 'NO_SESSION_ID', 'a server with no session id cannot grant mastery (guard fires)');
  const ping = await N.rpc('ping', {});
  check(ping.result && !ping.error, 'ping answers');
  const bad = await N.rpc('no/such/method', {});
  check(bad.error && bad.error.code === -32601, 'an unknown JSON-RPC method gets -32601');

  const audit = fs.readFileSync(path.join(HOME, 'state', 'master-audit.log'), 'utf8');
  check(/MASTER CLAIMED by local_mcp_test_a project="demo"/.test(audit) && /takeover=true/.test(audit) && /MASTER RELEASED by local_mcp_test_b/.test(audit), 'claims, takeovers and releases are in the audit log');

  for (const s of [A, B, N]) s.close();
  await new Promise(r => setTimeout(r, 300));
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('CRASH', e && e.stack || e); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} process.exit(1); });
