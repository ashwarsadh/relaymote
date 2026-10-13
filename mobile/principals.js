'use strict';
// g1870 — one Conductor per PRINCIPAL on one account. Ashwar 13-Oct-2026: "I want to give Sagar an access
// ... same account, same chats, same everything. But just that he gets one more conductor ... Maybe his
// board should also be dedicated."
//
// principals.json lives beside board.json (the Conductor's folder) and is shared with the Python register
// (~/.claude/skills/conductor/scripts/principals.py):
//   { "default": "ashwar", "principals": { "ashwar": {name, conductor:null, sees:"all"},
//                                          "sagar":  {name, conductor:"local_…", sees:"own"} } }
// A device says who holds it (localStorage baton.principal, sent as ?as=); nothing here is a security
// boundary — Sagar's phone holds the full key by Ashwar's choice ("same everything"). It decides which
// board he sees, which Conductor his board taps go to, and where his app opens.
const fs = require('fs');
const path = require('path');

function load(dir) {
  let j = {};
  try { j = JSON.parse(fs.readFileSync(path.join(dir, 'principals.json'), 'utf8')) || {}; } catch {}
  const def = String(j.default || 'ashwar').toLowerCase();
  const principals = Object.assign({}, j.principals || {});
  if (!principals[def]) principals[def] = { name: 'Ashwar', conductor: null, sees: 'all' };
  return { default: def, principals };
}

/** 'Sagar' -> { key:'sagar', name, conductor, own:true }; unknown / empty / default -> the default (sees all). */
function resolve(dir, as) {
  const j = load(dir);
  const k = String(as || '').trim().toLowerCase();
  const key = k && j.principals[k] ? k : j.default;
  const r = j.principals[key] || {};
  const own = key !== j.default && (r.sees || 'own') === 'own';
  return { key, name: r.name || key, conductor: key === j.default ? null : (r.conductor || null), own, isDefault: key === j.default };
}

/** The list the phone's settings picker offers. */
function list(dir) {
  const j = load(dir);
  return Object.entries(j.principals).map(([key, r]) => ({ key, name: r.name || key, conductor: key === j.default ? null : (r.conductor || null), isDefault: key === j.default }));
}

const of = (row, def) => String((row && row.principal) || def).toLowerCase();

/**
 * Narrow a board view to one principal: their goals and asks, and the session rows that serve them
 * (owners of their open goals, sessions named on their asks, and their own Conductor).
 */
function narrow(body, p, def) {
  if (!p || !p.own) return body;
  const mine = (r) => of(r, def) === p.key;
  const goals = (body.goals || []).filter(mine);
  const inbox = (body.inbox || []).filter(mine);
  const inbox_waiting = (body.inbox_waiting || []).filter(mine);
  const inbox_resolved = (body.inbox_resolved || []).filter(mine);
  const serving = new Set([p.conductor].filter(Boolean));
  for (const g of goals) if (g.status === 'open' && g.session) serving.add(g.session);
  for (const r of [...inbox, ...inbox_waiting]) if (r.session) serving.add(r.session);
  const rows = (body.rows || []).filter(r => serving.has(r.id));
  return Object.assign({}, body, { goals, inbox, inbox_waiting, inbox_resolved, rows,
    projects: [...new Set(rows.map(r => r.project).filter(Boolean))].sort() });
}

module.exports = { load, resolve, list, narrow, of };
