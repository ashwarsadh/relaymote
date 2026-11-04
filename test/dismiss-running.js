// dismiss-running.js — #382 (25-Oct, Ashwar): "pressing the dismiss button interrupts the running sessions". The phone's
// Dismiss sent a real Esc to the Desktop window, and Esc is also Desktop's Stop key. Replay on the real pressDialogButton
// against a fake Desktop whose Esc ends a running turn unless an open box takes it:
//   1. a box with its own close button, over a running turn: the button is clicked, no Esc, the turn continues;
//   2. a box with no close button, over a running turn: refused (WOULD_INTERRUPT), no Esc, the turn continues;
//   3. the same box, nothing running: Esc is sent and the box closes (the old behaviour, where it is harmless).
'use strict';
const vm = require('vm');
const desktop = require('../lib/desktop.js');
const { pressDialogButton, DISMISS } = require('../mobile/dialog.js');
let fails = 0;
const check = (ok, what, got) => { console.log((ok ? 'ok   ' : 'FAIL ') + what + (got !== undefined ? '  ' + JSON.stringify(got) : '')); if (!ok) fails++; };

function scene({ closeButton, running }) {
  const turn = { running, interrupted: 0, esc: 0 };
  const box = { attrs: { 'data-open': '' }, style: { visibility: 'visible', display: 'block', opacity: '1', pointerEvents: 'auto' },
    offsetWidth: 420, offsetHeight: 220, innerText: 'Allow Claude to open this link?\n\nhttps://example.com', isConnected: true, open: true,
    hasAttribute(n) { return n in this.attrs; }, getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; }, closest() { return null; },
    querySelectorAll() { return this.buttons; } };
  const b = (text, aria, onClick) => ({ textContent: text, isConnected: true, disabled: false, getAttribute: (n) => (n === 'aria-label' ? aria : null), click: onClick });
  box.buttons = [b('Open link', null, () => {}), b('Copy', null, () => {})];
  if (closeButton) box.buttons.unshift(b('', 'Close', () => { box.open = false; }));
  const ctx = { window: {}, String, JSON, Array, Number, getComputedStyle: (e) => e.style,
    location: { href: 'https://claude.ai/claude-code-desktop/local_run1' },
    document: { querySelectorAll: () => (box.open ? [box] : []) } };
  ctx.window = ctx;
  ctx['claude.web'] = { LocalSessions: { getSession: async (id) => (id === 'local_run1' ? { isRunning: turn.running } : null) } };
  vm.createContext(ctx);
  // Desktop: Esc closes an open box that takes it; with no box open it reaches the chat and stops the turn.
  const conn = { close() {}, evaluate: async (js) => {
    if (/sendInputEvent/.test(js) && /Escape/.test(js)) {
      turn.esc++;
      if (box.open && !closeButton) box.open = false; else if (turn.running) { turn.running = false; turn.interrupted++; }
      return 1;
    }
    return vm.runInContext(js, ctx);
  } };
  return { turn, box, conn };
}

(async () => {
  Object.assign(desktop, { cdpAvailable: async () => true, wsUrl: async () => 'ws://fake', pickChat: async () => 1, rEval: (_c, js) => js });
  const key = 'Allow Claude to open this link?  https://example.com'.slice(0, 80);

  let s = scene({ closeButton: true, running: true });
  desktop.connect = async () => s.conn;
  let r = await pressDialogButton({ key, label: DISMISS, index: -1 });
  check(r.ok && r.closed && r.via === 'close-button', 'running turn, box with a Close button: Dismiss clicks it and the box closes', r);
  check(s.turn.esc === 0 && s.turn.running && !s.turn.interrupted, 'no Esc was sent; the turn is still running', s.turn);

  s = scene({ closeButton: false, running: true });
  r = await pressDialogButton({ key, label: DISMISS, index: -1 });
  check(!r.ok && r.error === 'WOULD_INTERRUPT', 'running turn, no close button: Dismiss is refused with a reason', r);
  check(s.turn.esc === 0 && s.turn.running && !s.turn.interrupted, 'no Esc was sent; the turn is still running', s.turn);

  s = scene({ closeButton: false, running: false });
  r = await pressDialogButton({ key, label: DISMISS, index: -1 });
  check(r.ok && r.closed && s.turn.esc === 1, 'nothing running: Esc is sent and the box closes', { r, turn: s.turn });

  console.log(fails ? `\n${fails} FAILED` : '\nall ok');
  process.exit(fails ? 1 : 0);
})();
