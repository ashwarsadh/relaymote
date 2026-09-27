// sign-release.js <SHA256SUMS.txt> — write <file>.sig: the base64 Ed25519 signature that lib/updater.js
// checks before an installed copy updates itself. Run by the release workflow with the private key in
// the RELAYMOTE_SIGNING_KEY environment variable (PEM). It refuses to write a signature that the public key
// in lib/updater.js would reject, so a rotated or mistyped secret fails the release instead of
// shipping an update no copy will install.
//
// No key: with RELAYMOTE_REQUIRE_SIGNATURE=1 that is an error; otherwise the release is left unsigned (a
// fork's own builds), and no installed copy will auto-install it.
'use strict';
const fs = require('fs');
const crypto = require('crypto');
const { PUBLIC_KEY, verifySums } = require('../lib/updater');

const file = process.argv[2];
if (!file || !fs.existsSync(file)) { console.error('usage: node scripts/sign-release.js <SHA256SUMS.txt>'); process.exit(2); }
const pem = process.env.RELAYMOTE_SIGNING_KEY || '';
if (!pem.trim()) {
  if (process.env.RELAYMOTE_REQUIRE_SIGNATURE === '1') { console.error('::error::RELAYMOTE_SIGNING_KEY is not set: installed copies would refuse this release'); process.exit(1); }
  console.log('::warning::no RELAYMOTE_SIGNING_KEY: release left unsigned, so no copy will auto-install it');
  process.exit(0);
}
const sums = fs.readFileSync(file, 'utf8');
const sig = crypto.sign(null, Buffer.from(sums), crypto.createPrivateKey(pem)).toString('base64');
if (!verifySums(sums, sig, PUBLIC_KEY)) { console.error('::error::the signing key does not match the public key in lib/updater.js'); process.exit(1); }
fs.writeFileSync(file + '.sig', sig + '\n');
console.log(`signed ${file} (${sums.split('\n').filter(Boolean).length} files); verifies with the key in lib/updater.js`);
