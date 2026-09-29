// core-logic.js — the pure and file-backed core that everything else leans on, offline, in a temp
// RELAYMOTE_HOME: task routing and escalation, the loopback control guard, phone sign-in for sub-users,
// the file reader's scope checks, trusted roots, the updater's version/signature helpers, settings
// merge, and the Cloudflare Access token reader. Each guard is shown refusing, not only passing.
'use strict';
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relaymote-core-')));
process.env.RELAYMOTE_HOME = path.join(TMP, 'relaymote');
process.env.CLAUDE_CONFIG_DIR = path.join(TMP, 'claude');
process.env.APPDATA = path.join(TMP, 'appdata');
for (const k of ['RELAYMOTE_STATE_DIR', 'RELAYMOTE_ACCESS_TEAM', 'RELAYMOTE_ACCESS_AUD', 'RELAYMOTE_PORT', 'RELAYMOTE_APP_PORT', 'RELAYMOTE_CDP_PORT']) delete process.env[k];

const root = path.join(__dirname, '..');
const config = require(path.join(root, 'lib', 'config.js'));
const router = require(path.join(root, 'lib', 'router.js'));
const guard = require(path.join(root, 'lib', 'control-guard.js'));
const trust = require(path.join(root, 'lib', 'trust.js'));
const updater = require(path.join(root, 'lib', 'updater.js'));
const subusers = require(path.join(root, 'mobile', 'subusers.js'));
const { readFile } = require(path.join(root, 'mobile', 'files.js'));
const access = require(path.join(root, 'mobile', 'access.js'));

let n = 0;
const ok = (c, name, extra) => { assert.ok(c, name + (extra !== undefined ? '  ' + JSON.stringify(extra).slice(0, 400) : '')); n++; console.log('ok ' + name); };
const setLevels = levels => { fs.writeFileSync(config.SETTINGS_FILE, JSON.stringify({ levels })); config.set({}); };

(async () => {
  try {
    // ---------------------------------------------------------------- router: classification
    {
      const c = router.classifyRules('thanks');
      ok(c.complexity === 'trivial' && c.confidence > 0.9, 'a greeting is trivial and confident', c);
      ok(router.route('thanks').mode === 'inline', 'a trivial prompt is answered inline, not by a worker');
      ok(router.classifyRules('rename the helper to parseDate').type === 'trivial', 'a rename is a trivial task');
      ok(router.classifyRules('why is the login test failing').type === 'debug', 'a "why is X failing" prompt is debugging');
      ok(router.classifyRules('design the sync system end-to-end').complexity === 'complex', 'architecture work is complex');
      const hard = router.classifyRules('fix the race condition in the queue');
      ok(hard.complexity === 'complex' && hard.signals.includes('hard'), 'a race condition lifts a code fix to complex', hard);
      ok(router.classifyRules('design a distributed lock across the codebase').complexity === 'severe', 'architecture + hard + broad is severe');
      ok(router.route('refactor every module').isolate === true, 'a broad task runs isolated');
      const long = router.classifyRules('update ' + 'the thing '.repeat(120));
      ok(long.words > 220 && long.complexity === 'complex', 'a very long prompt is at least complex', long.words);
      ok(router.classifyRules('').complexity === 'moderate' && router.classifyRules(null).words === 0, 'an empty prompt does not throw');
    }
    // ---------------------------------------------------------------- router: ladder and tiers
    {
      setLevels({});
      const L = router.ladder();
      ok(L.map(l => l.level).join() === 'easy,medium,hard,extraHard' && L.every(l => l.model === 'claude-opus-5-5'), 'the default ladder is four levels on the default model');
      ok(L.map(l => l.effort).join() === 'low,medium,high,max', 'default efforts rise low → max');
      ok(router.toModelId('Opus 5.5') === 'claude-opus-5-5' && router.toModelId('claude-sonnet-5') === 'claude-sonnet-5' && router.toModelId('sonnet') === 'sonnet' && router.toModelId('') === '',
        'picker names become model ids; ids and aliases pass through');
      ok(router.tierOf('claude-opus-5-5', 'high') === 2 && router.tierOf('Opus 5.5', 'high') === 2, 'tierOf finds a level by model + effort, from either spelling');
      ok(router.tierOf('some-model', 'xhigh') === 2, 'xhigh falls back to the high level');
      ok(router.tierOf('some-model', 'weird') === 1, 'an unknown pair is treated as the middle level');
      ok(router.rung(-5).level === 'easy' && router.rung(99).level === 'extraHard', 'rung() clamps out-of-range tiers');
      const unsure = router.route('please look at it and do it properly for the thing we talked about yesterday');
      ok(unsure.confidence < 0.6 && unsure.tier >= 2, 'a low-confidence prompt is bumped one level', unsure);
      ok(router.route('thanks', { minTier: 3 }).effort === 'max', 'minTier raises the level');
      const forced = router.route('thanks', { forceModel: 'claude-haiku-4-5-20251001', forceEffort: 'low' });
      ok(forced.model === 'claude-haiku-4-5-20251001' && forced.effort === 'low' && forced.lean === false, 'forceModel / forceEffort win');
      setLevels({ hard: { model: 'Sonnet 5', effort: 'high' } });
      ok(router.rung(2).model === 'claude-sonnet-5', 'a level set in Settings › Models is used, name converted to an id');
    }
    // ---------------------------------------------------------------- router: escalation
    {
      setLevels({});
      const e = router.escalate('claude-opus-5-5', 'low');
      ok(e && e.effort === 'medium', 'escalate moves one level up', e);
      ok(router.escalate('claude-opus-5-5', 'max') === null, 'escalate stops at the top level');
      // Regression: two levels on the same model + effort. Escalating from that pair used to return the
      // same pair (tierOf took the first match), so a failing task re-ran on it with no cap.
      setLevels({ easy: { model: 'claude-sonnet-5', effort: 'medium' }, medium: { model: 'claude-sonnet-5', effort: 'medium' } });
      const up = router.escalate('claude-sonnet-5', 'medium');
      ok(up && !(up.model === 'claude-sonnet-5' && up.effort === 'medium'), 'escalate never returns the pair it started from (duplicate levels)', up);
      ok(up.effort === 'high', 'from a duplicated level it reaches the next distinct one', up);
      setLevels({ hard: { model: 'claude-opus-5-5', effort: 'max' } });
      ok(router.escalate('claude-opus-5-5', 'max') === null, 'hard = extra hard: the top pair has nowhere to go');
      let hops = 0, cur = { model: 'claude-opus-5-5', effort: 'low' };
      setLevels({ medium: { model: 'claude-opus-5-5', effort: 'low' }, hard: { model: 'claude-opus-5-5', effort: 'low' } });
      while ((cur = router.escalate(cur.model, cur.effort)) && hops < 10) hops++;
      ok(hops === 1, 'any ladder is climbed in at most (distinct levels − 1) hops', hops);
      setLevels({});
    }
    // ---------------------------------------------------------------- control guard (loopback API)
    {
      const P = 8788, req = (method, headers) => guard.check({ method, headers }, P);
      ok(req('GET', { host: '127.0.0.1:8788' }) === null && req('GET', { host: 'localhost:8788' }) === null && req('GET', { host: '[::1]:8788' }) === null, 'loopback hosts on the port are let through');
      ok(req('GET', {}) === null, 'a request without Host (CLI over a raw socket) is let through');
      ok(req('GET', { host: 'evil.example:8788' }).body.error === 'BAD_HOST', 'a rebound hostname is refused (DNS rebinding)');
      ok(req('GET', { host: '127.0.0.1:9999' }).body.error === 'BAD_HOST', 'the right host on the wrong port is refused');
      ok(req('GET', { host: 'LOCALHOST:8788' }) === null, 'the host check ignores case');
      ok(req('POST', { host: '127.0.0.1:8788' }) === null, 'a POST with no Origin (CLI, MCP, tray) is let through');
      ok(req('POST', { host: '127.0.0.1:8788', origin: 'http://127.0.0.1:8788' }) === null, 'the dashboard\'s own origin may POST');
      ok(req('POST', { host: '127.0.0.1:8788', origin: 'https://evil.example' }).body.error === 'CROSS_ORIGIN', 'a POST from another website is refused');
      ok(req('POST', { host: '127.0.0.1:8788', origin: 'http://127.0.0.1:3000' }).body.error === 'CROSS_ORIGIN', 'a POST from another local port is refused');
      ok(req('POST', { host: '127.0.0.1:8788', origin: 'null' }).body.error === 'CROSS_ORIGIN', 'Origin: null (sandboxed frame, file://) is refused');
      ok(req('POST', { host: '127.0.0.1:8788', origin: 'https://127.0.0.1:8788' }).body.error === 'CROSS_ORIGIN', 'only http: is the dashboard\'s origin');
      ok(req('POST', { host: '127.0.0.1:8788', 'sec-fetch-site': 'cross-site' }).body.error === 'CROSS_ORIGIN', 'Sec-Fetch-Site: cross-site is refused even with no Origin');
      ok(req('DELETE', { host: '127.0.0.1:8788', origin: 'http://evil' }).status === 403, 'every non-GET method is guarded');
    }
    // ---------------------------------------------------------------- sub-users (phone sign-in)
    {
      const a = subusers.create('alice', ['s1', 's2', 's1']);
      ok(a.token.length >= 32 && a.sessions.length === 2, 'a sub-user gets a long random token and de-duplicated sessions');
      const f = subusers.find(a.token);
      ok(f && f.name === 'alice' && f.sessions.has('s1') && !f.sessions.has('s3'), 'find() returns the sub-user with exactly their sessions');
      ok(subusers.find('not-a-token') === null && subusers.find('') === null && subusers.find(null) === null, 'unknown and empty tokens are refused');
      // Regression: db[token] on a plain object — these names resolved to Object.prototype members and
      // signed anyone in as an unrevoked sub-user.
      for (const k of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', '__defineGetter__']) {
        ok(subusers.find(k) === null, `the token "${k}" does not sign anyone in`);
      }
      ok(subusers.find(['x']) === null && subusers.find({}) === null, 'a non-string token is refused');
      ok(subusers.grant('alice', ['s3']).sessions.length === 3 && subusers.find(a.token).sessions.has('s3'), 'grant adds a session');
      ok(subusers.revokeSessions('alice', ['s1']).sessions.join() === 's2,s3', 'revoke-sessions removes one');
      ok(subusers.grant('nobody', ['x']).error === 'NOT_FOUND', 'grant to an unknown name fails cleanly');
      ok(subusers.revoke('alice').ok && subusers.find(a.token) === null, 'a revoked sub-user\'s link stops working');
      ok(subusers.grant('alice', ['s9']).error === 'NOT_FOUND', 'a revoked sub-user cannot be granted more');
      ok(subusers.list().some(r => r.name === 'alice' && r.revoked), 'the revoked record is kept for the audit trail');
      // Regression: a name reused after a revoke. revoke() took the FIRST record with the name (the old,
      // already revoked one), reported ok, and the new link kept working.
      const again = subusers.create('alice', ['s4']);
      ok(subusers.find(again.token) !== null, 'a name can be reused after a revoke');
      const rv = subusers.revoke('alice');
      ok(rv.ok && rv.revoked === 1 && subusers.find(again.token) === null, 'revoking a reused name revokes the live link', rv);
      ok(subusers.revoke('alice').revoked === 0 && subusers.revoke('nobody').error === 'NOT_FOUND', 'revoking twice is a no-op; an unknown name is NOT_FOUND');
    }
    // ---------------------------------------------------------------- file reader scope
    {
      const proj = path.join(TMP, 'work', 'proj'), other = path.join(TMP, 'work', 'other'), outside = path.join(TMP, 'outside');
      for (const d of [path.join(proj, 'docs'), other, outside]) fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(proj, 'docs', 'a.md'), '# A\n');
      fs.writeFileSync(path.join(proj, '.env'), 'X=1');
      fs.writeFileSync(path.join(proj, 'aws-credentials.json'), '{}');
      fs.writeFileSync(path.join(proj, 'server.pem'), 'k');
      fs.writeFileSync(path.join(proj, 'blob.bin'), 'x');
      fs.writeFileSync(path.join(outside, 'secret.md'), 'nope');
      fs.writeFileSync(path.join(other, 'only-here.md'), 'sibling');
      let linked = false;
      try { fs.symlinkSync(outside, path.join(proj, 'escape'), 'dir'); linked = true; } catch {}
      const sub = { roots: [proj], cwd: proj, siblings: false, home: null };

      const r = readFile('docs/a.md:3', sub);
      ok(r.ok && r.kind === 'text' && r.line === 3 && r.text === '# A\n', 'a relative path with :line resolves in the session folder');
      ok(readFile(path.join(proj, 'docs', 'a.md'), sub).ok, 'an absolute path inside the folder is read');
      ok(readFile('../../outside/secret.md', sub).error === 'OUT_OF_SCOPE', '../ cannot climb out of the folder');
      ok(readFile(path.join(outside, 'secret.md'), sub).error === 'OUT_OF_SCOPE', 'an absolute path outside the folder is refused');
      if (linked) ok(readFile('escape/secret.md', sub).error === 'OUT_OF_SCOPE', 'a symlink inside the folder cannot reach outside it');
      ok(readFile(proj + '-evil/x.md', sub).error === 'OUT_OF_SCOPE', 'a sibling whose name starts with the folder name is not "inside"');
      for (const f of ['.env', 'aws-credentials.json', 'server.pem']) ok(readFile(f, sub).error === 'PRIVATE', `${f} is never shown`);
      ok(readFile('blob.bin', sub).error === 'UNSUPPORTED', 'an unknown binary type is not dumped as text');
      ok(readFile('docs', sub).kind === 'dir' && readFile('docs', sub).entries[0].name === 'a.md', 'a folder is listed');
      ok(readFile('nope.md', sub).error === 'NOT_FOUND' && readFile('', sub).error === 'NO_PATH', 'missing and empty paths say so');
      fs.writeFileSync(path.join(TMP, 'home-note.md'), 'h');
      const tilde = readFile('~/home-note.md', { ...sub, home: null });
      ok(!tilde.ok && tilde.path === path.join(proj, '~', 'home-note.md'), 'a sub-user gets no ~ expansion: ~ stays a folder name inside the project', tilde);
      ok(readFile('~/home-note.md', { roots: [TMP], cwd: proj, home: TMP }).text === 'h', 'the owner\'s ~ is the home folder');
      ok(readFile('only-here.md', sub).error === 'NOT_FOUND', 'a sub-user gets no sibling-folder lookup');
      const owner = { roots: [proj, other], cwd: proj, siblings: true, home: TMP };
      ok(readFile('only-here.md', { ...owner, roots: [proj] }).text === 'sibling', 'the owner finds a file in exactly one sibling project');
      fs.writeFileSync(path.join(proj, 'only-here.md'), 'mine');
      ok(readFile('only-here.md', owner).text === 'mine', 'the session\'s own folder wins over a sibling');
      fs.mkdirSync(path.join(TMP, 'work', 'third'));
      fs.writeFileSync(path.join(TMP, 'work', 'third', 'twice.md'), '1'); fs.writeFileSync(path.join(other, 'twice.md'), '2');
      ok(readFile('twice.md', { ...owner, roots: [proj] }).error === 'AMBIGUOUS', 'two sibling matches are never guessed between');
      const big = path.join(proj, 'big.log');
      fs.writeFileSync(big, 'a'.repeat(2 * 1024 * 1024) + 'TAIL');
      const b = readFile('big.log', sub);
      ok(b.truncated && b.text.endsWith('TAIL') && b.text.length === 2 * 1024 * 1024, 'a large text file returns its last 2 MB');
    }
    // ---------------------------------------------------------------- trusted roots
    {
      const t = trust.trustedRoots(['relative/dir', '/', path.parse(TMP).root, TMP, '', '  ']);
      ok(t.roots.length === 1 && t.roots[0] === TMP, 'only an absolute, non-root folder is accepted', t);
      ok(t.refused.some(x => x.why === 'not an absolute path') && t.refused.some(x => /filesystem root/.test(x.why)), 'relative paths and filesystem roots are refused with a reason', t.refused);
      ok(trust.trustedRoots(`${TMP}\n/;relative`).roots.length === 1, 'a newline/semicolon list string is parsed the same way');
      const p1 = path.join(TMP, 'work', 'proj');
      ok(trust.trustPaths([p1, p1 + '/', p1]).added === 1, 'trusting a folder twice (or with a trailing slash) writes it once');
      ok(trust.isTrusted(p1) && !trust.isTrusted(path.join(TMP, 'outside')), 'isTrusted reflects exactly what was trusted');
      ok(trust.trustPaths([p1]).added === 0, 'trusting an already trusted folder changes nothing');
    }
    // ---------------------------------------------------------------- updater helpers
    {
      const c = updater.cmpVersion;
      ok(c('0.2.10', '0.2.9') === 1 && c('v1.0.0', '1.0.0') === 0 && c('1.0.0', '1.0.1') === -1, 'versions compare numerically, v prefix ignored');
      ok(c('1.0.0', '1.0.0-rc1') === 1 && c('1.0.0-rc1', '1.0.0') === -1, 'a release is newer than its pre-release');
      ok(c('1.2', '1.2.0') === 0, 'a missing patch number counts as 0');
      const sums = 'a'.repeat(64) + '  Relaymote-Setup-1.0.0-x64.exe\n' + 'B'.repeat(64) + ' *other.dmg\r\n';
      ok(updater.listedHash(sums, 'Relaymote-Setup-1.0.0-x64.exe') === 'a'.repeat(64), 'listedHash reads a sha256sum line');
      ok(updater.listedHash(sums, 'other.dmg') === 'b'.repeat(64), 'binary-mode (*) lines and CRLF are read, hash lower-cased');
      ok(updater.listedHash(sums, 'Relaymote-Setup-1.0.0') === null && updater.listedHash(sums, 'missing.exe') === null, 'a name must match exactly');
      const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
      const pem = publicKey.export({ type: 'spki', format: 'pem' });
      const sig = crypto.sign(null, Buffer.from(sums), privateKey).toString('base64');
      ok(updater.verifySums(sums, sig, pem), 'a checksum file signed by the key verifies');
      ok(!updater.verifySums(sums + ' ', sig, pem), 'one changed byte fails verification');
      ok(!updater.verifySums(sums, sig) && !updater.verifySums(sums, 'garbage', pem), 'a signature by another key, or garbage, fails');
      ok(updater.assetName('windows-installer', '1.2.3') === 'Relaymote-Setup-1.2.3-x64.exe' && updater.assetName('portable', '1') === null, 'only the Windows installer self-updates');
      ok(updater.installKind(root) === 'source', 'a git checkout is a source install (never replaces itself)');
    }
    // ---------------------------------------------------------------- settings merge
    {
      fs.writeFileSync(config.SETTINGS_FILE, '{}'); config.set({});
      const s1 = config.set({ modules: { board: true }, trustedRoots: ['/a', '/b'] });
      ok(s1.modules.board === true && s1.modules.app === true, 'a nested patch merges and keeps the other defaults');
      ok(config.set({ trustedRoots: ['/c'] }).trustedRoots.join() === '/c', 'an array is replaced, not merged');
      ok(config.set({ levels: { easy: { model: 'x' } } }).levels.easy.effort === 'low', 'a partial level keeps its default effort');
      fs.writeFileSync(config.SETTINGS_FILE, '{ not json');
      config.set({});
      ok(config.get().appPort === 8790, 'a corrupt settings.json falls back to defaults instead of crashing');
      fs.writeFileSync(config.SETTINGS_FILE, '{}'); config.set({});
    }
    // ---------------------------------------------------------------- Cloudflare Access reader (offline)
    {
      ok(await access.verify('a.b.c') === null, 'with no team/AUD configured, Access tokens are never trusted');
      ok(access.tokenFrom({ headers: { 'cf-access-jwt-assertion': 'H' } }) === 'H', 'the Access header is read first');
      ok(access.tokenFrom({ headers: { cookie: 'x=1; CF_Authorization=a%3Db; y=2' } }) === 'a=b', 'the CF_Authorization cookie is read and decoded');
      ok(access.tokenFrom({ headers: {} }) === null, 'no header or cookie → no token');
    }
    console.log(`\n${n}/${n} passed`);
  } finally { fs.rmSync(TMP, { recursive: true, force: true }); }
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
