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
    /** The goal waits on HIM (his tap, OTP, password, OK) — "on Sagar ... at his repair link" does not. */
    onMe(g, me) {
      const b = String(g.blocked_on || '').trim();
      if (!b) return false;
      const name = String(me || '').replace(/[^\w]/g, '');
      return (name && name !== 'you' && new RegExp('\\b' + name + '\\b', 'i').test(b))
        || /^\W*(?:[\w-]+\s+){0,3}?on\s+(?:his|him|your)\b/i.test(b);
    },
    /** you | check | wait | run — where a goal belongs on the board (the phone and /api/board/needs agree). */
    goalKind(g, me) {
      if (g.condition === 'DELIVERED' || g.condition === 'VERIFY-NOW') return 'check';
      if (Filter.onMe(g, me)) return 'you';
      if (g.blocked_on || g.condition === 'BLOCKED' || g.condition === 'BLOCKED-STALE') return 'wait';
      return 'run';
    },
    /** In progress / Waiting / Done counts, so a light board can show its tabs before the full one loads. */
    tabCounts(d, me, now = Date.now()) {
      const open = (d.goals || []).filter(g => !FINISHED.includes(g.status));
      const kinds = open.map(g => Filter.goalKind(g, me));
      const keep = (Number(d.finished_keep_days) || 3) * 86400000;
      const paused = (d.rows || []).filter(r => !Filter.isDone(r) && (r.bucket === 'un' || r.bucket === 'open')).length;
      const closed = (d.goals || []).filter(g => FINISHED.includes(g.status) && g.closed_at && now - Date.parse(g.closed_at) < keep).length;
      const sent = (d.inbox || []).filter(Filter.isDone).length + (d.rows || []).filter(Filter.isDone).length;
      return { run: kinds.filter(k => k === 'run').length + paused, wait: kinds.filter(k => k === 'wait').length + (d.inbox_waiting || []).length,
        done: closed + sent + (d.inbox_resolved || []).length };
    },
  };
  if (typeof module === 'object' && module.exports) module.exports = Filter;
  if (typeof document === 'undefined') return;

  // g1870: who holds this phone (Settings › This phone is, or a ?as=sagar link). A non-default principal sees
  // only their own goals and asks, and their taps go to their own Conductor; Ashwar's board shows all.
  const asP = () => { try { return localStorage.getItem('baton.principal') || ''; } catch { return ''; } };
  const asQ = () => (asP() ? '?as=' + encodeURIComponent(asP()) : '');
  const B = {
    data: null, q: '',
    // g1885: data = the light "Needs you" board (/api/board/needs, ~20 KB); full = the whole board, fetched only
    // when a tab, a search, the old fold or a link needs it. The times say which is newer.
    dataAt: 0, full: null, fullAt: 0, fullLoading: null, doneOpen: false,
    busy: Object.create(null),
    posts: 0,
    drafts: Object.create(null),
    expanded: Object.create(null),
    answerFor: null,
    goalsOpen: false,
    waitOpen: false, oldOpen: false, showAllNeed: false,
    gexp: Object.create(null), laneOpen: Object.create(null),
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
        body: JSON.stringify({ bid: batchId(batch), why, as: asP() || undefined, items: batch.map(q => ({ kind: q.kind, id: q.id, text: q.text })) }),
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
  window.relaymoteBoardFlush = flush;

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
    // The last board shows at once — from this page, else from the phone's cache — and the fresh one replaces it
    // when it lands (stale-while-revalidate). A cold phone used to wait for ~420 KB over the tunnel first.
    if (!B.data) { const c = cacheGet(); if (c) { B.data = c; B.dataAt = 0; } }
    if (B.data) render(); else $('board-list').innerHTML = '<div class="empty">Loading…</div>';
    await loadBoard();
  }

  /* A tap on a goal id / card number in a chat (g1869). { goal: 'g1867' } opens the board searched for
     that goal: its register card plus every ask and session row that names it. { card: '1783' } opens
     that card, expanded, with its Answer sheet up when it still wants an answer. */
  async function openBoardAt(t) {
    t = t || {};
    B.q = t.goal ? String(t.goal).toLowerCase() : '';
    if ($('board-q')) $('board-q').value = B.q;
    if (t.goal) B.gexp[B.q] = true;
    await openBoard();
    const d = B.data;
    if (!d) return;
    const list = $('board-list');
    list.scrollTop = 0;
    const flash = (el) => {
      if (!el) return;
      el.scrollIntoView({ block: 'start' });
      el.classList.add('bflash');
      setTimeout(() => el.classList.remove('bflash'), 2400);
    };
    if (t.goal) {
      let el = list.querySelector('.bcard.goal[data-goal="' + B.q + '"]');
      if (el) flash(el); else toast(B.q + ' is not in the goal register yet — pull down to refresh in a minute');
      return;
    }
    if (t.card) {
      const n = String(t.card), k = '#' + n;
      let r = (d.inbox || []).find(x => String(x.n) === n);
      // The light board carries only the last week's asks (and numbers for the rest).
      if (!r && !B.full) { const f = await ensureFull(); r = f && (f.inbox || []).find(x => String(x.n) === n); }
      const dd = B.full || d;
      if (!r) {
        const w = (dd.inbox_waiting || []).find(x => String(x.n) === n) ? 'is waiting on someone else'
          : (dd.inbox_resolved || []).find(x => String(x.n) === n) ? 'looks handled already' : 'is not an open card on the board';
        toast(k + ' ' + w);
        return;
      }
      // It may sit past the first cards, in the two-weeks-old fold, or (sent already) under Done.
      B.showAllNeed = true; B.oldOpen = true;
      render();
      const card = [...list.querySelectorAll('.bcard')].find(c => c.dataset.id === k);
      if (!card) { toast(k + ' is not shown on the board'); return; }
      const sect = card.closest('details'); if (sect) sect.open = true;
      const exp = card.querySelector('[data-expand]');
      if (exp && !exp.classList.contains('open')) exp.click();
      flash(card);
      if (!r.acted && !r.handled && r.ask_kind !== 'fyi' && !queued(k)) openAnswer(k, cardTitle(card), cardAsk(card));
    }
  }
  window.openBoardAt = openBoardAt;

  const CACHE_KEY = () => 'baton.boardNeeds.v1.' + (asP() || '-');
  function cacheGet() { try { const d = JSON.parse(localStorage.getItem(CACHE_KEY()) || 'null'); return d && d.ok && d.light ? d : null; } catch { return null; } }
  function cachePut(d) { try { localStorage.setItem(CACHE_KEY(), JSON.stringify(d)); } catch {} }

  async function loadBoard() {
    B.busy = Object.create(null);
    let d;
    const goal = /^g\d+$/.test(B.q) ? B.q : '';
    try { d = await api('/api/board/needs' + asQ() + (goal ? (asQ() ? '&' : '?') + 'goal=' + goal : '')); }
    catch (e) {
      if (B.data) { toast('Could not refresh the board: ' + e.message); return; }
      $('board-list').innerHTML = '<div class="empty">Could not load the board: ' + esc(e.message)
        + ' <button class="linkish" onclick="openBoard()">retry</button></div>';
      return;
    }
    B.data = d; B.dataAt = Date.now();
    if (!goal) cachePut(d);
    // Whatever is open on screen that shows the whole board is refreshed with it.
    if (B.full && needsFull()) { B.fullAt = 0; ensureFull(); }
    render();
  }
  /** A search, an open In progress / Waiting / Done section, or the old fold show the whole board. */
  const needsFull = () => (B.q && !/^g\d+$/.test(B.q)) || B.goalsOpen || B.waitOpen || B.doneOpen || B.oldOpen;
  function ensureFull() {
    if (B.full && Date.now() - B.fullAt < 60000) return Promise.resolve(B.full);
    if (B.fullLoading) return B.fullLoading;
    B.fullLoading = api('/api/board' + asQ())
      .then(f => { B.full = f; B.fullAt = Date.now(); render(); return f; })
      .catch(e => { toast('Could not load the whole board: ' + e.message); return null; })
      .finally(() => { B.fullLoading = null; });
    return B.fullLoading;
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
    el.style.display = c.ok ? 'none' : '';
    const p = (B.data && B.data.principal) || {};
    const h = document.querySelector('#view-board .board-head h2');
    if (h && h.firstChild && h.firstChild.nodeType === 3) h.firstChild.nodeValue = p.own ? p.name + "'s board " : 'Board ';
    el.innerHTML = c.ok
      ? '<b>' + esc(p.own ? p.name + ' Conductor ready' : 'Conductor ready') + '</b><span>' + esc(c.reason || '') + '</span>'
      : '<b>Buttons will not send</b><span>' + esc(c.reason || 'The Conductor session is not available.') + '</span>';
  }


  /* ---------- the board, phone-first (g1881) ---------------------------------------------------------
     Ashwar 14-Oct: "the opening of the board should focus first on the task which need my action ... So
     that I know what is the things I have to work on." One scroll, in the order he works:
       NEEDS YOU          only what waits on his tap or answer, each with its one-tap action, most urgent
                          first; anything older than a week folds into one group at the end.
       IN PROGRESS        open goals by lane (the owner session), stale ones flagged and sorted first.
       WAITING ON OTHERS  goals blocked on someone else, and asks in flight.
       DONE               recently closed goals, sent taps, probably-handled asks (folded).
     A search, or a gNNNN tapped in a chat, shows only its matches, goal card first. */
  const KIND_ORDER = { decide: 0, you: 1, nudge: 1, do: 2, check: 3, ask: 4, fyi: 5 };
  const PILL = { decide: 'Decide', you: 'Your move', nudge: 'Paused', do: 'Do', check: 'Check & close', ask: 'Reply', fyi: 'Read' };
  const OLD_DAYS = 7, FIRST_N = 12;
  const STATUS = { FRESH: 'On track', WATCH: 'Watching', STUCK: 'Stuck', LATE: 'Late', BLOCKED: 'Blocked',
    'BLOCKED-STALE': 'Blocked a week', 'AWAITING-VERIFICATION': 'Being checked', 'VERIFY-NOW': 'Check now', DELIVERED: 'Says done',
    ORPHAN: 'No owner', UNTOLD: 'Not handed over', UNRESPONSIVE: 'Not answering', OFFLINE: 'Owner offline', 'HANDED-OVER': 'Handed over' };
  const STALE = new Set(['STUCK', 'LATE', 'BLOCKED-STALE', 'UNRESPONSIVE', 'ORPHAN', 'UNTOLD', 'OFFLINE']);
  const LABELS = { yes: 'Yes', skip: 'Skip', answer: 'Answer…', done: 'Done ✓', reopen: 'Reinstate' };
  const SENT = { yes: 'Yes sent', skip: 'Skip sent', answer: 'Answer sent', done: 'Done sent', reopen: 'Reinstated' };

  const meName = () => { const d = B.data || {}, p = d.principal || {}; return (p.own && p.name) || d.owner_name || 'you'; };
  const goalKind = (g) => Filter.goalKind(g, meName());
  /** One plain line: the ask, else the first sentence — no "#123", "Conductor 04:16 IST:" or similar prefixes. */
  function plain(s, max) {
    max = max || 150;
    let t = String(s || '').replace(/\s+/g, ' ').trim();
    if (t === '-') return '';
    t = t.replace(/^#\d+\s*[:-]?\s*/, '').replace(/^(?:Conductor|Ashwar|Lane)?\s*\d{1,2}:\d{2}\s*IST\s*[:-]\s*/i, '');
    const end = t.search(/[a-z0-9)\]][.;!?]\s+(?=[A-Z(#])/);
    if (end > 40 && end < max) t = t.slice(0, end + 2).trim();
    return t.length > max ? t.slice(0, max - 1).replace(/\s+\S*$/, '') + '…' : t;
  }
  const whyText = (r) => [r.ask && r.text && r.text !== '-' && plain(r.text, 9999) !== plain(r.ask, 9999) ? r.text : '', r.note ? 'Note: ' + r.note : '']
    .filter(Boolean).join('\n\n');
  const ageTxt = (a) => a == null ? '' : a < 1 ? Math.max(1, Math.round(a * 24)) + 'h' : Math.round(a) + 'd';
  const goalAge = (g) => { const t = Date.parse(g.ts || g.closed_at || ''); return isNaN(t) ? null : (Date.now() - t) / 86400000; };
  const relatedAsks = (d, gid) => (d.inbox || []).filter(r => r.status === 'open' && new RegExp('\\b' + gid + '\\b', 'i').test((r.ask || '') + ' ' + (r.text || '')));

  function cardTitle(card) { return (card && card.dataset.title) || ''; }
  function cardAsk(card) { return (card && card.dataset.ask) || ''; }

  // What "Open session" lands on (g785): the card's anchor (a message uuid), else its own words.
  function landAttrs(r) {
    return (r.anchor ? ' data-anchor="' + esc(r.anchor) + '"' : '')
      + ' data-land="' + esc(String(r.text || r.ask || '').slice(0, 600)) + '"';
  }

  /** The card's buttons; the first is the primary action. labels overrides LABELS per kind (a goal's Done = Close). */
  function actionsHtml(id, kinds, done, handled, labels) {
    const L = Object.assign({}, LABELS, labels || {});
    const q = !handled && !done && queued(id);
    if (q) {
      // Composed, not sent: it goes with the others as ONE message; until then it can be taken back.
      return '<div class="bcard-done"><span class="bpill wait">Queued: ' + esc(String(L[q.kind] || q.kind).replace(/[….✓ ]+$/, '')) + '</span>'
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
    return '<div class="bcard-acts">' + kinds.map((k, i) =>
      '<button class="bbtn b-' + k + (i === 0 ? ' primary' : '') + '" data-act="' + k + '" data-target="' + esc(id) + '">' + esc(L[k]) + '</button>').join('') + '</div>';
  }

  const openBtn = (sid, label) => sid ? '<button class="bopen" data-open="' + esc(sid) + '">' + esc(label || 'Open') + ' ›</button>' : '';
  const pill = (cls, txt) => '<span class="bp ' + cls + '">' + esc(txt) + '</span>';

  /** A card that waits on him: pill, plain title (tap for the rest), lane and age, and its one-tap action. */
  /** blocked_on is written about him ("on Ashwar's tap, unchanged ..."); turn it into a line said to him. */
  function youText(t) {
    return String(t || '').replace(/^[\s,;:.-]*(on\s+)?/i, '').replace(/^(Ashwar|his)'s\b/i, 'Your').replace(/^his\b/i, 'Your').replace(/^Ashwar\b/i, 'You').trim();
  }

  function needCard(it) {
    const id = it.id;
    let title, more = '', lane = '', sid = '', acts = '', extra = '', land = '', sub = '';
    if (it.type === 'inbox') {
      const r = it.r;
      title = plain(r.ask || r.text) || '#' + r.n;
      more = whyText(r) || (plain(r.ask || r.text, 9999) !== String(r.ask || r.text || '').trim() ? String(r.ask || r.text || '') : '');
      lane = r.lane || ''; sid = r.openable && r.session ? r.session : ''; land = landAttrs(r);
      acts = actionsHtml(id, it.kind === 'fyi' ? ['done'] : it.kind === 'do' ? ['done', 'answer'] : ['answer', 'done'], r.acted, r.handled,
        it.kind === 'fyi' ? { done: 'Got it ✓' } : null);
      extra = '<span class="bnum">#' + r.n + '</span>';
    } else if (it.type === 'row') {
      const r = it.r;
      title = r.title; more = r.ask ? String(r.ask).slice(-600) : ''; lane = r.group || r.project || ''; sid = r.openable === false ? '' : r.id;
      acts = actionsHtml(id, ['yes', 'answer'], r.acted, r.handled, { yes: 'Yes, go on' });
    } else {
      const g = it.g;
      // Title = what the goal is; the line under it = what he must do (blocked_on, said to him, not about him).
      const must = youText(g.blocked_on);
      title = plain(g.title, 140);
      sub = it.kind === 'check' ? 'The owner says it is done. Check it, then close.' : (must ? (/^You/.test(must) ? '' : 'You: ') + plain(must, 110) : '');
      more = (it.kind !== 'check' && plain(must, 9999) !== must.trim() ? must + '\n\n' : '') + (g.progress ? 'Latest: ' + g.progress : '');
      lane = g.owner || ''; sid = g.session || '';
      acts = it.kind === 'check'
        ? actionsHtml(id, ['done', 'answer'], g.acted, null, { done: 'Close ✓', answer: 'Not yet…' })
        : actionsHtml(id, ['answer', 'yes'], g.acted, null, { yes: 'Go ahead' });
      extra = '<span class="bnum">' + esc(g.id) + '</span>';
    }
    const k = 'x' + id;
    return '<div class="bcard need k-' + it.kind + (it.old ? ' old' : '') + '" data-id="' + esc(id) + '"'
      + (it.type === 'goal' ? ' data-goal="' + esc(String(id).toLowerCase()) + '"' : '')
      + ' data-title="' + esc(title) + '" data-ask="' + esc(String(more).slice(0, 1500)) + '"'
      + (it.r && it.r.ts ? ' data-raised="' + esc(it.r.ts) + '"' : '') + land + '>'
      + '<div class="bmeta">' + pill('k-' + it.kind, PILL[it.kind]) + extra
        + (lane ? '<span class="blane">' + esc(lane) + '</span>' : '') + '<span class="bage">' + ageTxt(it.age) + '</span></div>'
      + '<div class="bcard-t bexp' + (B.expanded[k] ? ' open' : '') + '" role="button" tabindex="0" data-expand="' + esc(k) + '">'
        + '<div class="btext">' + esc(title) + (more ? '<span class="bmore">' + esc(more) + '</span>' : '') + '</div><span class="bgo"></span></div>'
      + (sub ? '<div class="bsubline">' + esc(sub) + '</div>' : '')
      + '<div class="bfoot">' + acts + openBtn(sid) + '</div>'
      + '</div>';
  }

  /** Everything that waits on him, most urgent first (Decide, his move, Do, Check & close, Reply, Read; newest first within). */
  function needsYou(d) {
    const out = [];
    for (const r of d.inbox || []) {
      if (r.status !== 'open' || Filter.isDone(r)) continue;
      const kind = r.ask_kind === 'decide' ? 'decide' : r.ask_kind === 'do' ? 'do' : r.ask_kind === 'fyi' ? 'fyi' : 'ask';
      out.push({ type: 'inbox', id: '#' + r.n, kind, age: Filter.ageOf(r), r });
    }
    for (const r of d.rows || []) {
      if (Filter.isDone(r) || !['decide', 'buried', 'nudge'].includes(r.bucket)) continue;
      out.push({ type: 'row', id: r.id, kind: r.bucket === 'nudge' ? 'nudge' : 'decide', age: r.age != null && r.age < 999 ? r.age : null, r });
    }
    for (const g of d.goals || []) {
      if (FINISHED.includes(g.status) || g.acted) continue;
      const k = goalKind(g);
      if (k === 'you' || k === 'check') out.push({ type: 'goal', id: g.id, kind: k, age: goalAge(g), g });
    }
    for (const it of out) it.old = it.age != null && it.age > OLD_DAYS;
    // A light board sends only the numbers of asks older than a week (they sit in a closed fold).
    for (const n of d.old_ids || []) out.push({ type: 'inbox', id: '#' + n, kind: 'ask', age: null, old: true, stub: true, r: { n, status: 'open' } });
    const age = (x) => x.age == null ? 1e6 : x.age;
    return out.sort((a, b) => (a.old - b.old) || (KIND_ORDER[a.kind] - KIND_ORDER[b.kind]) || (age(a) - age(b)));
  }

  /** The full goal: title, owner, status, latest progress, what he must do, done-when; and its actions. */
  function goalCard(g, d) {
    const k = goalKind(g), fin = FINISHED.includes(g.status);
    const st = fin ? g.status : (STATUS[g.condition] || (g.fresh ? 'New' : 'Open'));
    const stCls = fin ? 'st-done' : k === 'you' || k === 'check' ? 'st-you' : STALE.has(g.condition) ? 'st-stale' : k === 'wait' ? 'st-wait' : 'st-run';
    const must = fin ? '' : k === 'you' ? youText(g.blocked_on)
      : k === 'check' ? 'The owner says it is done. Check the result, then close it.' : '';
    const asks = relatedAsks(d, g.id);
    const row = (label, html, cls) => html ? '<div class="gkv' + (cls ? ' ' + cls : '') + '"><b>' + label + '</b><span>' + html + '</span></div>' : '';
    const acts = fin ? actionsHtml(g.id, ['reopen'], g.acted, null)
      : k === 'check' ? actionsHtml(g.id, ['done', 'answer'], g.acted, null, { done: 'Close ✓', answer: 'Not yet…' })
      : k === 'you' ? actionsHtml(g.id, ['answer', 'yes'], g.acted, null, { yes: 'Go ahead' })
      : actionsHtml(g.id, ['answer', 'done'], g.acted, null, { answer: 'Tell the owner…', done: 'Close ✓' });
    return '<div class="bcard goal s-' + k + '" data-id="' + esc(g.id) + '" data-goal="' + esc(String(g.id).toLowerCase()) + '"'
      + ' data-title="' + esc(g.id + ' ' + plain(g.title, 200)) + '" data-ask="' + esc(must || String(g.progress || '').slice(0, 600)) + '">'
      + '<div class="bmeta"><span class="bnum">' + esc(g.id) + '</span>' + pill(stCls, st) + (g.fresh ? pill('st-new', 'just updated') : '')
        + (g.due ? '<span class="bage">due ' + esc(String(g.due).slice(5, 10)) + '</span>' : '') + '</div>'
      + '<div class="gc-title">' + esc(plain(g.title, 220)) + '</div>'
      + row('You', esc(must), 'must')
      + row('Owner', g.owner ? esc(g.owner) : g.session ? esc(String(g.session).slice(0, 14)) + '…' : '<em>nobody yet</em>')
      + row('Latest', g.progress || g.outcome ? esc(String(g.progress || g.outcome).slice(0, 420)) : '<em>nothing reported yet</em>')
      + (k === 'wait' && g.blocked_on ? row('Waiting on', esc(String(g.blocked_on).replace(/^\W*on\s+/i, '').slice(0, 300))) : '')
      + row('Done when', g.checks && g.checks.length ? esc(String(g.checks[0]).slice(0, 300)) : '')
      + (asks.length ? '<div class="gkv"><b>Asks</b><span>' + asks.map(r => '<a class="boardlink" data-card="' + r.n + '">#' + r.n + '</a> '
          + esc(plain(r.ask || r.text, 80))).join('<br>') + '</span></div>' : '')
      + '<div class="bfoot">' + acts + openBtn(g.session) + '</div>'
      + '</div>';
  }

  /** One line per goal inside a lane; a tap opens the full card in place. */
  function goalRow(g, d) {
    const open = !!B.gexp[g.id];
    const stale = STALE.has(g.condition);
    return '<div class="grow' + (open ? ' open' : '') + '" data-goalrow="' + esc(g.id) + '">'
      + '<button class="grow-h" data-gexp="' + esc(g.id) + '" aria-expanded="' + open + '">'
        + '<span class="bnum">' + esc(g.id) + '</span><span class="grow-t">' + esc(plain(g.title, 120)) + '</span>'
        + pill(stale ? 'st-stale' : g.condition === 'AWAITING-VERIFICATION' ? 'st-wait' : 'st-run', STATUS[g.condition] || (g.fresh ? 'New' : 'Open')) + '</button>'
      + (g.progress && !open ? '<div class="grow-p">' + esc(plain(g.progress, 140)) + '</div>' : '')
      + (open ? goalCard(g, d) : '')
      + '</div>';
  }

  function sessionCard(r) {
    const sum = r.summary ? r.summary.filter(p => p[1]) : null;
    return '<div class="bcard row b-' + esc(r.bucket) + (r.acted ? ' acted' : '') + '" data-id="' + esc(r.id) + '"'
      + ' data-title="' + esc(r.title) + '" data-ask="' + esc(String(r.ask || '').slice(-600)) + '">'
      + '<div class="bmeta">' + pill('st-wait', (B.data.labels && B.data.labels[r.bucket] || r.bucket).split('—')[0].trim())
        + '<span class="blane">' + esc(r.group || r.project || '') + '</span><span class="bage">' + fmtAge(r.age) + '</span></div>'
      + '<div class="gc-title">' + esc(r.title) + '</div>'
      + (r.ask ? '<div class="grow-p">' + esc(plain(String(r.ask).slice(-500), 200)) + '</div>' : '')
      + (sum && sum.length ? '<div class="bcard-sum">' + sum.slice(0, 2).map(p => '<div><b>' + esc(p[0]) + '</b>' + esc(String(p[1]).slice(0, 160)) + '</div>').join('') + '</div>' : '')
      + '<div class="bfoot">' + actionsHtml(r.id, ['yes', 'answer', 'skip'], r.acted, r.handled, { yes: 'Yes, go on' }) + (r.openable === false ? '' : openBtn(r.id)) + '</div>'
      + '</div>';
  }

  const section = (id, title, n, hint, body, open) => '<details class="bsect" id="' + id + '"' + (open ? ' open' : '') + '>'
    + '<summary><span class="bs-t">' + esc(title) + '</span><span class="bs-n">' + n + '</span>' + (hint ? '<span class="bs-h">' + hint + '</span>' : '') + '</summary>'
    + body + '</details>';

  /** What the page holds, computed once per render: the four sections and the tab counts. */
  function model(light) {
    const d = B.full || light;
    let need = needsYou(B.full && B.fullAt >= B.dataAt ? B.full : light);
    // A newer light board carries only numbers for the week-old asks; the whole board, once here, fills them in.
    if (B.full && need.some(x => x.stub)) {
      const byN = new Map((B.full.inbox || []).map(r => [String(r.n), r]));
      need = need.map(x => { const r = x.stub && byN.get(String(x.r.n));
        return r ? { type: 'inbox', id: x.id, kind: r.ask_kind === 'decide' ? 'decide' : r.ask_kind === 'do' ? 'do' : r.ask_kind === 'fyi' ? 'fyi' : 'ask', age: Filter.ageOf(r), old: true, r } : x; });
    }
    const open = (d.goals || []).filter(g => !FINISHED.includes(g.status));
    const run = open.filter(g => goalKind(g) === 'run');
    const wait = open.filter(g => goalKind(g) === 'wait');
    const paused = (d.rows || []).filter(r => !Filter.isDone(r) && (r.bucket === 'un' || r.bucket === 'open'));
    const keep = (Number(d.finished_keep_days) || 3) * 86400000;
    const closed = (d.goals || []).filter(g => FINISHED.includes(g.status) && g.closed_at && Date.now() - Date.parse(g.closed_at) < keep)
      .sort((a, b) => String(b.closed_at).localeCompare(String(a.closed_at)));
    const sent = [].concat((d.inbox || []).filter(r => Filter.isDone(r)), (d.rows || []).filter(r => Filter.isDone(r)));
    return { need, run, wait, paused, closed, sent, waitingAsks: d.inbox_waiting || [], resolved: d.inbox_resolved || [],
      lightOnly: !B.full && !!light.light, counts: light.tab_counts || null };
  }

  function tabs(m) {
    const t = $('board-tabs');
    if (!t) return;
    const c = m.lightOnly && m.counts ? m.counts
      : { run: m.run.length + m.paused.length, wait: m.wait.length + m.waitingAsks.length, done: m.closed.length + m.sent.length + m.resolved.length };
    const fresh = m.need.filter(x => !x.old).length;
    t.innerHTML = [['bs-need', 'Needs you', fresh, 'need'], ['bs-run', 'In progress', c.run, ''], ['bs-wait', 'Waiting', c.wait, ''],
      ['bs-done', 'Done', c.done, '']]
      .map(([id, l, n, cls]) => '<button class="btab ' + cls + '" data-tab="' + id + '">' + esc(l) + ' <b>' + n + '</b></button>').join('');
    t.hidden = !!B.q;
  }

  function searchView(light) {
    const q = B.q;
    const isGoal = /^g\d+$/.test(q);
    // A goal id comes with the light board (/api/board/needs?goal=, any status), so it never needs the whole
    // board; a light board fetched for another goal is still on its way. Any other search needs the whole one.
    if (isGoal && light.goal !== q && !(light.goals || []).some(g => String(g.id).toLowerCase() === q) && !B.full) {
      return '<div class="bsearch-h"><span>Looking up <b>' + esc(q) + '</b>…</span><button class="linkish" data-clearq="1">Clear search</button></div>';
    }
    const seen = new Set();
    const d = isGoal ? Object.assign({}, B.full || {}, light, { goals: (light.goals || []).concat((B.full && B.full.goals) || [])
      .filter(g => !seen.has(g.id) && seen.add(g.id)) }) : B.full;
    if (!isGoal && !B.full) {
      ensureFull();
      return '<div class="bsearch-h"><span>Searching the whole board…</span><button class="linkish" data-clearq="1">Clear search</button></div>';
    }
    const goals = (d.goals || []).filter(g => isGoal ? String(g.id).toLowerCase() === q
      : (g.id + ' ' + g.title + ' ' + (g.progress || '') + ' ' + (g.owner || '')).toLowerCase().includes(q));
    const asks = (d.inbox || []).filter(r => r.status === 'open' && Filter.hay(r).includes(q))
      .map(r => ({ type: 'inbox', id: '#' + r.n, kind: r.ask_kind === 'decide' ? 'decide' : r.ask_kind === 'do' ? 'do' : r.ask_kind === 'fyi' ? 'fyi' : 'ask', age: Filter.ageOf(r), r }));
    const rows = isGoal ? [] : (d.rows || []).filter(r => Filter.hay(r).includes(q));
    const head = '<div class="bsearch-h"><span>' + (goals.length + asks.length + rows.length) + ' for <b>' + esc(q) + '</b></span>'
      + '<button class="linkish" data-clearq="1">Clear search</button></div>';
    if (!goals.length && !asks.length && !rows.length) {
      if (!B.full) return head + '<div class="empty">Looking it up…</div>';
      return head + '<div class="empty">' + (isGoal ? esc(q) + ' is not in the goal register.' : 'Nothing matches.') + '</div>';
    }
    return head + goals.slice(0, 30).map(g => goalCard(g, d)).join('')
      + (asks.length ? '<h4 class="bsub">Asks that mention it</h4>' + asks.map(needCard).join('') : '')
      + rows.map(sessionCard).join('');
  }

  function render() {
    const d = B.data;
    if (!d) return;
    $('board-built').textContent = fmtBuilt(d.built_at);
    staleBanner(d.bundle);
    conductorBanner();
    pendingBar();
    const m = model(d);
    tabs(m);
    if (B.q) { $('board-list').innerHTML = searchView(d); markClamped(); return; }

    const html = [];
    // NEEDS YOU — open; the first FIRST_N cards, then "show all"; anything older than a week in one fold at the end.
    const fresh = m.need.filter(x => !x.old), old = m.need.filter(x => x.old);
    const shown = B.showAllNeed ? fresh : fresh.slice(0, FIRST_N);
    const oldIds = old.filter(x => x.type === 'inbox' && !queued(x.id)).map(x => x.id);
    html.push('<section class="bsect need" id="bs-need"><h3 class="bs-title">Needs you <span class="bs-n">' + fresh.length + '</span></h3>'
      + (fresh.length ? '<p class="bs-h">Only what waits on your tap or answer. Most urgent first.</p>' : '<div class="empty">Nothing waits on you right now.</div>')
      + shown.map(needCard).join('')
      + (fresh.length > shown.length ? '<button class="bolder" data-more="need">Show ' + (fresh.length - shown.length) + ' more</button>' : '')
      + (old.length ? '<details class="bold-fold" id="bs-old"' + (B.oldOpen ? ' open' : '') + '><summary>' + old.length + ' older than a week — still open, probably stale</summary>'
          + (oldIds.length > 1 ? '<button class="linkish" data-bulk="old">Mark all ' + oldIds.length + ' done</button>' : '')
          + old.filter(x => !x.stub).map(needCard).join('')
          + (old.some(x => x.stub) && B.oldOpen ? '<div class="empty">Loading…</div>' : '') + '</details>' : '')
      + '</section>');

    // IN PROGRESS — open goals by lane, the lanes with stale goals first; then paused sessions.
    const lanes = new Map();
    for (const g of m.run) { const l = g.owner || 'No owner yet'; if (!lanes.has(l)) lanes.set(l, []); lanes.get(l).push(g); }
    const staleN = (gs) => gs.filter(g => STALE.has(g.condition)).length;
    const laneList = [...lanes.entries()].sort((a, b) => (staleN(b[1]) - staleN(a[1])) || (b[1].length - a[1].length) || a[0].localeCompare(b[0]));
    const nStale = m.run.filter(g => STALE.has(g.condition)).length;
    const lazy = m.lightOnly ? '<div class="empty">Loading…</div>' : '';
    html.push(section('bs-run', 'In progress', m.lightOnly && m.counts ? m.counts.run : m.run.length + m.paused.length,
      nStale ? '<em class="st-stale-t">' + nStale + ' stale</em>' : '',
      lazy + laneList.map(([lane, gs]) => {
        gs.sort((a, b) => STALE.has(b.condition) - STALE.has(a.condition));
        const s = staleN(gs);
        return '<details class="lane"' + (B.laneOpen[lane] ? ' open' : '') + ' data-lane="' + esc(lane) + '"><summary><span class="lane-t">' + esc(lane) + '</span>'
          + (s ? pill('st-stale', s + ' stale') : '') + '<span class="bs-n">' + gs.length + '</span></summary>'
          + gs.map(g => goalRow(g, d)).join('') + '</details>';
      }).join('')
      + (m.paused.length ? '<details class="lane" data-lane="__paused"' + (B.laneOpen.__paused ? ' open' : '') + '><summary><span class="lane-t">Paused sessions</span><span class="bs-n">' + m.paused.length + '</span></summary>'
          + '<p class="bs-h">These stopped with work left. Yes = keep going.</p>' + m.paused.map(sessionCard).join('') + '</details>' : ''),
      B.goalsOpen));

    // WAITING ON OTHERS
    html.push(section('bs-wait', 'Waiting on others', m.lightOnly && m.counts ? m.counts.wait : m.wait.length + m.waitingAsks.length, '',
      lazy + m.wait.map(g => '<div class="grow" data-goalrow="' + esc(g.id) + '"><button class="grow-h" data-gexp="' + esc(g.id) + '"><span class="bnum">' + esc(g.id) + '</span>'
          + '<span class="grow-t">' + esc(plain(g.title, 110)) + '</span></button>'
          + '<div class="grow-p">Waiting on: ' + esc(plain(String(g.blocked_on || STATUS[g.condition] || '').replace(/^\W*on\s+/i, ''), 140)) + '</div>'
          + (B.gexp[g.id] ? goalCard(g, d) : '') + '</div>').join('')
      + m.waitingAsks.map(r => '<div class="grow"><div class="grow-h static"><span class="bnum">#' + r.n + '</span><span class="grow-t">' + esc(plain(r.ask || r.text, 120)) + '</span></div>'
          + (r.lane ? '<div class="grow-p">' + esc(r.lane) + '</div>' : '') + '</div>').join(''),
      B.waitOpen));

    // DONE — folded
    html.push(section('bs-done', 'Done', m.lightOnly && m.counts ? m.counts.done : m.closed.length + m.sent.length + m.resolved.length, '',
      lazy + (m.sent.length ? '<h4 class="bsub">Your taps, sent</h4>' + m.sent.map(r => r.n != null ? needCard({ type: 'inbox', id: '#' + r.n, kind: r.ask_kind || 'ask', age: Filter.ageOf(r), r }) : sessionCard(r)).join('') : '')
      + (m.closed.length ? '<h4 class="bsub">Closed in the last ' + (Number(d.finished_keep_days) || 3) + ' days</h4>' + m.closed.map(g =>
          '<div class="grow done"><button class="grow-h" data-gexp="' + esc(g.id) + '"><span class="bnum">' + esc(g.id) + '</span><span class="grow-t">' + esc(plain(g.title, 110)) + '</span>'
          + pill('st-done', g.status) + '</button>' + (B.gexp[g.id] ? goalCard(g, d) : '') + '</div>').join('') : '')
      + (m.resolved.length ? '<h4 class="bsub">Probably handled — reinstate any that are not</h4>' + m.resolved.map(r =>
          '<div class="bcard need k-fyi" data-id="#' + r.n + '" data-title="' + esc(plain(r.ask || r.text)) + '"' + landAttrs(r) + '>'
          + '<div class="bmeta"><span class="bnum">#' + r.n + '</span><span class="blane">' + esc(r.why || '') + '</span></div>'
          + '<div class="gc-title">' + esc(plain(r.ask || r.text)) + '</div>'
          + '<div class="bfoot">' + actionsHtml('#' + r.n, ['reopen'], r.acted, r.handled) + openBtn(r.openable && r.session) + '</div></div>').join('') : ''),
      B.doneOpen));

    $('board-list').innerHTML = html.join('');
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
    const gx = e.target.closest('[data-gexp]');
    if (gx) {
      const id = gx.dataset.gexp;
      if (B.gexp[id]) delete B.gexp[id]; else B.gexp[id] = true;
      render();
      return;
    }
    if (e.target.closest('[data-clearq]')) { B.q = ''; $('board-q').value = ''; render(); return; }
    if (e.target.closest('[data-more="need"]')) { B.showAllNeed = true; render(); return; }
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
      // "Mark all done" on the week-old fold: one Done per ask, queued like any tap (undo works on each).
      const ids = bulk.dataset.bulk === 'old' ? needsYou(d).filter(x => x.old && x.type === 'inbox').map(x => x.id) : [];
      if (ids.length) enqueueAll('done', ids.filter(id => !queued(id)));
      return;
    }
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
    if (t.id === 'bs-run') B.goalsOpen = t.open;
    if (t.id === 'bs-wait') B.waitOpen = t.open;
    if (t.id === 'bs-old') B.oldOpen = t.open;
    if (t.id === 'bs-done') B.doneOpen = t.open;
    if (t.open && ['bs-run', 'bs-wait', 'bs-done', 'bs-old'].includes(t.id) && !B.full) ensureFull();
    if (t.dataset.lane) { if (t.open) B.laneOpen[t.dataset.lane] = true; else delete B.laneOpen[t.dataset.lane]; }
  }, true);

  $('board-q').oninput = (e) => { B.q = e.target.value.trim().toLowerCase(); render(); };
  // The section tabs jump to their section and open it.
  $('board-tabs').addEventListener('click', (e) => {
    const t = e.target.closest('[data-tab]');
    if (!t) return;
    const sec = $(t.dataset.tab);
    if (!sec) return;
    if (t.dataset.tab !== 'bs-need') ensureFull();
    if (sec.tagName === 'DETAILS') sec.open = true;
    sec.scrollIntoView({ block: 'start', behavior: 'smooth' });
  });
  $('btn-board').onclick = openBoard;
  const openIfHashed = () => {
    const m = /^#board(?:=([a-z]+))?$/.exec(location.hash);
    if (!m) return;
    // #board=goals must land on an OPEN register (In progress); collapsed it looks empty.
    if (m[1] === 'goals') { B.goalsOpen = true; B.q = ''; }
    openBoard().then(() => { if (m[1] === 'goals' && $('bs-run')) $('bs-run').scrollIntoView({ block: 'start' }); });
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
