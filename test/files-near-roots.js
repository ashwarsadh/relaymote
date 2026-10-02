// A link relative to the folder ABOVE a session's own (e.g. "development\payroll\RULES.md" written
// from a session in "<root>\email analyzer") and an absolute path beside the session folders both open
// for the owner; nothing outside opens, and a non-owner gets neither.
const fs = require('fs'), os = require('os'), path = require('path');
const files = require('../mobile/files.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-near-'));
const top = path.join(TMP, 'work');
const proj = path.join(top, 'email-proj');
const other = path.join(top, 'development', 'payroll', 'analysis');
fs.mkdirSync(proj, { recursive: true }); fs.mkdirSync(other, { recursive: true });
fs.writeFileSync(path.join(other, 'RULES.md'), '# Rules\n');
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-out-'));
fs.writeFileSync(path.join(outside, 'x.md'), 'no');
let fails = 0;
const check = (ok, what, r) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) { fails++; console.log('     ', JSON.stringify(r)); } };
const opt = { roots: [proj], cwd: proj, siblings: true };
const sep = path.sep;
const rel = ['development', 'payroll', 'analysis', 'RULES.md'].join(sep);
let r = files.readFile(rel, opt);
check(r.ok && r.kind === 'text' && /# Rules/.test(r.text || r.content || JSON.stringify(r)), 'relative to the folder above the session opens', r);
r = files.readFile(path.join(other, 'RULES.md'), opt);
check(r.ok, 'absolute path beside the session folders opens', r);
r = files.readFile(rel, { ...opt, siblings: false });
check(!r.ok, 'a non-owner does not get the parent-folder lookup', r);
r = files.readFile(path.join(outside, 'x.md'), opt);
check(!r.ok, 'an absolute path outside every nearby folder is refused', r);
fs.rmSync(TMP, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true });
if (fails) { console.error(fails + ' failed'); process.exit(1); }
console.log('files-near-roots: 4 checks passed');
