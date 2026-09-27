'use strict';
// debugger-button.js: "Turn it on for me" did nothing visible. The route threw away the macro's exit
// code and output, the reply carried no message, the button had no catch or timeout, and the macro
// un-maximised Claude Desktop (ShowWindow SW_SHOWNOACTIVATE) and clicked into a disconnected session.
// Guards: every exit code has a sentence, the button always ends in a result, the window keeps its
// size, the Windows session boundary is named, and the auto path waits for sign-in instead of idle.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = path.join(__dirname, '..');
const heal = require(path.join(root, 'lib', 'heal.js'));
const ps1 = fs.readFileSync(path.join(root, 'scripts', 'enable-debugger.ps1'), 'utf8');
const idx = fs.readFileSync(path.join(root, 'mobile', 'index.js'), 'utf8');
const ui = fs.readFileSync(path.join(root, 'mobile', 'public', 'settings-ui.js'), 'utf8');
const srv = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
let n = 0;
const ok = (c, name) => { assert.ok(c, name); n++; console.log('ok ' + name); };

(async () => {
  const codes = [...ps1.matchAll(/Finish (\d+) /g)].map(m => +m[1]);
  ok(codes.length >= 10 && codes.every(c => typeof heal.DEBUGGER_REASONS[c] === 'string'), 'every exit code the macro can return has a sentence for the app');
  ok(/Windows/.test(heal.DEBUGGER_REASONS[8]) && /disconnected/.test(heal.DEBUGGER_REASONS[8]) && /locked/.test(heal.DEBUGGER_REASONS[9]), 'the Windows session boundary (disconnected, locked) is named plainly');
  ok(/ConnState\(\)[\s\S]{0,120}Finish 8[\s\S]{0,200}InputDesktop\(\)\) \{ Finish 9/.test(ps1) && ps1.indexOf('Finish 8') < ps1.indexOf('RealClick $menu'), 'the session is checked before any click');
  ok(!/ShowWindow\(\$h, [34]\)/.test(ps1), 'the window is never shown in a way that un-maximises or resizes it');
  ok(/if \(\[N\]::IsIconic\(\$h\)\) \{ \[void\]\[N\]::ShowWindow\(\$h, 9\) \}/.test(ps1) && /wasMinimized\) \{ \[void\]\[N\]::ShowWindow\(\$script:h, 7\)/.test(ps1), 'only a minimised window is restored, and it is minimised again afterwards');
  ok(/turning on Claude's debugger in \$i/.test(ps1) && /0x08000000 \| 0x80 \| 0x20/.test(ps1), 'a click-through, non-activating 3-2-1 countdown shows on screen');
  ok(/oauth:tokenCacheV2/.test(ps1) && /Finish 10/.test(ps1), 'it waits for Claude Desktop to be signed in');
  ok(!/Start-Sleep -Milliseconds 1[2-9]\d\d/.test(ps1) && /function WaitFind/.test(ps1), 'fixed long sleeps are replaced by polling');
  {
    // g546: input during the 3-2-1 snoozes it; the pointer goes back where it was, both logged.
    const cd = ps1.slice(ps1.indexOf('$script:bar.Show()'), ps1.indexOf('Say "Relaymote: turning on Claude\'s debugger..."'));
    ok(/if \(\$i -eq 1 -and \$kind -eq 'key pressed'\) \{ \$busy = \$true/.test(cd) && !/\$busy = \$true; \$why = InputKind/.test(cd) && /-lt \$SnoozeMs/.test(cd) && /Finish 12/.test(cd), 'only a key pressed during the last second snoozes it (the mouse never does); a busy user ends it as exit 12');
    ok(ps1.indexOf('$script:cur0 = [System.Windows.Forms.Cursor]::Position') < ps1.indexOf('RealClick $menu') && /cursor before: /.test(ps1) && /SetCursorPos\(\$script:cur0\.X, \$script:cur0\.Y\)[\s\S]{0,200}cursor after: /.test(ps1), 'the pointer is recorded before the clicks and put back after, both positions logged');
    ok(/Say \("Relaymote: snoozed - " \+ \$why/.test(ps1) && /return 'mouse moved'/.test(ps1) && /return 'key pressed'/.test(ps1), 'the bar says why it snoozed: mouse moved, mouse clicked or key pressed');
    ok(/\$script:bar\.Top = \[int\]\(\$wa\.Top \+ 8\)/.test(ps1), 'the bar sits at the top of the screen, clear of the Claude text box');
    ok(/new Set\(\[1, 8, 9, 10, 12\]\)/.test(srv), 'a snoozed-out run is retried in a minute, not counted as a failure');
  }

  ok(/const r = await enableDebuggerRun;[\s\S]{0,200}return json\(res, 200, r\)/.test(idx), 'the route returns the result with its message');
  ok(/already: true, message:/.test(idx), 'pressing while it is already on says so');
  const h = ui.slice(ui.indexOf("x = $('set-desk-enable')"), ui.indexOf("x = $('set-welcome')"));
  ok(/AbortController/.test(h) && /90000/.test(h) && /function \(e\) \{/.test(h) && /r\.json\(\)\.catch/.test(h), 'the button has a timeout, a network-error path and a non-JSON path');
  ok(/deskMsg = \{ text: m\.text, err: !m\.ok \}/.test(h) && /note\(m\.text, !m\.ok\)/.test(h) && (ui.match(/esc\(deskMsg\.text\)/g) || []).length === 2, 'the result is toasted AND kept in the card on both screens');

  {
    // THE no-op: every handler used the shared `x`, which at click time points at the last element bound
    // (usually null), so `x.disabled = true` threw before any request. Handlers must use their own element.
    const b = ui.slice(ui.indexOf('    var x;\n'), ui.indexOf("if ((x = $('set-skip')))"));
    const handlers = b.split(/x\.onclick = function/).slice(1).map(h => h.slice(0, h.indexOf('\n    };') + 1 || 400));
    ok(handlers.length >= 8 && handlers.every(h => !/\bx\.(disabled|textContent|value|classList)/.test(h)), 'no click handler touches the shared x (it is null by the time you press)');
    // Behaviour: bind a fake DOM the way render() does, then press.
    const els = {};
    const mk = id => (els[id] = { id, disabled: false, textContent: '', onclick: null });
    mk('set-desk-enable');   // set-welcome is absent, so the bind leaves x null, as in the real sheet
    let x;
    const $ = id => els[id] || null;
    const src = b.slice(b.indexOf("if ((x = $('set-desk-enable')))"), b.indexOf("if ((x = $('set-backup-test')))"));
    let posted = null, toasted = null;
    const fetch = (u, o) => { posted = u; return Promise.resolve({ status: 200, json: () => Promise.resolve({ ok: false, code: 9, message: heal.DEBUGGER_REASONS[9] }) }); };
    const window = { AbortController }; let deskMsg = null, desk = {}; const note = (m, e) => { toasted = [m, e]; }; const render = () => {}; const loadDesk = () => {}; let section;
    eval(src.replace(/\bvar x;/, ''));
    const btn = els['set-desk-enable'];
    btn.onclick.call(btn);
    await new Promise(r => setTimeout(r, 20));
    ok(btn.disabled === true && posted === '/api/desktop/enable-debugger', 'a press disables the button and posts, although x is null by then');
    ok(toasted && toasted[1] === true && /locked/.test(toasted[0]) && deskMsg && /locked/.test(deskMsg.text), 'the refusal is toasted and kept on the card');
  }

  const tick = srv.slice(srv.indexOf('async function debuggerTick'), srv.indexOf('// The project index'));
  ok(!/isIdle/.test(tick) && /DEBUGGER_WAITING\.has\(r\.code\)/.test(tick) && /debuggerTries >= 3/.test(tick), 'auto-enable does not wait for idle, retries the no-click exits, caps the clicking ones');

  if (process.platform === 'win32') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-dbg-'));
    try {
      const stub = path.join(dir, 'stub.ps1');
      fs.writeFileSync(stub, "param($Port, $Countdown)\nWrite-Host '[00:00:00] the Windows session is disconnected'\nexit 8\n");
      process.env.BATON_DEBUGGER_MACRO = stub;
      const r = await heal.enableDebugger();
      ok(r.ok === false && r.code === 8 && r.message === heal.DEBUGGER_REASONS[8] && /disconnected/.test(r.detail), 'a real run hands back the exit code, the sentence and the macro\'s last line');
      fs.writeFileSync(stub, "param($Port, $Countdown)\nthrow 'boom'\n");
      const r2 = await heal.enableDebugger();
      ok(r2.ok === false && typeof r2.message === 'string' && r2.message.length > 10, 'a script that crashes still yields a message');
    } finally { delete process.env.BATON_DEBUGGER_MACRO; fs.rmSync(dir, { recursive: true, force: true }); }
  } else {
    const r = await heal.enableDebugger();
    ok(r.ok === false && /Windows-only/.test(r.message), 'off Windows the reply says it is Windows-only');
  }
  console.log(`\n${n}/${n} passed`);
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
