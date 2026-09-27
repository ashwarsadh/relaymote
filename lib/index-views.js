// index-views.js — human views of the project index: INDEX.md, per-project wiki pages, a searchable
// map.html, and the reports the Conductor asks for (progress, buried, session card, fleet tree, masters).
// Pure functions over the index object from lib/projects.js; nothing here reads a transcript.
'use strict';
const path = require('path');
const { findSessions } = require('./aliases');

const iso = ts => String(ts || '').slice(0, 16).replace('T', ' ');
const cell = s => String(s == null ? '' : s).replace(/[|\r\n]+/g, '/').trim();
const k = n => Math.round((n || 0) / 1000);
const short = id => String(id).startsWith('local_') ? String(id).slice(6, 14) : String(id).slice(0, 12);
const ageOf = ts => { const t = Date.parse(ts || ''); return t ? (Date.now() - t) / 86400000 : Infinity; };

/** The context flag with its honesty label: the estimate is a hint, compactions are the ground truth. */
function ctxLabel(s) {
  let f = `~${k(s.est_ctx_tokens)}k ${s.ctx_flag || 'ok'}`;
  if (s.ctx_flag && s.ctx_flag !== 'ok') {
    if (s.compactions) f += ` (compacted×${s.compactions} — coping, not dead)`;
    else if (!s.context_exceeded) f += ' (est only, 0 compactions — NOT verified full)';
  }
  if (s.context_exceeded) f += ` (exceeded×${s.context_exceeded})`;
  return f;
}

function sessLine(s) {
  const role = s.baton_master ? ' [MASTER]' : s.is_master ? ' [master]' : '';
  const kids = (s.children || []).length ? ` fleet:${s.children.length}` : '';
  const dots = [['●unread', s.unread], ['?await', s.awaiting], ['▶run', s.running]].filter(x => x[1]).map(x => x[0]).join('');
  const tags = (s.tags || []).length ? ' #' + s.tags.slice(0, 3).join(' #') : '';
  return `${short(s.id)} | ${cell(String(s.title).slice(0, 70))} | ${cell(s.group || (s.in_sidebar ? 'Ungrouped' : 'no Desktop row'))} | ${iso(s.last)} | ` +
    `${ctxLabel(s)}${role}${kids} ${dots}${s.archived ? ' (archived)' : ''}${tags}`.trimEnd();
}

const liveRecent = (S, days) => Object.values(S).filter(s => s.in_sidebar && !s.archived && (s.age_days == null || s.age_days <= days));

/** Waiting counts. NARROW (the session's own flag) and BROAD (how its last turn ended) are never summed. */
function waiting(ix, days = 7) {
  const L = liveRecent(ix.sessions, days);
  const n = f => L.filter(f).length;
  return {
    days, narrow: n(s => s.awaiting_signal === 'narrow'), broad: n(s => s.awaiting_signal === 'broad'),
    buried: n(s => s.pending === 'buried'), decide: n(s => s.pending === 'asks' && s.critical),
    nudge: n(s => s.pending === 'asks' && !s.critical), unanswered: n(s => s.pending === 'unanswered'), open: n(s => s.pending === 'open'),
    running: n(s => s.pending === 'running'),
  };
}

function indexMd(ix) {
  const S = ix.sessions, c = ix.counts;
  const L = [`Conductor id: ${ix.conductor || 'unknown'}`, '# Relaymote project index', '',
    `Built ${ix.builtAt}. ${c.projects} projects, ${c.sessions} Desktop sessions (${c.active} active, ${c.archived || 0} archived)` +
    `, ${c.cli_only || 0} transcript-only (\`cli_<uuid>\`: headless or deleted), ${c.groups || 0} groups. Groups read from: ${ix.groupSource || 'nowhere'}.`,
    'ctx = bytes since the last compaction ÷ bytesPerToken — a HINT that over-counts images/attachments, never a liveness signal; ' +
    'the compaction count is the ground truth. Ids: `local_<uuid>` (Desktop; the 8-char prefix works) and `cli_<uuid>` (no Desktop row).', ''];

  L.push('## Masters');
  const claims = Object.entries(ix.relaymote_masters || {});
  for (const [key, m] of claims) {
    const s = S[m.sessionId];
    L.push(`- CLAIMED ${m.sessionId} | ${cell(key)} | ${cell(String(m.scope || '').slice(0, 80))} | ` +
      (s ? `${ctxLabel(s)} · fleet ${(s.children || []).length} · last ${iso(s.last)}` : 'no row') + ` | claim expires ${iso(m.expiresAt)}`);
  }
  if (!claims.length) L.push('- no Relaymote master claims');
  for (const [g, gd] of Object.entries(ix.groups || {})) {
    const ms = (gd.living_masters || []).slice(0, 3).map(i => `${short(i)} "${cell(String(S[i].title).slice(0, 44))}" ${ctxLabel(S[i])} fleet ${(S[i].children || []).length}`);
    if (ms.length) L.push(`- group **${g}**: ${ms.join('; ')}`);
  }
  L.push('');

  const w = waiting(ix, 7);
  L.push(`## Waiting on a human (last ${w.days} days)`,
    `- narrow (the session's OWN flag — awaiting dot or unanswered AskUserQuestion): **${w.narrow}**`,
    `- broad (only how its last turn ended — much weaker; never add it to narrow): ${w.broad}`,
    `- buried ${w.buried} (a relay hid the ask) · decide ${w.decide} (critical) · nudge ${w.nudge} · unanswered ${w.unanswered} · open ${w.open} · running ${w.running}`, '');

  L.push('## Sidebar groups (live sessions)');
  for (const [g, gd] of Object.entries(ix.groups || {})) {
    const ps = Object.entries(gd.projects).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([p, n]) => `${p} (${n})`).join(', ') || '—';
    L.push(`- **${g}** — ${gd.sessions.length} live; projects ${ps}; last ${iso(gd.last)}; masters ${(gd.living_masters || []).length}`);
  }
  L.push('');

  const tasks = (ix.os_tasks && ix.os_tasks.rows) || [];
  if (tasks.length) {
    L.push(`## Scheduled tasks (OS, read ${iso(ix.os_tasks.at)}) — owner project · ⚠ = may flash a console window`,
      '| task | status | fires | schedule | run as | owner | action |', '|---|---|---|---|---|---|---|');
    for (const t of tasks) {
      if (t.error) { L.push(`| (error) | ${cell(t.error)} | | | | | |`); continue; }
      if (t.status === 'Disabled' && !t.owner) continue;
      L.push(`| ${t.console ? '⚠ ' : ''}${cell(t.name).slice(0, 40)} | ${cell(t.status)} | ${t.fires} | ${cell(t.schedule).slice(0, 28)} | ${cell(t.run_as)} | ${cell(t.owner || '?')} | \`${cell(t.action).slice(0, 110)}\` |`);
    }
    L.push('');
  }

  if ((ix.skills || []).length) {
    L.push('## Skills installed');
    for (const sk of ix.skills) L.push(`- **${sk.name}** — ${cell(sk.description).slice(0, 150)}`);
    L.push('');
  }

  L.push('## Projects (most recently active first)', '');
  const list = Object.values(ix.projects).sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  for (const p of list) {
    const gs = Object.entries(p.groups).map(([g, n]) => `${g} (${n})`).join(', ') || 'none';
    const plan = (p.plan_files || []).reduce((n, f) => n + f.open, 0);
    L.push(`## ${p.name}`, '', `\`${p.path}\` · master: ${p.master ? p.master.sessionId : 'none'} · groups: ${gs} · ` +
      `${p.counts.active} active, ${p.counts.archived} archived, ${p.counts.ungrouped} ungrouped, ${p.counts.cli_only || 0} transcript-only · ` +
      `last ${require('./projects').ago(p.lastActivityAt)} ago` + (plan ? ` · ${plan} open plan items` : ''), '');
    if (p.claude_md) L.push(`CLAUDE.md: ${cell(p.claude_md).slice(0, 200)}`, '');
    for (const id of p.sessions) {
      const s = S[id];
      if (s.archived) continue;
      // `- 8hex | title | group | model | ...  #local_id` — owner.js readIndex() parses these lines
      L.push(`- ${id.replace(/^local_/, '').slice(0, 8)} | ${cell(s.title)} | ${cell(s.group || 'ungrouped')} | ${cell(s.model)} | ` +
        `${require('./projects').ago(s.lastActivityAt)} | ${ctxLabel(s)} | ${s.pending || '?'}${s.critical ? ' ⚠critical' : ''} #${id}` +
        (s.baton_master ? ' #master' : '') + (s.conductor ? ' #conductor' : ''));
    }
    if ((p.memory || []).length) L.push(`  memory (${p.memory.length}): ` + p.memory.slice(0, 6).map(m => m.split('](')[0].replace(/^\[/, '')).join(' · '));
    L.push('');
  }
  const loose = Object.values(S).filter(s => !s.project && !s.archived && s.in_sidebar);
  if (loose.length) {
    L.push('## (no folder)', '');
    for (const s of loose) L.push(`- ${s.id.replace(/^local_/, '').slice(0, 8)} | ${cell(s.title)} | ${cell(s.group || 'ungrouped')} | ${cell(s.model)} | ${require('./projects').ago(s.lastActivityAt)} #${s.id}`);
    L.push('');
  }
  return L.join('\n');
}

const fileName = n => String(n || 'unknown').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';

/** [[fileName, markdown]] — one page per project. */
function wikiPages(ix) {
  const S = ix.sessions, out = [];
  for (const p of Object.values(ix.projects)) {
    const L = [`# ${p.name} — \`${p.path}\``, ''];
    if (p.claude_md) L.push(`**CLAUDE.md head:** ${p.claude_md}`, '');
    if ((p.memory || []).length) { L.push('**Project memory index:**'); for (const m of p.memory) L.push('- ' + m); L.push(''); }
    if ((p.plan_files || []).length) {
      L.push('**Plan / status files:**');
      for (const f of p.plan_files) L.push(`- ${f.rel} (${iso(f.mtime)}) open ${f.open} / done ${f.done} — ${f.head}`);
      L.push('');
    }
    const ids = p.sessions.concat(p.cli_sessions || []);
    L.push(`## Sessions (${p.counts.active} live / ${p.counts.total} Desktop, ${p.counts.cli_only || 0} transcript-only), newest first`);
    for (const i of ids) {
      const s = S[i];
      L.push(`### ${s.id} — ${s.title}${s.archived ? ' (ARCHIVED)' : ''}${s.in_sidebar ? '' : ' (no Desktop row)'}`);
      L.push(`cli: ${s.cli || '—'}${(s.cli_chain || []).length > 1 ? ` (resumed chain of ${s.cli_chain.length})` : ''} · group: ${s.group || '—'} · last: ${iso(s.last)} · ` +
        `turns: ${s.turns} · ${ctxLabel(s)} · compactions: ${s.compactions} · model: ${s.model || '?'}/${s.effort || '?'}` +
        (s.worktree ? ` · branch ${s.branch}` : '') + (s.spawned_from ? ` · spawned by ${s.spawned_from}` : '') +
        ((s.children || []).length ? ` · fleet: ${s.children.length}` : '') + ` · pending: ${s.pending}${s.critical ? ' ⚠critical' : ''}`);
      if (s.buried) L.push(`**BURIED QUESTION** (${iso(s.buried_ts)}, hidden by ${s.buried_by || 'a notice'}): ${s.buried_ask}`);
      if (Object.keys(s.skills || {}).length) L.push('skills: ' + Object.entries(s.skills).map(([a, b]) => `${a}×${b}`).join(', '));
      if ((s.tags || []).length) L.push('tags: ' + s.tags.join(', '));
      for (const t of s.prompts || []) L.push(`- ${t}`);
      if (s.last_prompt && (!(s.prompts || []).length || s.last_prompt.slice(0, 60) !== s.prompts[s.prompts.length - 1].slice(0, 60))) L.push(`- (last) ${s.last_prompt}`);
      L.push('');
    }
    out.push([fileName(p.name), L.join('\n') + '\n']);
  }
  return out;
}

/** A self-contained, searchable map: groups → projects → sessions. No external resources. */
function mapHtml(ix) {
  const S = ix.sessions, tree = [];
  const groups = { ...(ix.groups || {}) };
  const cli = Object.values(S).filter(s => !s.in_sidebar).map(s => s.id);
  if (cli.length) groups['(no Desktop row)'] = { sessions: cli };
  for (const [g, gd] of Object.entries(groups)) {
    const byP = new Map();
    for (const i of gd.sessions) { const p = S[i].project || '(no folder)'; if (!byP.has(p)) byP.set(p, []); byP.get(p).push(i); }
    tree.push({ n: `${g} (${gd.sessions.length})`, k: [...byP].map(([pn, ids]) => ({ n: `${pn} (${ids.length})`, k: ids.map(i => {
      const s = S[i];
      return { n: String(s.title).slice(0, 80), d: `${s.id} · ${iso(s.last)} · ${ctxLabel(s)}` + ((s.children || []).length ? ` · fleet ${s.children.length}` : '') + (s.is_master ? ' · MASTER' : '') + ` · ${s.pending || ''}`,
        s: [(s.tags || []).join(' '), ...(s.prompts || []).slice(0, 4)].join(' ').slice(0, 600), f: s.ctx_flag || 'ok', m: !!s.is_master };
    }) })) });
  }
  const LS = new RegExp('[' + String.fromCharCode(0x2028) + String.fromCharCode(0x2029) + ']', 'g');
  const data = JSON.stringify(tree).replace(/</g, '\\u003c').replace(LS, ' ');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Session map</title>
<style>:root{--bg:#fafaf8;--fg:#1a1a1a;--mute:#666;--line:#ddd;--full:#b3261e;--tight:#b26a00;--star:#c47a00}
@media (prefers-color-scheme:dark){:root{--bg:#161616;--fg:#e8e8e8;--mute:#9a9a9a;--line:#333;--full:#ff8a80;--tight:#ffb74d;--star:#ffca28}}
body{font:13px/1.45 system-ui,sans-serif;margin:0;padding:16px;background:var(--bg);color:var(--fg)}h1{font-size:18px;margin:0 0 8px}
input{width:100%;box-sizing:border-box;padding:8px;font-size:14px;border:1px solid var(--line);border-radius:6px;margin:8px 0 14px;background:transparent;color:inherit}
details{margin-left:14px;border-left:1px solid var(--line);padding-left:8px}summary{cursor:pointer;padding:2px 0}.s{margin-left:22px;padding:3px 0}
.t{font-weight:600}.d{color:var(--mute);font-size:12px;word-break:break-all}.FULL .t{color:var(--full)}.tight .t{color:var(--tight)}.m .t::before{content:'★ ';color:var(--star)}small{color:var(--mute)}</style>
<h1>Session map <small>— groups → projects → sessions · built ${iso(ix.builtAt)} · ★ master · red = context estimate full (a hint)</small></h1>
<input id="q" placeholder="search titles, prompts, tags, ids…" autofocus><div id="root"></div>
<script>const T=${data};const root=document.getElementById('root');
function esc(s){return String(s||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
function render(q){q=(q||'').toLowerCase().trim();root.innerHTML='';for(const g of T){const dg=document.createElement('details');dg.open=!!q;let any=false;const sg=document.createElement('summary');sg.textContent=g.n;dg.appendChild(sg);
for(const p of g.k){const dp=document.createElement('details');dp.open=!!q;const sp=document.createElement('summary');sp.textContent=p.n;dp.appendChild(sp);let anyp=false;
for(const s of p.k){const hay=(s.n+' '+s.d+' '+s.s).toLowerCase();if(q&&!hay.includes(q))continue;anyp=true;const div=document.createElement('div');div.className='s '+s.f+(s.m?' m':'');div.innerHTML='<div class=t>'+esc(s.n)+'</div><div class=d>'+esc(s.d)+'</div>'+(q?'<div class=d>'+esc(s.s.slice(0,300))+'</div>':'');dp.appendChild(div);}
if(anyp){dg.appendChild(dp);any=true;}}if(any)root.appendChild(dg);}}
document.getElementById('q').addEventListener('input',e=>render(e.target.value));render('');</script></html>`;
}

// ------------------------------------------------------------------ reports
function findProject(ix, ref) {
  const want = String(ref || '').trim().toLowerCase();
  if (!want) return null;
  const list = Object.values(ix.projects || {});
  return list.find(p => p.name.toLowerCase() === want) || list.find(p => p.name.toLowerCase().includes(want)) || null;
}

/** One project: its plan files with open items, and every live session's plan → state → pending. */
function progress(ix, ref) {
  const p = findProject(ix, ref);
  if (!p) return { ok: false, error: 'NO_SUCH_PROJECT', message: `no project matches "${ref}"`, projects: Object.keys(ix.projects || {}) };
  const S = ix.sessions;
  const tag = { buried: 'BURIED ASK', asks: 'ASKS', open: 'OPEN', unanswered: 'UNANSWERED', running: 'running', ended: 'ended' };
  const sessions = p.sessions.map(i => S[i]).filter(s => !s.archived).map(s => ({
    id: s.id, title: s.title, group: s.group, last: s.last, pending: s.pending, critical: s.critical,
    plan: s.first_prompt || '', state: (s.final_text || '').slice(-220), buried_ask: s.buried ? s.buried_ask : undefined, ask: s.ask || undefined,
  }));
  const L = [`# ${p.name} — ${p.path}  (${p.counts.active} live sessions)`, ''];
  if ((p.plan_files || []).length) {
    L.push('## Plan / status files (newest first)');
    for (const f of p.plan_files) { L.push(`- ${f.rel}  (${iso(f.mtime)})  open ${f.open} / done ${f.done}  — ${f.head}`); for (const it of f.open_items.slice(0, 6)) L.push(`    [ ] ${it}`); }
    L.push('');
  }
  L.push('## Sessions — what was asked → where it stopped');
  for (const s of sessions) {
    L.push(`- ${short(s.id)} "${String(s.title).slice(0, 60)}" [${s.group || 'ungrouped'}] last ${iso(s.last)} ${tag[s.pending] || s.pending}${s.critical ? ' ⚠critical' : ''}`);
    if (s.plan) L.push(`    plan: ${s.plan.slice(0, 180)}`);
    if (s.buried_ask) L.push(`    buried ask: ${s.buried_ask.slice(-220)}`);
    if (s.state) L.push(`    state: ${s.state}`);
  }
  return { ok: true, project: p.name, path: p.path, plan_files: p.plan_files || [], sessions, text: L.join('\n') };
}

/** Every session (live or archived, Desktop or transcript-only) whose last ask a relay hid, within `days`. */
function buried(ix, days = 14) {
  const rows = Object.values(ix.sessions).filter(s => s.buried && ageOf(s.buried_ts) <= days)
    .sort((a, b) => String(b.buried_ts || '').localeCompare(String(a.buried_ts || '')));
  const live = rows.filter(s => s.in_sidebar && !s.archived);
  const L = [`buried questions in the last ${days} days: ${rows.length} sessions (${live.length} live in the sidebar, ${rows.filter(s => s.critical).length} critical) · ` +
    `notices seen in those sessions: ${rows.reduce((n, s) => n + (s.n_notices || 0), 0)}`];
  for (const s of rows) {
    L.push('', `${s.id}  "${String(s.title).slice(0, 64)}"  [${s.group || (s.in_sidebar ? 'Ungrouped' : 'no Desktop row')}]${s.archived ? ' (archived)' : ''}`,
      `   asked ${iso(s.buried_ts)} · hidden by ${s.buried_by || 'a notice'} (+${Math.max(0, (s.buried_notices || 1) - 1)} more) · last active ${iso(s.last)}`,
      `   ask: ${String(s.buried_ask).slice(-240)}`);
    if (s.final_text) L.push(`   then ended with: ${s.final_text.slice(-160)}`);
  }
  return { ok: true, days, count: rows.length, live: live.length, critical: rows.filter(s => s.critical).length,
    rows: rows.map(s => ({ id: s.id, title: s.title, group: s.group, archived: s.archived, in_sidebar: s.in_sidebar, buried_ts: s.buried_ts,
      buried_by: s.buried_by, notices: s.buried_notices, ask: s.buried_ask, critical: s.critical })), text: L.join('\n') };
}

/** A session card: identity (both ids), context, pending, tags, fleet, prompts. */
function card(ix, ref) {
  const hits = findSessions(ix, ref);
  if (!hits.length) return { ok: false, error: 'NO_SUCH_SESSION', message: `no session matches "${ref}"` };
  const S = ix.sessions;
  const cards = hits.slice(0, 3).map(s => ({
    id: s.id, cli: s.cli, cli_chain: s.cli_chain, title: s.title, project: s.project, cwd: s.cwd, group: s.group,
    in_sidebar: s.in_sidebar, archived: s.archived, model: s.model, effort: s.effort, created: s.createdAt ? new Date(s.createdAt).toISOString() : null,
    last: s.last, last_user_ts: s.last_user_ts, turns: s.turns,
    context: { est_tokens: s.est_ctx_tokens, flag: s.ctx_flag, verified: s.ctx_verified, compactions: s.compactions, exceeded: s.context_exceeded, note: s.ctx_note || undefined, label: ctxLabel(s) },
    pending: s.pending, ask: s.ask || undefined, critical: s.critical, awaiting_signal: s.awaiting_signal,
    buried: s.buried ? { ask: s.buried_ask, at: s.buried_ts, by: s.buried_by, notices: s.buried_notices } : undefined,
    dots: { running: s.running, awaiting: s.awaiting, unread: s.unread },
    tags: s.tags, manual_tags: s.manual_tags, skills: s.skills, errors: s.errors, error: s.error || undefined,
    fleet: { parent: s.spawned_from ? { id: s.spawned_from, title: (S[s.spawned_from] || {}).title || null } : null,
      children: (s.children || []).map(i => ({ id: i, title: S[i].title, pending: S[i].pending })), is_master: s.is_master,
      why_master: s.baton_master ? 'Relaymote claim' : s.master_by_title ? 'title says master' : (s.children || []).length >= 3 ? '>= 3 children' : undefined },
    forked_from: s.forked_from || undefined, scheduled_task: s.scheduled_task || undefined,
    first_prompt: s.first_prompt, last_prompt: s.last_prompt, prompts: s.prompts, final_text: s.final_text,
  }));
  return { ok: true, matches: hits.length, cards };
}

/** The fleet under a session (spawnedFrom chain), as indented lines. Cycle-safe. */
function tree(ix, ref) {
  const hits = findSessions(ix, ref);
  if (!hits.length) return { ok: false, error: 'NO_SUCH_SESSION', message: `no session matches "${ref}"` };
  const S = ix.sessions, lines = [], seen = new Set();
  const rec = (s, d) => {
    if (seen.has(s.id) || d > 12) return;
    seen.add(s.id);
    lines.push('  '.repeat(d) + sessLine(s) + `  ${s.id}`);
    for (const c of (s.children || []).slice(0, 30)) if (S[c]) rec(S[c], d + 1);
  };
  for (const s of hits.slice(0, 3)) rec(s, 0);
  return { ok: true, text: lines.join('\n'), lines };
}

/** Relaymote master claims and the living masters of every group. */
function masters(ix) {
  const S = ix.sessions;
  const claimed = Object.entries(ix.relaymote_masters || {}).map(([key, m]) => {
    const s = S[m.sessionId];
    return { key, sessionId: m.sessionId, scope: m.scope, expiresAt: m.expiresAt, title: s ? s.title : null, context: s ? ctxLabel(s) : null, fleet: s ? (s.children || []).length : 0 };
  });
  const byGroup = {};
  for (const [g, gd] of Object.entries(ix.groups || {})) {
    if ((gd.living_masters || []).length) byGroup[g] = gd.living_masters.slice(0, 4).map(i => ({ id: i, title: S[i].title, line: sessLine(S[i]) }));
  }
  const L = ['Relaymote-claimed masters:'].concat(claimed.length ? claimed.map(c => `  ${c.sessionId} | ${c.key} | ${String(c.scope || '').slice(0, 70)} | ${c.context || 'no row'} · fleet ${c.fleet}`) : ['  none']);
  L.push('', 'Masters per group (live, newest first; claim, title or >= 3 children):');
  for (const [g, ms] of Object.entries(byGroup)) { L.push(`  [${g}]`); for (const m of ms) L.push(`    ${m.line}  ${m.id}`); }
  return { ok: true, claimed, byGroup, text: L.join('\n') };
}

module.exports = { indexMd, wikiPages, mapHtml, progress, buried, card, tree, masters, waiting, sessLine, ctxLabel, findProject, fileName };
