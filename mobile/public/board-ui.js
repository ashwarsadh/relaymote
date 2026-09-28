(function () {
  'use strict';

  // ONE predicate for showing a card AND counting its chip, so a chip never promises more (or less) than
  // it shows. The server's header counts (mobile/board.js) require this same object. No age cut-off by
  // default: a lane waiting two weeks needs you more than one waiting two days. A day chip you pick
  // filters EVERY card, For-you cards included (their age comes from ts); the list then says how many
  // older ones it is holding back, with one tap to show them (#board-older).
  const FINISHED = ['done', 'closed', 'failed', 'dropped'];
  const Filter = {
    FINISHED,
    isDone: (r) => !!(r && (r.acted || r.handled)),
    isInbox: (r) => !!r && r.n != null && !r.bucket,
    /** Days since the item arrived: the row's own age, else from its ts; null when neither is known. */
    ageOf: (r, now = Date.now()) => {
      if (r.age != null) return r.age;
      const t = r.ts ? Date.parse(r.ts) : NaN;
      return isNaN(t) ? null : (now - t) / 86400000;
    },
    hay: (r) => (Filter.isInbox(r) ? ['#' + r.n, r.ask, r.text, r.note, r.project] : [r.title, r.group, r.project, r.ask, r.state])
      .map(x => x == null ? '' : String(x)).join(' ').toLowerCase(),
    /** f: { bucket: 'all' | 'inbox' | 'ask:decide|do|fyi|none' | a row bucket, days, project, q, showHandled } */
    matches(r, f) {
      f = f || {};
      const bucket = f.bucket || 'all';
      if (!r) return false;
      if (Filter.isDone(r) !== !!f.showHandled) return false;
      if (f.project && f.project !== 'all' && (r.project || '') !== f.project) return false;
      if (f.q && !Filter.hay(r).includes(String(f.q).toLowerCase())) return false;
      if (f.days != null) { const a = Filter.ageOf(r); if (a != null && a > f.days) return false; }
      if (Filter.isInbox(r)) {
        if (r.status !== 'open') return false;
        if (bucket === 'all' || bucket === 'inbox') return true;
        return bucket.startsWith('ask:') && (r.ask_kind || 'none') === bucket.slice(4);
      }
      if (bucket !== 'all' && r.bucket !== bucket) return false;
      return true;
    },
    count: (list, f) => (list || []).filter(r => Filter.matches(r, f)).length,
  };
  if (typeof module === 'object' && module.exports) module.exports = Filter;
  if (typeof document === 'undefined') return;

  const B = {
    data: null, bucket: 'all', days: null, q: '', project: 'all',
    showHandled: false,
    busy: Object.create(null),
    posts: 0,
    drafts: Object.create(null),
    expanded: Object.create(null),
    answerFor: null,
    goalsOpen: false,
    goalsDoneOpen: false,
    queue: [],
    flushing: false,
  };

  /* ---------- the reply queue ------------------------------------------------------------------------
     Every tap (Done / Yes / Skip / an Answer) QUEUES; nothing is sent per tap. The queue goes to
     /api/board/act-batch as ONE message, one "[board] " line per card, when:
       - you tap "Send all as one" on the pending bar;
       - the board closes, BY ANY PATH (X, swipe, Back, Done, Open session): watched on the sheet's own
         `hidden` class, not wired to each close control, so a close path added later is covered;
       - the app opens with a queue left over (the page was killed before it went), or comes back to
         the foreground with one (a batch that failed earlier).
     One message instead of many small ones: each message wakes the Conductor, so a batch costs one
     turn, not one per card. It lives in localStorage, so a killed page loses
     nothing. A batch carries an id (`bid`) the server remembers, so a retry after a lost response can
     never deliver it twice. */
  const QUEUE_KEY = 'baton_board_queue';
  /* HELD (g775): leaving the board by "Open session" is going to LOOK, not to finish. The queue is
     held instead of sent, and a card at the notification position says how many are waiting, with
     Send all. Reopening the board releases the hold, so closing it then sends as before. Persisted,
     so a reload while held does not send behind his back either. */
  const HELD_KEY = 'baton_board_held';
  const isHeld = () => { try { return localStorage.getItem(HELD_KEY) === '1'; } catch { return false; } };
  function setHeld(on) {
    try { on ? localStorage.setItem(HELD_KEY, '1') : localStorage.removeItem(HELD_KEY); } catch {}
    heldCard();
  }
  function heldCard() {
    const c = $('board-held');
    if (!c) return;
    const n = B.queue.length;
    const show = isHeld() && n > 0 && $('view-board').classList.contains('hidden');
    c.classList.toggle('hidden', !show);
    if (show) $('board-held-n').textContent = n + (n === 1 ? ' message' : ' messages') + ' scheduled';
    $('board-held-send').disabled = !!B.flushing;
    $('board-held-send').textContent = B.flushing ? 'Sending…' : 'Send all';
  }
  function migrateKey(oldKey, newKey) {
    try { const v = localStorage.getItem(oldKey); if (v != null && localStorage.getItem(newKey) == null) localStorage.setItem(newKey, v); localStorage.removeItem(oldKey); } catch {}
  }
  migrateKey('baton-board-queue', QUEUE_KEY); migrateKey('baton-board-expanded', 'baton_board_expanded');
  try { localStorage.removeItem('baton-board-batch'); localStorage.removeItem('baton_board_batch'); } catch {}   // the old opt-in switch: queueing is always on now
  try { for (let i = localStorage.length - 1; i >= 0; i--) { const k = localStorage.key(i); if (k && k.startsWith('baton-board-draft-')) migrateKey(k, 'baton_board_draft_' + k.slice(18)); } } catch {}
  try {
    const q = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
    B.queue = (Array.isArray(q) ? q : []).filter(x => x && x.id).map((x, i) => ({ kind: x.kind, id: String(x.id), text: x.text || '', at: x.at || Date.now() + i }));
  } catch {}
  function saveQueue() {
    try { B.queue.length ? localStorage.setItem(QUEUE_KEY, JSON.stringify(B.queue)) : localStorage.removeItem(QUEUE_KEY); } catch {}
  }
  const queued = (id) => B.queue.find(q => q.id === String(id)) || null;
  function enqueue(kind, id, text, quiet) {
    B.posts++;                         // the tap did something: the dead-tap watchdog reads this
    id = String(id);
    B.queue = B.queue.filter(q => q.id !== id).concat([{ kind, id, text: text || '', at: Date.now() }]);   // re-answering a card replaces its line
    saveQueue();
    pendingBar();
    if (quiet) return;
    toast('Queued — ' + B.queue.length + ' pending; they go as one message when you close the board');
    if (B.data) render();
  }
  /** Bulk: one line per visible card, queued like any other tap. */
  function enqueueAll(kind, ids) {
    for (const id of ids) enqueue(kind, id, '', true);
    toast('Queued ' + ids.length + ' — ' + B.queue.length + ' pending; they go as one message when you close the board');
    if (B.data) render();
  }
  function unqueue(id) {
    const q = queued(id);
    B.queue = B.queue.filter(x => x.id !== String(id));
    saveQueue();
    if (q && q.kind === 'answer' && q.text) saveDraft(q.id, q.text);   // taken back, not thrown away
    pendingBar();
    if (B.data) render();
  }

  function pendingBar() {
    const bar = $('board-pending');
    if (!bar) return;
    const n = B.queue.length;
    bar.classList.toggle('hidden', !n);
    $('board-pending-n').textContent = n + (n === 1 ? ' reply' : ' replies') + ' pending';
    $('board-sendall').disabled = !!B.flushing;
    $('board-sendall').textContent = B.flushing ? 'Sending…' : 'Send all as one';
    heldCard();
  }

  /** Same batch, same id: a retry of an unchanged queue is recognised by the server and not re-sent. */
  function batchId(batch) {
    let h = 5381;
    for (const ch of batch.map(q => q.id + '@' + q.at + ':' + q.kind).join(',')) h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0;
    return 'b' + batch.length + '-' + h.toString(36);
  }
  async function flush(why) {
    if (B.flushing || !B.queue.length) return;
    B.flushing = true; pendingBar();
    const batch = B.queue.slice();
    try {
      const r = await api('/api/board/act-batch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bid: batchId(batch), why, items: batch.map(q => ({ kind: q.kind, id: q.id, text: q.text })) }),
      });
      // Remove exactly what went: a tap made while this was in flight stays queued.
      const went = new Set(batch.map(q => q.id + '@' + q.at));
      const rejected = new Set((r.rejected || []).map(x => String(x.id)));
      B.queue = B.queue.filter(q => !went.has(q.id + '@' + q.at));
      saveQueue();
      if (!B.queue.length) setHeld(false);
      for (const q of batch) if (q.kind === 'answer' && !rejected.has(q.id)) saveDraft(q.id, '');
      const n = r.n != null ? r.n : r.sent;
      toast('Sent ' + n + (n === 1 ? ' reply' : ' replies') + ' as one message'
        + (rejected.size ? ' (' + rejected.size + ' no longer on the board, dropped)' : ''));
      if (B.data) loadBoard();
    } catch (e) {
      toast('Not sent: ' + e.message + ' — ' + B.queue.length + ' kept, they go next time', true);
    } finally {
      B.flushing = false; pendingBar();
    }
  }
  window.batonBoardFlush = flush;

  const EXP_KEY = 'baton_board_expanded';
  try {
    for (const id of JSON.parse(localStorage.getItem(EXP_KEY) || '[]')) B.expanded[id] = true;
  } catch {}
  function saveExpanded() {
    try { localStorage.setItem(EXP_KEY, JSON.stringify(Object.keys(B.expanded).slice(-120))); } catch {}
  }

  const BUCKETS = ['buried', 'decide', 'nudge', 'un', 'open'];

  const MY_BUNDLE = (function () {
    try {
      const tag = [...document.querySelectorAll('script[src*="board-ui.js"]')].pop();
      const m = tag && /[?&]v=([a-z0-9]+)/i.exec(tag.src);
      return m ? m[1] : 'unversioned';
    } catch { return 'unknown'; }
  })();

  function fmtAge(a) {
    if (a == null || a >= 999) return '';
    return a < 1 ? Math.round(a * 24) + 'h' : Math.round(a) + 'd';
  }

  function fmtWhen(iso) {
    const t = Date.parse(iso); if (!t) return '';
    const m = Math.round((Date.now() - t) / 60000);
    return m < 1 ? 'just now' : m < 60 ? m + 'm ago' : Math.round(m / 60) + 'h ago';
  }

  function fmtBuilt(iso) {
    const t = Date.parse(iso); if (!t) return '';
    const m = Math.round((Date.now() - t) / 60000);
    return m < 60 ? 'built ' + m + 'm ago' : 'built ' + Math.round(m / 60) + 'h ago';
  }

  async function openBoard() {
    if (typeof drawer === 'function') drawer(false);
    setHeld(false);
    showSheet($('view-board'));
    if (!B.data) $('board-list').innerHTML = '<div class="empty">Loading…</div>';
    await loadBoard();
  }

  async function loadBoard() {
    B.busy = Object.create(null);
    let d;
    try { d = await api('/api/board'); }
    catch (e) {
      $('board-list').innerHTML = '<div class="empty">Could not load the board: ' + esc(e.message)
        + ' <button class="linkish" onclick="openBoard()">retry</button></div>';
      return;
    }
    B.data = d;
    render();
  }

  function staleBanner(serverBundle) {
    let el = $('board-stale');
    const stale = serverBundle && MY_BUNDLE !== 'unknown' && serverBundle !== MY_BUNDLE;
    if (!stale) { if (el) el.remove(); return; }
    if (!el) {
      el = document.createElement('div');
      el.id = 'board-stale';
      el.className = 'board-conductor bad';
      $('board-conductor').parentNode.insertBefore(el, $('board-conductor'));
    }
    el.innerHTML = '<b>This app is running an old version</b><span>buttons may do nothing — '
      + esc(MY_BUNDLE.slice(0, 6)) + ' vs ' + esc(String(serverBundle).slice(0, 6))
      + '</span><button class="bbtn b-yes" id="board-reload">Reload now</button>';
    $('board-reload').onclick = async () => {
      try { if (navigator.serviceWorker) {
        const rs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(rs.map(r => r.update()));
      } } catch {}
      location.replace(location.pathname + '?cb=' + Date.now() + location.hash);
    };
  }

  function conductorBanner() {
    const c = (B.data && B.data.conductor) || {};
    const el = $('board-conductor');
    el.className = 'board-conductor ' + (c.ok ? 'ok' : 'bad');
    el.innerHTML = c.ok
      ? '<b>Conductor ready</b><span>' + esc(c.reason || '') + '</span>'
      : '<b>Buttons will not send</b><span>' + esc(c.reason || 'The Conductor session is not available.') + '</span>';
  }

  const filt = (over) => Object.assign({ bucket: B.bucket, days: B.days, project: B.project, q: B.q, showHandled: B.showHandled }, over || {});

  function chips() {
    const d = B.data;
    const nInbox = Filter.count(d.inbox, filt({ bucket: 'inbox', showHandled: false }));
    const mk = (wrap, label, n, key, on, cls) => {
      const b = document.createElement('button');
      b.className = 'chip' + (on ? ' on' : '') + (cls ? ' ' + cls : '');
      b.innerHTML = esc(label) + (n != null ? ' <span class="n">' + n + '</span>' : '');
      b.onclick = () => { B.bucket = key; render(); };
      wrap.appendChild(b);
    };
    const bw = $('board-buckets');
    bw.innerHTML = '';
    mk(bw, 'All', null, 'all', B.bucket === 'all');
    if (nInbox) mk(bw, 'For ' + (d.owner_name || 'you'), nInbox, 'inbox', B.bucket === 'inbox', 'b-inbox');
    const nGoals = ((d.goals || []).filter(g => !FINISHED.includes(g.status))).length;
    if ((d.goals || []).length) {
      const gb = document.createElement('button');
      gb.className = 'chip' + (B.bucket === 'goals' ? ' on' : '');
      gb.innerHTML = 'Goals <span class="n">' + nGoals + '</span>';
      gb.onclick = () => { B.bucket = 'goals'; B.goalsOpen = true; B.showHandled = false; render(); };
      bw.appendChild(gb);
    }
    for (const k of ['decide', 'do', 'fyi', 'none']) {
      const n = Filter.count(d.inbox, filt({ bucket: 'ask:' + k, showHandled: false }));
      if (!n) continue;
      mk(bw, KIND_LABEL[k], n, 'ask:' + k, B.bucket === 'ask:' + k, 'b-ask k-' + k);
    }
    for (const k of BUCKETS) {
      const n = Filter.count(d.rows, filt({ bucket: k, showHandled: false }));
      if (!n && !(d.rows || []).some(r => r.bucket === k)) continue;
      mk(bw, (d.labels && d.labels[k] ? d.labels[k].split('—')[0].trim() : k), n, k, B.bucket === k, 'b-' + k);
    }
    projectChips(d);
    const dw = $('board-days');
    dw.innerHTML = '';
    for (const n of [3, 7, 14, null]) {
      const b = document.createElement('button');
      b.className = 'chip' + (B.days === n && !B.showHandled ? ' on' : '');
      b.textContent = n === null ? 'All' : n + 'd';
      b.onclick = () => { B.days = n; B.showHandled = false; render(); };
      dw.appendChild(b);
    }
    // The count is the list a tap on it shows (this bucket, day chip, project and search). It counted
    // bucket 'all' while the list applied the bucket too, so the chip promised cards it then did not show.
    const nDone = Filter.count(d.rows, filt({ showHandled: true })) + Filter.count(d.inbox, filt({ showHandled: true }));
    if (nDone) {
      const b = document.createElement('button');
      b.className = 'chip b-handled' + (B.showHandled ? ' on' : '');
      b.innerHTML = 'Handled <span class="n">' + nDone + '</span>';
      b.onclick = () => { B.showHandled = !B.showHandled; render(); };
      dw.appendChild(b);
    }
  }

  function projectChips(d) {
    let pw = $('board-projects');
    const list = (d.projects || []).filter(Boolean);
    if (!pw) {
      if (list.length < 2) return;
      pw = document.createElement('div');
      pw.id = 'board-projects';
      pw.className = 'chips board-projects';
      const after = document.querySelector('#view-board .board-filters') || $('board-days');   // under the search + days row, not inside it
      after.parentNode.insertBefore(pw, after.nextSibling);
    }
    pw.hidden = list.length < 2;
    pw.innerHTML = '';
    if (B.project !== 'all' && !list.includes(B.project)) B.project = 'all';
    for (const p of ['all'].concat(list)) {
      const b = document.createElement('button');
      b.className = 'chip' + (B.project === p ? ' on' : '');
      b.textContent = p === 'all' ? 'All projects' : p;
      b.onclick = () => { B.project = p; render(); };
      pw.appendChild(b);
    }
  }

  function cardTitle(card) {
    const t = card.querySelector('.bcard-t');
    if (!t) return '';
    return [...t.childNodes].filter(n => !(n.nodeType === 1 && n.classList.contains('bgo')))
      .map(n => n.textContent).join('').trim().slice(0, 300);
  }

  function cardAsk(card) {
    const a = card && card.querySelector('.bcard-ask');
    if (!a) return '';
    return [...a.childNodes].filter(n => !(n.nodeType === 1 && n.tagName === 'B'))
      .map(n => n.textContent).join('').trim();
  }

  const KIND_LABEL = { decide: 'DECIDE', do: 'DO', fyi: 'FYI', none: 'NO QUESTION' };
  const KIND_HINT = { decide: 'needs your answer', do: 'needs your hands', fyi: 'read and clear' };

  // What "Open session" lands on (g785): the card's anchor (a message uuid), else its own words.
  function landAttrs(r) {
    return (r.anchor ? ' data-anchor="' + esc(r.anchor) + '"' : '')
      + ' data-land="' + esc(String(r.text || r.ask || '').slice(0, 600)) + '"';
  }

  function inboxCard(r) {
    const k = '#' + r.n, done = r.acted;
    const tap = r.openable && r.session;
    return '<div class="bcard inbox' + (done ? ' acted' : '') + '" data-id="' + esc(k) + '"'
      + (r.ts ? ' data-raised="' + esc(r.ts) + '"' : '') + landAttrs(r) + '>'
      + '<div class="bcard-head head-x">'
      + '<div class="bcard-t bexp' + (B.expanded[k] ? ' open' : '') + '" role="button" tabindex="0"'
      + ' data-expand="' + esc(k) + '">'
      + '<div class="btext">' + (r.ask_kind
          ? '<span class="b-kind k-' + esc(r.ask_kind) + '">' + esc(KIND_LABEL[r.ask_kind] || '?') + '</span> '
          : '<span class="b-kind k-none" title="The session never said what it needs from you">NO QUESTION</span> ')
        + (new RegExp('^#' + r.n + '\\b').test(String(r.ask || r.text || '')) ? '' : '#' + r.n + ' ') + esc(String(r.ask || r.text || '')) + '</div>'
      + '<span class="bgo"></span></div>'
      + '<div class="bcard-m"><span class="b-tag">' + esc(KIND_HINT[r.ask_kind] || 'For ' + ((B.data && B.data.owner_name) || 'you')) + '</span><span>' + esc((r.ts || '').slice(5, 16)) + '</span>'
      + (r.project ? '<span>' + esc(r.project) + '</span>' : '') + (r.pinned ? '<span title="Reinstated by you; never auto-resolved">pinned</span>' : '')
      + (tap ? '<button class="bopen" data-open="' + esc(r.session) + '">Open session ›</button>' : '')
      + '</div></div>'
      + ((r.ask && r.text) ? '<div class="bcard-ask bnote' + (B.expanded[k] ? ' open' : '') + '" data-note="' + esc(k) + '">'
          + '<b>Why</b>' + esc(r.text) + '</div>' : '')
      + (r.note ? '<div class="bcard-ask bnote' + (B.expanded[k] ? ' open' : '') + '" data-note="' + esc(k) + '">'
          + '<b>Note</b>' + esc(r.note) + '</div>' : '')
      + actionsHtml(k, r.ask_kind === 'fyi' ? ['done'] : ['done', 'answer'], done, r.handled)
      + '</div>';
  }

  function sessionCard(r) {
    const done = r.acted;
    const sum = r.summary ? r.summary.filter(p => p[1]) : null;
    const overview = sum && sum.length
      ? '<div class="bcard-sum">' + sum.slice(0, 3).map(p =>
          '<div><b>' + esc(p[0]) + '</b>' + esc(String(p[1]).slice(0, 220)) + '</div>').join('') + '</div>'
      : '';
    return '<div class="bcard b-' + esc(r.bucket) + (done ? ' acted' : '') + '" data-id="' + esc(r.id) + '">'
      + (r.openable === false
          ? '<div class="bcard-head"><div class="bcard-t">' + esc(r.title) + '</div>'
          : '<div class="bcard-head tap" role="button" tabindex="0" data-open="' + esc(r.id) + '">'
            + '<div class="bcard-t linkish-t">' + esc(r.title) + '<span class="bgo">›</span></div>')
      + '<div class="bcard-m"><span class="b-tag b-' + esc(r.bucket) + '">'
        + esc((B.data.labels && B.data.labels[r.bucket] || r.bucket).split('—')[0].trim()) + '</span>'
      + '<span>' + esc(r.group || '') + '</span><span>' + esc(r.project || '') + '</span>'
      + '<span>' + fmtAge(r.age) + '</span>'
      + (r.critical ? '<span class="b-crit">⚠ outward / irreversible</span>' : '') + '</div></div>'
      + (r.ask ? '<div class="bcard-ask">' + esc(String(r.ask).slice(-500)) + '</div>' : '')
      + overview
      + actionsHtml(r.id, ['yes', 'answer', 'skip'], done, r.handled)
      + '</div>';
  }

  const LABELS = { yes: 'Yes', skip: 'Skip', answer: 'Answer…', done: 'Done ✓', reopen: 'Reinstate' };

  const SENT = { yes: 'Yes sent', skip: 'Skip sent', answer: 'Answer sent', done: 'Done sent', reopen: 'Reinstated' };

  function actionsHtml(id, kinds, done, handled) {
    const q = !handled && !done && queued(id);
    if (q) {
      // Composed, not sent: it goes with the others as ONE message; until then it can be taken back.
      return '<div class="bcard-done"><span class="bpill wait">Queued: ' + esc(String(LABELS[q.kind] || q.kind).replace(/[….]+$/, '')) + '</span>'
        + (q.text ? '<span class="bq-text">' + esc(String(q.text).slice(0, 140)) + '</span>' : '')
        + '<button class="linkish" data-unqueue="' + esc(id) + '">undo</button></div>';
    }
    if (handled) {
      return '<div class="bcard-done"><span class="bpill ok">Handled by the Conductor</span>'
        + '<span>' + esc(String(handled).slice(0, 80)) + '</span>'
        + '<button class="linkish" data-putback="' + esc(id) + '">put back</button></div>';
    }
    if (done) {
      return '<div class="bcard-done"><span class="bpill wait">' + esc(SENT[done.kind] || done.kind) + '</span>'
        + '<span>' + esc(fmtWhen(done.at)) + ' — waiting for the Conductor</span>'
        + '<button class="linkish" data-putback="' + esc(id) + '">put back</button></div>';
    }
    return '<div class="bcard-acts">' + kinds.map(k =>
      '<button class="bbtn b-' + k + '" data-act="' + k + '" data-target="' + esc(id) + '">' + LABELS[k] + '</button>').join('') + '</div>';
  }

  function goalsSection(d) {
    const goals = (d && d.goals) || [];
    if (!goals.length) return '';
    const now = Date.now();
    const dueMs = (g) => { const t = g.due ? Date.parse(g.due) : NaN; return isNaN(t) ? Infinity : t; };
    const overdue = (g) => dueMs(g) < now;
    const open = goals.filter(g => !FINISHED.includes(g.status) && (B.project === 'all' || (g.project || '') === B.project));
    const done = goals.filter(g => FINISHED.includes(g.status) && (B.project === 'all' || (g.project || '') === B.project));
    open.sort((a, b) => (overdue(b) - overdue(a)) || (dueMs(a) - dueMs(b)));

    const days = (g) => {
      if (!isFinite(dueMs(g))) return '';
      const diff = Math.round((dueMs(g) - now) / 86400000);
      if (diff < 0) return '<em class="gover">overdue ' + Math.abs(diff) + 'd</em>';
      return '<span class="gdue">due ' + (diff === 0 ? 'today' : 'in ' + diff + 'd') + '</span>';
    };

    const card = (g) => {
      const tap = g.session ? ' data-open="' + esc(g.session) + '" role="button" tabindex="0"' : '';
      const checks = (g.checks || []).length
        ? '<ul class="gchecks">' + g.checks.map(c => '<li>' + esc(String(c)) + '</li>').join('') + '</ul>'
        : '';
      return '<div class="gcard' + (overdue(g) ? ' gcard-over' : '') + '"' + tap + '>'
        + '<div class="gtitle">' + esc(g.title || g.id) + '</div>'
        + '<div class="gmeta">' + (g.condition ? '<span class="gcond c-' + esc(g.condition) + '">' + esc(COND_LABEL[g.condition] || g.condition) + '</span> ' : '')
        + (FINISHED.includes(g.status) ? '<span class="gcond">' + esc(g.status) + (g.closed_at ? ' ' + esc(fmtWhen(g.closed_at)) : '') + '</span> ' : days(g))
        + (g.blocked_on ? ' <em class="gblocked">blocked: ' + esc(String(g.blocked_on)) + '</em>' : '')
        + (g.session ? ' <span class="gsess">' + esc(String(g.session).slice(0, 14)) + '…</span>' : '')
        + '</div>'
        + checks
        + '</div>';
    };

    const nOver = open.filter(overdue).length;
    return '<details class="goals"' + (B.goalsOpen ? ' open' : '') + ' id="goals-reg">'
      + '<summary><b>Projects &amp; where they have got to</b> <span class="n">' + open.length + ' open</span>'
      + (nOver ? ' <em class="gover">' + nOver + ' overdue</em>' : '')
      + '<p>Nothing here needs you — this is where the work has got to.</p></summary>'
      + open.map(card).join('')
      + (done.length
          ? '<details class="goals-done"' + (B.goalsDoneOpen ? ' open' : '') + ' id="goals-done">'
            + '<summary>Finished — last ' + esc(d.finished_keep_days || 3) + ' days <span class="n">' + done.length + '</span></summary>'
            + done.map(card).join('')
            + (d.finished_older ? '<p class="gmore">' + esc(d.finished_older) + ' finished earlier — <code>relaymote goal list --all</code></p>' : '')
            + '</details>'
          : '')
      + '</details>';
  }

  const COND_LABEL = { 'VERIFY-NOW': 'verify now', DELIVERED: 'delivered — read it', ORPHAN: 'no owner', UNTOLD: 'owner never told',
    UNRESPONSIVE: 'not answering', LATE: 'late', STUCK: 'stuck', 'BLOCKED-STALE': 'blocked a week', BLOCKED: 'blocked', OFFLINE: 'owner offline',
    'HANDED-OVER': 'handed over', 'AWAITING-VERIFICATION': 'awaiting verification', WATCH: 'watch', FRESH: 'on track' };

  /** Goal register health: what needs a person, from goals-health.json (written by the goal chaser). */
  function healthBlock(d) {
    const h = d.goals_health;
    if (!h || !(h.items || []).length) return '';
    const by = (c) => h.items.filter(i => i.condition === c && (B.project === 'all' || (i.project || '') === B.project));
    const line = (cls, list, label) => '<div class="' + (list.length ? cls : 'ok') + '"><b>' + list.length + '</b> ' + esc(label)
      + (list.length ? '<small>' + list.slice(0, 6).map(i => esc(i.id + ' ' + String(i.title || '').slice(0, 60))).join(' · ') + '</small>' : '') + '</div>';
    const ev = h.events24 || [];
    return '<div class="bhealth">'
      + (by('VERIFY-NOW').length ? line('bad', by('VERIFY-NOW'), 'verify now — the proving date has arrived') : '')
      + line('bad', by('DELIVERED'), 'delivered, not yet read — close with the evidence or judge it back')
      + line('bad', by('ORPHAN').concat(by('UNTOLD')), 'ownerless or never handed over')
      + line('warn', by('STUCK').concat(by('LATE')), 'stuck or late')
      + '<div><b>' + ev.length + '</b> change' + (ev.length === 1 ? '' : 's') + ' in 24 h'
      + (ev.length ? '<small>' + ev.slice(-5).map(e => esc((e.id || '') + ' ' + (e.kind || '') + (e.to ? ' → ' + e.to : ''))).join(' · ') + '</small>' : '') + '</div>'
      + '</div>';
  }

  /** One card per project: its open goals and its open asks. */
  function projectsBlock(d) {
    const map = new Map();
    const get = (p) => { if (!map.has(p)) map.set(p, { goals: [], asks: [] }); return map.get(p); };
    for (const g of d.goals || []) if (!FINISHED.includes(g.status) && g.project) get(g.project).goals.push(g);
    for (const r of d.inbox || []) if (r.status === 'open' && r.project) get(r.project).asks.push(r);
    const list = [...map.entries()].filter(([p]) => B.project === 'all' || p === B.project).sort((a, b) => a[0].localeCompare(b[0]));
    if (!list.length) return '';
    return '<details class="goals" id="board-byproject"' + (B.projectsOpen ? ' open' : '') + '><summary><b>By project</b> <span class="n">' + list.length + '</span></summary>'
      + list.map(([p, v]) => '<div class="gcard"><div class="gtitle">' + esc(p) + '</div><div class="gmeta">'
        + v.goals.length + ' open goal' + (v.goals.length === 1 ? '' : 's') + ' · ' + v.asks.length + ' open ask' + (v.asks.length === 1 ? '' : 's') + '</div>'
        + '<ul class="gchecks">' + v.goals.slice(0, 5).map(g => '<li>' + esc(g.id + ' ' + g.title) + (g.condition ? ' — ' + esc(COND_LABEL[g.condition] || g.condition) : '') + '</li>').join('')
        + v.asks.slice(0, 5).map(r => '<li>#' + r.n + ' ' + esc(String(r.ask || r.text || '').slice(0, 120)) + '</li>').join('') + '</ul></div>').join('')
      + '</details>';
  }

  /** Context hygiene (hygiene.json in the board folder, when something writes it). */
  function hygieneBlock(d) {
    const h = d.hygiene;
    if (!h || typeof h !== 'object') return '';
    const counts = h.counts && typeof h.counts === 'object' ? Object.entries(h.counts) : [];
    const rows = Array.isArray(h.items) ? h.items : Array.isArray(h.sessions) ? h.sessions : [];
    const wl = h.wakes && h.wakes.lastDay;
    if (!counts.length && !rows.length && !wl) return '';
    return '<details class="goals" id="board-hygiene"><summary><b>Context hygiene</b>'
      + counts.map(([k, n]) => ' <span class="n">' + esc(n) + ' ' + esc(String(k).toLowerCase().replace(/[-_]/g, ' ')) + '</span>').join('')
      + (h.at ? '<p>as at ' + esc(fmtWhen(h.at)) + '</p>' : '')
      + (wl ? '<p>Wakes, last day: ' + esc(wl.warm || 0) + ' inside the cache window · ' + esc(wl.cold || 0) + ' outside'
        + (h.wakes.baton24 != null ? ' · Relaymote sent ' + esc(h.wakes.baton24) + ' in 24 h' : '') + '</p>' : '') + '</summary>'
      + rows.slice(0, 40).map(r => '<div class="gcard"><div class="gtitle">' + esc(r.title || r.id || r.sessionId || '') + '</div><div class="gmeta">'
        + esc([r.verdict || r.state || '', r.reason || r.why || ''].filter(Boolean).join(' — ')) + '</div></div>').join('')
      + (h.more ? '<p class="gmore">' + esc(h.more) + ' more — <code>relaymote hygiene</code></p>' : '')
      + '</details>';
  }

  function inboxDrawers(d) {
    const inProj = (r) => B.project === 'all' || (r.project || '') === B.project;
    const res = (d.inbox_resolved || []).filter(inProj), wait = (d.inbox_waiting || []).filter(inProj);
    let out = '';
    if (res.length) {
      out += '<details class="goals" id="board-resolved"' + (B.resolvedOpen ? ' open' : '') + '><summary><b>Probably handled</b> <span class="n">' + res.length + '</span>'
        + '<p>Evidence says these were dealt with. They close on their own only when that evidence is strong. Reinstate any that are not.</p></summary>'
        + res.map(r => '<div class="bcard inbox' + (r.acted ? ' acted' : '') + '" data-id="#' + r.n + '"' + (r.ts ? ' data-raised="' + esc(r.ts) + '"' : '') + landAttrs(r) + '><div class="bcard-head"><div class="bcard-t">#' + r.n + ' ' + esc(String(r.ask || r.text || '').slice(0, 300)) + '</div>'
          + '<div class="bcard-m"><span class="b-tag">' + esc((r.tier || '?') + ' confidence') + '</span><span>' + esc(r.why || '') + '</span>'
          + (r.openable && r.session ? '<button class="bopen" data-open="' + esc(r.session) + '">Open session ›</button>' : '') + '</div></div>'
          + (r.evidence ? '<div class="bcard-ask"><b>Evidence</b>' + esc(r.evidence) + '</div>' : '')
          + actionsHtml('#' + r.n, ['reopen'], r.acted, r.handled) + '</div>').join('')
        + '</details>';
    }
    if (wait.length) {
      out += '<details class="goals" id="board-waiting"' + (B.waitingOpen ? ' open' : '') + '><summary><b>In flight</b> <span class="n">' + wait.length + '</span>'
        + '<p>Waiting on someone else — nothing for you to do yet.</p></summary>'
        + wait.map(r => '<div class="gcard"' + (r.openable && r.session ? ' data-open="' + esc(r.session) + '" role="button" tabindex="0"' : '') + '><div class="gtitle">#' + r.n + ' '
          + esc(String(r.ask || r.text || '').slice(0, 200)) + '</div><div class="gmeta">' + esc((r.ts || '').slice(5, 16)) + (r.project ? ' · ' + esc(r.project) : '') + '</div></div>').join('')
        + '</details>';
    }
    return out;
  }

  function render() {
    const d = B.data;
    if (!d) return;
    $('board-built').textContent = fmtBuilt(d.built_at) + ' · v' + MY_BUNDLE.slice(0, 6);
    staleBanner(d.bundle);
    conductorBanner();
    chips();
    pendingBar();

    const inbox = (d.inbox || []).filter(r => Filter.matches(r, filt()));
    const rows = (d.rows || []).filter(r => Filter.matches(r, filt()));

    const html = [];
    const top = B.bucket === 'all' || B.bucket === 'goals';
    if (top && !B.showHandled) { const hb = healthBlock(d); if (hb) html.push(hb); }
    if (inbox.length) {
      const fyi = inbox.filter(r => r.ask_kind === 'fyi' && !queued('#' + r.n));
      html.push('<div class="bsec"><h3>For ' + esc(d.owner_name || 'you') + ' <span>' + inbox.length + '</span></h3>'
        + '<p>Only you can do these — nothing else on this page needs you.</p>'
        + (fyi.length && !B.showHandled ? '<button class="linkish" data-bulk="fyi">Clear all FYI (' + fyi.length + ')</button>' : '') + '</div>');
      html.push(inbox.map(inboxCard).join(''));
    }
    // An unanswered ask must never vanish silently because it is old: say how many the day chip is
    // holding back, with the one tap that shows them.
    if (!B.showHandled && B.days != null) {
      const older = Filter.count(d.inbox, filt({ days: null })) - inbox.length;
      if (older > 0) html.push('<button class="bolder" id="board-older">' + older + ' older than ' + B.days
        + 'd waiting for you — show all</button>');
    }
    if ((B.bucket === 'all' || B.bucket === 'inbox') && !B.showHandled) { const dr = inboxDrawers(d); if (dr) html.push(dr); }
    for (const k of BUCKETS) {
      const rs = rows.filter(r => r.bucket === k);
      if (!rs.length) continue;
      const lbl = (d.labels && d.labels[k]) || k;
      const bulk = k === 'nudge' && !B.showHandled ? rs.filter(r => !queued(r.id)) : [];
      html.push('<div class="bsec"><h3>' + esc(lbl) + ' <span>' + rs.length + '</span></h3>'
        + '<p>' + esc((d.hints && d.hints[k]) || '') + '</p>'
        + (bulk.length > 1 ? '<button class="linkish" data-bulk="nudge">Yes to all Nudge (' + bulk.length + ')</button>' : '') + '</div>');
      html.push(rs.map(sessionCard).join(''));
    }
    const reg = (top && !B.showHandled) ? goalsSection(d) + projectsBlock(d) + hygieneBlock(d) : '';
    $('board-list').innerHTML = (html.length ? html.join('')
      : reg ? ''
      : '<div class="empty">' + (B.showHandled ? 'Nothing handled in the last 12 hours.'
                                               : 'Nothing waiting for this filter.') + '</div>') + reg;
    markClamped();
  }

  function markClamped() {
    const list = $('board-list');
    if (!list.clientHeight) { requestAnimationFrame(markClamped); return; }
    for (const t of list.querySelectorAll('.bcard-t.bexp')) {
      const body = t.querySelector('.btext');
      if (!body) continue;
      const wasOpen = t.classList.contains('open');
      if (wasOpen) t.classList.remove('open');
      t.classList.toggle('clamped', body.scrollHeight - body.clientHeight > 2);
      if (wasOpen) t.classList.add('open');
    }
  }

  // (There is no per-tap send: every tap queues, and flush() is the only path to the Conductor.)

  $('board-list').addEventListener('click', (e) => {
    const open = e.target.closest('[data-open]');
    if (open) {
      const id = open.dataset.open;
      const card = open.closest('.bcard');
      const ask = (card && (card.querySelector('.bcard-ask:not(.bnote)') || {}).textContent) || '';
      const raised = card && card.dataset.raised;
      const anchor = card && card.dataset.anchor, land = card && card.dataset.land;
      navOpenFrom(id).then(async () => {
        if ((anchor || land) && window.landAtAnchor && await window.landAtAnchor(id, { uuid: anchor, text: land, raised })) return;
        if (!scrollToAsk(ask) && raised) scrollToRaiseTime(raised);
      });
      if (B.queue.length) setHeld(true);   // BEFORE the hide: the close observer must see the hold
      hideSheet($('view-board'));
      return;
    }
    const noteHit = e.target.closest('[data-note]');
    const exp = noteHit
      ? (noteHit.closest('.bcard') || document).querySelector('[data-expand]')
      : e.target.closest('[data-expand]');
    if (exp) {
      const id = exp.dataset.expand;
      const open = exp.classList.toggle('open');
      const card = exp.closest('.bcard');
      const note = card && card.querySelector('.bnote');
      if (note) note.classList.toggle('open', open);
      if (open) B.expanded[id] = true; else delete B.expanded[id];
      saveExpanded();
      return;
    }
    const head = e.target.closest('.bcard-head');
    if (head && !head.classList.contains('tap')
        && !(head.closest('.bcard') || head).querySelector('[data-open]')) {
      toast('No session is linked to this item yet, so there is nothing to open — the buttons below still work');
      return;
    }
    const back = e.target.closest('[data-putback]');
    if (back) {
      const id = back.dataset.putback;
      api('/api/board/unhide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) })
        .then(() => { toast('Put back on the board — the line already went, this only un-hides it'); loadBoard(); })
        .catch(err => toast('Could not put it back: ' + err.message, true));
      return;
    }
    const bulk = e.target.closest('[data-bulk]');
    if (bulk) {
      const d = B.data || {};
      const ids = bulk.dataset.bulk === 'fyi'
        ? (d.inbox || []).filter(r => r.ask_kind === 'fyi' && Filter.matches(r, filt())).map(r => '#' + r.n)
        : (d.rows || []).filter(r => r.bucket === 'nudge' && Filter.matches(r, filt({ bucket: 'nudge' }))).map(r => r.id);
      if (ids.length) enqueueAll(bulk.dataset.bulk === 'fyi' ? 'done' : 'yes', ids.filter(id => !queued(id)));
      return;
    }
    if (e.target.closest('#board-older')) { B.days = null; render(); return; }
    const unq = e.target.closest('[data-unqueue]');
    if (unq) { unqueue(unq.dataset.unqueue); return; }
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const id = b.dataset.target, kind = b.dataset.act;
    if (kind !== 'answer') {
      const before = B.posts;
      setTimeout(() => {
        if (B.posts === before) toast('That tap did nothing — reload the app (pull down) and try again', true);
      }, 1000);
    }
    if (kind === 'answer') {
      const card = b.closest('.bcard');
      openAnswer(id, cardTitle(card), cardAsk(card));
      return;
    }
    enqueue(kind, id);                 // queued, sent with the others as one message
  });

  function landOn(msg) {
    const go = () => msg.scrollIntoView({ block: 'center' });
    go(); setTimeout(go, 350); setTimeout(go, 1200);
    msg.classList.add('askhit');
    setTimeout(() => msg.classList.remove('askhit'), 2600);
  }

  function landWhenPainted(find, missMsg, settleMs) {
    const hardDeadline = Date.now() + 15000;
    let softDeadline = null;
    const tick = () => {
      const msgs = [...document.querySelectorAll('#log .msg')];
      if (msgs.length) {
        const hit = find(msgs);
        if (hit) { landOn(hit); return; }
        if (settleMs != null && softDeadline == null) softDeadline = Date.now() + settleMs;
      }
      const done = Date.now() >= hardDeadline || (softDeadline != null && Date.now() >= softDeadline);
      if (!done) { setTimeout(tick, 250); return; }
      if (missMsg) toast(missMsg);
    };
    setTimeout(tick, 250);
  }

  function scrollToAsk(ask) {
    const norm = (x) => String(x || '').replace(/[*_`~#>\[\]()]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
    const needle = norm(ask).slice(0, 40);
    if (needle.length < 12) return false;
    landWhenPainted(
      (msgs) => msgs.reverse().find(m => norm(m.textContent).includes(needle)),
      'Opened at the latest message — could not find the exact one.');
    return true;
  }

  const RAISE_WINDOW_MS = 45 * 60 * 1000;

  function scrollToRaiseTime(iso) {
    const raised = Date.parse(iso);
    if (!raised) return false;
    landWhenPainted((msgs) => {
      let best = null, bestGap = Infinity;
      for (const m of msgs) {
        const st = m.nextElementSibling;
        if (!st || !st.classList.contains('stamp')) continue;
        const t = Date.parse(st.dataset.ts || '');
        if (!t || t > raised) continue;
        const gap = raised - t;
        if (gap < bestGap) { bestGap = gap; best = m; }
      }
      return bestGap <= RAISE_WINDOW_MS ? best : null;
    }, 'Opened at the latest message — nothing in this session lines up with when this was raised.',
       1500);
    return true;
  }

  const DRAFT_KEY = (id) => 'baton_board_draft_' + id;

  function saveDraft(id, text) {
    B.drafts[id] = text;
    try { text ? localStorage.setItem(DRAFT_KEY(id), text) : localStorage.removeItem(DRAFT_KEY(id)); } catch {}
  }
  function loadDraft(id) {
    if (B.drafts[id] != null) return B.drafts[id];
    try { return localStorage.getItem(DRAFT_KEY(id)) || ''; } catch { return ''; }
  }

  function growAnswer() {
    const t = $('answer-text');
    t.style.height = 'auto';
    t.style.height = Math.min(t.scrollHeight, Math.round(window.innerHeight * 0.38)) + 'px';
  }

  function openAnswer(id, title, ask) {
    B.answerFor = id;
    $('answer-for').textContent = title;
    const askBox = $('answer-ask');
    askBox.textContent = ask || '';
    askBox.hidden = !ask;
    const t = $('answer-text');
    t.value = loadDraft(id);
    $('answer-note').textContent = t.value ? 'Draft restored.' : '';
    showSheet($('answersheet'));
    growAnswer();
    t.focus();
    try { t.setSelectionRange(t.value.length, t.value.length); } catch {}
  }

  function closeAnswer() {
    if (B.answerFor) saveDraft(B.answerFor, $('answer-text').value);
    B.answerFor = null;
    hideSheet($('answersheet'));
  }

  async function sendAnswer() {
    const id = B.answerFor, text = $('answer-text').value;
    if (!id) return;
    if (!text.trim()) { $('answer-note').textContent = 'Nothing to send yet.'; $('answer-text').focus(); return; }
    // Queued with the others, not sent alone. The draft is kept until the batch is delivered (flush
    // clears it), so a failed batch loses nothing.
    saveDraft(id, text);
    B.answerFor = null;
    hideSheet($('answersheet'));
    enqueue('answer', id, text);
  }

  $('answer-text').addEventListener('input', () => {
    growAnswer();
    if (B.answerFor) saveDraft(B.answerFor, $('answer-text').value);
  });
  $('answer-send').onclick = sendAnswer;
  $('answer-cancel').onclick = closeAnswer;
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('answersheet').classList.contains('hidden')) {
      e.stopPropagation(); closeAnswer();
    }
  }, true);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('view-board').classList.contains('hidden')) {
      e.stopPropagation(); hideSheet($('view-board'));
    }
  }, true);

  $('board-list').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const t = e.target.closest('[data-open], [data-expand]');
    if (t) { e.preventDefault(); t.click(); }
  });

  $('board-list').addEventListener('toggle', (e) => {
    const t = e.target;
    if (!t || t.tagName !== 'DETAILS') return;
    if (t.id === 'goals-reg') B.goalsOpen = t.open;
    if (t.id === 'goals-done') B.goalsDoneOpen = t.open;
    if (t.id === 'board-resolved') B.resolvedOpen = t.open;
    if (t.id === 'board-waiting') B.waitingOpen = t.open;
    if (t.id === 'board-byproject') B.projectsOpen = t.open;
  }, true);

  $('board-q').oninput = (e) => { B.q = e.target.value.trim().toLowerCase(); render(); };
  $('btn-board').onclick = openBoard;
  const openIfHashed = () => {
    const m = /^#board(?:=([a-z]+))?$/.exec(location.hash);
    if (!m) return;
    if (m[1]) B.bucket = m[1];
    // #board=goals must land on an OPEN register, as the Goals chip does; collapsed it looks empty.
    if (m[1] === 'goals') { B.goalsOpen = true; B.showHandled = false; }
    openBoard();
  };
  if (document.readyState === 'complete') openIfHashed();
  else window.addEventListener('load', openIfHashed);
  window.addEventListener('hashchange', openIfHashed);
  $('btn-board-refresh').onclick = () => { $('board-list').innerHTML = '<div class="empty">Loading…</div>'; loadBoard(); };
  $('btn-close-board').onclick = () => navBack();
  window.openBoard = openBoard;

  // Flush triggers. Closing the board by ANY path sends the queue: observed on the sheet's own `hidden`
  // class rather than wired into each close control.
  $('board-sendall').onclick = () => flush('send-all');
  $('board-held-send').onclick = () => flush('send-all-held');
  $('board-held-open').onclick = () => openBoard();
  new MutationObserver(() => {
    if ($('view-board').classList.contains('hidden') && B.queue.length && !isHeld()) flush('board-closed');
    heldCard();
  }).observe($('view-board'), { attributes: true, attributeFilter: ['class'] });
  pendingBar();
  // Left over from a page that was killed before it sent: send on this open, once boot's own requests
  // have had the link first. Also when the app comes back to the foreground with the board closed.
  if (B.queue.length) setTimeout(() => { if ($('view-board').classList.contains('hidden') && !isHeld()) flush('reopen'); }, 4000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && B.queue.length && $('view-board').classList.contains('hidden') && !isHeld()) flush('resume');
  });
})();
