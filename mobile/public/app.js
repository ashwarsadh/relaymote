'use strict';

const $ = (id) => document.getElementById(id);

const BUILD = (() => {
  try {
    const el = document.querySelector('script[src*="app.js"]');
    return el ? new URL(el.src, location.href).searchParams.get('v') : null;
  } catch { return null; }
})();
let reauthing = false;
function reauth() {
  if (reauthing) return;
  reauthing = true;
  document.body.insertAdjacentHTML('beforeend',
    '<div class="reauth"><div><b>Session expired</b><p>Cloudflare Access needs you to sign in again.</p>' +
    '<button onclick="location.href=location.pathname">Sign in</button></div></div>');
  setTimeout(() => { location.href = location.pathname; }, 2500);
}

const isNetErr = (e) => /Failed to fetch|NetworkError|Load failed|aborted|timed out/i.test(String(e && e.message || e));
const api = async (path, opts) => {
  const method = ((opts && opts.method) || 'GET').toUpperCase();
  if (method !== 'GET') return apiOnce(path, opts);
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise(r => setTimeout(r, 700 * attempt));
    try { return await apiOnce(path, opts); }
    catch (e) {
      last = e;
      const m = String((e && e.message) || '');
      if (!/timed out|^50[234]$|Failed to fetch|NetworkError|Load failed/.test(m)) throw e;
      if (m === 'signin-required') throw e;
    }
  }
  throw last;
};
const CLIENT_ID = (() => {
  const mint = () => 'c' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  try {
    let v = sessionStorage.getItem('baton.client');
    if (!v) { v = mint(); sessionStorage.setItem('baton.client', v); }
    return v;
  } catch { return mint(); }
})();

const apiOnce = async (path, opts) => {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), (opts && opts.timeoutMs) || 25000);
  let r;
  const o = { credentials: 'same-origin', signal: ctl.signal, ...opts };
  o.headers = { ...(o.headers || {}), 'X-Baton-Client': CLIENT_ID };
  try { r = await fetch(path, o); }
  catch (e) { throw new Error(e && e.name === 'AbortError' ? 'timed out' : (e && e.message) || 'Failed to fetch'); }
  finally { clearTimeout(timer); }
  if (r.redirected && /cloudflareaccess\.com|\/cdn-cgi\/access\//.test(r.url)) { reauth(); throw new Error('signin-required'); }
  if (!r.ok) {
    if (r.status === 401 || r.status === 403) { reauth(); throw new Error('signin-required'); }
    let msg = r.status + '';
    try { msg = (await r.json()).error || msg; } catch {}
    throw new Error(msg);
  }
  const ct = r.headers.get('content-type') || '';
  if (!ct.includes('json')) { reauth(); throw new Error('signin-required'); }
  return r.json();
};

const state = {
  boot: null, sessions: [], folder: null, q: '',
  open: null, meta: null, messages: [], attachments: [], uploads: [],
  oldestByte: null, hasMore: false, loadingMore: false,
  es: null, sending: false, pending: null,
  sort: localStorage.getItem('baton.sort') || 'active',
  favs: new Set(JSON.parse(localStorage.getItem('baton.favs') || '[]')),
  showWork: false,
  expanded: new Set(),
  openGroups: new Set(),
  closedClamps: new Set(),
};

const BOTTOM_TOL = 60;
let logAtBottom = true;
let logNew = 0;
let scrollToBottomNext = false;
let lastProgTop = -1;
let seenMsgIds = new Set();
let seenReplyTs = '';

function syncViewport() {
  const vv = window.visualViewport;
  const h = vv ? vv.height : window.innerHeight;
  // Under CSS zoom z a px height renders at z times its size, but visualViewport is unzoomed, so the
  // column must be h / z CSS px to still fill the screen (see display-ui.js).
  const z = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--z')) || 1;
  document.documentElement.style.setProperty('--app-h', (h / z) + 'px');
  const log = logAtBottom ? document.getElementById('log') : null;
  if (log) requestAnimationFrame(() => setScrollTop(log, log.scrollHeight));
}
if (window.visualViewport) {
  visualViewport.addEventListener('resize', syncViewport);
  visualViewport.addEventListener('scroll', syncViewport);
}
window.addEventListener('resize', syncViewport);
syncViewport();

let toastTimer;
function humanMessage(s) {
  return String(s == null ? '' : s)
    .replace(/\s+/g, ' ')
    .replace(/\b[A-Z][A-Z0-9]{2,}(?:_[A-Z0-9]+)+:?\s*/g, '')
    .replace(/:\s*:/g, ':')
    .trim();
}
function firstSentence(t, cap = 140) {
  const m = t.match(/^.*?[.!?](?=\s|$)/);
  let s = m ? m[0] : t;
  if (s.length > cap) s = s.slice(0, cap).replace(/\s+\S*$/, '') + '…';
  return s;
}
function toast(msg, isErr) {
  const el = $('toast');
  const full = humanMessage(msg);
  const short = firstSentence(full);
  el.innerHTML = '';
  const span = document.createElement('span');
  span.textContent = short;
  el.appendChild(span);
  el.classList.toggle('err', !!isErr);
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  const hide = (ms) => { clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.add('hidden'), ms); };
  if (short !== full) {
    const more = document.createElement('button');
    more.className = 'toast-more';
    more.type = 'button';
    more.textContent = 'Details';
    more.onclick = (e) => {
      e.stopPropagation();
      span.textContent = full;
      more.remove();
      hide(20000);
    };
    el.appendChild(more);
  }
  hide(isErr ? 4500 : 2200);
}

function ago(ts) {
  if (!ts) return '';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  if (s < 86400 * 7) return Math.floor(s / 86400) + 'd';
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
// The desktop picker's badge glyphs are Private Use characters ("Sonnet 5.5\uE08F" showed a box): drop
// them, and zero-width marks, from every model label.
// Same generic rule as desktop.cleanLabel: controls, format and private-use characters and non-ASCII
// symbol badges go, so a glyph on a model that ships later needs no code change.
const shortModel = (m) => String(m || '').normalize('NFKC').replace(/[\p{Cc}\p{Cf}\p{Co}]|(?![\x00-\x7F])[\p{So}\p{Sk}]/gu, '').trim()
  .replace(/^claude-/, '').replace(/-\d{8}$/, '').replace(/-latest$/, '');
const modelKey = (m) => shortModel(m).replace(/-.*$/, '');
const modelFamily = (m) => shortModel(String(m || '').trim()).split(/[\s\-_[]/)[0].toLowerCase();
// Family is not identity: "Opus 5.5" and "Opus 5" share the family word, so comparing families lit
// both buttons. The id is the whole version: "Opus 5.5" / "claude-opus-5-5" / "claude-opus-5-5[1m]"
// -> "opus-5-5". A BARE family ("opus") is an alias and matches its family; nothing else does.
// Same rule as lib/desktop.js sameModel.
const modelId = (m) => shortModel(String(m || '').trim().toLowerCase()).replace(/\[[^\]]*\]$/, '')
  .replace(/[\s._]+/g, '-').replace(/-+$/, '');
const sameModel = (a, b) => {
  const x = modelId(a), y = modelId(b);
  if (!x || !y) return false;
  if (/^[a-z]+$/.test(x) || /^[a-z]+$/.test(y)) return x.split('-')[0] === y.split('-')[0];
  return x === y;
};
// Exact id first; a bare alias ("opus") falls back to the first of its family, which is the desktop's
// own default for that family.
const pickByFamily = (list, m) => (list || []).find(x => sameModel(x, m) && modelId(x) === modelId(m))
  || (list || []).find(x => sameModel(x, m)) || null;

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderTables(h) {
  const lines = h.split('\n');
  const out = [];
  const isSep = (l) => /^[\s|:-]+$/.test(l) && l.includes('-') && l.includes('|');
  const cells = (l) => l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim());

  for (let i = 0; i < lines.length; i++) {
    const head = lines[i];
    if (i + 1 < lines.length && head.includes('|') && isSep(lines[i + 1])) {
      const align = cells(lines[i + 1]).map(c =>
        /^:.*:$/.test(c) ? 'center' : /:$/.test(c) ? 'right' : 'left');
      const body = [];
      let j = i + 2;
      while (j < lines.length && lines[j].includes('|') && lines[j].trim()) { body.push(lines[j]); j++; }
      const hcells = cells(head);
      const hasHead = hcells.some(c => c.replace(/<[^>]*>/g, '').trim());
      const th = hcells.map((c, k) =>
        `<th style="text-align:${align[k] || 'left'}">${c}</th>`).join('');
      const tr = body.map(r => '<tr>' + cells(r).map((c, k) =>
        `<td style="text-align:${align[k] || 'left'}">${c}</td>`).join('') + '</tr>').join('');
      out.push(`<div class="tablewrap"><table class="mdtable">` +
        (hasHead ? `<thead><tr>${th}</tr></thead>` : '') +
        `<tbody>${tr}</tbody></table></div>`);
      i = j - 1;
      continue;
    }
    out.push(head);
  }
  return out.join('\n');
}

async function alreadyLanded(id) {
  try {
    const r = await api('/api/outbox/check?id=' + encodeURIComponent(id));
    return !!(r && r.landed);
  } catch { return false; }
}

function md(src, doc) {
  let h = esc(String(src == null ? '' : src).replace(/\0/g, ''));
  const fences = [];
  h = h.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    fences.push(`<pre class="code">${code.replace(/\n$/, '')}</pre>`);
    return `\u0000${fences.length - 1}\u0000`;
  });
  const links = [];
  // An inline-code span that IS a path opens as one, whole. A path with a space ("memento mcp/docs/x.md")
  // was cut at the space by FILE_RX, and the viewer asked for "mcp/docs/x.md" -> NOT_FOUND.
  h = h.replace(/`([^`\n]+)`/g, (_, c) => {
    const p = c.trim();
    if (!CODE_PATH_RX.test(p)) return `<code>${c}</code>`;
    links.push(`<a class="fileref" data-p="${p.replace(/"/g, '&quot;')}"><code>${c}</code></a>`);
    return `\u0000L${links.length - 1}\u0000`;
  });
  // A markdown link's target may hold spaces: [plan](memento mcp/docs/x.md) or [plan](<a b/x.md>).
  h = h.replace(/\[([^\]\n]+)\]\((?:&lt;([^\n]+?)&gt;|([^)\n]+?))\)/g, (_, label, angle, plain) => {
    const t = (angle || plain).trim().replace(/&amp;/g, '&').replace(/"/g, '&quot;');
    links.push(/^https?:/i.test(t)
      ? `<a href="${t}" target="_blank" rel="noreferrer">${label}</a>`
      : `<a class="fileref" data-p="${t}">${label}</a>`);
    return `\u0000L${links.length - 1}\u0000`;
  });
  // Bare http(s) URLs open in a new tab. Parked like a markdown link BEFORE FILE_RX, so a URL's path is
  // never also turned into a file link. Runs on escaped text: only http(s), and the match stops at an
  // escaped quote or bracket, so the href cannot close its attribute. Trailing punctuation stays outside.
  h = h.replace(URL_RX, (m) => {
    const url = m.replace(/(?:[.,;:!?)\]}]|&#39;)+$/, '');
    const tail = m.slice(url.length);
    links.push(`<a class="weblink" href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
    return `\u0000L${links.length - 1}\u0000${tail}`;
  });
  h = h.replace(FILE_RX, (m) => {
    const clean = m.replace(/[.,;:)\]]+$/, '');
    const tail = m.slice(clean.length);
    return `<a class="fileref" data-p="${clean.replace(/"/g, '&quot;')}">${clean}</a>${tail}`;
  });
  // A .md document is hard-wrapped, so its bold often spans one line break (never a blank line).
  h = h.replace(doc ? /\*\*((?:[^*\n]|\r?\n(?!\r?\n))+?)\*\*/g : /\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  // Chat shows a heading as bold, where one the size of the screen is noise.
  if (!doc) h = h.replace(/^#{1,6}\s+(.+)$/gm, '<strong>$1</strong>');
  h = h.replace(/(^|[^*\w])\*([^*\n]+)\*(?![*\w])/g, '$1<em>$2</em>');
  h = h.replace(/^\s*[-*]\s+/gm, '• ');
  h = renderTables(h);
  // A whole .md DOCUMENT in the file viewer gets real headings; a long one is unreadable as bold
  // lines. The newline after a heading is swallowed because .mdbody is pre-wrap. This runs LAST:
  // done before the bullet and table passes, it pulled the next line off line-start, so a list
  // right under a heading kept its raw "- " and a table there would not render.
  if (doc) h = h.replace(/^(#{1,6})[ \t]+(.+)$\n?/gm, (_, l, t) => { const n = Math.min(l.length + 1, 5); return `<h${n} class="mdh">${t}</h${n}>`; });
  h = h.replace(/\u0000L(\d+)\u0000/g, (_, i) => links[Number(i)]);
  return h.replace(/\u0000(\d+)\u0000/g, (_, i) => fences[Number(i)]);
}

const URL_RX = /\bhttps?:\/\/(?:(?!&quot;|&lt;|&gt;)[^\s<>`"'])+/gi;
// A code span holding one path: a drive path, or a relative path with a separator, ending in a file
// extension (optionally :line). Spaces are allowed, since a code span marks where the path starts and ends.
const CODE_PATH_RX = /^(?:[A-Za-z]:[\\/]|\.{0,2}[\\/])?(?:[^\\/\n`<>|*?]+[\\/])+[^\\/\s`<>|*?]+\.\w{1,8}(?::\d+(?::\d+)?)?$/;
// A bare drive path's folders may hold spaces (D:\Documents of X\y\plan.md); its last segment may not.
const FILE_RX = /(?:[A-Za-z]:\\(?:[^\n"'<>|`&\\:,;]+\\)+[^\s"'<>|`&\\]+\.\w{1,8}|[A-Za-z]:\\[^\s"'<>|`&]+|(?:\.{0,2}[\/])?(?:[\w.@~-]+[\/])+[\w.@~-]+\.\w{1,8})(?::\d+)?/g;

const uiJobs = new Map();

const draftKey = (id) => 'baton.draft.' + id;
function saveDraft(id, text) {
  if (!id) return;
  try {
    if (text && text.trim()) localStorage.setItem(draftKey(id), text);
    else localStorage.removeItem(draftKey(id));
  } catch {}
}
function loadDraft(id) {
  try { return id ? (localStorage.getItem(draftKey(id)) || '') : ''; } catch { return ''; }
}
function clearDraft(id) { try { localStorage.removeItem(draftKey(id)); } catch {} }

const CLAMP_AT = 620;
function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
// Read-aloud button (g757): the device's own speechSynthesis, nothing fetched. Hidden where the
// browser has none, so it never appears as a dead control.
const TTS_OK = typeof speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance !== 'undefined';
function speakBtn(cls) {
  return TTS_OK && /^msg (assistant|user)/.test(cls) ? '<button class="speak" title="Read aloud" aria-label="Read aloud">🔊</button>' : '';
}

// The expand/collapse state is keyed by WHO said it and WHEN it began (`id` = the first row's time),
// never by the text: a reply still being written grows, and a text-keyed bubble that grew in the same
// update that started a newer one came back CLAMPED, throwing him from mid-reply to its start (g780).
function clampable(html, text, cls, id) {
  if (text.length <= CLAMP_AT) return `<div class="${cls}">${speakBtn(cls)}${html}</div>`;
  const ck = hash(id ? cls.split(' ').slice(0, 2).join(' ') + '@' + id : text);
  return `<div class="${cls}">${speakBtn(cls)}<div class="body clamp" data-ck="${ck}">${html}</div>` +
         '<button class="more">Show more</button></div>';
}

const htmlCache = new Map();

function keyOf(m) {
  return m.role + (m.queued ? ':q' : '') + ':' + (m.ts || '') + ':' + ((m.text || '').length) + ':' +
         (m.tools ? m.tools.map(t => t.done ? 'd' : 'r').join('') : '') + ':' +
         ((m.text || '').slice(0, 32)) + ':' + (m.tools ? m.tools.length : 0) + ':' + ((m.thinking || '').length) +
         ':' + (m.ask ? 'q' + (m.ask.questions || []).length : '') + ':' + (m.pairs ? 'a' + m.pairs.length : '');
}

function systemLine(t) {
  const s = String(t || '');
  if (/^\s*<task-notification>/i.test(s)) {
    const m = s.match(/<summary>([\s\S]*?)<\/summary>/i);
    const sum = (m ? m[1] : '').replace(/[ \t\r\n]+/g, ' ').trim();
    return '⚙ ' + (sum || 'background task update');
  }
  if (/^A session-scoped Stop hook/i.test(s)) return '⚙ stop-hook check';
  if (/^\s*<system-reminder>/i.test(s)) return '⚙ system reminder';
  const x = s.match(/^\s*<cross-session-message[^>]*from="([^"]+)"/i);
  if (x) return '↪ message from another session';
  const one = s.replace(/[ \t\r\n]+/g, ' ').trim();
  return one.length > 120 ? one.slice(0, 120) + '…' : one;
}

function ageText(ts) {
  const t = Date.parse(ts || '');
  if (!t) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 45) return 'just now';
  if (s < 5400) return Math.round(s / 60) + 'm ago';
  if (s < 82800) return Math.round(s / 3600) + 'h ago';
  const d = new Date(t);
  const days = Math.round(s / 86400);
  const clock = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (days < 7) return d.toLocaleDateString([], { weekday: 'short' }) + ' ' + clock;
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' }) + ' ' + clock;
}

function stampHtml(m) {
  if (!m.ts) return '';
  const full = new Date(Date.parse(m.ts)).toLocaleString();
  return `<div class="stamp ${m.role === 'user' ? 'mine' : ''}" data-ts="${esc(m.ts)}" ` +
         `title="${esc(full)}">${esc(ageText(m.ts))}</div>`;
}

function tickStamps() {
  document.querySelectorAll('.stamp[data-ts]').forEach(el => {
    const t = ageText(el.getAttribute('data-ts'));
    if (t && el.textContent !== t) el.textContent = t;
  });
}
setInterval(tickStamps, 30000);

setInterval(() => {
  if (document.hidden) return;
  if (state.sending) return;
  loadSessions();
  checkOutbox();
  reloadOpenChat();
}, 30000);

setInterval(() => {
  if (document.hidden || state.sending || !state.open) return;
  const row = (state.sessions || []).find(x => x.id === state.open);
  if (row && (row.running || row.awaiting)) reloadOpenChat();
}, 8000);

let resumeAt = 0;
async function resumeNow() {
  if (document.hidden) return;
  if (Date.now() - resumeAt < 1500) return;
  resumeAt = Date.now();
  state.openingId = null;
  connectStream(state.open || undefined);
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await new Promise(r => setTimeout(r, 1500));
    try {
      await reloadOpenChat(true, { throwOnError: true });
      loadSessions(); checkOutbox();
      if (state.open && $('btn-retry-open')) openChat(state.open);
      return;
    } catch (e) { if (!isNetErr(e)) return; }
  }
}
document.addEventListener('visibilitychange', () => resumeNow());
window.addEventListener('pageshow', () => resumeNow());
window.addEventListener('focus', () => resumeNow());
window.addEventListener('online', () => resumeNow());

setInterval(() => {
  paintConnDot();
  if (document.hidden || !state.es) return;
  if (Date.now() - (state.esLastEvent || 0) > 50000) {
    connectStream(state.esWatch || undefined);
    reloadOpenChat(true);
  }
}, 10000);

function messageHtml(m) {
  let out = '';
  if (m.role === 'assistant' && (m.text || m.ask || (m.asks && m.asks.length))) {
    if (m.text) out += clampable(md(m.text), m.text, 'msg assistant', m.ts);
    const askList = m.asks && m.asks.length ? m.asks : (m.ask ? [m.ask] : []);
    for (const ask of askList) {
      const answers = ask.answers || null;
      const qs = ask.questions || [];
      const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();
      const byText = (q) => {
        const want = flat(q.question);
        return answers.find(p => {
          const got = flat(p.q);
          const n = Math.min(got.length, want.length, 120);
          return n >= 12 && got.slice(0, n) === want.slice(0, n);
        }) || null;
      };
      const mapped = answers ? qs.map(byText) : null;
      const aligned = !!answers && (mapped.every(Boolean) || answers.length === qs.length);
      const answerFor = (q, qi) => mapped[qi] || (answers.length === qs.length ? answers[qi] : null);

      out += '<div class="askcard' + (answers ? ' resolved' : '') + '">'
        + qs.map((q, qi) => {
            const head = (q.header ? `<span class="askhdr">${esc(q.header)}</span>` : '') +
                         `<div class="askt">${esc(q.question)}</div>`;
            if (!answers) {
              return `<div class="askq">` + head +
                (q.options || []).map(o => `<div class="asko">${esc(o.label)}</div>`).join('') +
                (q.multiSelect ? '<div class="askmulti">pick any number</div>' : '') + `</div>`;
            }
            if (ask.dismissed) {
              return `<div class="askq">` + head +
                '<div class="askans dismissed">You dismissed this question</div></div>';
            }
            const hit = aligned ? answerFor(q, qi) : null;
            return `<div class="askq">` + head +
              (hit ? `<div class="askans">${esc(hit.a)}</div>` : '') + `</div>`;
          }).join('')
        + (answers && !ask.dismissed && !aligned
            ? '<div class="askans">' + answers.map(p => esc(p.a)).join('<br>') + '</div>' : '')
        + '</div>';
    }
    out += stampHtml(m);
  }
  else if (m.role === 'answered') {
    out += '<div class="msg user answered">' + (m.pairs || []).map(p =>
      `<div class="ansline"><span>${esc(p.q)}</span><b>${esc(p.a)}</b></div>`).join('') + '</div>';
    out += stampHtml({ ...m, role: 'user' });
  }
  else if (m.role === 'user') {
    out += clampable(md(m.text), m.text, 'msg user' + (m.queued ? ' queued' : ''), m.ts);
    if (m.queued) out += '<div class="queuetag">queued · waiting to be picked up' + sendNowBtn() + '</div>';
    out += stampHtml(m);
  }
  else if (m.role === 'attachment') {
    out += `<div class="msg attachment">📎 ${esc(m.text)}</div>`;
  }
  else if (m.role === 'peer') {
    out += `<details class="peer"><summary>Received message from <b>${esc(peerName(m))}</b><span class="line"></span></summary>` +
           `<div class="body">${md(m.text)}</div>${stampHtml(m)}</details>`;
  }
  else if (m.role === 'system') {
    out += `<div class="msg system"><span class="sysline">${esc(systemLine(m.text))}</span>` +
           `<span class="sysfull">${esc(m.text)}</span></div>`;
  }
  return out;
}

function peerName(m) {
  if (m.name) return m.name;
  const id = m.from || '';
  const row = (state.rawSessions || state.sessions || []).find(x => x.id === id);
  return row && row.title ? row.title : 'another session';
}
function turnOpen(msgs) {
  let open = false, lastTs = NaN;
  for (const m of msgs || []) {
    if (m.ts) { const t = Date.parse(m.ts); if (Number.isFinite(t)) lastTs = t; }
    if (m.role === 'peer' || (m.role === 'user' && !m.queued)) open = !/^\s*\[Request interrupted/i.test(m.text || '');
    else if (m.role === 'assistant' && m.stop === 'end_turn') open = false;
  }
  const quiet = Number.isFinite(lastTs) ? (Date.now() - lastTs) / 1000 : Infinity;
  return open && quiet < 90;
}
function isLive() {
  return !!(state.meta && state.meta.running) || turnOpen(state.messages);
}
function stepText(t) {
  const l = t.label || { done: t.name, running: t.name, meta: '' };
  const running = !t.done && isLive();
  return { verb: running ? l.running : l.done, meta: l.meta || '', running };
}
function workHtml(m) {
  let out = '';
  if (m.thinking) out += `<details class="think"><summary>thinking</summary><div class="body">${esc(m.thinking)}</div></details>`;
  for (const t of (m.tools || [])) {
    const st = stepText(t);
    out += `<details class="tool${st.running ? ' live' : ''}"><summary><b>${esc(st.verb)}</b>${st.meta ? ' <span class="meta">' + esc(st.meta) + '</span>' : ''}</summary>` +
           `<div class="raw">${esc(t.name)} ${esc(t.input)}</div></details>`;
  }
  if (m.role === 'result') out += clampable(esc(m.text), m.text, 'result' + (m.error ? ' err' : ''), m.ts);
  return out;
}

function blocks(messages) {
  const out = [];
  let said = null;
  let run = null;

  const flushWork = () => { if (run) { out.push(run); run = null; } };
  const flushSaid = () => {
    if (!said) return;
    const merged = { role: 'assistant', ts: said.ts, text: said.texts.join('\n\n'), asks: said.asks };
    const k = 'turn:' + said.keys.join('|');
    out.push({ type: 'msg', key: k, html: cached(k, merged) });
    said = null;
  };
  const endTurn = () => { flushWork(); flushSaid(); };

  // Keys must not carry the row's INDEX. The stream sends a sliding 60-row window, so every new row
  // shifted every index: each working group got a new key on every update, which closed a group he
  // had opened and lost the reading anchor. Count repeats instead of positions.
  const seenKey = new Map(), seenId = new Map();
  const nth = (map, v) => { const n = map.get(v) || 0; map.set(v, n + 1); return n; };
  messages.forEach((m) => {
    const k = keyOf(m) + ':' + nth(seenKey, keyOf(m));
    // A working group is named by its FIRST row's identity (role + time), which stays the same while
    // the turn runs; keyOf() changes as that row's tools finish.
    const wk = 'w:' + m.role + ':' + (m.ts || '') + ':' + nth(seenId, m.role + ':' + (m.ts || ''));
    const note = m.role === 'system';
    const working = m.thinking || (m.tools && m.tools.length) || m.role === 'result' || note;
    const speaks = m.role === 'assistant' && (m.text || m.ask);
    const theirs = m.role === 'user' || m.role === 'answered' || m.role === 'attachment' || m.role === 'peer';

    if (note && said) flushSaid();

    if (working) {
      if (!run) run = { type: 'work', key: wk, steps: [], n: 0 };
      run.steps.push(note ? messageHtml(m) : workHtml(m));
      run.n += (m.tools ? m.tools.length : 0) + (m.role === 'result' ? 1 : 0) +
               (m.thinking ? 1 : 0) + (note ? 1 : 0);
      for (const t of (m.tools || [])) { const st = stepText(t); run.last = st.verb + (st.meta ? ' · ' + st.meta : ''); }
    }
    if (speaks) {
      if (!said) said = { texts: [], asks: [], keys: [], ts: m.ts };
      if (m.text) said.texts.push(m.text);
      if (m.ask) said.asks.push(m.ask);
      said.keys.push(k);
      said.ts = m.ts || said.ts;
    }
    if (theirs) { endTurn(); out.push({ type: 'msg', key: k, html: cached(k, m) }); }
    // A file the session SENT is the point of the turn, not a step: it gets its own card (player,
    // preview, open) in the flow instead of hiding inside "Working · N steps".
    const sent = (m.tools || []).filter(t => t.files && t.files.length);
    if (sent.length) { endTurn(); sent.forEach((t, i) => out.push({ type: 'msg', key: 'file:' + k + ':' + i, html: sentFileHtml(t) })); }
  });
  endTurn();
  return out;
}

/* The card for a sent file. Media goes through /api/sent-file, which the auth cookie (or the
   Cloudflare Access cookie) authenticates, so an <audio>/<video>/<img> src works without a header;
   the server answers Range, so audio and video seek. Every file also gets an open-in-a-tab link. */
/* Each render rebuilds the log, so a video or image above him came back with no size and grew
   again when its metadata loaded, a frame AFTER the view was placed: every stream update in a
   session with a sent video jumped his page by the video's height and back (g780, measured 29-Sep on
   his phone: 374 px, every 2.5 s). The first load records the real size, and every later render
   reserves it. */
const mediaDims = new Map();
function learnMedia(e) {
  const m = e.target, src = m.getAttribute && m.getAttribute('src');
  const w = m.videoWidth || m.naturalWidth, h = m.videoHeight || m.naturalHeight;
  if (!src || !w || !h || mediaDims.has(src)) return;
  mediaDims.set(src, { w, h });
  htmlCache.clear();   // cached bubbles were built without the size
}
function sentFileHtml(t) {
  const sid = state.open || '';
  let out = '<div class="msg sentfile">';
  if (t.caption) out += `<div class="sf-cap">${esc(t.caption)}</div>`;
  for (const f of t.files) {
    const name = String(f).split(/[\\/]/).pop() || f;
    const url = '/api/sent-file?session=' + encodeURIComponent(sid) + '&path=' + encodeURIComponent(f);
    const e = ((name.match(/\.([a-z0-9]+)$/i) || [])[1] || '').toLowerCase();
    out += '<div class="sf">';
    if (/^(wav|mp3|ogg|oga|opus|m4a|aac|flac)$/.test(e)) out += `<audio controls preload="metadata" src="${esc(url)}"></audio>`;
    const d = mediaDims.get(url);
    if (/^(mp4|webm|mov)$/.test(e)) out += `<video controls playsinline preload="metadata"${d ? ` style="aspect-ratio:${d.w} / ${d.h}"` : ''} src="${esc(url)}"></video>`;
    else if (/^(png|jpe?g|gif|webp|svg)$/.test(e)) out += `<a href="${esc(url)}" target="_blank" rel="noopener"><img loading="lazy" alt="${esc(name)}"${d ? ` width="${d.w}" height="${d.h}"` : ''} src="${esc(url)}"></a>`;
    // A text file opens in Relaymote's own file viewer (a .md one formatted); the href stays as a fallback.
    const view = /^(md|markdown|txt|log|json|csv|py|js|ts|sh|ps1|yml|yaml|xml|sql)$/.test(e) ? ` data-sent="${esc(url)}" data-p="${esc(f)}"` : '';
    out += `<a class="sf-name" href="${esc(url)}"${view} target="_blank" rel="noopener">\ud83d\udcce ${esc(name)}</a></div>`;
  }
  return out + '</div>';
}

function cached(k, m) {
  if (m.queued) return messageHtml(m);
  let h = htmlCache.get(k);
  if (h === undefined) { h = messageHtml(m); htmlCache.set(k, h); }
  return h;
}

const sendNowBlocked = new Map();
const ATT_QUEUED_NOTE = 'queued — goes when the current turn ends · no Send now or × for a message with an attachment';
function heldControls(outboxId) {
  return ' <button class="sendnow ob-sendnow" type="button" data-ob="' + esc(outboxId) + '"' +
         ' title="Interrupt the current turn and send this now">Send now</button>' +
         ' <button class="linkish ob-cancel" type="button" data-ob="' + esc(outboxId) + '"' +
         ' title="Take this message back — it will not be sent">×</button>';
}

function sendNowBtn() {
  const why = state.open ? sendNowBlocked.get(state.open) : null;
  if (why === 'held') return '';
  const title = why === 'gone'
    ? 'This message has already gone through to the session'
    : 'Push this into the session now, ahead of the queue';
  return ' <button class="sendnow" type="button"' + (why ? ' disabled' : '') +
         ' title="' + title + '">send now</button>';
}
function heldNote(at) {
  if (!state.open || sendNowBlocked.get(state.open) !== 'held') return '';
  const mins = Math.round((Date.now() - (typeof at === 'number' ? at : Date.parse(at || ''))) / 60000);
  return '<span class="heldnote">held' + (Number.isFinite(mins) && mins >= 1 ? ' ' + mins + 'm' : '') +
         ' · goes when this turn ends</span>';
}

let lastSig = '';
function liveState() {
  const msgs = state.messages || [];
  if (!state.open || !msgs.length || !isLive()) return null;
  let start = -1;
  for (let i = msgs.length - 1; i >= 0; i--) { const r = msgs[i].role; if ((r === 'user' && !msgs[i].queued) || r === 'peer') { start = i; break; } }
  const startTs = start >= 0 ? Date.parse(msgs[start].ts || '') : NaN;
  let tokens = 0, lastTs = NaN, toolsRunning = false;
  for (let i = Math.max(start, 0); i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role === 'assistant' && m.usage) tokens += m.usage.out || 0;
    if (m.ts) lastTs = Date.parse(m.ts) || lastTs;
    toolsRunning = m.role === 'assistant' && (m.tools || []).some(t => !t.done);
    if (m.role === 'result') toolsRunning = false;
  }
  const now = Date.now();
  const elapsed = Number.isFinite(startTs) ? Math.max(0, (now - startTs) / 1000) : null;
  const quiet = Number.isFinite(lastTs) ? (now - lastTs) / 1000 : 0;
  const phase = toolsRunning ? 'Running tools…'
              : quiet >= 60 ? 'Almost done thinking…' : quiet >= 45 ? 'Thinking some more…'
              : quiet >= 30 ? 'Thinking more…' : quiet >= 15 ? 'Still thinking…' : 'Thinking…';
  return { elapsed, tokens, phase };
}
function fmtElapsed(s) {
  if (s === null) return '';
  if (s < 60) return Math.floor(s) + 's';
  const m = Math.floor(s / 60), r = Math.floor(s % 60);
  return m < 60 ? m + 'm ' + String(r).padStart(2, '0') + 's' : Math.floor(m / 60) + 'h ' + String(m % 60).padStart(2, '0') + 'm';
}
function renderLive() {
  const el = $('live');
  if (!el) return;
  const st = liveState();
  if (!st) { if (!el.hidden) { el.hidden = true; el.textContent = ''; } return; }
  const parts = [];
  if (st.elapsed !== null) parts.push(fmtElapsed(st.elapsed));
  if (st.tokens) parts.push(st.tokens.toLocaleString() + ' tokens');
  parts.push(st.phase);
  const text = parts.join(' · ');
  if (el.textContent !== text) el.textContent = text;
  el.hidden = false;
}
setInterval(renderLive, 1000);

const nearBottom = (el) => el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_TOL;
function setScrollTop(el, v) { el.scrollTop = v; lastProgTop = el.scrollTop; }
// A working group is identified by its data-key alone: its summary ("Working · 42 steps · Read file")
// changes with every step, so a key built from the text stopped matching mid-turn.
const anchorKey = (el) => el.dataset.key ? 'k:' + el.dataset.key : el.className + '|' + (el.textContent || '').slice(0, 80);
const anchorable = (el) => !el.classList.contains('stamp') && el.id !== 'log-top';
function keyCounts(log) {
  const n = new Map();
  for (const el of log.children) if (anchorable(el)) { const k = anchorKey(el); n.set(k, (n.get(k) || 0) + 1); }
  return n;
}
/* Every block on screen, top first, each with where it sits. One anchor was not enough: when that block
   was itself replaced or renamed, the render fell back to an absolute scrollTop and the page moved under
   the reader. The first candidate that survives the render wins. Keys that appear twice (two identical
   "ok" bubbles) are skipped, since they could restore to the wrong one. */
function readingAnchor(log) {
  const top = log.getBoundingClientRect().top, bottom = top + log.clientHeight;
  const counts = keyCounts(log), out = [];
  for (const el of log.children) {
    if (!anchorable(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.bottom <= top) continue;
    if (r.top >= bottom || out.length >= 8) break;
    const key = anchorKey(el);
    // `delta` is from the log's top edge; `screen` is on the screen, so a bar appearing ABOVE the log
    // (which moves its top edge) does not slide what he is reading (g780).
    if (counts.get(key) === 1) out.push({ key, delta: r.top - top, screen: r.top });
  }
  return out.length ? out : null;
}
function restoreAnchor(log, list, byScreen) {
  if (!list) return false;
  const top = log.getBoundingClientRect().top;
  const counts = keyCounts(log), byKey = new Map();
  for (const el of log.children) if (anchorable(el)) byKey.set(anchorKey(el), el);
  for (const a of list) {
    const el = counts.get(a.key) === 1 && byKey.get(a.key);
    if (!el) continue;
    const want = byScreen && a.screen != null ? el.getBoundingClientRect().top - a.screen
                                               : (el.getBoundingClientRect().top - top) - a.delta;
    setScrollTop(log, log.scrollTop + want);
    return true;
  }
  return false;
}
/* The stream and the timed reload send only the LAST 60 rows. Rendering that as the whole list threw
   away every older page scrolled up into, so the message being read left the DOM and the view jumped.
   Unless the reader is at the bottom, keep what is loaded above the tail and splice the tail on where
   the two overlap. At the bottom the tail alone is right: nothing above is on screen, and it keeps the
   list bounded. */
/* A queued placeholder (the server's `queued` extra) whose text has since arrived as a real message
   is stale: drop it, so it can never sit above its own delivered copy with a live "send now". */
function reconcileQueued(msgs) {
  if (!msgs || !msgs.some(m => m.queued !== undefined)) return msgs;
  const nn = (t) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const arrived = msgs.filter(m => m.role === 'user' && m.queued === undefined);
  return msgs.filter(m => m.queued === undefined ||
    !arrived.some(a => nn(a.text) === nn(m.text) && String(a.ts || '') >= String(m.ts || '')));
}

function applyTail(tail, startByte, hasMore) {
  const cur = state.messages || [];
  const page = () => { if (startByte !== undefined && startByte !== null) { state.oldestByte = startByte; state.hasMore = !!hasMore; } };
  if (!cur.length || !tail.length || scrollToBottomNext || logAtBottom) { page(); return tail; }
  const id = (m) => m.role + ':' + (m.ts || '');
  const t0 = id(tail[0]);
  for (let j = 0; j < cur.length; j++) {
    if (id(cur[j]) !== t0) continue;
    let same = true;
    for (let k = 1; k < 4 && j + k < cur.length && k < tail.length; k++) if (id(cur[j + k]) !== id(tail[k])) { same = false; break; }
    // Older pages stay, so oldestByte / hasMore still describe the top of what is loaded.
    // A queued placeholder is only true in the LATEST window: one kept in the older prefix outlived its
    // delivery (29-Sep: 'queued · waiting' sat above the delivered copy for an hour). Drop them there.
    if (same) return cur.slice(0, j).filter(m => m.queued === undefined).concat(tail);
  }
  page(); return tail;    // no overlap: more arrived than one window holds; the tail is the truth
}
function renderJump() {
  const b = $('jump'); if (!b) return;
  const log = $('log');
  const show = !logAtBottom && log.scrollHeight > log.clientHeight + BOTTOM_TOL;
  b.hidden = !show;
  b.textContent = logNew > 0 ? '\u2193 ' + logNew + ' new' : '\u2193';
  b.setAttribute('aria-label', logNew > 0 ? logNew + ' new messages, jump to the end' : 'Jump to the end');
}
function jumpToBottom() {
  const log = $('log');
  logAtBottom = true; logNew = 0;
  setScrollTop(log, log.scrollHeight);
  renderJump();
}

function renderLog(messages, force) {
  messages = reconcileQueued(messages);
  state.messages = messages;
  if (state.open && state._suggLive !== undefined && isLive() !== state._suggLive) renderSuggestion(state.meta);
  renderLive();
  const sig = messages.map(keyOf).join('|');
  if (!force && sig === lastSig) return;

  const log = $('log');
  if (!force) {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.rangeCount &&
        log.contains(sel.getRangeAt(0).commonAncestorContainer)) return;
  }
  lastSig = sig;
  const stick = scrollToBottomNext || logAtBottom;
  scrollToBottomNext = false;
  const anchor = stick ? null : readingAnchor(log);
  const keepTop = log.scrollTop;
  let html = '';
  const blks = blocks(messages);
  // Count only what he can READ: assistant text (or a question), newer than anything already seen.
  // A tool step, a "Working" row, or older history loaded at the top is never "new" (g780: 100 steps
  // read as 100). The first render of a chat only sets the mark.
  {
    let top = seenReplyTs;
    for (const m of messages) {
      if (m.role !== 'assistant' || !(m.text || m.ask) || !m.ts) continue;
      const t = String(m.ts);
      if (!stick && seenReplyTs && t > seenReplyTs) logNew++;
      if (t > top) top = t;
    }
    seenReplyTs = top;
  }
  for (const b of blks) {
    if (b.type === 'msg') { html += b.html; continue; }
    const open = state.showWork || state.openGroups.has(b.key);
    html += `<details class="work" data-key="${esc(b.key)}"${open ? ' open' : ''}>` +
            `<summary>Working · ${b.n} step${b.n === 1 ? '' : 's'}${b.last ? ' <span class="last">· ' + esc(b.last) + '</span>' : ''}<span class="line"></span></summary>` +
            `<div class="steps">${b.steps.join('')}</div></details>`;
  }
  if (state.pending && state.pending.sid !== state.open) state.pending = null;

  if (state.pending) {
    const p = state.pending;
    const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim();
    const want = norm(p.text).slice(0, 60);
    const seen = want ? messages.some(m => norm(m.text).includes(want)) : false;
    if (seen || Date.now() - p.at > (p.text ? 90000 : 30000)) state.pending = null;
  }
  retireSpentDraft(messages);

  {
    const nn = (t) => String(t || '').replace(/\s+/g, ' ').trim();
    const inLog = (t) => { const w = nn(t).slice(0, 60); return !!w && messages.some(m => nn(m.text).includes(w)); };
    const pendText = state.pending ? nn(state.pending.text) : '';
    for (const e of (state.outbox || [])) {
      if (e.session !== state.open) continue;
      if (inLog(e.text)) continue;
      if (pendText && nn(e.text) === pendText) continue;
      const mins = Math.round((e.ageMs || 0) / 60000);
      const bad = e.suspect || e.state === 'failed';
      const sn = !bad && e.held ? heldControls(e.id) : (!bad && e.delivery === 'queued' ? sendNowBtn() : '');
      html += `<div class="msg user pending${bad ? ' stuck' : ''}${sn ? ' act' : ''}">${md(e.text)}` +
        (bad
          ? `<span class="tick">delivered, waiting for a reply${mins ? ' · ' + mins + 'm' : ''} ` +
            `<button class="linkish ob-retry" data-ob="${esc(e.id)}">Send again</button> ` +
            `<button class="linkish ob-forget" data-ob="${esc(e.id)}">Discard</button></span>`
          : `<span class="tick">${e.held
              ? 'queued — waiting for the current turn' + sn
              : e.delivery === 'queued'
                ? (/^@/m.test(e.text) ? ATT_QUEUED_NOTE : 'queued — waiting for the current turn' + sn + heldNote(e.at))
                : 'sending…'}</span>`) +
        `</div>`;
    }
  }

  if (state.pending) {
    const p2 = state.pending;
    const names = (p2.atts || []).map(a => esc(String(a).split(/[/\\/]/).pop()));
    const body = p2.text ? md(p2.text)
      : names.length ? '<div class="muted">attached: ' + names.join(', ') + '</div>'
      : '<div class="muted">(empty)</div>';
    const sn2 = p2.status === 'queued' ? (p2.held && p2.outboxId ? heldControls(p2.outboxId) : sendNowBtn()) : '';
    const tick = p2.status === 'sent' ? 'sent ✓'
               : p2.status === 'queued' ? (!p2.held && p2.atts && p2.atts.length ? ATT_QUEUED_NOTE : 'queued — waiting for the current turn' + sn2 + (p2.held ? '' : heldNote(p2.at)))
               : 'sending…';
    html += `<div class="msg user pending${sn2 ? ' act' : ''}">${body}<span class="tick">${tick}</span></div>`;
  }
  log.innerHTML = html || '<div class="empty">No messages yet.</div>';
  log.querySelectorAll('.ob-retry').forEach(b => {
    b.onclick = async (ev) => {
      ev.stopPropagation();
      const e = (state.outbox || []).find(x => x.id === b.dataset.ob);
      if (!e) return;
      b.disabled = true;
      if (await alreadyLanded(e.id)) {
        toast('Already delivered — not sent again');
        api('/api/outbox/drop?id=' + encodeURIComponent(e.id)).catch(() => {});
        state.outbox = (state.outbox || []).filter(x => x.id !== e.id);
        renderLog(state.messages, false);
        return;
      }
      api('/api/outbox/drop?id=' + encodeURIComponent(e.id)).catch(() => {});
      state.outbox = (state.outbox || []).filter(x => x.id !== e.id);
      send({ id: e.session, text: e.text });
    };
  });
  log.querySelectorAll('.ob-forget').forEach(b => {
    b.onclick = async (ev) => {
      ev.stopPropagation();
      await api('/api/outbox/drop?id=' + encodeURIComponent(b.dataset.ob)).catch(() => {});
      state.outbox = (state.outbox || []).filter(x => x.id !== b.dataset.ob);
      renderLog(state.messages, false);
    };
  });
  const heldAction = (b, path, label) => async (ev) => {
    ev.stopPropagation();
    const outboxId = b.dataset.ob;
    const sid = state.open;
    b.disabled = true;
    try {
      const d = await api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                  body: JSON.stringify({ id: sid, outboxId }) });
      if (d && d.jobId) uiJobs.set(d.jobId, {
        label,
        done: (r) => r.cancelled ? 'Taken back — it will not be sent'
                   : r.interrupted ? 'Sent now — the running turn was interrupted'
                   : label + ' done',
        after: () => {
          if (label === 'Cancel') {
            state.outbox = (state.outbox || []).filter(x => x.id !== outboxId);
            if (state.pending && state.pending.outboxId === outboxId) state.pending = null;
          } else if (state.pending && state.pending.outboxId === outboxId) state.pending.status = 'sent';
          renderLog(state.messages, false);
          checkOutbox();
          setTimeout(() => reloadOpenChat(true), 1500);
        },
        onFail: (r) => {
          if (r.alreadySent) {
            toast(r.note || 'Already sent — it was delivered when the turn ended. Nothing was sent twice.');
            state.outbox = (state.outbox || []).filter(x => x.id !== outboxId);
            if (state.pending && state.pending.outboxId === outboxId) state.pending = null;
            renderLog(state.messages, false);
            reloadOpenChat(true); checkOutbox();
            return true;
          }
          toast(r.note || r.error || (label + ' failed'), true); b.disabled = false; return true;
        },
        revert: () => { b.disabled = false; },
      });
      else { toast((d && (d.message || d.error)) || (label + ' refused'), true); b.disabled = false; }
    } catch (e) { toast(label + ' failed: ' + e.message, true); b.disabled = false; }
  };
  log.querySelectorAll('.ob-sendnow').forEach(b => { b.onclick = heldAction(b, '/api/queued/send-now', 'Send now'); });
  log.querySelectorAll('.ob-cancel').forEach(b => { b.onclick = heldAction(b, '/api/queued/cancel', 'Cancel'); });
  if (state.hasMore && typeof topSentinel !== 'undefined') log.insertBefore(topSentinel, log.firstChild);

  const clamped = log.querySelectorAll('[data-ck]');
  const replies = log.querySelectorAll('.msg.assistant [data-ck]');
  const newest = replies.length ? replies[replies.length - 1] : null;
  if (newest && !state.closedClamps.has(newest.dataset.ck)) {
    state.expanded.add(newest.dataset.ck);
  }

  for (const el of clamped) {
    if (!state.expanded.has(el.dataset.ck)) continue;
    el.classList.remove('clamp');
    const b = el.nextElementSibling;
    if (b && b.classList.contains('more')) b.textContent = 'Show less';
  }

  if (htmlCache.size > 400) htmlCache.clear();
  if (stick) { logAtBottom = true; logNew = 0; setScrollTop(log, log.scrollHeight); }
  else if (!restoreAnchor(log, anchor)) setScrollTop(log, keepTop);
  heldAnchor = logAtBottom ? null : (anchor || readingAnchor(log));
  if (typeof observeLog === 'function') observeLog();
  findRemark();
  renderJump();
}

$('log').addEventListener('scroll', () => {
  if ($('log').scrollTop === lastProgTop) return;
  const was = logAtBottom;
  logAtBottom = nearBottom($('log'));
  if (logAtBottom) logNew = 0;
  if (was !== logAtBottom || logAtBottom) renderJump();
}, { passive: true });
if ($('jump')) $('jump').addEventListener('click', jumpToBottom);

/* Hold the view still (g780). renderLog places the view once, but the page keeps changing size AFTER
   it: a code block or image lays out, the composer or a bar above the log grows or goes, a clamp or a
   step list settles. At the bottom that left the newest text below the edge (it "scrolled me up");
   higher up it slid what he was reading. A ResizeObserver on the log box and every row answers each
   such change: at the bottom, stay at the bottom; otherwise put the row he was reading back where it
   was. His own tap (Show more, a Working row, the speaker) is the exception: the thing he tapped
   stays where his finger was, and nothing jumps to the end. */
let heldAnchor = null, userTapAt = 0, anchorRaf = 0;
function noteAnchor() {
  if (anchorRaf) return;
  anchorRaf = requestAnimationFrame(() => { anchorRaf = 0; heldAnchor = logAtBottom ? null : readingAnchor($('log')); });
}
function holdView() {
  const log = $('log');
  if (Date.now() - userTapAt < 700) {
    if (heldAnchor) restoreAnchor(log, heldAnchor, true);
    logAtBottom = nearBottom(log);
  } else if (logAtBottom) {
    if (log.scrollHeight - log.clientHeight - log.scrollTop > 1) setScrollTop(log, log.scrollHeight);
  } else if (heldAnchor) {
    restoreAnchor(log, heldAnchor, true);
    heldAnchor = readingAnchor(log);   // re-based: the next change is measured from where he now is
  }
  renderJump();
}
const logRO = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(holdView);
function observeLog() {
  if (!logRO) return;
  const log = $('log');
  logRO.disconnect();
  logRO.observe(log);
  for (const el of log.children) logRO.observe(el);
}
$('log').addEventListener('scroll', noteAnchor, { passive: true });
$('log').addEventListener('loadedmetadata', learnMedia, true);
$('log').addEventListener('load', learnMedia, true);
$('log').addEventListener('pointerdown', (e) => {
  if (!e.target.closest('summary, .more, .speak, details, button')) return;
  userTapAt = Date.now();
  heldAnchor = readingAnchor($('log'));      // taken NOW, before the tap changes anything
}, { capture: true, passive: true });

$('log').addEventListener('click', (e) => {
  const more = e.target.closest('.more');
  if (more) {
    e.stopPropagation();
    const body = more.previousElementSibling;
    const stillClamped = body.classList.toggle('clamp');
    if (stillClamped) { state.expanded.delete(body.dataset.ck); state.closedClamps.add(body.dataset.ck); }
    else { state.expanded.add(body.dataset.ck); state.closedClamps.delete(body.dataset.ck); }
    more.textContent = stillClamped ? 'Show more' : 'Show less';
    return;
  }
  const sum = e.target.closest('details.work > summary');
  if (sum) {
    const d = sum.parentElement;
    if (d.open) { state.openGroups.delete(d.dataset.key); }
    else { state.openGroups.add(d.dataset.key); }
  }
});

function drawer(open) {
  if (open && !navQuiet && !$('drawer').classList.contains('open')) navRecord();
  $('drawer').classList.toggle('open', open);
  $('scrim').classList.toggle('hidden', !open);
}

const navStack = [];
let navQuiet = false;
let navTouched = 0;          // every navigation, the user's or a restore's: boot yields to any of them
let navSkip = 0;
let exitArmed = 0;

function visibleSheetId() {
  const open = document.querySelectorAll('.sheet:not(.hidden)');
  return open.length ? (open[open.length - 1].id || null) : null;
}
function navSnapshot() {
  return { chat: state.open || null, sheet: visibleSheetId(),
           drawer: $('drawer').classList.contains('open') };
}
const navSame = (a, b) => a && b && a.chat === b.chat && a.sheet === b.sheet && a.drawer === b.drawer;

function navRecord() {
  navTouched++;
  if (navQuiet) return;
  const snap = navSnapshot();
  if (navSame(navStack[navStack.length - 1], snap)) return;
  navStack.push(snap);
  try { history.pushState({ ago: navStack.length }, ''); } catch {}
}

function navBack() {
  if (navStack.length) { try { history.back(); return; } catch {} }
  const sid = visibleSheetId();
  if (sid) return hideSheet($(sid));
  if ($('drawer').classList.contains('open')) drawer(false);
}

async function navRestore(snap) {
  navQuiet = true;
  try {
    const cur = visibleSheetId();
    if (cur && cur !== snap.sheet) hideSheet($(cur));
    if (snap.sheet && snap.sheet !== cur && $(snap.sheet)) showSheet($(snap.sheet));
    if (snap.chat && snap.chat !== state.open) await openChat(snap.chat);
    drawer(!!snap.drawer);
  } catch { }
  finally { navQuiet = false; }
}

window.navBack = navBack;
window.navOpenFrom = (id) => { navRecord(); navQuiet = true; const p = openChat(id); navQuiet = false; return p; };
window.navRecord = navRecord;

window.addEventListener('popstate', () => {
  if (navSkip > 0) { navSkip--; return; }
  const snap = navStack.pop();
  if (snap) { navRestore(snap); return; }
  if (Date.now() - exitArmed < 2500) { navSkip++; try { history.back(); } catch {} return; }
  exitArmed = Date.now();
  toast('Press back again to exit');
  try { history.pushState({ ago: 0 }, ''); } catch {}
});

function renderFolders() {
  const wrap = $('folders');
  wrap.innerHTML = '';
  const mk = (label, n, key) => {
    const b = document.createElement('button');
    b.className = 'chip' + (state.folder === key ? ' on' : '');
    b.innerHTML = esc(label) + (n != null ? ` <span class="n">${n}</span>` : '');
    b.onclick = () => { state.folder = key; renderFolders(); loadSessions(); };
    wrap.appendChild(b);
  };
  mk('All', state.boot ? state.boot.counts.active : null, null);
  for (const f of (state.boot ? state.boot.folders : [])) mk(f.name || '(root)', f.count, f.cwd);
}

function sortSessions(list) {
  const rank = (s) => (s.awaiting ? 0 : s.running ? 1 : 2);
  const arr = list.slice();
  if (state.sort === 'fav') return arr.filter(s => state.favs.has(s.id)).sort((a, b) => b.at - a.at);
  if (state.sort === 'recent') return arr.sort((a, b) => b.at - a.at);
  return arr.sort((a, b) => {
    const f = (state.favs.has(b.id) ? 1 : 0) - (state.favs.has(a.id) ? 1 : 0);
    if (f) return f;
    const r = rank(a) - rank(b);
    return r || b.at - a.at;
  });
}

function toggleFav(id) {
  if (state.favs.has(id)) state.favs.delete(id); else state.favs.add(id);
  localStorage.setItem('baton.favs', JSON.stringify([...state.favs]));
  renderSessions(state.rawSessions || []);
}

function renderSessions(list, opts = {}) {
  state.rawSessions = list;
  const shown = opts.noSort ? list : sortSessions(list);
  state.sessions = shown;
  const ul = $('sessions');
  ul.innerHTML = '';
  for (const s of shown) {
    const li = document.createElement('li');
    li.className = 'row' + (s.id === state.open ? ' current' : '');
    const cls = s.running ? (s.stalled ? 'running stalled' : 'running') : s.awaiting ? 'awaiting' : 'idle';
    const meta = [];
    const tag = s.folder || s.group;
    if (tag) meta.push(`<span class="tag">${esc(tag)}</span>`);
    meta.push(`<span>${ago(s.at)}</span>`);
    if (s.model) meta.push(`<span>${esc(shortModel(s.model))}</span>`);
    if (s.awaiting) meta.push('<span style="color:var(--wait)">needs you</span>');
    if (s.stalled) meta.push(`<span class="muted">running · quiet ${Math.round(s.quietFor / 60000)}m</span>`);
    li.innerHTML =
      `<span class="dot ${cls}"></span>` +
      `<div class="row-main">` +
        `<div class="row-title">${esc(s.title)}</div>` +
        `<div class="row-meta">${meta.join('')}</div>` +
        (s.snippet ? `<div class="snip">${s.role ? `<b>${s.role === 'user' ? 'You' : 'Reply'}:</b> ` : ''}${markSnip(s.snippet, state.deepQ)}` +
          `${s.matches > 1 ? ` <span class="muted">· ${s.matches} matches</span>` : ''}</div>` : '') +
      `</div>` +
      `<button class="star${state.favs.has(s.id) ? ' on' : ''}" data-fav="${esc(s.id)}" ` +
      `aria-label="${state.favs.has(s.id) ? 'Unstar' : 'Star'}">${state.favs.has(s.id) ? '★' : '☆'}</button>`;
    li.onclick = (e) => {
      const st = e.target.closest('.star');
      if (st) { e.stopPropagation(); toggleFav(st.dataset.fav); return; }
      // A search hit opens ON its message (29-Sep), not at the bottom of the session.
      const p = openChat(s.id); drawer(false);
      if (s.byte != null && s.ts) Promise.resolve(p).then(() => landAtHit({ byte: s.byte, ts: s.ts, snippet: s.snippet }, state.deepQ));
    };
    ul.appendChild(li);
  }
  $('list-empty').classList.toggle('hidden', shown.length > 0);
}

function renderSortChips() {
  const wrap = $('sortbar');
  wrap.innerHTML = '';
  for (const [key, label] of [['active', 'Active first'], ['recent', 'Recent'], ['fav', '★ Starred']]) {
    const b = document.createElement('button');
    b.className = 'chip' + (state.sort === key ? ' on' : '');
    b.textContent = label;
    b.onclick = () => {
      state.sort = key; localStorage.setItem('baton.sort', key);
      renderSortChips(); renderSessions(state.rawSessions || []);
    };
    wrap.appendChild(b);
  }
}

async function loadSessions() {
  const p = new URLSearchParams();
  if (state.folder) p.set('folder', state.folder);
  if (state.q) p.set('q', state.q);
  p.set('limit', '80');
  try {
    const d = await api('/api/sessions?' + p);
    renderSessions(d.sessions);
    noteLinkState(d);
    if (state.boot && d.build) {
      const moved = state.boot.build !== d.build;
      state.boot.build = d.build; state.boot.buildAgeMs = d.buildAgeMs;
      if (d.version) state.boot.version = d.version;
      if (moved || typeof d.buildAgeMs === 'number') paintBuildLine();
    }
  } catch (e) { toast('List failed: ' + e.message, true); }
}

// With no session open, the header dot beside "Relaymote" says whether Relaymote is connected (g454): green when
// the live stream from the PC is up and Claude Desktop answers, red when Desktop's link is down, grey
// while connecting or unreachable. It was the session-state dot with no session, so it stayed grey.
// Inside a session it is that session's state (renderHeader), as before.
function connState() {
  const streamUp = !!(state.es && state.es.readyState === 1 && Date.now() - (state.esLastEvent || 0) < 50000);
  if (!streamUp) return 'off';
  return state.boot && state.boot.cdp === false ? 'down' : 'ok';
}
function paintConnDot() {
  if (state.open) return;
  const c = connState();
  const el = $('chat-state');
  el.className = 'dot ' + (c === 'ok' ? 'linked' : c === 'down' ? 'err' : '');
  el.parentElement.title = c === 'ok' ? 'Connected to your PC' : c === 'down' ? 'Connected, but Claude Desktop is not answering' : 'Connecting…';
}

function noteLinkState(d) {
  if (!d || typeof d.cdp !== 'boolean' || !state.boot) return;
  const was = state.boot.cdp;
  state.boot.cdp = d.cdp;
  paintConnDot();
  state.snapshotAt = d.snapshotAt || null;
  renderBlocker(d.blocker);
  renderStats();
  if (was === false && d.cdp === true) {
    toast('Desktop link is back — refreshing');
    if (state.open) reloadOpenChat(true);
    checkOutbox();
  }
}

function renderBlocker(b) {
  const el = $('blocker');
  if (!el) return;
  const key = b && b.text ? b.text.slice(0, 80) : '';
  if (!key || state.blockerDismissed === key) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  const btns = (b.buttons || []).filter(Boolean);
  el.classList.remove('hidden');
  el.innerHTML = '<div class="bk-head">Sends are blocked — answer this on the PC</div>'
    + '<div class="bk-text">' + esc(b.text.slice(0, 300)) + '</div>'
    + (btns.length ? '<div class="bk-text" style="margin-top:4px">Buttons: ' + esc(btns.join(' / ')) + '</div>' : '')
    + '<div class="bk-acts"><button class="linkish" id="bk-hide">Dismiss</button></div>';
  const h = $('bk-hide');
  if (h) h.onclick = () => { state.blockerDismissed = key; el.classList.add('hidden'); el.innerHTML = ''; };
}

function renderStats() {
  const c = state.boot && state.boot.counts;
  if (!c) return;
  $('stats').innerHTML =
    `<span class="muted">${c.active} active</span>` +
    (c.running ? `<span style="color:var(--run)">${c.running} running</span>` : '') +
    (c.awaiting ? `<span style="color:var(--wait)">${c.awaiting} waiting</span>` : '') +
    (state.boot.cdp ? '' : '<span style="color:var(--err)">desktop link down</span>') +
    (!state.boot.cdp && state.snapshotAt
      ? `<span class="muted">status frozen ${ageText(state.snapshotAt) || ''}</span>` : '');
}

function renderSuggestion(meta) {
  const el = $('suggestion');
  state._suggLive = isLive();
  // Like the desktop: a suggestion is offered only when the session is idle and its turn has ended
  // (29-Sep: the button and its text showed while the session was still working).
  if (state.question || state._suggLive) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  const s = state.liveSuggestion || (meta && meta.suggestion);
  el.classList.remove('hidden');
  el.innerHTML = s
    ? `<button class="sugg"><span>Suggested</span>${esc(s)}</button>` +
      '<button class="sugg-again" title="Read it again" aria-label="Read the suggestion again">↻</button>'
    : '<button class="sugg fetch"><span>Suggested</span>tap to read the current one</button>';

  const fetchLive = async (btn, busyText) => {
    const before = btn.innerHTML;
    btn.disabled = true;
    if (busyText) btn.textContent = busyText;
    try { await api('/api/suggestion?id=' + encodeURIComponent(state.open) + '&fresh=1'); }
    catch (err) {
      toast('Could not read it: ' + err.message, true);
      btn.disabled = false; btn.innerHTML = before;
    }
  };

  el.querySelector('.sugg').onclick = (e) => {
    if (!s) return fetchLive(e.currentTarget, 'reading the desktop…');
    const cur = $('input').value;
    if (cur.trim() && cur.trim() !== String(s).trim()) {
      saveDraft(state.open, cur);
      return toast('Your message is still in the box — clear it first to use the suggestion.', true);
    }
    $('input').value = s;
    saveDraft(state.open, s);
    autosize();
    $('input').focus();
    el.classList.add('hidden');
  };
  const again = el.querySelector('.sugg-again');
  if (again) again.onclick = (e) => fetchLive(e.currentTarget, '…');
}

function renderHeader(meta) {
  const wasWaiting = state.meta && /awaiting/i.test(String(state.meta.dot || ''));
  state.meta = meta;
  const nowWaiting = /awaiting/i.test(String((meta || {}).dot || ''));
  if (nowWaiting && !wasWaiting) checkPermission(meta);
  if (!nowWaiting) renderPermission(null);
  renderSuggestion(meta);
  $('chat-title').textContent = meta.title;
  $('chat-state').className = 'dot ' + (nowWaiting ? 'awaiting'
    : /running/i.test(String(meta.dot || '')) ? 'running' : '');
  const bits = [];
  if (meta.dot) bits.push(meta.dot);
  if (meta.model) bits.push(shortModel(meta.model));
  if (meta.effort) bits.push(meta.effort);
  if (meta.folder) bits.push(meta.folder);
  $('chat-sub').textContent = bits.join(' · ');
}

// Where a cold open lands (g454, replacing "the Board first"). Closed and reopened within RESUME_MS:
// exactly where you were (that session, the Board, or the session list). Otherwise, or when that
// session is gone or archived: the session open on the PC right now (Claude Desktop's own selection,
// the `active` flag on the list), else the most recently active one, else the session list. The
// place is saved whenever the app is hidden or closed, and when a session opens. Anything you opened
// while the app loaded wins.
const RESUME_MS = 30 * 60000;
const PLACE_KEY = 'baton.lastPlace';
function currentPlace() {
  if (visibleSheetId() === 'view-board') return { kind: 'board' };
  if (state.open) return { kind: 'chat', id: state.open };
  return { kind: 'list' };
}
function savePlace() {
  try { localStorage.setItem(PLACE_KEY, JSON.stringify({ ...currentPlace(), at: Date.now() })); } catch {}
}
/** The rule itself, pure: place = what savePlace() stored (or null), list = the session rows. */
function pickFirstScreen(place, list, { now = Date.now(), board = true } = {}) {
  const live = (list || []).filter(s => s && !s.archived);
  if (place && typeof place.at === 'number' && now - place.at <= RESUME_MS) {
    if (place.kind === 'board' && board) return { kind: 'board', why: 'resume' };
    if (place.kind === 'list') return { kind: 'list', why: 'resume' };
    if (place.kind === 'chat' && live.some(s => s.id === place.id)) return { kind: 'chat', id: place.id, why: 'resume' };
  }
  const pc = live.find(s => s.active);
  if (pc) return { kind: 'chat', id: pc.id, why: 'pc' };
  const newest = live.slice().sort((a, b) => (b.at || 0) - (a.at || 0))[0];
  if (newest) return { kind: 'chat', id: newest.id, why: 'recent' };
  return { kind: 'list', why: 'empty' };
}
async function firstScreen(touched0 = navTouched) {
  const untouched = () => !state.open && !visibleSheetId() && !$('drawer').classList.contains('open') && navTouched === touched0;
  if (!untouched()) return 'user';
  let place = null;
  try { place = JSON.parse(localStorage.getItem(PLACE_KEY) || 'null'); } catch {}
  const p = pickFirstScreen(place, state.rawSessions || state.sessions || [], { board: typeof window.openBoard === 'function' });
  if (p.kind === 'board') window.openBoard();
  else if (p.kind === 'chat') openChat(p.id);
  else drawer(true);
  return p.kind + ':' + p.why;
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') savePlace(); });
window.addEventListener('pagehide', savePlace);

async function openChat(id) {
  if (!navQuiet && id !== state.open) navRecord();
  if (state.openingId === id) return;
  state.openingId = id;
  try { return await openChatInner(id); } finally { if (state.openingId === id) state.openingId = null; }
}

async function openChatInner(id) {
  const sameSession = state.open === id;
  if (state.open && state.open !== id) saveDraft(state.open, $('input').value);
  state.open = id;
  try { localStorage.setItem(PLACE_KEY, JSON.stringify({ kind: 'chat', id, at: Date.now() })); } catch {}
  state.liveSuggestion = null;
  if (state.pending && state.pending.sid !== id) state.pending = null;
  state.attachments = []; renderAttachments();
  state.openGroups.clear();
  htmlCache.clear(); lastSig = '';
  logAtBottom = true; logNew = 0; seenMsgIds = new Set(); seenReplyTs = ''; scrollToBottomNext = true;
  $('pick-hint') && $('pick-hint').remove();
  $('log').innerHTML = '<div class="empty">Loading…</div>';

  clearTimeout(state.markReadTimer);
  const row = (state.sessions || []).find(x => x.id === id);
  // Opening a session is seeing it: its dot goes at once, here and on the server (sessions.ackDot),
  // unless a question or permission prompt is really open -- that one still needs him. The check runs
  // once the session has loaded, which is when state.question / state.permission are known.
  if (row && (row.awaiting || row.unread || row.dot === 'unread')) {
    clearTimeout(state.seenTimer);
    state.seenTimer = setTimeout(() => {
      if (state.open !== id || state.question || state.permission) return;
      for (const L of [state.sessions, state.rawSessions]) for (const r of (L || [])) if (r.id === id) { r.awaiting = false; r.unread = false; r.dot = null; r.seen = true; }
      try { renderSessions(state.rawSessions || []); } catch {}
      api('/api/seen?id=' + encodeURIComponent(id)).catch(() => {});
    }, 1500);
  }
  if (row && (row.unread || row.dot === 'unread')) {
    state.markReadTimer = setTimeout(() => {
      if (state.open !== id) return;
      if (state.pending) return;
      api('/api/mark-read?id=' + encodeURIComponent(id)).catch(() => {});
    }, 6000);
  }

  setChipBadge(0);

  {
    const cur = $('input').value;
    const draft = loadDraft(id);
    if (sameSession && cur.trim() && cur.trim() !== draft.trim()) saveDraft(id, cur);
    else $('input').value = draft;
  }
  autosize();
  updateCommandList();

  try {
    let d, lastErr;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt) await new Promise(r => setTimeout(r, 1200 * attempt));
      if (state.open !== id) return;
      try { d = await api('/api/session/' + encodeURIComponent(id) + '?limit=60', { timeoutMs: 12000 }); lastErr = null; break; }
      catch (e) { lastErr = e; if (!isNetErr(e)) break; }
    }
    if (!d) throw lastErr || new Error('no response');
    if (d.transcript && d.transcript.chips) setChipBadge(d.transcript.chips.length);
    if (state.open !== id) return;
    state.oldestByte = d.transcript.startByte;
    state.hasMore = !!d.transcript.hasMore;
    renderHeader(d.meta);
    state.qpicked = {};
    renderQuestion(d.transcript.pendingQuestion);
    renderLog(d.transcript.messages, true);
    if (!d.transcript.ok) toast(d.transcript.error || 'No transcript', true);
    connectStream(id);
    renderSessions(state.sessions);
  } catch (e) {
    toast('Open failed: ' + e.message, true);
    if (state.open === id) {
      $('log').innerHTML = '<div class="empty">Could not load this conversation (' + esc(e.message) + ').<br>' +
        '<button class="linkish" id="btn-retry-open">Tap to retry</button></div>';
      const b2 = $('btn-retry-open'); if (b2) b2.onclick = () => openChat(id);
    }
  }
}

async function reloadOpenChat(force, opts = {}) {
  const id = state.open;
  if (!id) return;
  if (state.openingId && !force) return;
  if (!force && (state.sending || state.loadingMore)) return;
  try {
    const d = await api('/api/session/' + encodeURIComponent(id) + '?limit=60', { timeoutMs: 12000 });
    if (state.open !== id) return;
    if (!d.transcript) return;
    renderHeader(d.meta);
    renderQuestion(d.transcript.pendingQuestion);
    if (d.transcript.chips) setChipBadge(d.transcript.chips.length);
    retireSpentDraft(d.transcript.messages);
    renderLog(applyTail(d.transcript.messages, d.transcript.startByte, d.transcript.hasMore), false);
    if (!state.es || state.es.readyState === 2) connectStream(id);
  } catch (e) {
    if (!(state.messages || []).length && /Loading/.test($('log').textContent || '')) openChat(id);
    if (opts.throwOnError) throw e;
  }
}

function connectStream(watch) {
  if (state.es) { state.es.close(); state.es = null; }
  const es = new EventSource('/api/stream?client=' + encodeURIComponent(CLIENT_ID) +
                             (BUILD ? '&build=' + encodeURIComponent(BUILD) : '') +
                             (watch ? '&watch=' + encodeURIComponent(watch) : ''));
  state.es = es;
  state.esWatch = watch || null;
  state.esLastEvent = Date.now();
  es.onopen = () => { state.esLastEvent = Date.now(); paintConnDot(); };
  es.addEventListener('ping', () => { state.esLastEvent = Date.now(); paintConnDot(); });
  es.addEventListener('sessions', ev => {
    state.esLastEvent = Date.now();
    const d = JSON.parse(ev.data);
    if (state.meta) {
      const row = d.sessions.find(s => s.id === state.meta.id);
      const wasRunning = !!state._tierWasRunning;
      const nowRunning = !!(row && row.running);
      if (wasRunning && !nowRunning && !$('sheet').classList.contains('hidden')) renderTier(state.meta);
      state._tierWasRunning = nowRunning;
      if (row && state.meta.running !== !!row.running) { state.meta.running = !!row.running; renderLive(); renderLog(state.messages || [], true); renderSuggestion(state.meta); }
    }
    if (!state.folder && !state.q) renderSessions(d.sessions);
    if (state.boot) {
      state.boot.counts.running = d.sessions.filter(s => s.running).length;
      state.boot.counts.awaiting = d.sessions.filter(s => s.awaiting).length;
      renderStats();
    }
  });
  es.addEventListener('messages', ev => {
    state.esLastEvent = Date.now();
    const d = JSON.parse(ev.data);
    if (d.id !== state.open) return;
    if (state.liveSuggestion) { state.liveSuggestion = null; renderSuggestion(state.meta); }
    renderLog(applyTail(d.messages, d.startByte, d.hasMore));
    if (d.meta) renderHeader(d.meta);
    if (state.meta && !$('sheet').classList.contains('hidden') && Date.now() - (state._tierReadAt || 0) > 3000) {
      state._tierReadAt = Date.now();
      renderTier(state.meta);
    }
    if (JSON.stringify(d.pendingQuestion || null) !== JSON.stringify(state.question || null)) {
      state.qpicked = {};
      renderQuestion(d.pendingQuestion);
    }
  });
  es.addEventListener('chips', ev => {
    const c = JSON.parse(ev.data);
    if (c.id !== state.open) return;
    setChipBadge((c.offered || []).length);
    if ($('chipsheet').classList.contains('hidden')) return;
    renderChips(c.liveTasks || [], c.offered || [], c.uiRunning, !!c.partial);
  });

  es.addEventListener('suggestion', ev => {
    const d = JSON.parse(ev.data);
    if (d.id !== state.open) return;
    state.liveSuggestion = d.suggestion || null;
    if (!d.suggestion) toast(d.error ? 'Could not read it (' + d.error + ')' : 'No suggestion right now');
    renderSuggestion(state.meta);
  });

  es.addEventListener('uiresult', ev => {
    const r = JSON.parse(ev.data);
    if (r.op === 'permission') {
      if (r.id === state.open) renderPermission(r.permission || null);
      return;
    }
    if (r.op === 'permission-answer' && r.ok) {
      renderPermission(null);
      for (const list of [state.rawSessions, state.sessions]) {
        const row = (list || []).find(x => x.id === r.id);
        if (row) { row.awaiting = false; row.dot = 'Running'; }
      }
      renderSessions(state.rawSessions || []);
      setTimeout(() => loadSessions(), 8000);
      return;
    }
    if (r.op === 'usage') {
      paintUsage(r.usage || null, !!(r.usage && r.usage.forSession && r.usage.forSession === state.open));
      return;
    }
    const job = uiJobs.get(r.jobId);
    uiJobs.delete(r.jobId);
    const label = (job && job.label) || r.op;
    const done = job && (typeof job.done === 'function' ? job.done(r) : job.done);
    if (r.ok) { toast(done || (label + ' done')); if (job && job.after) job.after(r); }
    else {
      if (job && job.onFail && job.onFail(r)) { if (job.revert) job.revert(); return; }
      toast(label + ' failed: ' + (r.error || 'unknown'), true);
      if (job && job.revert) job.revert();
    }
  });

  es.addEventListener('sendresult', ev => {
    const r = JSON.parse(ev.data);
    if (state.pending && state.pending.jobId && r.jobId !== state.pending.jobId) return;
    if (r.ok) {
      if (state.pending) {
        state.pending.status = r.confirmed ? 'sent' : 'queued';
        state.pending.held = !!r.held;
        state.pending.outboxId = r.outboxId || null;
      }
      if (r.delivery === 'queued') sendNowBlocked.delete(r.id || state.open);
      if (r.confirmed) clearDraft(r.id || state.open);
      else {
        if (r.text) saveDraft(r.id || state.open, r.text);
        checkOutbox();
      }
      renderLog(state.messages, true);
      return;
    }
    state.pending = null;
    if (r.text) {
      saveDraft(r.id || state.open, r.text);
      if (!$('input').value) { $('input').value = r.text; autosize(); }
    }
    renderLog(state.messages, true);
    toast(sendError(r.error), true);

    if (String(r.error || '').includes('blocked-by-dialog')) {
      state.resendAfterAnswer = { id: r.id || state.open, text: r.text || $('input').value || '' };
      checkPermission({ id: r.id || state.open }, true);
    }
  });

  es.addEventListener('alert', ev => {
    const a = JSON.parse(ev.data);
    banner(a);
    if (state.boot) loadSessions();
  });

  es.addEventListener('accountswitch', () => { renderAccountSwitch(); });
  es.addEventListener('outbox', ev => {
    state.esLastEvent = Date.now();
    const d = JSON.parse(ev.data);
    const ids = new Set((d.confirmed || []).map(e => e.id));
    if (!ids.size) return;
    state.outbox = (state.outbox || []).filter(x => !ids.has(x.id));
    if (state.pending && ids.has(state.pending.outboxId)) state.pending = null;
    if (state.open && (d.confirmed || []).some(e => e.session === state.open)) { renderLog(state.messages, false); reloadOpenChat(true); }
    checkOutbox();
  });
  es.onerror = () => { paintConnDot(); };
}

async function openFile(p, sentUrl) {
  showSheet($('fileview'));
  $('file-name').textContent = p.split(/[\\/]/).pop() || p;
  $('file-path').textContent = p;
  $('file-body').innerHTML = '<div class="empty">Opening\u2026</div>';
  let d;
  try {
    if (sentUrl) {
      // A sent file lives outside every cwd, so /api/file refuses it; /api/sent-file serves it (its
      // first 2 MB) and the text branch below renders it exactly as it renders any other file.
      const r = await fetch(sentUrl, { credentials: 'include', headers: { Range: 'bytes=0-2097151' } });
      if (!r.ok) { let m = 'HTTP ' + r.status; try { m = (await r.json()).message || m; } catch {} throw new Error(m); }
      d = { ok: true, kind: 'text', path: p, text: await r.text(), truncated: (() => { const m = /\/(\d+)$/.exec(r.headers.get('Content-Range') || ''); return !!m && +m[1] > 2097152; })() };
    } else
    d = await api('/api/file?path=' + encodeURIComponent(p) +
                  (state.open ? '&session=' + encodeURIComponent(state.open) : ''));
  } catch (e) {
    $('file-body').innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    return;
  }
  $('file-path').textContent = d.path || p;
  if (d.kind === 'image') {
    const src = /^data:image\/[a-z+.-]+;base64,[A-Za-z0-9+\/=]+$/i.test(d.dataUrl || '') ? d.dataUrl : '';
    $('file-body').innerHTML = src
      ? `<img class="fileimg" src="${src}" alt="${esc(d.path)}">`
      : '<div class="empty">That image could not be displayed.</div>';
  } else if (d.kind === 'dir') {
    $('file-body').innerHTML = (d.entries || []).map(e =>
      `<button class="direntry" data-p="${esc((d.path + '/' + e.name))}">` +
      `${e.dir ? '\u{1F4C1}' : '\u{1F4C4}'} ${esc(e.name)}</button>`).join('') ||
      '<div class="empty">Empty folder.</div>';
  } else if (d.kind === 'text') {
    const isMd = /\.(md|markdown)$/i.test(d.path || '');
    $('file-body').innerHTML =
      (d.truncated ? `<div class="empty">Showing the ${sentUrl ? 'first' : 'last'} 2 MB.</div>` : '') +
      (isMd ? `<div class="mdbody">${md(d.text, true)}</div>`
            : `<pre class="code">${esc(d.text)}</pre>`);
  } else {
    $('file-body').innerHTML = `<div class="empty">${esc(d.message || d.error || 'Cannot show this file.')}</div>`;
  }
}

$('fileview').addEventListener('click', (e) => {
  const dir = e.target.closest('.direntry');
  if (dir) { openFile(dir.dataset.p); return; }
  if (e.target === $('fileview')) hideSheet($('fileview'));
});

$('log').addEventListener('click', (e) => {
  const sys = e.target.closest('.msg.system');
  if (sys) sys.classList.toggle('open');
});

$('log').addEventListener('click', (e) => {
  const sentA = e.target.closest('a[data-sent]');
  if (sentA) { e.preventDefault(); e.stopPropagation(); openFile(sentA.dataset.p, sentA.dataset.sent); return; }
  const a = e.target.closest('.fileref');
  if (!a) return;
  e.preventDefault();
  e.stopPropagation();
  openFile(a.dataset.p);
});

let sendNowBusy = false;
$('log').addEventListener('click', async (e) => {
  const b = e.target.closest('.sendnow');
  if (!b) return;
  e.preventDefault();
  e.stopPropagation();
  const id = state.open;
  if (!id) return;
  if (sendNowBusy) return;
  sendNowBusy = true;
  b.disabled = true;
  b.textContent = 'sending…';
  const revert = () => { sendNowBusy = false; b.disabled = false; b.textContent = 'send now'; };
  try {
    const d = await api('/api/send-now?id=' + encodeURIComponent(id), { method: 'POST' });
    if (!d || !d.jobId) { revert(); toast('Send now was not accepted by the server.', true); return; }
    uiJobs.set(d.jobId, {
      label: 'Send now',
      done: 'Sent into the running turn',
      after: () => { sendNowBusy = false; reloadOpenChat(true); checkOutbox(); },
      onFail: (r) => {
        sendNowBusy = false;
        const why = (r && r.sendNow && r.sendNow.message) || '';
        const verdict = (r && r.result) || '';
        if (verdict === 'held-no-control') {
          if (id) sendNowBlocked.set(id, 'held');
          toast(why || 'The desktop is still holding that message; it will go when the turn ends.');
          renderLog(state.messages, true);
          reloadOpenChat(true); checkOutbox();
          return true;
        }
        if (verdict === 'no-queued-message' || verdict === 'no-send-control') {
          if (id) sendNowBlocked.set(id, 'gone');
          if (state.pending && state.pending.sid === id) state.pending = null;
          toast(why || 'That message has already gone through.');
          renderLog(state.messages, true);
          reloadOpenChat(true); checkOutbox();
          return true;
        }
        toast(why || ('Send now failed: ' + ((r && r.error) || 'unknown')), true);
        reloadOpenChat(true);
        return true;
      },
      revert,
    });
    toast('Sending it now…');
  } catch (err) {
    revert();
    toast('Send now failed: ' + err.message, true);
  }
});

function banner(a) {
  const el = document.createElement('div');
  el.className = 'banner ' + (a.kind === 'awaiting' ? 'wait' : 'done');
  el.innerHTML = `<button class="x" type="button" aria-label="Dismiss">&times;</button>` +
                 `<b>${esc(a.title)}</b><span>${esc(a.body)}</span>`;
  let gone = false;
  const close = () => { if (gone) return; gone = true; el.classList.add('away'); setTimeout(() => el.remove(), 200); };
  el.querySelector('.x').onclick = (e) => { e.stopPropagation(); close(); };
  el.onclick = () => { close(); openChat(a.id); drawer(false); };

  let x0 = null, dx = 0;
  el.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; dx = 0; }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    if (x0 === null) return;
    dx = e.touches[0].clientX - x0;
    el.style.transform = 'translateX(' + dx + 'px)';
    el.style.opacity = String(Math.max(0, 1 - Math.abs(dx) / 220));
  }, { passive: true });
  el.addEventListener('touchend', () => {
    if (x0 === null) return;
    if (Math.abs(dx) > 70) { close(); }
    else { el.style.transform = ''; el.style.opacity = ''; }
    x0 = null;
  });

  document.body.appendChild(el);
  setTimeout(close, 9000);
  // A burst of "Finished" buzzes once a minute at most (g770); "Needs your input" always buzzes.
  const quiet = a.kind !== 'awaiting' && Date.now() - lastDoneBuzz < 60000;
  if (a.kind !== 'awaiting' && !quiet) lastDoneBuzz = Date.now();
  if (navigator.vibrate && !quiet) { try { navigator.vibrate(a.kind === 'awaiting' ? [80, 60, 80] : 60); } catch {} }
}
let lastDoneBuzz = 0;

function renderPermission(perm) {
  const box = $('permission');
  if (!box) return;
  state.permission = perm && perm.present ? perm : null;
  if (!state.permission) { box.classList.add('hidden'); box.innerHTML = ''; return; }

  let req = String(perm.request || 'This session is waiting for permission.');
  for (const o of perm.options || []) if (o.raw) req = req.split(o.raw).join('');

  req = req.trim();
  const qm = req.indexOf('?');
  const head = qm > 0 && qm < 160 ? req.slice(0, qm + 1) : '';
  const body = head ? req.slice(qm + 1).trim() : req;

  box.classList.remove('hidden');
  box.innerHTML =
    '<div class="permhdr">Permission needed</div>' +
    (head ? `<div class="permask">${esc(head)}</div>` : '') +
    `<div class="permreq">${esc(body.slice(0, 400))}</div>` +
    '<div class="permacts">' +
    (perm.options || []).map(o =>
      `<button class="permbtn ${o.kind}" data-kind="${esc(o.kind)}" data-raw="${esc(o.raw || o.label)}">${esc(o.label)}</button>`).join('') +
    '</div>';

  box.querySelectorAll('.permbtn').forEach(b => {
    b.onclick = async () => {
      box.querySelectorAll('.permbtn').forEach(x => { x.disabled = true; });
      b.textContent = 'sending…';
      try {
        const d = await api('/api/permission/answer', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: state.open, kind: b.dataset.kind, raw: b.dataset.raw }),
        });
        if (d && d.jobId) uiJobs.set(d.jobId, {
          label: b.dataset.kind === 'deny' ? 'Deny' : 'Allow',
          done: b.dataset.kind === 'deny' ? 'Denied' : 'Allowed',
          after: () => { renderPermission(null); resumeHeldSend(); },
          revert: () => renderPermission(perm),
        });
      } catch (e) { toast('Failed: ' + e.message, true); renderPermission(perm); }
    };
  });
}

async function checkOutbox() {
  let d;
  try { d = await api('/api/outbox'); } catch { return; }
  const list = (d && d.pending) || [];
  state.outbox = list;
  const el = $('outbox');
  if (!el) return;
  if (state.open) renderLog(state.messages, false);
  const worry = list.filter(e => e.suspect || e.state === 'failed');
  if (!worry.length) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  el.innerHTML = worry.map(e => `
    <div class="obrow" data-id="${esc(e.id)}">
      <div class="obtext">${esc(e.text.slice(0, 160))}${e.text.length > 160 ? '…' : ''}</div>
      <div class="obmeta">delivered, waiting for a reply · ${Math.round(e.ageMs / 60000)}m</div>
      <div class="obacts">
        <button class="linkish ob-resend">Send again</button>
        <button class="linkish ob-drop">Discard</button>
      </div>
    </div>`).join('');
  el.querySelectorAll('.ob-resend').forEach(b => {
    b.onclick = () => {
      const id = b.closest('.obrow').dataset.id;
      const e = (state.outbox || []).find(x => x.id === id);
      if (!e) return;
      b.disabled = true;
      alreadyLanded(id).then((landed) => {
      if (landed) {
        toast('Already delivered — not sent again');
        state.outbox = (state.outbox || []).filter(x => x.id !== id);
        const row0 = b.closest('.obrow'); if (row0) row0.remove();
        api('/api/outbox/drop?id=' + encodeURIComponent(id)).catch(() => {});
        checkOutbox();
        return;
      }
      state.outbox = (state.outbox || []).filter(x => x.id !== id);
      const rowEl = b.closest('.obrow');
      if (rowEl) rowEl.remove();
      if (!(state.outbox || []).length) { const box = $('outbox'); if (box) { box.hidden = true; box.innerHTML = ''; } }
      api('/api/outbox/drop?id=' + encodeURIComponent(id)).catch(() => {});
      send({ id: e.session, text: e.text });
      setTimeout(checkOutbox, 6000);
      });
    };
  });
  el.querySelectorAll('.ob-drop').forEach(b => {
    b.onclick = async () => {
      const id = b.closest('.obrow').dataset.id;
      await api('/api/outbox/drop?id=' + encodeURIComponent(id)).catch(() => {});
      checkOutbox();
    };
  });
}

function resumeHeldSend() {
  const held = state.resendAfterAnswer;
  state.resendAfterAnswer = null;
  if (!held || !held.text) return;
  if (state.open !== held.id) return;
  $('input').value = held.text;
  autosize();
  toast('Prompt answered — sending your message…');
  setTimeout(() => send(), 900);
}

function checkPermission(meta, force) {
  const waiting = meta && /awaiting/i.test(String(meta.dot || ''));
  if ((!waiting && !force) || state.question) { renderPermission(null); return; }
  if (state.pending && !force) return;
  api('/api/permission?id=' + encodeURIComponent(state.open)).catch(() => {});
}

function renderQuestion(pq) {
  const box = $('question');
  state.question = pq || null;
  if (!pq || !pq.questions || !pq.questions.length) {
    box.classList.add('hidden'); box.innerHTML = ''; box.dataset.sig = ''; return;
  }
  state.qpicked = state.qpicked || {};
  box.classList.remove('hidden');

  const sig = JSON.stringify(pq);
  if (box.dataset.sig === sig && box.querySelector('.qother')) {
    box.querySelectorAll('.qopt').forEach(b => {
      b.classList.toggle('on', (state.qpicked[+b.dataset.q] || []).includes(+b.dataset.o));
    });
    box.querySelectorAll('.qother').forEach(inp => {
      const v = (state.qother || {})[+inp.dataset.q] || '';
      if (inp !== document.activeElement && inp.value !== v) inp.value = v;
    });
    return;
  }
  box.dataset.sig = sig;
  box.innerHTML = pq.questions.map((q, qi) => {
    const opts = (q.options || []).map((o, oi) => {
      const on = (state.qpicked[qi] || []).includes(oi);
      return `<button class="qopt${on ? ' on' : ''}" data-q="${qi}" data-o="${oi}">` +
             `<b>${esc(o.label)}</b>${o.description ? `<span>${esc(o.description)}</span>` : ''}</button>`;
    }).join('');
    return `<div class="qhead">${esc(q.header || 'Question')}${q.multiSelect ? ' · choose any' : ''}</div>` +
           `<div class="qtext">${esc(q.question)}</div>${opts}` +
           `<input class="qother" data-q="${qi}" placeholder="Other — type your own answer" ` +
           `value="${esc((state.qother || {})[qi] || '')}">`;
  }).join('') + '<button class="qsend" id="q-send">Send answer</button>';
}

$('question').addEventListener('click', async (e) => {
  const opt = e.target.closest('.qopt');
  if (opt) {
    const qi = +opt.dataset.q, oi = +opt.dataset.o;
    const q = state.question.questions[qi];
    const cur = state.qpicked[qi] || [];
    if (q.multiSelect) state.qpicked[qi] = cur.includes(oi) ? cur.filter(x => x !== oi) : cur.concat(oi);
    else state.qpicked[qi] = cur.includes(oi) ? [] : [oi];
    renderQuestion(state.question);
    return;
  }
  if (!e.target.closest('#q-send')) return;

  const answers = state.question.questions.map((q, qi) => ({
    labels: (state.qpicked[qi] || []).map(oi => q.options[oi].label),
    other: ((state.qother || {})[qi] || '').trim(),
  }));
  if (!answers.some(a => a.labels.length || a.other)) {
    return toast('Pick an option or type an answer', true);
  }
  if (answers.some(a => !a.labels.length && !a.other)) {
    return toast('Answer every question — the widget asks them one at a time', true);
  }

  const btn = document.getElementById('q-send');
  btn.disabled = true; btn.textContent = 'Answering…';
  const restore = () => { btn.disabled = false; btn.textContent = 'Send answer'; };
  try {
    const d = await api('/api/answer', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: state.open, answers }),
    });
    uiJobs.set(d.jobId, {
      label: 'Answer', done: 'Answered',
      revert: restore,
      after: () => { state.qpicked = {}; state.qother = {}; renderQuestion(null); restore(); },
    });
    btn.textContent = 'Answering…';
  } catch (e) {
    toast('Could not answer from here: ' + e.message + ' — answer it in the desktop app.', true);
    restore();
  }
});

$('question').addEventListener('input', (e) => {
  const box = e.target.closest('.qother');
  if (!box) return;
  state.qother = state.qother || {};
  state.qother[+box.dataset.q] = box.value;
});

const MODEL_HAS_EFFORT = (m) => !/^haiku/i.test(String(m || ''));

function renderNewSegs() {
  seg($('new-model'), state.boot.models, state.newModel, async (v) => { state.newModel = v; renderNewSegs(); });
  const canEffort = MODEL_HAS_EFFORT(modelFamily(state.newModel));
  seg($('new-effort'), state.boot.efforts, canEffort ? state.newEffort : null,
      async (v) => { state.newEffort = v; renderNewSegs(); });
  const box = $('new-effort');
  [...box.children].forEach(c => { c.disabled = !canEffort; });
  let note = document.getElementById('new-effort-note');
  if (!note) {
    note = document.createElement('div');
    note.id = 'new-effort-note';
    note.className = 'seg-note';
    box.insertAdjacentElement('afterend', note);
  }
  note.textContent = canEffort ? '' : 'Haiku does not offer an effort setting.';
  note.style.display = canEffort ? 'none' : '';
}

function renderFolderList() {
  const f = ($('new-filter').value || '').toLowerCase();
  const list = (state.folderList || []).filter(x =>
    !f || x.name.toLowerCase().includes(f) || (x.cwd || '').toLowerCase().includes(f));
  $('new-folders').innerHTML = list.map(x =>
    `<div class="fold${state.newFolder === x.cwd ? ' on' : ''}" data-cwd="${esc(x.cwd)}">` +
    `<span>${esc(x.name)}</span>` +
    (x.ambiguous ? '<span class="warn">dup name</span>' : '') +
    `<span class="p">${esc(x.cwd)}</span><span class="n">${x.count}</span></div>`).join('')
    || '<div class="empty">No folders match.</div>';
}

async function openNew() {
  showSheet($('newsheet'));
  $('new-folders').innerHTML = '<div class="empty">Loading folders…</div>';
  $('new-prompt').value = '';
  $('new-filter').value = '';
  state.newFolder = null;
  const sd = (state.boot && state.boot.startDefaults) || null;
  const bootModels = (state.boot && state.boot.models) || [];
  state.newModel = (sd && bootModels.find(x => x === sd.model)) || pickByFamily(bootModels, (sd && sd.model) || 'opus') || 'opus';
  state.newEffort = (sd && sd.effort) || 'medium';
  renderNewSegs();
  try {
    state.folderList = (await api('/api/folders')).folders;
    renderFolderList();
  } catch (e) { $('new-folders').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}

async function openChips() {
  if (!state.open) return toast('Pick a session first', true);
  showSheet($('chipsheet'));
  $('chip-sub').innerHTML = '<span class="muted">reading the session…</span>';
  $('chiplist').innerHTML = '<div class="empty">Reading background tasks…</div>';
  try {
    const d = await api('/api/chips?id=' + encodeURIComponent(state.open) + '&offered=1');
    if (d.fromTranscript && d.fromTranscript.length) {
      renderChips(d.running || [], d.fromTranscript.map(c => ({ title: c.title, tldr: 'suggested task' })), null, true);
    }
    renderChips(d.liveTasks || [], d.offered || [], d.uiRunning, true);
  } catch (e) {
    $('chiplist').innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

function setChipBadge(n) {
  const b = $('btn-chips');
  if (!b) return;
  b.classList.toggle('has-chips', n > 0);
  b.setAttribute('data-count', n > 0 ? String(n) : '');
}

function renderChips(running, chips, uiRunning, pending) {
  const sd = (state.boot && state.boot.startDefaults) || null;
  $('chip-sub').innerHTML =
    `<span style="color:var(--run)">${uiRunning != null ? uiRunning : running.length} running</span>` +
    `<span class="muted">${chips.length} offered</span>` +
    (pending ? '<span class="muted">checking…</span>' : '') +
    (sd && sd.model ? `<span class="muted">starts on ${esc(shortModel(sd.model))} · ${esc(sd.effort || 'medium')}</span>` : '');

  const ul = $('chiplist');
  ul.innerHTML = '';

  running.forEach((t, i) => {
    const li = document.createElement('li');
    li.className = 'row';
    li.innerHTML = '<span class="dot running"></span><div class="row-main">' +
      `<div class="row-title">${esc(t.label || t.description || 'task')}</div>` +
      `<div class="row-meta"><span>${esc(t.name || 'background')}</span><span>running</span></div></div>`;
    const stop = document.createElement('button');
    stop.className = 'ghost danger';
    stop.style.cssText = 'flex:0 0 auto;width:auto;padding:8px 14px';
    stop.textContent = 'Stop';
    stop.onclick = async () => {
      stop.disabled = true; stop.textContent = '…';
      const revert = () => { stop.disabled = false; stop.textContent = 'Stop'; };
      try {
        const d = await api('/api/task/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: state.open, index: t.index != null ? t.index : i }) });
        if (d && d.jobId) { uiJobs.set(d.jobId, { label: 'Stop', revert, after: openChips }); toast('Stopping…'); }
        else { toast('Task stopped'); openChips(); }
      } catch (e) { toast('Stop failed: ' + e.message, true); revert(); }
    };
    li.appendChild(stop);
    ul.appendChild(li);
  });

  chips.forEach((c, i) => {
    const li = document.createElement('li');
    li.className = 'row';
    li.innerHTML = `<div class="row-main"><div class="row-title">${esc(c.title || c.text || 'task ' + (i + 1))}</div>` +
                   `<div class="row-meta"><span>${esc(c.tldr || c.subtitle || '')}</span></div></div>`;
    const go = document.createElement('button');
    go.className = 'ghost primary';
    go.style.cssText = 'flex:0 0 auto;width:auto;padding:8px 14px';
    go.textContent = 'Start';
    go.onclick = async () => {
      go.disabled = true; go.textContent = '…';
      const revert = () => { go.disabled = false; go.textContent = 'Start'; };
      try {
        const d = await api('/api/chip/start', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: state.open, title: c.title, index: i, mode: 'local' }) });
        if (d && d.jobId) { uiJobs.set(d.jobId, { label: 'Start', revert, after: openChips }); toast('Starting…'); }
        else { toast('Task started'); openChips(); }
      } catch (e) { toast('Start failed: ' + e.message, true); revert(); }
    };
    li.appendChild(go);
    ul.appendChild(li);
  });

  if (!running.length && !chips.length) {
    ul.innerHTML = pending
      ? '<div class="empty">Checking the session…</div>'
      : '<div class="empty">Nothing running or offered here.</div>';
  }
}

function renderAttachments() {
  const wrap = $('attachments');
  wrap.innerHTML = '';
  const uploads = state.uploads || [];
  wrap.classList.toggle('hidden', !state.attachments.length && !uploads.length);
  uploads.forEach(u => {
    const el = document.createElement('span');
    el.className = 'att uploading' + (u.failed ? ' failed' : '');
    const pct = u.total ? Math.round((u.loaded / u.total) * 100) : 0;
    el.innerHTML = (u.failed ? '' : '<span class="upspin"></span> ') + esc(u.name) +
      ' <b>' + (u.failed ? 'failed — tap to retry' : pct + '%') + '</b>' +
      (u.failed ? ' <button aria-label="Remove">×</button>' : '');
    if (u.failed) {
      el.onclick = (e) => { if (e.target.tagName === 'BUTTON') return; uploadOne(u.file, u); };
      el.querySelector('button').onclick = () => { const i = state.uploads.indexOf(u); if (i >= 0) state.uploads.splice(i, 1); renderAttachments(); };
    }
    wrap.appendChild(el);
  });
  state.attachments.forEach((a, i) => {
    const el = document.createElement('span');
    el.className = 'att';
    el.innerHTML = `📎 ${esc(a.name)} <button aria-label="Remove">×</button>`;
    el.querySelector('button').onclick = () => { state.attachments.splice(i, 1); renderAttachments(); };
    wrap.appendChild(el);
  });
}

function uploadOne(f, rec) {
  if (!rec) { rec = { name: f.name, file: f, loaded: 0, total: f.size || 0, failed: false, attempt: 0 }; state.uploads.push(rec); }
  rec.failed = false; rec.attempt = (rec.attempt || 0) + 1;
  renderAttachments();
  const done = () => {
    const i = state.uploads.indexOf(rec);
    if (i >= 0) state.uploads.splice(i, 1);
    renderAttachments();
  };
  const fail = () => {
    if (rec.attempt < 3) { setTimeout(() => uploadOne(f, rec), 1200 * rec.attempt); return; }
    rec.failed = true; rec.loaded = 0; renderAttachments();
    toast('Upload failed: ' + f.name + ' — tap it to retry', true);
  };
  return new Promise((resolveOuter) => {
    if (!rec.resolve) rec.resolve = resolveOuter; else resolveOuter(undefined);
    const resolve = (v) => { if (v === false && rec.attempt < 3 && !rec.failed) return; rec.resolve(v); };
    const x = new XMLHttpRequest();
    x.timeout = 60000;
    x.open('POST', '/api/upload');
    x.setRequestHeader('X-Filename', f.name);
    x.setRequestHeader('Content-Type', 'application/octet-stream');
    x.withCredentials = true;
    x.upload.onprogress = (e) => {
      rec.loaded = e.loaded; rec.total = e.total || rec.total;
      renderAttachments();
    };
    x.onload = () => {
      let d = null;
      try { d = JSON.parse(x.responseText); } catch {}
      if (x.status >= 200 && x.status < 300 && d && d.path) {
        state.attachments.push({ name: f.name, path: d.path });
        done();
        resolve(true);
      } else { fail(); resolve(false); }
    };
    x.onerror = () => { fail(); resolve(false); };
    x.ontimeout = () => { fail(); resolve(false); };
    x.send(f);
  });
}

async function uploadFiles(files) {
  const jobs = [];
  for (const f of files) {
    if (f.size > 25 * 1024 * 1024) { toast(`${f.name} is over 25 MB`, true); continue; }
    jobs.push(uploadOne(f));
  }
  return Promise.all(jobs);
}

async function send(target) {
  if (state.sending) return;
  if (target && target.id && target.id !== state.open) {
    if (target.text) { $('input').value = target.text; autosize(); }
    return sendTo(target.id, target.text || $('input').value.trim(), []);
  }
  if (!state.open) return toast('Pick a session first', true);
  if (state.question && !state.sentDismissWarning) {
    state.sentDismissWarning = true;
    return toast('A question is open — sending a message will DISMISS it. Tap send again if that is what you want.', true);
  }
  state.sentDismissWarning = false;
  const text = $('input').value.trim();

  const failedUps = state.uploads.filter(u => u.failed);
  if (failedUps.length) {
    return toast(failedUps.length + ' upload' + (failedUps.length > 1 ? 's' : '') + ' failed — tap to retry, or × to send without.', true);
  }
  if (state.uploads.length) {
    $('btn-send').disabled = true;
    toast('Waiting for ' + state.uploads.length + ' upload' + (state.uploads.length > 1 ? 's' : '') + '…');
    const deadline = Date.now() + 120000;
    while (state.uploads.length && Date.now() < deadline) await new Promise(r => setTimeout(r, 200));
    $('btn-send').disabled = false;
    if (state.uploads.length) return toast('Uploads did not finish — nothing was sent.', true);
  }

  const atts = state.attachments.filter(a => !a.native).map(a => a.path);
  if (!text && !atts.length) return;

  const id = state.open;
  state.sending = true;
  $('btn-send').disabled = true;
  $('input').value = ''; autosize();
  saveDraft(id, text);
  state.attachments = []; renderAttachments();
  state.liveSuggestion = null;
  renderSuggestion(state.meta);
  state.pending = { sid: id, text, atts, status: 'sending', at: Date.now() };
  renderLog(state.messages, true);

  try {
    const r = await api('/api/send', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, text, attachments: atts }),
    });
    if (state.pending) {
      if (r && r.jobId) state.pending.jobId = r.jobId;
      state.pending.status = 'sent';
    }
    renderLog(state.messages, true);
  } catch (e) {
    state.pending = null;
    if (!$('input').value) { $('input').value = text; autosize(); }
    state.attachments = atts.map(p => ({ name: p.split(/[\\/]/).pop(), path: p }));
    renderAttachments();
    renderLog(state.messages, true);
    toast(sendError(e.message), true);
  } finally { state.sending = false; $('btn-send').disabled = false; }
}

function retireSpentDraft(messages) {
  const id = state.open;
  const draft = id && loadDraft(id);
  if (!draft) return false;
  const n = (t) => String(t || '').replace(/\s+/g, ' ').trim();
  const want = n(draft).slice(0, 60);
  if (!want || !(messages || []).some(m => n(m.text).includes(want))) return false;
  clearDraft(id);
  if (n($('input').value) === n(draft)) { $('input').value = ''; autosize(); }
  return true;
}

async function sendTo(id, text, atts) {
  if (!text) return;
  saveDraft(id, text);
  try {
    const r = await api('/api/send', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, text, attachments: atts || [] }) });
    if (r && r.jobId) { state.pending = { sid: id, text, atts, status: 'sending', at: Date.now(), jobId: r.jobId }; }
    toast('Sending to ' + ((state.rawSessions || []).find(x => x.id === id) || {}).title || 'that session');
    // Sending does not move him (g780, 29-Sep: "after sending msg my screen moved"): at the bottom the
    // render follows to his bubble anyway; higher up, what he was reading stays where it is.
    if (state.open === id) { $('input').value = ''; autosize(); renderLog(state.messages, true); }
  } catch (e) { toast(sendError(e.message), true); }
}

function sendError(code) {
  const s = String(code == null || code === 'null' ? 'the desktop app did not respond' : code);
  if (s.includes('queued')) return 'A message is already queued in that session — wait for it.';
  if (s.includes('busy')) return 'Session is busy and would not accept a queued message.';
  if (s.includes('nav-lost')) return 'The app moved mid-send, so nothing was delivered. Try again.';
  if (s.includes('not-found')) return 'That session has no row in the desktop sidebar.';
  if (s.includes('no-editor')) return 'Could not reach the composer in the desktop app.';
  if (s.includes('too-long') || s.includes('MESSAGE_TOO_LONG')) return 'Message is enormous (over 2,000,000 characters) and was refused. Nothing was sent.';
  if (s.includes('blocked-by-dialog')) return 'A prompt in the desktop is covering the composer — answer it and this will send.';
  if (s.includes('covered')) return 'Something is floating over the composer in the desktop app.';
  if (s.includes('ambiguous-composer')) return 'The desktop had two panes open and the message was held back rather than risk the wrong one.';
  return 'Send failed: ' + s;
}

let sizing = false;
function autosize() {
  if (sizing) return;
  sizing = true;
  requestAnimationFrame(() => {
    sizing = false;
    const t = $('input');
    t.style.height = 'auto';
    t.style.height = Math.min(t.scrollHeight, 132) + 'px';
  });
}

function seg(container, values, current, onPick) {
  container.innerHTML = '';
  for (const v of values) {
    const b = document.createElement('button');
    b.textContent = v;
    b.className = current === v ? 'on' : '';
    b.onclick = async () => {
      [...container.children].forEach(c => { c.disabled = true; });
      try {
        await onPick(v);
        toast(v + ' set');
        setTimeout(() => { loadSessions(); reloadOpenChat(true); }, 1500);
      }
      catch (e) {
        const why = String(e.message || '');
        toast(/SESSION_RUNNING/.test(why)
          ? 'Not while the session is running — stop the turn first.'
          : 'Failed: ' + why, true);
      }
      finally { [...container.children].forEach(c => { c.disabled = false; }); }
    };
    container.appendChild(b);
  }
}

function usageBar(pct) {
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  const tone = p >= 90 ? 'hot' : p >= 70 ? 'warm' : '';
  return `<div class="ubar"><i class="${tone}" style="width:${p}%"></i></div>`;
}

function paintUsage(u, forThisSession) {
  const el = $('usage');
  if (!el) return;
  if (!u) { el.innerHTML = '<div class="empty">Could not read usage from the desktop.</div>'; return; }
  const rows = [];
  if (u.context) {
    rows.push(forThisSession
      ? `<div class="urow"><span>Context window</span><b>${esc(u.context.used)} / ${esc(u.context.total)}` +
        ` · ${u.context.pct}%</b></div>${usageBar(u.context.pct)}`
      : `<div class="urow"><span>Context window</span>` +
        `<button id="btn-usage-ctx" class="linkish">read this session’s</button></div>`);
  }
  if (u.fiveHour) {
    rows.push(`<div class="urow"><span>5-hour limit</span><b>${u.fiveHour.pct}%</b></div>` +
              usageBar(u.fiveHour.pct) +
              (u.fiveHour.resets ? `<div class="unote">${esc(u.fiveHour.resets)}</div>` : ''));
  }
  if (u.weekly) {
    rows.push(`<div class="urow"><span>Weekly · all models</span><b>${u.weekly.pct}%</b></div>` +
              usageBar(u.weekly.pct) +
              (u.weekly.resets ? `<div class="unote">${esc(u.weekly.resets)}</div>` : ''));
  }
  if (u.plan) rows.push(`<div class="unote">Plan · ${esc(u.plan)}</div>`);
  el.innerHTML = rows.join('') || '<div class="empty">No usage figures on screen.</div>';

  const b = document.getElementById('btn-usage-ctx');
  if (b) b.onclick = () => { b.textContent = 'reading…'; b.disabled = true; askUsage(state.open, false); };
}

function askUsage(id, panel) {
  const q = [];
  if (id) q.push('id=' + encodeURIComponent(id));
  if (panel) q.push('panel=1');
  api('/api/usage' + (q.length ? '?' + q.join('&') : ''))
    .catch(() => paintUsage(null));
}

function renderUsage() {
  const el = $('usage');
  if (el) el.innerHTML = '<div class="empty">Reading usage…</div>';
  askUsage(null, true);
}

async function renderDiag() {
  const el = $('diag');
  if (!el) return;
  const rows = [];
  const add = (ok, label, hint) => rows.push({ ok, label, hint });

  add(location.protocol === 'https:' || location.hostname === '127.0.0.1',
      'Secure context', 'Push and install need the https:// address');
  const standalone = window.matchMedia('(display-mode: standalone)').matches;
  add(standalone, 'Installed to home screen',
      standalone ? '' : 'Chrome menu -> Add to Home screen');

  const perm = (typeof Notification !== 'undefined') ? Notification.permission : 'unavailable';
  add(perm === 'granted', 'Notification permission: ' + perm,
      perm === 'denied'
        ? 'Chrome has BLOCKED this site. Tap the lock icon in the address bar -> Permissions -> Notifications -> Allow, then reload.'
        : perm === 'default' ? 'Tap the bell to grant it' : '');

  let sw = false, sub = false;
  if ('serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      sw = !!(reg && reg.active);
      if (reg) sub = !!(await reg.pushManager.getSubscription());
    } catch {}
  }
  add(sw, 'Service worker active', sw ? '' : 'Reload once; it registers on load');
  add(sub, 'Push subscription', sub ? '' : 'Tap the bell after granting permission');

  add(!!(state.boot && state.boot.cdp), 'Desktop link (port 9229)',
      (state.boot && state.boot.cdp) ? '' : 'Claude Desktop debugger unreachable - every write will fail');

  el.innerHTML = rows.map(r =>
    `<div class="drow ${r.ok ? 'good' : 'bad'}"><b>${r.ok ? '✓' : '✗'}</b>` +
    `<span>${esc(r.label)}${r.hint && !r.ok ? `<i>${esc(r.hint)}</i>` : ''}</span></div>`).join('');

  let cfg = null;
  try { cfg = await api('/api/notify-config'); } catch {}
  if (!cfg) return;
  const notif = cfg.notifications || {};
  const route = cfg.route ? cfg.route + (cfg.push ? '' : '. Tap the bell to subscribe, or set a backup channel in Settings › Notifications.')
              : cfg.push ? `web push (${cfg.push} subscription${cfg.push > 1 ? 's' : ''})`
              : 'nowhere — no push subscription. Tap the bell to subscribe.';
  const sw2 = (k, label, on) =>
    `<label class="drow toggle"><input type="checkbox" data-k="${k}"${on ? ' checked' : ''}>` +
    `<span>${label}</span></label>`;
  el.insertAdjacentHTML('beforeend',
    `<div class="drow note"><span>Alerts go out over ${esc(route)}</span></div>` +
    (cfg.contact && cfg.contact.placeholder ? `<div class="drow bad"><b>✗</b><span>No push contact set<i>Settings › Notifications: Apple may refuse push without a real mailto: address</i></span></div>` : '') +
    sw2('enabled', 'Send me alerts', notif.enabled !== false) +
    sw2('awaiting', 'When a session needs an answer (yellow)', notif.awaiting !== false) +
    sw2('done', 'When a session finishes (blue)', notif.done !== false));

  el.querySelectorAll('input[data-k]').forEach(cb => {
    cb.onchange = async () => {
      try {
        await api('/api/notify-config', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ [cb.dataset.k]: cb.checked }),
        });
        toast('Saved');
      } catch (e) { cb.checked = !cb.checked; toast('Could not save: ' + e.message, true); }
    };
  });
}

function openSheet() {
  const m = state.meta;
  if (!m) return toast('Pick a session first', true);
  $('sheet-title').textContent = m.title;
  $('sheet-cwd').textContent = m.cwd || '(unknown)';
  $('btn-cancel-run').hidden = !m.running;
  $('btn-cancel-run').disabled = false;
  const pick = (endpoint, field, op) => async (v) => {
    const was = m[field];
    if (field === 'model' && was && !sameModel(was, v)) {
      const go = await confirmModelSwitch(was, v);
      if (!go) { openSheet(); return; }
    }
    tierOverride = { id: m.id,
      model: field === 'model' ? v : (tierOverride && tierOverride.id === m.id ? tierOverride.model : null),
      effort: field === 'effort' ? v : (tierOverride && tierOverride.id === m.id ? tierOverride.effort : null),
      until: Date.now() + 20000 };
    m[field] = v; renderHeader(m); openSheet();
    if (field === 'model') {
      const note = document.getElementById('seg-model-note');
      if (note) {
        note.textContent = 'Recorded: ' + shortModel(v) + ' — applies from the next turn.' +
                           (m.running ? ' This turn stays on ' + shortModel(was) + '.' : '');
        note.style.display = '';
      }
      _tierSeq++;
    }
    try {
      const d = await api(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: m.id, [field]: v }) });
      if (d && d.jobId) uiJobs.set(d.jobId, {
        label: op,
        done: (r) => r.pending
          ? (op + ' recorded — applies from the next turn' + (r.was ? ' (this turn stays on ' + shortModel(r.was) + ')' : ''))
          : (r.unchanged ? op + ' already ' + String(v) : op + ' set'),
        after: () => { setTimeout(() => renderTier(m), 600); },
        onFail: (r) => { toast(op + ' not changed: ' + (r.note || r.error || 'unknown'), true); return true; },
        revert: () => { m[field] = was; renderHeader(m); openSheet(); },
      });
    } catch (e) {
      toast(op + ' failed: ' + e.message, true);
      m[field] = was; renderHeader(m); openSheet();
    }
  };
  const ov = (tierOverride && tierOverride.id === m.id && Date.now() < tierOverride.until) ? tierOverride : null;
  const modelShown = (ov && ov.model) || m.model;
  const effortShown = (ov && ov.effort) || m.effort;
  seg($('seg-model'), state.boot.models, pickByFamily(state.boot.models, modelShown),
      pick('/api/model', 'model', 'Model'));
  const canEffort = MODEL_HAS_EFFORT(modelFamily(modelShown));
  seg($('seg-effort'), state.boot.efforts, canEffort ? effortShown : null,
      pick('/api/effort', 'effort', 'Effort'));
  [...$('seg-effort').children].forEach(c => { c.disabled = !canEffort; });
  let en = document.getElementById('seg-effort-note');
  if (!en) {
    en = document.createElement('div');
    en.id = 'seg-effort-note';
    en.className = 'seg-note';
    $('seg-effort').insertAdjacentElement('afterend', en);
  }
  en.textContent = canEffort ? '' : 'Haiku does not offer an effort setting.';
  en.style.display = canEffort ? 'none' : '';
  renderTier(m);
  renderFast(m);
  showSheet($('sheet'));
  renderUsage();
  renderDiag();
}

let _tierSeq = 0;
function confirmModelSwitch(from, to) {
  let noask = false;
  try { noask = localStorage.getItem('baton.model-switch-noask') === '1'; } catch {}
  if (noask) return Promise.resolve(true);
  return new Promise((resolve) => {
    let box = $('confirm');
    if (!box) { box = document.createElement('div'); box.id = 'confirm'; box.className = 'confirm hidden'; document.body.appendChild(box); }
    const fromL = prettyModel(from), toL = prettyModel(to);
    box.innerHTML = '<div class="confirm-body" role="dialog" aria-modal="true" aria-label="Switch model?">' +
      '<h3>Switch model?</h3>' +
      '<p>This session is cached for ' + esc(fromL) + '. Switching to ' + esc(toL) +
      ' means Claude re-reads the whole session on your next message, which uses more of your limit.</p>' +
      '<label class="confirm-noask"><input type="checkbox" id="confirm-noask"> Don\u2019t ask again</label>' +
      '<div class="confirm-acts"><button type="button" class="primary" id="confirm-yes">Switch model</button>' +
      '<button type="button" class="linkish" id="confirm-no">Cancel</button></div></div>';
    box.classList.remove('hidden');
    const done = (ok) => {
      if (ok) { try { if ($('confirm-noask').checked) localStorage.setItem('baton.model-switch-noask', '1'); } catch {} }
      box.classList.add('hidden'); box.innerHTML = '';
      resolve(ok);
    };
    $('confirm-yes').onclick = () => done(true);
    $('confirm-no').onclick = () => done(false);
    box.onclick = (ev) => { if (ev.target === box) done(false); };
  });
}
function prettyModel(m) {
  const sm = shortModel(m);
  if (/^[A-Z]/.test(sm)) return sm;
  return sm.replace(/\[.*$/, '').split('-').map((w, i) => i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w).join(' ');
}

let tierOverride = null;
async function renderTier(m) {
  const seq = ++_tierSeq;
  const box = $('seg-model');
  let note = document.getElementById('seg-model-note');
  if (!note) {
    note = document.createElement('div');
    note.id = 'seg-model-note';
    note.className = 'seg-note';
    box.insertAdjacentElement('afterend', note);
  }
  let d;
  try { d = await api('/api/tier?id=' + encodeURIComponent(m.id)); } catch { return; }
  if (seq !== _tierSeq || !d || !d.ok || !state.meta || state.meta.id !== m.id) return;
  tierOverride = { id: m.id, model: d.recorded || null, effort: d.effortLabel || null, until: Date.now() + 20000 };
  if (d.recorded) {
    m.model = d.recorded;
    // Exactly ONE button: the one pickByFamily resolves (exact id; a bare alias -> first of its family).
    const hit = pickByFamily([...box.children].map(b => b.textContent), d.recorded);
    [...box.children].forEach(b => b.classList.toggle('on', b.textContent === hit));
  }
  if (d.effortLabel) {
    m.effort = d.effortLabel;
    [...$('seg-effort').children].forEach(b => b.classList.toggle('on', b.textContent === d.effortLabel));
  }
  if (d.modelPending) {
    note.textContent = 'Recorded: ' + shortModel(d.recorded) + ' — applies from the next turn. ' +
                       'The last turn ran on ' + shortModel(d.applied) + '.';
    note.style.display = '';
  } else {
    note.textContent = '';
    note.style.display = 'none';
  }
}

async function renderAccountSwitch() {
  const el = $('acctswitch');
  if (!el) return;
  let d;
  try { d = await api('/api/account-switch'); } catch { return; }
  const q = d && d.pending;
  if (!q) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  const to = esc(q.toAccount || String(q.to).split('/')[0].slice(0, 8));
  const from = esc(q.fromAccount || String(q.from).split('/')[0].slice(0, 8));
  el.innerHTML =
    `<div class="bk-head">You switched Claude account</div>` +
    `<div class="bk-text">Claude Desktop is now on <b>${to}</b> (it was ${from}).\n${esc(d.note || '')}</div>` +
    `<div class="seg" id="acct-seg" style="margin-top:8px">` +
      `<button data-a="dismiss">Leave it</button>` +
      `<button data-a="transfer">Carry the chats over</button>` +
    `</div>`;
  el.classList.remove('hidden');
  el.querySelectorAll('#acct-seg button').forEach(b => {
    b.onclick = async () => {
      el.querySelectorAll('#acct-seg button').forEach(x => { x.disabled = true; });
      try {
        const r = await api('/api/account-switch', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ answer: b.dataset.a }),
        });
        if (!r || !r.ok) throw new Error((r && (r.message || r.error)) || 'not recorded');
        toast(b.dataset.a === 'transfer'
          ? (d.transferToast || 'Recorded.')
          : 'Recorded — leaving both accounts as they are.');
        renderAccountSwitch();
      } catch (e) {
        toast('Not recorded: ' + e.message, true);
        el.querySelectorAll('#acct-seg button').forEach(x => { x.disabled = false; });
      }
    };
  });
}

let _fastSeq = 0;

const MODEL_HAS_FAST = (m) => /^opus/i.test(String(m || ''));

function fastNoteEl() {
  let n = document.getElementById('seg-fast-note');
  if (!n) {
    n = document.createElement('div');
    n.id = 'seg-fast-note';
    n.className = 'seg-note';
    $('seg-fast').insertAdjacentElement('afterend', n);
  }
  return n;
}

function paintFast(m, d) {
  const box = $('seg-fast');
  const note = fastNoteEl();
  const asked = (d.pendingAsk === true || d.pendingAsk === false) ? d.pendingAsk : null;
  const family = modelFamily(m.model);
  const wrongModel = !!family && !MODEL_HAS_FAST(family);
  const usable = !!d.loaded;
  const shown = asked !== null ? (asked ? 'On' : 'Off')
              : d.loaded ? (d.on ? 'On' : 'Off')
              : null;
  box.innerHTML = '';
  for (const v of ['Off', 'On']) {
    const b = document.createElement('button');
    b.textContent = v;
    b.className = shown === v ? 'on' : '';
    b.disabled = !!d.busy || !usable;
    b.onclick = () => setFast(m, v === 'On');
    box.appendChild(b);
  }
  const why = d.note || d.message || '';
  const bits = [];
  if (d.busy) bits.push('Asking Claude Desktop…');
  else if (asked !== null) bits.push('Asked for ' + (asked ? 'on' : 'off') + ' — Claude confirms it at the next turn.');
  if (why) bits.push(why);
  else if (!d.busy && asked === null && usable) {
    bits.push(d.on ? 'On — same model, faster output.' : 'Off — sessions run at normal speed.');
  }
  if (!d.busy && d.loaded) {
    bits.push('One switch for every session.' +
      (wrongModel ? ' It only speeds up Opus, and this session is on ' + shortModel(m.model) + '.' : ''));
  }
  note.textContent = bits.join(' ');
  note.style.display = note.textContent ? '' : 'none';
}

async function renderFast(m) {
  const seq = ++_fastSeq;
  paintFast(m, { busy: true });
  let d;
  try { d = await api('/api/fast?id=' + encodeURIComponent(m.id)); }
  catch (e) {
    if (seq === _fastSeq) paintFast(m, { note: 'Could not read fast mode: ' + e.message });
    return;
  }
  if (seq !== _fastSeq || !state.meta || state.meta.id !== m.id) return;
  if (!d.ok) { paintFast(m, { note: d.message || ('Could not read fast mode (' + (d.error || 'unknown') + ').') }); return; }
  paintFast(m, d);
}

async function setFast(m, want) {
  const seq = ++_fastSeq;
  paintFast(m, { busy: true, pendingAsk: want, loaded: true });
  let d;
  try {
    d = await api('/api/fast', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: m.id, fast: want }),
    });
  } catch (e) {
    toast('Fast mode failed: ' + e.message, true);
    renderFast(m);
    return;
  }
  const mine = () => seq === _fastSeq && state.meta && state.meta.id === m.id;
  if (!d || !d.jobId) { renderFast(m); return; }
  uiJobs.set(d.jobId, {
    label: 'Fast mode',
    done: (r) => r.confirmed
      ? ('Fast mode is ' + (r.on ? 'on' : 'off'))
      : ('Fast mode ' + (r.asked ? 'on' : 'off') + ' — confirms at the next turn'),
    after: (r) => {
      if (!mine()) return;
      paintFast(m, Object.assign({}, r, { pendingAsk: r.confirmed ? null : r.asked }));
    },
    onFail: (r) => { toast(r.note || r.error || 'Fast mode could not be changed', true); return true; },
    revert: () => { if (mine()) renderFast(m); },
  });
}

async function openTasks() {
  showSheet($('view-tasks'));
  $('tasks').innerHTML = '<div class="empty">Loading…</div>';
  try {
    const d = await api('/api/tasks');
    const s = d.summary || {};
    $('task-sub').innerHTML =
      `<span style="color:var(--run)">${s.running || 0} running</span>` +
      `<span class="muted">${s.queued || 0} queued</span>` +
      `<span class="muted">${s.failed || 0} failed</span>` +
      `<span class="muted">$${(s.costUsd || 0).toFixed(2)}</span>`;
    const ul = $('tasks'); ul.innerHTML = '';
    for (const t of d.tasks) {
      const li = document.createElement('li');
      li.className = 'row task' + (t.status === 'running' ? ' live' : '');
      const cls = t.status === 'running' ? 'running'
                : t.status === 'queued' ? 'awaiting'
                : t.status === 'failed' ? 'err' : 'idle';
      const when = t.status === 'running' && t.startedAt ? ageText(t.startedAt).replace(' ago', ' in')
                 : t.endedAt ? ageText(t.endedAt) : t.createdAt ? ageText(t.createdAt) : '';
      const bits = [t.status, shortModel(t.model), t.dispatch, when,
                    t.costUsd ? '$' + t.costUsd.toFixed(2) : ''].filter(Boolean);
      li.innerHTML = `<span class="dot ${cls}"></span><div class="row-main">` +
        `<div class="row-title">${esc(t.id)} · ${esc(t.title || '')}</div>` +
        `<div class="row-meta">${bits.map(x => `<span>${esc(x)}</span>`).join('')}</div>` +
        `<div class="taskmore"></div></div>`;

      li.onclick = () => {
        const box = li.querySelector('.taskmore');
        if (box.innerHTML) { box.innerHTML = ''; li.classList.remove('open'); return; }
        li.classList.add('open');
        const rows = [];
        if (t.brief) rows.push(`<p class="tbrief">${esc(t.brief)}${t.brief.length >= 320 ? '…' : ''}</p>`);
        const kv = [
          ['where', t.cwd], ['route', [t.mode, t.dispatch].filter(Boolean).join(' · ')],
          ['kind', [t.type, t.complexity].filter(Boolean).join(' · ')],
          ['effort', t.effort],
          ['attempt', t.attempt ? t.attempt + ' of ' + (t.maxAttempts || 1) : null],
          ['started', t.startedAt ? new Date(t.startedAt).toLocaleString() : null],
          ['ended', t.endedAt ? new Date(t.endedAt).toLocaleString() : null],
          ['escalations', t.escalations || null],
        ].filter(([, v]) => v !== null && v !== undefined && v !== '');
        rows.push(kv.map(([k, v]) => `<div class="tkv"><span>${esc(k)}</span><b>${esc(String(v))}</b></div>`).join(''));
        if (t.tags && t.tags.length) rows.push(`<div class="ttags">${t.tags.map(x => `<i>${esc(x)}</i>`).join('')}</div>`);
        if (t.result) rows.push(`<p class="tresult">${esc(t.result)}</p>`);
        if (t.error) rows.push(`<p class="terror">${esc(t.error)}</p>`);
        const desktopSession = (t.guiSessionId && /^local_/.test(t.guiSessionId)) ? t.guiSessionId
                             : (/^local_/.test(String(t.sessionId || '')) ? t.sessionId : null);
        const acts = [];
        acts.push('<button class="linkish tdetail">what is it doing?</button>');
        if (desktopSession) acts.push('<button class="linkish tsess">open its session</button>');
        if (t.status === 'running' || t.status === 'queued') acts.push('<button class="linkish tstop">stop it</button>');
        rows.push(`<div class="tacts">${acts.join('')}</div><div class="tlive"></div>`);
        box.innerHTML = rows.join('');

        const live = box.querySelector('.tlive');
        const b2 = box.querySelector('.tsess');
        if (b2) b2.onclick = (ev) => { ev.stopPropagation(); navOpenFrom(desktopSession); hideSheet($('view-tasks')); };

        box.querySelector('.tdetail').onclick = async (ev) => {
          ev.stopPropagation();
          live.innerHTML = '<div class="empty">Reading…</div>';
          try {
            const d = await api('/api/baton-task?id=' + encodeURIComponent(t.id));
            const out = [];
            if (d.events && d.events.length) {
              out.push(`<div class="tsec">progress${d.streaming ? ' · live' : ''}</div>`);
              out.push('<div class="tstream">' + d.events.map(e => e.kind === 'tool'
                ? `<div class="tev tool"><b>${esc(e.name)}</b>${e.text ? ' ' + esc(e.text) : ''}</div>`
                : `<div class="tev">${esc(e.text)}</div>`).join('') + '</div>');
            }
            if (d.result) {
              const r = d.result;
              const summary = r.summary || r.result || r.output || r.raw ||
                              (typeof r === 'string' ? r : JSON.stringify(r));
              out.push(`<div class="tsec">result</div><p class="tresult">${esc(String(summary).slice(0, 2000))}</p>`);
            }
            if (d.log && d.log.trim()) out.push(`<div class="tsec">log</div><pre class="tlog">${esc(d.log.slice(-3000))}</pre>`);
            if (d.task && d.task.routeReason) out.push(`<div class="tsec">why this route</div><p class="tbrief">${esc(d.task.routeReason)}</p>`);
            if (d.task && d.task.prompt) out.push(`<div class="tsec">full instruction</div><pre class="tlog">${esc(d.task.prompt)}</pre>`);
            if (!out.length) {
              out.push('<div class="empty">Nothing yet. Tasks started before streaming was added ' +
                       'write nothing until they finish; ones started now stream as they go.</div>');
            }
            live.innerHTML = out.join('');
          } catch (e) { live.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
        };

        const b3 = box.querySelector('.tstop');
        if (b3) b3.onclick = async (ev) => {
          ev.stopPropagation();
          if (!confirm('Stop ' + t.id + '?\n\n' + (t.title || ''))) return;
          b3.disabled = true; b3.textContent = 'stopping…';
          try {
            await api('/api/baton-task/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: t.id }) });
            toast('Stopped ' + t.id); openTasks();
          } catch (e) { toast('Stop failed: ' + e.message, true); b3.disabled = false; b3.textContent = 'stop it'; }
        };
      };
      ul.appendChild(li);
    }
    if (!d.tasks.length) ul.innerHTML = '<div class="empty">No tasks.</div>';
  } catch (e) { toast('Tasks failed: ' + e.message, true); }
}

function b64ToU8(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}
const sameKey = (sub, key) => {
  if (!sub || !sub.options || !sub.options.applicationServerKey) return false;
  const a = new Uint8Array(sub.options.applicationServerKey), b = b64ToU8(key);
  return a.length === b.length && a.every((v, i) => v === b[i]);
};

async function subscribePush(quiet) {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || typeof Notification === 'undefined') return { ok: false, reason: 'unsupported' };
  if (Notification.permission === 'denied') return { ok: false, reason: 'denied' };
  if (quiet && Notification.permission !== 'granted') return { ok: false, reason: 'not-granted' };
  if (!quiet) {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return { ok: false, reason: 'not-granted' };
  }
  let reg;
  try {
    reg = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
  } catch (e) { return { ok: false, reason: 'sw-failed', detail: e.message }; }
  const key = state.boot && state.boot.vapid;
  if (!key) return { ok: false, reason: 'no-vapid-key' };

  const existing = await reg.pushManager.getSubscription();
  if (existing && !sameKey(existing, key)) {
    await existing.unsubscribe();
    if (!quiet) toast('Replacing old subscription…');
  }
  const sub = (existing && sameKey(existing, key))
    ? existing
    : await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(key) });

  await api('/api/push/subscribe', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sub.toJSON()),
  });
  const bell = $('btn-bell'); if (bell) bell.classList.add('on');
  return { ok: true, endpoint: sub.endpoint };
}

async function enablePush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return toast(location.protocol === 'https:' ? 'This browser cannot do push.'
      : 'Push needs the https:// address, not this one.', true);
  }
  try {
    const r = await subscribePush(false);
    if (!r.ok) {
      if (r.reason === 'denied') return toast('Chrome has blocked notifications for this site. Tap the lock icon in the address bar → Permissions → Notifications → Allow, then reload.', true);
      if (r.reason === 'not-granted') return toast('Notification permission was not granted', true);
      if (r.reason === 'sw-failed') return toast('Service worker failed: ' + r.detail, true);
      return toast('Push failed: ' + r.reason, true);
    }
    await api('/api/push/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    toast('Notifications on — a test one should arrive now');
  } catch (e) { toast('Push failed: ' + e.message, true); }
}

function showSheet(el) {
  if (!navQuiet && el.classList.contains('hidden')) navRecord();
  enableSwipeToClose(el);
  el.dataset.returnFocus = document.activeElement && document.activeElement.id || '';
  el.classList.remove('hidden');
  const first = el.querySelector('button, [href], input, select, textarea');
  if (first) first.focus();
}
function hideSheet(el) {
  el.classList.add('hidden');
  const back = el.dataset.returnFocus && $(el.dataset.returnFocus);
  if (back) back.focus();
}

// Swipe down to close starts ONLY on the sheet's top bar, never in its content. The bar is sticky and is
// built here from the sheet's .grab, with an X that closes through navBack(). The earlier rule let the
// content start the drag once it was scrolled to the top, and an ordinary scroll-up then closed the
// Board: its list scrolls inside #board-list, which is not the sheet body.
function enableSwipeToClose(sheet) {
  const body = sheet.querySelector('.sheet-body');
  if (!body || body.dataset.swipeWired) return;
  body.dataset.swipeWired = '1';
  let y0 = 0, t0 = 0, dy = 0, active = false;

  let bar = body.querySelector(':scope > .sheet-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'sheet-bar';
    const grab = body.querySelector(':scope > .grab') || Object.assign(document.createElement('div'), { className: 'grab' });
    bar.appendChild(grab);
    const x = document.createElement('button');
    x.type = 'button'; x.className = 'sheet-x'; x.setAttribute('aria-label', 'Close'); x.textContent = '\u2715';
    x.onclick = () => navBack();
    bar.appendChild(x);
    body.insertBefore(bar, body.firstChild);
  }
  // Only the bar, and never its X: a button must stay a button.
  const canStart = (target) => !!target.closest('.sheet-bar') && !target.closest('button');

  bar.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1 || !canStart(e.target)) { active = false; return; }
    active = true; y0 = e.touches[0].clientY; t0 = Date.now(); dy = 0;
    body.style.transition = 'none';
  }, { passive: true });

  bar.addEventListener('touchmove', (e) => {
    if (!active) return;
    dy = e.touches[0].clientY - y0;
    if (dy <= 0) { body.style.transform = ''; return; }
    body.style.transform = 'translateY(' + (dy < 140 ? dy : 140 + (dy - 140) * 0.35) + 'px)';
  }, { passive: true });

  const end = () => {
    if (!active) return;
    active = false;
    body.style.transition = 'transform .22s ease';
    const v = dy / Math.max(1, Date.now() - t0);
    if (dy > 110 || (dy > 40 && v > 0.55)) {
      body.style.transform = 'translateY(100%)';
      setTimeout(() => { navBack(); body.style.transition = ''; body.style.transform = ''; }, 200);
    } else {
      body.style.transform = '';
    }
    dy = 0;
  };
  bar.addEventListener('touchend', end, { passive: true });
  bar.addEventListener('touchcancel', end, { passive: true });
}
document.querySelectorAll('.sheet').forEach(enableSwipeToClose);
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (visibleSheetId() || $('drawer').classList.contains('open')) navBack();
});

$('btn-menu').onclick = () => drawer(true);
$('btn-close-drawer').onclick = () => navBack();
$('scrim').onclick = () => navBack();
$('btn-bell').onclick = enablePush;
$('btn-cfg').onclick = openSheet;
$('chat-sub').onclick = openSheet;
$('btn-close-sheet').onclick = () => navBack();
$('sheet').onclick = (e) => { if (e.target === $('sheet')) navBack(); };
$('btn-tasks').onclick = () => { drawer(false); openTasks(); };
$('btn-new').onclick = () => { drawer(false); openNew(); };
$('btn-close-new').onclick = () => navBack();
$('newsheet').onclick = (e) => { if (e.target === $('newsheet')) navBack(); };
$('new-filter').addEventListener('input', renderFolderList);
$('new-folders').addEventListener('click', (e) => {
  const f = e.target.closest('.fold');
  if (!f) return;
  state.newFolder = f.dataset.cwd;
  renderFolderList();
});
$('btn-close-chips').onclick = () => navBack();
$('chipsheet').onclick = (e) => { if (e.target === $('chipsheet')) hideSheet($('chipsheet')); };
$('btn-chips').onclick = openChips;
$('btn-create').onclick = createSession;
$('btn-close-tasks').onclick = () => navBack();
$('btn-close-file').onclick = () => navBack();
$('view-tasks').onclick = (e) => { if (e.target === $('view-tasks')) hideSheet($('view-tasks')); };
if ($('btn-accounts')) $('btn-accounts').onclick = () => {
  showSheet($('view-accounts'));
  if (window.AccountsUI) window.AccountsUI.mount($('accounts-slot'));
};
if ($('btn-close-accounts')) $('btn-close-accounts').onclick = () => hideSheet($('view-accounts'));
if ($('view-accounts')) $('view-accounts').onclick = (e) => { if (e.target === $('view-accounts')) hideSheet($('view-accounts')); };

// Working steps live in the ⋯ sheet (29-Sep: the header slot went to 🔍 find-in-session).
$('btn-work').onclick = () => {
  state.showWork = !state.showWork;
  $('btn-work').classList.toggle('on', state.showWork);
  $('btn-work').setAttribute('aria-pressed', String(state.showWork));
  $('btn-work').textContent = state.showWork ? 'Shown' : 'Hidden';
  state.openGroups.clear();
  renderLog(state.messages, true);
  toast(state.showWork ? 'Showing working steps' : 'Working steps collapsed');
};

$('btn-cancel-run').onclick = async () => {
  const id = state.open;
  if (!id) return;
  if (!confirm('Stop the turn this session is running?')) return;
  const b = $('btn-cancel-run');
  b.disabled = true;
  try {
    const d = await api('/api/cancel?id=' + encodeURIComponent(id));
    if (d && d.jobId) {
      uiJobs.set(d.jobId, {
        label: 'Stop', done: 'Stopped',
        after: () => { b.disabled = false; loadSessions(); },
        onFail: (r) => {
          b.disabled = false;
          const why = String((r && r.error) || '');
          if (/stale-label/i.test(why)) {
            toast('Nothing was running — the desktop was showing a stale status.', true);
            loadSessions();
            return true;
          }
          if (/not-running/i.test(why)) { toast('That session is not running.', true); loadSessions(); return true; }
          return false;
        },
      });
      toast('Stopping…');
    } else { b.disabled = false; toast('Stopped'); loadSessions(); }
  } catch (e) { b.disabled = false; toast('Stop failed: ' + e.message, true); }
};

$('btn-archive').onclick = async () => {
  if (!confirm('Archive this session?')) return;
  archiveSession(false);
};

async function archiveSession(force) {
  const id = state.open;
  try {
    const d = await api('/api/archive', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, force: !!force }) });
    if (d && d.jobId) {
      uiJobs.set(d.jobId, {
        label: 'Archive', done: 'Archived',
        after: () => { hideSheet($('sheet')); loadSessions(); },
        onFail: (r) => {
          const why = String((r && r.error) || '');
          if (/PROTECTED/i.test(why) && !force) {
            const reason = (why.match(/session is ([^.]+)\./i) || [, 'unread or still running'])[1];
            if (confirm('This session is ' + reason + '.\n\n'
                        + 'Archiving stops it and discards work nobody has seen yet.'
                        + ' Archive it anyway?')) archiveSession(true);
            return true;
          }
          return false;
        },
      });
      toast(force ? 'Archiving anyway…' : 'Archiving…');
    } else { hideSheet($('sheet')); toast('Archived'); loadSessions(); }
  } catch (e) { toast('Archive failed: ' + e.message, true); }
}

$('btn-send').onclick = send;
$('btn-attach').onclick = () => $('file').click();
$('file').onchange = (e) => { uploadFiles([...e.target.files]); e.target.value = ''; };

$('input').addEventListener('paste', (e) => {
  const items = (e.clipboardData && e.clipboardData.items) || [];
  const files = [];
  for (const it of items) {
    if (it.kind !== 'file') continue;
    const f = it.getAsFile();
    if (f && /^image\//i.test(f.type)) {
      files.push(f.name && f.name !== 'image.png'
        ? f
        : new File([f], `pasted-${new Date().toISOString().replace(/[:.]/g, '-')}.png`, { type: f.type }));
    }
  }
  if (!files.length) return;
  e.preventDefault();
  uploadFiles(files);
});
$('input').addEventListener('input', () => { autosize(); updateCommandList(); saveDraft(state.open, $('input').value); });

let searchTimer;
function syncSearchClear() {
  const b = $('search-clear');
  if (b) b.hidden = !$('search').value;
}
$('search-clear').onclick = () => {
  $('search').value = '';
  syncSearchClear();
  state.q = '';
  loadSessions();
  $('search').focus();
};
$('search').addEventListener('input', (e) => {
  syncSearchClear();
  state.q = e.target.value.trim();
  $('deep').classList.toggle('hidden', state.q.length < 3);
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadSessions, 220);
});

// The text around a hit, with the match marked (29-Sep: the hints showed message ids).
function markSnip(text, q) {
  const t = String(text || ''), n = String(q || '').trim().toLowerCase();
  if (!n) return esc(t);
  let out = '', from = 0, at = t.toLowerCase().indexOf(n);
  while (at >= 0) { out += esc(t.slice(from, at)) + '<mark class="hit">' + esc(t.slice(at, at + n.length)) + '</mark>'; from = at + n.length; at = t.toLowerCase().indexOf(n, from); }
  return out + esc(t.slice(from));
}
$('deep').onclick = async () => {
  if (state.q.length < 3) return;
  state.deepQ = state.q;
  $('sessions').innerHTML = '<div class="empty">Searching conversations…</div>';
  try {
    const d = await api('/api/search?q=' + encodeURIComponent(state.q) + '&limit=40');
    renderSessions(d.hits, { noSort: true });
    $('list-empty').classList.toggle('hidden', d.hits.length > 0);
    toast(`${d.hits.length} in ${d.scanned} conversations${d.truncated ? ' (partial — narrow it)' : ''}`);
  } catch (e) { toast('Search failed: ' + e.message, true); }
};

async function createSession() {
  if (!state.newFolder) return toast('Pick a folder', true);
  const prompt = $('new-prompt').value.trim();
  if (!prompt) return toast('Type a first message', true);
  const btn = $('btn-create');
  btn.disabled = true; btn.textContent = 'Creating…';
  try {
    const d = await api('/api/new', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cwd: state.newFolder, prompt, model: state.newModel, effort: state.newEffort,
        group: (state.folderList.find(x => x.cwd === state.newFolder) || {}).name,
      }),
    });
    uiJobs.set(d.jobId, {
      label: 'Create', done: 'Session created',
      revert: () => { btn.disabled = false; btn.textContent = 'Create'; },
      after: async (r) => {
        btn.disabled = false; btn.textContent = 'Create';
        hideSheet($('newsheet'));
        await loadSessions();
        if (r.sessionId) openChat(r.sessionId);
      },
    });
  } catch (e) {
    toast('Create failed: ' + e.message, true);
    btn.disabled = false; btn.textContent = 'Create';
  }
}

async function loadMore() {
  if (state.loadingMore || !state.hasMore || !state.open) return;
  state.loadingMore = true;
  try {
    const forSession = state.open;
    const d = await api(`/api/session/${encodeURIComponent(forSession)}?before=${state.oldestByte}&limit=60`);
    if (state.open !== forSession) return;
    const older = d.transcript.messages || [];
    state.oldestByte = d.transcript.startByte;
    state.hasMore = !!d.transcript.hasMore && older.length > 0;
    if (older.length) {
      const seen = new Set(state.messages.map(keyOf));
      const fresh = older.filter(m => !seen.has(keyOf(m)));
      // renderLog() puts the reading anchor back. A scrollTop write here would use a position read
      // BEFORE the fetch, snapping a fling made during the fetch back to where it started.
      renderLog(fresh.concat(state.messages), true);
    }
  } catch (e) {
    toast('Could not load older messages: ' + e.message, true);
  } finally { state.loadingMore = false; }

  if (state.hasMore && $('log').scrollTop < 400) setTimeout(loadMore, 150);
}

const topSentinel = document.createElement('div');
topSentinel.id = 'log-top';
topSentinel.style.cssText = 'flex:none;height:1px';
const historyObserver = new IntersectionObserver((entries) => {
  if (entries.some(e => e.isIntersecting)) loadMore();
}, { root: $('log'), rootMargin: '400px 0px 0px 0px' });
historyObserver.observe(topSentinel);

$('log').addEventListener('scroll', () => {
  if ($('log').scrollTop < 400) loadMore();
}, { passive: true });

let installEvent = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvent = e;
  if (localStorage.getItem('baton.noinstall') === '1') return;
  if (window.matchMedia('(display-mode: standalone)').matches) return;
  $('install').classList.remove('hidden');
});
window.addEventListener('appinstalled', () => {
  $('install').classList.add('hidden');
  toast('Installed — open Relaymote from your home screen');
});
$('btn-install').onclick = async () => {
  if (!installEvent) return toast('Use the Chrome menu → Add to Home screen', true);
  $('install').classList.add('hidden');
  installEvent.prompt();
  try { await installEvent.userChoice; } catch {}
  installEvent = null;
};
$('btn-install-x').onclick = () => {
  $('install').classList.add('hidden');
  localStorage.setItem('baton.noinstall', '1');
};

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (e) => {
    const m = e.data || {};
    if (m.type === 'open-session' && m.id) { openChat(m.id); drawer(false); }
  });
}

function paintBuildLine() {
  const el = $('buildline');
  if (!el) return;
  const server = state.boot && state.boot.build;
  if (!BUILD && !server) { el.hidden = true; return; }
  el.hidden = false;
  const SETTLE_MS = 90000;
  const age = state.boot && state.boot.buildAgeMs;
  const settled = typeof age === 'number' ? age >= SETTLE_MS : true;
  if (!server || BUILD === server || !settled) {
    el.className = 'buildline';
    el.textContent = 'build ' + (BUILD || server) +
      (server && BUILD !== server ? ' · newer build just landed' : '');
    el.onclick = null;
    return;
  }
  el.className = 'buildline stale';
  el.textContent = 'This app is running an OLD build (' + BUILD + '); the desktop has ' + server +
                   '. Tap to load the current one.';
  el.onclick = () => location.reload();
  updateBanner(server);
}

// The drawer line above is where nobody looks: a web app left open on the phone kept running an old
// build for hours (28-Sep). This puts the news where it is seen, once per new build, until reloaded.
function updateBanner(server) {
  let b = $('updbanner');
  let dismissed = null;
  try { dismissed = sessionStorage.getItem('baton.updDismissed'); } catch {}
  if (!server || server === BUILD || dismissed === server) { if (b) b.remove(); return; }
  if (!b) {
    b = document.createElement('div');
    b.id = 'updbanner';
    b.className = 'updbanner';
    b.setAttribute('role', 'status');
    document.body.appendChild(b);
  }
  const v = state.boot && state.boot.version;
  b.innerHTML = `<span>${v ? 'Relaymote ' + esc(v) + ' is ready' : 'A new version is ready'}</span>` +
    '<button class="upd-go">Reload</button><button class="upd-x" aria-label="Later">✕</button>';
  b.querySelector('.upd-go').onclick = () => location.reload();
  b.querySelector('.upd-x').onclick = () => { try { sessionStorage.setItem('baton.updDismissed', server); } catch {} b.remove(); };
}

async function watchForUpdates() {
  if (!('serviceWorker' in navigator)) return;
  let reg;
  try { reg = await navigator.serviceWorker.getRegistration(); } catch { return; }
  if (!reg) return;
  reg.addEventListener('updatefound', () => {
    const sw = reg.installing;
    if (!sw) return;
    sw.addEventListener('statechange', () => {
      if (sw.state === 'installed' && navigator.serviceWorker.controller) {
        toast('Update ready — reloading');
        setTimeout(() => location.reload(), 900);
      }
    });
  });
  const check = () => { reg.update().catch(() => {}); };
  check();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
}

let commandList = null;
async function ensureCommands() {
  if (commandList) return commandList;
  try { commandList = (await api('/api/commands')).commands; } catch { commandList = []; }
  return commandList;
}

async function updateCommandList() {
  const box = $('cmdlist');
  const v = $('input').value;
  const m = /^\/([\w:-]*)$/.exec(v);
  if (!m) { box.classList.add('hidden'); return; }
  const all = await ensureCommands();
  const q = m[1].toLowerCase();
  const hits = all.filter(c => c.name.toLowerCase().startsWith(q)).slice(0, 8);
  if (!hits.length) { box.classList.add('hidden'); return; }
  box.innerHTML = hits.map(c =>
    `<button class="cmd" data-name="${esc(c.name)}"><b>/${esc(c.name)}</b>` +
    `<span>${esc(c.desc || c.kind)}</span></button>`).join('');
  box.classList.remove('hidden');
}

$('cmdlist').addEventListener('click', (e) => {
  const b = e.target.closest('.cmd');
  if (!b) return;
  const cur = $('input').value;
  const rest = cur.replace(/^\s*\/\S*\s?/, '');
  $('input').value = '/' + b.dataset.name + ' ' + rest;
  saveDraft(state.open, $('input').value);
  $('cmdlist').classList.add('hidden');
  $('input').focus();
  autosize();
});

window.__batonT = { nav: performance.timeOrigin };
const tmark = (k) => { try { window.__batonT[k] = Math.round(performance.now()); } catch {} };

(async function boot() {
  const bootTouched = navTouched;
  try { history.replaceState({ ago: 0 }, ''); history.pushState({ ago: 0 }, ''); } catch {}
  const registerSW = () => { if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {}); };

  let painted = false;
  try {
    const raw = localStorage.getItem('baton_sessions_cache');
    if (raw) {
      const c = JSON.parse(raw);
      if (c && Array.isArray(c.sessions) && c.at && Date.now() - c.at < 24 * 3600 * 1000) {
        renderSessions(c.sessions, { noSort: true });
        painted = true;
        tmark('cachePaint');
      }
    }
  } catch {}
  if (painted) { const bl = $('buildline'); if (bl) bl.textContent = 'last known list \u2014 refreshing\u2026'; }

  try {
    state.boot = await api('/api/bootstrap' + (BUILD ? '?build=' + encodeURIComponent(BUILD) : ''));
    tmark('bootstrap');
    paintBuildLine();
    renderStats(); renderFolders(); renderSortChips();
    await loadSessions();
    tmark('sessions');
    setTimeout(registerSW, 0);
    try {
      localStorage.setItem('baton_sessions_cache', JSON.stringify({ at: Date.now(), sessions: (state.rawSessions || state.sessions || []).slice(0, 80) }));
    } catch {}
    connectStream(null);
    renderAccountSwitch();
    // Re-subscribe silently on every open, with no capability guard: subscribePush answers
    // 'unsupported' itself, and that (a plain-http origin) is exactly the case worth reporting. The
    // result goes to the SERVER, so "no phone subscribed" on the desktop can say why.
    {
      const report = (r) => api('/api/push/state', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: !!r.ok, reason: r.reason || '', detail: r.detail || '',
          permission: (window.Notification && Notification.permission) || '', secure: !!window.isSecureContext }) }).catch(() => {});
      subscribePush(true)
        .then(r => { report(r); if (!r.ok && r.reason !== 'not-granted' && r.reason !== 'denied') console.warn('push re-subscribe:', r); })
        .catch(e => { report({ ok: false, reason: 'error', detail: e && e.message }); console.warn('push re-subscribe failed:', e && e.message); });
    }
    // Boot's LAST step is a navigation, and boot ends seconds after the cached list is on screen and
    // tappable (up to ~18 s measured on a phone). So it yields to anything done since: a sheet already
    // open (the #board link, a quick tap), or any navigation at all. Without that, a session opened from
    // the cached list was covered by the drawer and then by the ?s= notification target.
    const want = new URLSearchParams(location.search).get('s');
    if (want) history.replaceState(history.state, '', location.pathname + location.hash);
    const userMoved = navTouched !== bootTouched || !!visibleSheetId() || !!state.open;
    if (userMoved) { /* their navigation stands */ }
    else if (want) openChat(want);
    else firstScreen(bootTouched).then(r => { window.__batonFirstScreen = r; });
    watchForUpdates();
  } catch (e) {
    setTimeout(registerSW, 0);
    if (e.message === 'signin-required') return;
    document.body.insertAdjacentHTML('beforeend',
      '<div class="reauth"><div><b>Could not reach Relaymote</b>' +
      `<p>${esc(e.message)}</p>` +
      '<button onclick="location.reload()">Retry</button></div></div>');
  }
})();

/* ---- Read aloud (g757) ----------------------------------------------------------------------
   The device's own speechSynthesis only. Text is spoken in sentence-sized chunks: Chrome on
   Android cuts one long utterance off after ~15 s, and chunks let a speed change take effect at
   once (the current chunk restarts at the new rate). While it speaks, the message scrolls with it,
   unless you scroll yourself, which pauses the follow for a few seconds. */
const tts = { el: null, chunks: [], i: 0, rate: 1, userScrollAt: 0, token: 0 };
try { tts.rate = Math.min(3, Math.max(0.5, Number(localStorage.getItem('baton.ttsRate')) || 1)); } catch {}

function ttsText(el) {
  const c = el.cloneNode(true);
  c.querySelectorAll('button, .stamp, .tick').forEach(n => n.remove());
  c.querySelectorAll('pre').forEach(n => n.replaceWith(' (code block) '));   // code read aloud is noise
  return (c.innerText || c.textContent || '').replace(/[•#*_`>|]+/g, ' ').replace(/[ \t]+/g, ' ').trim();
}
function ttsChunks(text) {
  const parts = text.split(/(?<=[.!?:;])\s+|\n+/).map(s => s.trim()).filter(Boolean);
  const out = [];
  for (const p of parts) {                     // keep each utterance well under the ~15 s cut-off
    if (out.length && (out[out.length - 1] + ' ' + p).length < 160) out[out.length - 1] += ' ' + p;
    else for (let k = 0; k < p.length; k += 220) out.push(p.slice(k, k + 220));
  }
  return out;
}
function ttsBar() {
  let bar = document.getElementById('ttsbar');
  if (bar) return bar;
  bar = document.createElement('div');
  bar.id = 'ttsbar';
  bar.className = 'ttsbar hidden';
  bar.innerHTML = '<button data-tts="slower" aria-label="Slower">−</button>' +
    '<span class="ttsrate"></span>' +
    '<button data-tts="faster" aria-label="Faster">+</button>' +
    '<span class="ttspos"></span>' +
    '<button data-tts="stop" class="ttsstop" aria-label="Stop">Stop</button>';
  bar.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tts]');
    if (!b) return;
    const a = b.dataset.tts;
    if (a === 'stop') return ttsStop();
    tts.rate = Math.round(Math.min(3, Math.max(0.5, tts.rate + (a === 'faster' ? 0.25 : -0.25))) * 100) / 100;
    try { localStorage.setItem('baton.ttsRate', String(tts.rate)); } catch {}
    ttsSpeak();                                  // restart the current chunk at the new speed
  });
  document.body.appendChild(bar);
  return bar;
}
function ttsPaint() {
  const bar = ttsBar();
  bar.querySelector('.ttsrate').textContent = (+tts.rate.toFixed(2)) + '×';
  bar.querySelector('.ttspos').textContent = tts.chunks.length ? `${Math.min(tts.i + 1, tts.chunks.length)}/${tts.chunks.length}` : '';
  bar.classList.toggle('hidden', !tts.el);
  document.querySelectorAll('.msg.speaking').forEach(n => { if (n !== tts.el) n.classList.remove('speaking'); });
  if (tts.el) tts.el.classList.add('speaking');
}
function ttsFollow() {
  const el = tts.el;
  if (!el || !el.isConnected || Date.now() - tts.userScrollAt < 4000) return;
  const log = $('log');
  const frac = tts.chunks.length ? tts.i / tts.chunks.length : 0;
  // Rect-based: a message's offsetParent is #main, not the scrolling #log.
  const y = log.scrollTop + (el.getBoundingClientRect().top - log.getBoundingClientRect().top) +
            frac * el.offsetHeight - log.clientHeight / 3;
  log.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
}
function ttsSpeak() {
  const my = ++tts.token;                      // a stale utterance's onend must not advance the new one
  speechSynthesis.cancel();
  if (!tts.el || tts.i >= tts.chunks.length) return ttsStop();
  const u = new SpeechSynthesisUtterance(tts.chunks[tts.i]);
  u.rate = tts.rate;
  u.onend = () => { if (my !== tts.token) return; tts.i++; ttsSpeak(); };
  u.onerror = (ev) => { if (my !== tts.token || ev.error === 'interrupted' || ev.error === 'canceled') return; toast('Read aloud stopped: ' + ev.error); ttsStop(); };
  ttsPaint(); ttsFollow();
  speechSynthesis.speak(u);
}
function ttsStart(msgEl) {
  if (tts.el === msgEl) return ttsStop();      // the same button again = stop
  const text = ttsText(msgEl);
  if (!text) return;
  tts.el = msgEl; tts.chunks = ttsChunks(text); tts.i = 0; tts.userScrollAt = 0;
  ttsSpeak();
}
function ttsStop() {
  tts.token++;
  if (TTS_OK) speechSynthesis.cancel();
  if (tts.el) tts.el.classList.remove('speaking');
  tts.el = null; tts.chunks = []; tts.i = 0;
  ttsPaint();
}
if (TTS_OK) {
  $('log').addEventListener('click', (e) => {
    const b = e.target.closest('.speak');
    if (!b) return;
    e.preventDefault(); e.stopPropagation();
    ttsStart(b.closest('.msg'));
  });
  for (const ev of ['touchmove', 'wheel']) $('log').addEventListener(ev, () => { tts.userScrollAt = Date.now(); }, { passive: true });
}

/* Find in this session (g784: "ability to search inside a session if I want to find a text").
   The desktop searches the WHOLE transcript (/api/session-search: his messages, peers', the replies;
   never tool steps), so a match in history not loaded yet is still found. Here every match in what is
   loaded is marked; ▲ walks to older ones, paging history in until the next older hit is on screen;
   ▼ walks back toward now. The marks are re-applied after every render, and the bar is an overlay,
   so opening it or a new message arriving never moves what he is reading (g780). */
// `var`: renderLog can run before this line does (a const would be in its dead zone then).
var finder = { q: '', sid: null, hits: [], occ: 0, truncated: false, cur: null, seq: 0, timer: 0, work: false };
const FIND_SKIP = 'button, .tick, .speak, .more, mark, script, style, .work, .stamp';
// With "Include working steps" ticked, the steps are searched too (not their collapsed summary line).
const FIND_SKIP_WORK = 'button, .tick, .speak, .more, mark, script, style, .stamp, details.work > summary';
// The tick is remembered per session; unticked (the default) searches only what was said.
const FIND_WORK_KEY = 'rm.findWork';
function findWorkFor(sid) {
  try { return !!(JSON.parse(localStorage.getItem(FIND_WORK_KEY) || '{}') || {})[sid]; } catch { return false; }
}
function findWorkSave(sid, on) {
  try {
    const m = JSON.parse(localStorage.getItem(FIND_WORK_KEY) || '{}') || {};
    if (on) m[sid] = 1; else delete m[sid];
    localStorage.setItem(FIND_WORK_KEY, JSON.stringify(m));
  } catch {}
}
// Open every fold around a match -- the step group, a tool's own details, a clamped result -- and keep
// the group open across the next render, which rebuilds the log with its folds closed.
function findOpenAround(m) {
  for (let d = m.closest('details'); d; d = d.parentElement && d.parentElement.closest('details')) {
    if (!d.open) d.open = true;
    if (d.matches('details.work') && d.dataset.key) state.openGroups.add(d.dataset.key);
  }
}

function findMarks() { return [...$('log').querySelectorAll('mark.hit')]; }
function findRow(m) { let el = m; while (el && el.parentElement !== $('log')) el = el.parentElement; return el; }
// A match is named by its row and its place in that row, so it survives renders and older pages.
function findRef(m) {
  const row = findRow(m); if (!row) return null;
  return { key: anchorKey(row), k: [...row.querySelectorAll('mark.hit')].indexOf(m) };
}
function findByRef(marks, ref) {
  if (!ref) return -1;
  return marks.findIndex(m => { const r = findRef(m); return r && r.key === ref.key && r.k === ref.k; });
}

function findUnmark() {
  const parents = new Set();
  for (const m of findMarks()) { parents.add(m.parentNode); m.replaceWith(document.createTextNode(m.textContent)); }
  for (const p of parents) if (p) p.normalize();
}
function findMark() {
  const q = finder.q.toLowerCase(), log = $('log');
  if (!q) return;
  for (const row of log.children) {
    if (!(row.matches('.msg, .peer') || (finder.work && row.matches('details.work'))) || row.matches('.sentfile')) continue;
    const skip = finder.work ? FIND_SKIP_WORK : FIND_SKIP;
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => n.parentElement.closest(skip) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
    const nodes = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.nodeValue.toLowerCase().includes(q)) nodes.push(n);
    for (const n of nodes) {
      const text = n.nodeValue, low = text.toLowerCase(), frag = document.createDocumentFragment();
      let from = 0, at = low.indexOf(q);
      while (at >= 0) {
        if (at > from) frag.appendChild(document.createTextNode(text.slice(from, at)));
        const mk = document.createElement('mark'); mk.className = 'hit'; mk.textContent = text.slice(at, at + q.length);
        frag.appendChild(mk);
        from = at + q.length; at = low.indexOf(q, from);
      }
      if (from < text.length) frag.appendChild(document.createTextNode(text.slice(from)));
      n.replaceWith(frag);
    }
  }
}
// Called at the end of every renderLog: the rebuilt log lost the marks.
function findRemark() {
  if (!finder || !finder.q) return;
  if (finder.sid !== state.open) { findClose(); return; }
  findMark();
  const marks = findMarks(), i = findByRef(marks, finder.cur);
  if (i >= 0) { marks[i].classList.add('cur'); findOpenAround(marks[i]); }
  findCount();
}
function findCount() {
  const el = $('find-n'); if (!el) return;
  if (!finder.q) { el.textContent = ''; return; }
  const marks = findMarks(), i = findByRef(marks, finder.cur);
  const total = Math.max(finder.occ, marks.length);
  if (!total) { el.textContent = finder.busy ? '…' : 'none'; return; }
  // Everything not loaded is older than everything loaded, so a loaded match's number counts them in.
  el.textContent = (i >= 0 ? (total - marks.length + i + 1) + '/' : '') + total + (finder.truncated ? '+' : '');
}

function findShow(m) {
  for (const x of findMarks()) x.classList.remove('cur');
  m.classList.add('cur');
  finder.cur = findRef(m);
  const body = m.closest('[data-ck]');
  if (body && body.classList.contains('clamp')) {
    body.classList.remove('clamp');
    state.expanded.add(body.dataset.ck); state.closedClamps.delete(body.dataset.ck);
    const more = body.nextElementSibling; if (more && more.classList.contains('more')) more.textContent = 'Show less';
  }
  findOpenAround(m);
  const log = $('log');
  const y = m.getBoundingClientRect().top - log.getBoundingClientRect().top + log.scrollTop - log.clientHeight / 3;
  logAtBottom = false;
  setScrollTop(log, Math.max(0, Math.min(y, log.scrollHeight - log.clientHeight)));
  logAtBottom = nearBottom(log);
  heldAnchor = logAtBottom ? null : readingAnchor(log);
  renderJump(); findCount();
}

// Page older history in until the transcript byte `byte` is loaded (the hit's line).
async function findLoadUntil(byte) {
  const sid = state.open;
  for (let guard = 0; guard < 80 && state.open === sid && state.hasMore && state.oldestByte > byte; guard++) {
    while (state.loadingMore) await new Promise(r => setTimeout(r, 100));
    if (!(state.hasMore && state.oldestByte > byte)) break;
    state.loadingMore = true;
    try {
      const d = await api(`/api/session/${encodeURIComponent(sid)}?before=${state.oldestByte}&limit=200`);
      if (state.open !== sid) return;
      const older = d.transcript.messages || [];
      state.oldestByte = d.transcript.startByte;
      state.hasMore = !!d.transcript.hasMore && older.length > 0;
      const seen = new Set(state.messages.map(keyOf));
      const fresh = older.filter(m => !seen.has(keyOf(m)));
      if (fresh.length) renderLog(fresh.concat(state.messages), true);
    } finally { state.loadingMore = false; }
  }
}

async function findStep(dir) {
  if (!finder.q) return;
  let marks = findMarks(), i = findByRef(marks, finder.cur);
  if (i < 0) i = dir < 0 ? marks.length : -1;     // nothing current yet: ▲ starts at the newest
  let j = i + dir;
  if (j < 0) {
    const older = finder.hits.filter(h => h.byte < state.oldestByte);
    if (!older.length) { toast('No earlier match'); return; }
    const before = marks.length;
    finder.busy = true; findCount();
    try { await findLoadUntil(older[older.length - 1].byte); } catch (e) { toast('Could not load older messages: ' + e.message, true); }
    finder.busy = false;
    marks = findMarks();
    j = marks.length - before - 1;                  // the newest of the matches just loaded
    if (j < 0) { findCount(); toast('No earlier match'); return; }
  }
  if (j >= marks.length) { toast('No later match'); return; }
  findShow(marks[j]);
}

async function findRun(q) {
  const seq = ++finder.seq, sid = state.open;
  findUnmark();
  finder.q = q; finder.sid = sid; finder.cur = null; finder.hits = []; finder.occ = 0; finder.truncated = false;
  if (!q || q.length < 2 || !sid) { findCount(); return; }
  finder.busy = true;
  findMark(); findCount();
  try {
    const r = await api(`/api/session-search?id=${encodeURIComponent(sid)}&q=${encodeURIComponent(q)}` + (finder.work ? '&work=1' : ''));
    if (seq !== finder.seq) return;
    finder.hits = r.hits || []; finder.occ = r.occurrences || 0; finder.truncated = !!r.truncated;
  } catch (e) { if (seq === finder.seq) toast('Search failed: ' + e.message, true); }
  finder.busy = false;
  if (seq !== finder.seq) return;
  findCount();
  if (findMarks().length || finder.hits.length) findStep(-1);   // start at the newest match
}

function findOpen() {
  if (!state.open) { toast('Open a session first'); return; }
  const bar = $('findbar');
  bar.style.top = document.querySelector('#main > .bar').offsetHeight + 'px';
  bar.hidden = false;
  finder.work = findWorkFor(state.open);
  $('find-work').checked = finder.work;
  $('find-q').focus(); $('find-q').select();
}
function findClose() {
  ++finder.seq;
  $('findbar').hidden = true;
  findUnmark();
  finder.q = ''; finder.cur = null; finder.hits = []; finder.occ = 0;
  findCount();
}
if ($('btn-find')) {
  $('btn-find').addEventListener('click', () => ($('findbar').hidden ? findOpen() : findClose()));
  $('find-x').addEventListener('click', findClose);
  $('find-prev').addEventListener('click', () => findStep(-1));
  $('find-work').addEventListener('change', () => {
    finder.work = $('find-work').checked;
    findWorkSave(state.open, finder.work);
    const v = $('find-q').value.trim();
    clearTimeout(finder.timer); findRun(v);
    $('find-q').focus();
  });
  $('find-next').addEventListener('click', () => findStep(1));
  $('find-q').addEventListener('input', () => {
    clearTimeout(finder.timer);
    const v = $('find-q').value.trim();
    finder.timer = setTimeout(() => findRun(v), 350);
  });
  $('find-q').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); findClose(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const v = $('find-q').value.trim();
      if (v !== finder.q) { clearTimeout(finder.timer); findRun(v); } else findStep(e.shiftKey ? 1 : -1);
    }
  });
}

/* Land on one message from a board card (g785: "clicking it didn't open the relevant message in that
   session"). A card's anchor names the message by its transcript uuid; without one, the card's own
   words are searched (a quoted phrase first, then its goal id such as "g769"), taking the hit nearest
   to when the card was raised. Either way the desktop finds it across the WHOLE transcript (the g784
   search), history is paged in until it is loaded, and the view lands with that message highlighted. */
function rowsWithTimes() {
  const out = [];
  for (const el of $('log').children) {
    if (el.matches('.stamp')) { const last = out[out.length - 1]; if (last && !last.ts) last.ts = el.dataset.ts; continue; }
    if (!el.matches('.msg, .peer')) continue;
    const inner = el.matches('.peer') ? el.querySelector('.stamp[data-ts]') : null;
    out.push({ el, ts: inner ? inner.dataset.ts : null });
  }
  return out;
}
const landNorm = (t) => String(t || '').replace(/[*_`~#>\[\]()]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
function landTarget(row, needle) {
  const want = landNorm(needle).slice(0, 40);
  if (want.length >= 6) {
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const v = landNorm(n.nodeValue);
      if (v.length >= 6 && (v.includes(want.slice(0, Math.min(want.length, v.length))) || want.startsWith(v.slice(0, 24)))) {
        const r = document.createRange(); r.selectNodeContents(n); return r;
      }
    }
  }
  return row;
}
async function landAtHit(hit, needle) {
  if (!hit || !state.open) return false;
  await findLoadUntil(hit.byte);
  const rows = rowsWithTimes().filter(r => r.ts && String(r.ts) <= String(hit.ts));
  const row = rows.length ? rows[rows.length - 1].el : null;
  if (!row) return false;
  const body = row.querySelector('[data-ck].clamp');
  if (body) {
    body.classList.remove('clamp'); state.expanded.add(body.dataset.ck); state.closedClamps.delete(body.dataset.ck);
    const more = body.nextElementSibling; if (more && more.classList.contains('more')) more.textContent = 'Show less';
  }
  if (row.matches('details') && !row.open) row.open = true;
  const log = $('log');
  const at = landTarget(row, needle || hit.snippet);
  const y = at.getBoundingClientRect().top - log.getBoundingClientRect().top + log.scrollTop - log.clientHeight / 4;
  logAtBottom = false;
  setScrollTop(log, Math.max(0, Math.min(y, log.scrollHeight - log.clientHeight)));
  logAtBottom = nearBottom(log);
  heldAnchor = logAtBottom ? null : readingAnchor(log);
  renderJump();
  row.classList.add('askhit');
  setTimeout(() => row.classList.remove('askhit'), 2600);
  return true;
}
async function landAtAnchor(sid, { uuid = '', text = '', raised = '' } = {}) {
  if (!sid || state.open !== sid) return false;
  const ask = (q, u) => api(`/api/session-search?id=${encodeURIComponent(sid)}&q=${encodeURIComponent(q || '')}` + (u ? '&uuid=' + encodeURIComponent(u) : ''));
  try {
    if (uuid) {
      const r = await ask('', uuid);
      if (r.hits && r.hits[0] && await landAtHit(r.hits[0], r.hits[0].snippet)) return true;
    }
    const t = String(text || '');
    // A quote opens after a space and closes before one, so "couldn't ... Android's" is not a phrase.
    const quoted = [...t.matchAll(/(?:^|[\s(])["'‘“]([^"'’”\n]{8,80})["'’”](?=[\s.,;:)!?]|$)/g)].map(m => m[1]).slice(0, 3);
    const goals = [...new Set(t.match(/\bg\d{2,4}[a-z]?\b/gi) || [])].slice(0, 2);
    const when = Date.parse(raised) || 0;
    for (const q of quoted.concat(goals)) {
      const r = await ask(q);
      const hits = r.hits || [];
      if (!hits.length) continue;
      const best = when ? hits.reduce((a, h) => Math.abs(Date.parse(h.ts) - when) < Math.abs(Date.parse(a.ts) - when) ? h : a)
                        : hits[hits.length - 1];
      if (await landAtHit(best, q)) return true;
    }
  } catch (e) { toast('Could not find that message: ' + e.message, true); }
  return false;
}
window.landAtAnchor = landAtAnchor;
