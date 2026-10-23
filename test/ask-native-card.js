// ask-native-card.js — replay of 24-Oct-2026 02:02 IST (Ashwar: "Relaymote error. Fix the bug"). The session asked
// "Should I go ahead on your phone?" with AskUserQuestion. Claude Desktop 3.x draws that as a
// [data-engine-native="AskUserQuestion"] card with no "Dismiss question" button, so:
//   - his tap on "Yes, use my S24" came back "Answer failed: NO_QUESTION";
//   - the permission reader took "No, leave my phone" for a Deny button and showed the card as "PERMISSION NEEDED",
//     with the two options glued together as its text.
// CARD below is that card exactly as the PC drew it (read from the live DOM, long class lists shortened). The page
// scripts run in a real headless Edge/Chrome; with no browser on the machine the DOM half is skipped, not faked.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const A = require('../mobile/answer');
const P = require('../mobile/permission');

let fails = 0;
const check = (ok, what, got) => { console.log((ok ? 'ok   ' : 'FAIL ') + what + (ok || got === undefined ? '' : '  ' + JSON.stringify(got))); if (!ok) fails++; };

const Q = "The Conductor delegated the S24 playback test to me: play #45 in the podcast app, turn the screen off and on 10 times over about 5 minutes, read the lock-screen media state each time, screenshot a partly-heard card, then stop playback. I won't touch volume or settings, and I'll stop if you're using the phone. Should I go ahead on your phone?";
const CARD = `<div data-approval-card-root="" style="display: contents;"><div data-engine-native="AskUserQuestion" style="display: contents;"><div style="display: contents;"><div tabindex="-1" role="group" aria-label="${Q}" data-approval-card-root="" data-skip-approval-enter="" data-approval-presentation="card" class="x"><div class="bg-alpha-1 px-lg flex gap-md py-md items-center"><div class="x">${Q}</div></div><span class="contents" data-approval-allow=""><div class="flex flex-col"><button type="button" aria-pressed="true" class="x"><span aria-hidden="true" data-checked="" class="x"><span class="epitaxy-radio-mark-dot"></span></span><div class="flex min-w-0 flex-1 flex-col gap-xs select-text"><div class="x">Yes, use my S24</div><div class="x">Run the 5-minute test now, under the adb rules (check that you're not using it first, no volume or settings changes).</div></div></button><button type="button" aria-pressed="false" class="x"><span aria-hidden="true" data-unchecked="" class="x"></span><div class="flex min-w-0 flex-1 flex-col gap-xs select-text"><div class="x">No, leave my phone</div><div class="x">Skip the real-phone test. You'll re-test the app yourself.</div></div></button><div class="x"><button type="button" aria-pressed="false" aria-label="Other" class="x"></button><div aria-hidden="true" class="pointer-events-none contents text-body text-primary"><span aria-hidden="true" data-unchecked="" class="x"></span><span aria-hidden="true">Other</span></div></div></div></span><div class="x"><span class="contents" data-approval-allow=""><button type="button" data-cds="Button" class="x"><span aria-hidden="true" class="x"><span data-cds-part="paint" class="x"></span></span><span class="inline-flex min-w-0 items-center gap-1 ">Skip</span></button><button type="button" data-cds="Button" class="x" aria-keyshortcuts="Control+Enter"><span aria-hidden="true" class="x"><span data-cds-part="paint" class="x"></span></span><span class="inline-flex min-w-0 items-center gap-1 ">Submit<span aria-hidden="true" data-cds="Shortcut" data-variant="keycap" class="x"><kbd class="x">Ctrl</kbd><kbd class="x"><span aria-hidden="true">⏎</span><span class="sr-only select-none">Enter</span></kbd></span></span></button></span></div></div></div></div></div>`;

// ---- 1. the fallback: a tap is never lost ----
check(A.answersAsText([{ labels: ['Yes, use my S24'], other: '' }]) === 'Yes, use my S24', 'his tap becomes the message "Yes, use my S24"');
check(A.answersAsText([{ labels: [], other: 'only on Sunday' }]) === 'only on Sunday', 'a typed Other answer is sent as typed');
check(A.answersAsText([{ labels: ['A'] }, { labels: ['B', 'C'] }]) === '1. A\n2. B, C', 'several questions are numbered');
check(A.shouldFallBack({ ok: false, error: 'NO_QUESTION' }), 'NO_QUESTION falls back to a message');
check(A.shouldFallBack({ ok: false, error: 'OPTION_NOT_FOUND', answered: [] }), 'a vanished option falls back too');
check(!A.shouldFallBack({ ok: false, error: 'OPTION_NOT_FOUND', answered: [{ q: 1 }] }), 'not after part of the widget was already answered (no double answer)');
check(!A.shouldFallBack({ ok: false, error: 'CDP_UNAVAILABLE' }) && !A.shouldFallBack({ ok: true }), 'a PC that cannot be reached, or a success, is not re-sent');
const server = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'index.js'), 'utf8');
check(/shouldFallBack\(out\) \? answersAsText\(body\.answers\)/.test(server) && /fallback: 'message', sentText: text/.test(server), '/api/answer sends the tap as a message when the answer cannot be pressed');
const app = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'public', 'app.js'), 'utf8');
check(/r\.fallback === 'message'/.test(app) && /your answer went as a message/.test(app), 'the toast says it went as a message');
check(/!\(state\.question && state\.question\.questions\) \? perm : null/.test(app), 'an open question is never also drawn as "Permission needed"');

// ---- 2. the page scripts against the real card, in a real browser ----
function browser() {
  const c = [process.env.CHROME_BIN,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  return c.find(p => p && fs.existsSync(p)) || null;
}
const bin = browser();
if (!bin) {
  console.log('skip DOM replay: no Edge/Chrome on this machine');
} else {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'relaymote-ask-'));
  const probes = {
    state: A.STATE_JS,
    perm: P._READ_JS,
    clickNo: A._js.clickOptionJs('No, leave my phone'),
    clickYes: A._js.clickOptionJs('Yes, use my S24'),
    other: A._js.clickOptionJs('Other'),
    submit: A._js.clickChromeJs('submit'),
  };
  const page = `<!doctype html><meta charset="utf-8"><body>${CARD}<pre id="out"></pre><script>
var R = {}; var P = ${JSON.stringify(probes)};
for (var k in P) { try { R[k] = (0, eval)(P[k]); } catch (e) { R[k] = 'THREW ' + e.message; } }
document.getElementById('out').textContent = '@@' + JSON.stringify(R) + '@@';
</script>`;
  const file = path.join(tmp, 'card.html');
  fs.writeFileSync(file, page);
  const r = spawnSync(bin, ['--headless=new', '--disable-gpu', '--no-sandbox', '--user-data-dir=' + path.join(tmp, 'profile'),
    '--virtual-time-budget=3000', '--dump-dom', 'file:///' + file.replace(/\\/g, '/')], { encoding: 'utf8', timeout: 60000, windowsHide: true });
  const m = /@@(.*)@@/.exec((r.stdout || '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'"));
  check(!!m, 'the browser ran the page scripts', (r.stderr || '').slice(0, 300));
  if (m) {
    const R = JSON.parse(m[1]);
    const st = JSON.parse(R.state || '{}');
    check(st.widget === true && st.native === true, 'the 3.x card IS a question widget (was NO_QUESTION)', st);
    check(JSON.stringify((st.options || []).map(o => o.text)) === JSON.stringify(['Yes, use my S24', 'No, leave my phone']),
      'options read as their labels, not label+description glued', st.options);
    check(st.hasSubmit && st.submitEnabled && !st.hasNext, 'Submit is found although it reads "SubmitCtrl⏎Enter"', st);
    check(/^The Conductor delegated the S24 playback test/.test(st.question || ''), 'the question text is the card\'s own', st.question);
    check(st.index === 1 && st.total === 1, 'one question', st);
    check(R.clickYes === 'already' && R.clickNo === 'clicked', 'a tap presses the right option (Yes is pre-selected, No is clicked)', R);
    check(R.other === 'clicked', '"Other" (an aria-labelled button now) is found', R.other);
    check(R.submit === 'clicked', 'Submit is pressed', R.submit);
    const perm = JSON.parse(R.perm || '{}');
    check(perm.present === false, 'the question card is NOT read as a permission prompt (no "PERMISSION NEEDED")', perm);
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}

if (fails) { console.error(fails + ' failed'); process.exit(1); }
console.log('ask-native-card: all checks passed');
