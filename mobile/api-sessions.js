'use strict';
// API sessions — Desktop sessions that answer a program, not a person (the claude-api service, g1871: one
// session per client app). Ashwar 14-Oct-2026: "the things like API session, these should not show up ... as a
// notification all the time. And maybe when we have the ability to hide other user sessions, we can also have
// the ability to hide API session."
//
// A session is an API session when either
//   - its id is a `session` in the claude-api state file (~/.claude/ago/state/claude-api/sessions.json, or
//     settings.apiSessions.stateFile) or a key of api-sessions.json beside it — the service's own records, or
//   - its title starts "API:" or "API ·" — the title the service gives the sessions it starts (catches older
//     days' sessions that the state file no longer names).
// They never raise an alert, a push or an unread/awaiting dot (mobile/sessions.js decorate), and the phone's
// "API" chip shows / folds / hides them (hidden by default).
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('../lib/config');

const TITLE_RX = /^\s*API\s*[:·]/;
let cache = {};

function stateFile() {
  const s = (config.get().apiSessions || {}).stateFile;
  return s || path.join(os.homedir(), '.claude', 'ago', 'state', 'claude-api', 'sessions.json');
}

function readIds(file) {
  let st;
  try { st = fs.statSync(file); } catch { return new Set(); }
  const c = cache[file];
  if (c && c.mtime === st.mtimeMs) return c.ids;
  const out = new Set();
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
    for (const [k, v] of Object.entries(j)) {
      if (v && typeof v.session === 'string') out.add(v.session);   // sessions.json: {app: {session}}
      if (/^local_/.test(k)) out.add(k);                              // api-sessions.json: {sessionId: {app,title}}
    }
  } catch { return c ? c.ids : out; }   // a half-written file: keep the last good set
  cache[file] = { mtime: st.mtimeMs, ids: out };
  return out;
}

function ids() {
  const out = new Set();
  for (const f of [stateFile(), path.join(path.dirname(stateFile()), 'api-sessions.json')]) for (const i of readIds(f)) out.add(i);
  return out;
}

function isApi(s) {
  if (!s) return false;
  return ids().has(s.id) || TITLE_RX.test(String(s.title || ''));
}

module.exports = { isApi, ids, stateFile, TITLE_RX, _reset() { cache = {}; } };
