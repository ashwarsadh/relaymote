// A compaction summary is written to the transcript as a "user" row. Desktop shows it as one collapsed
// "Session compacted" row; Relaymote must not show it as something he typed.
const fs = require('fs'), path = require('path');
const { flattenForTest: flatten } = require('../mobile/sessions.js');
let fails = 0;
const check = (ok, what, got) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) { fails++; console.log('     ', JSON.stringify(got)); } };

const summary = 'This session is being continued from a previous conversation that ran out of context.\n\nSummary:\n1. Primary Request';
let r = flatten({ type: 'user', isCompactSummary: true, isVisibleInTranscriptOnly: true, timestamp: '2026-10-03T00:00:00Z',
                  message: { role: 'user', content: summary } });
check(r && r.role === 'compact', 'string summary is a compact row, not a user row', r);
check(r && r.text.includes('Primary Request'), 'the full summary text is kept for expanding', r && r.text.slice(0, 60));

r = flatten({ type: 'user', isCompactSummary: true, message: { role: 'user', content: [{ type: 'text', text: summary }] } });
check(r && r.role === 'compact', 'block-array summary is a compact row too', r);

r = flatten({ type: 'user', message: { role: 'user', content: 'hello' } });
check(r && r.role === 'user', 'an ordinary message is still his', r);

// The client renders it collapsed under "Session compacted" and as its own row, never as msg user.
const app = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'public', 'app.js'), 'utf8');
check(/m\.role === 'compact'\)\s*\{\s*out \+= `<details class="peer compact"><summary>Session compacted/.test(app), 'app.js renders a collapsed "Session compacted" row');
check(/const theirs = [^;]*m\.role === 'compact'/.test(app), 'it stands as its own row in the flow');

if (fails) { console.error(fails + ' failed'); process.exit(1); }
console.log('compact-summary: all checks passed');
