// perm-sidebar-row.js — replay of 08-Nov-2026 17:31 IST (Ashwar: "I saw this and there was only one button before. I
// pressed it. Didn't do anything."). A sidebar row for a session titled "Allow short dated holds on tax goals (g2498)"
// was read as an Allow button, and the rows around it as the ask, so every session showed a false "PERMISSION NEEDED"
// card. SIDEBAR below is that row's real ancestry (read from the live DOM, class lists dropped).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const P = require('../mobile/permission');

let fails = 0;
const check = (ok, what, got) => { console.log((ok ? 'ok   ' : 'FAIL ') + what + (ok || got === undefined ? '' : '  ' + JSON.stringify(got))); if (!ok) fails++; };

const row = (title, id) => `<div data-row-key="code:local_${id}" data-jump-hint-row=""><div><div data-row=""><button type="button" data-roving-item="" data-row-main-button="">${title} <span>Unread response</span></button></div></div></div>`;
const SIDEBAR = `<div data-mode="code"><div data-kind="code"><div data-testid="sidebar-recents" data-recents-list="" data-group-list=""><div data-group-section="state-done">` +
  row('Wedding card designs for Yati and Yug', 'a1') + row('Sagar Conductor', 'a2') +
  row('Allow short dated holds on tax goals (g2498) <span>Started from a suggestion in Conductor chase: stalled lanes</span>', 'a3') +
  row('Doorbell · app not working, HA fine (g1882)', 'a4') + `</div></div></div></div>`;
const REAL = `<main><div class="epitaxy-approval-card"><div>Allow Claude to use Adobe Photoshop?</div>
  <button type="button">Allow for this session</button><button type="button">Deny</button></div></main>`;

function browser() {
  const c = [process.env.CHROME_BIN,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  return c.find(p => p && fs.existsSync(p)) || null;
}
function run(bin, tmp, name, body) {
  const file = path.join(tmp, name + '.html');
  fs.writeFileSync(file, `<!doctype html><meta charset="utf-8"><body>${body}<pre id="out"></pre><script>
var r; try { r = (0, eval)(${JSON.stringify(P._READ_JS)}); } catch (e) { r = JSON.stringify({threw: e.message}); }
document.getElementById('out').textContent = '@@' + r + '@@';</script>`);
  const o = spawnSync(bin, ['--headless=new', '--disable-gpu', '--no-sandbox', '--user-data-dir=' + path.join(tmp, 'p-' + name),
    '--virtual-time-budget=3000', '--dump-dom', 'file:///' + file.split(path.sep).join('/')], { encoding: 'utf8', timeout: 60000, windowsHide: true });
  const m = /@@(.*)@@/.exec((o.stdout || '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'"));
  return m ? JSON.parse(m[1]) : { noresult: (o.stderr || '').slice(0, 200) };
}

const bin = browser();
if (!bin) {
  console.log('skip DOM replay: no Edge/Chrome on this machine');
} else {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'relaymote-perm-'));
  const a = run(bin, tmp, 'sidebar', SIDEBAR + '<main><p>Checking the step size.</p></main>');
  check(a.present === false, 'a sidebar row titled "Allow …" is NOT a permission prompt', a);
  const b = run(bin, tmp, 'both', SIDEBAR + REAL);
  check(b.present === true, 'a real Allow card is still read with that row in the sidebar', b);
  check(JSON.stringify((b.options || []).map(o => o.label + ':' + o.kind)) === JSON.stringify(['Allow for this session:allow', 'Deny:deny']),
    'only the card\'s own two buttons are offered', b.options);
  check(/Photoshop/.test(b.request || '') && !/Unread response|Wedding/.test(b.request || ''), 'the ask is the card\'s text, not the sidebar\'s', b.request);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}
if (fails) { console.error(fails + ' failed'); process.exit(1); }
console.log('perm-sidebar-row: all checks passed');
