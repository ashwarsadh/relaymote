// refactor-g842h.js — the duplicated helpers that were folded into lib/fsx.js and mobile/cookies.js
// behave exactly as the copies they replaced. Each OLD_* below is the removed code, verbatim; the test
// runs old and new side by side on the same inputs and compares the bytes written, the temp file used,
// whether it was fsync'd, the rename, and what is thrown. The only intended differences are in error
// paths, and each is asserted explicitly:
//   - a failed write no longer leaves its temp file behind (the error is still thrown, unchanged);
//   - a cookie that is not valid percent-encoding reads as "no cookie" instead of throwing, which used
//     to turn every request carrying it into a 500 (proved over HTTP at the end).
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relaymote-g842h-')));
const root = path.join(__dirname, '..');
const fsx = require(path.join(root, 'lib', 'fsx.js'));
const { cookieValue } = require(path.join(root, 'mobile', 'cookies.js'));
let n = 0;
const ok = (c, name, extra) => { assert.ok(c, name + (extra !== undefined ? '  ' + JSON.stringify(extra).slice(0, 300) : '')); n++; console.log('ok ' + name); };
const src = f => fs.readFileSync(path.join(root, f), 'utf8');

// ------------------------------------------------------------------ the removed code, verbatim
function OLD_writeAtomic_text(file, text) {           // lib/directions.js, goals.js, hygiene.js, projects.js
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}
function OLD_aliases_writeJson(f, obj) {              // lib/aliases.js
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, f);
}
function OLD_notify_writeAtomic(file, obj) {          // lib/notify.js
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}
function OLD_salvage_writeAtomic(file, obj) {         // lib/salvage.js
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeSync(fd, JSON.stringify(obj, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}
function OLD_summarize_writeJson(f, v, pretty) {      // lib/summarize.js
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(v, null, pretty ? 1 : 0));
  fs.renameSync(tmp, f);
}
function OLD_readJson(f, d) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } }  // aliases, hygiene, reaper, summarize
function OLD_cookie(req, name) {                      // mobile/index.js cookieToken, mobile/access.js tokenFrom
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

// The new wrappers, exactly as each module now defines them (asserted against the source below).
const NEW = {
  text: (file, text) => fsx.writeAtomic(file, text),
  aliases: (f, obj) => fsx.writeJsonAtomic(f, obj, 2),
  notify: (file, obj) => fsx.writeJsonAtomic(file, obj, 2, { tmp: file + '.tmp' }),
  salvage: (file, obj) => fsx.writeJsonAtomic(file, obj, 2, { fsync: true }),
  summarize: (f, v, pretty) => fsx.writeJsonAtomic(f, v, pretty ? 1 : 0),
};
const PAIRS = [
  ['text writeAtomic (directions/goals/hygiene/projects)', OLD_writeAtomic_text, NEW.text, 'text'],
  ['aliases writeJson', OLD_aliases_writeJson, NEW.aliases, 'json'],
  ['notify writeAtomic', OLD_notify_writeAtomic, NEW.notify, 'json'],
  ['salvage writeAtomic', OLD_salvage_writeAtomic, NEW.salvage, 'json'],
  ['summarize writeJson (pretty)', (f, v) => OLD_summarize_writeJson(f, v, true), (f, v) => NEW.summarize(f, v, true), 'json'],
  ['summarize writeJson (compact)', (f, v) => OLD_summarize_writeJson(f, v, false), (f, v) => NEW.summarize(f, v, false), 'json'],
];

// Record the fs calls a writer makes, with paths made relative to its target so old and new compare.
function traced(fn, file, ...args) {
  const calls = [], orig = {};
  const rel = p => typeof p === 'string' ? p.replace(file, '<f>') : p;
  for (const m of ['writeFileSync', 'openSync', 'writeSync', 'fsyncSync', 'closeSync', 'renameSync', 'unlinkSync']) {
    orig[m] = fs[m];
    fs[m] = function (...a) {
      calls.push(m + '(' + (m === 'renameSync' ? rel(a[0]) + '→' + rel(a[1]) : m === 'writeSync' || m === 'fsyncSync' || m === 'closeSync' ? 'fd' : rel(a[0])) + ')');
      return orig[m].apply(fs, a);
    };
  }
  let threw = null;
  try { fn(file, ...args); } catch (e) { threw = e.code || e.message; } finally { Object.assign(fs, orig); }
  return { calls, threw };
}
const leftovers = dir => { try { return fs.readdirSync(dir).filter(x => x.endsWith('.tmp')); } catch { return []; } };

const VALUES = [
  { a: 1, b: [1, 2, { c: 'x' }], d: null },
  { unicode: 'naïve — 😀   "quoted" \\ back', empty: {}, arr: [] },
  [], {}, 'a string', 42, true, null,
  { undef: undefined, fn: () => 1, nested: { deep: { deeper: [undefined] } } },
  Object.fromEntries(Array.from({ length: 200 }, (_, i) => ['k' + i, 'v'.repeat(i)])),
];
const TEXTS = ['', 'plain\n', '# Title\r\n\r\nbody with ünïcode ✓\n', 'x'.repeat(300000)];

(async () => {
  try {
    // ---------------------------------------------------------------- writers: identical success path
    for (const [name, oldFn, newFn, kind] of PAIRS) {
      const inputs = kind === 'text' ? TEXTS : VALUES;
      let same = 0;
      inputs.forEach((v, i) => {
        const a = path.join(TMP, 'old', name.replace(/\W+/g, '_'), String(i), 'deep', 'f.json');
        const b = path.join(TMP, 'new', name.replace(/\W+/g, '_'), String(i), 'deep', 'f.json');
        const ta = traced(oldFn, a, v), tb = traced(newFn, b, v);
        assert.deepStrictEqual(tb.calls, ta.calls, `${name} #${i}: same fs calls`);
        assert.strictEqual(tb.threw, ta.threw);
        assert.ok(fs.readFileSync(b).equals(fs.readFileSync(a)), `${name} #${i}: same bytes`);
        assert.strictEqual(fs.statSync(b).mode, fs.statSync(a).mode);
        assert.deepStrictEqual(leftovers(path.dirname(b)), []);
        same++;
      });
      ok(same === inputs.length, `${name}: same bytes, same temp file, same fs calls, same mode for ${same} inputs (parent folder created)`);
      // Overwriting an existing file behaves the same too.
      const a = path.join(TMP, 'ow-old', name.replace(/\W+/g, '_') + '.json'), b = path.join(TMP, 'ow-new', name.replace(/\W+/g, '_') + '.json');
      for (const f of [a, b]) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'previous contents that are longer than the new ones'); }
      oldFn(a, kind === 'text' ? 'new' : { n: 1 }); newFn(b, kind === 'text' ? 'new' : { n: 1 });
      ok(fs.readFileSync(a, 'utf8') === fs.readFileSync(b, 'utf8'), `${name}: overwrites an existing file identically`);
    }
    ok(traced(NEW.salvage, path.join(TMP, 's', 'r.json'), { x: 1 }).calls.includes('fsyncSync(fd)'), 'salvage still fsyncs before the rename');
    ok(traced(NEW.notify, path.join(TMP, 'n', 'n.json'), { x: 1 }).calls[0] === 'writeFileSync(<f>.tmp)', 'notify still writes through <file>.tmp');
    ok(traced(NEW.text, path.join(TMP, 't', 't.md'), 'x').calls[0] === `writeFileSync(<f>.${process.pid}.tmp)`, 'the others still write through <file>.<pid>.tmp');
    {
      // A value JSON cannot serialise throws the same error, before any file is created.
      const cyc = {}; cyc.self = cyc;
      const a = traced(OLD_aliases_writeJson, path.join(TMP, 'cy-old', 'c.json'), cyc);
      const b = traced(NEW.aliases, path.join(TMP, 'cy-new', 'c.json'), cyc);
      ok(a.threw === b.threw && !fs.existsSync(path.join(TMP, 'cy-new', 'c.json')), 'a circular value throws the same error and writes nothing', [a.threw, b.threw]);
    }

    // ---------------------------------------------------------------- writers: error paths
    for (const [name, oldFn, newFn, kind] of PAIRS) {
      // The rename fails because the target is a non-empty folder.
      const mk = tag => { const t = path.join(TMP, 'err-' + tag, name.replace(/\W+/g, '_'), 'target'); fs.mkdirSync(path.join(t, 'inside'), { recursive: true }); return t; };
      const a = mk('old'), b = mk('new');
      const v = kind === 'text' ? 'x' : { x: 1 };
      const ea = traced(oldFn, a, v), eb = traced(newFn, b, v);
      ok(ea.threw && ea.threw === eb.threw, `${name}: a failed rename throws the same error (${ea.threw})`);
      ok(leftovers(path.dirname(a)).length === 1 && leftovers(path.dirname(b)).length === 0, `${name}: the old copy left its temp file behind, the new one removes it`);
      ok(fs.statSync(b).isDirectory() && fs.existsSync(path.join(b, 'inside')), `${name}: the target is untouched`);
    }
    if (process.platform !== 'win32' && process.getuid && process.getuid() !== 0) {
      const ro = path.join(TMP, 'ro'); fs.mkdirSync(ro); fs.chmodSync(ro, 0o500);
      const ea = traced(OLD_writeAtomic_text, path.join(ro, 'a.md'), 'x'), eb = traced(NEW.text, path.join(ro, 'b.md'), 'x');
      ok(ea.threw === 'EACCES' && eb.threw === 'EACCES', 'a read-only folder throws EACCES in both');
      fs.chmodSync(ro, 0o700);
    }

    // ---------------------------------------------------------------- readJson
    {
      const d = path.join(TMP, 'rj'); fs.mkdirSync(d);
      const cases = { valid: '{"a":[1,2]}', empty: '', corrupt: '{ nope', bom: '﻿{"a":1}', arr: '[1]', nul: 'null', num: '7' };
      for (const [k, v] of Object.entries(cases)) fs.writeFileSync(path.join(d, k), v);
      fs.mkdirSync(path.join(d, 'folder'));
      const names = [...Object.keys(cases), 'missing', 'folder'];
      const fb = { fallback: true };
      const same = names.every(k => JSON.stringify(fsx.readJson(path.join(d, k), fb)) === JSON.stringify(OLD_readJson(path.join(d, k), fb)));
      ok(same, 'readJson returns what the old copies returned for valid, empty, corrupt, BOM, array, null, number, missing and folder');
      ok(fsx.readJson(path.join(d, 'missing'), fb) === fb && fsx.readJson(path.join(d, 'missing')) === undefined, 'the fallback is returned by identity (undefined when none is given)');
    }

    // ---------------------------------------------------------------- each module uses fsx with its old parameters
    {
      const wired = [
        ['lib/directions.js', "const { writeAtomic } = require('./fsx');"],
        ['lib/goals.js', "const { writeAtomic } = require('./fsx');"],
        ['lib/projects.js', "const { writeAtomic } = require('./fsx');"],
        ['lib/hygiene.js', "const { readJson, writeAtomic } = require('./fsx');"],
        ['lib/reaper.js', "const { readJson } = require('./fsx');"],
        ['lib/aliases.js', 'const writeJson = (f, obj) => writeJsonAtomic(f, obj, 2);'],
        ['lib/notify.js', "writeJsonAtomic(file, obj, 2, { tmp: file + '.tmp' })"],
        ['lib/salvage.js', 'writeJsonAtomic(file, obj, 2, { fsync: true })'],
        ['lib/summarize.js', 'const writeJson = (f, v, pretty) => writeJsonAtomic(f, v, pretty ? 1 : 0);'],
      ];
      for (const [f, line] of wired) {
        const s = src(f);
        ok(s.includes(line) && !/fs\.renameSync\(tmp, f(ile)?\)/.test(s.slice(0, s.indexOf(line) + 2000).replace(line, '')) && !/^function (writeAtomic|writeJson|readJson)\b/m.test(s),
          `${f}: its own copy is gone; it calls fsx with the old parameters`);
      }
      // Every one of these modules still loads, and none calls the helper while loading (a const is not hoisted).
      const { spawnSync } = require('child_process');
      const mods = wired.map(w => w[0]);
      const r = spawnSync(process.execPath, ['-e', mods.map(m => `require(${JSON.stringify(path.join(root, m))});`).join('')],
        { env: { ...process.env, RELAYMOTE_HOME: path.join(TMP, 'load-home'), CLAUDE_CONFIG_DIR: path.join(TMP, 'load-claude'), APPDATA: path.join(TMP, 'load-appdata') }, encoding: 'utf8', windowsHide: true });
      ok(r.status === 0, 'all nine modules load', r.stderr && r.stderr.slice(0, 300));
    }

    // ---------------------------------------------------------------- cookie reader
    {
      const H = c => ({ headers: c === undefined ? {} : { cookie: c } });
      const table = [undefined, '', 'baton_m=abc', 'x=1; baton_m=abc; y=2', 'baton_m=a%3Db%20c', 'baton_m=a=b=c', '  baton_m=  spaced',
        'baton_m=', 'baton_m', 'xbaton_m=1', 'baton_m=first; baton_m=second', 'CF_Authorization=eyJ.x.y', ';;; baton_m=z ;;',
        'baton_m=%7B%22a%22%3A1%7D'];
      let same = 0;
      for (const c of table) for (const name of ['baton_m', 'CF_Authorization']) {
        assert.strictEqual(cookieValue(H(c), name), OLD_cookie(H(c), name), JSON.stringify([c, name])); same++;
      }
      ok(same === table.length * 2, `cookieValue matches the old parser on ${same} well-formed cases (first match wins, '=' kept, decoding)`);
      for (const bad of ['baton_m=%E0%A4%A', 'baton_m=%', 'baton_m=100%', 'CF_Authorization=%zz']) {
        const name = bad.split('=')[0];
        let threw = false; try { OLD_cookie(H(bad), name); } catch (e) { threw = e instanceof URIError; }
        ok(threw && cookieValue(H(bad), name) === null, `"${bad}": the old parser threw URIError, the new one reads no cookie`);
      }
      ok(cookieValue(null, 'x') === null && cookieValue({}, 'x') === null, 'a request without headers reads no cookie');
      ok(/const cookieToken = \(req\) => require\('\.\/cookies'\)\.cookieValue\(req, 'baton_m'\);/.test(src('mobile/index.js')) &&
         /return require\('\.\/cookies'\)\.cookieValue\(req, 'CF_Authorization'\);/.test(src('mobile/access.js')), 'both cookie readers use the shared helper');
    }

    // ---------------------------------------------------------------- dead code is gone and nothing named it
    {
      const all = ['mobile/index.js', 'mobile/public/app.js', 'mobile/public/index.html', 'mobile/public/settings-ui.js'].map(src).join('\n');
      for (const name of ['runningTaskCount', 'startDefaultsCached', 'modelKey']) ok(!new RegExp('\\b' + name + '\\b').test(all), `${name} (never called) is removed`);
    }

    // ---------------------------------------------------------------- over HTTP: a bad cookie no longer breaks sign-in
    {
      const Hn = require('./mobile-harness');
      const w = Hn.world('g842h-cookie');
      const d = await Hn.boot(w);
      try {
        const withBearer = await Hn.request(d.app, '/api/bootstrap', { token: d.token, headers: { Cookie: 'baton_m=%E0%A4%A' } });
        ok(withBearer.status === 200, 'a malformed baton_m cookie plus a valid Bearer key signs in (was 500 "URI malformed")', withBearer.status);
        const alone = await Hn.request(d.app, '/api/bootstrap', { headers: { Cookie: 'baton_m=%E0%A4%A' } });
        ok(alone.status === 401, 'a malformed cookie alone is simply not signed in: 401, not 500', alone.status);
        const cf = await Hn.request(d.app, '/api/bootstrap', { cookie: d.token, headers: { Cookie: 'CF_Authorization=%zz; baton_m=' + encodeURIComponent(d.token) } });
        ok(cf.status === 200, 'a malformed CF_Authorization cookie no longer hides a valid baton_m cookie', cf.status);
        const good = await Hn.request(d.app, '/api/bootstrap', { cookie: d.token });
        ok(good.status === 200, 'a good cookie still signs in');
      } finally { await d.stop(); w.cleanup(); }   // not Hn.finish(): it exits before this file's own summary and cleanup
    }
    console.log(`\n${n}/${n} passed`);
  } finally {
    try { fs.chmodSync(path.join(TMP, 'ro'), 0o700); } catch {}
    fs.rmSync(TMP, { recursive: true, force: true });
  }
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
