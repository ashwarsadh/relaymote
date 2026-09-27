// goals-ui.js — the Goals sheet: the goal register, what each goal is waiting on, and a one-line add.
(function () {
  'use strict';

  const G = { data: null, busy: false };
  const LABEL = {
    'VERIFY-NOW': 'verify now', 'AWAITING-VERIFICATION': 'awaiting check', DELIVERED: 'reported done', ORPHAN: 'no owner',
    UNTOLD: 'handing over', UNRESPONSIVE: 'not answering', 'BLOCKED-STALE': 'blocked a week', BLOCKED: 'blocked',
    LATE: 'late', STUCK: 'stuck', OFFLINE: 'owner offline', 'HANDED-OVER': 'handed over', WATCH: 'watching', FRESH: 'in progress',
  };
  const BAD = new Set(['VERIFY-NOW', 'DELIVERED', 'ORPHAN', 'UNRESPONSIVE', 'BLOCKED-STALE', 'LATE']);

  function ensureDom() {
    if ($('view-goals')) return;
    const s = document.createElement('section');
    s.id = 'view-goals'; s.className = 'sheet hidden';
    s.setAttribute('role', 'dialog'); s.setAttribute('aria-modal', 'true'); s.setAttribute('aria-label', 'Goals');
    s.innerHTML = '<div class="sheet-body"><div class="grab"></div>'
      + '<h2>Goals <span id="goals-meta" class="board-built"></span></h2>'
      + '<div id="goals-stats" class="goals-stats"></div>'
      + '<form id="goals-add" class="goals-add" autocomplete="off">'
      + '<input id="goals-title" type="text" placeholder="New goal: what does done look like?" enterkeyhint="done">'
      + '<input id="goals-project" type="text" placeholder="Project (optional)" list="goals-projects">'
      + '<datalist id="goals-projects"></datalist>'
      + '<button class="bbtn b-yes" type="submit">Add</button></form>'
      + '<div id="goals-list" class="board-list"><div class="empty">Loading…</div></div>'
      + '<div class="sheet-actions"><button id="btn-goals-refresh" class="ghost">Refresh</button>'
      + '<button id="btn-close-goals" class="ghost">Done</button></div></div>';
    document.body.appendChild(s);
    $('goals-add').onsubmit = (e) => { e.preventDefault(); addGoal(); };
    $('btn-goals-refresh').onclick = load;
    $('btn-close-goals').onclick = () => hideSheet($('view-goals'));
    $('goals-list').addEventListener('click', onListClick);
  }

  function ago(iso) {
    const t = Date.parse(iso || ''); if (!t) return '';
    const m = Math.round((Date.now() - t) / 60000);
    return m < 60 ? m + 'm' : m < 2880 ? Math.round(m / 60) + 'h' : Math.round(m / 1440) + 'd';
  }

  function card(g) {
    const open = g.status === 'open';
    const cond = g.condition;
    const meta = [];
    const lbl = cond === 'OFFLINE' && g.ownerState === 'unknown' ? 'desktop not connected' : (LABEL[cond] || cond);
    if (open && cond) meta.push('<span class="b-tag' + (BAD.has(cond) ? ' gbad' : '') + '">' + esc(lbl) + '</span>');
    if (!open) meta.push('<span class="b-tag">' + esc(g.status) + '</span>');
    if (g.project) meta.push('<span>' + esc(g.project) + '</span>');
    meta.push('<span>' + esc(g.ownerTitle ? 'owner: ' + g.ownerTitle.slice(0, 40) : g.ownerSessionId ? 'owner: ' + g.ownerSessionId.slice(0, 14) + '…' : 'no owner yet') + '</span>');
    if (g.due) meta.push('<span>due ' + esc(g.due.slice(0, 10)) + '</span>');
    if (open) meta.push('<span>' + (g.lastProgressAt ? 'report ' + ago(g.lastProgressAt) + ' ago' : 'no report yet') + '</span>');
    if (open && g.verifyBy) meta.push('<span>verify ' + esc(String(g.verifyBy).slice(0, 10)) + (g.verifyWhat ? ': ' + esc(String(g.verifyWhat).slice(0, 60)) : '') + '</span>');
    if (!open && g.closedAt) meta.push('<span>' + esc(ago(g.closedAt)) + ' ago</span>');
    if (g.chases) meta.push('<span>' + g.chases + ' reminder' + (g.chases === 1 ? '' : 's') + '</span>');
    const note = g.blockedOn ? 'Blocked: ' + g.blockedOn : !open ? (g.outcome || '') : (g.progress || '');
    return '<div class="gcard' + (open && BAD.has(cond) ? ' gcard-over' : '') + '" data-id="' + esc(g.id) + '">'
      + '<div class="gtitle"><b>' + esc(g.id) + '</b> ' + esc(g.title) + '</div>'
      + '<div class="gmeta">' + meta.join('') + '</div>'
      + (note ? '<div class="gnote">' + esc(note) + '</div>' : '')
      + '<div class="bcard-acts">'
      + (g.ownerSessionId ? '<button class="bbtn" data-open="' + esc(g.ownerSessionId) + '">Open owner</button>' : '')
      + (open && (cond === 'DELIVERED' || cond === 'VERIFY-NOW') ? '<button class="bbtn" data-goal="judged">Judge back</button>' : '')
      + (open && !g.verifyBy ? '<button class="bbtn" data-goal="verify">Verify by…</button>' : '')
      + (open ? '<button class="bbtn b-done" data-goal="done">' + (g.deliveredAt ? 'Close ✓' : 'Done ✓') + '</button><button class="bbtn" data-goal="dropped">Drop</button>'
              : '<button class="bbtn" data-goal="reopen">Reopen</button>')
      + '</div></div>';
  }

  function render() {
    const d = G.data;
    if (!d) return;
    const c = d.counts || {}, p = d.last24h || {};
    $('goals-meta').textContent = (c.open || 0) + ' open';
    const bits = [
      (c.unrouted ? c.unrouted + ' without an owner' : ''),
      (c.late ? c.late + ' late' : ''),
      (c.blocked ? c.blocked + ' blocked' : ''),
      'last 24h: ' + (p.handover || 0) + ' handed over · ' + ((p.warm || 0) + (p.stuck || 0)) + ' warm/stuck nudges · ' + (p.cold || 0) + ' cold wakes'
        + (p.failed ? ' · ' + p.failed + ' failed' : ''),
    ].filter(Boolean);
    if (d.modules && !d.modules.goalChaser) bits.unshift('Goal chaser is off: goals are listed but nobody is nudged');
    $('goals-stats').textContent = bits.join(' · ');
    const all = d.goals || [];
    const open = all.filter(g => g.status === 'open');
    const closed = all.filter(g => g.status !== 'open').slice(-20).reverse();
    $('goals-list').innerHTML = (open.length ? open.map(card).join('')
      : '<div class="empty">No open goals. Add one above, or let a master add them with relaymote_goal_add.</div>')
      + (closed.length ? '<details class="goals-done"><summary>Finished <span class="n">' + closed.length + '</span></summary>'
        + closed.map(card).join('') + '</details>' : '');
  }

  async function load() {
    try { G.data = await api('/api/goals'); render(); }
    catch (e) { $('goals-list').innerHTML = '<div class="empty">Could not load goals: ' + esc(e.message) + '</div>'; }
  }

  async function post(body, okMsg) {
    if (G.busy) return;
    G.busy = true;
    try {
      const r = await api('/api/goals', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      toast(typeof okMsg === 'function' ? okMsg(r) : okMsg);
      await load();
    } catch (e) { toast('Not saved: ' + e.message, true); }
    finally { G.busy = false; }
  }

  function addGoal() {
    const title = $('goals-title').value.trim();
    if (!title) { $('goals-title').focus(); return; }
    const project = $('goals-project').value.trim();
    post({ action: 'add', title, project: project || undefined }, (r) => (r && r.goal && r.goal.ownerSessionId)
      ? 'Goal added — its owner is told in the next cycle' : 'Goal added — no session owns it yet, so it waits on the Board')
      .then(() => { $('goals-title').value = ''; });
  }

  function onListClick(e) {
    const open = e.target.closest('[data-open]');
    if (open) { hideSheet($('view-goals')); navOpenFrom(open.dataset.open); return; }
    const b = e.target.closest('button[data-goal]');
    if (!b) return;
    const id = b.closest('.gcard').dataset.id, act = b.dataset.goal;
    if (act === 'verify') {
      const date = window.prompt('Verify on which date? (YYYY-MM-DD)', '');
      if (date == null || !date.trim()) return;
      const what = window.prompt('What will you check that day?', '') || '';
      post({ action: 'verify', id, verify_by: date.trim(), what }, 'Verification date set');
      return;
    }
    const ask = act === 'done' ? 'What shows it is done?' : act === 'reopen' ? 'Why reopen it?' : act === 'judged' ? 'What is still missing?' : null;
    let note = '';
    if (ask) { note = window.prompt(ask, ''); if (note == null || !note.trim()) return; }
    post({ action: act, id, note }, act === 'done' ? 'Closed' : act === 'dropped' ? 'Dropped' : act === 'judged' ? 'Sent back to its owner' : 'Reopened');
  }

  async function openGoals() {
    ensureDom();
    if (typeof drawer === 'function') drawer(false);
    showSheet($('view-goals'));
    await load();
    try {
      const ix = await api('/api/projects');
      $('goals-projects').innerHTML = Object.keys(ix.projects || {}).sort().map(n => '<option value="' + esc(n) + '">').join('');
    } catch {}
  }

  document.addEventListener('keydown', (e) => {
    const v = $('view-goals');
    if (e.key === 'Escape' && v && !v.classList.contains('hidden')) { e.stopPropagation(); hideSheet(v); }
  }, true);
  const btn = $('btn-goals');
  if (btn) btn.onclick = openGoals;
  if (location.hash === '#goals') window.addEventListener('load', openGoals);
  window.addEventListener('hashchange', () => { if (location.hash === '#goals') openGoals(); });
  window.openGoals = openGoals;
})();
