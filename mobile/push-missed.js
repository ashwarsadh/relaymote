'use strict';
// push-missed.js — 24-Oct (board: "124 alerts to Sagar were dropped 14-23 Oct"). Sagar's phone never subscribed to
// push, so every alert for him was logged DROPPED and nobody told HIM. This counts, per principal, the alerts that
// found no phone of theirs; the phone shows the count with a one-tap "Turn on notifications" until it subscribes.
const fs = require('fs');

function make(file) {
  const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { return {}; } };
  const write = (d) => { try { fs.writeFileSync(file, JSON.stringify(d, null, 2)); } catch {} };
  return {
    /** An alert for `key` reached no phone of theirs. */
    note(key, at = new Date().toISOString()) {
      if (!key) return;
      const d = read();
      const r = d[key] || { n: 0, since: at };
      r.n++; r.last = at;
      d[key] = r; write(d);
    },
    /** Their phone subscribed: the count starts again. */
    clear(key) {
      const d = read();
      if (d[key]) { delete d[key]; write(d); }
    },
    get(key) { return read()[key] || { n: 0, since: null, last: null }; },
  };
}

module.exports = { make };
