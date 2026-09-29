'use strict';
// A UI-driving call must DEFER while the user is typing: it must not connect, navigate or press anything.
const assert = require('assert');
const path = require('path');
const root = path.join(__dirname, '..');
const idle = require(path.join(root, 'lib', 'idle.js'));
const config = require(path.join(root, 'lib', 'config.js'));
const d = require(path.join(root, 'lib', 'desktop.js'));
let n = 0;
const ok = (c, name) => { assert.ok(c, name); n++; console.log('ok ' + name); };

(async () => {
  ok(config.DEFAULTS ? config.DEFAULTS.idleGateSeconds >= 120 : require('fs').readFileSync(path.join(root, 'lib', 'config.js'), 'utf8').includes('idleGateSeconds: 120'), 'default quiet window is at least 2 minutes');
  const realIsIdle = idle.isIdle, realIdleMs = idle.idleMs;
  idle.isIdle = () => false;       // he typed a second ago
  idle.idleMs = () => 900;
  for (const [name, args] of [
    ['startTask', { sessionId: 'local_00000000-0000-0000-0000-000000000000', idleMaxWaitMs: 300 }],
    ['setEffort', { sessionId: 'local_00000000-0000-0000-0000-000000000000', effort: 'high', idleMaxWaitMs: 300 }],
  ]) {
    if (typeof d[name] !== 'function') continue;
    const r = await d[name](args);
    if (name === 'setEffort') { ok(r && (r.error === 'USER_ACTIVE' || !r.navigated), 'setEffort defers or uses the no-navigation bridge'); continue; }
    ok(r && r.error === 'USER_ACTIVE', name + ' returns USER_ACTIVE and does nothing while he is typing');
  }
  idle.isIdle = realIsIdle; idle.idleMs = realIdleMs;
  console.log('idle-defer: ' + n + ' checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
