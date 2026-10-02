// settings-ui.js — Settings, phone pairing and first-run welcome. Same screen on phone and desktop.
(function () {
  'use strict';

  var MODULES = [
    ['app', 'Phone & desktop app', 'Sessions, chat, send, model and effort, notifications. Turning this off also turns off this screen after a restart.'],
    ['autoResume', 'Auto-resume', 'Continue sessions that stopped on a usage limit (when it resets) or because Claude Desktop crashed.'],
    ['orchestrator', 'Orchestrator', 'Master/worker tools for Claude (relaymote_* MCP tools): spawn workers, track a fleet, goals, waiting for results.'],
    ['masterNotify', 'Wake the master', 'When a worker finishes or asks something, tell the session that is coordinating it.'],
    ['chipAutostart', 'Auto-start task chips', 'Off by default. Presses Start on background-task suggestions in sessions a master owns, only while you are away from the keyboard, so a master’s suggested work begins without you.'],
    ['routines', 'Routines', 'Show Claude Code scheduled tasks in the app.'],
    ['organizer', 'Organizer', 'Put each new session into its project\'s group automatically. Sessions you have grouped yourself are never moved.'],
    ['board', 'Board', 'A tappable to-do board read from board.json (for a Conductor session). See docs/BOARD.md.'],
    ['goalChaser', 'Goal chaser', 'Keeps track of goals and nudges the owning session until each one is done.'],
    ['cacheKeeper', 'Cache keeper', 'Nudges idle sessions before their 1-hour prompt cache expires, so work continues cheaply.'],
    ['accounts', 'Accounts', 'Several Claude accounts on this computer: keep their sessions, groups and routines the same.'],
    ['summaries', 'Session overviews', 'Off by default. A 5-line card per changed session (goal, done, in progress, blocked on, last ask), written by the model engine (Settings › Model engine).'],
    ['roles', 'Roles for routing', 'Records what each session is for, so messages reach the right owner. Free (title, tags, project) unless a model engine is set.'],
    ['inbox', 'Inbox', 'Things only you can do, numbered and never lost. Stays empty until a session adds to it.'],
    ['inboxAutoResolve', 'Inbox auto-resolve', 'Off by default. Moves an item to “probably handled” when there is evidence. Never marks it done, and never touches money, deletion or outward items on weak evidence.'],
    ['transcriptIndex', 'Transcript index', 'Reads transcripts into the project index: pending questions, buried asks, fleet tree, context size. Incremental and time-limited.'],
    ['digests', 'Digests', 'Off by default. A lean per-session digest (your turns and the answers, no tool traffic) for masters and overviews.'],
    ['osTasks', 'Scheduled-task inventory', 'Off by default. Lists Windows Task Scheduler, launchd or cron entries with the project each belongs to.'],
    ['hygiene', 'Context hygiene', 'Every 30 min, says what each session’s context needs (compact, write state first, rotate, archive, hold). Writes a report only.'],
    ['autoUpdate', 'Automatic updates', 'On by default. Every 6 hours Relaymote checks GitHub for a new release and, on a Windows install, installs it and restarts by itself (about 15 seconds; never while a task runs). A release is installed only when its checksum file carries a valid signature by the Relaymote release key. Other copies only tell you (`relaymote update`).'],
    ['reaper', 'Idle-CLI reaper', 'Off by default. Frees the memory (~400 MB each) of sessions idle 3 h or more, using Claude’s own teardown; the next message resumes them. Only logs for its first 24 h. Never touches a session that is running, unread, waiting on you, on Remote Control, or owns a goal.'],
    ['autoCompact', 'Auto-compact', 'Off by default. Types /compact only in a session’s last warm cache cycle, when it is idle and has written its state down. Never cold, running or waiting on you.'],
    ['directives', 'Directives', 'Off by default. Daily, collects your own instructions per project into DIRECTIVES.md in that folder. Never overwrites a file you wrote.'],
    ['finishHook', 'Finish-the-task hook', 'Off by default. After “relaymote hooks install”, a session may not end its turn on a question it can answer itself.'],
  ];
  var REMOTE = [
    ['off', 'This computer only', 'The app answers on 127.0.0.1. Nothing is exposed.'],
    ['tailscale', 'Tailscale', 'Reachable from your devices on your tailnet. Install Tailscale on both.'],
    ['lan', 'Same Wi-Fi', 'Reachable from devices on your local network (plain HTTP, no push notifications).'],
    ['cloudflare-quick', 'Anywhere — quick link', 'A free random https://….trycloudflare.com address. No account. Changes when Relaymote restarts.'],
    ['cloudflare-named', 'Anywhere — my own address', 'A fixed https address on your domain through your free Cloudflare account. Best for daily use.'],
  ];

  var S = null, section = 'general', pairData = null, saving = false, desk = null, modelList = null, deskMsg = null;
  var EFFORTS = ['low', 'medium', 'high', 'max'];
  var LEVELS = [['easy', 'Easy', 'Look-ups, renames, small edits.'], ['medium', 'Medium', 'Ordinary features and fixes.'],
    ['hard', 'Hard', 'Debugging, research, multi-file work.'], ['extraHard', 'Extra hard', 'Architecture, concurrency, anything that failed once (escalation).']];

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function req(path, body) {
    var o = { credentials: 'same-origin', headers: { 'Content-Type': 'application/json' } };
    if (body !== undefined) { o.method = 'POST'; o.body = JSON.stringify(body); }
    return fetch(path, o).then(function (r) { return r.json(); });
  }
  function note(msg, err) { if (typeof window.toast === 'function') window.toast(msg, err); }

  function ensureDom() {
    if ($('view-settings')) return;
    document.body.insertAdjacentHTML('beforeend',
      '<section id="view-settings" class="sheet hidden settings" role="dialog" aria-modal="true" aria-label="Settings">' +
      '<div class="sheet-body">' +
      '<div class="grab"></div>' +
      '<h2 id="set-title">Settings</h2>' +
      '<nav class="chips" id="set-tabs" aria-label="Settings sections"></nav>' +
      '<div id="set-body" class="set-body"></div>' +
      '<div class="sheet-actions"><button id="btn-close-settings" class="ghost">Done</button></div>' +
      '</div></section>');
    $('btn-close-settings').onclick = close;
    $('view-settings').addEventListener('click', function (e) { if (e.target.id === 'view-settings') close(); });
    var head = document.querySelector('.drawer-head');
    if (head && !$('btn-settings')) {
      var b = document.createElement('button');
      b.id = 'btn-settings'; b.className = 'icon-btn'; b.title = 'Settings'; b.setAttribute('aria-label', 'Settings');
      b.textContent = '⚙';
      b.onclick = function () { open('general'); };
      var closeBtn = $('btn-close-drawer');
      head.insertBefore(b, closeBtn || null);
    }
  }

  function tabs() {
    var list = [['general', 'Modules'], ['desktop', 'Desktop connection'], ['models', 'Models'], ['remote', 'Remote access'], ['pair', 'Pair a phone'], ['notify', 'Notifications'], ['engine', 'Model engine'], ['advanced', 'Advanced'], ['about', 'About']];
    $('set-tabs').innerHTML = list.map(function (t) {
      return '<button class="chip' + (t[0] === section ? ' on' : '') + '" data-sec="' + t[0] + '">' + t[1] + '</button>';
    }).join('');
    Array.prototype.forEach.call($('set-tabs').querySelectorAll('button'), function (b) {
      b.onclick = function () { section = b.dataset.sec; render(); };
    });
  }

  // Modules shown in three groups so the list stays short: the everyday ones open, the rest folded away.
  var MODULE_GROUPS = [
    ['Main features', ['app', 'autoResume', 'organizer', 'accounts', 'board', 'inbox', 'goalChaser', 'cacheKeeper', 'routines', 'autoUpdate'], true],
    ['Orchestration — acts in your sessions', ['orchestrator', 'masterNotify', 'chipAutostart', 'autoCompact', 'reaper', 'inboxAutoResolve', 'finishHook'], false],
    ['Background reports — reads and writes files only', ['transcriptIndex', 'hygiene', 'roles', 'digests', 'summaries', 'osTasks', 'directives'], false],
  ];
  function moduleGroups(m) {
    var byKey = {}, used = {};
    MODULES.forEach(function (x) { byKey[x[0]] = x; });
    function rows(keys) {
      return keys.filter(function (k) { return byKey[k]; }).map(function (k) { used[k] = 1; var x = byKey[k]; return toggle('modules.' + x[0], x[1], x[2], !!m[x[0]]); }).join('');
    }
    var h = MODULE_GROUPS.map(function (g) {
      var body = rows(g[1]);
      var on = g[1].filter(function (k) { return m[k]; }).length;
      return g[2] ? '<h3>' + esc(g[0]) + '</h3>' + body
        : '<details class="set-group"><summary>' + esc(g[0]) + ' <small>' + on + ' of ' + g[1].length + ' on</small></summary>' + body + '</details>';
    }).join('');
    var rest = MODULES.filter(function (x) { return !used[x[0]]; }).map(function (x) { return x[0]; });
    return h + (rest.length ? '<h3>Other</h3>' + rows(rest) : '');
  }
  function toggle(key, label, desc, on) {
    return '<label class="set-row"><span class="set-text"><b>' + esc(label) + '</b><small>' + esc(desc) + '</small></span>' +
      '<input type="checkbox" class="set-switch" data-key="' + key + '"' + (on ? ' checked' : '') + '></label>';
  }
  function field(key, label, value, hint, type) {
    return '<label class="set-field"><span><b>' + esc(label) + '</b>' + (hint ? '<small>' + esc(hint) + '</small>' : '') + '</span>' +
      '<input data-field="' + key + '" type="' + (type || 'text') + '" value="' + esc(value) + '" autocomplete="off"></label>';
  }

  function sel(key, label, value, options, hint) {
    var opts = options.slice();
    if (value && opts.every(function (o) { return o[0] !== value; })) opts.push([value, value]);
    return '<label class="set-field"><span><b>' + esc(label) + '</b>' + (hint ? '<small>' + esc(hint) + '</small>' : '') + '</span>' +
      '<select data-field="' + key + '">' + opts.map(function (o) {
        return '<option value="' + esc(o[0]) + '"' + (o[0] === (value || '') ? ' selected' : '') + '>' + esc(o[1]) + '</option>';
      }).join('') + '</select></label>';
  }

  function save(patch, quiet) {
    if (saving) return Promise.resolve();
    saving = true;
    return req('/api/settings', patch).then(function (r) {
      saving = false;
      if (r && r.ok) { S = r.settings; applyVisibility(); if (!quiet) note('Saved'); render(); }
      else note('Could not save: ' + ((r && r.error) || 'unknown error'), true);
    }).catch(function (e) { saving = false; note('Could not save: ' + e.message, true); });
  }
  function setPath(obj, dotted, val) {
    var parts = dotted.split('.'), o = obj;
    for (var i = 0; i < parts.length - 1; i++) { o[parts[i]] = o[parts[i]] || {}; o = o[parts[i]]; }
    o[parts[parts.length - 1]] = val;
    return obj;
  }
  function getPath(obj, dotted) { return dotted.split('.').reduce(function (o, k) { return o == null ? o : o[k]; }, obj); }

  function renderGeneral() {
    var m = S.modules || {};
    return '<p class="set-lead">Turn features on or off. Changes apply within a minute; the app module needs a restart.</p>' +
      moduleGroups(m) +
      '<h3>While you work</h3>' +
      field('idleGateSeconds', 'Idle gate (seconds)', S.idleGateSeconds, 'Relaymote drives the Claude Desktop window. It waits until you have not touched keyboard or mouse for this long. 0 = never wait.', 'number');
  }

  function loadDesk() {
    return req('/api/desktop').then(function (r) { desk = r; banner(); if (section === 'desktop' || section === 'welcome') render(); return r; }).catch(function () {});
  }

  function desktopSteps() {
    var mac = desk && desk.platform === 'darwin';
    return '<ol class="set-steps">' +
      '<li><b>Turn on Developer Mode</b> (once). In Claude Desktop open ' + (mac ? 'the <b>Help</b> menu in the menu bar' : 'the <b>☰</b> menu at the top-left of the window, then <b>Help</b>') +
      ' › <b>Troubleshooting</b> › <b>Enable Developer Mode</b>. This menu is hidden until you do it; afterwards a new <b>Developer</b> menu appears.</li>' +
      '<li><b>Turn on the Main Process Debugger.</b> ' + (mac ? 'Menu bar' : '☰') + ' › <b>Developer</b> › <b>Enable Main Process Debugger</b>, then press OK.</li>' +
      '<li>Press <b>Check again</b>.</li></ol>' +
      '<p class="set-small">The debugger switches itself off whenever Claude Desktop restarts. ' + (mac ? 'On macOS, repeat step 2 after a restart (automatic re-enabling is Windows-only for now).' : 'Relaymote turns it back on for you once Claude Desktop is signed in, after a 3-2-1 countdown on the computer (Advanced › Re-enable automatically).') +
      ' It listens on this computer only (127.0.0.1).</p>';
  }

  function renderDesktop() {
    if (!desk) { loadDesk(); return '<div class="empty">Checking Claude Desktop…</div>'; }
    var h = '<p class="set-lead">Relaymote reads your sessions from disk and acts through Claude Desktop’s own main-process debugger. Nothing else to install, no Remote Control to switch on.</p>';
    if (!desk.desktopData) h += '<div class="set-card set-warn">Claude Desktop’s data was not found on this computer. Install Claude Desktop, sign in and open the Code tab once.</div>';
    h += desk.cdp
      ? '<div class="set-card"><b>✔ Connected.</b> The debugger answers on port ' + esc(desk.cdpPort) + '. Everything works.</div>'
      : '<div class="set-card set-warn"><b>Not connected.</b> Reading sessions works; sending, answering and resuming need the debugger.</div>';
    if (!desk.cdp && desk.desktopData) h += desk.devMode
      ? '<p class="set-small">✔ Developer Mode is on.</p>'
      : '<div class="set-card"><b>Developer Mode is off.</b><p>Relaymote can switch it on for you. Then quit Claude Desktop completely and open it again.</p><button class="ghost primary" id="set-dev-mode">Turn on Developer Mode</button></div>';
    h += '<div class="set-inline"><button class="ghost" id="set-desk-check">Check again</button>' +
      (!desk.cdp && desk.canAutoEnable && desk.devMode ? '<button class="ghost primary" id="set-desk-enable">Turn it on for me</button>' : '') + '</div>';
    if (deskMsg) h += '<div class="set-card' + (deskMsg.err ? ' set-warn' : '') + '" id="set-desk-result">' + esc(deskMsg.text) + '</div>';
    if (!desk.cdp && desk.canAutoEnable && desk.devMode) h += '<p class="set-small">“Turn it on for me” shows a 3-2-1 countdown on the computer, then clicks through Claude Desktop’s menus in a few seconds. The window keeps its size.</p>';
    h += '<h3>How to turn it on</h3>' + desktopSteps();
    return h;
  }

  function renderModels() {
    if (!modelList) {
      req('/api/models').then(function (r) { modelList = (r && r.models) || []; if (section === 'models') render(); }).catch(function () { modelList = []; render(); });
      return '<div class="empty">Loading models…</div>';
    }
    var mo = modelList.map(function (m) { return [m, m]; });
    // A stored id ("claude-sonnet-5-5", or a dated "claude-haiku-4-5-2025…") is shown as the picker's
    // own label, not as a second raw option beside it; saving writes the label, which the router maps.
    var asLabel = function (v) {
      if (!v || modelList.indexOf(v) >= 0) return v;
      var id = String(v).toLowerCase().replace(/-\d{8}$/, '');
      var hit = modelList.filter(function (m) { return 'claude-' + String(m).toLowerCase().replace(/[\s.]+/g, '-') === id; })[0];
      return hit || v;
    };
    var eo = EFFORTS.map(function (e) { return [e, e]; });
    var n = S.newSession || {}, lv = S.levels || {};
    var h = '<p class="set-lead">Which model and effort Relaymote uses. The list comes from your Claude Desktop model picker.</p>' +
      '<h3>New sessions you start from Relaymote</h3>' +
      sel('newSession.model', 'Default model', asLabel(n.model) || '', [['', 'Same as Claude Desktop']].concat(mo)) +
      sel('newSession.effort', 'Default effort', n.effort || '', [['', 'Same as Claude Desktop']].concat(eo)) +
      '<label class="set-field"><span><b>Default instructions</b><small>Added to the first message of every session you start from Relaymote, e.g. “Keep replies short. Run the tests before you say done.”</small></span>' +
      '<textarea data-field="newSession.instructions" rows="3">' + esc(n.instructions || '') + '</textarea></label>' +
      toggle('tierBeforeWake', 'Use these before a wake', 'Before the Conductor or a master wakes an existing session, switch it to the default model and effort above. Every session Relaymote starts gets them before its first message.', S.tierBeforeWake !== false) +
      field('tierOverrideHours', 'Keep my own changes for (hours)', S.tierOverrideHours != null ? S.tierOverrideHours : 4, 'A model or effort you change by hand in a session is left alone this long; after that Relaymote may put the default back.', 'number') +
      '<h3>Workers by difficulty</h3><p class="set-small">When a master or the Conductor spawns a worker, Relaymote grades the task and starts it on the model below. A task that fails can be escalated one level.</p>';
    LEVELS.forEach(function (L) {
      var cur = lv[L[0]] || {};
      h += '<div class="set-level"><b>' + esc(L[1]) + '</b><small>' + esc(L[2]) + '</small><div class="set-inline">' +
        sel('levels.' + L[0] + '.model', 'Model', asLabel(cur.model) || '', mo) + sel('levels.' + L[0] + '.effort', 'Effort', cur.effort || '', eo) + '</div></div>';
    });
    return h;
  }

  function banner() {
    var b = $('relaymote-desk-banner');
    var show = desk && desk.ok && !desk.cdp && S;
    if (!show) { if (b) b.remove(); return; }
    if (b) return;
    document.body.insertAdjacentHTML('afterbegin', '<div id="relaymote-desk-banner" class="set-banner" role="status">Claude Desktop is not connected — sending and resuming are paused. <a href="#" id="relaymote-desk-fix">Set it up</a></div>');
    $('relaymote-desk-fix').onclick = function (e) { e.preventDefault(); open('desktop'); };
  }

  function renderRemote() {
    var r = S.remote || {};
    var t = (pairData && pairData.tunnel) || {};
    var h = '<p class="set-lead">How your phone reaches this computer. The app always needs your access key (it is inside the pairing QR code), so an address alone lets nobody in.</p>';
    h += REMOTE.map(function (x) {
      return '<label class="set-radio"><input type="radio" name="remote" value="' + x[0] + '"' + (r.mode === x[0] ? ' checked' : '') + '>' +
        '<span><b>' + esc(x[1]) + '</b><small>' + esc(x[2]) + '</small></span></label>';
    }).join('');
    if (r.mode === 'cloudflare-quick' || r.mode === 'cloudflare-named') {
      h += '<div class="set-card">';
      if (!t.cloudflared) {
        h += '<b>Install cloudflared first</b><p>Windows: <code>winget install Cloudflare.cloudflared</code><br>macOS: <code>brew install cloudflared</code><br>Then press Check again.</p><button class="ghost" id="set-recheck">Check again</button>';
      } else if (r.mode === 'cloudflare-quick') {
        h += '<b>Status: ' + esc(t.status || 'stopped') + '</b>' + (t.url ? '<p>' + esc(t.url) + '</p>' : '') + (t.error ? '<p class="set-err">' + esc(t.error) + '</p>' : '') +
          '<p>Open <b>Pair a phone</b> to scan the link.</p>';
      } else {
        h += '<b>Step 1 — connect your Cloudflare account</b>';
        h += t.loggedIn ? '<p>✔ This computer is authorised.</p>'
          : '<p>You need a free Cloudflare account with a domain on it.</p><button class="ghost primary" id="set-cf-login">Log in to Cloudflare</button>';
        h += '<b>Step 2 — choose your address</b>' +
          '<div class="set-inline"><input id="set-cf-host" placeholder="relaymote.example.com" value="' + esc(r.hostname || '') + '"><button class="ghost primary" id="set-cf-setup"' + (t.loggedIn ? '' : ' disabled') + '>Create</button></div>';
        if (r.hostname) h += '<p>Status: <b>' + esc(t.status || 'stopped') + '</b>' + (t.error ? ' — <span class="set-err">' + esc(t.error) + '</span>' : '') + '</p>';
        h += '<details><summary>Optional: Cloudflare Access (email login)</summary><p>Protect the address with Cloudflare Zero Trust Access. Enter your team name and the application AUD tag; Relaymote then accepts verified Access logins without the key.</p>' +
          field('remote.access.team', 'Team domain', (r.access || {}).team || '', 'e.g. myteam.cloudflareaccess.com') +
          field('remote.access.aud', 'Application AUD tag', (r.access || {}).aud || '', '') + '</details>';
      }
      h += '</div>';
    }
    if (r.mode === 'tailscale') h += '<div class="set-card"><p>Install Tailscale on this computer and your phone, sign both into the same account, then use <b>Pair a phone</b>.</p></div>';
    return h;
  }

  function renderPair() {
    if (!pairData) { loadPair(); return '<div class="empty">Loading…</div>'; }
    var links = pairData.links || [];
    var best = links[0];
    var h = '<p class="set-lead">Scan with your phone’s camera. The link signs the phone in and remembers it. Then use your browser’s <b>Add to Home screen</b> to install Relaymote like an app.</p>';
    if (best && best.kind === 'local') h += '<div class="set-card set-warn">This computer is not reachable from your phone yet. Choose an option in <a href="#" id="go-remote">Remote access</a> first.</div>';
    h += links.map(function (l, i) {
      return '<div class="set-qr' + (i ? ' small' : '') + '"><div class="qr">' + (l.qr || '') + '</div><div><b>' + esc(l.label) + '</b><code class="set-url">' + esc(l.url) + '</code>' +
        '<button class="ghost set-copy" data-url="' + esc(l.url) + '">Copy link</button></div></div>';
    }).join('');
    h += '<p class="set-small">The link contains your access key — treat it like a password. <a href="#" id="set-rotate">Issue a new key</a> to sign out every phone.</p>';
    return h;
  }

  function renderNotify() {
    var n = S.notifications || {};
    return '<p class="set-lead">Push notifications need HTTPS (Cloudflare) or this computer. Tap 🔔 in the session list on each phone to subscribe.</p>' +
      toggle('notifications.enabled', 'Notifications', 'Master switch.', n.enabled !== false) +
      toggle('notifications.awaiting', 'Needs your input', 'A session is waiting for an answer or a permission.', n.awaiting !== false) +
      toggle('notifications.done', 'Finished', 'A session finished its turn.', n.done !== false) +
      contactField(n.pushSubject || '') +
      backupSection(n);
  }

  // Apple's push service refuses a token without a real contact, so ask until there is one.
  var CONTACT_RX = /^mailto:[^@\s]+@[^@\s]+\.[^@\s]+$|^https:\/\/[^\s\/]+\.[^\s]+/i;
  function contactField(v) {
    var ok = CONTACT_RX.test(String(v).trim());
    return (ok ? '' : '<div class="set-card set-warn"><b>Add a contact for push.</b> Apple (iPhone, Safari) may refuse notifications until this is a real address, e.g. <code>mailto:you@example.com</code>.</div>') +
      field('notifications.pushSubject', 'Contact for push services', v, 'A mailto: or https: address; push services may use it to contact you. Used from the next notification on.');
  }

  function backupSection(n) {
    var b = n.backup || {};
    var kind = b.kind || 'off';
    var h = '<h3>Backup channel</h3><p class="set-small">Used when web push reaches no phone — for example on Same Wi-Fi, where push cannot work. Off by default.</p>' +
      sel('notifications.backup.kind', 'Send alerts through', kind, [['off', 'Nothing (off)'], ['ntfy', 'ntfy topic'], ['webhook', 'Webhook (POST JSON)'], ['command', 'A command on this computer']]);
    if (kind === 'ntfy') h += field('notifications.backup.url', 'ntfy topic URL', b.url || '', 'e.g. https://ntfy.sh/<a long random topic>. Anyone who knows a public topic can read it — use a long random name or your own server.');
    if (kind === 'webhook') h += field('notifications.backup.url', 'Webhook URL', b.url || '', 'Receives {title, body, text, kind, url} as JSON.');
    if (kind === 'command') h += field('notifications.backup.command', 'Command', b.command || '', 'Runs on this computer. The alert is in RELAYMOTE_ALERT_TITLE / _BODY / _KIND / _URL and as JSON on stdin.');
    if (kind !== 'off') {
      h += toggle('notifications.backup.always', 'Also when push works', 'Send every alert through this channel too, not only when push reaches no phone.', b.always === true) +
        field('notifications.maxPer10Min', 'At most this many per 10 minutes', n.maxPer10Min || 6, 'Alerts over the cap are dropped, never queued or retried.', 'number') +
        '<div class="set-inline"><button class="ghost" id="set-backup-test">Send a test</button></div>';
    }
    return h;
  }

  function renderAdvanced() {
    var w = S.workers || {}, G = S.goals || {}, C = S.cacheKeeper || {};
    return '<p class="set-lead">Ports apply after restarting Relaymote.</p>' +
      field('appPort', 'App port', S.appPort, 'The phone/desktop app.', 'number') +
      field('port', 'Control port', S.port, 'Local API used by the CLI and MCP tools (loopback only).', 'number') +
      field('cdpPort', 'Claude Desktop debugger port', S.cdpPort, 'Developer › Enable Main Process Debugger in Claude Desktop.', 'number') +
      toggle('autoEnableDebugger', 'Re-enable the debugger automatically', 'Windows: when Claude Desktop starts and you are signed in, Relaymote shows a 3-2-1 countdown on the computer and switches the debugger on in a few seconds. The window keeps its size.', S.autoEnableDebugger !== false) +
      toggle('followClaude', 'Run Relaymote only while Claude Desktop is open', 'Windows, with the tray icon: Relaymote starts when Claude Desktop opens. When Desktop exits, Relaymote runs the account sync (if it is on) and then stops. It waits for running Relaymote tasks first.', S.followClaude === true) +
      '<h3>Workers</h3>' +
      '<label class="set-field"><span><b>Trusted project folders</b><small>Headless workers may open any folder directly inside these without Claude Code’s trust prompt, e.g. your projects folder. One absolute path per line; a whole drive is refused. Empty = only Relaymote’s own folders and each task’s folder.</small></span>' +
      '<textarea data-field="trustedRoots" data-list="1" rows="2" autocomplete="off">' + esc((S.trustedRoots || []).join('\n')) + '</textarea></label>' +
      field('workers.concurrency', 'Headless workers at once', w.concurrency, '', 'number') +
      field('workers.guiConcurrency', 'Desktop workers at once', w.guiConcurrency, '', 'number') +
      '<h3>Conductor</h3>' +
      field('conductorSession', 'Conductor session id', S.conductorSession || '', 'Set when a session calls relaymote_become_conductor: the one session above all projects. Masters report to it and the Board sends your taps to it.') +
      field('board.dir', 'Board folder', (S.board || {}).dir || '', 'Folder containing board.json. Blank = the default in Relaymote’s data folder.') +
      field('ownerIndex', 'Owner index folder', S.ownerIndex || '', 'Optional folder describing which session owns which topic.') +
      '<h3>Conductor behaviour</h3>' +
      '<p class="set-lead">How hard Relaymote chases and wakes your sessions. The defaults suit most people; your own numbers stay in settings.json on this computer.</p>' +
      toggle('goals.autoSpawn', 'Start a session for unowned goals', 'When no session owns a goal, start one in its project folder.', !!G.autoSpawn) +
      field('goals.quietHours', 'Chase after (hours without a report)', G.quietHours, 'A goal with no progress report for this long counts as stuck and its owner is asked for status.', 'number') +
      field('goals.warmPingMinQuietHours', 'Chase a warm session after (hours)', G.warmPingMinQuietHours, 'A session whose cache is still warm costs little to wake, so it may be asked sooner.', 'number') +
      field('goals.rechaseHours', 'Ask again after (hours)', G.rechaseHours, 'Hold time before the same stuck goal is chased again.', 'number') +
      field('goals.maxChases', 'Give up after (chases)', G.maxChases, 'After this many unanswered chases the goal is flagged to you instead of chased again.', 'number') +
      field('goals.maxChasesPerCycle', 'Messages per cycle', G.maxChasesPerCycle, 'Pace: at most this many sessions are woken per pass. Each owner gets one message carrying all its goals.', 'number') +
      field('cacheKeeper.windowMinutes', 'Prompt-cache window (minutes)', C.windowMinutes, 'How long your plan keeps a session’s prompt cache. Claude’s default is 60.', 'number') +
      field('cacheKeeper.pingFromMinutes', 'Warm ping from (minutes idle)', C.pingFromMinutes, 'Warm-window sends: a nudge inside the cache window is cheap, one after it re-reads the whole context.', 'number') +
      field('cacheKeeper.pingUntilMinutes', 'Warm ping until (minutes idle)', C.pingUntilMinutes, 'Must end before the cache window (' + (C.windowMinutes || 60) + ' min).', 'number') +
      field('cacheKeeper.coldAfterHours', 'Wake a cold session after (hours)', C.coldAfterHours, 'Unless a goal is late.', 'number') +
      toggle('cacheKeeper.keepConductorWarm', 'Keep the Conductor warm', 'At most twice in 3 hours, only while goal owners are working.', !!C.keepConductorWarm) +
      '<p class="set-lead">Usage-limit resets are read from Claude itself for every signed-in account (Auto-resume), so there is nothing to enter here.</p>';
  }

  function renderEngine() {
    var e = S.engine || {}, o = e.openai || {}, k = e.kind || 'none', sm = S.summaries || {}, ro = S.roles || {};
    var plan = k === 'claude-cli' || k === 'baton-worker';
    return '<p class="set-lead">The model that writes session overviews and the roles database. Off by default: with <b>None</b>, nothing is ever sent to a model and roles use a free heuristic.</p>' +
      sel('engine.kind', 'Engine', k, [['none', 'None (off)'], ['openai', 'OpenAI-compatible server'], ['claude-cli', 'Claude CLI (your Claude plan)'], ['baton-worker', 'Relaymote worker (your Claude plan)']]) +
      (plan ? '<div class="set-card set-warn"><b>Uses your own Claude plan.</b> Every overview and role is a real request that counts toward your usage limits. Keep the caps below small and pick a small model.</div>' : '') +
      (k === 'none' ? '' : field('engine.model', 'Model', e.model || '', plan ? 'Blank = haiku. A small model is enough.' : 'The model id your server serves.')) +
      (k === 'openai' ? field('engine.openai.baseUrl', 'Server address', o.baseUrl || '', 'Base URL ending in /v1, e.g. http://127.0.0.1:8080/v1') +
        field('engine.openai.apiKeyEnv', 'API key environment variable', o.apiKeyEnv || '', 'The NAME of an environment variable holding the key (e.g. MY_LLM_KEY). The key itself is never stored in settings. Blank = no key.') : '') +
      (k === 'none' ? '' : toggle('engine.requireModel', 'Refuse a substituted model', 'Reject an answer when the server reports a different model than the one asked for, or will not say.', !!e.requireModel) +
        field('engine.timeoutSec', 'Timeout per request (seconds)', e.timeoutSec || 180, '', 'number')) +
      '<h3>Session overviews</h3>' +
      field('summaries.cap', 'Sessions per pass', sm.cap || 6, 'Hard cap; one request at a time.', 'number') +
      field('summaries.budgetMin', 'Time budget per pass (minutes)', sm.budgetMin || 20, '', 'number') +
      field('summaries.days', 'Only sessions active in the last (days)', sm.days || 14, '', 'number') +
      '<h3>Roles</h3>' +
      field('roles.budget', 'Model classifications per run', ro.budget || 60, 'Only sessions whose transcript changed are re-classified.', 'number');
  }

  function renderAbout(extra) {
    return '<div class="set-about"><img src="/icon.svg" width="64" height="64" alt=""><div><b>Relaymote</b> ' + esc(S.__version || '') +
      '<p>Your Claude Code sessions, in your pocket.</p></div></div>' +
      '<p class="set-small">Data folder: <code>' + esc(S.__dataDir || '') + '</code></p>' +
      '<p class="set-small">Relaymote is an independent open-source project and is not affiliated with Anthropic. It drives the Claude Desktop app you are already signed in to; it never sees your password.</p>' +
      '<p><button class="ghost" id="set-welcome">Show the welcome tour</button></p>';
  }

  function renderWelcome() {
    return '<div class="set-about"><img src="/icon.svg" width="64" height="64" alt=""><div><b>Welcome to Relaymote</b><p>Your Claude Code sessions, in your pocket.</p></div></div>' +
      '<ol class="set-steps">' +
      '<li><b>Your sessions, anywhere.</b> Every Claude Code session from the desktop app, live: read, reply, answer questions and permissions, switch model and effort, start new sessions.</li>' +
      '<li><b>Nothing stalls.</b> Sessions stopped by a usage limit continue when it resets; sessions cut off by a crash pick up again.</li>' +
      '<li><b>A conductor for many sessions.</b> Tell one session “you are the master” and it can spawn workers, track them and get woken when they finish.</li>' +
      '<li><b>Everything is optional.</b> Switch modules on and off in Settings.</li></ol>' +
      (desk && !desk.cdp ? '<div class="set-card set-warn"><b>First, connect Claude Desktop.</b>' + desktopSteps() + '<div class="set-inline"><button class="ghost" id="set-desk-check">Check again</button>' + (desk.canAutoEnable ? '<button class="ghost primary" id="set-desk-enable">Turn it on for me</button>' : '') + '</div>' + (deskMsg ? '<p class="set-small" id="set-desk-result">' + esc(deskMsg.text) + '</p>' : '') + '</div>' : '') +
      '<div class="sheet-actions"><button class="ghost primary" id="set-start">Pair my phone</button><button class="ghost" id="set-skip">Later</button></div>';
  }

  function render() {
    if (!S) return;
    tabs();
    var body = $('set-body');
    $('set-title').textContent = section === 'welcome' ? 'Welcome' : 'Settings';
    $('set-tabs').style.display = section === 'welcome' ? 'none' : '';
    body.innerHTML = section === 'general' ? renderGeneral()
      : section === 'remote' ? renderRemote()
      : section === 'pair' ? renderPair()
      : section === 'notify' ? renderNotify()
      : section === 'advanced' ? renderAdvanced()
      : section === 'desktop' ? renderDesktop()
      : section === 'models' ? renderModels()
      : section === 'engine' ? renderEngine()
      : section === 'welcome' ? renderWelcome()
      : renderAbout();
    wire(body);
  }

  function wire(body) {
    Array.prototype.forEach.call(body.querySelectorAll('.set-switch'), function (c) {
      c.onchange = function () { save(setPath({}, c.dataset.key, c.checked)); };
    });
    Array.prototype.forEach.call(body.querySelectorAll('[data-field]'), function (inp) {
      inp.onchange = function () {
        var v = inp.type === 'number' ? Number(inp.value) : inp.value.trim();
        if (inp.dataset.list) v = v.split(/[\r\n;]+/).map(function (x) { return x.trim(); }).filter(Boolean);
        save(setPath({}, inp.dataset.field, v));
      };
    });
    Array.prototype.forEach.call(body.querySelectorAll('input[name=remote]'), function (r) {
      r.onchange = function () { pairData = null; save({ remote: { mode: r.value } }).then(loadPair); };
    });
    Array.prototype.forEach.call(body.querySelectorAll('.set-copy'), function (b) {
      b.onclick = function () {
        try { navigator.clipboard.writeText(b.dataset.url); note('Link copied'); } catch (e) { note('Copy failed', true); }
      };
    });
    // A handler must never touch `x` when clicked: by then it points at the last element bound here.
    var x;
    if ((x = $('go-remote'))) x.onclick = function (e) { e.preventDefault(); section = 'remote'; render(); };
    if ((x = $('set-recheck'))) x.onclick = function () { loadPair(); };
    if ((x = $('set-cf-login'))) x.onclick = function () {
      var btn = this; btn.disabled = true; btn.textContent = 'Opening…';
      req('/api/tunnel/login', {}).then(function (r) {
        if (r.loginUrl) { window.open(r.loginUrl, '_blank'); note('Finish the login in the new tab, then come back'); pollLogin(); }
        else if (r.already) { note('Already connected'); loadPair(); }
        else note(r.error || 'Login did not start', true);
      });
    };
    if ((x = $('set-cf-setup'))) x.onclick = function () {
      var btn = this, host = $('set-cf-host').value.trim();
      btn.disabled = true; btn.textContent = 'Creating…';
      req('/api/tunnel/setup', { hostname: host }).then(function (r) {
        if (r.ok) { note('Address ready: https://' + r.hostname); pairData = null; load(); }
        else { note(r.error || 'Setup failed', true); btn.disabled = false; btn.textContent = 'Create'; }
      });
    };
    if ((x = $('set-rotate'))) x.onclick = function (e) {
      e.preventDefault();
      if (!confirm('Issue a new access key? Every paired phone and browser will need to scan again after Relaymote restarts.')) return;
      req('/api/token/rotate', {}).then(function (r) { note(r.note || 'Done'); });
    };
    if ((x = $('set-desk-check'))) x.onclick = function () { desk = null; render(); loadDesk(); };
    if ((x = $('set-dev-mode'))) x.onclick = function () {
      var btn = this; btn.disabled = true;
      req('/api/desktop/dev-mode', {}).then(function (r) { note(r.message || (r.ok ? 'Developer Mode is on' : 'Could not switch it on'), !r.ok); desk = null; render(); loadDesk(); });
    };
    if ((x = $('set-desk-enable'))) x.onclick = function () {
      // Always ends in a visible result: the server's sentence, a network error, or a timeout.
      var btn = this; btn.disabled = true; btn.textContent = 'Working… watch the computer’s screen';
      var ctl = window.AbortController ? new AbortController() : null;
      var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 90000);
      var o = { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' };
      if (ctl) o.signal = ctl.signal;
      fetch('/api/desktop/enable-debugger', o).then(function (r) {
        return r.json().catch(function () { return { ok: false, message: 'The computer answered HTTP ' + r.status + ' instead of a result.' }; });
      }).then(function (r) {
        return { ok: !!r.ok, text: r.message || (r.ok ? 'Claude Desktop’s debugger is on.' : 'Could not turn it on (' + (r.error || 'no reason given') + '). Use the steps below.') };
      }, function (e) {
        return { ok: false, text: e && e.name === 'AbortError' ? 'No answer from the computer after 90 seconds. Check again, or use the steps below.' : 'Could not reach the computer: ' + ((e && e.message) || 'network error') };
      }).then(function (m) {
        clearTimeout(timer);
        deskMsg = { text: m.text, err: !m.ok };
        note(m.text, !m.ok);
        desk = null; render(); loadDesk();
      });
    };
    if ((x = $('set-welcome'))) x.onclick = function () { section = 'welcome'; render(); };
    if ((x = $('set-backup-test'))) x.onclick = function () {
      var btn = this; btn.disabled = true;
      req('/api/notify/test-backup', {}).then(function (r) {
        var d = (r && r.result) || {};
        note(r && r.ok ? 'Test sent' : 'Test failed: ' + (d.error || d.skipped || (d.status ? 'HTTP ' + d.status : 'unknown')), !(r && r.ok));
        btn.disabled = false;
      }).catch(function (e) { note('Test failed: ' + e.message, true); btn.disabled = false; });
    };
    if ((x = $('set-start'))) x.onclick = function () { save({ onboarded: true }, true); section = 'pair'; render(); };
    if ((x = $('set-skip'))) x.onclick = function () { save({ onboarded: true }, true); close(); };
  }

  function pollLogin() {
    var n = 0;
    var t = setInterval(function () {
      req('/api/tunnel').then(function (r) {
        if ((r.tunnel && r.tunnel.loggedIn) || ++n > 60) { clearInterval(t); loadPair(); }
      });
    }, 3000);
  }

  function loadPair() {
    return req('/api/pair').then(function (r) { pairData = r; if (section === 'pair' || section === 'remote') render(); });
  }

  function load() {
    return req('/api/settings').then(function (r) {
      if (!r || !r.ok) return;
      S = r.settings; S.__version = r.version; S.__dataDir = r.dataDir;
      applyVisibility();
      render();
      return S;
    });
  }

  function applyVisibility() {
    var m = (S && S.modules) || {};
    var map = { 'btn-board': 'board', 'btn-routines': 'routines', 'btn-accounts': 'accounts', 'btn-goals': 'goalChaser' };
    Object.keys(map).forEach(function (id) { var b = $(id); if (b) b.style.display = m[map[id]] ? '' : 'none'; });
  }

  function open(sec) {
    ensureDom();
    section = sec || 'general';
    if (section === 'pair') loadPair();
    if (section === 'remote') loadPair();
    if (section === 'desktop' || section === 'welcome') loadDesk();
    var sheet = $('view-settings');
    if (typeof window.showSheet === 'function') window.showSheet(sheet); else sheet.classList.remove('hidden');
    load();
  }
  function close() {
    var sheet = $('view-settings');
    if (typeof window.hideSheet === 'function') window.hideSheet(sheet); else sheet.classList.add('hidden');
    if (/^#(settings|pair|desktop)$/.test(location.hash)) history.replaceState(null, '', location.pathname + location.search);
  }

  window.relaymoteSettings = { open: open, close: close };

  function boot() {
    ensureDom();
    load().then(function (s) {
      if (!s) return; // a scoped sub-user: settings are owner-only
      loadDesk();
      setInterval(loadDesk, 60000);
      if (location.hash === '#pair') open('pair');
      else if (location.hash === '#settings') open('general');
      else if (location.hash === '#desktop') open('desktop');
      else if (!s.onboarded) open('welcome');
    });
    window.addEventListener('hashchange', function () {
      if (location.hash === '#pair') open('pair');
      else if (location.hash === '#settings') open('general');
      else if (location.hash === '#desktop') open('desktop');
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
