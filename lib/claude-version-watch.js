'use strict';
// Claude Desktop / Claude Code version watch (Ashwar 21-Oct-2026: "Cloud has updated. See if there are any
// breaking changes ... if anything needs to be updated in the Relay mode, we can also do so automatically").
//
// Desktop 3.1623.0 (from 2.42304.2) moved screen-reader-only status text INSIDE each sidebar row's button, and
// 404 of 473 session titles read "Sagar Conductor Awaiting input" until lib/desktop.js learned it. Nothing told
// him. Now: when the Desktop or bundled Claude Code version changes, run a LIVE check of the surfaces Relaymote
// reads from Claude, and push him the result once — "OK" or the exact problem.
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('./config');

const FILE = path.join(config.STATE, 'claude-versions.json');
const LOCAL = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const ROAMING = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
// Transcript record types Relaymote knows (mobile/sessions.js flatten + the ones it skips on purpose).
const KNOWN_TYPES = new Set(['user', 'assistant', 'system', 'summary', 'attachment', 'queue-operation', 'file-history-snapshot',
  'progress', 'custom-title', 'ai-title', 'tag', 'last-prompt', 'mode', 'agent-name', 'permission-mode', 'pr-link',
  // Claude Code 2.1.300+ ("transcripts record each API request") and the others seen on 2.1.304 (21-Oct), all skipped:
  'api-request', 'api-request-shape', 'api-request-blob', 'bridge-session', 'atis-latch', 'file-history-delta', 'cost-state']);
// What a row title must never carry (Desktop 3.x sr-only text).
const POLLUTED = /\s(Awaiting input|Unread response|Started (from|by) .*)$/;

const cmpVer = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; } return 0; };
const newest = (names) => names.filter(n => /^\d+(\.\d+)+$/.test(n)).sort(cmpVer).pop() || null;

/** The versions installed now: Desktop (newest app-* folder) and the Claude Code it bundles (newest folder). */
function versions(dirs = {}) {
  const deskDir = dirs.desktop || path.join(LOCAL, 'AnthropicClaude');
  const codeDir = dirs.code || path.join(ROAMING, 'Claude', 'claude-code');
  let desktop = null, code = null;
  try { desktop = newest(fs.readdirSync(deskDir).filter(n => n.startsWith('app-')).map(n => n.slice(4))); } catch {}
  try { code = newest(fs.readdirSync(codeDir)); } catch {}
  return { desktop, code };
}

function load() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return null; } }
function save(s) { try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(s, null, 1)); } catch {} }

/** Record types in the newest transcript's tail that Relaymote does not know (new ones are reported, not failed). */
function transcriptTypes(projectsDir = path.join(os.homedir(), '.claude', 'projects')) {
  let best = null;
  try {
    for (const d of fs.readdirSync(projectsDir)) {
      let files; try { files = fs.readdirSync(path.join(projectsDir, d)); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const p = path.join(projectsDir, d, f);
        let st; try { st = fs.statSync(p); } catch { continue; }
        if (!best || st.mtimeMs > best.m) best = { p, m: st.mtimeMs, size: st.size };
      }
    }
  } catch { return { ok: false, why: 'no transcripts folder' }; }
  if (!best) return { ok: false, why: 'no transcript found' };
  const n = Math.min(best.size, 2 * 1024 * 1024), buf = Buffer.alloc(n), fd = fs.openSync(best.p, 'r');
  try { fs.readSync(fd, buf, 0, n, best.size - n); } finally { fs.closeSync(fd); }
  const unknown = new Map(); let parsed = 0, versionSeen = null;
  for (const l of buf.toString('utf8').split('\n').slice(best.size > n ? 1 : 0)) {
    if (!l.trim()) continue;
    let d; try { d = JSON.parse(l); } catch { continue; }
    parsed++;
    if (d.version) versionSeen = d.version;
    if (d.type && !KNOWN_TYPES.has(d.type)) unknown.set(d.type, (unknown.get(d.type) || 0) + 1);
  }
  return { ok: parsed > 0, parsed, unknown: [...unknown.entries()], version: versionSeen, file: path.basename(best.p) };
}

/**
 * The live check. deps.scrape() = lib/desktop.scrapeSidebar, deps.cdp() = cdpAvailable. Each problem is a sentence
 * he can act on (or a lane can); notes are changes that need no action.
 */
async function check(deps) {
  const problems = [], notes = [];
  let cdp = false;
  try { cdp = await deps.cdp(); } catch {}
  if (!cdp) problems.push('Relaymote cannot reach Claude Desktop (debugger link down) — it may still be starting');
  else {
    try {
      const r = await deps.scrape();
      const rows = r.sessions || [];
      if (!rows.length) problems.push('the Code tab sidebar read 0 sessions — Desktop changed its session list');
      const bad = rows.filter(x => POLLUTED.test(x.title || ''));
      if (bad.length) problems.push(`${bad.length} of ${rows.length} session titles carry status text ("${bad[0].title.slice(0, 50)}") — the sidebar row layout changed`);
      const withStatus = rows.filter(x => x.status).length;
      if (rows.length >= 20 && !withStatus) problems.push('no session shows a status (running / awaiting input / unread) — the status labels changed');
      if (rows.length) notes.push(`sidebar ${rows.length} sessions, ${withStatus} with a status`);
    } catch (e) { problems.push('reading the Code tab sidebar failed: ' + e.message); }
  }
  const t = transcriptTypes(deps.projectsDir);
  if (!t.ok) problems.push('transcripts: ' + (t.why || 'nothing parsed'));
  else if (t.unknown.length) notes.push('new transcript record types (skipped safely): ' + t.unknown.map(([k, n]) => `${k}×${n}`).join(', '));
  return { ok: !problems.length, problems, notes };
}

/** Every few minutes from server.js. First sight only records; a change runs check() and alerts once. */
async function tick(deps) {
  const now = versions(deps.dirs);
  if (!now.desktop && !now.code) return null;
  const was = load();
  if (!was) { save({ ...now, at: new Date().toISOString(), checked: null }); return { first: true, now }; }
  if (was.desktop === now.desktop && was.code === now.code && !was.pending) return null;
  const r = await check(deps);
  // Desktop just restarted: give it a few ticks to come up before calling an unreachable debugger a problem.
  if (!r.ok && r.problems.every(p => /debugger link down/.test(p)) && (was.pendingTries || 0) < 6) {
    save({ ...was, pending: now, pendingTries: (was.pendingTries || 0) + 1 }); return { waiting: true };
  }
  const change = [was.desktop !== now.desktop ? `Desktop ${was.desktop} → ${now.desktop}` : null,
                  was.code !== now.code ? `Claude Code ${was.code} → ${now.code}` : null].filter(Boolean).join(', ') || 'versions unchanged';
  const msg = r.ok ? `Relaymote checked it: everything it reads from Claude works.${r.notes.length ? ' (' + r.notes.join('; ') + ')' : ''}`
                   : `Relaymote found ${r.problems.length} problem(s): ${r.problems.join('; ')}. A lane must update Relaymote.`;
  const evt = { kind: 'health', title: `Claude updated: ${change}`.slice(0, 120), body: msg.slice(0, 600), tag: 'claude-version', url: '/' };
  let sent = null;
  try { sent = await deps.alert(evt); } catch (e) { sent = { error: e.message }; }
  save({ ...now, at: new Date().toISOString(), checked: { ok: r.ok, problems: r.problems, notes: r.notes, change } });
  if (deps.log) deps.log(`claude version: ${change} — ${r.ok ? 'OK' : 'PROBLEMS: ' + r.problems.join(' | ')}${r.notes.length ? ' [' + r.notes.join('; ') + ']' : ''}`);
  return { changed: true, change, ...r, sent };
}

module.exports = { versions, check, tick, transcriptTypes, POLLUTED, KNOWN_TYPES, _file: () => FILE };
