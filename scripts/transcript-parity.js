#!/usr/bin/env node
// Live parity check: does Relaymote's reading view hold everything a real session said in a window?
//   node scripts/transcript-parity.js <local_session_id> <fromISO> <toISO>
// Every user message must appear once, and every assistant text and thinking block must be present.
// Exit 0 = parity, 1 = something missing or doubled (printed). Reads only; changes nothing.
'use strict';
const fs = require('fs');
const sessions = require('../mobile/sessions.js');

const [SID, FROM, TO] = process.argv.slice(2);
if (!SID || !FROM || !TO) { console.error('usage: transcript-parity.js <session id> <fromISO> <toISO>'); process.exit(2); }
const inWindow = (t) => !!t && t >= FROM && t <= TO;
const nn = (t) => String(t || '').replace(/\s+/g, ' ').trim();
const INJECTED = /^\s*(<task-notification>|<command-|<local-command-|\[SYSTEM NOTIFICATION)/;

(async () => {
  await sessions.refresh();
  const sess = sessions.get(SID);
  const file = sess && sessions.transcriptPath(sess);
  if (!file) { console.error('no transcript for ' + SID); process.exit(2); }

  const raw = { user: [], peer: [], text: [], thinking: [] };
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    let j; try { j = JSON.parse(line); } catch { continue; }
    if (!inWindow(j.timestamp)) continue;
    const c = j.message && j.message.content;
    if (j.type === 'user' && typeof c === 'string' && !j.isCompactSummary && !INJECTED.test(c)) {
      (j.origin && j.origin.kind === 'peer' ? raw.peer : raw.user).push(nn(c));
    }
    if (j.type === 'assistant' && Array.isArray(c)) {
      for (const b of c) {
        if (b.type === 'text' && nn(b.text)) raw.text.push(nn(b.text));
        if (b.type === 'thinking' && nn(b.thinking)) raw.thinking.push(nn(b.thinking));
      }
    }
  }

  const view = (sessions.transcript(sess, { limit: 5000, maxBytes: 32 * 1024 * 1024 }).messages || []).filter(m => inWindow(m.ts));
  const users = view.filter(m => m.role === 'user' && !m.queued).map(m => nn(m.text));
  const peers = view.filter(m => m.role === 'peer').length;
  const said = view.filter(m => m.role === 'assistant');
  const texts = said.map(m => nn(m.text)).join(' ‖ '), thoughts = said.map(m => nn(m.thinking)).join(' ‖ ');
  // The view clips long blocks, so a block is "present" when its opening is.
  const present = (hay, x) => hay.includes(x.slice(0, 120));
  const report = {
    window: FROM + ' .. ' + TO,
    session: { user: raw.user.length, peer: raw.peer.length, text: raw.text.length, thinking: raw.thinking.length },
    view: { user: users.length, peer: peers, assistantRows: said.length, queuedLeftover: view.filter(m => m.queued).length },
    missingUser: raw.user.filter(u => !users.some(g => g.includes(u.slice(0, 80)))).map(x => x.slice(0, 70)),
    doubledUser: raw.user.filter(u => users.filter(g => g.includes(u.slice(0, 80))).length > 1).map(x => x.slice(0, 70)),
    missingPeer: Math.max(0, raw.peer.length - peers),
    missingText: raw.text.filter(x => !present(texts, x)).map(x => x.slice(0, 70)),
    missingThinking: raw.thinking.filter(x => !present(thoughts, x)).map(x => x.slice(0, 70)),
  };
  const bad = report.missingUser.length + report.doubledUser.length + report.missingPeer + report.missingText.length + report.missingThinking.length;
  console.log(JSON.stringify(report, null, 2));
  console.log(bad ? 'PARITY FAILED' : 'parity ok');
  process.exit(bad ? 1 : 0);
})();
