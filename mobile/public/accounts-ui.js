(function () {
  'use strict';

  var PANEL_ID = 'accounts-panel';
  var state = null, plan = null, cycle = null, busy = false, msg = '';

  var MODE_TEXT = {
    keep: 'Keep this account as it is',
    add: 'Add the other accounts’ data into this one',
    'two-way': 'Two-way: both end up with everything'
  };
  var KIND_TEXT = { records: 'sessions', archive: 'archive marks', state: 'session details', routines: 'routines', groups: 'sidebar groups', assignments: 'group placements', deletes: 'removals' };

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function btn(text, cls, on) {
    var b = el('button', cls || 'acct-btn', text);
    b.disabled = busy;
    b.addEventListener('click', on);
    return b;
  }
  function api(path, body) {
    var opts = { credentials: 'same-origin' };
    if (body) { opts.method = 'POST'; opts.headers = { 'Content-Type': 'application/json' }; opts.body = JSON.stringify(body); }
    return fetch(path, opts).then(function (r) { return r.json(); });
  }
  function counts(c) {
    var out = [];
    Object.keys(c || {}).forEach(function (k) { if (c[k]) out.push(c[k] + ' ' + (KIND_TEXT[k] || k)); });
    return out.join(', ');
  }
  function sum(c) { var n = 0; Object.keys(c || {}).forEach(function (k) { n += c[k] || 0; }); return n; }
  function when(iso) { return iso ? new Date(iso).toLocaleString() : 'never'; }

  function load() {
    return api('/api/accounts').then(function (d) { state = d; render(); return d; })
      .catch(function (e) { state = { ok: false, error: e.message }; render(); });
  }
  function act(fn) {
    if (busy) return;
    busy = true; msg = ''; render();
    Promise.resolve().then(fn).catch(function (e) { msg = 'Request failed: ' + e.message; })
      .then(function () { busy = false; return load(); });
  }
  function saveSettings(patch) { act(function () { plan = null; return api('/api/accounts/settings', patch); }); }

  function preview(opts) {
    act(function () {
      return api('/api/accounts/sync', Object.assign({ dryRun: true }, opts)).then(function (r) { plan = { opts: opts, result: r }; });
    });
  }
  function syncNow() {
    var opts = plan && plan.opts || {};
    act(function () {
      return api('/api/accounts/sync', Object.assign({ dryRun: false }, opts)).then(function (r) {
        plan = null;
        msg = r.ok ? (r.applied && r.changeCount ? r.changeCount + ' change(s) written.' : 'Nothing to write.') +
                     (r.pendingCount ? ' ' + r.pendingCount + ' wait until Claude Desktop is closed.' : '')
                   : (r.lines && r.lines[0]) || r.error || 'Sync failed.';
      });
    });
  }
  function runCycle(extra) {
    var opts = Object.assign({}, plan && plan.opts || {}, extra || {});
    act(function () {
      return api('/api/accounts/cycle', opts).then(function (r) {
        cycle = (r.needsConfirm || r.needsForceConfirm || r.manual) ? { opts: opts, result: r } : null;
        if (r.log) msg = r.log.join(' · ');
        else if (!cycle) msg = r.message || r.error || '';
        if (r.ok) plan = null;
      });
    });
  }

  function scopeList(s) {
    return (s.scopes || []);
  }
  function setIncluded(key, on) {
    var all = scopeList(state).map(function (s) { return s.key; });
    var cur = scopeList(state).filter(function (s) { return s.included; }).map(function (s) { return s.key; });
    var next = on ? cur.concat([key]) : cur.filter(function (k) { return k !== key; });
    saveSettings({ scope: next.length === all.length ? 'all' : next });
  }

  function card(s) {
    var c = el('div', 'acct-card' + (s.active ? ' acct-active' : '') + (s.included ? '' : ' acct-off'));
    var head = el('div', 'acct-head');
    head.appendChild(el('strong', null, s.label));
    if (s.active) head.appendChild(el('span', 'acct-badge', 'in use'));
    else if (s.live) head.appendChild(el('span', 'acct-badge', 'open in Claude'));
    c.appendChild(head);
    if (s.identity && s.identity.email && s.identity.email !== s.label) c.appendChild(el('div', 'acct-sub', s.identity.email));

    var stats = el('div', 'acct-stats');
    [[s.records, 'sessions'], [s.archived, 'archived'], [s.routines, 'routines'], [s.groups, 'groups']].forEach(function (p) {
      if (p[0] != null) stats.appendChild(el('span', null, p[0] + ' ' + p[1]));
    });
    c.appendChild(stats);

    var now = sum(s.changes), later = sum(s.pending);
    if (s.included && (now || later)) {
      c.appendChild(el('div', 'acct-drift', (now ? 'To bring in: ' + counts(s.changes) + '. ' : '') +
        (later ? 'Waiting for Claude to close: ' + counts(s.pending) + '.' : '')));
    } else if (s.included) c.appendChild(el('div', 'acct-sub', 'Up to date.'));

    var row = el('div', 'acct-row');
    var lab = el('label', 'acct-check');
    var cb = el('input'); cb.type = 'checkbox'; cb.checked = !!s.included; cb.disabled = busy;
    cb.addEventListener('change', function () { setIncluded(s.key, cb.checked); });
    lab.appendChild(cb); lab.appendChild(document.createTextNode(' Sync this account'));
    row.appendChild(lab);
    var sel = el('select', 'acct-select'); sel.disabled = busy || !s.included;
    [['', 'Use the default'], ['keep', MODE_TEXT.keep], ['add', MODE_TEXT.add], ['two-way', MODE_TEXT['two-way']]].forEach(function (o) {
      var op = el('option', null, o[1]); op.value = o[0]; sel.appendChild(op);
    });
    var roles = (state.settings && state.settings.roles) || {};
    sel.value = roles[s.key] || '';
    sel.addEventListener('change', function () { var r = {}; r[s.key] = sel.value || null; saveSettings({ roles: r }); });
    row.appendChild(sel);
    c.appendChild(row);

    var acts = el('div', 'acct-row');
    acts.appendChild(btn('Rename', 'acct-btn acct-small', function () {
      var v = prompt('A name for this account (for example Work or Personal):', s.label);
      if (v != null) act(function () { return api('/api/accounts/label', { scope: s.key, label: v.trim() }); });
    }));
    if (!s.active && s.included) {
      acts.appendChild(btn('Copy my sessions into this account', 'acct-btn acct-small', function () { preview({ target: s.key, mode: 'add' }); }));
    }
    c.appendChild(acts);
    return c;
  }

  function settingsBox() {
    var st = state.settings || {};
    var box = el('details', 'acct-box');
    box.appendChild(el('summary', null, 'Settings'));
    var on = el('label', 'acct-check');
    var cb = el('input'); cb.type = 'checkbox'; cb.checked = st.enabled !== false; cb.disabled = busy;
    cb.addEventListener('change', function () { saveSettings({ enabled: cb.checked }); });
    on.appendChild(cb); on.appendChild(document.createTextNode(' Account sync is on'));
    box.appendChild(on);

    var sc = el('div', 'acct-sub', st.scope === 'all' || !Array.isArray(st.scope)
      ? 'Syncing all accounts on this computer. Untick an account above to leave it out.'
      : 'Syncing only the ticked accounts.');
    box.appendChild(sc);
    if (Array.isArray(st.scope)) box.appendChild(btn('Sync all accounts on this computer', 'acct-btn acct-small', function () { saveSettings({ scope: 'all' }); }));

    var mrow = el('label', 'acct-row');
    mrow.appendChild(document.createTextNode('Default: '));
    var ms = el('select', 'acct-select'); ms.disabled = busy;
    ['add', 'two-way'].forEach(function (m) { var op = el('option', null, MODE_TEXT[m]); op.value = m; ms.appendChild(op); });
    ms.value = st.mode || 'add';
    ms.addEventListener('change', function () { saveSettings({ mode: ms.value }); });
    mrow.appendChild(ms);
    box.appendChild(mrow);

    var arow = el('label', 'acct-check');
    var ac = el('input'); ac.type = 'checkbox'; ac.checked = !!st.autoSync; ac.disabled = busy;
    ac.addEventListener('change', function () { saveSettings({ autoSync: ac.checked }); });
    arow.appendChild(ac); arow.appendChild(document.createTextNode(' Sync by itself every '));
    var iv = el('input', 'acct-num'); iv.type = 'number'; iv.min = 5; iv.value = st.intervalMinutes || 30; iv.disabled = busy;
    iv.addEventListener('change', function () { saveSettings({ intervalMinutes: Number(iv.value) }); });
    arow.appendChild(iv); arow.appendChild(document.createTextNode(' minutes, and when Claude closes'));
    box.appendChild(arow);
    return box;
  }

  function check(label, on, patch, note) {
    var row = el('label', 'acct-check');
    var c = el('input'); c.type = 'checkbox'; c.checked = !!on; c.disabled = busy;
    c.addEventListener('change', function () { patch(c.checked); });
    row.appendChild(c); row.appendChild(document.createTextNode(' ' + label));
    var wrap = el('div'); wrap.appendChild(row);
    if (note) wrap.appendChild(el('div', 'acct-sub', note));
    return wrap;
  }
  function advancedBox() {
    var st = state.settings || {}, adv = state.advanced || {};
    var box = el('details', 'acct-box');
    box.appendChild(el('summary', null, 'Advanced'));
    box.appendChild(check('Carry archive marks', st.syncArchive !== false, function (v) { saveSettings({ syncArchive: v }); },
      'Archiving a session in one account archives it in the others. The newest change wins; a clash with no clear order is left alone.'));
    box.appendChild(check('Carry session details (model, effort, unread)', st.syncState !== false, function (v) { saveSettings({ syncState: v }); },
      'Between subscription accounts only. A usage-limit error is cleared, never copied.'));
    box.appendChild(check('Fold sidebar groups across accounts', !!st.foldGroups, function (v) { saveSettings({ foldGroups: v }); },
      'Off: each account keeps its own groups (they are still repaired if Claude loses them). On: every account gets every group.'));
    box.appendChild(check('Hold session details', !!adv.hold, function (v) { act(function () { return api('/api/accounts/hold', { on: v }); }); },
      'Pauses the session-details part only; sessions, archive marks and routines still sync.'));

    var fr = el('label', 'acct-row');
    fr.appendChild(document.createTextNode('First sync, when two accounts disagree on an archive mark: '));
    var fs = el('select', 'acct-select'); fs.disabled = busy;
    [['baseline', 'leave it alone'], ['archived-wins', 'archive it everywhere']].forEach(function (o) { var op = el('option', null, o[1]); op.value = o[0]; fs.appendChild(op); });
    fs.value = st.firstRunMode || 'baseline';
    fs.addEventListener('change', function () { saveSettings({ firstRunMode: fs.value }); });
    fr.appendChild(fs); box.appendChild(fr);

    var ids = Object.keys(adv.frozen || {});
    box.appendChild(el('div', 'acct-sub', ids.length ? 'Sessions that keep their own details:' : 'No session is excluded from the details sync.'));
    ids.forEach(function (id) {
      var r = el('div', 'acct-row'); r.appendChild(el('span', 'acct-sub', id + ' - ' + adv.frozen[id]));
      r.appendChild(btn('Include again', 'acct-btn acct-small', function () { act(function () { return api('/api/accounts/freeze', { id: id, on: false }); }); }));
      box.appendChild(r);
    });
    box.appendChild(btn('Exclude a session…', 'acct-btn acct-small', function () {
      var v = window.prompt('Session record id (local_…)');
      if (v) act(function () { return api('/api/accounts/freeze', { id: v.trim() }).then(function (r) { if (r && r.ok === false) msg = r.error; }); });
    }));

    var ur = el('div', 'acct-row');
    ur.appendChild(btn('Undo the last sync', 'acct-btn acct-small', function () {
      if (window.confirm('Undo the last sync? Claude Desktop must be closed.')) act(function () { return api('/api/accounts/undo', {}).then(function (r) { msg = r.ok ? 'Undone: ' + r.reversed + ' change(s).' : (r.message || r.error); }); });
    }));
    box.appendChild(ur);
    (adv.groupBackups || []).forEach(function (b) {
      var r = el('div', 'acct-row'); r.appendChild(el('span', 'acct-sub', 'Groups backup ' + b.stamp + ' (' + (b.store || '1p') + ', ' + (b.reason || '') + ')'));
      r.appendChild(btn('Restore', 'acct-btn acct-small', function () {
        if (window.confirm('Put the sidebar groups back as they were at ' + b.stamp + '? What is there now is backed up first.')) act(function () { return api('/api/accounts/groups-restore', { stamp: b.stamp }).then(function (x) { msg = x.ok ? 'Groups restored.' : (x.message || x.error); }); });
      }));
      box.appendChild(r);
    });

    var hook = adv.launchHook;
    if (hook && hook.supported) {
      box.appendChild(check('Start Claude through Relaymote', !!hook.installed, function (v) { act(function () { return api('/api/accounts/launch-hook', { on: v }).then(function (r) { if (r.ok === false) msg = r.message || r.error; }); }); },
        'At sign-in Relaymote runs the repair pass first (at most 150 s), then starts Claude. Untick to put Claude’s own startup entry back.'));
    }
    box.appendChild(el('div', 'acct-sub', 'Lock file: ' + (adv.lockFile || '') + '. Only one sync tool may write: switch the others off before turning on automatic sync.'));
    return box;
  }

  function addAccountBox() {
    var box = el('details', 'acct-box');
    box.appendChild(el('summary', null, 'Add an account'));
    var ol = el('ol', 'acct-steps');
    ['In Claude Desktop, log out, then log in with the other account.',
     'Open the Code tab once, so Claude makes the new account’s folder.',
     'Come back here. The new account shows up in the list above.',
     'Press “Copy my sessions into this account” on it (or pick Two-way), check the preview, then Sync now.'
    ].forEach(function (t) { ol.appendChild(el('li', null, t)); });
    box.appendChild(ol);
    box.appendChild(el('div', 'acct-sub', 'The account you are signed in to is only written while Claude is closed. Use “Close Claude, sync, reopen Claude” below to do it in one go.'));
    return box;
  }

  function planBox() {
    var r = plan.result, box = el('div', 'acct-plan');
    var who = plan.opts.target ? 'Into ' + ((scopeList(state).find(function (s) { return s.key === plan.opts.target; }) || {}).label || 'the chosen account') + ' only. ' : '';
    if (!r.ok) box.appendChild(el('div', 'acct-armed', (r.lines && r.lines[0]) || r.error || 'Preview failed.'));
    else if (!r.changeCount && !r.pendingCount) box.appendChild(el('div', 'acct-ok', who + 'Nothing to change - the accounts already match.'));
    else {
      box.appendChild(el('div', null, who + (r.changeCount ? 'Sync now would write ' + counts(r.totals.now) + '.' : 'Nothing can be written right now.')));
      if (r.pendingCount) box.appendChild(el('div', 'acct-armed', counts(r.totals.pending) + ' wait until Claude Desktop is closed.'));
      var det = el('details'); det.appendChild(el('summary', null, 'Details'));
      det.appendChild(el('pre', 'acct-log', (r.lines || []).join('\n') || '-'));
      box.appendChild(det);
      if (r.changeCount) box.appendChild(btn('Sync now', 'acct-btn acct-go', syncNow));
    }
    box.appendChild(btn('Cancel', 'acct-btn acct-small', function () { plan = null; render(); }));
    return box;
  }

  function cycleBox() {
    var r = cycle.result, box = el('div', 'acct-plan');
    if (r.manual) {
      box.appendChild(el('div', null, r.message || 'Do it by hand:'));
      var ol = el('ol', 'acct-steps'); (r.steps || state.manualSteps || []).forEach(function (t) { ol.appendChild(el('li', null, t)); });
      box.appendChild(ol);
    } else if (r.needsConfirm) {
      box.appendChild(el('div', r.running && r.running.length ? 'acct-armed' : 'acct-ok', r.message));
      if (r.snapshotWarning) box.appendChild(el('div', 'acct-armed', r.snapshotWarning));
      if (r.running && r.running.length) {
        var ul = el('ul', 'acct-steps');
        r.running.forEach(function (s) { ul.appendChild(el('li', null, (s.title || s.id) + (s.awaiting ? ' (waiting for you)' : ' (working)'))); });
        box.appendChild(ul);
      }
      box.appendChild(btn(r.running && r.running.length ? 'Stop them, close Claude and sync' : 'Close Claude and sync', 'acct-btn acct-go',
        function () { runCycle(Object.assign({}, cycle.opts, { confirm: r.confirm })); }));
    } else if (r.needsForceConfirm) {
      box.appendChild(el('div', 'acct-armed', r.message));
      box.appendChild(btn('Force-close Claude', 'acct-btn acct-danger', function () {
        runCycle(Object.assign({}, cycle.opts, { confirm: cycle.opts.confirm, force: true, forceConfirm: r.forceConfirm }));
      }));
    }
    box.appendChild(btn('Cancel', 'acct-btn acct-small', function () { cycle = null; render(); }));
    return box;
  }

  function render() {
    var host = document.getElementById(PANEL_ID);
    if (!host) return;
    host.innerHTML = '';
    if (!state) { host.appendChild(el('div', 'muted', 'Loading accounts…')); return; }
    if (!state.ok && !state.scopes) { host.appendChild(el('div', 'muted', 'Accounts unavailable: ' + (state.error || ''))); return; }

    host.appendChild(el('p', 'acct-sub', 'Use more than one Claude account? Relaymote keeps them looking the same: your sessions, archive marks ' +
      'and routines are copied between the accounts on this computer, and each account’s sidebar groups are kept from being lost. Nothing is deleted, and a backup is kept before every change.'));
    if (state.writableNote) host.appendChild(el('div', 'acct-sub', state.writableNote));
    if (state.verdict && state.verdict.ok === false) host.appendChild(el('div', 'acct-armed', 'Claude Desktop replaced the sidebar groups Relaymote wrote (checked ' + when(state.verdict.at) + '). Restore them under Advanced, or sync again with Claude closed.'));
    if (state.settings && state.settings.enabled === false) host.appendChild(el('div', 'acct-armed', 'Account sync is switched off (Settings below).'));

    var scopes = scopeList(state);
    if (!scopes.length) host.appendChild(el('div', 'muted', (state.lines && state.lines[0]) || 'No Claude Desktop accounts found on this computer.'));
    scopes.forEach(function (s) { host.appendChild(card(s)); });

    if (msg) host.appendChild(el('div', 'acct-ok', msg));
    if (plan) host.appendChild(planBox());
    if (cycle) host.appendChild(cycleBox());

    if (!plan && !cycle && scopes.length > 1) {
      var acts = el('div', 'acct-row');
      acts.appendChild(btn(busy ? 'Working…' : 'Preview sync', 'acct-btn acct-go', function () { preview({}); }));
      acts.appendChild(btn('Close Claude, sync, reopen Claude', 'acct-btn', function () {
        if (!state.cycleSupported) { cycle = { opts: {}, result: { manual: true, steps: state.manualSteps, message: 'On this computer Relaymote cannot close and reopen Claude Desktop for you. Do it by hand:' } }; render(); return; }
        runCycle({});
      }));
      host.appendChild(acts);
    }

    host.appendChild(addAccountBox());
    host.appendChild(settingsBox());
    host.appendChild(advancedBox());

    var foot = el('div', 'acct-foot');
    var last = state.lastSync || {};
    foot.appendChild(el('div', 'acct-sub', 'Last sync: ' + when(last.appliedAt) + (state.auto && state.auto.last && state.auto.last.at ? ' · last automatic check: ' + when(state.auto.last.at) : '')));
    if (state.groupsSupported === false) foot.appendChild(el('div', 'acct-sub', 'Sidebar groups are not synced here (an optional part is not installed).'));
    host.appendChild(foot);
  }

  window.AccountsUI = {
    mount: function (container) {
      if (!container) return;
      if (!document.getElementById(PANEL_ID)) {
        var wrap = el('section', 'acct-wrap');
        wrap.appendChild(el('h3', 'acct-title', 'Accounts'));
        var host = el('div');
        host.id = PANEL_ID;
        wrap.appendChild(host);
        container.appendChild(wrap);
      }
      render();
      load();
    },
    refresh: load
  };

  document.addEventListener('DOMContentLoaded', function () {
    var slot = document.getElementById('accounts-slot');
    if (slot) window.AccountsUI.mount(slot);
  });
})();
