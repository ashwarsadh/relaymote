'use strict';
// API sessions — Desktop sessions that answer a program, not a person (the claude-api service, g1871: one
// session per client app). Ashwar 14-Oct-2026: "the things like API session, these should not show up ... as a
// notification all the time. And maybe when we have the ability to hide other user sessions, we can also have
// the ability to hide API session."
//
// A session is an API session when either
//   - its id is a `session` in the claude-api state file (~/.claude/ago/state/claude-api/sessions.json, or
//     settings.apiSessions.stateFile) — the service's own record of the session it drives per app, or
//   - its title starts "API:" or "API ·" — the title the service gives the sessions it starts (catches older
//     days' sessions that the state file no longer names).
// They never raise an alert, a push or an unread/awaiting dot (mobile/sessions.js decorate), and the phone's
// "API" chip shows / folds / hides them (hidden by default).
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('../lib/config');

const TITLE_RX = /^\s*API\s*[:·]/;
let cache = { file: '', mtime: -1, ids: new Set() };

function stateFile() {
  const s = (config.get().apiSessions || {}).stateFile;
  return s || path.join(os.homedir(), '.claude', 'ago', 'state', 'claude-api', 'sessions.json');
}

function ids() {
  const file = stateFile();
  let st;
  try { st = fs.statSync(file); } catch { return cache.file === file ? cache.ids : new Set(); }
  if (cache.file === file && cache.mtime === st.mtimeMs) return cache.ids;
  const out = new Set();
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
    for (const v of Object.values(j)) if (v && typeof v.session === 'string') out.add(v.session);
  } catch { return cache.ids; }          // a half-written file: keep the last good set
  cache = { file, mtime: st.mtimeMs, ids: out };
  return out;
}

function isApi(s) {
  if (!s) return false;
  return ids().has(s.id) || TITLE_RX.test(String(s.title || ''));
}

module.exports = { isApi, ids, stateFile, TITLE_RX, _reset() { cache = { file: '', mtime: -1, ids: new Set() }; } };
