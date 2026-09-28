'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = process.env.USERPROFILE || os.homedir();
const STORE = path.join(require('../lib/config').APPDATA, 'Claude', 'claude-code-sessions');
const PROJECTS = path.join(require('../lib/config').CLAUDE_HOME, 'projects');

let cache = { at: 0, dirKey: '', list: [], byId: new Map() };
let parsed = new Map();
let inflight = null;
const TTL_MS = 12000;

function storeDirs() {
  const out = [];
  let accounts = [];
  try { accounts = fs.readdirSync(STORE); } catch { return out; }
  for (const a of accounts) {
    let orgs = [];
    try { orgs = fs.readdirSync(path.join(STORE, a)); } catch { continue; }
    for (const o of orgs) out.push(path.join(STORE, a, o));
  }
  return out;
}

function dirFingerprint(dirs) {
  let k = '';
  for (const d of dirs) {
    try { k += d + ':' + fs.statSync(d).mtimeMs + ';'; } catch {}
  }
  return k;
}

function shape(d, file) {
  return {
    id: d.sessionId,
    cliSessionId: d.cliSessionId || null,
    title: d.title || '(untitled)',
    cwd: d.cwd || d.originCwd || null,
    model: d.model || null,
    effort: d.effort || null,
    archived: !!d.isArchived,
    permissionMode: d.permissionMode || null,
    createdAt: d.createdAt || 0,
    lastActivityAt: d.lastActivityAt || d.lastFocusedAt || d.createdAt || 0,
    turns: d.completedTurns || 0,
    suggestion: d.promptSuggestion || null,
    file,
  };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const n = i++; out[n] = await fn(items[n], n); }
  }));
  return out;
}

async function scan() {
  const dirs = storeDirs();
  const files = [];
  for (const dir of dirs) {
    let names = [];
    try { names = await fs.promises.readdir(dir); } catch { continue; }
    for (const f of names) {
      if (f.startsWith('local_') && f.endsWith('.json')) files.push(path.join(dir, f));
    }
  }

  const seen = new Set();
  const now = Date.now();
  const recs = await mapLimit(files, 24, async file => {
    seen.add(file);
    const hit = parsed.get(file);
    if (hit && hit.rec) {
      const age = now - (hit.rec.lastActivityAt || 0);
      const since = now - (hit.statAt || 0);
      const recheck = age < 10 * 60 * 1000 ? 0
                    : age < 6 * 60 * 60 * 1000 ? 60 * 1000
                    : 10 * 60 * 1000;
      if (since < recheck) return hit.rec;
    }
    let st;
    try { st = await fs.promises.stat(file); } catch { return null; }
    if (hit) hit.statAt = now;
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.rec;
    let d;
    try { d = JSON.parse(await fs.promises.readFile(file, 'utf8')); } catch { return null; }
    if (!d || !d.sessionId) return null;
    const rec = shape(d, file);
    parsed.set(file, { mtimeMs: st.mtimeMs, size: st.size, statAt: now, rec });
    return rec;
  });

  for (const k of parsed.keys()) if (!seen.has(k)) parsed.delete(k);

  const byId = new Map();
  for (const r of recs) {
    if (!r) continue;
    const prev = byId.get(r.id);
    if (!prev || r.lastActivityAt > prev.lastActivityAt) byId.set(r.id, r);
  }
  const list = [...byId.values()].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  cache = { at: Date.now(), dirKey: dirFingerprint(dirs), list, byId };
  return cache;
}

function refresh({ force = false } = {}) {
  if (inflight) return inflight;
  if (!force && Date.now() - cache.at <= TTL_MS) return Promise.resolve(cache);
  if (!force && cache.list.length && dirFingerprint(storeDirs()) === cache.dirKey) {
    cache.at = Date.now();
    return Promise.resolve(cache);
  }
  inflight = scan().finally(() => { inflight = null; });
  return inflight;
}

function index() { return cache; }
function get(id) { return cache.byId.get(id) || null; }

const STALE_RUN_MS = 10 * 60 * 1000;

function decorate(list, snapshot) {
  const dots = new Map();
  if (snapshot && Array.isArray(snapshot.sessions)) {
    for (const s of snapshot.sessions) {
      dots.set(s.sessionId, {
        dot: s.statusDot || (s.running ? 'Running' : s.awaiting ? 'Awaiting input' : null),
        group: s.group || null,
        awaiting: !!s.awaiting,
        running: !!s.running,
        unread: !!s.unread,
      });
    }
  }
  const active = snapshot && snapshot.active ? snapshot.active : null;
  return list.map(s => {
    const d = dots.get(s.id);
    return {
      ...s,
      dot: d ? d.dot : null,
      group: d ? d.group : null,
      awaiting: d ? d.awaiting : false,
      running: d ? d.running : false,
      unread: d ? d.unread : false,
      active: s.id === active,
      live: !!d,
      stalled: !!(d && d.running && s.lastActivityAt && (Date.now() - s.lastActivityAt) > STALE_RUN_MS),
      quietFor: d && d.running && s.lastActivityAt ? Date.now() - s.lastActivityAt : 0,
    };
  });
}

function folders(list) {
  const m = new Map();
  for (const s of list) {
    if (s.archived) continue;
    const cwd = s.cwd || '(no folder)';
    let e = m.get(cwd);
    if (!e) { e = { cwd, name: path.basename(cwd) || cwd, count: 0, lastActivityAt: 0, running: 0, awaiting: 0 }; m.set(cwd, e); }
    e.count++;
    if (s.lastActivityAt > e.lastActivityAt) e.lastActivityAt = s.lastActivityAt;
    if (s.running) e.running++;
    if (s.awaiting) e.awaiting++;
  }
  return [...m.values()].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
}

function slugFor(cwd) {
  return String(cwd || '').replace(/[^A-Za-z0-9]/g, '-');
}

let projectDirsCache = { at: 0, dirs: [] };
function projectDirs() {
  if (Date.now() - projectDirsCache.at < 30000 && projectDirsCache.dirs.length) return projectDirsCache.dirs;
  let dirs = [];
  try { dirs = fs.readdirSync(PROJECTS).map(d => path.join(PROJECTS, d)); } catch {}
  projectDirsCache = { at: Date.now(), dirs };
  return dirs;
}

function transcriptPath(sess) {
  if (!sess || !sess.cliSessionId) return null;
  const direct = path.join(PROJECTS, slugFor(sess.cwd), sess.cliSessionId + '.jsonl');
  if (fs.existsSync(direct)) return direct;
  for (const d of projectDirs()) {
    const p = path.join(d, sess.cliSessionId + '.jsonl');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function readWindow(file, size, endAt) {
  const fd = fs.openSync(file, 'r');
  try {
    const total = fs.fstatSync(fd).size;
    const end = Math.max(0, Math.min(endAt == null ? total : endAt, total));
    const start = Math.max(0, end - size);
    const len = end - start;
    if (len <= 0) return { text: '', start: 0, end, total, truncated: false };
    const buf = Buffer.allocUnsafe(len);
    fs.readSync(fd, buf, 0, len, start);
    return { text: buf.toString('utf8'), start, end, total, truncated: start > 0 };
  } finally { fs.closeSync(fd); }
}

const INJECTED = [
  /^\s*<task-notification>/i,
  /^\s*\[SYSTEM NOTIFICATION/i,
  /^\s*\[Image: original \d+x\d+/i,
  /^\s*<command-(name|message|args)>/i,
  /^\s*<local-command-std(out|err)>/i,
  /^\s*<system-reminder>/i,
  /^A session-scoped Stop hook is now active/i,
  /^\s*Caveat: The messages below were generated/i,
  /^\s*Base directory for this skill:/i,
  /^\s*\[Request interrupted by user/i,
  /^\s*\[Request cancelled/i,
  /^\s*\[User dismissed/i,
  /^\s*Stop hook feedback:/i,
  /^\s*<user-prompt-submit-hook>/i,
  /^\s*<cross-session-message/i,
];
const isInjected = (t) => INJECTED.some(rx => rx.test(String(t || '')));

function stripFraming(text) {
  let t = String(text || '');
  for (let i = 0; i < 8; i++) {
    const open = t.indexOf('<system-reminder>');
    if (open < 0) break;
    const close = t.indexOf('</system-reminder>', open);
    if (close < 0) break;
    t = (t.slice(0, open) + t.slice(close + '</system-reminder>'.length));
  }
  return t.trim();
}

function unwrap(text) {
  const raw = String(text || '');
  if (!isInjected(raw)) return { text: raw, injected: false };
  const bare = stripFraming(raw);
  if (bare && bare.length > 12 && /<system-reminder>/i.test(raw) && !isInjected(bare)) {
    return { text: bare, injected: false };
  }
  return { text: raw, injected: true };
}

const USER_ATTACHMENTS = new Set(['file', 'image', 'pasted_text', 'pasted_image', 'selected_lines', 'screenshot']);
const TEXT_LIMIT = 4000;
const SPOKEN_LIMIT = 40000;
const PAGE_BUDGET = 600 * 1024;
function clip(s, n = TEXT_LIMIT) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n) + '\n… [' + (s.length - n) + ' more characters]' : s;
}

const STEP_VERBS = {
  Bash: ['Ran', 'Running'], BashTool: ['Ran', 'Running'], PowerShell: ['Ran', 'Running'],
  Read: ['Read', 'Reading'], Edit: ['Edited', 'Editing'], MultiEdit: ['Edited', 'Editing'],
  NotebookEdit: ['Edited', 'Editing'], Write: ['Created', 'Creating'],
  Grep: ['Searched', 'Searching'], Glob: ['Searched', 'Searching'], LS: ['Listed', 'Listing'],
  WebFetch: ['Fetched', 'Fetching'], WebSearch: ['Searched web', 'Searching web'],
  Task: ['Ran agent', 'Running agent'], Agent: ['Ran agent', 'Running agent'], Skill: ['Ran skill', 'Running skill'],
  TaskGet: ['Read task', 'Reading task'], TaskList: ['Listed tasks', 'Listing tasks'],
  TaskCreate: ['Added task', 'Adding task'], TaskStop: ['Stopped task', 'Stopping task'],
  TodoWrite: ['Updated todos', 'Updating todos'],
  EnterPlanMode: ['Started planning', 'Making a plan'], ExitPlanMode: ['Proposed plan', 'Proposing plan'],
  AskUserQuestion: ['Asked', 'Asking'], SendUserFile: ['Sent', 'Sending'], SendUserMessage: ['Sent', 'Sending'],
};
function baseName(p) {
  const t = String(p || '');
  const i = Math.max(t.lastIndexOf('/'), t.lastIndexOf('\\'));
  return i >= 0 ? t.slice(i + 1) : t;
}
function stepLabel(name, input) {
  const i = input && typeof input === 'object' ? input : {};
  const str = (k) => (typeof i[k] === 'string' && i[k].trim()) ? i[k].trim() : '';
  if (name === 'SendMessage' && str('to')) {
    return { done: 'Messaged @' + str('to'), running: 'Messaging @' + str('to'), meta: clip(str('message'), 200) };
  }
  if (name === 'mcp__ccd_session_mgmt__send_message' || name === 'SendMessage') {
    return { done: 'Messaged teammate', running: 'Messaging teammate', meta: clip(str('message'), 200), to: str('session_id') || str('to') || '' };
  }
  const v = STEP_VERBS[name];
  if (v) {
    let meta = '';
    switch (name) {
      case 'Bash': case 'BashTool': case 'PowerShell': meta = str('description') || str('command') || 'a command'; break;
      case 'Read': case 'Edit': case 'MultiEdit': case 'NotebookEdit': case 'Write':
        meta = baseName(str('file_path') || str('notebook_path')); break;
      case 'Grep': case 'Glob': meta = str('pattern'); break;
      case 'WebFetch': meta = str('url'); break;
      case 'WebSearch': meta = str('query'); break;
      case 'Task': case 'Agent': meta = str('description'); break;
      case 'Skill': meta = str('skill') ? '/' + str('skill') : ''; break;
      default: meta = '';
    }
    return { done: v[0], running: v[1], meta: clip(meta, 160) };
  }
  if (String(name).startsWith('mcp__')) {
    const parts = String(name).split('__');
    const label = (parts[2] || parts[1] || name).replace(/_/g, ' ');
    return { done: 'Used ' + label, running: 'Using ' + label, meta: '' };
  }
  return { done: 'Used ' + name, running: 'Using ' + name, meta: '' };
}

function peerRow(origin, ts, fallbackText) {
  let name = origin.name || null;
  let body = typeof origin.body === 'string' && origin.body.trim() ? origin.body : '';
  const raw = String(fallbackText || '');
  const open = raw.indexOf('<cross-session-message');
  if (open >= 0) {
    const gt = raw.indexOf('>', open);
    const attrs = gt > open ? raw.slice(open, gt) : '';
    const nm = attrs.match(/(?:^|\s)(?:from-)?name="([^"]*)"/);
    if (!name && nm) name = nm[1];
    if (!body && gt > open) {
      const close = raw.indexOf('</cross-session-message>', gt);
      body = raw.slice(gt + 1, close > gt ? close : undefined).trim();
    }
  }
  if (!body) body = raw;
  return { role: 'peer', ts, from: origin.from || null, name,
           msgId: origin.msg_id || null, text: clip(body, SPOKEN_LIMIT) };
}

function flatten(row) {
  const t = row.type;
  const ts = row.timestamp || null;

  if (t === 'user') {
    const c = row.message && row.message.content;
    if (row.origin && row.origin.kind === 'peer') {
      return peerRow(row.origin, ts, typeof c === 'string' ? c : '');
    }
    if (typeof c === 'string') {
      if (!c.trim()) return null;
      { const u = unwrap(c); if (u.injected) return { role: 'system', ts, text: clip(u.text, 600) };
        return { role: 'user', ts, text: clip(u.text, SPOKEN_LIMIT) }; }
      return { role: 'user', ts, text: clip(c, SPOKEN_LIMIT) };
    }
    if (Array.isArray(c)) {
      const results = c.filter(b => b && b.type === 'tool_result');
      if (results.length) {
        const body = results.map(r => {
          const rc = r.content;
          if (typeof rc === 'string') return rc;
          if (Array.isArray(rc)) return rc.map(x => (x && x.type === 'text' ? x.text : '')).join('\n');
          return '';
        }).join('\n');
        const forAsk = results[0].tool_use_id || null;
        if (/^\s*(Your questions have been answered|The user answered:)/i.test(body)) {
          const pairs = [];
          const rx = /"(.+?)"="(.*?)"(?=\s*,\s*"|\s*[^"]*$)/gs;
          let m2;
          while ((m2 = rx.exec(body)) !== null) pairs.push({ q: m2[1], a: m2[2] });
          if (pairs.length) return { role: 'answered', ts, pairs, forAsk, forTools: [forAsk].filter(Boolean) };
        }
        if (/^\s*The user did not answer the questions/i.test(body)) {
          return { role: 'answered', ts, pairs: [], dismissed: true, forAsk, forTools: [forAsk].filter(Boolean) };
        }
        return { role: 'result', ts, text: clip(body, 1500), error: !!results[0].is_error,
                 forTools: results.map(r => r.tool_use_id).filter(Boolean) };
      }
      const text = c.filter(b => b && b.type === 'text').map(b => b.text).join('\n');
      if (!text.trim()) return null;
      { const u = unwrap(text); if (u.injected) return { role: 'system', ts, text: clip(u.text, 600) };
        return { role: 'user', ts, text: clip(u.text, SPOKEN_LIMIT) }; }
      return { role: 'user', ts, text: clip(text, SPOKEN_LIMIT) };
    }
    return null;
  }

  if (t === 'assistant') {
    const m = row.message || {};
    const blocks = Array.isArray(m.content) ? m.content : [];
    const out = { role: 'assistant', ts, model: m.model || null, stop: m.stop_reason || null, text: '', thinking: '', tools: [] };
    for (const b of blocks) {
      if (!b) continue;
      if (b.type === 'text') out.text += (out.text ? '\n' : '') + b.text;
      else if (b.type === 'thinking') out.thinking += (out.thinking ? '\n' : '') + (b.thinking || '');
      else if (b.type === 'tool_use' && b.name === 'AskUserQuestion') {
        out.ask = {
          id: b.id || null,
          questions: (((b.input || {}).questions) || []).slice(0, 6).map(q => ({
            header: String(q.header || '').slice(0, 40),
            question: String(q.question || '').slice(0, 400),
            multiSelect: !!q.multiSelect,
            options: (q.options || []).slice(0, 8).map(o => ({
              label: String(o.label || '').slice(0, 80),
              description: String(o.description || '').slice(0, 200),
            })),
          })),
        };
      }
      else if (b.type === 'tool_use') {
        out.tools.push({ id: b.id || null, name: b.name, input: clip(JSON.stringify(b.input || {}), 600),
                         label: stepLabel(b.name, b.input) });
        // A file handed to the user is shown as a player/preview, so its paths travel whole: the
        // clipped input above can cut a long caption's file list in half.
        if (/SendUserFile$/.test(b.name || '') && b.input && Array.isArray(b.input.files)) {
          const t = out.tools[out.tools.length - 1];
          t.files = b.input.files.filter(f => typeof f === 'string').slice(0, 20);
          t.caption = typeof b.input.caption === 'string' ? clip(b.input.caption, 600) : '';
        }
      }
    }
    out.text = clip(out.text, SPOKEN_LIMIT);
    out.thinking = clip(out.thinking, 2000);
    if (!out.text && !out.thinking && !out.tools.length && !out.ask) return null;
    if (m.usage) {
      out.usage = {
        in: (m.usage.input_tokens || 0) + (m.usage.cache_read_input_tokens || 0) + (m.usage.cache_creation_input_tokens || 0),
        out: m.usage.output_tokens || 0,
      };
    }
    return out;
  }

  if (t === 'attachment' && row.attachment) {
    const a = row.attachment;
    if (a.type === 'queued_command' && a.origin && a.origin.kind === 'peer') return peerRow(a.origin, ts, a.prompt);
    if (!USER_ATTACHMENTS.has(a.type)) return null;
    return { role: 'attachment', ts, kind: a.type, text: clip(a.path || a.name || a.filename || a.type, 300) };
  }

  if (t === 'system' && row.content) return { role: 'system', ts, text: clip(row.content, 800) };

  return null;
}

const isSpoken = (m) => m.role === 'user' || m.role === 'peer' || (m.role === 'assistant' && m.text) ||
                        m.role === 'system' || m.role === 'attachment';

const isUser = (m) => m.role === 'user';

function transcript(sess, { limit = 60, minSpoken = 8, minUser = 2, before = null, maxBytes = 512 * 1024 } = {}) {
  const file = transcriptPath(sess);
  if (!file) return { ok: false, error: 'no transcript on disk', messages: [] };

  let size = maxBytes;
  let win, msgs = [], queued = new Map();
  for (let attempt = 0; attempt < 4; attempt++) {
    try { win = readWindow(file, size, before); } catch (e) { return { ok: false, error: e.message, messages: [] }; }
    const lines = win.text.split('\n');
    if (win.truncated) lines.shift();
    msgs = [];
    queued = new Map();
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      let row;
      try { row = JSON.parse(t); } catch { continue; }
      if (row.type === 'queue-operation' && typeof row.content === 'string') {
        if (row.operation === 'enqueue') queued.set(row.content, { ts: row.timestamp || null, taken: false });
        else if (queued.has(row.content)) queued.get(row.content).taken = true;
      }
      const f = flatten(row);
      if (f) msgs.push(f);
    }
    const enough = msgs.length >= limit &&
                   msgs.filter(isSpoken).length >= minSpoken &&
                   msgs.filter(isUser).length >= minUser;
    if (enough || win.start === 0) break;
    size *= 3;
  }

  let kept = msgs;

  {
    const byAsk = new Map();
    for (const m of msgs) if (m.role === 'answered' && m.forAsk) byAsk.set(m.forAsk, m);
    for (const m of msgs) {
      if (m.role !== 'assistant' || !m.ask || !m.ask.id) continue;
      const a = byAsk.get(m.ask.id);
      if (!a) continue;
      m.ask.answers = a.pairs || [];
      m.ask.dismissed = !!a.dismissed;
    }
  }

  {
    const answered = new Set();
    for (const m of msgs) for (const id of (m.forTools || [])) answered.add(id);
    let lastAssistant = -1;
    for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'assistant') { lastAssistant = i; break; }
    msgs.forEach((m, i) => {
      for (const tool of (m.tools || [])) tool.done = i < lastAssistant || (tool.id ? answered.has(tool.id) : true);
    });
  }
  {
    const seen = new Set();
    kept = kept.filter(m => {
      if (m.role !== 'peer') return true;
      const k = m.msgId || ((m.name || '') + '|' + String(m.text || '').slice(0, 80));
      if (seen.has(k)) return false;
      seen.add(k); return true;
    });
  }

  {
    let used = 0;
    for (let i = kept.length - 1; i >= 0; i--) {
      const m = kept[i];
      const len = (m.text || '').length;
      if (used + len <= PAGE_BUDGET) { used += len; continue; }
      if (len > TEXT_LIMIT) m.text = clip(m.text, TEXT_LIMIT);
      used += Math.min(len, TEXT_LIMIT);
    }
  }

  const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const arrived = new Set(msgs.filter(m => m.role === 'user').map(m => norm(m.text)));

  const extras = [...queued.entries()]
    .map(([text, info]) => ({ u: unwrap(text), info }))
    .filter(({ u }) => !u.injected)
    .filter(({ u }) => !arrived.has(norm(u.text)))
    .map(({ u, info }) => ({ role: 'user', queued: !info.taken, ts: info.ts, text: clip(u.text) }))
    .filter(m => m.ts);

  for (const m of extras) {
    const inWindow = kept.length && m.ts >= (kept[0].ts || '') ;
    if (!inWindow && before !== null) continue;
    let at = kept.findIndex(x => (x.ts || '') > m.ts);
    if (at < 0) at = kept.length;
    kept.splice(at, 0, m);
  }
  return {
    ok: true,
    file,
    size: win.total,
    startByte: win.start,
    hasMore: win.start > 0,
    truncated: win.truncated,
    messages: kept,
  };
}

function backgroundTasks(sess) {
  const file = transcriptPath(sess);
  if (!file) return [];

  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }

  const launched = new Map();
  const finished = new Map();
  const idRx = /<tool-use-id>(toolu_[A-Za-z0-9]+)<\/tool-use-id>/g;
  const statusRx = /<status>(\w+)<\/status>/;

  for (const line of text.split('\n')) {
    if (!line.includes('run_in_background') && !line.includes('tool-use-id')) continue;
    const t = line.trim();
    if (!t) continue;
    let row;
    try { row = JSON.parse(t); } catch { continue; }

    const content = row.message && row.message.content;
    if (Array.isArray(content)) {
      for (const b of content) {
        if (!b || b.type !== 'tool_use' || !b.id) continue;
        const inp = b.input || {};
        if (!inp.run_in_background) continue;
        launched.set(b.id, {
          id: b.id,
          name: b.name,
          description: String(inp.description || inp.command || inp.prompt || b.name).slice(0, 120),
          startedAt: row.timestamp || null,
        });
      }
    }
    if (t.includes('task-notification') || t.includes('<tool-use-id>')) {
      const st = (t.match(statusRx) || [])[1] || 'completed';
      let m;
      idRx.lastIndex = 0;
      while ((m = idRx.exec(t))) finished.set(m[1], st);
    }
  }

  const out = [];
  for (const [id, info] of launched) {
    if (finished.has(id)) continue;
    if (info.name !== 'Agent' && info.name !== 'Task') continue;
    out.push(info);
  }
  return out;
}

function pendingChips(sess, allSessions, { maxBytes = 2 * 1024 * 1024 } = {}) {
  const file = transcriptPath(sess);
  if (!file) return [];
  let win;
  try { win = readWindow(file, maxBytes, null); } catch { return []; }

  const norm = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const started = new Set((allSessions || []).map(x => norm(x.title)).filter(Boolean));

  const seen = new Map();
  for (const line of win.text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let row;
    try { row = JSON.parse(t); } catch { continue; }
    const content = row.message && row.message.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (!b || b.type !== 'tool_use') continue;
      const nm = String(b.name || '');
      if (/dismiss_task$/i.test(nm)) {
        const dt = String((b.input || {}).title || '').trim();
        if (dt) seen.delete(norm(dt));
        continue;
      }
      if (!/spawn_task$/i.test(nm)) continue;
      const title = String((b.input || {}).title || '').trim();
      if (!title) continue;
      seen.set(norm(title), { title, ts: row.timestamp || null });
    }
  }
  return [...seen.entries()].filter(([k]) => !started.has(k)).map(([, v]) => v);
}

function pendingQuestion(sess, { maxBytes = 2 * 1024 * 1024 } = {}) {
  const file = transcriptPath(sess);
  if (!file) return null;
  let win;
  try { win = readWindow(file, maxBytes, null); } catch { return null; }
  const asks = new Map(), answered = new Set();
  for (const line of win.text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let row;
    try { row = JSON.parse(t); } catch { continue; }
    const content = row.message && row.message.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'tool_use' && b.name === 'AskUserQuestion' && b.id) asks.set(b.id, b.input || {});
      if (b.type === 'tool_result' && b.tool_use_id) answered.add(b.tool_use_id);
    }
  }
  let out = null;
  for (const [id, input] of asks) {
    if (answered.has(id)) continue;
    const qs = Array.isArray(input.questions) ? input.questions : [];
    if (qs.length) out = { id, questions: qs };
  }
  return out;
}

function transcriptStamp(sess) {
  const file = transcriptPath(sess);
  if (!file) return null;
  try { const st = fs.statSync(file); return st.size + ':' + st.mtimeMs; } catch { return null; }
}

async function searchTranscripts(query, { limit = 30, maxSessions = 250, tailBytes: tb = 400 * 1024,
                                          deadlineMs = 7000, list = null } = {}) {
  const q = String(query || '').trim().toLowerCase();
  if (q.length < 3) return { ok: false, error: 'query must be at least 3 characters', hits: [] };

  const started = Date.now();
  const pool = (list || index().list).filter(s => s.cliSessionId).slice(0, maxSessions);
  const hits = [];
  let scanned = 0, truncated = false;

  await mapLimit(pool, 12, async (sess) => {
    if (hits.length >= limit || Date.now() - started > deadlineMs) { truncated = true; return; }
    const file = transcriptPath(sess);
    if (!file) return;
    let text;
    try {
      const st = await fs.promises.stat(file);
      const start = Math.max(0, st.size - tb);
      const fh = await fs.promises.open(file, 'r');
      try {
        const buf = Buffer.allocUnsafe(st.size - start);
        await fh.read(buf, 0, buf.length, start);
        text = buf.toString('utf8');
      } finally { await fh.close(); }
    } catch { return; }
    scanned++;
    const at = text.toLowerCase().indexOf(q);
    if (at < 0) return;
    const from = Math.max(0, at - 90);
    let snippet = text.slice(from, at + q.length + 130)
      .replace(/\[nrt]/g, ' ').replace(/\\"/g, '"').replace(/\s+/g, ' ').trim();
    hits.push({ id: sess.id, title: sess.title, cwd: sess.cwd, at: sess.lastActivityAt, snippet });
  });

  hits.sort((a, b) => b.at - a.at);
  return { ok: true, hits: hits.slice(0, limit), scanned, truncated, ms: Date.now() - started };
}

/* Find text inside ONE session, across its whole transcript (g784): what he said, what peers said,
   and the replies -- never tool input or output. Each hit carries the byte where its line starts, so
   the app can page older history in until that hit is loaded. Oldest first. */
async function searchSession(sess, query, { limit = 500, deadlineMs = 8000 } = {}) {
  const q = String(query || '').trim().toLowerCase();
  if (q.length < 2) return { ok: false, error: 'query must be at least 2 characters', hits: [] };
  const file = transcriptPath(sess);
  if (!file) return { ok: false, error: 'no transcript on disk', hits: [] };
  const started = Date.now();
  const hits = [];
  let occurrences = 0, truncated = false, pos = 0, rest = Buffer.alloc(0);
  const scan = (buf, base) => {
    let from = 0;
    for (;;) {
      const nl = buf.indexOf(10, from);
      if (nl < 0) return from;
      const lineStart = base + from;
      const line = buf.toString('utf8', from, nl);
      from = nl + 1;
      if (!line.toLowerCase().includes(q)) continue;      // cheap prefilter on the raw line
      let row; try { row = JSON.parse(line); } catch { continue; }
      const f = flatten(row);
      if (!f || !(f.role === 'user' || f.role === 'peer' || (f.role === 'assistant' && f.text))) continue;
      const text = String(f.text || '');
      const low = text.toLowerCase();
      let at = low.indexOf(q), n = 0;
      if (at < 0) continue;
      const first = at;
      while (at >= 0) { n++; at = low.indexOf(q, at + q.length); }
      occurrences += n;
      if (hits.length < limit) {
        const a = Math.max(0, first - 60);
        hits.push({ ts: f.ts || null, role: f.role, byte: lineStart, n,
                    snippet: (a ? '…' : '') + text.slice(a, first + q.length + 90).replace(/\s+/g, ' ').trim() });
      } else truncated = true;
    }
  };
  let fh;
  try {
    fh = await fs.promises.open(file, 'r');
    const chunk = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      if (Date.now() - started > deadlineMs) { truncated = true; break; }
      const { bytesRead } = await fh.read(chunk, 0, chunk.length, pos);
      if (!bytesRead) break;
      const buf = Buffer.concat([rest, chunk.subarray(0, bytesRead)]);
      const base = pos - rest.length;
      const used = scan(buf, base);
      rest = Buffer.from(buf.subarray(used));
      pos += bytesRead;
    }
    if (rest.length) scan(Buffer.concat([rest, Buffer.from([10])]), pos - rest.length);
  } catch (e) { return { ok: false, error: e.message, hits: [] }; }
  finally { if (fh) await fh.close().catch(() => {}); }
  return { ok: true, q, hits, occurrences, truncated, ms: Date.now() - started };
}

module.exports = { unwrapForTest: unwrap,
  refresh, index, get, decorate, folders, transcript, pendingQuestion, pendingChips, backgroundTasks, transcriptStamp, transcriptPath, slugFor,
  searchTranscripts, searchSession,
  STORE, PROJECTS,
};
