# NOTES-g842d — core-logic tests, the three biggest risks, and what is left

Branch `cloud/g842d`, cut from `main` at 9428fa7 (v0.2.49). Everything was done offline: no network, no
Claude Desktop, no live server or phone. There is no `CLAUDE.md`, `STATE.md` or `DIRECTIVES.md` in the repo.

## What changed

| File | Change |
|---|---|
| `mobile/subusers.js` | **Bug fixes (security).** `find(token)` now accepts only a string that is an own key of `subusers.json`. `revoke(name)` now revokes every live record with that name. |
| `lib/router.js` | **Bug fix.** `tierOf()` takes the highest level matching a model + effort pair, and `escalate()` skips levels that would change nothing. |
| `test/core-logic.js` | **New suite, 103 checks**, added to `npm test` (see below). |
| `test/mobile-subuser-scope.js` | Adds an HTTP-level regression for the sign-in bug, with `?k=`, Bearer and cookie. |
| `package.json` | `npm test` now ends with `node test/core-logic.js`. |

### Fix 1: anyone could sign in to the phone app with `?k=constructor`

`subusers.find()` looked the token up with `db[token]` on a plain object. `constructor`, `__proto__`,
`toString`, `hasOwnProperty` and every other `Object.prototype` name resolved to a built-in. That built-in
has no `revoked` flag, so it came back as a valid, unrevoked sub-user with no sessions. Proof against the
real daemon (`test/mobile-subuser-scope.js`, before the fix): `GET /api/bootstrap?k=constructor` returned
**200** with no key, and so did `Authorization: Bearer constructor` and `Cookie: baton_m=constructor`.
The `?k=` form also set a one-year `baton_m` cookie (`mobile/index.js:777`), so the access persisted.

A "sub-user" with no sessions could reach everything on the sub-user allowlist: bootstrap (hostname,
debugger state, push key, models, version), `/api/stream`, `/api/build`, `/api/tier`, `/api/permission`.
It could not reach any session, file or write, because each of those checks the (empty) session set.
After the fix, all three ways of sending the key return **401**.

### Fix 2: escalation could loop forever on the same model

Settings › Models lets two levels share a model and effort (for example easy = medium = Sonnet/medium).
`tierOf()` returned the *first* match, so a medium task counted as easy, and `escalate()` "moved it up"
to medium: the same model and effort. `orchestrator.js:116` escalates on every failure with no cap, so a
failing task re-ran on an unchanged model indefinitely, spending tokens each time. `escalate()` now
returns the next level that actually differs, or `null` at the top.

### Fix 3: revoking a reused sub-user name left the live link working

`revoke(name)` acted on the *first* record with that name. After a revoke and a new `create` under the
same name, the first record is the old, already-revoked one. It was revoked again, the call returned
`ok: true`, the CLI printed "revoked. Their link stops working immediately", and the new link kept
working (reproduced before the fix). `revoke` now revokes every live record with the name and reports
how many it revoked.

Each regression fails on the old code: *escalate never returns the pair it started from*, *the token
"constructor" does not sign anyone in*, and *revoking a reused name revokes the live link*.

## The test suite: `test/core-logic.js`

It runs offline in a temp `RELAYMOTE_HOME`, and each guard is shown refusing as well as passing:

- **Router:** classification (trivial, rename, debug, architecture, hard, broad, very long, empty); the
  ladder, defaults and `toModelId`; `tierOf` fallbacks (xhigh → high, unknown → middle); rung clamping;
  the low-confidence bump, `minTier` and `force*`; levels set in Settings; escalation step and top; the
  duplicate-level regression; the climb is bounded.
- **Control guard (loopback API):** loopback hosts pass; rebound hostnames, wrong ports, foreign
  origins, other local ports, `Origin: null`, https origin and `Sec-Fetch-Site: cross-site` are refused;
  every non-GET method is guarded.
- **Sub-users:** create, find, grant, revoke-sessions and revoke; unknown, empty and non-string tokens;
  every `Object.prototype` name; revoking a reused name.
- **File reader:** `:line`; absolute paths inside the folder; `../` escapes; absolute paths outside;
  **symlink escape**; the `proj-evil` prefix trick; key files (`.env`, `*credentials*`, `.pem`);
  binaries; folder listing; `~` expansion (owner only); sibling lookup (owner only; an ambiguous match
  is refused; the session's own folder wins); the 2 MB tail of a large file.
- **Trusted roots:** relative paths and filesystem roots are refused with a reason; list-string
  parsing; `trustPaths` is idempotent; `isTrusted`.
- **Updater:** `cmpVersion`; `listedHash` (binary `*` mode, CRLF, exact names); Ed25519 `verifySums`
  (a good signature, one changed byte, the wrong key, garbage); `assetName`; `installKind`.
- **Settings merge:** nested merge; arrays replaced; a partial level keeps its default; a corrupt
  `settings.json` falls back to defaults.
- **Cloudflare Access reader:** disabled means never trusted; header and cookie extraction.

### Tests run

- `node test/core-logic.js` → **103/103 passed**.
- `node test/mobile-subuser-scope.js` → all checks passed. Against the pre-fix `subusers.js`, the 4 new
  checks FAIL with `[200,200,200]`.
- `npm test` (the full suite, with `APPDATA` and `CLAUDE_CONFIG_DIR` set to empty temp folders as CI
  does) → **exit 0, no FAIL lines**.

## The three biggest risks

### 1. One bearer key controls a machine that runs code with no permission prompts

The phone app is reachable from the internet over the Cloudflare options, and everything behind it rests
on a single 24-byte key. Anyone with the key can send prompts into sessions. Workers run with
`--permission-mode bypassPermissions` (`lib/worker.js:52`, `lib/heal.js:122`). So the key is effectively
remote code execution as the user.

- The key travels in URLs (`?k=` in the pairing link, `mobile/index.js:77`), where browser history,
  screenshots of the QR, proxy logs and `Referer` can leak it. It then becomes a 1-year cookie.
- There is no rate limit or lockout on wrong keys. At 192 bits the key can't be brute-forced; the concern
  is the lack of any signal when someone tries.
- Fix 1 above was a real bypass of this layer. The pattern it came from (a plain-object lookup keyed by
  user input) is worth a grep across the codebase.

**Suggested:** move the key out of URLs after first use (swap `?k=` for a one-time pairing code), log
and throttle failed sign-ins, and keep Cloudflare Access (email login) as the recommended default for
the "Anywhere" modes.

### 2. Workers are trusted far beyond their task

`ensureDefaultTrust()` (`lib/trust.js:45-53`) marks as trusted for Claude Code: the whole **home
folder**, `~/.claude`, the data folder, the results folder and `process.cwd()`, plus every
subdirectory of each `trustedRoots` entry. Combined with `bypassPermissions`, any prompt injection that
reaches a worker (a README, an issue, a web page it reads) runs with the user's full rights and no
prompt. `trustedRoots` refuses filesystem roots, but a root such as `C:\Users` or `/home` is accepted
and trusts every user's profile.

**Suggested:** trust only the task's own folder, drop `home` and `cwd` from the defaults, refuse roots
that are ancestors of the home folder, and give workers a narrower permission mode by default
(`acceptEdits` plus an allowlist), with bypass as an explicit per-task opt-in.

### 3. It writes to and drives Claude Desktop's private internals

Actions go through Claude Desktop's main-process debugger (`Runtime.evaluate` in `lib/desktop.js`,
3,700 lines) and through synthetic clicks. Account sync writes other accounts' session files and the
LevelDB store (`lib/account-sync.js`). None of this is a public API. A Desktop update can change the
store layout or the UI under it. The worst case is not a failed action but a **silent wrong write** to
the user's session store or the wrong account. Separately, the main-process debugger port (9229) is
unauthenticated: while it is on, any local process can run code in Claude Desktop, and the app switches
it back on after every restart (Windows).

The code is visibly defensive: backups before every write, fresh re-checks inside a write lock,
preview before sync, sync for the open account deferred until Desktop is closed. What guards against a
format change is only the author noticing.

**Suggested:** before any write, verify the store's shape (a schema/version fingerprint) and refuse on
an unknown shape. Keep a canary test per Desktop version. Say plainly in the README that while the
debugger is on, any local program can control Claude Desktop.

## Found, not fixed (not clear-cut bugs, or not mine to decide)

1. **`mobile/access.js:88`**: an Access JWT with no `exp` is accepted, and cached for 60 s. Cloudflare
   always sets `exp`, and the signature must still verify, so this is hardening: require `exp`.
2. **`mobile/files.js:34-37`**: `inside()` lower-cases both paths, which is right on Windows and macOS
   but wrong on case-sensitive Linux. There, `/w/Proj` "contains" `/w/proj/...`, a different folder. It
   matters only for a sub-user whose session folder has a sibling differing only in case. Suggest
   lower-casing only on `win32`/`darwin`.
3. **`mobile/files.js:45` (owner only)**: the sibling lookup searches the parents of every root. With
   `~/.claude` as a root, the parent is the home folder, so a bare name such as `config` can resolve to
   `~/.ssh/config` if it is the only match. The key-file filter checks names like `credentials`, `.pem`
   and `id_rsa`, not `.ssh/config`, `.npmrc`, `.netrc` or `.git-credentials` (the last does match
   `credentials`). This is owner-only, and the owner already controls Claude, but it is worth filtering
   dot-folders out of the sibling scan.
4. **`lib/updater.js:48`**: pre-release tags compare as strings, so `1.0.0-rc.10` sorts before
   `1.0.0-rc.9`, and `split('-')` drops everything after a second hyphen. Releases today are plain
   `x.y.z`, so there is no effect yet.
5. **`lib/router.js` `tierOf` fallback**: a task on a model that is not on the ladder is placed by effort
   alone. A `sonnet/max` task therefore counts as the top level, and `escalate()` returns `null` even
   when the top level is a stronger model. The behavior predates this change; it is a design choice for
   the owner.
6. **`lib/orchestrator.js:116`**: auto-escalation has no cap of its own. After Fix 2 it is bounded by the
   number of distinct levels, but a `maxEscalations` setting would make that explicit.
7. **`mobile/subusers.js` `create`** accepts a duplicate live name. `grant` and `revokeSessions` then act
   on the first live record only. Suggest refusing duplicate live names.
8. **Plain-object lookups keyed by input**: a broader sweep for the Fix 1 pattern (`obj[userValue]` on a
   JSON-loaded object) across `lib/` and `mobile/` was not done. `aliases.js`, `roles.js` and
   `account-scope.js` are the first places to look.
