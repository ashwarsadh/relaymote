// transcript-index.js — the transcript search index, on a fake projects tree: Devanagari/Tibetan words, archived lanes, subagent
// files, incremental appends, <system-reminder> stripping, a deleted file keeping its rows, and the relaymote_transcripts tool.
'use strict';
try { require('node:sqlite'); } catch { console.log('skip: this Node has no node:sqlite (needs 22.13+)'); process.exit(0); }
const fs = require('fs'), os = require('os'), path = require('path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crt-'));
process.env.CRT_PROJECTS = path.join(root, 'projects');
process.env.CRT_SESSIONS = path.join(root, 'sessions');
process.env.CRT_DIR = path.join(root, 'idx');
process.env.CRT_DB = path.join(root, 'idx', 'index.db');
const T = require('../lib/transcript-index');
let failed = 0;
const check = (ok, name, x) => { console.log((ok ? 'ok   ' : 'FAIL ') + name + (!ok && x !== undefined ? '  ' + JSON.stringify(x).slice(0, 300) : '')); if (!ok) failed++; };

const proj = path.join(root, 'projects', 'D--work-personal');
fs.mkdirSync(path.join(proj, 'cli-1', 'subagents'), { recursive: true });
fs.mkdirSync(path.join(root, 'sessions', 'acct', 'org'), { recursive: true });
const line = (o) => JSON.stringify(o) + '\n';
const f1 = path.join(proj, 'cli-1.jsonl');
fs.writeFileSync(f1,
  line({ type: 'custom-title', customTitle: 'Dolma voice notes' }) +
  line({ type: 'user', timestamp: '2026-11-02T10:00:00Z', message: { role: 'user', content: 'please transcribe दोल्मा की आवाज voice note <system-reminder>SECRETWORD</system-reminder>' } }) +
  line({ type: 'assistant', timestamp: '2026-11-02T10:01:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'བཀྲ་ཤིས་བདེ་ལེགས transcribed the baby maid note' }] } }) +
  line({ type: 'user', timestamp: '2026-11-02T10:02:00Z', message: { role: 'user', content: [{ type: 'tool_result', content: [{ type: 'text', text: 'result mentions meher' }] }] } }) +
  line({ type: 'api-request-blob', blob: 'x'.repeat(5000) + ' blobword' }));
fs.writeFileSync(path.join(proj, 'cli-1', 'subagents', 'agent-a.jsonl'), line({ type: 'assistant', timestamp: '2026-11-03T09:00:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'subagent saw nepali नमस्ते' }] } }));
fs.writeFileSync(path.join(root, 'sessions', 'acct', 'org', 'local_x1.json'), JSON.stringify({ sessionId: 'local_x1', cliSessionId: 'cli-1', title: 'Dolma lane', cwd: 'D:\\work\\personal', isArchived: true, lastActivityAt: 5 }));

(async () => {
  const st = T.update({ noLock: true });
  check(st.changed === 2 && st.rows >= 4, 'first build reads both transcripts (main and subagent)', st);
  let r = T.search('दोल्मा');
  check(r.hits.length === 1 && r.hits[0].local === 'local_x1' && r.hits[0].archived === true && r.hits[0].lane === 'Dolma lane', 'a Devanagari word finds the archived lane, with its Desktop id and title', r.hits);
  check(T.search('བཀྲ་ཤིས་བདེ་ལེགས').hits.length === 1, 'a Tibetan phrase is found');
  check(T.search('नमस्ते').hits[0].cli === 'cli-1', 'a subagent transcript is attributed to its parent session');
  check(T.search('meher').hits[0].snippets[0].role === 'tool', 'tool results are searched');
  check(T.search('SECRETWORD').hits.length === 0, '<system-reminder> text is not indexed');
  check(T.search('blobword').hits.length === 0, 'blob lines are skipped');
  check(T.search('voice note', { role: 'assistant' }).hits.length === 0 && T.search('voice note', { role: 'user' }).hits.length === 1, 'role filter');
  check(T.search('baby maid', { since: '2026-11-02', until: '2026-11-03' }).hits.length === 1 && T.search('baby maid', { since: '2026-11-04' }).hits.length === 0, 'date filter');
  check(T.search('transcrib*').hits.length === 1, 'prefix search');
  check(T.search('voice', { archived: false }).hits.length === 0, 'live-only filter excludes the archived lane');
  check(/\[दोल्मा\]/.test(T.search('दोल्मा').hits[0].snippets[0].text), 'the snippet marks the matched word');

  // incremental: an appended line is read, old rows not duplicated
  fs.appendFileSync(f1, line({ type: 'user', timestamp: '2026-11-04T08:00:00Z', message: { role: 'user', content: 'appended later zebra' } }));
  const st2 = T.update({ noLock: true });
  check(st2.changed === 1 && T.search('zebra').hits.length === 1 && T.search('दोल्मा').hits[0].count === 1, 'an appended line is added once, nothing re-read twice', st2);
  // a half-written last line waits for its newline
  fs.appendFileSync(f1, '{"type":"user","message":{"role":"user","content":"partial yak');
  T.update({ noLock: true });
  check(T.search('yak').hits.length === 0, 'a half-written line is not indexed yet');
  fs.appendFileSync(f1, ' done"}}\n');
  T.update({ noLock: true });
  check(T.search('yak').hits.length === 1, 'and is picked up once complete');
  // a deleted transcript keeps its rows
  fs.unlinkSync(f1); T.update({ noLock: true });
  check(T.search('zebra').hits.length === 1, 'a deleted transcript keeps its rows');
  // the status
  const s = T.status();
  check(s.built && s.rows > 0 && s.archivedSessions === 1, 'status reports the index', s);
  // the MCP tool
  const tool = fs.readFileSync(path.join(__dirname, '..', 'mcp', 'relaymote-mcp.js'), 'utf8');
  check(/name: 'relaymote_transcripts'[\s\S]*?slaveSafe: true/.test(tool), 'relaymote_transcripts is a tool every session may call');
  fs.rmSync(root, { recursive: true, force: true });
  console.log(failed ? `\n${failed} failed` : '\nall transcript-index checks passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
