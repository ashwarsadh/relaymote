// live-settings.js — Settings › Now: what is ACTUALLY set right now, read from the files that hold it.
//
// Ashwar 17-Oct: "the settings which were done by you or the agent changing things ... should reflect in
// the menu also ... so we can understand what is the current settings." The Modules switches showed
// Relaymote's own goal chaser OFF while the Conductor's chaser ran at full speed from goals-config.json.
// So nothing here comes from DEFAULTS or a cache: every value is read from its source file on each
// request, an absent key is shown as "default" (never as a set value), and an unreadable file says so.
//
// Who / when: config.set(patch, by) appends each change to state/settings-audit.jsonl. Files that agents
// or Ashwar edit by hand (settings.json itself, goals-config.json, wake_gate.config.json,
// last-conductor.txt, principals.json) are diffed against a snapshot here; a change nobody announced
// is recorded as "edited on disk" at the file's mtime. Times go out as ISO; the phone shows IST.
'use strict';
const fs = require('fs');
const path = require('path');
const config = require('./config');

const AUDIT = () => path.join(config.STATE, 'settings-audit.jsonl');
const SEEN = () => path.join(config.STATE, 'settings-seen.json');
const conductorDir = () => process.env.RELAYMOTE_CONDUCTOR_DIR
  || (config.get().board || {}).dir || path.join(config.CLAUDE_HOME, 'conductor');
const agoState = () => process.env.RELAYMOTE_AGO_STATE || path.join(config.CLAUDE_HOME, 'ago', 'state');

// Wake-gate defaults, as ~/.claude/hooks/wake-gate.py applies them when its config file leaves a key out.
const WAKE_DEFAULTS = { hold_cold: true, hold_hours: 2 };
// Leaves of principals.json worth tracking; the rest (role cards, power lists) is not a setting he flips.
const PRINCIPAL_LEAVES = /^principals\.[^.]+\.(name|enabled|sees|conductor|admin)$|^default$/;

function stat(f) { try { return fs.statSync(f); } catch { return null; } }
function readJson(f) {
  const st = stat(f);
  if (!st) return { missing: true, file: f };
  try { return { json: JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')), mtime: st.mtimeMs, file: f }; }
  catch (e) { return { error: e.message, mtime: st.mtimeMs, file: f }; }
}
function readText(f) {
  const st = stat(f);
  if (!st) return { missing: true, file: f };
  try { return { text: fs.readFileSync(f, 'utf8').trim(), mtime: st.mtimeMs, file: f }; } catch (e) { return { error: e.message, file: f }; }
}
/** The last `bytes` of a file, split into whole lines. */
function tailLines(f, bytes = 262144) {
  const st = stat(f);
  if (!st) return [];
  const fd = fs.openSync(f, 'r');
  try {
    const len = Math.min(bytes, st.size), buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    const lines = buf.toString('utf8').split(/\r?\n/);
    if (len < st.size) lines.shift(); // a partial first line
    return lines.filter(Boolean);
  } finally { fs.closeSync(fd); }
}
function jsonl(f, bytes) { return tailLines(f, bytes).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); }

/** {a:{b:1}} -> {'a.b': 1}; arrays are one value. */
function flatten(o, pre = '', out = {}) {
  for (const [k, v] of Object.entries(o || {})) {
    const key = pre ? pre + '.' + k : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = v;
  }
  return out;
}
function diff(before, after) {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  const out = [];
  for (const k of keys) {
    const a = before ? before[k] : undefined, b = after ? after[k] : undefined;
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ k, from: a === undefined ? null : a, to: b === undefined ? null : b });
  }
  return out;
}

function append(row) {
  try { fs.mkdirSync(config.STATE, { recursive: true }); fs.appendFileSync(AUDIT(), JSON.stringify(row) + '\n'); } catch {}
}

/** Called by config.set: the change and who asked for it. */
function recordSet(before, after, by) {
  const changes = diff(flatten(before), flatten(after));
  if (changes.length) append({ at: new Date().toISOString(), by: by || 'unknown', file: 'settings.json', changes });
}

// The files watched for hand/agent edits, and how each is turned into flat keys.
function watched() {
  const cd = conductorDir();
  return [
    { id: 'settings.json', file: config.SETTINGS_FILE, flat: j => flatten(j) },
    { id: 'goals-config.json', file: path.join(cd, 'goals-config.json'), flat: j => flatten(j) },
    { id: 'wake_gate.config.json', file: path.join(cd, 'wake_gate.config.json'), flat: j => flatten(j) },
    { id: 'principals.json', file: path.join(cd, 'principals.json'),
      flat: j => { const f = flatten(j), o = {}; for (const k of Object.keys(f)) if (PRINCIPAL_LEAVES.test(k)) o[k] = f[k]; return o; } },
    { id: 'last-conductor.txt', file: path.join(cd, 'last-conductor.txt'), text: true, flat: t => ({ conductor: t }) },
  ];
}

/**
 * Diff each watched file against the last snapshot. Changes already announced by config.set (same key,
 * same new value, after the snapshot) are not repeated. The first run only takes the snapshot.
 */
function scanEdits() {
  let seen = {}; try { seen = JSON.parse(fs.readFileSync(SEEN(), 'utf8')); } catch {}
  const audit = jsonl(AUDIT(), 131072);
  let dirty = false;
  for (const w of watched()) {
    const r = w.text ? readText(w.file) : readJson(w.file);
    if (r.missing || r.error) continue;
    const prev = seen[w.id];
    if (prev && prev.mtime === r.mtime) continue;
    const flat = w.flat(w.text ? r.text : r.json);
    if (prev) {
      const announced = new Set();
      for (const a of audit) if (a.file === w.id && Date.parse(a.at) >= (prev.at || 0) - 2000)
        for (const c of a.changes || []) announced.add(c.k + '=' + JSON.stringify(c.to));
      const changes = diff(prev.flat, flat).filter(c => !announced.has(c.k + '=' + JSON.stringify(c.to)));
      if (changes.length) append({ at: new Date(r.mtime).toISOString(), by: 'edited on disk (a session or by hand)', file: w.id, changes });
    }
    seen[w.id] = { mtime: r.mtime, at: Date.now(), flat };
    dirty = true;
  }
  if (dirty) { try { fs.writeFileSync(SEEN(), JSON.stringify(seen)); } catch {} }
}

/** Latest audit row per file+key, for "changed by X at T" next to each value. */
function lastChanges() {
  const by = {};
  for (const a of jsonl(AUDIT(), 524288)) for (const c of a.changes || []) by[a.file + ':' + c.k] = { at: a.at, by: a.by, from: c.from };
  return by;
}

const iso = ms => (ms ? new Date(ms).toISOString() : null);

/**
 * Build the live view. `opts.titleOf(id)` names a session; `opts.principal` is the phone's principal key
 * (a sub-principal sees its own row first, never anything hidden from the owner).
 */
function read(opts = {}) {
  try { scanEdits(); } catch {}
  const titleOf = opts.titleOf || (() => '');
  const who = lastChanges();
  const cd = conductorDir(), ag = agoState();
  const raw = readJson(config.SETTINGS_FILE);
  const S = raw.json || {};
  const src = (file, mtime) => ({ file, mtime: iso(mtime) });
  // One row: the value as set in the file, or the default (marked) when the file leaves it out.
  const row = (fileId, key, label, setVal, defVal, extra) => Object.assign({
    key, label, value: setVal === undefined ? defVal : setVal, isDefault: setVal === undefined,
    changed: who[fileId + ':' + key] || null,
  }, extra || {});
  const get = (o, k) => k.split('.').reduce((x, p) => (x == null ? undefined : x[p]), o);
  const sr = (key, label, extra) => row('settings.json', key, label, get(S, key), get(config.DEFAULTS, key), extra);
  const sections = [];

  // ---- Models
  const L = ['easy', 'medium', 'hard', 'extraHard'];
  sections.push({ id: 'models', title: 'Models', source: src(config.SETTINGS_FILE, raw.mtime), error: raw.error || null, rows: [
    sr('newSession.model', 'New sessions · model'), sr('newSession.effort', 'New sessions · effort'),
    ...L.flatMap(l => [sr('levels.' + l + '.model', 'Workers · ' + l + ' · model'), sr('levels.' + l + '.effort', 'Workers · ' + l + ' · effort')]),
    sr('tierBeforeWake', 'Switch to these before a wake'), sr('tierOverrideHours', 'Keep a hand change for (h)'),
  ] });

  // ---- Goal chaser: the Conductor's (goals-config.json) is the one that runs; Relaymote's own module is shown beside it.
  {
    const g = readJson(path.join(cd, 'goals-config.json')), G = g.json || {};
    const gr = (key, label, extra) => row('goals-config.json', key, label, G[key], undefined, extra);
    const until = Date.parse(G.full_speed_until || '');
    const hb = readText(path.join(cd, 'goalchase.heartbeat'));
    const pace = jsonl(path.join(cd, 'pace.jsonl'), 8192).pop() || null;
    sections.push({ id: 'chaser', title: 'Goal chaser (Conductor)', source: src(g.file, g.mtime), error: g.missing ? 'file not found' : g.error || null,
      status: {
        on: G.auto_chase === true,
        fullSpeed: until > Date.now(), fullSpeedUntil: isNaN(until) ? null : new Date(until).toISOString(),
        heartbeat: hb.mtime ? iso(hb.mtime) : null,
        pace: pace ? { pace: pace.pace, weeklyPct: pace.weekly_pct, coldPerDay: pace.cold_chase_per_day, holdHours: pace.hold_hours, at: pace.ts, resets: pace.resets } : null,
      },
      rows: [
        gr('auto_chase', 'Chasing'),
        gr('full_speed_until', 'Full speed until', { kind: 'time' }), gr('full_speed_cold_per_cycle', 'Full speed · cold wakes per cycle'),
        gr('chase_per_cycle', 'Chases per cycle'), gr('warm_per_cycle', 'Warm wakes per cycle'), gr('max_chases', 'Give up after (chases)'),
        gr('quiet_hours', 'Chase after (h quiet)'), gr('rechase_hours', 'Ask again after (h)'), gr('cold_chase_per_day', 'Cold chases per day (cap)'),
        gr('auto_rehome', 'Re-home orphan goals'),
        row('settings.json', 'modules.goalChaser', 'Relaymote’s own chaser (separate)', get(S, 'modules.goalChaser'), config.DEFAULTS.modules.goalChaser),
      ],
      notes: Object.keys(G).filter(k => /^_.*note$|^_paused_reason$/.test(k) && G[k]).map(k => ({ key: k, text: String(G[k]) })),
    });
  }

  // ---- Wake gate (~/.claude/hooks/wake-gate.py)
  {
    const wc = readJson(path.join(cd, 'wake_gate.config.json')), W = wc.json || {};
    let hooked = null;
    try { hooked = /wake-gate\.py/.test(fs.readFileSync(path.join(config.CLAUDE_HOME, 'settings.json'), 'utf8')); } catch {}
    const rows24 = jsonl(path.join(cd, 'wake_gate.jsonl'), 1048576);
    const since = Date.now() - 864e5, counts = {};
    let last = null;
    for (const r of rows24) { const t = Date.parse(r.ts); if (t >= since) { counts[r.action] = (counts[r.action] || 0) + 1; last = r; } }
    let held = 0; const h = readJson(path.join(cd, 'wake_hold.json'));
    for (const v of Object.values(h.json || {})) held += ((v && v.items) || []).length;
    sections.push({ id: 'wakegate', title: 'Wake gate', source: src(wc.file, wc.mtime), error: wc.error || null,
      status: { installed: hooked, held, last24h: counts, last: last ? { at: last.ts, action: last.action, why: last.why, to: last.to, toTitle: titleOf(last.to) } : null },
      rows: [
        row('wake_gate.config.json', 'hold_cold', 'Hold wakes to cold sessions', W.hold_cold, WAKE_DEFAULTS.hold_cold),
        row('wake_gate.config.json', 'hold_hours', 'Hold for at most (h)', W.hold_hours, WAKE_DEFAULTS.hold_hours),
      ] });
  }

  // ---- Conductor + principals
  {
    const lc = readText(path.join(cd, 'last-conductor.txt'));
    const p = readJson(path.join(cd, 'principals.json')), P = (p.json && p.json.principals) || {};
    const def = (p.json && p.json.default) || 'ashwar';
    const principals = Object.entries(P).map(([key, v]) => ({
      key, name: v.name || key, enabled: v.enabled !== false, sees: v.sees || 'all', admin: !!v.admin, isDefault: key === def,
      conductor: v.conductor || (key === def ? (S.conductorSession || lc.text || null) : null),
    })).map(x => Object.assign(x, { conductorTitle: x.conductor ? titleOf(x.conductor) : '' }));
    sections.push({ id: 'conductor', title: 'Conductor & principals', source: src(lc.file, lc.mtime), error: lc.missing ? 'last-conductor.txt not found' : lc.error || null,
      status: { conductor: lc.text || null, conductorTitle: lc.text ? titleOf(lc.text) : '', override: S.conductorSession || null, principals, principal: opts.principal || def },
      rows: [
        row('last-conductor.txt', 'conductor', 'Conductor session', lc.text || undefined, null, { kind: 'session' }),
        row('settings.json', 'conductorSession', 'Relaymote override', S.conductorSession || undefined, null, { kind: 'session' }),
        ...principals.map(x => row('principals.json', 'principals.' + x.key + '.enabled', x.name + (x.isDefault ? ' (default)' : ''),
          x.enabled ? 'on · sees ' + x.sees + (x.admin ? ' · admin' : '') : 'off', undefined)),
      ] });
  }

  // ---- Dispatch: who starts work, and how (headless is retired)
  {
    const lines = tailLines(path.join(ag, 'master-audit.log'), 262144), since = Date.now() - 864e5;
    let spawns = 0, chips = 0, lastSpawn = null, lastChip = null;
    for (const l of lines) {
      const m = /^\[([^\]]+)\] (SPAWN|CHIPWATCH started)\b(.*)$/.exec(l); if (!m) continue;
      const t = Date.parse(m[1]); if (!(t >= since)) continue;
      if (m[2] === 'SPAWN') { spawns++; lastSpawn = { at: m[1], text: m[3].trim().slice(0, 160) }; }
      else { chips++; lastChip = { at: m[1], text: m[3].trim().slice(0, 160) }; }
    }
    const d = get(S, 'workers.dispatch');
    sections.push({ id: 'dispatch', title: 'Auto-dispatch', source: src(config.SETTINGS_FILE, raw.mtime),
      status: { route: (d || 'auto') === 'headless' ? 'refused (headless retired)' : 'GUI (Claude Desktop)', headless: 'retired 16-Oct', spawns24h: spawns, chips24h: chips, lastSpawn, lastChip },
      rows: [
        sr('workers.dispatch', 'Dispatch route'), sr('modules.chipAutostart', 'Auto-start task chips'),
        sr('workers.guiConcurrency', 'Desktop workers at once'), sr('modules.orchestrator', 'Relaymote orchestrator (AGO dispatches)'),
        sr('modules.masterNotify', 'Wake the master'),
      ] });
  }

  // ---- Everything else an agent can flip
  {
    const rb = readJson(path.join(config.STATE, 'reaper.json')), ra = readJson(path.join(ag, 'reaper.json'));
    const nc = readJson(path.join(ag, 'notify-config.json'));
    const mods = Object.keys(config.DEFAULTS.modules).filter(k => !['goalChaser', 'chipAutostart', 'orchestrator', 'masterNotify'].includes(k));
    sections.push({ id: 'other', title: 'Modules & other switches', source: src(config.SETTINGS_FILE, raw.mtime), rows: [
      ...mods.map(k => sr('modules.' + k, k)),
      sr('idleGateSeconds', 'Idle gate (s)'), sr('followClaude', 'Run only while Claude Desktop is open'), sr('remote.mode', 'Remote access'),
      sr('engine.kind', 'Model engine'),
      { key: 'reaper.mode', label: 'Reaper mode (Relaymote / AGO)', value: ((rb.json || {}).mode || '—') + ' / ' + ((ra.json || {}).mode || '—'), changed: rb.mtime ? { at: iso(rb.mtime), by: 'reaper.json' } : null },
      { key: 'ago.notify', label: 'AGO notifications', value: nc.json ? (nc.json.enabled ? 'on' : 'off') : '—',
        changed: nc.json && nc.json.lastChange ? { at: nc.json.lastChange.at, by: nc.json.lastChange.by } : null },
    ] });
  }

  const recent = jsonl(AUDIT(), 131072).slice(-25).reverse()
    .map(a => Object.assign({}, a, { changes: (a.changes || []).filter(c => !/^_/.test(c.k) || /note/.test(c.k)).slice(0, 12) }));
  return { ok: true, at: new Date().toISOString(), sections, recent };
}

module.exports = { read, recordSet, scanEdits, flatten, diff, AUDIT, SEEN };
