'use strict';
// g1712: the Stop-hook block cap ("A hook blocked the turn from ending 9 consecutive times") is detected,
// and only a session that was doing real work (tool calls) qualifies for a relay continuation.
const fs = require('fs');
const os = require('os');
const path = require('path');
const resume = require('../lib/resume');

let fails = 0;
const check = (ok, name, got) => { console.log((ok ? 'ok   ' : 'FAIL ') + name + (ok ? '' : ' — got ' + JSON.stringify(got))); if (!ok) fails++; };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blockcap-'));
const L = o => JSON.stringify(o);
const t = s => `2026-10-12T00:00:${String(s).padStart(2, '0')}Z`;
const prompt = (s, text, extra = {}) => L({ type: 'user', timestamp: t(s), message: { role: 'user', content: text }, ...extra });
const said = (s, text) => L({ type: 'assistant', timestamp: t(s), message: { role: 'assistant', content: [{ type: 'text', text }] } });
const tool = s => L({ type: 'assistant', timestamp: t(s), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: {} }] } });
const result = s => L({ type: 'user', timestamp: t(s), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] } });
const feedback = s => prompt(s, 'Stop hook feedback:\nkeep going', { isMeta: true });
const cap = s => L({ type: 'system', subtype: 'informational', timestamp: t(s), content: 'A hook blocked the turn from ending 9 consecutive times — overriding and ending turn.' });
const write = (name, lines) => { const f = path.join(dir, name); fs.writeFileSync(f, lines.join('\n') + '\n'); return f; };

const working = resume.transcriptCapStop(write('working.jsonl', [prompt(1, 'do the job'), tool(2), result(3), said(4, 'step done'), feedback(5), tool(6), result(7), said(8, 'more'), cap(9)]));
check(working && working.toolUses === 2, 'a working session stopped by the cap is found, with its tool calls counted', working);

const talking = resume.transcriptCapStop(write('talking.jsonl', [prompt(1, 'wait for FINISHTEST'), said(2, 'waiting'), feedback(3), said(4, 'still waiting'), cap(5)]));
check(talking && talking.toolUses === 0, 'a talk-only session is found with zero tool calls (so the relay skips it)', talking);

const after = resume.transcriptCapStop(write('after.jsonl', [prompt(1, 'x'), tool(2), result(3), cap(4), prompt(5, 'human typed again')]));
check(after === null, 'activity after the cap means the session is not stopped by it', after);

const none = resume.transcriptCapStop(write('none.jsonl', [prompt(1, 'x'), said(2, 'done')]));
check(none === null, 'an ordinary finished turn is not a cap stop', none);

const scoped = resume.transcriptCapStop(write('scoped.jsonl', [prompt(1, 'old'), tool(2), result(3), tool(4), result(5), said(6, 'ok'), prompt(7, 'new task'), said(8, 'talk'), feedback(9), cap(10)]));
check(scoped && scoped.toolUses === 0, 'tool calls before the latest prompt do not count', scoped);

check(resume.CAP_RX.test('A hook blocked the turn from ending 201 consecutive times — overriding'), 'the cap message matches at any count');
check(resume.CAP_DEFAULTS.capMaxPerDay > 0 && resume.config().capMessage.includes('g1712'), 'relay is budgeted and labelled');

fs.rmSync(dir, { recursive: true, force: true });
if (fails) { console.log(fails + ' failure(s)'); process.exit(1); }
console.log('block-cap: all passed');
