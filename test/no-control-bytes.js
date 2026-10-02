// A script that writes source through a shell heredoc can turn "\b" into a backspace byte: a regex
// /\bgzip\b/ silently became one that never matches. No source file may carry such bytes.
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const bad = [];
(function walk(d) {
  for (const n of fs.readdirSync(d, { withFileTypes: true })) {
    if (n.name === 'node_modules' || n.name.startsWith('.git') || n.name === 'dist' || n.name === 'runtime') continue;
    const p = path.join(d, n.name);
    if (n.isDirectory()) walk(p);
    else if (/\.(js|mjs|cjs|html|css|json|md|ps1|sh|iss|yml)$/.test(n.name)) {
      const b = fs.readFileSync(p);
      for (let i = 0; i < b.length; i++) { const c = b[i]; if (c < 32 && c !== 9 && c !== 10 && c !== 13) { bad.push(path.relative(ROOT, p) + ' byte ' + i + ' = 0x' + c.toString(16)); break; } }
    }
  }
})(ROOT);
if (bad.length) { console.error('FAIL control bytes in source:\n  ' + bad.join('\n  ')); process.exit(1); }
console.log('ok   no control bytes in source files');
