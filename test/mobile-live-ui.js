// mobile-live-ui.js — the app must keep itself current, and must not carry a private copy of the
// desktop's vocabulary. Ported from the private tool's test-live-ui.js: mostly assertions on the
// source (each names the incident it pins down), plus the parts that can run against the
// stand-in desktop. Adapted for Relaymote's names (__relaymoteLastKey, relaymote-mcp.js). Not ported: the
// board / goals-register checks (that code is owned and tested by the board work package) and
// the checks that need a real Electron renderer (model menu contents, timer throttling, the
// modal-blocker scrape) — listed as SKIP.
'use strict';
const H = require('./mobile-harness');
const W = H.world('liveui', { demo: false, env: true });
const { check: chk, src } = H;

(async () => {
  const fake = await H.fakeDesktop();
  require('../lib/config').set({ cdpPort: fake.port });
  const desktop = require('../lib/desktop');

  console.log('--- no hardcoded model roster anywhere ---');
  {
    const d = src('lib/desktop.js');
    chk(!/MODEL_LABELS\s*=/.test(d), 'desktop.js keeps no MODEL_LABELS roster');
    chk(!/model must be one of: opus, sonnet, haiku, fable/.test(d), 'setModel does not reject names against a fixed list');
    const m = src('mobile/index.js');
    chk(!/models:\s*\['opus'/.test(m), '/api/boot does not serve a hardcoded model array');
    chk(/listModels/.test(m), 'the model list is read from the desktop instead');
  }

  console.log('\n--- controls are found by what they ARE, not by what they show ---');
  {
    const d = src('lib/desktop.js');
    chk(d.includes('data-cds="ModelSelectorEffort"'), 'the effort control is located by its data-cds handle');
    chk(d.includes('data-cds="ModelSelector"'), 'the model control is located by its data-cds handle');
    const pickBlock = d.slice(d.indexOf('async function setModel'), d.indexOf('async function setEffort'));
    chk(pickBlock.length > 100 && !/\$\{rx\}/.test(pickBlock), 'the matcher object is never interpolated into page-side script');
  }

  console.log('\n--- the model matcher speaks both vocabularies ---');
  {
    // The exported matcher, not a slice of source: it leans on normModel/sameModel beside it.
    const { modelMatcher } = require('../lib/desktop');
    for (const [inp, menu, want] of [['fable', 'Fable 5.1', true], ['Fable 5.1', 'Fable 5.1', true], ['Fable 6', 'Fable 6', true],
      ['sonnet', 'Sonnet 5', true], ['Opus 5', 'Opus 5', true], ['Opus 5', 'Opus 5.5', false], ['fable', 'Opus 5', false]]) {
      const m = modelMatcher(inp);
      chk(!!m && m.test(menu) === want, `${JSON.stringify(inp)} vs ${JSON.stringify(menu)} -> ${want}`, m && m.test(menu));
    }
    chk(modelMatcher('') === null, 'an empty model name is refused');
  }

  console.log('\n--- the client can SEE the link state and the data age ---');
  {
    const m = src('mobile/index.js');
    chk(/cdp:\s*await cdpCached\(\)/.test(m), 'every session list carries the live desktop-link state');
    chk(/snapshotAt/.test(m), 'and the age of the snapshot the dots came from');
    const a = src('mobile/public/app.js');
    chk(/function noteLinkState/.test(a), 'the client acts on that state');
    chk(/was === false && d\.cdp === true/.test(a), 'and specifically notices the link coming BACK');
    chk(/function reloadOpenChat/.test(a) && /reloadOpenChat\(\)/.test(a), 'the open conversation is re-read in place, not only by reopening the app');
  }

  console.log('\n--- a send may not race its own uploads; an upload may fail, but never silently ---');
  {
    const a = src('mobile/public/app.js');
    chk(/state\.uploads/.test(a), 'in-flight uploads are tracked');
    chk(/while \(state\.uploads\.length && Date\.now\(\) < deadline\)/.test(a), 'send() waits for them instead of reading an empty attachment list');
    chk(/upload\.onprogress/.test(a), 'upload progress is reported (XHR, since fetch cannot)');
    chk(/x\.timeout = 60000/.test(a), 'uploads have a hard timeout');
    chk(/rec\.attempt < 3/.test(a), 'a failed upload is retried automatically');
    chk(/tap to retry/.test(a), 'a permanently failed upload stays on screen, tappable');
    chk(/failedUps\.length/.test(a), 'send() refuses while a failed upload is attached');
    chk(a.includes("if (m === 'signin-required' || !(e && e.conn)) throw e;") && a.includes("throw connErr(e && e.name === 'AbortError' ? 'timeout' : 'net')"),
        'a timed-out read is retried on a fresh connection (g1588: e.conn marks every cannot-reach-the-PC failure)');
  }

  console.log('\n--- a message is sent whole or not at all ---');
  {
    const d = src('lib/desktop.js');
    chk(/MAX_MESSAGE_CHARS = 2000000/.test(d), 'no practical cap: the bound is 2,000,000');
    chk(/MESSAGE_TOO_LONG/.test(d), 'an over-limit message is refused, not truncated');
    // The background bridge (no composer, no length limit) is tried first; when it cannot deliver,
    // the composer path must refuse the over-limit message rather than send a fragment.
    const r = await desktop.sendMessage('local_whatever', 'x'.repeat(2000001), { dryRun: true });
    chk(r && r.ok === false && r.result === 'too-long', 'the composer path refuses an over-limit message instead of truncating it', r && r.result);
  }

  console.log('\n--- never move the view under someone typing; and be quick about it ---');
  {
    const d = src('lib/desktop.js');
    chk(/async function awaitUserIdle/.test(d), 'an idle guard exists');
    chk(/e\.isTrusted && e\.target && editable\(e\.target\)/.test(d), 'only TRUSTED keystrokes INTO AN EDITABLE BOX count');
    const i = d.indexOf('async function sendMessage(');
    const sendBody = d.slice(i, i + 6000);
    chk(i > 0 && /awaitUserIdle\(conn, CID\)/.test(sendBody), 'sendMessage waits for the user to stop typing');
    chk(!/await sleep\(2600\)/.test(sendBody), 'sendMessage does not sleep a flat 2.6s to switch');
    chk(!/await sleep\(1800\)/.test(d), 'no flat 1.8s post-send sleep');
    for (const f of ['setModel', 'setEffort', 'cancelSession']) {
      const j = d.indexOf('async function ' + f + '(');
      chk(j > 0 && /awaitUserIdle\(conn, CID\)/.test(d.slice(j, j + 3000)), f + ' waits for the user to stop typing');
    }
    // Live, against the stand-in renderer: a keystroke 1s ago must hold the guard until 2.5s of quiet.
    const c = await desktop.connect(await desktop.wsUrl());
    try {
      const CID = await desktop.pickChat(c);
      await c.evaluate(desktop.rEval(CID, '(function(){ window.__relaymoteLastKey=Date.now()-1000; return 1; })()'));
      const t = Date.now(); await desktop.awaitUserIdle(c, CID, { idleMs: 2500 }); const ms = Date.now() - t;
      chk(ms >= 1200 && ms <= 2600, `a keystroke 1s ago makes the guard wait until 2.5s of quiet (${ms}ms)`, ms);
      await c.evaluate(desktop.rEval(CID, '(function(){ window.__relaymoteLastKey=0; return 1; })()'));
      const t2 = Date.now(); await desktop.awaitUserIdle(c, CID, { idleMs: 2500 }); const ms2 = Date.now() - t2;
      chk(ms2 < 800, `with nobody typing it does not wait (${ms2}ms)`, ms2);
    } finally { c.close(); }
    chk(/setBackgroundThrottling\(false\)/.test(d), 'pickChat switches background throttling off for the chat renderer');
  }

  console.log('\n--- a transient 502 must not reach the user ---');
  {
    const a = src('mobile/public/app.js');
    chk(a.includes('(n >= 502 && n <= 504)') && a.includes("if (!msg && isPcDownStatus(r.status)) throw connErr('pc-down', r.status);"),
        'reads retry on 502/503/504 (said in plain words now, g1588)');
    chk(/if \(method !== 'GET'\) return apiOnce/.test(a), 'a non-GET is passed straight through -- never retried');
    chk(/700 \* attempt/.test(a), 'retries back off rather than hammering');
  }

  console.log('\n--- nothing may destroy text in the message box ---');
  {
    const a = src('mobile/public/app.js');
    chk(/clear it first to use the suggestion/.test(a), 'the suggestion bar refuses to overwrite a non-empty box');
    chk(/\+ rest/.test(a), 'picking a command replaces only the "/word" being typed');
    chk(/if \(sameSession && cur\.trim\(\) && cur\.trim\(\) !== draft\.trim\(\)\) saveDraft/.test(a), 're-opening the SAME session keeps what is typed');
    chk(/saveDraft\(state\.open, s\);/.test(a), 'a programmatic fill persists the draft, since .value fires no input event');
  }

  console.log('\n--- search clear, and a banner you can get rid of ---');
  {
    const h = src('mobile/public/index.html'), a = src('mobile/public/app.js'), c = src('mobile/public/style.css');
    chk(!/id="search" type="search"/.test(h), 'the search box is not type="search" (no unthemed browser widget)');
    chk(/id="search-clear"/.test(h) && /\.searchclear\{/.test(c), 'it has a themed clear button');
    chk(/function syncSearchClear/.test(a), 'the clear button appears only when there is text');
    chk(/class="x" type="button" aria-label="Dismiss"/.test(a), 'the banner has a dismiss control');
    chk(/e\.stopPropagation\(\); close\(\);/.test(a), 'dismissing does NOT open the session');
    chk(/touchstart/.test(a) && /Math\.abs\(dx\) > 70/.test(a), 'and it can be swiped away');
  }

  console.log('\n--- your question must not sit below its answer ---');
  {
    const a = src('mobile/public/app.js');
    chk(!/messages\.some\(m => m\.role === 'user' && norm\(m\.text\)\.includes\(want\)\)/.test(a), 'the pending bubble does not require a USER row to retire');
  }

  console.log('\n--- the back button behaves like an app ---');
  {
    const a = src('mobile/public/app.js');
    chk(/window\.addEventListener\('popstate'/.test(a), 'the app listens for Back');
    chk(/function navRecord/.test(a) && /function navRestore/.test(a), 'each navigation records the view being left, and Back restores it');
    chk(a.indexOf("!$('drawer').classList.contains('open')) navRecord()") > 0, 'only a REAL view change is recorded');
    chk(/Press back again to exit/.test(a) && /history\.pushState\(\{ ago: 0 \}, ''\)/.test(a), 'at the root the first Back warns and the second leaves');
    chk(/window\.navOpenFrom/.test(a), 'jumping from a sheet into a session records the sheet first');
    chk(/navOpenFrom\(el\.dataset\.sid\)/.test(src('mobile/public/routines-ui.js')), 'Back from a routine run returns to the routines');
    for (const id of ['btn-close-sheet', 'btn-close-new', 'btn-close-tasks', 'btn-close-file', 'btn-close-chips'])
      chk(a.indexOf("$('" + id + "').onclick = () => navBack();") > 0, id + ' unwinds through history');
  }

  console.log('\n--- unconfirmed is not the same as failed; Send again does something you can see ---');
  {
    const a = src('mobile/public/app.js');
    chk(a.indexOf("const bad = e.suspect || e.state === 'failed';") > 0, 'only a suspect or failed entry is drawn as a problem');
    chk(/setTimeout\(\(\) => \{ outboxTick\(\)/.test(src('mobile/index.js')), 'a completed send reconciles promptly instead of waiting for the 60s sweep');
    const start = a.indexOf(".ob-resend').forEach(");
    const body = a.slice(start, a.indexOf(".ob-drop').forEach("));
    const iRemove = body.indexOf('rowEl.remove()'), iFilter = body.indexOf('state.outbox = (state.outbox || []).filter'), iSend = body.indexOf('send({ id: e.session');
    chk(start > 0 && iRemove > 0 && iFilter > 0 && iSend > 0, 'Send again drops the row, drops the entry, and resends');
    chk(iFilter < iRemove && iRemove < iSend, 'the row and the entry go BEFORE the resend starts -- the tap is never silent', [iFilter, iRemove, iSend]);
    chk(body.indexOf('await') === -1, 'nothing is awaited first, so the screen cannot lag behind the tap');
    chk(body.indexOf('b.disabled = true') > 0 && body.indexOf('b.disabled = true') < iSend, 'the button disarms itself so a second tap cannot send twice');
    chk(body.indexOf('box.hidden = true') > 0, 'the banner disappears once its last row is gone');
  }

  console.log('\n--- the background send reports what it actually knows ---');
  {
    const d = src('lib/desktop.js');
    chk(/delivery: accepted \? 'generating' : 'queued'/.test(d), 'the bridge reports delivery in the vocabulary the outbox understands');
    chk(/confirmed: accepted === true/.test(d), 'and only claims confirmation when the session actually took it');
    chk(!/result: 'unconfirmed'/.test(d), 'a queued message is never reported as a failure (that would double-send)');
    chk(/last\.delivery \|\| 'accepted'/.test(src('mobile/index.js')), 'a success with no delivery keeps being watched, not marked confirmed');
  }

  console.log('\n--- a modal on the PC must not block sends in silence ---');
  {
    chk(src('server.js').indexOf('blocker: sidebar.blocker') > 0, 'the snapshot on disk keeps the modal, so the phone sees it');
    chk(src('mobile/index.js').indexOf('blocker: snap.blocker') > 0, '/api/sessions ships it beside the link health');
    const a = src('mobile/public/app.js');
    chk(a.indexOf('function renderBlocker(') > 0 && a.indexOf('renderBlocker(d.blocker);') > 0, 'the client draws it from the list refresh');
    chk(a.indexOf('state.blockerDismissed') > 0, 'and it can be dismissed');
  }

  console.log('\n--- swipe down to dismiss belongs to every sheet; every control is wired ---');
  {
    const a = src('mobile/public/app.js'), h = src('mobile/public/index.html');
    chk(a.indexOf('function enableSwipeToClose(') > 0, 'the swipe-to-dismiss handler lives in app.js');
    chk(a.indexOf("document.querySelectorAll('.sheet').forEach(enableSwipeToClose)") > 0, 'wired to EVERY sheet at load');
    chk(a.indexOf('enableSwipeToClose(el);') > a.indexOf('function showSheet('), 'showSheet re-wires, so a sheet built after load is covered');
    chk(a.indexOf('body.dataset.swipeWired') > 0, 'wiring is idempotent');
    const sw = a.slice(a.indexOf('function enableSwipeToClose('), a.indexOf("document.querySelectorAll('.sheet')"));
    chk(sw.indexOf('navBack()') > 0 && sw.indexOf('hideSheet(') < 0, 'the gesture closes through navBack(), not hideSheet()');
    // Replaced "content may start the drag once scrolled to the top": that closed the Board on a scroll-up.
    chk(sw.indexOf("target.closest('.sheet-bar')") > 0 && sw.indexOf("bar.addEventListener('touchstart'") > 0
        && sw.indexOf("body.addEventListener('touch") < 0 && sw.indexOf('scrollTop') < 0,
        'the drag starts ONLY on the sticky top bar, never in content at any scroll position');
    chk(sw.indexOf("!target.closest('button')") > 0, 'a drag never starts on the X');
    const nSheets = h.split('class="sheet hidden"').length - 1, nGrabs = h.split('<div class="grab"></div>').length - 1;
    chk(nSheets > 0 && nGrabs === nSheets, `every sheet draws a grab handle (${nGrabs} for ${nSheets})`);
    chk(src('mobile/public/style.css').indexOf('overscroll-behavior:contain') > 0, 'the sheet body contains its overscroll');
    // The roster is index.html's own script tags: a hand list once missed goals-ui.js, so its
    // controls were never checked, and a new file would silently escape this check too.
    const roster = [...h.matchAll(/<script src="\/([\w.-]+\.js)"><\/script>/g)].map(m => m[1]);
    chk(roster.includes('app.js') && roster.includes('display-ui.js') && roster.includes('goals-ui.js'), `the JS roster comes from index.html (${roster.length} files)`, roster);
    const jsAll = roster.map(f => src('mobile/public/' + f)).join('\n');
    chk(jsAll.indexOf('SHEET_IDS') < 0, 'no hand-maintained SHEET_IDS list');
    chk(a.indexOf("querySelectorAll('.sheet:not(.hidden)')") > 0 && a.indexOf('open[open.length - 1]') > 0, 'the open sheet is asked of the DOM, topmost last');
    const ctrls = []; { const re = /<(?:button|a|input|select|textarea)[ >][^>]*id="([A-Za-z0-9_-]+)"/g; let m; while ((m = re.exec(h))) ctrls.push(m[1]); }
    const dead = ctrls.filter(id => jsAll.indexOf("'" + id + "'") < 0 && jsAll.indexOf('"' + id + '"') < 0);
    chk(ctrls.length > 20 && dead.length === 0, `every control declared in index.html is referenced by JS (${ctrls.length} checked)`, dead.join(', '));
  }

  console.log('\n--- two logs, one event: a stop names who asked ---');
  {
    const o = src('lib/orchestrator.js');
    chk(/async function stopTask\(id, opts/.test(o), 'stopTask takes an actor');
    const i = o.indexOf('async function stopTask(');
    const body = o.slice(i, i + 3000);
    chk(body.indexOf('log(') > 0 && body.indexOf('opts.by') > 0, 'and logs it itself, so every caller is covered');
    chk(src('server.js').indexOf('orch.stopTask(id, { by })') > 0, 'the HTTP route passes the actor through');
    chk(src('mobile/index.js').indexOf("orch.stopTask(String(body.id || ''), { by:") > 0, 'the phone names itself when it stops a worker');
    chk(src('mcp/relaymote-mcp.js').indexOf('/stop?by=') > 0, 'and the stop tool tells the daemon which session asked');
  }

  console.log('\nSKIP (need a real Claude Desktop renderer): model menu contents, renderer timer throttling, modal-blocker scrape.');
  console.log('SKIP (owned by the board work package): board inbox notes, goals register rendering.');
  fake.close();
  H.finish(W);
})().catch(e => { console.error('THREW', e); process.exit(1); });
