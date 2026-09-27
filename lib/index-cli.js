// index-cli.js — `baton index …`: the project index and transcript intelligence from a terminal.
// Reads and writes only Relaymote's own data folder (<data>/conductor); never drives Claude Desktop.
'use strict';
const path = require('path');

const USAGE = `baton index <verb>
  build [--full] [--os] [--digests]    rebuild the index (--full: no time budget; --os: re-read OS scheduled tasks)
  route "<text>" [--grep <pattern>]    who owns this? (named ids win; aliases/dispatches/tasks boost; AMBIGUOUS refuses)
  who "<pattern>"                      rank sessions by transcript hit count (a miss proves nothing)
  session <id> | tree <id> | masters   a session card · the fleet under a session · masters per group
  progress "<project>"                 plan files with open items + each session's plan → state → pending
  buried [days]                        asks a relay/notice hid (default 14 days)
  learn "<keyword>" "<project>"        routing alias
  tag <id> "a,b"                       manual tags for one session
  log "<query>" <target id> "<reason>" [--confirmed]    record a routing decision
  dispatches [n]                       the last n routing decisions
  tasks [--refresh]                    OS scheduled tasks with owner project
  newproject "<name>" "<purpose>"      folder under settings index.projectsRoot + seed CLAUDE.md + alias
  digest <id> [--since <bytes>]        the lean digest of one session
  where                                where the index files are`;

const flag = (args, f) => args.includes(f);
const opt = (args, f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const plain = args => { const out = []; for (let i = 0; i < args.length; i++) { if (/^--(grep|since)$/.test(args[i])) { i++; continue; } if (!args[i].startsWith('--')) out.push(args[i]); } return out; };
const print = r => console.log(typeof r === 'string' ? r : (r && r.text) ? r.text : JSON.stringify(r, (k, v) => v instanceof Map ? undefined : v, 2));

async function run(argv) {
  const P = require('./projects'), V = require('./index-views'), A = require('./aliases'), O = require('./owner');
  const verb = (argv[0] || 'help').toLowerCase();
  const args = argv.slice(1), pos = plain(args);
  const ix = async () => P.fresh(30 * 60000);
  switch (verb) {
    case 'build': {
      const r = await P.build({ full: flag(args, '--full'), osTasks: flag(args, '--os') ? 'force' : undefined, digests: flag(args, '--digests') || undefined });
      return print({ builtAt: r.builtAt, ms: r.buildMs, counts: r.counts, transcripts: r.transcripts, digests: r.digests, index: P.INDEX_MD });
    }
    case 'route': {
      await ix();
      const r = await O.resolveWithGrep(pos.join(' '), { grep: opt(args, '--grep') });
      return print(r);
    }
    case 'who': { await ix(); const r = await O.whoTouched(pos.join(' ')); if (r) delete r.hitsById; return print(r); }
    case 'session': return print(V.card(await ix(), pos[0]));
    case 'tree': return print(V.tree(await ix(), pos[0]));
    case 'masters': return print(V.masters(await ix()));
    case 'progress': return print(V.progress(await ix(), pos.join(' ')));
    case 'buried': return print(V.buried(await ix(), Number(pos[0]) || 14));
    case 'learn': return print(A.learn(pos[0], pos[1]));
    case 'tag': return print(A.tag(await ix(), pos[0], pos[1]));
    case 'log': return print(A.logDispatch(pos[0], pos[1], pos[2] || '', flag(args, '--confirmed')));
    case 'dispatches': return print(A.dispatches(Number(pos[0]) || 15, P.read()));
    case 'tasks': {
      const x = await ix();
      const r = await require('./ostasks').collect({ projectRoots: Object.values(x.projects).map(p => ({ path: p.path, name: p.name })), force: flag(args, '--refresh') });
      return print(r.rows.map(t => t.error ? `(error) ${t.error}` : `${t.console ? '⚠ ' : '  '}${String(t.name).slice(0, 40).padEnd(40)} ${String(t.status).padEnd(9)} ${String(t.fires).padEnd(9)} owner=${t.owner || '?'}\n      ${t.action}`).join('\n') || 'no scheduled tasks found');
    }
    case 'newproject': return print(P.newProject(pos[0], pos.slice(1).join(' ')));
    case 'digest': {
      const x = await ix();
      const hit = A.findSessions(x, pos[0]);
      if (hit.length !== 1) return print({ error: 'REFUSED', message: `need exactly one session matching "${pos[0]}", got ${hit.length}` });
      const D = require('./digests');
      const u = D.update(hit[0].id, { session: hit[0] });
      if (!u.ok) return print(u);
      return print(D.readDelta(hit[0].id, Number(opt(args, '--since')) || 0).text);
    }
    case 'where': return print({ dir: P.DIR, index: P.INDEX_JSON, markdown: P.INDEX_MD, wiki: P.WIKI_DIR, map: P.MAP_HTML, digests: path.join(P.DIR, 'digests') });
    default: return console.log(USAGE);
  }
}

module.exports = { run, USAGE };
