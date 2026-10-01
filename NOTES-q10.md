# q10: secret and security audit, plus an auth check of every endpoint

Base: `origin/main` at a10d5ec. Branch: `cloud/q10`. This is a report only: no source file was changed.
Scope: the working tree, all 66 commits reachable from `--all` (every branch, tag and remote ref),
deleted files, commit and tag messages, the committed binaries (PNG/ICO), and every HTTP listener.

Proof script: `test/q10-auth-audit.js` (offline; NOT in `package.json`, and not picked up by
`test/mobile.js`, which only runs `mobile-*.js`). Run it with:

```
node test/q10-auth-audit.js        # needs node_modules (ws); prints FINDING / fine / info lines, exits 0
```

It builds a temp world (temp `RELAYMOTE_HOME`, `CLAUDE_CONFIG_DIR`, `APPDATA`, `HOME`, demo sessions from
`test/make-demo.js`, debugger port 9 so every desktop call fails fast), boots `server.js` with
`windowsHide: true`, stubs `https.get` for the Cloudflare Access JWKS, and deletes the world afterwards.
Its last run printed 23 `FINDING` lines (several per finding ID).

## Summary

| Severity | Count | IDs |
|---|---|---|
| critical | 0 | none |
| high | 1 | B1 |
| medium | 5 | B2, B3, B4, B8, B12 |
| low | 7 | A1, A5, B6, B7, B9, B10, B13 |
| info | 10 | A2, A3, A4, B14, B15, B16, B17, B18, B19, B20 |

The secrets picture is clean. No live credential, private key, `.env`, tunnel credential or VAPID
private key was ever committed. The only real-looking secret is a demo access key shown in a screenshot (A1).

The main auth problem is B1. Any string that names an `Object.prototype` member (`constructor`,
`__proto__`, `toString`, ...) works as a sub-user token on every install, including installs with no
sub-users. That identity has an empty grant, so it cannot send or read transcripts. But it can read the
owner's board page, the machine's hostname and its live client ids. Through B3 it can also receive the
owner's live job results over SSE. This works over the Cloudflare tunnel, and no Access policy sits in
front of a quick tunnel.

---

## Part A: secrets in the tree and in history

### Method

- `git log --all -p` (75,913 lines) was dumped to the scratchpad and scanned for these patterns: PEM private
  keys, `sk-ant-`, `sk-…`, `ghp_/gho_/ghs_/ghu_/github_pat_`, `AKIA…`, `xox?-`, Slack and Discord webhooks,
  `AIza…`, JWTs (`eyJ….eyJ`), `AccountTag|TunnelSecret|TunnelID` (cloudflared credentials), `privateKey`,
  `password =|:`, `Bearer …`, `npm_…`, `trycloudflare.com`, `cloudflareaccess.com`, IPv4 (including
  RFC1918 and Tailscale 100.64/10), emails, `.env`, user-home paths, and `*.internal|*.lan|*.ts.net`.
  A Shannon-entropy pass (at least 24 chars, at least 4.0 bits/char, `package-lock.json` excluded) covered
  every added or removed line. Commit messages and annotated tag messages were scanned the same way.
- Deleted files: `lib/import-ago.js` and `scripts/migrate-from-baton.ps1`, both deleted in a10d5ec. Their
  content is in the `-p` dump and nothing in it matched.
- Every path ever committed (211) was checked for sensitive names (`.env`, `*.pem`, `*key*`, `*secret*`,
  `*cred*`, `cert.pem`, `cloudflared`, `subusers`, `vapid`, `settings`). Only source files matched:
  `mobile/subusers.js`, `mobile/public/settings-ui.js`, `test/mobile-subuser-*.js` and `package*.json`.
- Binaries ever committed: the PNG/ICO files under `assets/`, `docs/img/`, `mobile/public/`, `installer/windows/`.
  All seven `docs/img/*.png` were viewed, plus the older revision of `shot-pair.png`.
- No output in this audit printed a full secret. Matches were redacted to their first 4 characters.

### Findings

**A1 (low): an owner access key in plain text and as a QR code in a screenshot.**
- Location: `docs/img/shot-pair.png`, added in commit 42d94ff ("retake all seven screenshots … demo data only").
  It is still in HEAD.
- The image shows the pairing link `http://127.0.0.1:18799/?k=3myX…[REDACTED]` in full, and the QR code
  encodes the same link. The earlier revision (195c9a7) masked the key (`?k=••••••••`).
- Live or placeholder: inferred to be a throwaway demo key. The port is 18799, not the default 8790; the
  commit says "demo data only"; and the other screenshots show only `test/make-demo.js` data. It is still a
  syntactically valid owner key for whichever install generated it.
- Remediation: check it against every real `~/.relaymote/mobile/secret.json`. If it matches one, rotate:
  Settings › "Issue a new key", or delete `secret.json` and restart. Either way, retake the screenshot with the
  key masked, as 195c9a7 did. Purging the blob with `git filter-repo --path docs/img/shot-pair.png --invert-paths`
  and then re-adding a masked image is optional. That is a recommendation only; it was not run.

**A2 (info): fake secrets in a test fixture.**
- Location: `test/directions.js` (from a3f870f, in HEAD). It defines `const SECRET = 'AbCd…[REDACTED]'` (36 chars)
  and the password `hunt…[REDACTED]`. Both exist to test `redact()`; they are placeholders, not live.
- No action needed. A scanner allowlist entry would stop CI secret scanners from flagging them.

**A3 (info): the release signing key was never committed.**
- `lib/updater.js` holds the Ed25519 public key (SPKI `MCow…[REDACTED]`, first added in d9ecec1). That is
  expected.
- `scripts/sign-release.js` reads the private key only from the `RELAYMOTE_SIGNING_KEY` environment variable.
  `.github/workflows/release.yml:192` maps it from the GitHub secret `BATON_SIGNING_KEY`.
- No `BEGIN … PRIVATE KEY` appears anywhere in history. The tests (`test/updater.js` and its history) create
  throwaway keys with `crypto.generateKeyPairSync('ed25519')` at run time. The VAPID key is created the same
  way at run time (`mobile/push.js:51`) and stored in `~/.relaymote/mobile/push.json` with mode 0600.
- Note: the GitHub secret is still named `BATON_…` after the rename. That is cosmetic.

**A4 (info): emails, hostnames and IPs.**
- Emails in content: only placeholders (`owner@example.com`, `work@example.com`, `you@example.com`).
- Commit metadata: `ashwarsadh@users.noreply.github.com` (64 commits) and `noreply@anthropic.com` (2). These
  are GitHub no-reply addresses, so no personal address leaks.
- Hostnames: only placeholders (`random-words.trycloudflare.com`, `team.` / `myteam.cloudflareaccess.com`,
  `baton.example.com`).
- IPs: only `127.0.0.1` and `0.0.0.0`. The RFC1918 hits are code ranges and `node >=10.x` semver strings.
- Paths: only `C:\Users\you`, `someone`, `x` and `/home/you`.

**A5 (low): `.gitignore` coverage of runtime data.**
- Runtime data lives in `~/.relaymote` (`lib/config.js:20`), outside the repo, so nothing is at risk by default.
  The risk is someone setting `RELAYMOTE_HOME` to a folder inside a checkout.
- Covered: `secret.json`, `push.json`, `subusers.json`, `settings.json`, `.env`, `state/` (holds `tunnel.json`
  and `masters.json`), `uploads/`, `results/`, `auth/`, `*.log`.
- Not covered:
  - `board.html`, `board/` and `board.json` (owner data)
  - `*.jsonl` (inbox, notes, wakes)
  - `goals.json`, `outbox.json`, the TTS cache
  - `*.pem` / `cert.pem` (cloudflared writes it to `~/.cloudflared/cert.pem`, `lib/tunnel.js:53`)
  - cloudflared tunnel credential files (`<uuid>.json`, written by `cloudflared tunnel create`)
  - a `.relaymote/` folder
- Suggested additions: `*.pem`, `.cloudflared/`, `.relaymote/`, `board.html`, `board/`, `*.jsonl`.
- Demo data: `test/make-demo.js` uses only synthetic titles, `/home/you/projects` and random UUIDs; no real
  data leaks. The `docs/img` screenshots show demo data only (A1 aside). Build ids such as `build 2ed0…` are not
  secrets.

---

## Part B: auth on every endpoint

### Listeners found

A grep of the whole repo for `createServer`, `WebSocket.Server`, `WebSocketServer` and `listen(` finds two
production listeners. Every other hit is a test fixture.

1. **Mobile app**: `mobile/index.js:1700` `http.createServer`, port `appPort` (default 8790).
   - It always binds `127.0.0.1`.
   - It also binds `0.0.0.0` in `remote.mode=lan`, and the Tailscale 100.64/10 addresses in `tailscale` mode
     (`wantedAddrs`, `mobile/index.js:1722`).
   - The Cloudflare quick and named tunnels forward to 127.0.0.1 (`lib/tunnel.js:132-141`).
   - Its request handler is `handle()` (`mobile/index.js:746`).
2. **Control API and dashboard**: `server.js:333` `http.createServer`, `127.0.0.1:8788` only (`server.js:665`).
   Every request goes through `lib/control-guard.js` (`server.js:344`).

`mcp/relaymote-mcp.js` speaks stdio, not HTTP. It calls the control API as a client (`daemon()`, line 83).
`hooks/` and `scripts/` start no servers.

### How a request is authenticated (mobile)

`resolveIdentity()` (`mobile/index.js:76-99`) tries these in order, and the first that matches wins:

1. `?k=` in the URL: the owner key (timing-safe compare, `safeEq`, line 60), else a sub-user token
   (`subusers.find`). A `?k=` that matches neither returns 401; nothing later is tried.
2. A Cloudflare Access JWT (`cf-access-jwt-assertion` header or `CF_Authorization` cookie): owner, but only when
   both `remote.access.team` and `remote.access.aud` are set (`mobile/access.js`).
3. The `baton_m` cookie: owner key, else a sub-user token.
4. `Authorization: Bearer`: owner key, else a sub-user token.

Only `/sw.js`, `/manifest.webmanifest` and `/(icon|badge)(-N).(svg|png)` skip authentication (`open`, line 754).
Everything else without an identity gets 401. A valid `?k=` on `/`, `/board` or `/board.html` sets a one-year
`baton_m` cookie (HttpOnly, SameSite=Lax; Secure only behind `X-Forwarded-Proto: https`) and redirects
without the key (line 777).

A **sub-user** may reach only an allowlist (`mobile/index.js:804-815`): GET `/api/bootstrap`, `/api/sessions`,
`/api/file`, `/api/sent-file`, `/api/tier`, `/api/permission`, `/api/build`, `/api/stream`, and POST `/api/send`,
`/api/model`, `/api/effort`, `/api/answer`, `/api/permission/answer`, `/api/queued/cancel` and
`/api/queued/send-now`. Each POST on that list also requires `body.id` to be a granted session (line 1488).
Every other `/api/*` route returns 403 `NOT_AVAILABLE`. Routes handled **before** the allowlist, `/`, `/board`
and `/board.html`, are not covered by it (see B2).

The **control API** (`server.js`) has no credential at all. `lib/control-guard.js` requires a loopback `Host`
on its own port, refuses `Sec-Fetch-Site: cross-site` on non-GET requests, and refuses any non-GET request
whose `Origin` is not `http://127.0.0.1|localhost|[::1]:<port>`. GET, HEAD and OPTIONS always pass the Origin
checks.

### Endpoint table

Key: **O** = owner (key via `?k=`, cookie, Bearer, or Access JWT); **S** = sub-user allowed, with the session
grant checked (**S\*** = allowed with no grant check); **—** = sub-user refused (403); **L** = loopback
control-guard only, with no credential; **none** = no auth. "GET mutates" marks a state change reachable by GET.

**Mobile app (`mobile/index.js`, port 8790; also exposed over the tunnel, LAN or Tailscale):**

| Method | Path | Auth | Sub-user | Changes state | Notes |
|---|---|---|---|---|---|
| GET | `/sw.js`, `/manifest.webmanifest`, `/icon*`, `/badge*` | none | n/a | no | public assets by design |
| GET | `/`, static files | O / S | S\* | sets cookie on `?k=` | static traversal refused (encoded `../` → 404) |
| GET | `/board`, `/board.html` | O / S | **S\* (B2)** | sets cookie on `?k=` | serves the owner's whole board.html to any identity |
| GET | `/api/bootstrap` | O / S | S\* | no | hostname, debugger state, VAPID key, models and version for any identity |
| GET | `/api/sessions` | O / S | S (filtered) | no | |
| GET | `/api/file` | O / S | S (grant + cwd root) | no | owner: sibling search (B6) |
| GET | `/api/sent-file` | O / S | S (grant + transcript allowlist) | no | |
| GET | `/api/tier`, `/api/permission` | O / S | S | no | |
| GET | `/api/build` | O / S | **S\* (B3)** | no | lists live client ids |
| GET | `/api/stream` (SSE) | O / S | S (lists filtered) | no | **results routed by client id, not identity (B3)** |
| GET | `/api/tts-audio`, `/api/models`, `/api/routines*`, `/api/goals`, `/api/projects`, `/api/desktop`, `/api/usage`, `/api/search`, `/api/session-search`, `/api/session/*`, `/api/folders`, `/api/chips`, `/api/commands`, `/api/tasks`, `/api/relaymote-task`, `/api/outbox`, `/api/outbox/check`, `/api/pair`, `/api/settings` (GET), `/api/tunnel` | O | — | no (`?refresh=1` re-reads) | `/api/pair` returns the pairing links **including the key** (owner only) |
| GET | `/api/usage`, `/api/suggestion`, `/api/probe` | O | — | no, but each one drives the Claude Desktop UI (serialised UI queue) to read | cross-site GETs can queue Desktop UI work (B8) |
| GET | `/api/outbox/drop` | O | — | **GET mutates** | drops a queued message (B8) |
| GET | `/api/cancel` | O | — | **GET mutates** | **stops a running session** (B8) |
| GET | `/api/send-now` | O | — | **GET mutates** | sends a queued message now (B8) |
| GET | `/api/seen`, `/api/mark-read` | O | — | **GET mutates** | read markers (B8) |
| POST | `/api/send`, `/api/answer`, `/api/model`, `/api/effort`, `/api/permission/answer`, `/api/queued/cancel`, `/api/queued/send-now` | O / S | S (grant on `body.id`) | yes | no Origin check (B8) |
| POST | `/api/settings`, `/api/notify-config`, `/api/token/rotate` (B13), `/api/tunnel/login`, `/api/tunnel/setup`, `/api/desktop/dev-mode`, `/api/desktop/enable-debugger`, `/api/accounts/*` (owner-only check, line 820), `/api/account-switch`, `/api/fast`, `/api/board/*`, `/api/routines/meta`, `/api/upload`, `/api/tts`, `/api/rename`, `/api/archive`, `/api/group`, `/api/new`, `/api/relaymote-task/stop`, `/api/task/stop`, `/api/attach`, `/api/chip/start`, `/api/chip/dismiss`, `/api/push/subscribe`, `/api/push/test`, `/api/push/state`, `/api/notify/test-backup` | O | — | yes | no Origin / Sec-Fetch-Site check (B8) |

**Control API (`server.js`, 127.0.0.1:8788 only):**

| Method | Path | Auth | Changes state | Notes |
|---|---|---|---|---|
| GET | `/`, `/api/state`, `/api/resume`, `/api/await`, `/api/notify`, `/api/agents`, `/api/health` | L | no | readable by any local process or user (B12) |
| POST | `/api/task` | L | **yes: starts a worker** with `bypassPermissions` in any `cwd` (B12) | |
| POST | `/api/task/<id>/stop`, `/api/task/<id>/escalate`, `/api/resume`, `/api/goal`, `/api/await`, `/api/await/cancel`, `/api/resume/config`, `/api/notify/config`, `/api/notify/flush`, `/api/route-preview`, `/api/prune`, `/api/shutdown` | L | yes | Origin-checked against browsers; open to local processes (B12) |
| GET | `/open`, `/api/open` | L | **GET mutates**: navigates Claude Desktop | sends `Access-Control-Allow-Origin: *` (B9) |

### Findings

**B1 (high): any `Object.prototype` name is accepted as a sub-user token.**
- Where: `mobile/subusers.js` `find()` (`const r = db[token]` on the object parsed from `subusers.json`), called
  from `resolveIdentity` at `mobile/index.js:80`, `:89` and `:95`.
- Mechanism: `db['constructor']`, `db['__proto__']`, `db['toString']`, `db['hasOwnProperty']` and `db['valueOf']`
  resolve to built-ins, which have no `revoked` flag, so `find()` returns an identity with an empty grant. This
  works on **every install, including one with no sub-users**, through `?k=`, Bearer or the cookie, and over the
  tunnel. A `?k=` request to `/` also sets a one-year cookie.
- Reproduction (offline): `node test/q10-auth-audit.js`, lines `B1-proto-token`, `B1-proto-token-http` and
  `B1-proto-cookie`. With no credential, `/api/bootstrap`, `/api/build`, `/api/sessions` and `/index.html`
  return 200, and `/board` returns the board.
- Impact: unauthenticated disclosure of the hostname, debugger state, version, client ids and the owner's board
  page. Combined with B3, it lets the caller receive the owner's live job results. It cannot send messages or
  read files: every grant check sees an empty set.
- Fix: `if (typeof token !== 'string' || !Object.prototype.hasOwnProperty.call(db, token)) return null;`, or
  parse into `Object.create(null)` / a `Map`. Add a regression test for these names.

**B2 (medium): a sub-user can read the owner's whole board.**
- Where: `mobile/index.js:791-800`. `/board` and `/board.html` are served before the sub-user allowlist at line 804.
- Reproduction: `B2-subuser-board`. A scoped sub-user's `GET /board` returns the owner's `board.html`, while
  `/api/board` correctly returns 403.
- Impact: the board shows every decision, inbox item, goal and nudge across all projects, not only the
  sessions granted to that sub-user.
- Fix: refuse `/board` and `/board.html` for `isSubuser(identity)`, or move them below the allowlist.

**B3 (medium): live results are routed by a client id the caller chooses.**
- Where: `recipients(origin)` (`mobile/index.js:286-292`) selects streams by `c.client === origin`. `c.client`
  comes straight from `?client=` on `/api/stream` (line 1460), and `origin` from the `X-Baton-Client` header
  (line 235). `/api/build`, which is on the sub-user allowlist, lists the live client ids.
- Mechanism: any identity, including a sub-user or the B1 identity, can open `/api/stream?client=<owner's id>`
  and receive the owner's `uiresult` and `sendresult` events. Those include results for sessions that were never
  granted. An owner request **without** `X-Baton-Client` is broadcast to every stream that has no client id,
  including sub-user streams.
- Reproduction: `B3-client-id-leak`, `B3-sse-hijack`, `B3-sse-null-origin`.
- Fix: filter `recipients()` by identity: an owner-origin result goes only to owner streams, and a sub-user stream
  receives only results about its granted sessions. Bind the client id to the identity that registered it.
  Remove client ids from `/api/build` for sub-users.

**B4 (medium): `revoke` can leave a live sub-user link working.**
- Where: `mobile/subusers.js` `revoke(name)` marks the **first** record with that name. `create()` does not refuse
  a duplicate live name.
- Mechanism: create "x", revoke "x", create "x" again, then revoke "x". The second revoke hits the old
  record, reports `ok`, and the CLI prints "revoked. Their link stops working immediately", but the new
  token still authenticates.
- Reproduction: `B4-revoke-first`.
- Fix: revoke every live record with the name (as `grant` does, match `!r.revoked`), report how many were
  revoked, and refuse duplicate live names in `create`.

**B6 (low): the owner's sibling-folder search can return a file outside every root.**
- Where: `mobile/files.js` `siblingMatches()` (around line 45), used at line 89 for the owner only.
- Mechanism: for a relative path that is not found, the search looks in every sibling folder of every root's
  parent. With `~/.claude` among the roots, the parent is the home folder, so a bare name can resolve under any
  `~/<folder>/` (dot-folders included), outside the roots that the scope check enforced. `SECRET_RX` catches
  `credentials`, `.pem`, `id_rsa` and similar names, but not names like `config`.
- Reproduction: `B6-files-sibling-escape`.
- Impact: owner only, so this is defence in depth: the owner can already run commands through Claude.
- Fix: skip dot-folders in the sibling scan, and require the match to be inside a project folder Relaymote knows
  about.

**B7 (low): an Access JWT with no `exp` is accepted.**
- Where: `mobile/access.js` `verify()`: `if (typeof payload.exp === 'number' && now >= payload.exp) return null;`
  lets a token with no `exp` through. Such a token is cached for 60 s.
- Mitigation already present: the RS256 signature by the team's key, `iss`, `aud` and `kid` are all checked, and
  `alg: none`, HS256 confusion, wrong keys and unknown `kid`s are refused (all "fine" in the script).
  Cloudflare always sets `exp`.
- Fix: refuse a token whose `exp` is not a number.

**B8 (medium): the phone app has no CSRF protection, and some GET routes change state.**
- Where: the mobile handler has no Origin or `Sec-Fetch-Site` check (the control API has one in
  `lib/control-guard.js`; the mobile app has none). `GET /api/cancel`, `/api/send-now`, `/api/outbox/drop`,
  `/api/seen` and `/api/mark-read` change state (`mobile/index.js:1094-1110`, `:1165`, `:1215`, `:1226`).
- Mechanism: the `baton_m` cookie is SameSite=Lax. Browsers still attach it to top-level cross-site GET
  navigations, so a page the owner visits can trigger `GET /api/cancel?id=<session>`, which stops a running
  session. This needs the session id, a `local_<uuid>`, so it is hard to guess (inferred limiting factor).
  Lax blocks the cookie on cross-site POSTs, but not on **same-site** ones: another site on the same
  registrable domain as a named tunnel (`relaymote.example.com` next to `blog.example.com`) counts as same-site.
- Reproduction: `B8-no-origin-check` (a POST with a foreign Origin and a `text/plain` body is accepted;
  the script authenticates with Bearer to show the missing check) and `B8-get-mutates`.
- Fix: refuse non-GET requests whose `Origin` is not the app's own origin, or that carry
  `Sec-Fetch-Site: cross-site` or `same-site`, reusing `control-guard`'s logic. Move every state-changing GET to
  POST. Consider `SameSite=Strict`.

**B9 (low): the control API's `GET /open` changes state and is readable by any website.**
- Where: `server.js:495-515` sets `Access-Control-Allow-Origin: *` and, on GET, navigates Claude Desktop to the
  given session.
- Mechanism: control-guard treats GET as safe, so any page in the owner's browser can make Claude Desktop jump
  to a session, and can read the answer (200 or 404 `NO_SUCH_SESSION`), which tells it whether a session id
  exists. The `Host` check still blocks DNS rebinding.
- Reproduction: `B9-open-cors`.
- Fix: drop the wildcard CORS header (send it only for the app's own origin, if the phone needs it), and make
  the route POST-only, or require an `Origin` from the app.

**B10 (low): `subusers.json` is world-readable.**
- Where: `mobile/subusers.js` `writeAll()` writes without a `mode`, so the file gets 644 under a typical umask.
  `secret.json` is written with mode 0600 (`mobile/index.js:54`).
- Impact: on a shared machine, another OS user can read every sub-user's bearer token.
- Reproduction: `B10-subusers-mode`.
- Fix: write with `{ mode: 0o600 }` (and `chmod` an existing file once).

**B12 (medium): the control API trusts every local process.**
- Where: `server.js:333-530`. No credential. `POST /api/task` (line 448) accepts `prompt` and `cwd`, and
  `orch.pump()` starts a worker with `--permission-mode bypassPermissions` (`lib/worker.js:52`).
- Mechanism: a loopback port is open to every user and process on the machine, not only the owner. Another OS
  user, or a sandboxed or low-privilege local service, can start a worker that runs commands **as the owner**
  with no prompt. The browser vectors are blocked by control-guard; local processes are not.
- Reproduction: `B12-control-noauth` (shown with the read-only `/api/state`; `/api/task` was deliberately not
  exercised).
- Fix: a per-install control token in a 0600 file (the CLI, MCP and tray read it and send it as a header), or a
  Unix socket / Windows named pipe with an owner-only ACL.

**B13 (low): "Issue a new key" does not sign anyone out until a restart.**
- Where: `mobile/index.js:1160-1163` deletes `secret.json`, but the in-memory `TOKEN` (line 58, read once at
  start-up) keeps working. The response says so, but the README presents it as "signs every device out".
- Reproduction: `B13-rotate-lag`.
- Fix: regenerate `TOKEN` in memory on rotate, and close open SSE streams.

**B14 (info): the owner key travels in URLs, and failed sign-ins are not throttled.** The pairing link and QR code
carry `?k=<key>`. The redirect strips it, but the first request lands in browser history and any proxy or tunnel
logs. Failed keys get 401 with no logging or rate limit. At 192 bits the key can't be brute-forced; the concern
is the lack of any signal when someone tries. Suggest a one-time pairing code that is exchanged for the cookie, and
a counter for failed sign-ins.

**B15 (info): the sub-user token lookup is a hash lookup, not a constant-time compare.** It has no practical
timing leak at this token length. The owner key uses `timingSafeEqual`.

**B16 (info): MCP roles are self-asserted.** `relaymote_become_master` / `_conductor` write a claim to
`state/masters.json`, and the tool description itself says the claim is "bookkeeping, not authorisation"
(`mcp/relaymote-mcp.js:160`). Nothing should be gated on it; the real boundary is B12.

**B17 (info): Claude Desktop's debugger port is unauthenticated.** While the Main Process Debugger is on
(127.0.0.1:9229), any local process can run code inside Claude Desktop, and Relaymote turns it back on after
each restart (Windows). This is Desktop's behaviour; it should be stated in the README.

**B18 (info): a quick tunnel has no Access in front.** In "Anywhere: quick link" mode, the key (and B1, until
fixed) is the only barrier on a public `*.trycloudflare.com` address.

**B19 (info): the cookie is marked `Secure` only behind `X-Forwarded-Proto: https`.** It is correctly absent on
plain-http LAN and Tailscale. If a proxy other than cloudflared fronts the app without that header, the cookie
loses `Secure`.

**B20 (info): CORS.** The mobile app sends no `Access-Control-Allow-Origin` header (fine). On the control API,
only `/open` does (B9).

### Checked and fine

- Static file serving refuses encoded `../` (404, 404).
- `mobile/files.js` `readFile`, for sub-users:
  - refuses `../` traversal, absolute paths outside the root, and symlinks that escape the root (realpath);
  - refuses `.env` and key-file names;
  - serves files inside the granted folder.
- `/api/sent-file` serves only files the session's own transcript sent, and checks the grant for a sub-user.
- Owner key comparison is timing-safe (`safeEq`). The key is 24 random bytes, stored with mode 0600.
- A random `?k=` and a missing credential both return 401. The B1 identity cannot `POST /api/send`
  (`NOT_GRANTED`) or read `/api/settings` (403).
- A revoked token (the first record in B4) stays refused, and a revoked sub-user's new stream is refused
  with 401.
- Sub-user POSTs require the session grant on `body.id`. `/api/accounts*` is owner-only.
- The pairing cookie is HttpOnly and SameSite=Lax, and the redirect strips `?k=`.
- Cloudflare Access verification refuses expired tokens, wrong `aud`, wrong `iss`, `alg: none`, HS256
  confusion, a token signed by another key, and an unknown `kid`.
- The control guard refuses a cross-origin POST, `Sec-Fetch-Site: cross-site`, `Origin: null`, and a
  non-loopback Host (DNS rebinding).
- The updater (from reading the code): it needs a valid Ed25519 signature over SHA256SUMS.txt, the installer's
  hash must match its signed line, unsigned releases are refused, and the file name carries the version, so an
  old checksum file can't be replayed for a newer release.

### Not covered

- No live tunnel, phone or Claude Desktop was used. Every check ran offline in a temp world.
- `lib/account-sync*`, `scripts/`, `installer/` and `.github/` were read for secrets only (Part A), not audited
  for logic.
- The client-side code (`mobile/public/*.js`) was not audited for XSS beyond noting that `esc()` is used in
  settings rendering.
