// display.js — text zoom + density (mobile/public/display-ui.js). Under CSS zoom z a vh/vw length renders
// z times too big or small, so every one in style.css must be divided by var(--z,1) (see the display-ui.js
// header). Fails on a new rule that forgets, which would leave a gap at the bottom of the screen when
// zoomed out. Also shown FIRING on a sample rule.
'use strict';
const fs = require('fs');
const path = require('path');

let failed = 0;
const check = (ok, name, extra) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra !== undefined && !ok ? '  ' + JSON.stringify(extra).slice(0, 400) : ''}`); if (!ok) failed++; };

const P = f => fs.readFileSync(path.join(__dirname, '..', 'mobile', 'public', f), 'utf8');
const stripComments = s => s.replace(/\/\*[\s\S]*?\*\//g, '');
const css = stripComments(P('style.css'));
const html = P('index.html');
const js = P('display-ui.js');
const app = P('app.js');

function undivided(text) {
  const bad = [];
  for (const m of text.matchAll(/(?<![\w.-])(\d*\.?\d+)(d|s|l)?v[hw]\b[^;}]*/g)) {
    if (!/^\S+\s*\/\s*var\(--z,1\)/.test(m[0])) bad.push(m[0].slice(0, 60));
  }
  return bad;
}

check(undivided('.x{max-height:40vh} .y{width:min(calc(86vw / var(--z,1)),380px)}').length === 1, 'the scan fires on an undivided vh and passes a divided vw');
check(undivided(css).length === 0, 'every vh/vw in style.css is divided by --z', undivided(css));
check(/--z:1;/.test(css) && /--app-h:calc\(100dvh \/ var\(--z,1\)\)/.test(css), 'the --z token exists and the CSS fallback for --app-h is divided');
check(/'--app-h',\s*\(h \/ z\)/.test(app), '--app-h from JS is divided by the zoom');
{
  const s = html.match(/<section id="view-display"[\s\S]*?<\/section>/);
  check(!!s && /class="grab"/.test(s[0]) && /id="zoom-range"/.test(s[0]) && /id="density-seg"/.test(s[0]), 'the Display sheet exists, with a grab handle, the slider and the density switch');
}
check(/id="btn-display"/.test(html), 'the drawer has the Aa button');
{
  const head = html.slice(0, html.indexOf('</head>'));
  check(/localStorage\.getItem\('baton.zoom'\)/.test(head) && head.indexOf('<script>') > head.indexOf('style.css'), 'zoom and density are applied in <head>, before first paint');
  check(/<script src="\/display-ui\.js"><\/script>/.test(html), 'display-ui.js is loaded');
  check(/'baton.zoom'/.test(js) && /'baton.density'/.test(js) && !/'ago\./.test(js + head), 'settings are stored under the baton.* keys (kept: renaming would reset every phone's display settings)');
}
{
  const clampZ = eval(js.match(/const clampZ = [^;]+;/)[0].replace('const clampZ = ', '(ZMIN,ZMAX,STEP)=>').replace(/;$/, ''))(0.7, 1.5, 0.05);
  check(clampZ(0.1) === 0.7 && clampZ(9) === 1.5 && Math.abs(clampZ(0.82) - 0.8) < 1e-9, 'zoom is clamped to 70..150% in 5% steps');
  const head = html.slice(0, html.indexOf('</head>'));
  check(/z<\.7\|\|z>1\.5/.test(head), 'the first-paint script refuses the same out-of-range values');
}
{
  const outside = css.replace(/@media \(pointer:fine\)\{[\s\S]*?\n\}/g, '');
  const bad = [...outside.matchAll(/html\[data-density="compact"\][^{]*\{[^}]*\b(min-height|height|width):\s*(\d+)px/g)].filter(m => +m[2] < 44);
  check(bad.length === 0, 'compact never shrinks a touch target on a coarse pointer (only under pointer:fine)', bad.map(m => m[0].slice(0, 70)));
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall display checks passed');
process.exit(failed ? 1 : 0);
