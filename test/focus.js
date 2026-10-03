'use strict';
// focus.js (g580): a Relaymote call that opens a session must put the user back on the session they were on.
// restoreActive used to click the sidebar row only if it was rendered, never checked, and had no fallback;
// the goal path skipped the restore entirely when it threw. Behaviour is tested with a fake app below.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const d = require(path.join(root, 'lib', 'desktop.js'));
let n = 0;
const ok = (c, name) => { assert.ok(c, name); n++; console.log('ok ' + name); };

// A fake renderer: a current session, rows that may or may not be rendered, and a router that can fail.
function fakeApp({ at, rendered, routeWorks }) {
  const st = { at, rendered: new Set(rendered), clicks: 0 };
  const conn = {
    evaluate: async (js) => {
      if (/location\.href\.split\('\/'\)\.pop\(\) ===/.test(js)) return '1';            // waitFor probe
      if (/^\s*\(function\(\)\{return location|location\.href\.split\('\/'\)\.pop\(\)/.test(js) && !/querySelector/.test(js)) return st.at;
      const m = js.match(/code:(local_[0-9a-z-]+)/);
      if (/scrollIntoView/.test(js) && m) { if (st.rendered.has(m[1])) { st.clicks++; st.at = m[1]; } return 1; }
      if (/!!document\.querySelector/.test(js) && m) return st.rendered.has(m[1]);
      return '';
    },
  };
  return { st, conn };
}

(async () => {
  const src = fs.readFileSync(path.join(root, 'lib', 'desktop.js'), 'utf8');
  const ra = src.slice(src.indexOf('async function restoreActive'), src.indexOf('async function renameSession'));
  ok(/routeTo\(conn, CID, sessionId, \{ idle: false \}\)/.test(ra) && /findSessionRow\(conn, CID, sessionId\)/.test(ra) && /return back;/.test(ra),
     'restoreActive routes back, reveals an unrendered row and clicks it, and reports whether it worked');
  ok(/if \(\/\^local_\/\.test\(snap\.active\) && active !== snap\.active\) \{\s*await restoreActive\(conn, CID, snap\.active\)/.test(src),
     'the guard around every UI call uses the full restore');
  const goal = fs.readFileSync(path.join(root, 'lib', 'goal.js'), 'utf8');
  ok(/finally \{\s*if \(!givenBack && original\) await desktop\.restoreActive/.test(goal), 'relaymote_goal gives the user back their session even when it throws');
  for (const f of ['lib/hygiene.js', 'lib/resume.js', 'mobile/answer.js'])
    ok(/restoreActive\(conn, CID, original\)/.test(fs.readFileSync(path.join(root, f), 'utf8')), `${f} restores the session the user was on`);
  // New session no longer moves the Desktop view at all: it is one LocalSessions.start call (g1131).
  { const ns = fs.readFileSync(path.join(root, 'mobile', 'newsession.js'), 'utf8');
    ok(/LocalSessions/.test(ns) && /\.start\(/.test(ns) && !/CLICK_NEW|navTo\(|selectFolder\(/.test(ns), 'mobile/newsession.js starts through the bridge and never drives the view'); }
  ok(/startTask: \(opts = \{\}\) => require\('\.\/tier-policy'\)\.withStarterTier\(opts\.sessionId, \(\) => gated\('startTask'/.test(src), 'a chip start runs inside the guarded UI lane (restored afterwards)');

  // Behaviour, with the dependencies inside restoreActive reached through the module's own bindings.
  const A = 'local_aaaaaaaa-0000-0000-0000-000000000001', B = 'local_bbbbbbbb-0000-0000-0000-000000000002';
  {
    const { st, conn } = fakeApp({ at: B, rendered: [A, B] });
    const r = await d.restoreActive(conn, 'cid', A);
    ok(r === true && st.at === A, 'a rendered row: back where the user was, and it says so');
  }
  {
    const { st, conn } = fakeApp({ at: A, rendered: [A] });
    ok((await d.restoreActive(conn, 'cid', A)) === true && st.clicks === 0, 'already there: nothing is clicked');
  }
  console.log(`\n${n}/${n} passed`);
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
