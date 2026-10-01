'use strict';
// fsx.js — the small file helpers that several modules each carried a copy of.
//
// readJson(file, fallback)        parsed JSON, or `fallback` when the file is missing or unreadable.
// writeAtomic(file, text, opts)   write via a temp file + rename, so a reader never sees half a file.
// writeJsonAtomic(file, v, indent, opts)  the same for JSON.stringify(v, null, indent).
//
// writeAtomic creates the parent folder. The temp file is `<file>.<pid>.tmp` unless opts.tmp names
// another one, and opts.fsync flushes it to disk before the rename. If the write or the rename fails,
// the temp file is removed and the error is re-thrown, so a full disk never leaves a stray .tmp behind.
const fs = require('fs');
const path = require('path');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeAtomic(file, text, { tmp = file + '.' + process.pid + '.tmp', fsync = false } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    if (fsync) {
      const fd = fs.openSync(tmp, 'w');
      try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    } else {
      fs.writeFileSync(tmp, text);
    }
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

function writeJsonAtomic(file, value, indent, opts) {
  writeAtomic(file, JSON.stringify(value, null, indent), opts);
}

module.exports = { readJson, writeAtomic, writeJsonAtomic };
