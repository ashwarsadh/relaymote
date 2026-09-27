// tier-policy.js — the model and effort a session runs on, applied before Relaymote wakes or starts it.
//
// Three rules (the user, g551):
//   1. A model/effort the USER changed by hand is respected for settings.tierOverrideHours (default 4).
//      After that Relaymote may put the default (Settings › New session) back.
//   2. settings.tierBeforeWake (on by default): before Relaymote wakes an existing session, the session is
//      switched to the default, honouring rule 1.
//   3. Every session Relaymote starts gets the default BEFORE its first prompt (spawns, chips, the phone).
//
// How a hand change is told apart from Relaymote's own: every change Relaymote makes is recorded here as
// by:'baton'. Whenever a session's tier is read and it differs from the last record, somebody else changed
// it: that is recorded as by:'user' with the time it was first seen (a change is never older than that, so
// it is respected for at least the full window). A session never seen before has no record, so it counts
// as an old setting, and the default may be applied.
'use strict';
const fs = require('fs');
const path = require('path');
const config = require('./config');

const file = () => path.join(config.STATE, 'tier-seen.json');
const HOUR = 3600000;

function load() { try { return JSON.parse(fs.readFileSync(file(), 'utf8')) || {}; } catch { return {}; } }
function save(all) { try { fs.writeFileSync(file(), JSON.stringify(all, null, 2)); } catch {} }

const norm = v => String(v == null ? '' : v).trim().toLowerCase();
const sameTier = (a, b) => norm(a && a.model) === norm(b && b.model) && norm(a && a.effort) === norm(b && b.effort);

/** The default every Relaymote-started or Relaymote-woken session should carry. Blank fields mean "leave it". */
function defaults(settings = config.get()) {
  const n = settings.newSession || {};
  return { model: String(n.model || '').trim(), effort: String(n.effort || '').trim() };
}

function overrideHours(settings = config.get()) {
  const h = Number(settings.tierOverrideHours);
  return Number.isFinite(h) && h >= 0 ? h : 4;
}

/** Record a tier Relaymote itself set (never counted as the user's). */
function recordBaton(sessionId, tier, now = Date.now()) {
  if (!sessionId) return;
  const all = load();
  all[sessionId] = { model: tier.model || (all[sessionId] || {}).model || '', effort: tier.effort || (all[sessionId] || {}).effort || '', by: 'baton', at: now };
  save(all);
}

/** Record a tier the user set by hand (e.g. from the phone). */
function recordUser(sessionId, tier, now = Date.now()) {
  if (!sessionId) return;
  const all = load(); const prev = all[sessionId] || {};
  all[sessionId] = { model: tier.model || prev.model || '', effort: tier.effort || prev.effort || '', by: 'user', at: now };
  save(all);
}

/** Compare what the session carries now with the last record; a difference is a hand change, first seen now. */
function observe(sessionId, current, now = Date.now()) {
  const all = load(); const rec = all[sessionId];
  if (!rec) { all[sessionId] = { model: current.model || '', effort: current.effort || '', by: 'seen', at: now }; save(all); return all[sessionId]; }
  if (!sameTier(rec, current)) { all[sessionId] = { model: current.model || '', effort: current.effort || '', by: 'user', at: now }; save(all); }
  return all[sessionId];
}

/**
 * What to change, as a pure decision. Returns { apply: {model?, effort?}, skip?: 'MANUAL_OVERRIDE'|'NO_DEFAULT'|'ALREADY', until? }.
 */
function decide({ current, record, want, now = Date.now(), hours = 4 }) {
  if (!want.model && !want.effort) return { apply: {}, skip: 'NO_DEFAULT' };
  if (record && record.by === 'user' && now - record.at < hours * HOUR) {
    return { apply: {}, skip: 'MANUAL_OVERRIDE', until: new Date(record.at + hours * HOUR).toISOString() };
  }
  const apply = {};
  if (want.model && norm(want.model) !== norm(current.model)) apply.model = want.model;
  if (want.effort && norm(want.effort) !== norm(current.effort)) apply.effort = want.effort;
  return Object.keys(apply).length ? { apply } : { apply, skip: 'ALREADY' };
}

let DESK = null;
const desk = () => DESK || require('./desktop');
function _setDesktop(d) { const p = DESK; DESK = d; return p; }

/**
 * Before a wake: bring an existing session to the default, unless the user changed it within the window.
 * Never throws and never blocks the wake: every failure is returned as a reason.
 */
async function beforeWake(sessionId, opts = {}) {
  const settings = opts.settings || config.get();
  if (settings.tierBeforeWake === false) return { ok: true, skipped: 'SETTING_OFF' };
  const want = defaults(settings);
  if (!want.model && !want.effort) return { ok: true, skipped: 'NO_DEFAULT' };
  try {
    const cur = await desk().readTier(sessionId);
    if (!cur || !cur.ok) return { ok: false, skipped: 'UNREADABLE', error: cur && cur.error };
    const now = opts.now || Date.now();
    const record = observe(sessionId, cur, now);
    const d = decide({ current: cur, record, want, now, hours: overrideHours(settings) });
    if (d.skip) return { ok: true, skipped: d.skip, until: d.until };
    return await applyTier(sessionId, d.apply);
  } catch (e) { return { ok: false, skipped: 'ERROR', error: String(e && e.message || e) }; }
}

/** Set model and/or effort through the background bridge only (no UI, no dialog), and record it as Relaymote's. */
async function applyTier(sessionId, tier) {
  const out = { ok: true, sessionId, applied: {} };
  if (tier.model) {
    const r = await desk().setTierBackground('model', sessionId, tier.model);
    if (r && r.ok) out.applied.model = tier.model; else { out.ok = false; out.modelError = r && r.error; }
  }
  if (tier.effort) {
    const r = await desk().setTierBackground('effort', sessionId, tier.effort);
    if (r && r.ok) out.applied.effort = tier.effort; else { out.ok = false; out.effortError = r && r.error; }
  }
  if (out.applied.model || out.applied.effort) {
    const cur = await desk().readTier(sessionId).catch(() => null);
    recordBaton(sessionId, cur && cur.ok ? cur : out.applied);
  }
  return out;
}

/**
 * Chips inherit the model and effort of the session that starts them. So: put the starter on the default,
 * start, give the new session the default too, then put the starter back exactly as it was.
 */
async function withStarterTier(starterId, start, opts = {}) {
  const want = defaults(opts.settings || config.get());
  if ((!want.model && !want.effort) || !starterId) return start();
  let before = null;
  const rec = load()[starterId];   // the starter's own history (a hand change stays a hand change)
  try { before = await desk().readTier(starterId); } catch {}
  if (before && before.ok) await applyTier(starterId, want).catch(() => {});
  let r;
  try { r = await start(); }
  finally {
    if (before && before.ok) {
      await applyTier(starterId, { model: before.model, effort: before.effort }).catch(() => {});
      const all = load(); if (rec) all[starterId] = rec; else delete all[starterId]; save(all);
    }
  }
  const started = r && (r.startedSessionId || (Array.isArray(r.results) ? r.results.map(x => x.startedSessionId).filter(Boolean) : null));
  for (const id of [].concat(started || [])) await applyTier(id, want).catch(() => {});
  return r;
}

module.exports = { defaults, overrideHours, decide, observe, recordBaton, recordUser, beforeWake, applyTier, withStarterTier, sameTier, _setDesktop, file };
