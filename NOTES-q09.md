# q09: relay core tests, and the failure risks under reconnects

Branch `cloud/q09`, based on `a10d5ec`. These tests check how a message typed on the phone reaches a Claude Desktop session, and how replies and events come back. No source file was changed. The change adds four test suites and a shared helper, extends the `npm test` chain, and adds this file.

Line numbers below refer to `a10d5ec`. "Observed" means a test in this branch shows it happening. "Inferred" means I read it in the code but no test runs it end to end.

## What was tested

Every suite runs offline. It uses a temp `RELAYMOTE_HOME`, `APPDATA`, `CLAUDE_CONFIG_DIR`, `HOME` and `USERPROFILE` (through `world()` in `test/mobile-harness.js`). Claude Desktop is always a local stand-in on 127.0.0.1: `fakeDesktop()` from the mobile harness, or the new `cdpStub()` / `silentServer()` / `deadPort()`. Nothing contacts push, ntfy, Cloudflare or GitHub. Every spawn passes `windowsHide: true`.

A check that documents a real bug prints `KNOWN-BUG ...` and does not fail the suite. If the bug is later fixed, the line turns into `ok ... (was a KNOWN-BUG ...)`.

| File | Passing checks | KNOWN-BUG | What it covers |
|---|---|---|---|
| `test/relay-harness.js` | n/a (helper) | n/a | Reuses `world()`, `request()` and `fakeDesktop()` from `mobile-harness.js`. Adds: `boot()` with `windowsHide` that can boot again in the same world; `cdpStub()`, a debugger that can hang, drop the socket mid-call, or stop and come back on the same port; `silentServer()`; `deadPort()`; `setCdpPort()` to move the debugger under a running daemon; `subuser()` with `windowsHide`; `knownBug()` and a summary line. |
| `test/relay-cdp.js` | 30 | 4 | `lib/desktop.js` `connect()`/`wsUrl()`/`cdpAvailable()`/`serializeUi()` and `lib/bridge.js` `connectRaw()`/`wsUrl()`. Covers Desktop unreachable, probe timeout (4s), handshake timeout (8s), eval timeout, exceptions, the socket dropping mid-call, the debugger coming back on the same port, a call in flight while it restarts, head-of-line blocking in the UI queue, and the background-send to composer fallback after a send that delivered. |
| `test/relay-outbox.js` | 46 | 4 | In-process: enqueue, ordering, `setUuid`, one confirmation per message, stale flagged once and kept across a reload, the false-confirmation bug, and the `busy()` bug through the exported `outboxTick()`. Through the daemon: a send while Desktop is unreachable, Desktop coming back, Send again delivering exactly once, a lost-response POST retry, held-message ordering, Cancel refused during an outage and working after it, and two daemon restarts (held and failed slips survive, Send now works after a restart, a stale slip alerts once and not again). |
| `test/relay-stream.js` | 17 | 3 | `/api/stream`: state sent on connect and reconnect, a client that dies without a goodbye is dropped and the broadcast to others continues, a job result follows its client id across a reconnect, the session list after a reconnect, and sub-user filtering (watch, list, outbox alerts) re-applied on every connection, including after revoke. |
| `test/relay-routing.js` | 54 | 2 | `lib/owner.js` resolve/check (no index, representative topics, named id, disqualified lanes, exclude-sender, ambiguous, project pin), `lib/aliases.js` (learn refusals, whole-word boosts, dispatch weighting, `findSessions`/`tag` refusals), `lib/router.js` (inline/trivial, `minTier`, low-confidence bump, force, escalate bounds, `toModelId`), `lib/uiqueue.js` (messages never queued, dedupe, drain during and after an outage, expiry, cancel), `lib/await.js` (park refusals, one wake, deadline, empty snapshot) and `lib/wakes.js` `wakeSender`. |

Totals: 147 passing checks and 13 KNOWN-BUG lines across four suites.

These suites add to the existing ones rather than repeat them: `mobile-outbox.js` (pure outbox rules), `mobile-queued.js` (Cancel / Send now with Desktop up), `mobile-client-isolation.js` (who gets which `uiresult`), `mobile-subuser-scope.js` (the sub-user filter on one connection), and `core.js` / `index.js` (router and owner basics).

## Commands run and results

1. `git checkout cloud/q09`: switched; up to date with `origin/main` at `a10d5ec`.
2. `ln -s /home/user/relaymote/node_modules node_modules`: the symlink is untracked and not committed.
3. Baseline before any change: `APPDATA=$T/a CLAUDE_CONFIG_DIR=$T/c npm test`, with `$T` a fresh temp folder. Exit 0.
   - The sandbox refused the `T=$(mktemp -d)` subshell form, so `$T` was a fresh empty folder made with `mkdir -p` in the session scratchpad. Otherwise the command is the same.
4. Each suite on its own while writing:
   - `node test/relay-cdp.js`: exit 0, 30 passed, 4 known.
   - `node test/relay-outbox.js`: exit 0, 46 passed, 4 known.
   - `node test/relay-stream.js`: exit 0, 17 passed, 3 known.
   - `node test/relay-routing.js`: exit 0, 54 passed, 2 known.
5. Full suite after the change, same command as step 3 on a new empty `$T`. Exit 0 in about 233s. No `FAIL` lines, "all 17 mobile suites passed", "all hidden-launch checks passed", and the four relay summaries shown above.

## Bugs found

None of these is fixed here. Each one is a `KNOWN-BUG` check, so reproducing it means running the named suite.

1. **The debugger socket closing does not reject pending calls.** `lib/desktop.js:21-45` `connect()` and `lib/bridge.js:21-48` `connectRaw()` handle `open`, `message` and `error` but not `close`.
   - A call in flight when Desktop drops the socket waits out its whole `evalTimeout` before rejecting with `eval timeout`. That is 20s by default and 60s for the composer send at `desktop.js:2724`.
   - A call made on an already-closed connection does the same.
   - Reproduce with `relay-cdp.js`, section "the socket drops in the middle of a call". With a 2.5s timeout the stub drops the socket at once, and the call still rejects only after 2501 ms.
2. **A connect that times out leaks its socket.** `desktop.js:26` and `bridge.js:25` reject after 8s but never `terminate()` the WebSocket.
   - Reproduce with `relay-cdp.js`, "the debugger hangs". One server-side socket is still open after the rejection.
3. **A failed short message is falsely confirmed.** `mobile/outbox.js:31-36` keeps the first 60 normalized characters, and `:112-113` confirms if they appear anywhere in `transcriptTail()`.
   - `transcriptTail()` (`mobile/index.js:1760`) is the raw last 2 MB of the `.jsonl`, including assistant text, tool output and older turns, with no time bound.
   - So a failed "yes" is marked confirmed by an hour-old "Say yes and I will continue." It then disappears from `/api/outbox` and Send again is no longer offered.
   - Reproduce with `relay-outbox.js`, "a failed short message ...".
4. **`busy()` is always false.** `mobile/index.js:1796` (and `:1088`) asks `sessions.get(id).running` or `.dot === 'Running'`. But `sessions.get()` returns the raw record from `shape()` (`mobile/sessions.js:35-55`), which has neither field. Only `decorate()` adds them.
   - So the "the session is still working, the clock does not run" guard in `outbox.reconcile` never engages in the daemon.
   - A message held behind a turn longer than 15 minutes raises "A message may not have arrived".
   - The existing `mobile-outbox.js` only checks that the call appears in the source.
   - Reproduce with `relay-outbox.js`, "the session is still working ...". The snapshot says Running, `decorate()` says `running:true`, and the slip is still flagged suspect.
5. **Send again treats a dropped slip as not delivered.** After a slip is dropped, `/api/outbox/check` answers `{ landed:false, gone:true }` (`mobile/index.js:1085`). The app's `alreadyLanded()` (`mobile/public/app.js:218-223`) returns `r.landed` only, so a second view still showing the slip resends it.
   - That second view can be another device, or the phone holding a stale list after a reconnect.
   - The server response is observed. The client side is checked by reading the source (inferred behaviour).
   - Reproduce with `relay-outbox.js`, section 3.
6. **`/api/send` has no idempotency key.** `mobile/index.js:1499-1508` starts a new job and a new outbox slip for every POST. The same POST sent twice, as when it is retried after a lost response, is delivered twice.
   - The app also puts the text back in the composer when the POST throws (`app.js:2233-2237`), which invites exactly that second tap (inferred).
   - Reproduce with `relay-outbox.js`, section 3; the transcript has the text twice.
7. **Job results are not replayed.** `uiresult` (`mobile/index.js:584-590`) and `sendresult` (`:620-633`) go only to clients connected at that instant. A phone that is reconnecting when its job ends never hears the outcome.
   - Reproduce with `relay-stream.js`, "a job result follows its client ...". A reconnect before the job ends receives the result; a reconnect after it does not.
8. **A reconnecting client is not sent the session list.** `mobile/index.js:452-460` compares one global `lastListKey`. A client that missed a list change while reconnecting is not sent the list if another client already saw it.
   - The phone refetches only on focus or `online` (`app.js:392-407`).
   - Reproduce with `relay-stream.js`, "the session list after a reconnect".
9. **A revoked sub-user's open stream keeps receiving.** The identity is captured once at connect (`mobile/index.js:1459`) and used for every broadcast (`:456-458`). After revoke, a reconnect is refused with 401, but the open stream keeps getting granted-session events until it drops.
   - Reproduce with `relay-stream.js`, last section.
10. **The UI replay queue counts "Desktop unreachable" as a failed attempt.** `lib/uiqueue.js:73-77` drops an item after `MAX_ATTEMPTS` (3). Drains run every 45s (`server.js:681`), so a queued rename or regroup is lost in a Desktop outage of about 2 minutes.
    - Reproduce with `relay-routing.js`, "uiqueue".
11. **A master is woken early when no snapshot exists.** `lib/await.js:84-85` treats "no snapshot" the same as "session gone from the sidebar". The master is woken with "everything you parked on has finished" while the worker may still be running.
    - This only happens before the first successful sidebar scrape (`loadSnapshot()` returns null), so it is unlikely.
    - Reproduce with `relay-routing.js`, "await".

`relay-cdp.js` also shows, as a passing check, how bug 6's cousin works at the Desktop layer. If the background send delivers and then fails (here the delivery throws; in real use the answer could be lost to a timeout), the exported `sendMessage` (`lib/desktop.js:3692-3705`) falls back to the composer. That is a second delivery attempt of a message that already landed.
- The stand-in has no real composer, so the attempt stops at `find-row`.
- Against a real Desktop it would type the text again (inferred).
- In the throw case `doSend`'s `landed()` check (`mobile/index.js:683-690`) usually catches it. It catches nothing when the composer itself succeeds.

## The three highest failure risks under reconnects

### 1. Duplicate delivery when a send is retried after a reconnect

- **Mechanism:** a message can be handed to Desktop more than once, and nothing on the server de-duplicates it. Four paths lead there:
  - (a) `/api/send` has no idempotency key (`mobile/index.js:1499-1508`). The app restores the text when the POST fails (`app.js:2233-2237`), so a POST that reached the daemon but lost its response, typical on a tunnel or Wi-Fi blip, is sent again by the next tap.
  - (b) Send again checks `/api/outbox/check`, which answers `gone` for a slip another view already resent. The app reads that as "not landed" (`app.js:218-223`) and resends.
  - (c) `busy()` is always false (`mobile/index.js:1796`). A message Desktop is still holding behind a long turn raises "may not have arrived" after 15 minutes, and its Send again check returns `landed:false` because the text is not in the transcript yet (`:1081-1091`). The resend goes into Desktop's queue too, and both arrive when the turn ends (inferred from the code; the first step is observed).
  - (d) At the Desktop layer, a background send that delivered but threw or timed out is retried through the composer (`lib/desktop.js:3692-3705`). `doSend` also retries up to 3 times on any `/timeout/` with only a 1.5s "did it land" check (`mobile/index.js:680-695`).
- **Evidence:** `relay-outbox.js` sections 3 and "still working"; `relay-cdp.js` "falls back to the composer".
- **What the user sees:** the same instruction reaches a session twice. For an agent that can mean doing work twice, such as two commits or two deployments, or a confusing duplicate turn.
- **Likelihood:** medium to high.
  - (c) needs only a turn longer than 15 minutes plus a tap on the offered Send again. Long agent turns are routine (inferred).
  - (a) needs a lost response, which is common over a phone link.
- **Mitigation:**
  - Have the phone mint a per-send key (the outbox id or a uuid). The daemon de-duplicates `/api/send` by it and returns the existing job.
  - `/api/outbox/check` should say whether a replacement was sent. The app should treat `gone` as "do not resend".
  - Compute `busy()` from `sessions.decorate(..., desktop.loadSnapshot())` instead of the raw record.
  - Before the composer fallback or a retry, check the transcript or Desktop's held input for the message (the bridge path already has a uuid).

### 2. A message typed during an outage is silently confirmed and dropped

- **Mechanism:**
  - While Desktop is unreachable the send fails and the slip is marked `failed`.
  - `finishSend` then runs `outboxTick()` at 4s and 15s (`mobile/index.js:617-618`).
  - `reconcile` confirms any slip whose first 60 characters appear anywhere in the raw 2 MB transcript tail, with no time or role bound (`mobile/outbox.js:31-36,112-113`; `mobile/index.js:1760`).
  - Short or common replies ("yes", "ok", "continue", "go ahead") nearly always appear somewhere in a tail, often in the assistant's own question.
  - The slip becomes `confirmed`. `pending()` then hides it, so the red outbox box and its Send again disappear.
  - The app's `retireSpentDraft()` (`app.js:2243`) also clears the draft, and the composer text if it still matches, because the same words appear in the log (inferred from the code).
- **Evidence:** `relay-outbox.js` "a failed short message ..." (observed: `state: confirmed`).
- **What the user sees:** the user saw a failure toast, but every later sign says the message went through. The session never got it and waits, so the message is lost while the UI looks consistent.
- **Likelihood:** medium. Outages happen at every Desktop restart and debugger toggle, and short replies are a large share of what people type on a phone.
- **Mitigation:**
  - Match only `user` rows whose timestamp is at or after the slip's `at` minus a small skew. `doSend`'s own `landed()` (`mobile/index.js:668-675`) already does this.
  - Never confirm a `failed` slip from text alone when the needle is shorter than some minimum. Ask for the uuid or a timestamped match instead.

### 3. A dropped debugger socket stalls every phone action, and the results are lost to a reconnecting phone

- **Mechanism:**
  - When Desktop restarts or crashes mid-call, the socket closes but pending calls are not rejected (`lib/desktop.js:21-45`; `lib/bridge.js:21-48`). They wait the full `evalTimeout`: 20s, or 60s for the composer send at `desktop.js:2724`.
  - Phone actions that go through `ui()` (`mobile/index.js:530`) are serialized on one chain (`lib/desktop.js:153-158`): composer sends, answers, permission answers, picker changes, renames. Each waits behind the hung call; this head-of-line blocking is observed.
  - `doSend` treats `eval timeout` as transient and retries up to 3 times (`mobile/index.js:680-695`), each attempt able to wait again. The worst case is minutes (inferred).
  - Meanwhile the phone's own SSE link often drops and comes back. Results that finish during that gap are not replayed (`mobile/index.js:584-590`, `:620-633`), and the session list is not resent on reconnect (`:452-460`).
  - Hung connect attempts also leak sockets (`desktop.js:26`).
- **Evidence:** `relay-cdp.js` ("socket drops", "serialized UI queue", "debugger hangs"); `relay-stream.js` ("job result ...", "session list after a reconnect").
- **What the user sees:** messages stuck in "sending…" until the app's own 90s give-up (`app.js:834`), controls that do nothing for tens of seconds, and stale dots, titles and running states until the next list change or until the app is refocused.
  - The outbox keeps the text, so nothing is lost here, but the UI is stuck or stale.
- **Likelihood:** medium. `server.js:122` notes that Claude Desktop switches its debugger off whenever it restarts, so every Desktop restart or update is one of these events. Whether a call is in flight at that moment depends on use.
- **Mitigation:**
  - Add `sock.on('close', ...)` to both `connect()` and `connectRaw()`. It should reject every pending call with a distinct `cdp socket closed` error, and `terminate()` the socket on connect timeout.
  - Have `doSend` treat that error as "check landed, then fail", not as a blind retry.
  - Give the UI chain a per-item ceiling.
  - On the SSE side, keep a short per-client-id buffer of `uiresult` / `sendresult` keyed by `jobId` and replay it on reconnect. Send the current `sessions` payload to every new connection, keyed per client instead of by one global `lastListKey`.

### Lower risks noted

- **Revoked sub-user's open stream (bug 9):** a security-shaped gap, bounded by the life of that connection.
- **UI queue drops after about 2 minutes of outage (bug 10):** only renames and regroups, never messages; `uiqueue.enqueue` refuses `sendMessage`.
- **Await wakes early with no snapshot (bug 11):** only before the first successful scrape.
- **Leaked sockets on connect timeout (bug 2):** slow resource growth while Desktop hangs.
