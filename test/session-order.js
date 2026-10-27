const fs = require('fs'), path = require('path'), vm = require('vm');
const src = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'public', 'app.js'), 'utf8');
const m = src.match(/function sortSessions\(list\) \{[\s\S]*?\n\}\n/);
if (!m) { console.error('sortSessions not found'); process.exit(1); }
const ctx = { state: { sort: 'smart', favs: new Set() } };
vm.createContext(ctx); vm.runInContext(m[0] + ';this.sortSessions = sortSessions;', ctx);
const rows = [
  { id: 'a', awaiting: true, at: 50 }, { id: 'b', running: true, at: 10 }, { id: 'c', at: 99 },
  { id: 'd', awaiting: true, at: 40 }, { id: 'e', running: true, at: 20 },
];
const got = ctx.sortSessions(rows).map(r => r.id).join('');
if (got !== 'ebadc') { console.error('FAIL order ' + got + ' (want ebadc: working, awaiting, rest; newest first inside each)'); process.exit(1); }
console.log('ok working first, then awaiting, then the rest');
ctx.state.favs = new Set(['a', 'c']);
const starred = ctx.sortSessions(rows).map(r => r.id).join('');
if (starred !== 'ebadc') { console.error('FAIL starred order ' + starred + ' (want ebadc: a star never lifts a waiting or idle session above a working one)'); process.exit(1); }
console.log('ok a star lifts a session only within its own group');
