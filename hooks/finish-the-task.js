#!/usr/bin/env node
// finish-the-task.js — an OPTIONAL Claude Code Stop hook: do not end a turn on a question you can
// answer yourself.
//
// Sessions often finish by asking something the user would answer "yes, do it" to, then sit idle
// until the user types exactly that. When a session is about to stop and its last message ends on a
// question, an offer, or "let me know", this hook blocks the stop ONCE and tells it to pick the
// sensible default and carry on. Claude Code sets stop_hook_active on the next stop, so the session
// always gets to stop after reconsidering: a genuinely critical question (money, deletion, sending to an
// outside party, credentials, anything irreversible) is let through untouched.
//
// Never installed by default. `relaymote hooks install` adds it to <CLAUDE_CONFIG_DIR>/settings.json and
// turns on modules.finishHook; switching the module off in Settings makes it a no-op without editing
// settings.json. Tuning lives in Relaymote settings under `finishHook` (see lib/config.js).
//
// Input (stdin JSON): { session_id, transcript_path, stop_hook_active, hook_event_name }
// Output: {"decision":"block","reason":"…"} on stdout to block; nothing to allow.
// FAIL-OPEN: any error allows the stop. It reads the tail of one file and nothing else.
'use strict';
const fs = require('fs');

const READ_BYTES = 400000;

const ASK_RX = new RegExp('\\b(shall i|should i|should we|do you want|would you like|want me to|let me know|say the word|' +
  'tell me (if|whether|which|what)|please confirm|confirm (and|before|if|that|whether)|your call|' +
  'which (one|option|of these)|pick one|choose one|' +
  'once you (confirm|approve|decide)|if you (want|prefer|agree|approve)|ready when you are|' +
  'go ahead\\?|proceed\\?|ok(ay)? to proceed)\\b', 'i');

// A question about one of these is allowed to stand: the user has to answer it.
const CRITICAL_RX = new RegExp('\\b(delete|deleting|drop table|wipe|pay|payment|refund|purchase|charge the card|' +
  'send (it |this |them )?(to|out)|email (it |this |them )?to|message (it |this |them )?to|publish|go live|' +
  'deploy to (prod|production|live)|force[- ]push|password|credential|api key|secret|token|irreversible|' +
  'cannot be undone|uninstall|format the)\\b|[$€£¥₹]\\s?\\d', 'i');

const DEFAULT_REASON =
  'Standing rule (finish-the-task hook): do not end your turn on a question you can answer yourself. ' +
  'Your last message asked the user something or offered to continue. They would answer "yes, do it" — so do it: pick the ' +
  'sensible default for every open choice, state the assumption in ONE line, and keep working until the task in hand is ' +
  'verifiably complete (run the check, stat the file). If the work is already complete, end with a plain completion statement ' +
  'and no question. Only if the question is genuinely critical — money, deletion, sending to an outside party, credentials, ' +
  'or a fork where a wrong guess wastes real work — restate that ONE question in one line and stop; this hook will not fire ' +
  'again on your next stop. ' +
  'SCOPE: this rule is about not parking work on the user; it is NOT a licence to override a peer. If you asked another ' +
  'session for a routing decision, an owner, or a fact only it holds, that request is IN FLIGHT and this hook does not let you ' +
  'act as though it were refused — two sessions writing the same live file is the failure that creates. Do everything that ' +
  'does not depend on the answer, in full, and NAME the one part you are holding and who you are holding it on: that is a ' +
  'complete turn under this rule.';

function settings() {
  const out = { enabled: true, tailChars: 320, extraAskPatterns: [], extraCriticalPatterns: [], reason: '' };
  try {
    const config = require('../lib/config');
    const cfg = config.get();
    out.enabled = !!(cfg.modules || {}).finishHook;
    Object.assign(out, cfg.finishHook || {});
  } catch {}
  return out;
}

function compile(list) {
  const out = [];
  for (const src of Array.isArray(list) ? list : []) { try { out.push(new RegExp(String(src), 'i')); } catch {} }
  return out;
}

/**
 * The last assistant text after the last REAL user prompt, from the tail of a transcript, and
 * whether the model called AskUserQuestion in that stretch. Tool-result lines do not reset it.
 */
function lastAssistantText(file, readBytes = READ_BYTES) {
  let tail, size;
  try {
    size = fs.statSync(file).size;
    const start = Math.max(0, size - readBytes);
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.allocUnsafe(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      tail = buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return { text: null, asked: false }; }
  let lines = tail.split('\n');
  if (size > readBytes) lines = lines.slice(1);
  let text = null, asked = false;
  for (const line of lines) {
    if (!line.startsWith('{')) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    if (d.isSidechain) continue;
    const role = (d.message && d.message.role) || (d.type === 'user' || d.type === 'assistant' ? d.type : null);
    const content = d.message && d.message.content;
    if (role === 'user') {
      const real = typeof content === 'string' ||
        (Array.isArray(content) && content.some(b => b && b.type === 'text') && !content.some(b => b && b.type === 'tool_result'));
      if (real) { text = null; asked = false; }
      continue;
    }
    if (role === 'assistant' && Array.isArray(content)) {
      if (content.some(b => b && b.type === 'tool_use' && b.name === 'AskUserQuestion')) asked = true;
      const t = content.filter(b => b && b.type === 'text').map(b => b.text || '').join(' ').trim();
      if (t) text = t;
    }
  }
  return { text, asked };
}

/** Pure decision: { block, reason?, why } for one Stop-hook input. */
function decide(input, opts = {}) {
  const s = { ...settings(), ...opts };
  if (!s.enabled) return { block: false, why: 'disabled' };
  if (!input || input.stop_hook_active) return { block: false, why: 'second stop' };
  const file = input.transcript_path;
  if (!file || !fs.existsSync(file)) return { block: false, why: 'no transcript' };
  const { text, asked } = lastAssistantText(file, s.readBytes || READ_BYTES);
  if (!text && !asked) return { block: false, why: 'no assistant text' };
  const n = Number(s.tailChars) > 0 ? Number(s.tailChars) : 320;
  const tail = String(text || '').slice(-n).replace(/\s+/g, ' ').trim();
  const isAsk = asked || tail.endsWith('?') || ASK_RX.test(tail) || compile(s.extraAskPatterns).some(r => r.test(tail));
  if (!isAsk) return { block: false, why: 'not a question' };
  if (CRITICAL_RX.test(tail) || compile(s.extraCriticalPatterns).some(r => r.test(tail))) return { block: false, why: 'critical question may stand' };
  return { block: true, why: 'answerable question', reason: String(s.reason || '').trim() || DEFAULT_REASON };
}

function main() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', c => { raw += c; });
  process.stdin.on('end', () => {
    try {
      const d = decide(JSON.parse(raw || '{}'));
      if (d.block) process.stdout.write(JSON.stringify({ decision: 'block', reason: d.reason }));
    } catch {}
  });
}

if (require.main === module) { try { main(); } catch {} }

module.exports = { decide, lastAssistantText, ASK_RX, CRITICAL_RX, DEFAULT_REASON };
