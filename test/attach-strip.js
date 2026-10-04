// g1169: "After attaching many files relaymote became unusable, couldn't see textbox". Each attachment
// chip took a full-width row, so 15+ chips pushed the textbox and Send off the screen. The chips now
// sit in one sideways-scrolling row under an "N files · Clear all" line. The real renderAttachments()
// is run here against a minimal DOM with 30 attachments.
const fs = require('fs'), path = require('path');
const pub = path.join(__dirname, '..', 'mobile', 'public');
const app = fs.readFileSync(path.join(pub, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(pub, 'style.css'), 'utf8');
let fails = 0;
const check = (ok, what, got) => { console.log((ok ? 'ok   ' : 'FAIL ') + what + (got !== undefined ? '  ' + JSON.stringify(got) : '')); if (!ok) fails++; };

// --- a DOM just big enough for renderAttachments -------------------------------------------------
function el(tag) {
  const e = { tag, children: [], className: '', title: '', _html: '', onclick: null, cls: new Set(),
    appendChild(c) { this.children.push(c); c.parent = this; return c; },
    querySelector(sel) { return (this._btns || []).find(b => sel === 'button') || null; } };
  e.classList = { toggle: (c, on) => (on ? e.cls.add(c) : e.cls.delete(c)), add: c => e.cls.add(c), remove: c => e.cls.delete(c) };
  Object.defineProperty(e, 'innerHTML', {
    get() { return e._html; },
    set(v) { e._html = v; e.children = []; e._btns = /<button/.test(v) ? [{ tag: 'BUTTON', onclick: null }] : []; },
  });
  return e;
}
const wrap = el('div');
const start = app.indexOf('function renderAttachments()');
const end = app.indexOf('function uploadOne(');
const src = app.slice(start, end);
const state = { attachments: [], uploads: [] };
const render = new Function('state', '$', 'document', 'esc', src + '\nreturn renderAttachments;')(
  state, () => wrap, { createElement: el }, (s) => String(s));

state.attachments = Array.from({ length: 30 }, (_, i) => ({ name: 'IMG-20261003-WA0' + (300 + i) + '.jpg', path: 'C:/u/' + i + '.jpg' }));
render();
const head = wrap.children.find(c => c.className === 'att-head');
const strip = wrap.children.find(c => c.className === 'att-strip');
check(!!head && /30 files/.test(head.innerHTML) && /Clear all/.test(head.innerHTML), 'with 30 files there is ONE summary line: "30 files · Clear all"');
check(!!strip && strip.children.length === 30, 'all 30 chips are in the one strip', strip && strip.children.length);
check(wrap.children.length === 2, 'the attachment area is exactly two rows (summary + strip), not one row per file', wrap.children.length);

// remove one chip: the right one goes, by identity (not a stale index)
const target = strip.children[7];
target._btns[0].onclick();
check(state.attachments.length === 29 && !state.attachments.some(a => a.name === 'IMG-20261003-WA0307.jpg'), 'each chip removes its own file');
// clear all
const head2 = wrap.children.find(c => c.className === 'att-head');
head2._btns[0].onclick();
check(state.attachments.length === 0 && wrap.cls.has('hidden'), '"Clear all" empties the list and hides the area');

// --- the CSS keeps it to one row that scrolls sideways ----------------------------------------
const rule = (sel) => { const m = new RegExp('(^|\\n)' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\{([^}]*)\\}').exec(css); return m ? m[2] : ''; };
check(!/flex-wrap:wrap/.test(rule('.attachments')), '.attachments no longer wraps chips onto new rows');
check(/flex-wrap:nowrap/.test(rule('.att-strip')) && /overflow-x:auto/.test(rule('.att-strip')), '.att-strip is one row that scrolls sideways');
check(/max-width/.test(rule('.att-strip .att')) && /text-overflow:ellipsis/.test(rule('.att-name')), 'a long file name is shortened, so one chip cannot fill the row');

if (fails) { console.error(fails + ' failed'); process.exit(1); }
console.log('attach-strip: all checks passed');
