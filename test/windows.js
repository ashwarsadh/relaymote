// windows.js — nothing Relaymote starts may flash a console window on Windows.
// Every child_process call in the shipped code must pass windowsHide, unless it is listed below with
// the reason it cannot open a Windows console. A new unhidden spawn fails here, by file and line.
// Also shown FIRING: the scanner catches an unhidden call in a sample, so a pass is not a blind scan.
'use strict';
const fs = require('fs');
const path = require('path');

let failed = 0;
const check = (ok, name, extra) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra !== undefined && !ok ? '  ' + JSON.stringify(extra).slice(0, 600) : ''}`); if (!ok) failed++; };

const ROOT = path.join(__dirname, '..');
const SHIPPED = ['bin', 'lib', 'mobile', 'hooks', 'mcp', 'scripts', 'installer', 'server.js'];

// file + the start of the call -> why it may go without windowsHide.
const EXEMPT = [
  ['bin/baton.js', "spawn(process.platform === 'darwin' ? 'open' : 'xdg-open'", 'macOS/Linux only'],
  ['lib/heal.js', "execFileSync('ps',", 'macOS/Linux only'],
  ['lib/idle.js', "execFile('ioreg',", 'macOS only'],
  ['lib/idle.js', "execFile('xprintidle',", 'Linux only'],
  ['lib/account-sync/desktop-cycle.js', "spawn('explorer.exe',", 'starts Claude Desktop, a GUI app: the window is the point, and explorer opens no console'],
];

const CALL = /(?<![\w.])(?:cp\.|child_process\.|childProcess\.)?(spawn|spawnSync|execFile|execFileSync|exec|execSync|fork)\s*\(/g;

function callsIn(src) {
  const out = [];
  let m;
  CALL.lastIndex = 0;
  while ((m = CALL.exec(src))) {
    if (/function\s+$/.test(src.slice(Math.max(0, m.index - 12), m.index))) continue;   // a definition
    let i = m.index + m[0].length, depth = 1;
    while (i < src.length && depth) { const c = src[i++]; if (c === '(') depth++; else if (c === ')') depth--; }
    out.push({ line: src.slice(0, m.index).split('\n').length, text: src.slice(m.index, i) });
  }
  return out;
}

function shippedFiles() {
  const files = [];
  (function walk(p) {
    const st = fs.statSync(p);
    if (st.isDirectory()) { if (/node_modules|[\\/]public$/.test(p)) return; for (const f of fs.readdirSync(p)) walk(path.join(p, f)); }
    else if (/\.(js|cjs|mjs)$/.test(p)) files.push(p);
  })(ROOT);
  return files.filter(f => SHIPPED.some(d => path.relative(ROOT, f).split(path.sep).join('/').startsWith(d)));
}

console.log('\n--- the scanner fires ---');
{
  const sample = "const cp = require('child_process');\n" +
    "cp.execFile('powershell', ['-Command', 'x'], { timeout: 1 }, () => {});\n" +
    "spawn('node', [a(b)], { windowsHide: true, stdio: 'ignore' });\n" +
    "const m = /x/.exec(s);\n";
  const calls = callsIn(sample);
  check(calls.length === 2, 'finds both calls, including one with nested parentheses, and skips regex .exec', calls.map(c => c.text));
  check(calls.filter(c => !/windowsHide/.test(c.text)).map(c => c.line).join() === '2', 'and flags only the unhidden one, by line');
}

console.log('\n--- every shipped spawn hides its window ---');
{
  let total = 0;
  const bad = [], usedExempt = new Set();
  for (const f of shippedFiles()) {
    const src = fs.readFileSync(f, 'utf8');
    if (!/child_process/.test(src)) continue;
    const rel = path.relative(ROOT, f).split(path.sep).join('/');
    for (const c of callsIn(src)) {
      total++;
      if (/windowsHide/.test(c.text)) continue;
      const ex = EXEMPT.find(([file, start]) => file === rel && c.text.startsWith(start));
      if (ex) { usedExempt.add(ex); continue; }
      bad.push(`${rel}:${c.line}  ${c.text.replace(/\s+/g, ' ').slice(0, 140)}`);
    }
  }
  check(total > 30, `the scan saw the spawns (${total})`, total);
  check(bad.length === 0, 'no child process without windowsHide outside the listed exemptions', bad);
  const stale = EXEMPT.filter(e => !usedExempt.has(e)).map(e => e[0] + ' ' + e[1]);
  check(stale.length === 0, 'every exemption still matches a real call (a stale one would hide a new spawn)', stale);
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall windows checks passed');
process.exit(failed ? 1 : 0);
