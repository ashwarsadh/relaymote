// Where Claude Desktop keeps its bundled CLI. When this cannot be found the sidebar refresh used to
// abort, so every session showed a grey dot; the layout changed once already (a build-hash folder).
const fs = require('fs'), os = require('os'), path = require('path');
const { claudeBin } = require('../lib/worker.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-bin-'));
let fails = 0;
const check = (ok, what, got) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) { fails++; console.log('     ', got); } };
const put = (...p) => { const f = path.join(TMP, ...p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, ''); return f; };

const flatRoot = path.join(TMP, 'flat');
const flat = put('flat', '2.1.200', 'claude.exe');
check(claudeBin([flatRoot]) === flat, 'old layout: <ver>/claude.exe', claudeBin([flatRoot]));

const hashRoot = path.join(TMP, 'hash');
put('hash', '2.1.284', '3f4bed3e44ad', 'claude.exe');
const newest = put('hash', '2.1.286', '635c1867224a', 'claude.exe');
fs.mkdirSync(path.join(hashRoot, '2.1.290'), { recursive: true });            // a version folder still downloading
check(claudeBin([hashRoot]) === newest, 'new layout: <ver>/<build-hash>/claude.exe, newest version with a binary', claudeBin([hashRoot]));

check(claudeBin([flatRoot, hashRoot]) === newest, 'both layouts side by side: highest version wins', claudeBin([flatRoot, hashRoot]));

let threw = false; try { claudeBin([path.join(TMP, 'none')]); } catch { threw = true; }
check(threw, 'nothing installed: a clear error, not a wrong path');

// The sidebar refresh must survive a missing CLI (the dots come from the Desktop DOM, not the CLI).
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const agents = server.slice(server.indexOf('function claudeAgents'), server.indexOf('function claudeAgents') + 600);
check(/try\s*\{\s*bin\s*=\s*worker\.claudeBin\(\)\s*;?\s*\}\s*catch/.test(agents), 'claudeAgents catches a missing CLI instead of aborting the refresh', agents.slice(0, 300));

fs.rmSync(TMP, { recursive: true, force: true });
if (fails) { console.error(fails + ' failed'); process.exit(1); }
console.log('claude-bin: all checks passed');
