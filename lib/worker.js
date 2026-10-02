'use strict';
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const registry = require('./registry');
const { reportLine } = require('./master-protocol');
const trust = require('./trust');

const ROOT = registry.ROOT;
const RESULTS = registry.RESULTS_DIR;
const AUTH_DIR = path.join(ROOT, 'auth');

function candidateRoots() {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  return [
    process.env.APPDATA && path.join(process.env.APPDATA, 'Claude', 'claude-code'),
    home && path.join(home, 'AppData', 'Roaming', 'Claude', 'claude-code'),
    home && path.join(home, 'AppData', 'Local', 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Roaming', 'Claude', 'claude-code'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Roaming', 'Claude', 'claude-code'),
  ].filter(Boolean);
}

function claudeBin(roots) {
  const execPath = process.env.CLAUDE_CODE_EXECPATH;
  if (!roots && execPath) { try { if (fs.existsSync(execPath)) return execPath; } catch {} }

  // Desktop has shipped two layouts: claude-code/<ver>/claude.exe, and (from 2.1.28x, Oct 2026)
  // claude-code/<ver>/<build-hash>/claude.exe. Accept both; within a version the newest build wins.
  const mtime = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };
  let best = null, bestV = null;
  for (const base of roots || candidateRoots()) {
    let versions = [];
    try { versions = fs.readdirSync(base).filter(v => /^\d+\.\d+\.\d+$/.test(v)); } catch { continue; }
    for (const v of versions) {
      const dir = path.join(base, v);
      let p = path.join(dir, 'claude.exe');
      if (!fs.existsSync(p)) {
        let subs = [];
        try { subs = fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => path.join(dir, d.name, 'claude.exe')); } catch {}
        p = subs.filter(f => fs.existsSync(f)).sort((x, y) => mtime(y) - mtime(x))[0];
      }
      if (!p) continue;
      if (!bestV || v.localeCompare(bestV, undefined, { numeric: true }) > 0) { best = p; bestV = v; }
    }
  }
  if (best) return best;

  throw new Error('claude CLI not found. Looked for CLAUDE_CODE_EXECPATH and claude.exe under: ' + (roots || candidateRoots()).join(' | '));
}

function buildArgs(task) {
  const prompt = task.masterId === undefined ? task.prompt : `${task.prompt}

---
${reportLine(task.masterId, { channel: 'file' })}`;
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose'];
  if (task.model) args.push('--model', task.model);
  if (task.effort) args.push('--effort', task.effort);
  args.push('--permission-mode', 'bypassPermissions');

  if (task.resumeSessionId) args.push('--resume', task.resumeSessionId);
  else if (task.sessionId) args.push('--session-id', task.sessionId);

  if (task.lean) args.push('--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}');

  if (task.fallbackModel) args.push('--fallback-model', task.fallbackModel);
  if (task.agent) args.push('--agent', task.agent);
  if (task.jsonSchema) args.push('--json-schema', typeof task.jsonSchema === 'string' ? task.jsonSchema : JSON.stringify(task.jsonSchema));
  return args;
}

const SAFE_FALLBACK_CWD = process.env.USERPROFILE || process.env.HOME || require('os').homedir();
function safeCwd(cwd) {
  const bad = /^[a-z]:\\?windows(\\|$)|^[a-z]:\\?$|system32|\\syswow64/i;
  if (!cwd || bad.test(cwd)) return SAFE_FALLBACK_CWD;
  try { if (!fs.existsSync(cwd)) return SAFE_FALLBACK_CWD; } catch { return SAFE_FALLBACK_CWD; }
  return cwd;
}

function spawnWorker(taskId) {
  const task = registry.getTask(taskId);
  if (!task) throw new Error('no such task: ' + taskId);
  registry.ensureDirs();

  const attempt = (task.attempt || 0) + 1;
  const resultFile = path.join(RESULTS, `${task.id}.a${attempt}.json`);
  const logFile = path.join(RESULTS, `${task.id}.a${attempt}.err.log`);

  const sessionId = task.resumeSessionId ? null : randomUuid();

  const args = buildArgs({ ...task, sessionId, attempt });
  const out = fs.openSync(resultFile, 'w');
  const err = fs.openSync(logFile, 'w');

  const runCwd = safeCwd(task.cwd);
  try { trust.ensureDefaultTrust([runCwd]); } catch {}
  const bin = claudeBin();
  const env = { ...process.env, CLAUDE_CONFIG_DIR: AUTH_DIR };
  delete env.CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH;
  delete env.CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH;
  // A .js "CLI" (CLAUDE_CODE_EXECPATH pointing at a stub — test/core.js) runs under this node, since
  // a script cannot be spawned directly on Windows.
  const viaNode = /\.(c|m)?js$/i.test(bin);
  const child = spawn(viaNode ? process.execPath : bin, viaNode ? [bin, ...args] : args, {
    cwd: runCwd,
    windowsHide: true,
    stdio: ['ignore', out, err],
    env,
  });
  child.on('error', e => {
    registry.updateTask(task.id, {
      status: 'failed',
      endedAt: new Date().toISOString(),
      error: `spawn failed (${e.code || 'ERR'}): ${e.message} [bin=${bin}]`,
      pid: null,
    });
  });
  child.unref();
  try { fs.closeSync(out); fs.closeSync(err); } catch {}

  return registry.updateTask(task.id, {
    status: 'running',
    attempt,
    runCwd,
    pid: child.pid,
    sessionId: sessionId || task.sessionId,
    startedAt: new Date().toISOString(),
    resultFile, logFile,
    error: null,
  });
}

function randomUuid() {
  try { return require('crypto').randomUUID(); }
  catch { return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }); }
}

const EXIT_GRACE_MS = 10000;

function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

const TAIL_BYTES = 256 * 1024;

function readTail(file, bytes) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    if (size <= bytes) return { text: fs.readFileSync(file, 'utf8'), whole: true };
    const buf = Buffer.alloc(bytes);
    fs.readSync(fd, buf, 0, bytes, size - bytes);
    return { text: buf.toString('utf8'), whole: false };
  } catch { return null; }
  finally { try { if (fd !== null) fs.closeSync(fd); } catch {} }
}

function transcriptShowsActivity(task) {
  if (!task || !task.resultFile) return false;
  try {
    if (!fs.existsSync(task.resultFile)) return false;
    const t = readTail(task.resultFile, TAIL_BYTES);
    if (!t || !t.text) return false;
    return /"type"s*:s*"assistant"|"type"s*:s*"tool_use"|"stop_reason"/.test(t.text);
  } catch { return false; }
}

function readResult(task) {
  if (!task.resultFile || !fs.existsSync(task.resultFile)) return null;
  let raw;
  const t = readTail(task.resultFile, TAIL_BYTES);
  if (!t) return null;
  raw = t.text.trim();
  if (!t.whole) { const nl = raw.indexOf(String.fromCharCode(10)); raw = nl >= 0 ? raw.slice(nl + 1) : ''; }
  if (!raw) return null;
  let j = null;
  if (raw.indexOf('\n') < 0) {
    try { j = JSON.parse(raw); } catch {
      const brace = raw.lastIndexOf('}');
      if (brace >= 0) { try { j = JSON.parse(raw.slice(0, brace + 1)); } catch {} }
    }
  } else {
    const lines = raw.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const L = lines[i].trim();
      if (!L || L[0] !== '{') continue;
      let o; try { o = JSON.parse(L); } catch { continue; }
      if (o && o.type === 'result') { j = o; break; }
    }
  }
  if (!j || typeof j !== 'object' || j.type !== 'result') return null;
  const u = j.usage || {};
  return {
    ok: j.is_error === false && j.subtype === 'success',
    subtype: j.subtype,
    apiErrorStatus: j.api_error_status || null,
    result: typeof j.result === 'string' ? j.result : JSON.stringify(j.result || ''),
    sessionId: j.session_id || null,
    costUsd: j.total_cost_usd || 0,
    numTurns: j.num_turns || 0,
    tokens: {
      input: u.input_tokens || 0,
      output: u.output_tokens || 0,
      cacheRead: u.cache_read_input_tokens || 0,
      cacheCreate: u.cache_creation_input_tokens || 0,
    },
    permissionDenials: j.permission_denials || [],
  };
}

function readErrTail(task, n = 600) {
  try { return fs.readFileSync(task.logFile, 'utf8').trim().slice(-n); } catch { return ''; }
}

function poll(taskId) {
  let task = registry.getTask(taskId);
  if (!task || task.status !== 'running') return task;

  const res = readResult(task);
  const alive = isAlive(task.pid);

  if (res && res.ok) {
    return registry.updateTask(task.id, {
      status: 'done',
      endedAt: new Date().toISOString(),
      exitSeenAt: null,
      result: res.result,
      sessionId: res.sessionId || task.sessionId,
      costUsd: (task.costUsd || 0) + res.costUsd,
      tokens: res.tokens,
      error: null,
      pid: null,
    });
  }

  if (res && !res.ok) {
    return registry.updateTask(task.id, {
      status: 'failed',
      endedAt: new Date().toISOString(),
      error: `${res.subtype || 'error'}${res.apiErrorStatus ? ' api=' + res.apiErrorStatus : ''}: ${(res.result || '').slice(0, 400) || readErrTail(task)}`,
      costUsd: (task.costUsd || 0) + res.costUsd,
      sessionId: res.sessionId || task.sessionId,
      pid: null,
    });
  }

  if (!alive) {
    if (!task.exitSeenAt) {
      return registry.updateTask(task.id, { exitSeenAt: new Date().toISOString() });
    }
    const waited = Date.now() - Date.parse(task.exitSeenAt);
    if (!(waited >= EXIT_GRACE_MS)) return task;
    return registry.updateTask(task.id, {
      status: 'failed',
      endedAt: new Date().toISOString(),
      error: `worker exited without a result after ${Math.round(waited / 1000)}s: `
             + (readErrTail(task) || 'no stderr'),
      pid: null,
    });
  }

  return task;
}

function stop(taskId) {
  const task = registry.getTask(taskId);
  if (!task) return null;
  if (task.pid && isAlive(task.pid)) {
    try { execFileSync('taskkill', ['/PID', String(task.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {}
  }
  return registry.updateTask(task.id, { status: 'cancelled', endedAt: new Date().toISOString(), pid: null });
}

function reconcile() {
  const out = { recovered: 0, failed: 0, stillRunning: 0 };
  for (const t of registry.allTasks()) {
    if (t.status !== 'running') continue;
    const before = t.status;
    const after = poll(t.id);
    if (!after) continue;
    if (after.status === 'done') out.recovered++;
    else if (after.status === 'failed') out.failed++;
    else if (after.status === 'running') out.stillRunning++;
    void before;
  }
  return out;
}

module.exports = {
  transcriptShowsActivity, spawnWorker, poll, stop, reconcile, isAlive, readResult, readErrTail, buildArgs, claudeBin, randomUuid, RESULTS };
