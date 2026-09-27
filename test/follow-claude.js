'use strict';
// follow-claude.js: "start Relaymote when Claude starts, stop it after exit (after syncing the sessions)".
// Guards the stop decision with fakes, and that the tray starts it only while Desktop is open.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const { makeFollow, GONE_MS } = require(path.join(root, 'lib', 'follow.js'));
const config = require(path.join(root, 'lib', 'config.js'));
let n = 0;
const ok = (c, name) => { assert.ok(c, name); n++; console.log('ok ' + name); };

function rig(o = {}) {
  const s = { t: 0, up: o.up ?? true, busy: null, synced: 0, stopped: 0, log: [], upAfterSync: false };
  const f = makeFollow({
    enabled: () => o.enabled ?? true, now: () => s.t,
    claudeUp: async () => s.up, busy: () => s.busy,
    sync: async () => { s.synced++; if (s.upAfterSync) s.up = true; return 'synced'; },
    stop: () => { s.stopped++; }, log: m => s.log.push(m),
  });
  return { s, f };
}

(async () => {
  ok(config.DEFAULTS.followClaude === false, 'off by default');
  {
    const { s, f } = rig({ up: false });
    for (let i = 0; i < 5; i++) { s.t += 5000; await f.tick(); }
    ok(s.stopped === 0 && s.synced === 0, 'a Relaymote started with Desktop closed stays up');
  }
  {
    const { s, f } = rig();
    await f.tick(); s.up = false;
    await f.tick(); s.t += GONE_MS - 1; await f.tick();
    ok(s.stopped === 0, 'a Desktop gone for less than 10 s (an update restart) does not stop Relaymote');
    s.up = true; await f.tick(); s.up = false; await f.tick(); s.t += GONE_MS; await f.tick();
    ok(s.stopped === 1 && s.synced === 1, 'Desktop seen, then gone 10 s: the sync runs, then Relaymote stops');
    ok(s.log.some(m => /exit sync: synced/.test(m)), 'the sync result is logged');
  }
  {
    const { s, f } = rig();
    await f.tick(); s.up = false; s.busy = '1 Relaymote task(s) running';
    await f.tick(); s.t += GONE_MS; await f.tick(); await f.tick();
    ok(s.stopped === 0 && s.synced === 0 && s.log.filter(m => /waiting to stop/.test(m)).length === 1, 'a running task holds the stop (logged once)');
    s.busy = null; await f.tick();
    ok(s.stopped === 1, 'it stops once the task is done');
  }
  {
    const { s, f } = rig();
    await f.tick(); s.up = false; s.upAfterSync = true;
    await f.tick(); s.t += GONE_MS; await f.tick();
    ok(s.synced === 1 && s.stopped === 0 && s.log.some(m => /back/.test(m)), 'Desktop reopened during the sync: Relaymote stays up');
  }
  {
    const { s, f } = rig({ enabled: false });
    await f.tick(); s.up = false; await f.tick(); s.t += GONE_MS * 2; await f.tick();
    ok(s.stopped === 0, 'with the setting off nothing stops');
  }
  const srv = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  ok(/bootPass\(\{ trigger: 'desktop-exit' \}\)/.test(srv) && /transferTick\(\{ exited: true \}\)/.test(srv) && /shutdown\('follow-claude'\)/.test(srv) && /follow\.tick\(\)/.test(srv), 'the daemon wires the account sync and a clean shutdown');
  const tray = fs.readFileSync(path.join(root, 'scripts', 'tray.ps1'), 'utf8');
  ok(/if \(Wanted\) \{ StartDaemon \}/.test(tray), 'the tray starts Relaymote at sign-in only when it is wanted');
  ok(tray.indexOf("Relaymote is asleep - it starts when Claude Desktop opens'; $icon") < tray.indexOf("'Relaymote stopped - restarting'"), 'the health poll does not restart a Relaymote that stopped with Desktop');
  ok(/\$follow\.Interval = 3000/.test(tray) && /if \(\$up -and -not \$script:wasUp -and -not \(StoppedByUser\)\) \{ StartDaemon/.test(tray), 'the tray starts Relaymote within seconds of Desktop opening, never after Quit');
  ok(/follow-sleep\.json'\), JSON\.stringify[\s\S]{0,120}shutdown\('follow-claude'\)/.test(srv) && /unlinkSync\(path\.join\(registry\.STATE_DIR, 'follow-sleep\.json'\)\)/.test(srv), 'the daemon leaves a sleep marker when it stops for Desktop and clears it on start');
  if (process.platform === 'win32') {
    // Headless autostart has no tray: run-daemon.cmd itself must bring Relaymote back when Desktop opens.
    const { execFileSync } = require('child_process');
    const os = require('os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-follow-'));
    try {
      const entry = path.join(dir, 'fake.js'), count = path.join(dir, 'count');
      fs.writeFileSync(entry, `const fs=require('fs');const c=${JSON.stringify(count)};const n=(+(fs.existsSync(c)?fs.readFileSync(c,'utf8'):0))+1;fs.writeFileSync(c,String(n));` +
        `if(n===1)fs.writeFileSync(${JSON.stringify(path.join(dir, 'follow-sleep.json'))},'{}');`);
      const env = { ...process.env, RELAYMOTE_STATE_DIR: dir, RELAYMOTE_DAEMON_ENTRY: entry, RELAYMOTE_NODE: process.execPath };
      const run = () => execFileSync('cmd.exe', ['/d', '/c', path.join(root, 'scripts', 'run-daemon.cmd')], { env, timeout: 60000, windowsHide: true });
      fs.writeFileSync(path.join(dir, 'stopped-by-user.json'), '{}');
      run();
      ok(fs.readFileSync(count, 'utf8') === '1' && !fs.existsSync(path.join(dir, 'follow-sleep.json')), 'asleep, `relaymote stop` / Quit ends the wait instead of relaunching');
      fs.unlinkSync(path.join(dir, 'stopped-by-user.json')); fs.writeFileSync(count, '0');
      let desktopUp = false;
      try { desktopUp = /claude\.exe/i.test(execFileSync('tasklist', ['/FI', 'IMAGENAME eq claude.exe', '/NH'], { windowsHide: true }).toString()); } catch {}
      if (desktopUp) {
        run();
        ok(fs.readFileSync(count, 'utf8') === '2' && /asleep until Claude Desktop opens/.test(fs.readFileSync(path.join(dir, 'daemon-stdio.log'), 'utf8')), 'asleep with Claude Desktop running, the wrapper starts the daemon again at once');
      }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  const ui = fs.readFileSync(path.join(root, 'mobile', 'public', 'settings-ui.js'), 'utf8');
  ok(/toggle\('followClaude'/.test(ui), 'Settings has the switch');
  console.log(`\n${n}/${n} passed`);
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
