// weblinks.js — bare http(s) URLs in chat bubbles become tappable links (mobile/public/app.js md()).
// Runs the REAL md() (with the helpers it uses) in a vm. Mirrors AGO g452.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failed = 0;
const check = (ok, name, extra) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra !== undefined && !ok ? '  ' + JSON.stringify(extra).slice(0, 300) : ''}`); if (!ok) failed++; };

const app = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'public', 'app.js'), 'utf8');
function grab(startRx) {
  const m = startRx.exec(app);
  if (!m) return '';
  const rest = app.slice(m.index);
  const end = rest.search(/\r?\n(?=(?:function |async function |const |let |\/\/|\/\*|\$\())/);
  return rest.slice(0, end > 0 ? end : undefined);
}
function load(src) {
  const ctx = {}; vm.createContext(ctx);
  vm.runInContext(src + '\n;globalThis.md = md;', ctx);
  return ctx.md;
}
const parts = [/^function esc\(/m, /^const CODE_PATH_RX = /m, /^const FILE_RX = /m, /^const URL_RX = /m, /^function renderTables\(/m, /^function md\(/m].map(grab);
check(parts.every(Boolean), 'esc, CODE_PATH_RX, FILE_RX, URL_RX, renderTables and md are found in app.js', parts.map(p => p.length));
const md = load(parts.join('\n'));
const hrefs = (h) => [...h.matchAll(/<a class="weblink" href="([^"]*)"[^>]*>([^<]*)<\/a>/g)].map(m => [m[1], m[2]]);

{
  const h = md('Open https://github.com/example/relaymote to install.');
  check(JSON.stringify(hrefs(h)) === JSON.stringify([['https://github.com/example/relaymote', 'https://github.com/example/relaymote']])
    && /target="_blank" rel="noopener noreferrer"/.test(h), 'a bare https URL becomes one link that opens outside', h);
}
check(hrefs(md('see https://x.io/a.'))[0][0] === 'https://x.io/a' && hrefs(md('(https://x.io/a)'))[0][0] === 'https://x.io/a', 'trailing punctuation stays outside the link');
{
  const h = md('https://github.com/example/relaymote/blob/main/src/app.js');
  check(!/fileref/.test(h) && hrefs(h).length === 1, 'the path of a URL is NOT also turned into a file link', h);
}
check(hrefs(md('https://x.io/?a=1&b=2'))[0][0] === 'https://x.io/?a=1&amp;b=2', 'a query string keeps its & (escaped in the attribute)');
check(!/href="(?:javascript|data):/i.test(md('javascript:alert(1) data:text/html,<b>x</b> [a](javascript:alert(2))')), 'no javascript: or data: link is produced');
{
  const h = md('https://x.io/"onmouseover="alert(1)');
  check(!/onmouseover="/.test(h) && hrefs(h).length === 1 && hrefs(h)[0][0] === 'https://x.io/', 'a quote cannot break out of the href', h);
}
{
  const h = md('[Relaymote](https://github.com/example/relaymote) and https://a.io');
  check((h.match(/<a /g) || []).length === 2 && !/<a[^>]*>[^<]*<a/.test(h), 'markdown links still work and are not double-linked', h);
}
check(hrefs(md('run `https://a.io/x`')).length === 1, 'a URL inside a code span is linked too');
check(/class="fileref"/.test(md('see src/app.js:12')), 'file paths are still file links');
check(md('hello world') === 'hello world', 'plain text is unchanged');
{
  // The control: md() without the URL pass leaves the URL as text and turns its path into a file link.
  const old = load(parts.join('\n').replace(/\n  \/\/ Bare http\(s\) URLs[\s\S]*?\n  \}\);\n/, '\n'));
  const h = old('https://github.com/example/relaymote/blob/main/src/app.js');
  check(hrefs(h).length === 0 && /fileref/.test(h), 'control: without the URL pass the link is missing and the path became a file link', h);
}

// File paths with spaces (28-Sep report: tapping `memento mcp/docs/GR_REWORK/INTEGRATION_PLAN.md` opened
// "mcp/docs/..." -> NOT_FOUND: the linkifier cut the path at the space).
const refs = (h) => [...h.matchAll(/<a class="fileref" data-p="([^"]*)"/g)].map(m => m[1]);
{
  const msg = 'The full plan is in `memento mcp/docs/GR_REWORK/INTEGRATION_PLAN.md`';
  check(JSON.stringify(refs(md(msg))) === JSON.stringify(['memento mcp/docs/GR_REWORK/INTEGRATION_PLAN.md']), 'the reported message: the whole spaced path in backticks is ONE link', refs(md(msg)));
  check(JSON.stringify(refs(md('`docs/a b/x.md:12`'))) === JSON.stringify(['docs/a b/x.md:12']), 'a :line suffix survives inside a code span');
  check(refs(md('see [the plan](memento mcp/docs/P.md) now'))[0] === 'memento mcp/docs/P.md', 'a markdown link target may hold spaces');
  check(refs(md('see [the plan](<memento mcp/docs/P.md>)'))[0] === 'memento mcp/docs/P.md', 'the <angle> link target form works');
  const abs = 'Saved to D:\\My Documents\\dev work\\projects\\memento mcp\\docs\\PLAN.md, then done.';
  check(refs(md(abs))[0] === 'D:\\My Documents\\dev work\\projects\\memento mcp\\docs\\PLAN.md', 'a bare Windows path with spaced folders is one link, punctuation outside', refs(md(abs)));
  const two = refs(md('compare D:\\a b\\x.md and D:\\c\\y.md'));
  check(two.length === 2 && two[0] === 'D:\\a b\\x.md' && two[1] === 'D:\\c\\y.md', 'two drive paths in a sentence stay two links', two);
  check(refs(md('`D:\\My Documents\\x y\\P.md`'))[0] === 'D:\\My Documents\\x y\\P.md', 'a spaced Windows path in backticks is one link');
  check(!/fileref/.test(md('run `npm test` or `git log -1`')), 'code that is not a path stays code');
  check(refs(md('edit src/app.js:44 now'))[0] === 'src/app.js:44', 'plain relative paths still link as before');
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall weblink checks passed');
process.exit(failed ? 1 : 0);
