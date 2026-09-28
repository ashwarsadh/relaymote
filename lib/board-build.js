// board-build.js — write board.json (docs/BOARD.md) and a desktop board.html from what Relaymote already
// knows: sessions waiting on you, stuck sessions, goals that need a person, the inbox (things only you
// can do, what is in flight, what is probably handled), the goal register's health and, when present,
// context hygiene. A board.json / board.html written by something else (no "generator": "relaymote") is
// never overwritten unless settings board.generate is true.
'use strict';
const fs = require('fs');
const path = require('path');
const config = require('./config');
const goals = require('./goals');
const inbox = require('./inbox');

const LABELS = {
  decide: 'Needs you — a question or a permission',
  nudge: 'Stuck — running but silent, or not answering',
  un: 'Unrouted goals — nobody owns them yet',
  open: 'Blocked goals',
  buried: 'Buried',
};
const HINTS = {
  decide: 'These sessions stopped to ask you something. Answer here or open the session.',
  nudge: 'Running with no output for a while, or the goal chaser got no answer. Yes = "carry on".',
  un: 'No session owns these goals. Yes = let the Conductor pick an owner or start one.',
  open: 'The owner reported what it is waiting for.',
  buried: '',
};
const BUCKETS = ['buried', 'decide', 'nudge', 'un', 'open'];
const RECENT_DAYS = 14;
const PQ_MAX = 30;
const DAY = 86400000;

const boardSettings = () => ({ dir: '', html: '', finishedKeepDays: 3, generate: false, ...((config.get() || {}).board || {}) });
const boardDir = () => boardSettings().dir || path.join(config.DATA, 'board');
const boardFile = () => path.join(boardDir(), 'board.json');
const htmlFile = () => boardSettings().html || path.join(config.DATA, 'board.html');
const ageDays = (t, now) => t ? +((now - t) / DAY).toFixed(2) : null;
const clip = (s, n) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const ms = (s) => { const t = Date.parse(s || ''); return isNaN(t) ? 0 : t; };

function projectName(cwd) {
  if (!cwd) return '';
  try { const r = require('./projects').projectRoot(cwd); return path.basename(r || cwd); } catch { return path.basename(cwd); }
}

async function defaultSessions() {
  const sessions = require('../mobile/sessions');
  await sessions.refresh();
  let snap = null;
  try { snap = require('./desktop').loadSnapshot(); } catch {}
  return sessions.decorate(sessions.index().list, snap);
}

// Goal conditions that need a person, and the board bucket each one lands in.
const GOAL_ROWS = {
  'VERIFY-NOW': ['decide', (g) => 'Verification date reached: ' + (g.verifyWhat || 'check the result') + '. Close it or reopen the work.'],
  DELIVERED: ['decide', (g, it) => 'Reported done — ' + clip(g.progress || '', 300) + '. Read the evidence: close it, or judge it back to the owner.'
    + (it.collected ? ' (Its owner was already collected and has been silent since.)' : '')],
  UNRESPONSIVE: ['nudge', (g) => `No answer to ${g.unanswered || 0} reminders. Judge it: close, re-home or release it.`],
  OFFLINE: ['nudge', (g, it) => `Its owner is ${it.ownerState}; nothing can be sent until it is back.`],
  ORPHAN: ['un', (g, it) => it.ownerState === 'none'
    ? 'No owner: ' + ((g.routing && g.routing.why) || 'nothing matched')
    : `Its owner session is ${it.ownerState}.`],
  UNTOLD: null,
  BLOCKED: ['open', (g) => 'Blocked: ' + (g.blockedOn || '')],
  'BLOCKED-STALE': ['open', (g) => 'Blocked for a week or more: ' + (g.blockedOn || '')],
};

/** goals-health.json when it is recent, else a fresh classification from the sessions in hand. */
function readHealth(gs, list, now) {
  try {
    const h = JSON.parse(fs.readFileSync(goals.HEALTH, 'utf8'));
    if (h && Array.isArray(h.items) && now - Date.parse(h.at) < 30 * 60000) return h;
  } catch {}
  const anyLive = list.some(s => s.live);
  const sessions = new Map(list.map(s => [s.id, anyLive ? s : { ...s, live: undefined }]));
  const items = goals.assess({ goals: gs, sessions, fresh: true, now, st: goals.settings() });
  let old = {};
  try { old = JSON.parse(fs.readFileSync(goals.HEALTH, 'utf8')) || {}; } catch {}
  const counts = {};
  for (const it of items) counts[it.condition] = (counts[it.condition] || 0) + 1;
  return { at: new Date(now).toISOString(), counts, items, events24: (old.events24 || []).filter(e => now - ms(e.at) < DAY), computed: true };
}

/**
 * hygiene.json (lib/hygiene.js: per-session context verdicts + wake counts) from the board folder, else
 * <data>/conductor. Slimmed for the phone: counts, the wake roll-up, and only the sessions that need a look.
 */
function slimHygiene(h) {
  if (!h || typeof h !== 'object') return null;
  const list = Array.isArray(h.items) ? h.items : Array.isArray(h.sessions) ? h.sessions : [];
  const need = list.filter(i => i && i.verdict && i.verdict !== 'OK');
  return { at: h.at || null, live: h.live != null ? h.live : null, counts: h.counts || {}, wakes: h.wakes || null, more: Math.max(0, need.length - 40),
    items: need.slice(0, 40).map(i => ({ id: i.id, title: clip(i.title, 90), project: i.project || '', verdict: i.verdict, why: clip(i.why || i.reason || '', 200) })) };
}
function readHygiene() {
  for (const f of [path.join(boardDir(), 'hygiene.json'), path.join(config.DATA, 'conductor', 'hygiene.json')]) {
    try { const h = JSON.parse(fs.readFileSync(f, 'utf8')); if (h && typeof h === 'object') return slimHygiene(h); } catch {}
  }
  return null;
}

function defaultQuestion(s) {
  try { return require('../mobile/sessions').pendingQuestion(s); } catch { return null; }
}

function readIndex() { try { return require('./projects').read(); } catch { return null; } }

/**
 * Compose the board object. deps: now, sessions (decorated list), pendingQuestion(s), goals (list),
 * inbox (items; default lib/inbox), index (project index, for sessions named in inbox text), conductor, health, hygiene.
 */
async function compose(deps = {}) {
  const now = deps.now || Date.now();
  const list = deps.sessions || await defaultSessions();
  const pq = deps.pendingQuestion || defaultQuestion;
  const gs = deps.goals || goals.list({ all: true });
  const byId = new Map(list.map(s => [s.id, s]));
  const ix = deps.index !== undefined ? deps.index : readIndex();
  const ixSessions = (ix && ix.sessions) || {};
  const rows = [];
  let probes = 0;

  for (const s of list) {
    if (s.archived) continue;
    const age = ageDays(s.lastActivityAt, now);
    if (age != null && age > RECENT_DAYS) continue;
    let q = null;
    if (!s.running && (s.awaiting || (age != null && age <= 3)) && probes < PQ_MAX) { probes++; q = pq(s); }
    const base = { id: s.id, title: s.title || '(untitled)', project: projectName(s.cwd), group: s.group || '', age };
    if (s.awaiting || q) {
      const first = q && q.questions && q.questions[0];
      rows.push({ ...base, bucket: 'decide', ask_kind: 'decision',
        ask: first ? clip(first.question || first.header || '', 500) : 'Waiting for your answer or a permission.' });
    } else if (s.stalled) {
      rows.push({ ...base, bucket: 'nudge', ask: `Running, but nothing new for ${Math.round((s.quietFor || 0) / 60000)} min.` });
    }
  }

  const health = deps.health || readHealth(gs, list, now);
  const items = health.items || [];
  const gById = new Map(gs.map(g => [g.id, g]));
  const hById = new Map(items.map(i => [i.id, i]));
  for (const it of items) {
    const g = gById.get(it.id);
    if (!g || g.status !== 'open') continue;
    const age = ageDays(Date.parse(g.createdAt), now);
    const base = { id: g.id, title: `${g.id} — ${g.title}`, project: g.project || '', group: '', age, goal: g.id, condition: it.condition,
      ...(g.ownerSessionId && byId.has(g.ownerSessionId) ? { session: g.ownerSessionId } : {}) };
    if (it.condition === 'OFFLINE' && it.ownerState === 'unknown') continue;
    if (it.oldOwnerDone && ['STUCK', 'LATE', 'FRESH', 'WATCH', 'HANDED-OVER'].includes(it.condition)) {
      rows.push({ ...base, bucket: 'decide', ask: `Its previous owner ${String(it.oldOwnerDone.session).slice(0, 14)} already reported it done: `
        + clip(it.oldOwnerDone.note, 240) + '. Read that, then close it or judge it back.' });
      continue;
    }
    const row = GOAL_ROWS[it.condition];
    if (row) rows.push({ ...base, bucket: row[0], ask: row[1](g, it) });
  }
  // Newest first inside a bucket.
  rows.sort((a, b) => (a.age == null ? 999 : a.age) - (b.age == null ? 999 : b.age));

  const projectOfSession = (sid) => (sid && ixSessions[sid] && ixSessions[sid].project) || (sid && byId.has(sid) ? projectName(byId.get(sid).cwd) : '') || '';
  const pmap = new Map();
  for (const sid of Object.keys(ixSessions)) if (sid.startsWith('local_') && sid.length > 14 && !pmap.has(sid.slice(0, 14))) pmap.set(sid.slice(0, 14), sid);
  for (const s of list) if (s.id && s.id.startsWith('local_') && !pmap.has(s.id.slice(0, 14))) pmap.set(s.id.slice(0, 14), s.id);
  const allItems = inbox.newestFirst(deps.inbox || inbox.all()).filter(r => r.kind !== 'log');
  const card = (r) => {
    const sid = inbox.sessionOf(r, { prefixMap: pmap });
    return { n: r.n, ts: r.ts, text: r.text || '', ask: r.ask || '', ask_kind: r.ask_kind || '', status: r.status, note: r.note || '',
      session: sid || null, anchor: (r.anchor && sid === r.session) ? r.anchor : undefined, project: projectOfSession(sid), pinned: !!r.no_auto || undefined,
      orphaned: r.orphaned || undefined, seen: r.seen_in_lane || r.replied_in_lane || undefined, answered_at: r.answered_at || undefined };
  };
  const inboxOpen = allItems.filter(r => r.status === 'open').map(card);
  const inboxWaiting = allItems.filter(r => r.status === 'waiting').map(card);
  const inboxResolved = inbox.newestFirst(deps.inbox || inbox.all()).filter(r => r.status === 'resolved?').map(r => ({
    ...card(r), tier: r.resolved_tier || null, why: r.resolved_why || '', evidence: r.resolved_evidence || '', at: r.resolved_at || null }));

  const keep = Number(boardSettings().finishedKeepDays) || 3;
  const fin = gs.filter(g => goals.FINISHED.includes(g.status));
  const recent = fin.filter(g => g.closedAt && now - ms(g.closedAt) <= keep * DAY).sort((a, b) => ms(b.closedAt) - ms(a.closedAt));
  const goalRows = gs.filter(g => g.status === 'open').concat(recent).map(g => {
    const h = hById.get(g.id) || {};
    return { id: g.id, title: g.title, status: g.status, due: g.due ? g.due.slice(0, 10) : null, session: g.ownerSessionId || null,
      blocked_on: g.blockedOn || null, progress: g.progress || null, outcome: g.outcome || null, detail: clip(g.text, 400),
      checks: Array.isArray(g.checks) ? g.checks : [], project: g.project || projectOfSession(g.ownerSessionId) || '',
      closed_at: g.closedAt || null, condition: g.status === 'open' ? (h.condition || null) : null,
      owner_state: h.ownerState || null, quiet_h: h.quietH != null ? h.quietH : null };
  });

  const slim = (it) => ({ id: it.id, title: it.title, condition: it.condition, owner: it.owner, ownerState: it.ownerState, quietH: it.quietH,
    chases: it.chases, due: it.due, blockedOn: it.blockedOn, verifyBy: it.verifyBy, verifyWhat: it.verifyWhat, progress: it.progress,
    project: it.project, oldOwnerDone: it.oldOwnerDone || undefined, collected: it.collected || undefined, since: it.since || undefined });
  const goalsHealth = { at: health.at || null, counts: health.counts || {}, items: items.map(slim),
    events24: (health.events24 || []).filter(e => now - ms(e.at) < DAY), thresholds: health.thresholds || null };

  // One predicate for the header counts: a row counts until it is handled — no age cut-off. A lane
  // waiting two weeks needs a nudge MORE than one waiting two days; the day chips stay a filter you apply.
  const counts = {};
  for (const b of BUCKETS) counts[b] = rows.filter(r => r.bucket === b && !r.handled).length;
  let conductor = deps.conductor;
  if (conductor === undefined) { try { conductor = require('./master-protocol').conductorId(); } catch { conductor = null; } }
  const projects = [...new Set([...rows.map(r => r.project), ...inboxOpen.map(r => r.project), ...goalRows.filter(g => g.status === 'open').map(g => g.project)]
    .filter(Boolean))].sort();
  return {
    generator: 'relaymote', built_at: new Date(now).toISOString(), conductor: conductor || null, owner_name: inbox.ownerName(),
    labels: LABELS, hints: HINTS, counts, projects,
    rows, inbox: inboxOpen, inbox_waiting: inboxWaiting, inbox_resolved: inboxResolved,
    goals: goalRows, finished_older: fin.length - recent.length, finished_keep_days: keep,
    goals_health: goalsHealth, hygiene: deps.hygiene !== undefined ? slimHygiene(deps.hygiene) : readHygiene(),
  };
}

// ---------------------------------------------------------------- board.html (a desktop view of the same data)
/**
 * Lines where a quoted JS string is still OPEN at the end of the line. A real newline typed inside a
 * string literal is a SyntaxError, which kills the WHOLE script tag: the page still renders, and every
 * filter and button silently does nothing. Block comments are stripped first so prose cannot cry wolf.
 */
function jsOpenStrings(js) {
  const out = [];
  let depth = 0;
  for (const line of String(js || '').split('\n')) {
    let keep = line;
    if (depth) { const k = keep.indexOf('*/'); if (k < 0) { out.push(''); continue; } keep = keep.slice(k + 2); depth = 0; }
    for (;;) {
      const a = keep.indexOf('/*');
      if (a < 0) break;
      const b = keep.indexOf('*/', a + 2);
      if (b < 0) { keep = keep.slice(0, a); depth = 1; break; }
      keep = keep.slice(0, a) + keep.slice(b + 2);
    }
    out.push(keep);
  }
  const bad = [];
  out.forEach((line, i) => {
    const t = line.trim();
    if (!t || t.startsWith('//') || t.startsWith('*')) return;
    let q = null;
    for (let k = 0; k < line.length; k++) {
      const c = line[k];
      if (c === '\\') { k++; continue; }
      if (q) { if (c === q) q = null; continue; }
      if (c === '/' && line[k + 1] === '/') break;
      if (c === "'" || c === '"' || c === '`') q = c;
    }
    if (q && q !== '`') bad.push({ line: i + 1, text: t.slice(-80) });
  });
  return bad;
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const BOARD_JS = `
(function () {
  var state = { bucket: 'all', project: 'all' };
  function cards() { return Array.prototype.slice.call(document.querySelectorAll('.card[data-bucket]')); }
  /* ONE predicate for both hiding a card and counting a chip, so a chip never promises more than it shows. */
  function matches(c, bucket, project) {
    var d = c.dataset;
    return (bucket === 'all' || d.bucket === bucket) && (project === 'all' || d.project === project);
  }
  function apply() {
    cards().forEach(function (c) { c.hidden = !matches(c, state.bucket, state.project); });
    Array.prototype.slice.call(document.querySelectorAll('.chip[data-b]')).forEach(function (ch) {
      var n = cards().filter(function (c) { return matches(c, ch.dataset.b, state.project); }).length;
      ch.querySelector('.n').textContent = n;
      ch.classList.toggle('on', ch.dataset.b === state.bucket);
    });
  }
  function toast(t) { var el = document.getElementById('toast'); el.textContent = t; el.hidden = false; setTimeout(function () { el.hidden = true; }, 3500); }
  function act(kind, id, text) {
    return fetch('/api/board/act', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
      body: JSON.stringify({ kind: kind, id: String(id), text: text || '' }) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok && j.ok, j: j }; }); })
      .then(function (r) { toast(r.ok ? 'Sent to the Conductor' : 'NOT sent: ' + (r.j.reason || r.j.error || 'refused')); return r.ok; })
      .catch(function (e) { toast('NOT sent: ' + e.message); return false; });
  }
  document.addEventListener('click', function (e) {
    var chip = e.target.closest('.chip[data-b]');
    if (chip) { state.bucket = chip.dataset.b; apply(); return; }
    var b = e.target.closest('button[data-act]');
    if (!b) return;
    var kind = b.dataset.act, id = b.dataset.id, text = '';
    if (kind === 'answer') { text = window.prompt('Your answer', '') || ''; if (!text.trim()) return; }
    act(kind, id, text).then(function (ok) { if (ok) { var c = b.closest('.card'); if (c) c.classList.add('acted'); } });
  });
  var sel = document.getElementById('proj');
  if (sel) sel.addEventListener('change', function () { state.project = sel.value; apply(); });
  apply();
})();
`;

const BOARD_CSS = `:root{--bg:#fbfaf8;--fg:#1d1b18;--mut:#6b655c;--card:#fff;--line:#e5e1da;--bad:#b91c1c;--warn:#b45309;--ok:#15803d;--acc:#1d4ed8}
@media (prefers-color-scheme:dark){:root{--bg:#12110f;--fg:#e8e6e1;--mut:#9b958c;--card:#1c1b18;--line:#2e2c28;--bad:#f87171;--warn:#fbbf24;--ok:#4ade80;--acc:#93c5fd}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}main{max-width:980px;margin:0 auto;padding:16px}
h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:22px 0 8px}small,.m{color:var(--mut)}.m{font-size:12px;display:flex;gap:10px;flex-wrap:wrap}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin:8px 0}.card.acted{opacity:.5}
.t{font-weight:600}.ask{margin-top:6px}.tag{font-size:11px;font-weight:700;border:1px solid currentColor;border-radius:6px;padding:0 5px;margin-right:4px}
.k-decide{color:var(--bad)}.k-do{color:var(--warn)}.k-fyi{color:var(--acc)}.k-none{color:var(--mut)}
button{font:inherit;font-size:13px;border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:8px;padding:3px 10px;margin:6px 6px 0 0;cursor:pointer}
.chips{display:flex;gap:6px;flex-wrap:wrap;margin:10px 0}.chip.on{border-color:var(--acc);color:var(--acc)}
.rh{border:1px solid var(--line);border-radius:10px;padding:8px 12px;margin:8px 0}.rh div{margin:3px 0}.bad{color:var(--bad)}.warn{color:var(--warn)}.ok{color:var(--ok)}
details summary{cursor:pointer;color:var(--mut)}#toast{position:fixed;bottom:16px;left:50%;transform:translateX(-50%);background:var(--fg);color:var(--bg);padding:6px 14px;border-radius:8px}
select{font:inherit;background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:8px}`;

function renderHtml(b) {
  const who = esc(b.owner_name || 'you');
  const kindTag = (r) => r.ask_kind ? `<span class="tag k-${esc(r.ask_kind)}">${esc(String(r.ask_kind).toUpperCase())}</span>` : '<span class="tag k-none">NO QUESTION</span>';
  const inboxCard = (r) => `<div class="card" data-bucket="inbox" data-project="${esc(r.project || '')}"><div class="t">${kindTag(r)} #${r.n} ${esc(r.ask || clip(r.text, 180))}</div>`
    + `<div class="m"><span>${esc(String(r.ts || '').slice(5, 16))}</span>${r.session ? `<span>${esc(r.session.slice(0, 14))}</span>` : ''}${r.pinned ? '<span>pinned</span>' : ''}</div>`
    + ((r.ask && r.text) || r.note ? `<details><summary>why</summary><div>${esc(r.text)}${r.note ? '<hr>' + esc(r.note) : ''}</div></details>` : '')
    + `<button data-act="done" data-id="#${r.n}">${r.ask_kind === 'fyi' ? 'Read' : 'Done'}</button>` + (r.ask_kind === 'fyi' ? '' : `<button data-act="answer" data-id="#${r.n}">Answer…</button>`) + '</div>';
  const rowCard = (r) => `<div class="card" data-bucket="${esc(r.bucket)}" data-project="${esc(r.project || '')}"><div class="t">${esc(r.title)}</div>`
    + `<div class="m"><span>${esc(r.project || '')}</span><span>${r.age != null ? esc(r.age) + 'd' : ''}</span></div>`
    + (r.ask ? `<div class="ask">${esc(r.ask)}</div>` : '')
    + `<button data-act="yes" data-id="${esc(r.id)}">Yes</button><button data-act="answer" data-id="${esc(r.id)}">Answer…</button><button data-act="skip" data-id="${esc(r.id)}">Skip</button></div>`;
  const H = [];
  H.push(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="generator" content="relaymote">`
    + `<title>Relaymote board</title><style>${BOARD_CSS}</style></head><body><main>`);
  H.push(`<h1>Board</h1><small>built ${esc(String(b.built_at).slice(0, 16).replace('T', ' '))} UTC · taps go to the Conductor${b.conductor ? '' : ' (none claimed — taps will be refused)'}</small>`);
  const chipDefs = [['all', 'All'], ['inbox', 'For ' + who]].concat(BUCKETS.map(k => [k, (b.labels[k] || k).split('—')[0].trim()]));
  H.push('<div class="chips">' + chipDefs.map(([k, l]) => `<button class="chip" data-b="${k}">${l} <span class="n"></span></button>`).join('')
    + (b.projects.length > 1 ? `<select id="proj"><option value="all">All projects</option>${b.projects.map(p => `<option>${esc(p)}</option>`).join('')}</select>` : '') + '</div>');
  const gh = b.goals_health || {}, hi = gh.items || [];
  const by = (c) => hi.filter(i => i.condition === c);
  if (hi.length || (gh.events24 || []).length) {
    const line = (cls, n, label, list) => `<div class="${n ? cls : 'ok'}"><b>${n}</b> ${label}${list && list.length ? '<br><small>' + list.map(i => esc(i.id + ' ' + clip(i.title, 70))).join(' · ') + '</small>' : ''}</div>`;
    H.push('<h2>Goal register</h2><div class="rh">'
      + (by('VERIFY-NOW').length ? line('bad', by('VERIFY-NOW').length, 'verify now — the proving date has arrived', by('VERIFY-NOW')) : '')
      + line('bad', by('DELIVERED').length, 'delivered, not yet read — close it with the evidence or judge it back', by('DELIVERED'))
      + line('bad', by('ORPHAN').length + by('UNTOLD').length, 'ownerless or never handed over', by('ORPHAN').concat(by('UNTOLD')))
      + line('warn', by('STUCK').length + by('LATE').length, 'stuck or late', by('STUCK').concat(by('LATE')))
      + `<div><b>${(gh.events24 || []).length}</b> changes in 24 h</div></div>`);
  }
  H.push(`<h2>For ${who} · ${b.inbox.length}</h2>` + (b.inbox.length ? b.inbox.map(inboxCard).join('') : '<small>Nothing only you can do.</small>'));
  if (b.inbox_resolved.length) {
    H.push(`<details><summary>Probably handled · ${b.inbox_resolved.length}</summary>` + b.inbox_resolved.map(r => `<div class="card"><div class="t">#${r.n} ${esc(clip(r.ask || r.text, 180))}</div>`
      + `<div class="m"><span>${esc(r.tier || '?')} confidence</span><span>${esc(r.why)}</span></div><small>evidence: ${esc(r.evidence)}</small><br>`
      + `<button data-act="reopen" data-id="#${r.n}">Reinstate</button></div>`).join('') + '</details>');
  }
  if (b.inbox_waiting.length) H.push(`<details><summary>In flight · ${b.inbox_waiting.length} (no action needed)</summary>` + b.inbox_waiting.map(r => `<div class="m">#${r.n} ${esc(clip(r.text, 160))}</div>`).join('') + '</details>');
  for (const k of BUCKETS) {
    const rs = b.rows.filter(r => r.bucket === k);
    if (rs.length) H.push(`<h2>${esc(b.labels[k] || k)} · ${rs.length}</h2><small>${esc(b.hints[k] || '')}</small>` + rs.map(rowCard).join(''));
  }
  const hy = b.hygiene;
  if (hy && hy.counts && typeof hy.counts === 'object') {
    const wl = hy.wakes && hy.wakes.lastDay;
    H.push('<h2>Context hygiene</h2><div class="rh">' + Object.entries(hy.counts).map(([k, n]) => `<div><b>${esc(n)}</b> ${esc(String(k).toLowerCase().replace(/-/g, ' '))}</div>`).join('')
      + (wl ? `<div><small>wakes, last day: ${esc(wl.warm || 0)} inside the cache window · ${esc(wl.cold || 0)} outside${hy.wakes.baton24 != null ? ' · Relaymote sent ' + esc(hy.wakes.baton24) + ' in 24 h' : ''}</small></div>` : '') + '</div>');
  }
  H.push('<div id="toast" hidden></div></main><script>' + BOARD_JS + '</script></body></html>');
  return H.join('\n');
}

/** Write board.html unless its script would not parse, or it belongs to something else. */
function writeHtml(board, opts = {}) {
  const file = opts.file || htmlFile();
  const js = opts.script !== undefined ? opts.script : BOARD_JS;
  const bad = jsOpenStrings(js);
  if (bad.length) return { written: false, file, reason: `board.html NOT written: its script has an unclosed string on line ${bad.map(x => x.line).join(', ')}`, bad };
  let existing = null;
  try { existing = fs.readFileSync(file, 'utf8'); } catch {}
  if (existing && !/<meta name="generator" content="relaymote">/.test(existing) && boardSettings().generate !== true) {
    return { written: false, file, reason: 'board.html was written by something else; set board.generate to true to replace it' };
  }
  let html = renderHtml(board);
  if (opts.script !== undefined) html = html.replace(BOARD_JS, js);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, html);
  fs.renameSync(tmp, file);
  return { written: true, file };
}

/** Compose and write board.json (and board.html). Returns { written, file, reason?, board, html, inbox }. */
async function build(deps = {}) {
  let maint = null;
  if (deps.maintain !== false) { try { maint = inbox.maintain(deps.inboxDeps || {}); } catch (e) { maint = { error: e.message }; } }
  const file = deps.file || boardFile();
  const board = await compose(deps);
  let existing = null;
  try { existing = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const force = boardSettings().generate === true;
  let html = null;
  if (deps.html !== false) { try { html = writeHtml(board, { file: deps.htmlFile }); } catch (e) { html = { written: false, reason: e.message }; } }
  if (existing && existing.generator !== 'relaymote' && !force) {
    return { written: false, file, reason: 'board.json was written by something else; set board.generate to true to replace it', board, html, inbox: maint };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(board, null, 1));
  fs.renameSync(tmp, file);
  return { written: true, file, board, html, inbox: maint };
}

let lastBuild = 0;
/** Rebuild when the last build is older than maxAgeMs (used when the Board opens). */
async function maybeBuild(maxAgeMs = 60000) {
  if (Date.now() - lastBuild < maxAgeMs) return null;
  lastBuild = Date.now();
  return build();
}

module.exports = { compose, build, maybeBuild, boardFile, htmlFile, renderHtml, writeHtml, jsOpenStrings, slimHygiene, BOARD_JS, LABELS, HINTS, BUCKETS };
