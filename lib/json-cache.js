'use strict';
// json-cache.js — 10-Nov: with the disk saturated, small JSON files read on every tick (chipwatch state, account-sync
// state and caches) held the event loop for seconds. A file is parsed once and its time is looked at no more than
// once a second; callers get their own copy, so changing it changes nothing until they write it.
const fs = require('fs');
const LOOK_MS = 1000;
const cache = new Map();   // file -> { mtime, looked, text }

function readJsonCached(file, dflt) {
  const now = Date.now();
  let c = cache.get(file);
  if (!c || now - c.looked >= LOOK_MS) {
    let m = -1;
    try { m = fs.statSync(file).mtimeMs; } catch {}
    if (!c || c.mtime !== m) {
      let text = null;
      if (m >= 0) { try { text = fs.readFileSync(file, 'utf8'); JSON.parse(text); } catch { text = null; } }
      c = { mtime: m, looked: now, text };
      cache.set(file, c);
      if (cache.size > 200) cache.delete(cache.keys().next().value);
    } else c.looked = now;
  }
  if (c.text === null) return dflt;
  try { return JSON.parse(c.text); } catch { return dflt; }
}

/** After this process writes a file: the next read takes it from disk. */
function forget(file) { cache.delete(file); }

module.exports = { readJsonCached, forget };
