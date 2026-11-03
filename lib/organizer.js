// organizer.js — put each new, ungrouped session into its project's sidebar group.
//
// Only sessions Claude Desktop reports as UNGROUPED are touched; a session the user has placed in any
// group is never moved. The caller runs tick() inside the serialised UI lane; each move is also
// gated on the user being idle, and a batch stops at the first sign the Desktop is unreachable.
'use strict';
const fs = require('fs');
const path = require('path');
const config = require('./config');

const DEFAULTS = { autoGroup: true, groupBy: 'project', rename: {}, batch: 10, minAgeMs: 2 * 60000 };
const LOG = () => path.join(config.STATE, 'organizer.log');
const STATE_FILE = () => path.join(config.STATE, 'organizer-state.json');
const RETRY_MS = 60 * 60000, MOVED_MEMORY_MS = 24 * 3600000, MAX_FAILS = 3;
// 03-Nov-2026: ten moves at ~30 s each (a NO_SUCH_SESSION lookup walks every group) held the UI lane for the
// full 300 s cap every 5 min, so phone sends queued behind it timed out and were re-delivered minutes late.
// A pass now yields the lane after BUDGET_MS, and a session the sidebar does not have is not retried.
const BUDGET_MS = 60000, FINAL_ERRORS = new Set(['NO_SUCH_SESSION']);

function settings() { return { ...DEFAULTS, ...(config.get().organizer || {}) }; }
function log(line) { try { fs.appendFileSync(LOG(), `[${new Date().toISOString()}] ${line}\n`); } catch {} }
function readState() { try { return JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8')) || {}; } catch { return {}; } }
function writeState(st) {
  try { const tmp = STATE_FILE() + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(st, null, 1)); fs.renameSync(tmp, STATE_FILE()); } catch {}
}

/** The group a project's sessions go into: the rename map, else the group its other sessions already use, else its name. */
function groupFor(project, cfg) {
  const r = (cfg.rename || {})[project.name];
  if (r && String(r).trim()) return String(r).trim();
  return project.group || project.name;
}

/** Sessions the organizer would move now, oldest first, with their target group. */
function plan(ix, cfg = settings(), st = readState(), now = Date.now()) {
  const out = [];
  if (!ix || !ix.sessions) return out;
  for (const s of Object.values(ix.sessions)) {
    if (s.archived || !s.project || !s.groupKnown || s.group) continue;
    const p = ix.projects[s.project];
    if (!p) continue;
    const born = s.createdAt || s.lastActivityAt || 0;
    if (born && now - born < cfg.minAgeMs) continue;
    const a = (st.attempts || {})[s.id];
    if (a && a.movedAt && now - Date.parse(a.movedAt) < MOVED_MEMORY_MS) continue;
    if (a && a.fails >= MAX_FAILS) continue;
    if (a && a.failedAt && now - Date.parse(a.failedAt) < RETRY_MS) continue;
    out.push({ sessionId: s.id, title: s.title, project: p.name, group: groupFor(p, cfg), born });
  }
  return out.sort((a, b) => a.born - b.born);
}

/**
 * One pass. deps: { index, setGroup(id, group, {create}), isIdle() } — setGroup is lib/desktop's.
 * Returns { moved, failed, skipped, considered }.
 */
async function tick(deps = {}) {
  const cfg = settings();
  const res = { moved: [], failed: [], skipped: null, considered: 0 };
  if (!config.mod('organizer')) { res.skipped = 'module off'; return res; }
  if (!cfg.autoGroup) { res.skipped = 'autoGroup off'; return res; }
  if (cfg.groupBy !== 'project') { res.skipped = 'groupBy ' + cfg.groupBy + ' not supported'; return res; }
  const ix = deps.index || await require('./projects').build();
  if (!ix.groupSource) { res.skipped = 'group assignments unreadable'; return res; }
  const st = readState();
  st.attempts = st.attempts || {};
  const todo = plan(ix, cfg, st);
  res.considered = todo.length;
  const limit = Math.max(0, Number(deps.limit != null ? deps.limit : cfg.batch) || 0);
  const setGroup = deps.setGroup || require('./desktop').setGroup;
  const isIdle = deps.isIdle || (() => require('./idle').isIdle(config.get().idleGateSeconds * 1000));
  const budget = deps.budgetMs != null ? deps.budgetMs : BUDGET_MS;
  const t0 = Date.now();
  for (const t of todo.slice(0, limit)) {
    if (!isIdle()) { res.skipped = 'user active'; break; }
    if (Date.now() - t0 >= budget) { res.skipped = 'time budget'; break; }
    let r;
    try { r = await setGroup(t.sessionId, t.group, { create: true }); }
    catch (e) {
      log(`stopped: ${t.sessionId} -> "${t.group}" threw ${e.message} (Desktop unreachable?)`);
      res.skipped = 'desktop unreachable: ' + e.message;
      break;
    }
    const a = st.attempts[t.sessionId] || {};
    if (r && r.ok) {
      st.attempts[t.sessionId] = { movedAt: new Date().toISOString(), group: t.group };
      res.moved.push({ sessionId: t.sessionId, group: t.group, project: t.project, unchanged: !!r.unchanged });
      log(`moved ${t.sessionId} "${String(t.title).slice(0, 60)}" -> "${t.group}" (project ${t.project})${r.unchanged ? ' [already there]' : ''}`);
    } else {
      const err = (r && (r.error || r.message)) || 'no result';
      const fails = FINAL_ERRORS.has(err) ? MAX_FAILS : (a.fails || 0) + 1;
      st.attempts[t.sessionId] = { fails, failedAt: new Date().toISOString(), error: err };
      res.failed.push({ sessionId: t.sessionId, group: t.group, error: err });
      log(`FAILED ${t.sessionId} "${String(t.title).slice(0, 60)}" -> "${t.group}": ${err}`);
    }
    writeState(st);   // a pass cut off by the UI-lane cap still keeps what it learnt
  }
  const cut = Date.now() - 7 * 86400000;
  for (const [id, a] of Object.entries(st.attempts)) if (Date.parse(a.movedAt || a.failedAt || 0) < cut) delete st.attempts[id];
  writeState(st);
  return res;
}

module.exports = { tick, plan, groupFor, settings, DEFAULTS, LOG, BUDGET_MS };
