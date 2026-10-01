# NOTES-g842h — dead code, duplicated logic, missing error handling

Branch `cloud/g842h`, cut from `main` at a10d5ec (v0.2.51). Everything was done offline: no Claude Desktop,
no network, no live server or phone. Scripts in `scripts/`, `installer/` and `.github/`, `lib/updater.js`,
`lib/account-sync*.js` and `lib/account-scope.js` were not touched. No secrets were read or printed. There is
no `CLAUDE.md`, `STATE.md` or `DIRECTIVES.md` in this repo.

## How the review was done

- **Dead code:** a script listed every top-level `function x` / `const x = (…) =>` in non-test JS and counted
  references to the name across the whole repo, including HTML, PowerShell and the browser scripts. A second
  pass listed every `module.exports` name that no other non-test file uses.
- **Duplication:** a grep for repeated helper shapes (temp file + rename writes, `try { JSON.parse(readFileSync) }`,
  cookie loops, HTML escapers), then a side-by-side read of each copy.
- **Error handling:** read every duplicated helper's failure path, plus the request entry points (`mobile/index.js`
  `handle()` and its wrapper, `server.js`).

## What changed

| Change | Files | Behaviour |
|---|---|---|
| New `lib/fsx.js`: `readJson`, `writeAtomic`, `writeJsonAtomic` | new | — |
| Nine duplicated helpers become one-line wrappers over `fsx` with their old parameters (local names kept, so no call site changed) | `lib/directions.js`, `goals.js`, `projects.js`, `hygiene.js` (`writeAtomic`, and `readJson` in hygiene), `aliases.js` (`readJson`, `writeJson`), `notify.js` (`writeAtomic`, keeps its `<file>.tmp` name), `salvage.js` (keeps its fsync), `summarize.js` (`readJson`, `writeJson`), `reaper.js` (`readJson`) | identical on success; on a failed write the temp file is now removed (the same error is still thrown) |
| New `mobile/cookies.js` `cookieValue(req, name)`, replacing the two copies of the cookie loop | `mobile/index.js` `cookieToken`, `mobile/access.js` `tokenFrom` | identical for every well-formed cookie; an undecodable value now reads as "no cookie" instead of throwing (see Bug 1) |
| Dead code removed | `mobile/index.js`: `runningTaskCount()` (28 lines, drove Claude Desktop and was never called) and `startDefaultsCached()`; `mobile/public/app.js`: `modelKey` | none; nothing referenced them |
| New `test/refactor-g842h.js` (60 checks), added to `npm test` | `test/`, `package.json` | — |

Net change to existing source: about 98 lines removed, 15 added, plus the two small helper modules.

### Bug 1 (fixed, missing error handling): one malformed cookie made every request fail with 500

Both cookie loops called `decodeURIComponent` unguarded. That throws `URIError` on a value that is not valid
percent-encoding (`%E0%A4%A`, `100%`). `resolveIdentity()` reads the Access cookie and the `baton_m` cookie
**before** the `Authorization` header. So the error escaped `handle()`, and the wrapper at `mobile/index.js:1700`
answered **500 "URI malformed"** to every request carrying that cookie, including ones with a valid Bearer key.
A stray or truncated cookie on the app's domain locked the phone out until the cookie was cleared.

This was measured against the real daemon on the old code and then the new code:

| Request | Old | New |
|---|---|---|
| bad `baton_m` cookie + valid Bearer | 500 URI malformed | 200 |
| bad `baton_m` cookie alone | 500 | 401 |
| bad `CF_Authorization` cookie + valid `baton_m` | 500 URI malformed | 200 |

### Bug 2 (fixed, missing error handling): a failed atomic write left its temp file behind

Every copy did write → rename with no cleanup. When the write fails (disk full, permissions) or the rename fails
(the target is a folder, or locked on Windows), `<file>.<pid>.tmp` stayed on disk. With pid-named temp files, the
leftovers pile up across restarts. `fsx.writeAtomic` removes the temp file and re-throws the original error, so
callers see exactly what they saw before.

## Tests proving identical behaviour: `test/refactor-g842h.js`

The removed code is pasted into the test verbatim (`OLD_*`), and old and new run side by side:

- **Writers (6 variants, 4 texts / 10 JSON values each):**
  - identical bytes, file mode, sequence of fs calls (the same temp name, `<file>.<pid>.tmp`, or `<file>.tmp`
    for notify; fsync only for salvage) and rename;
  - the parent folder is created;
  - an existing file is overwritten the same way;
  - a circular value throws the same error and writes nothing.
- **Error paths:**
  - a failed rename throws the same error code, the old copy leaves a `.tmp` and the new one doesn't, and the
    target is untouched;
  - a read-only folder gives EACCES in both.
- **`readJson`:** the same result for valid, empty, corrupt, BOM, array, `null`, a number, a missing file and a
  folder. The fallback is returned by identity.
- **Wiring:** each of the nine modules now calls `fsx` with its old parameters, has no copy of its own left, and
  all of them load (a `const` is not hoisted, so a call at load time would throw).
- **Cookies:**
  - 28 well-formed header/name cases match the old parser (first match wins, `=` inside values kept, decoding);
  - 4 malformed values: the old parser throws `URIError`, the new one returns `null`;
  - over HTTP against the booted daemon, the three cases in the table above, plus a good cookie still signing in.
- **Dead code:** the three names no longer appear in the app's server, browser scripts or HTML.

### Commands run

- `node test/refactor-g842h.js` → **60/60 passed**.
- The HTTP cases were run against the pre-change `mobile/index.js` and `mobile/access.js` (500 in all three) and
  then the new ones (200 / 401 / 200).
- `npm test` (the full suite, with `APPDATA` and `CLAUDE_CONFIG_DIR` set to empty temp folders, as CI does) →
  **exit 0, no FAIL lines**.

## Found, not changed (for the owner)

1. **More inline atomic writes (19 sites), same pattern, not migrated.** These are in `lib/await.js`,
   `board-build.js` (×2), `conductor-access.js`, `desktop.js` (×2), `digests.js`, `organizer.js`, `resume.js`,
   `roles.js`, `transcripts.js`, `trust.js` (fsync), `config.js` `set()`; `mobile/outbox.js`, `push.js`
   (mode 0600), `pushhealth.js`, `routines.js`, `subusers.js`; and `mcp/relaymote-mcp.js`.
   - Each could become one `fsx.writeJsonAtomic` call with no behaviour change, but they were left to keep this
     change reviewable.
   - Several use a plain `<file>.tmp`. That name is shared, so two processes writing the same file can rename
     each other's half-written temp file. The daemon, CLI, tray and MCP server are separate processes, and
     `masters.json` (MCP) and `settings.json` (`config.set`) are written by more than one of them. Moving those
     to the pid-named temp file is the one real gain (inferred risk; not reproduced).
   - `lib/account-scope.js` (×2) is sync-adjacent and was deliberately left alone.
2. **`server.js` turns a malformed JSON body into a 500.** Eight routes (`server.js:373-466`) do
   `JSON.parse(await readBody(req) || '{}')` outside a local try. A bad body reaches the outer catch and answers 500
   with the parser's message, where 400 "bad json" (as in `mobile/index.js`) is meant. This changes a status code,
   so it is listed rather than changed.
3. **Duplicate escapers.** HTML: `lib/board-build.js:250` escapes `&<>"'`, while `lib/index-views.js:192` escapes
   only `&<>"` (no `'`). The `index-views` one is safe only while its output never lands in a single-quoted
   attribute; a shared escaper would remove the doubt. Regex: `lib/directions.js:76` and `lib/transcripts.js:39`
   are identical.
4. **Exports used only by tests, or by no one outside the module.** The scan lists many: test hooks (`_set*`,
   `_reset*`) and module-internal helpers that are exported as well. None is dead, since all are used inside their
   module, so nothing was removed. Two exported functions are referenced nowhere outside their file and not by
   any test: `router.needsModelAssist` and `goals.closeNote`. They are candidates for removal if no external
   tool relies on them.
5. **277 empty `catch {}` blocks.** Most are deliberate best-effort (logging, cache writes, optional files). They
   were not audited one by one. The ones around state that matters (outbox, registry, goals) deserve at least a log
   line, so that a failing disk is visible.
6. **Bare `.then(` chains.** 17 lines in `lib/`, `mobile/` and `server.js` call `.then(` with no `.catch` on the same
   line. Many end in a `.catch` on a later line, so this is a pointer for review, not a list of bugs.
