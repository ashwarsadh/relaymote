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
