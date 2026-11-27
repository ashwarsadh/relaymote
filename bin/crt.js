#!/usr/bin/env node
'use strict';
// crt — search every Claude session transcript (archived and subagent ones too).
//   crt grep "<words>" [--limit N] [--per N] [--role user|assistant|tool|call|queued] [--since 2026-11-02] [--until 2026-11-04]
//                      [--lane text] [--project text] [--archived|--live] [--recent] [--raw] [--json]
//   crt update [--full]   index what changed (the daemon does this every few minutes)
//   crt status
//   crt show <file> <offset>   the original transcript line behind a hit
const T = require('../lib/transcript-index');
const argv = process.argv.slice(2);
const cmd = argv.shift();
const flags = {}, rest = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) { const k = a.slice(2); if (['archived', 'live', 'recent', 'raw', 'json', 'full'].includes(k)) flags[k] = true; else flags[k] = argv[++i]; }
  else rest.push(a);
}
const out = (s) => process.stdout.write(s + '\n');

if (cmd === 'grep' || cmd === 'search') {
  if (!require('fs').existsSync(T.DB_FILE)) { out('index not built yet - run: crt update'); process.exit(2); }
  const r = T.search(rest.join(' '), {
    limit: +flags.limit || 15, per: +flags.per || 2, role: flags.role, since: flags.since, until: flags.until, lane: flags.lane, project: flags.project,
    archived: flags.archived ? true : flags.live ? false : undefined, recent: !!flags.recent, raw: !!flags.raw,
  });
  if (flags.json) { out(JSON.stringify(r)); process.exit(0); }
  if (r.error) { out(r.error); process.exit(2); }
  for (const h of r.hits) {
    out(`${h.local || h.cli}  ${h.archived ? '[archived] ' : ''}${h.lane || '(no title)'}  · ${h.project}  · ${h.count} hit${h.count > 1 ? 's' : ''}`);
    for (const s of h.snippets) out(`   ${String(s.ts).slice(0, 16)} ${s.role}: ${s.text}`);
  }
  out(`-- ${r.hits.length} sessions, ${r.matched} matching rows, ${r.ms} ms`);
} else if (cmd === 'update') {
  const t = Date.now();
  const r = T.update({ full: !!flags.full, progress: (s, n) => process.stderr.write(`  ${s.changed}/${n} files, ${s.rows} rows, ${Math.round(s.bytes / 1048576)} MB read, ${Math.round((Date.now() - t) / 1000)}s\n`) });
  out(JSON.stringify(r));
} else if (cmd === 'status') {
  out(JSON.stringify(T.status(), null, 1));
} else if (cmd === 'show') {
  out(T.rawLine(rest[0], +rest[1]));
} else {
  out('usage: crt grep "<words>" [--limit N] [--per N] [--role r] [--since D] [--until D] [--lane t] [--project t] [--archived|--live] [--recent] [--raw] [--json]\n       crt update [--full] | crt status | crt show <file> <offset>');
}
