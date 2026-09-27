// mobile-outbox.js — nothing the user typed may be forgotten until the transcript proves it arrived.
// Ported from the private tool's test-outbox.js. Every case is about one rule: a QUEUED message is
// not a DELIVERED message. Runs against a temp RELAYMOTE_HOME, so it can never touch a real outbox.
'use strict';
const H = require('./mobile-harness');
const W = H.world('outbox', { env: true });
const fs = require('fs');
const path = require('path');
const { check: chk } = H;

const outbox = require('../mobile/outbox');
const MIN = 60 * 1000;
const reset = () => { try { fs.unlinkSync(outbox.FILE); } catch {} };
const NL = '\n';

(async () => {
  if (!outbox.FILE.startsWith(W.dir)) { console.error('REFUSING TO RUN: outbox.FILE is not inside the temp world -', outbox.FILE); process.exit(1); }
  reset();

  console.log('--- the incident, replayed ---');
  {
    const e = outbox.add({ session: 's1', text: 'stop the agent session from the phone and verify' });
    outbox.markSent(e.id, { ok: true, delivery: 'queued' });
    chk(outbox.get(e.id).state === 'pending', 'a QUEUED send stays pending -- "queued" is not proof of arrival', outbox.get(e.id).state);
    const r = outbox.reconcile(() => '', Date.now() + 16 * MIN);
    chk(r.suspect.length === 1 && r.suspect[0].id === e.id, 'after 15 minutes with no transcript trace it is raised as suspect', r.suspect.length);
    chk(outbox.get(e.id).text.includes('agent session'), 'and the exact text is still recoverable');
  }

  console.log('\n--- delivery precedence: the weaker claim must win ---');
  {
    const classify = (gen, queued) => queued ? 'queued' : gen ? 'generating' : 'accepted';
    chk(classify(false, false) === 'accepted', 'neither flag -> accepted (weakest evidence)');
    chk(classify(true, false) === 'generating', 'a turn started, nothing queued -> generating');
    chk(classify(false, true) === 'queued', 'a queued chip with no turn -> queued');
    chk(classify(true, true) === 'queued', 'BOTH flags -> queued, never generating');
  }

  console.log('\n--- what confirmation actually looks like ---');
  reset();
  {
    const e = outbox.add({ session: 's1', text: 'hello there, this is the message body' });
    outbox.markSent(e.id, { ok: true, delivery: 'generating' });
    chk(outbox.get(e.id).state === 'pending', 'a busy-looking session is NOT proof: it stays pending until the transcript shows it', outbox.get(e.id).state);
    outbox.markSent(e.id, { ok: true, delivery: 'generating', proven: true });
    chk(outbox.get(e.id).state === 'confirmed' && outbox.pending().length === 0, 'a caller that read it back out of the transcript may confirm it');
  }
  reset();
  {
    const e = outbox.add({ session: 's1', text: 'queued but it did eventually run' });
    outbox.markSent(e.id, { ok: true, delivery: 'queued' });
    const r = outbox.reconcile(() => 'earlier chatter\nqueued but it did eventually run\nmore');
    chk(r.confirmed.length === 1, 'finding the text in the transcript confirms it', r.confirmed.length);
    chk(outbox.pending().length === 0, 'a confirmed message stops being pending');
  }

  console.log('\n--- matching is tolerant of the transcript, but not sloppy ---');
  reset();
  {
    const e = outbox.add({ session: 's1', text: 'line one\n\nline two   with   gaps' });
    outbox.markSent(e.id, { ok: true, delivery: 'queued' });
    chk(outbox.reconcile(() => 'line one line two with gaps').confirmed.length === 1, 'reflowed whitespace still matches');
  }
  reset();
  {
    const e = outbox.add({ session: 's1', text: 'the quick brown fox jumps over the lazy dog again and again' });
    outbox.markSent(e.id, { ok: true, delivery: 'queued' });
    chk(outbox.reconcile(() => 'the quick brown fox').confirmed.length === 0, 'a short coincidental overlap is NOT accepted as delivery');
  }

  console.log('\n--- the outbox never loses its own contents ---');
  reset();
  {
    outbox.add({ session: 's1', text: 'first message that must survive' });
    outbox.add({ session: 's2', text: 'second message in another session' });
    delete require.cache[require.resolve('../mobile/outbox')];
    const fresh = require('../mobile/outbox');
    chk(fresh.pending().length === 2, 'entries survive a full reload of the module -- they live on disk', fresh.pending().length);
    chk(fresh.pending().every(e => e.text.length > 0), 'and their text is intact');
  }

  console.log('\n--- refusals and edges ---');
  reset();
  chk(outbox.add({ session: 's1', text: '   ' }) === null, 'blank text is never recorded');
  chk(outbox.markSent('no-such-id', { ok: true }) === null, 'marking an unknown id is a no-op, not a throw');
  chk(outbox.reconcile(() => '').checked === 0, 'reconciling an empty outbox does no work');
  {
    const e = outbox.add({ session: 's1', text: 'a failed send keeps its text too' });
    outbox.markSent(e.id, { ok: false, error: 'eval timeout' });
    const p = outbox.pending().find(x => x.id === e.id);
    chk(p && p.state === 'failed' && p.text.includes('keeps its text'), 'a FAILED send stays recoverable, with the reason attached', p && p.state);
  }
  {
    const e = outbox.add({ session: 's1', text: 'reconcile must tolerate an unreadable session' });
    outbox.markSent(e.id, { ok: true, delivery: 'queued' });
    let threw = false;
    try { outbox.reconcile(() => { throw new Error('transcript unreadable'); }); } catch { threw = true; }
    chk(!threw, 'a transcript that cannot be read does not take the reconciler down');
    chk(outbox.get(e.id).state === 'pending', 'and the entry is kept, not silently confirmed');
  }
  {
    const e = outbox.add({ session: 's1', text: 'dropped on purpose' });
    outbox.drop(e.id);
    chk(outbox.get(e.id) === null, 'an explicitly discarded message is gone');
  }

  console.log('\n--- the transcript outranks what the send call said ---');
  reset();
  {
    const e = outbox.add({ session: 's1', text: 'dig out that store and build the routines tab' });
    outbox.markSent(e.id, { ok: false, error: 'eval timeout' });
    const r = outbox.reconcile(() => ['earlier', 'dig out that store and build the routines tab', 'later'].join(NL));
    chk(r.confirmed.length === 1, 'a FAILED entry is confirmed once the transcript shows it', r.confirmed.length);
    chk(outbox.pending().length === 0, 'and it stops being reported as lost');
  }
  reset();
  {
    const text = ['@C:\\Users\\you\\uploads\\shot.jpg', 'dig out that store and build the routines tab'].join(NL);
    chk(outbox.needleFor(text).indexOf('dig out that store') === 0, 'the needle skips attachment lines and matches what was typed', outbox.needleFor(text));
    chk(outbox.needleFor('@C:\\only\\path.jpg').indexOf('@C:') === 0, 'an attachment-only message still has something to match on');
    const e = outbox.add({ session: 's1', text });
    outbox.markSent(e.id, { ok: true, delivery: 'queued' });
    chk(outbox.reconcile(() => 'dig out that store and build the routines tab').confirmed.length === 1, 'an attachment-first message is confirmed by its text');
  }

  console.log('\n--- old entries are eventually released ---');
  reset();
  {
    const e = outbox.add({ session: 's1', text: 'ancient unconfirmed message' });
    outbox.markSent(e.id, { ok: true, delivery: 'queued' });
    outbox.reconcile(() => '', Date.now() + outbox.KEEP_MS + MIN);
    chk(outbox.get(e.id) === null, `entries older than ${Math.round(outbox.KEEP_MS / 86400000)} days are dropped, so this cannot grow forever`);
  }

  console.log('\n--- delivery counts however the transcript stored it ---');
  reset();
  {
    const msg = 'So I want you to start a session to research how an AI agent can control my automations';
    const e = outbox.add({ session: 's1', text: msg });
    outbox.markSent(e.id, { ok: true, delivery: 'queued' });
    const r = outbox.reconcile(() => '<system-reminder>' + NL + msg + NL + '</system-reminder>');
    chk(r.confirmed.length === 1, 'a message wrapped in harness framing still counts as delivered', r.confirmed.length);
    chk(outbox.pending().length === 0, 'and the outbox clears instead of nagging for ever');
  }

  console.log('\n--- a message wrapped in framing is still YOUR message ---');
  {
    const sessions = require('../mobile/sessions');
    const framed = '<system-reminder>' + NL + 'The user started your suggested background task.' + NL + '</system-reminder>' + NL + NL + 'So I want you to start a session to research automation.';
    chk(typeof sessions.transcript === 'function', 'the transcript reader is exported');
    chk(typeof sessions.unwrapForTest === 'function', 'unwrap is exported for direct testing');
    const out = sessions.unwrapForTest(framed);
    chk(out.injected === false, 'a framed row carrying real text is NOT treated as noise');
    chk(out.text.indexOf('So I want you') === 0, 'and what survives is exactly what was typed', out.text);
    chk(sessions.unwrapForTest('<system-reminder>' + NL + 'nothing but a note' + NL + '</system-reminder>').injected === true, 'a row that is ONLY framing stays a note');
  }

  console.log('\n--- how far back the reconciler is allowed to look ---');
  {
    const mob = require('../mobile/index.js');
    chk(typeof mob.transcriptTail === 'function', 'the reconciler reads through an exported, testable reader');
    chk(mob.TAIL_BYTES >= 1024 * 1024, 'the window is megabytes of transcript, not a handful of messages', mob.TAIL_BYTES);
    chk(mob.transcriptTail('local_no_such_session_at_all') === '', 'an unknown session yields no text rather than throwing');
    const sess = require('../mobile/sessions');
    await sess.refresh();
    const live = (sess.index().list || []).map(x => ({ id: x.id, s: sess.get(x.id) }))
      .filter(x => { try { const f = x.s && sess.transcriptPath(x.s); return !!(f && fs.statSync(f).size > 600); } catch { return false; } })[0];
    chk(!!live, 'precondition: the demo world has a transcript to read back');
    if (live) {
      const file = sess.transcriptPath(live.s);
      const size = fs.statSync(file).size;
      const tailBytes = fs.readFileSync(file).subarray(size - 200).toString('utf8');
      const tail = mob.transcriptTail(live.id);
      chk(tail.endsWith(tailBytes), 'the tail really ends at the end of the file -- newest rows are always in the window');
      chk(mob.transcriptTail(live.id, 256).length <= 256, 'and the span is honoured, so a huge transcript is never slurped whole');
    }
  }

  console.log('\n--- a message waiting behind a running turn is not late ---');
  {
    reset();
    const text = 'For the transfer between the two accounts, we had that fixed verifier';
    const e = outbox.add({ session: 'busy1', text });
    outbox.markSent(e.id, { ok: true, delivery: 'queued' });
    const late = Date.now() + outbox.SUSPECT_MS + 60000;
    const r1 = outbox.reconcile(() => '', late, () => true);
    chk(r1.suspect.length === 0, 'while the target session is still working, the clock does not run', r1.suspect.length);
    chk(outbox.get(e.id).state === 'pending' && !outbox.get(e.id).suspectedAt, 'and the entry stays pending and unflagged');
    chk(outbox.reconcile(() => '', late, () => false).suspect.length === 1, 'a session that goes idle without it is flagged exactly as before');
    reset();
    const e2 = outbox.add({ session: 'busy2', text });
    outbox.markSent(e2.id, { ok: true, delivery: 'queued' });
    const r3 = outbox.reconcile(() => 'noise ' + text + ' more noise', late, () => true);
    chk(r3.confirmed.length === 1 && outbox.get(e2.id).state === 'confirmed', 'a busy session that HAS taken it is confirmed on the spot');
    reset();
    const e3 = outbox.add({ session: 'busy3', text });
    outbox.markSent(e3.id, { ok: true, delivery: 'queued' });
    chk(outbox.reconcile(() => '', late).suspect.length === 1, 'with no way to ask, an old caller still gets the plain timer');
    chk(H.src('mobile/index.js').indexOf('outbox.reconcile(transcriptTail, Date.now(), busy)') > 0, 'the daemon supplies that answer from the session index it already keeps');
    // The private tool asserted a code COMMENT here; Relaymote ships without it, so assert the behaviour:
    // a session busy before and after the send shows no change -- unobservable, reported as queued.
    const desktop = require('../lib/desktop');
    chk(desktop.changedFrom({ running: true }, { running: true }) === false, 'busy before AND after proves nothing about our message (never read as delivered or failed)');
    chk(/delivery: accepted \? 'generating' : 'queued'/.test(H.src('lib/desktop.js')), 'and an unobservable send is reported as queued, never failed');
    reset();
  }

  console.log('\n--- a multi-line message must confirm ---');
  {
    reset();
    const text = 'The service does not use that number' + NL + 'Uses mine.' + NL + NL + 'Also, as my laptop is on the VPN, give me a prompt';
    outbox.add({ id: 'ob_multiline', session: 'local_conductor', text });
    const rawJsonl = JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + NL;
    chk(rawJsonl.indexOf('number\\nUses') > 0, 'precondition: the transcript really stores the line break as backslash-n');
    const r = outbox.reconcile(() => rawJsonl, Date.now());
    chk(r.confirmed.length === 1, 'a multi-line message is confirmed from the raw JSONL transcript', { confirmed: r.confirmed.length, suspect: r.suspect.length });
    chk(outbox.load()[0].state === 'confirmed', 'and its state is confirmed, so no red box and no Send again');
    reset();
    outbox.add({ id: 'ob_oneline', session: 'local_x', text: 'Auto solve is allowed and nothing else changes here' });
    chk(outbox.reconcile(() => JSON.stringify({ type: 'user', message: { content: 'Auto solve is allowed and nothing else changes here' } })).confirmed.length === 1,
        'a single-line message still confirms from raw JSONL');
  }

  console.log('\n--- confirmation must not go backwards ---');
  {
    reset();
    outbox.add({ id: 'ob_mono', session: 'local_y', text: 'already landed' });
    outbox.markSent('ob_mono', { ok: true, proven: true });
    chk(outbox.get('ob_mono').state === 'confirmed', 'precondition: it is confirmed');
    outbox.markSent('ob_mono', { ok: false, error: 'verify timed out' });
    chk(outbox.get('ob_mono').state === 'confirmed', 'a later failure report CANNOT un-confirm a delivered message', outbox.get('ob_mono').state);
    reset();
  }

  console.log('\n--- the wording is the safety feature ---');
  {
    const a = H.src('mobile/public/app.js');
    chk(a.indexOf('not confirmed after') < 0, 'the UI never tells the user a delivered message was "not confirmed"');
    chk(a.indexOf('delivered, waiting for a reply') > 0, 'it says delivered, waiting for a reply');
    chk(a.indexOf('ob-resend') > 0 && a.indexOf('alreadyLanded') > 0, 'and Send again checks for the earlier copy before sending another');
  }

  H.finish(W);
})().catch(e => { console.error('THREW', e); process.exit(1); });
