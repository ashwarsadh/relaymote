# Relaymote (baton) — live state

What is TRUE now, with evidence. Requests live in the goal register; this file is where things stand.

## g1885 — the Board opened slowly on his phone (14-Oct-2026, ~23:45 IST) — 0.2.105
**Measured on his path.** relaymote.log for his 0.2.104 open at 22:39 IST: `slow /api/board 4174ms`. That timer runs
until the last byte has left through cloudflared. Where the time went:
- `board-build.maybeBuild(60000)` was AWAITED inside the request: inbox upkeep, compose and HTML took **2.1 s**,
  every minute, and the result is usually discarded (build_index.py owns board.json).
- The payload was **412 KB gzipped** (1,883 goals: 341 KB; inbox: 62 KB). At 1.5 Mbps that is 2.55 s.
- The JS bundle is not a factor: board-ui.js is part of the app shell, already loaded before the board opens.
**Fix.**
- `GET /api/board/needs[?goal=gN]` (board.js `needs()`) sends only what the first screen shows: about **19 KB gzipped**.
  - Asks from the last 7 days (text ≤700); older ones go as numbers (`old_ids`) for the fold count and "Mark all done".
  - Only goals on his move or to check, plus `tab_counts` (Filter.tabCounts).
  - The tapped goal, whatever its status, and any old ask that names it.
- `viewCached()` memoises the view per principal while board.json, goals.jsonl, taps and the audit are unchanged (≤15 s).
- The full `/api/board` goes through `phoneFull()`: goals finished more than `finished_keep_days` ago stay on the PC (412 → 159 KB).
- The route rebuilds after `finish`, not before the answer. Every open logs `[board] needs|full N KB in Xms (build Yms)`.
- Phone (board-ui.js):
  - paints the cached light board from localStorage at once, then revalidates (stale-while-revalidate);
  - `ensureFull()` loads the whole board only for a tab, section, search or the old fold;
  - goal taps never need it.
- `onMe`/`goalKind`/`tabCounts` moved into `Filter`, so the phone and the server agree.
**Before/after (harness on live data; the real APIs, gzip, shaped to 1.5 Mbps + 300 ms RTT; Chromium at 375×812).**
| | 0.2.104 | 0.2.105 |
|---|---|---|
| open, nothing cached | 2,871 ms first paint (412 KB), +2.1 s rebuild on the daemon | **440 ms** (19 KB) |
| reopen | 412 KB again | **18 ms** paint from cache, fresh at 469 ms |
| tap g1874 / g1881 / closed g100 | full board | **521 / 429 / 438 ms**, 19 KB each |
| open a tab (lazy) | — | 159 KB, ~1.2 s on the wire |
| old card #273 → Answer focused | — | 2.2 s (needs the whole board) |
The harness's "before" leaves out the 2.1 s rebuild (running it would touch his live inbox), so the real gain is larger.
Tests: `test/board-live-goals.js` +9 checks (payload, memo, old_ids, goal of any status, phoneFull, route order, cache/lazy markers).
**LIVE 0.2.105 at 23:12:58 IST** (8e9cfa8, Release run 38438953770).
- `setup-0.2.105.log`: "stop-relaymote -ForUpdate exit 0" at 23:11:59, then "Installation process succeeded".
- `apply.log`: installer exit 0, started, tray started. No stop marker is left.
**Proof still owed:** the `[board] needs … KB in …ms` lines from his own phone on his next open. Last 0.2.104
opens: 22:39 IST 4,174 ms, 22:40 IST 2,920 ms.

## API sessions never notify; "API" chip hides them by default (14-Oct-2026, ~02:00 IST) — committed 93ce223, NOT yet released
Ashwar (via Conductor): "API session ... should not show up ... as having the relay mode as a notification all the time ... ability to hide API session."
- Marker (`mobile/api-sessions.js`): the id is a `session` value in `~/.claude/ago/state/claude-api/sessions.json`
  (`settings.apiSessions.stateFile` overrides) or a key of `api-sessions.json` beside it, OR the title starts with `API:` or `API ·`. The file is re-read on mtime.
  The claude-api lane (local_58ed4015) was told to keep both stable. "Pattern 3D API session" matches only via the file.
- `sessions.decorate`: an API row loses unread, awaiting and dot. A running dot still shows. `index.js attentionState`
  returns null for `s.api`, so no SSE alert and no push. `slimSession` carries `api`.
- Phone (`app.js` FOLDS): an "API" chip cycles shown / folded / hidden, defaults to hidden, and is stored in
  `baton.apiSessions`. "Others" (g1875) now uses the same fold code; API rows are never counted as Others.
- Tests: `test/api-sessions.js` (14 checks) is new and in `npm test`. The vm slice in `test/principal-touch.js` now starts
  at `applyFold`.
- Release: the updater locked-file fix (tray.ps1 -Watchdog holding tray.png) is NOT committed yet. Ship 93ce223 only
  after it, or stop the watchdog (`stop-relaymote.ps1`) before `update --apply`. Coordinating with local_2d3c486f.
  **Update (g1881 lane, ~22:45 IST):** the fix is f566499 and is tagged v0.2.104. That tag includes 93ce223 and 11ad791.

## Updater: a locked file can no longer empty the install folder (13-Oct-2026, ~22:45 IST) — f566499, v0.2.104
**Root cause of the 21:32–21:45 IST outage (corrects "rollback left the folder gutted").**
- `relaymote.iss` `[InstallDelete]` removes bin, lib, mcp, mobile, scripts, hooks, assets, runtime and node_modules
  BEFORE files are copied. The locked `assets\tray.png` then aborted the silent setup.
- Inno's rollback cannot restore what `[InstallDelete]` removed. It also deletes the files it had just copied, since they count as new.
- `stopped-by-user.json` came from the installer's own `relaymote stop`. `relaymote start` clears it, but `start` could not run from the emptied folder.
**Fix.**
- `PrepareToInstall` runs BEFORE `[InstallDelete]`. It executes the NEW `stop-relaymote.ps1 -ForUpdate -Root {app}` (taken from setup via `dontcopy`).
  - That script stops the tray powershell, its run-hidden wscript wrappers and node.
  - It then opens every file with FileShare None, retrying for 20 s, to prove nothing holds it.
  - If a file is still held, it exits 3 and names the file. Setup then aborts with the old install intact.
- The apply script (`lib/updater.js`):
  - retries setup once after stopping again;
  - always deletes the stop marker;
  - runs `start` again if it fails. `relaymote start` now exits 1 when the daemon does not answer.
**Tests.** `test/update-lock.js` (in `npm test`) uses real fixtures: a fake tray holding tray.png with no sharing → exit 0
and the folder freed; a watchdog restarting it → stopped again; an outside holder → exit 3 naming tray.png, all files kept.
**DEPLOYED and proven on the incident's own precondition (22:13–22:14 IST).** Release CI compiled the `.iss` (run 38431119258, success).
Before the install, the live tray held `assets\tray.png` (a FileShare-None open failed: "tray.png LOCKED").
`relaymote update --apply` was run from 0.2.102, using its old apply script.
- `setup-0.2.104.log`: "Extracting temporary file … stop-relaymote.ps1", then "stop-relaymote -ForUpdate exit 0" at
  22:13:16, then "Installation process succeeded".
- `apply.log`: installer exit 0, then "Relaymote started.", then "Tray icon started."
- `relaymote.log`: "updated 0.2.102 -> 0.2.104" at 16:44:02Z.
- The install folder has all 28 entries. No `stopped-by-user.json` is left. `:8799` answers.

## g1881 — Board opens on "Needs you"; a tapped gNNNN always shows its goal (13-Oct-2026, ~22:30 IST)

**Bug, root cause.** The board read only `~/.claude/conductor/board.json`, which `build_index.py cycle` rewrites every
30 min. A goal named since the last build was absent, so tapping it opened an empty search. The old UI also put the
goal card below unfiltered drawers (197 "For you" asks, 135 of them older than a week).
**Built.**
- `mobile/board.js`: `liveGoals()` folds `goals.jsonl` (stat-cached, CRLF-safe). `withLiveGoals()` merges rows newer
  than `built_at` (marked `fresh`; new open goals = FRESH) and carries each goal's last-change `ts`. `board.json` is never written.
  `view`/`act`/`actBatch` use it. Goals gain `owner` (session title) and `lane`.
  `lineFor` accepts a goal id: done→`close gN`, yes→`go gN`, answer→`answer gN …`, reopen.
- `board-ui.js` rewrite. Search, then tabs **Needs you / In progress / Waiting / Done**.
  - Needs you: decide, his-move goals, paused sessions, do, check-and-close, reply, read; newest first. Each card
    has a one-tap primary action. Asks older than 7 days fold as "probably stale" with "Mark all N done".
  - In progress: grouped by owner session, stale first. Done: folded.
  - A goal card always shows title, owner, status, Latest ("nothing reported yet" if empty), You (blocked_on said to him), and Done when.
  - Day and bucket chips are removed. `Filter` (server-side) is unchanged.
- Tests: `test/board-live-goals.js`, new and in `npm test`, with a control check that board.json alone lacks the new
  goal. `test/board-queue.js` was moved to the new layout.
- **Ashwar 14-Oct ~01:30 IST: "slowly loaded … said the goal does not exist".** That was 0.2.102: g1881 (created 16:16Z)
  was not yet in board.json. Also `/api/board` was **4.27 MB**: 3.3 MB was the full texts of ~1,770 finished goals, and
  0.68 MB was `goals_health.events24`, which nothing on the phone reads.
  - The view now sends finished goals slim (title ≤140, outcome ≤160; no progress, checks or detail) and `goals_health`
    as counts only, giving 1.6 MB before gzip.
  - The server work is fast: the register fold takes 185 ms once, then 1 ms while cached; `readBoardLive` 86 ms.
  - The phone renders its last board at once on open.
  - An id not in the register gets the toast "gN is not in the goal register yet".
  - Harness taps: g1881 388 ms, g1880 195 ms, g730 192 ms, each showing its open card. Shipped in 9001a45 (v0.2.103) and in v0.2.104.
**LIVE in 0.2.104 (22:14 IST).** The installed code's `view()` on real data took 275 ms and returned 1.49 MB, 1,883 goals, 112 open.
- g1881, g1880 and g1874 are each open, with their owner session titles.
- The installed `board-ui.js` and `index.html` carry the new tabs.
**Not proven:** a tap on his actual phone. adb was not used (his phone, not mine to drive). The phone loads the new
bundle on its next open, or from the "ready, Reload" banner. v0.2.103 was tagged but never installed; 0.2.104 superseded it.
**Proof (live data, harness on the working tree, 375×812, no real token).** The live view held 1,882 goals, including g1877–g1881
named after the 30-min snapshot. Tabs read Needs you 71 · In progress 93 · Waiting 54 · Done 9.
- `openBoardAt({goal:'g1881'})` (fresh) and `{goal:'g1874'}` each showed the goal card first.
- `openBoardAt({card:273})` (oldest, in the stale fold) opened the fold with the Answer box focused.
- Screenshots `g1881-before-board.jpg`, `g1881-after-needs-you.jpg` and `g1881-after-goal-tap-g1874.jpg` are in the
  Conductor's side-session-notes folder.
**Open data issue (not code).** About 50 goals' `blocked_on` is status prose ("his tap, unchanged (re-checked …)"),
not an instruction. The card shows it as written. A lane writing blocked_on should state the tap itself.

## g1878 — admin-only sources for sub-user Conductors (14-Oct-2026)
Mostly conductor-side (see ~/.claude/skills/conductor/STATE.md g1878). In Relaymote: `mobile/principals.js` drops `enabled: false` templates (Ajay), so no phone is ever offered one (9e3f3e9). Not yet released; it ships with the next release (0.2.103, deeplinks lane).

## g1875 — Sagar's session list = his Conductor + what he touched in 7 days; Ashwar can fold/hide them (13-Oct-2026, ~21:30 IST)

**Built (0.2.102, 5b4f7a6; feature commit 8f1c010).** `mobile/principal-touch.js` keeps a ledger (`~/.relaymote/state/principal-touch.json`)
of the sessions each non-default principal ACTED on. Two sources:
- His Conductor's own transcript, read incrementally from a saved offset. It counts send_message / SendMessage /
  start_session / spawn / start_task / hand_off calls, by their target field only, so ids quoted in message text do not count.
  The ids a start call returned, and `/api/new` results, are marked "started".
- His phone's `/api/send` and `/api/new`. The phone sends the `X-Relaymote-As` header from Settings › This phone.

Reads (list_events) are not touches. Ashwar's Conductor is never put on his list, even when Sagar escalates to it.
`/api/sessions` and `/api/bootstrap` now pass through `principalList`:
- Sagar's phone gets his Conductor plus the sessions he touched within 7 days. A session goes hidden after a week and comes back on the next touch.
- Ashwar's phone gets every session. Sessions Sagar touched carry `by` (a name tag); sessions he started carry `othersOnly`.
  An "Others" chip cycles shown → folded (one collapsible "Sagar's sessions" group at the end) → hidden.
  Shared sessions stay visible, with the tag.

Tests: `test/principal-touch.js` (15) is part of `npm test`, and the full suite passes. I ran it on the STAGED tree
(checkout-index), not the working copy.
Gotcha: Python `open(...,'w')` on Windows writes CRLF. That broke the tests that slice source on `
}
`
(mobile-session-search, mobile-burst-tts-held). Write with `newline='
'`.

**Deployed and LIVE (0.2.102, 21:45 IST 13-Oct).** Checked through the live daemon at :8799 `/api/sessions`:
- The Sagar phone (`X-Relaymote-As: sagar`) gets **1 of 674** sessions: Sagar Conductor.
- Ashwar's list keeps all of them, with Sagar Conductor tagged `by: Sagar, othersOnly: true`.

The ledger file exists and is being read from Sagar Conductor's transcript (b3530bbb…jsonl).
I did not prove a live "message → appears" round trip: the wake gate held the test send because the Conductor is cold (~200k tokens to wake).
I withdrew that send from wake_hold.json. `test/principal-touch.js` covers the round trip instead.

**🔴 INCIDENT: Relaymote was DOWN ~21:32–21:45 IST during the 0.2.102 update.**
`update --apply` ran the installer, which hit `assets	ray.png` "in use (32)".
The old tray watchdog (`powershell … scripts	ray.ps1 -Watchdog`, pid 39352, plus 2 wscript wrappers) was still alive.
The installer aborted (exit 5) and its rollback left the install folder with no `bin/ lib/ mobile/ runtime/ node_modules`, so the daemon could not restart
(apply.log: "The system cannot find the path specified").
Recovery:
1. Ran `stop-relaymote.ps1`; the tray then stopped.
2. Re-ran the verified `Relaymote-Setup-0.2.102-x64.exe` with the updater's own arguments; exit 0, 0 locks (log `setup-0.2.102-retry.log`).
3. `relaymote start` and `relaymote tray`; `/api/principals` returned 200.

**Open defect:** the installer's pre-upgrade stop did not keep the tray down long enough. Either it missed the tray or the tray came back.
A failed upgrade must never leave the folder gutted.

## g1870 — Sagar Conductor: one Conductor per principal on the same account (13-Oct-2026, ~21:00 IST)

**Built.** `principals.json` sits in the Conductor folder (`~/.claude/conductor`, the same folder as board.json):
it lists `ashwar` (the default, sees everything) and `sagar` (`conductor: local_e2e162ac-2489-4147-a2d2-00151a57555c`, sees only his own).
Relaymote `mobile/principals.js` and `board.view/act/actBatch({as})`: a phone with `?as=sagar` (or Settings › This phone is › Sagar)
opens cold on Sagar Conductor, and its Board shows only rows with `principal: sagar` (goals, asks, and the sessions serving them).
Its board taps go only to Sagar Conductor, and a tap on an item that is not his is refused (400).
Ashwar's phone works as before: it shows everything, with a "Sagar's" tag on Sagar's asks. `GET /api/principals` returns the list.
Commits e7b7512 and the follow-up "keep the goal's principal". `test/principals.js` passes 15/15 and is in `npm test`.

**Proof (live board.json, repo code).** View with no principal: 1872 goals, 198 asks, taps go to `local_a1a539c7`.
View with `as=sagar`: 1 goal (g1872) and 1 ask (#1790), taps go to `local_e2e162ac`. Both were TEST items, now closed.

**LIVE in 0.2.101** (deployed 15:40Z on 13-Oct by the deeplinks lane). I checked it through the live daemon:
`GET /api/principals` lists ashwar and sagar, and `/api/board?as=sagar` returns principal sagar with taps going to local_e2e162ac
(the Conductor shows as up). The app.js placement e7b7512 got wrong was fixed in 2afc051.

**Not a security boundary.** Sagar's phone uses Ashwar's full pairing key ("same everything", as Ashwar asked).
His Conductor's role card enforces Ashwar's hard taps. The only way to revoke the phone is Settings › Pair a phone ›
Issue a new key, which also re-pairs Ashwar's phone.

## g1712 — sessions stopping after ~10 autonomous turns (12-Oct-2026, 00:20 IST)

**Cause (measured, not guessed).** Claude Code itself ends a turn once Stop hooks have blocked it
`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` times in a row — default **8**, so the 9th block prints
*"A hook blocked the turn from ending 9 consecutive times — overriding and ending turn"* (system/informational).
Source: `claude.exe` 2.1.295 (`%APPDATA%\Claude\claude-code\2.1.295\…`): `let qe=a.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP??8;if(qe>0&&_e>qe)…`.
The blocking hooks are `/goal` (a prompt-type Stop hook) and `~/.claude/hooks/finish-the-task.py`.
15 occurrences in transcripts of the last 21 days, e.g. pvt-ltd-conversion `1f68d7a5…` 07-Oct 16:59 IST,
email-analyzer `d4e28edd…` 09-Sep.

**Ruled out (where I looked).** No `maxTurns`/`error_max_turns` stop in any `~/.claude/projects/*/*.jsonl`
(last 21 days); Relaymote/AGO pass no maxTurns to Desktop sessions (only `orchestrator.js` regex mentions it).
Peer messages / task notifications have no cap: 152 runs of 40+ consecutive non-human prompts exist.
finish-the-task.py blocks once only (honours `stop_hook_active`). wake-gate.py (g624) holds cold
*sends*, it does not stop a running session.

**Fix.**
1. `~/.claude/settings.json` → `env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP = "200"` (effectively unlimited for real
   work; still bounds a `/goal` evaluator looping on a session that is only waiting for Ashwar). Applies to
   each session's CLI process at its next start — already-running processes keep 8 until restarted.
2. Relaymote 0.2.95 `lib/resume.js` (`transcriptCapStop` / `capCandidates` / `runCap`, run from the daemon's
   60 s resume tick): if the cap still fires on a session that made tool calls since its last prompt, the
   bridge sends one labelled continuation (`initiator: baton-blockcap-relay`, text starts "Relaymote relay
   (g1712)") — never disguised as Ashwar. Talk-only stops are skipped (waiting on a human); budget 12/session/day;
   one relay per cap event. Audit lines: `BLOCK-CAP RELAY` in Relaymote's `master-audit.log`.
   Test: `test/block-cap.js` (in `npm test`; whole suite green).

**Proof.** Session `local_38c2c10e-f4d7-4d31-b6e3-50ced24184d7` (cli `ebc25ecf…`), started 00:16:53 IST with
ONE prompt and a test Stop hook that blocked 20 times: **21 assistant turns (READY, TICK-1…TICK-20), 0 cap
events, 0 human messages**, finished 00:18:32 IST. Before the change, the same shape (ago `14a7eef4…`, a /goal that kept blocking, 09-Sep) stopped at 9.
The test hook (`.claude/settings.local.json`) was removed afterwards.

**Deployed.** v0.2.95 released (signed, GitHub Actions run green 00:23 IST); installed copy updated with
`relaymote update --apply`; daemon running 0.2.95 since 00:34 IST 12-Oct (pids 121272/59984).
Open edge: sessions whose CLI process started before 00:16 IST still carry cap 8 until they restart; the
relay backstop covers those meanwhile.

## g1712 add-on — Desktop dialogs answerable from the phone (12-Oct-2026, 01:00 IST)

**Before.** Relaymote's snapshot scraped a blocking `[role=dialog]` (e.g. "Trust this workspace?") and the phone
could only say "Sends are blocked — answer this on the PC". Tool-permission prompts were already answerable
(`/api/permission/answer`); app-level dialogs were not. The baton trust prompt Ashwar saw was most likely caused by
this lane's temporary `.claude/settings.local.json` Stop hook — a folder that gains project settings becomes
untrusted (Desktop: `WorkspaceTrustError … trust_required`), and the next UI send raises the dialog.

**Built (0.2.96).** `mobile/dialog.js` `pressDialogButton({key,label,index})` + `POST /api/dialog/press` +
phone buttons in the blocker banner. It presses only the button at that index WITH that label, on the dialog
whose text matches what the phone showed; otherwise `DIALOG_CHANGED`. ok only after the dialog is gone.
The only caller is that route (his tap); scoped sub-users get 403. Test: `test/dialog-press.js`.

**Proof (real dialog, fresh folder).** Fresh scratch folder `g1712-trust-probe`, then an inert project Stop hook was
added, then a UI send was made. Desktop raised "Trust this workspace? … Cancel / Trust workspace". The scrape gave the
phone exactly `["Cancel","Trust workspace"]`. A wrong label was refused (`DIALOG_CHANGED`) and a stale key was not
touched. Pressing "Trust workspace" returned `{ok:true,closed:true}`, the blocker went to null, and the held send
then started session `local_94177558-8c20-4175-9772-253fbb5f37b0`.
Gotcha for automation: a synthetic `button.click()` on Send in an untrusted workspace does nothing; a trusted
key event (`webContents.sendInputEvent` Enter) is what raises the dialog.
**Deployed.** v0.2.96 released (Actions green), installed 00:58:57 IST via `relaymote update --apply`; daemon pid
115260 serves it. The live HTTP route was not exercised with the phone's access key (not handled by this lane);
the first real tap from the phone is its end-to-end check.

## g1719 — phone: false "send now" on a delivered /goal; "/" list (12-Oct-2026, 01:35 IST)

**Bug 1 (fixed, 0.2.97).** Claude Code writes every `dequeue` queue-operation WITHOUT `content` (measured: 3,324 of
3,324 in the Conductor transcript; 3,621 enqueues = 3,324 dequeues + 297 content-keyed removes). `mobile/sessions.js`
only read queue ops with string content, so a dequeue never cleared its message. Only the text match below rescued
plain messages, and a slash command lands as a `<command-name>/goal…` turn, so his `/goal` stayed "queued" with a
live "send now" that would re-run it. Fix: a dequeue takes the oldest waiting enqueue (first in, first out), and a command
turn counts as arrived in its typed form "/name args". Proof: real Conductor transcript `4853c4dc…` showed 1 queued row
(the /goal) on 0.2.96 and 0 with the fix. `test/queued-command.js` has 3 FAIL on the old code and passes on the new.
On the phone page (demo world with the same shape), the /goal turn shows with 0 queued tags and 0 "send now" buttons.

**Bug 2 ("/" list) — NOT reproduced; hardened + instrumented.** Tried on the phone page in mobile emulation:
demo data; his REAL data (27 commands, 15 skills, served correctly); his Conductor session; after sending a /goal; at
100% and 140% text. The list opened every time. Server side is fine (the daemon runs as KKFE0ashwar, home correct).
Changes: the list opens on `input`, `compositionend` and `keyup`; a throwing autosize can no longer stop it; a leading
space before "/" is accepted; a stale async result can't overwrite a newer one. Phone errors and a "/" with no list now
go to the PC log as `[mobile] phone: …` (POST /api/clientlog, owner only, at most 6 a minute). **Next time it happens,
grep relaymote.log for "phone:"** — that is the evidence this lane could not get.
Also found: Python on Windows wrote CRLF into mobile/index.js and app.js (git normalised the commits, but the
working-tree tests broke); converted back to LF.

**Deployed 12-Oct-2026:** v0.2.97 release workflow succeeded; `update --apply` installed it (installed package.json reads 0.2.97, daemon answers on :8798).

## g1756 — Weekly · Fable missing from Relaymote usage (12-Oct-2026, 08:10 IST) — DONE, 0.2.98 live

Desktop's usage panel lists `Weekly · Fable` after `Weekly · all models`; `mobile/usage.js` read only "all models".
Now every `Weekly · <model>` window is parsed (`weeklyModels`) and drawn on the phone with its bar and reset.
Also fixed: the panel was read on its first non-empty paint, which can come before its figures load. Measured once:
Session limit missing and Weekly 0% when the real value was 2%. It is now read until two reads 200 ms apart agree.
Proof: the phone page (mobile viewport, a daemon on the real Desktop) showed Session 7% · Weekly all models 2% · Weekly Fable 0%,
both weekly windows "Resets Sun 3:30 PM". get_usage returned 7 / 2 / 0 at the same moment, resetting 2026-10-18T10:00Z,
which is Sun 15:30 IST. Screenshot: `C:\Users\Ashwar\.relaymote\results\g1756-usage-fable.jpg`. Release CI green;
`update --apply` installed 0.2.98.

## g1783 — a message Desktop dropped showed "delivered" for 73 min (12-Oct-2026, 13:50 IST) — DONE, 0.2.99 live

**Cause (Conductor's evidence, confirmed):** outbox `ob_mv4u2tlkbs0x` went over the bridge (`LS.sendMessage`, priority
'next') at 05:50:47.384Z, 157 ms before a Stop-hook continuation in the Conductor transcript (4853c4dc). Desktop wrote
no enqueue, no remove and no user row: it dropped the message. `sendQueued` still returned delivery 'held' because
isRunning was true at the call, and nothing ever checked again. The 15-min suspect flag only offered "Send again", under
the words "delivered, waiting for a reply". That item has been `confirmed` since 07:56:55Z, after the Conductor relayed
it (g1782), so no hand fix was needed.
**Fix (`mobile/outbox.js` checkAccepted / markResent, `outboxTickInner`, `desktop.sendQueued(…, {uuid})`):**
- A bridge send (one that has a uuid) must leave a trace within 60 s: an enqueue/remove row with its text, a row carrying its uuid,
  or the user turn.
- If there is none, it is re-sent ONCE under the same uuid, and only within 5 min of sending, so nothing old is re-sent late.
- If that also leaves no trace in 60 s, it becomes `failed` and `notDelivered`, the phone gets an alert titled "Message NOT delivered",
  and the bubble reads "NOT delivered — the PC never took it". "Delivered, waiting for a reply" now needs `acceptedAt`;
  before that the bubble reads "not seen arriving yet".
- `test/outbox-mention.js`'s "tick never sends" rule now allows exactly this one same-uuid re-send.
**Proof:**
- `test/outbox-accept.js` replays that morning's transcript shape: re-sent once at 61 s with the same uuid, the re-send's
  enqueue is seen, never re-sent again; lost twice → NOT delivered; never a third send.
- Live on 0.2.99: I planted a never-sent held entry (`ob_mv4zabj6gdiz`, uuid 0211928f…) for the idle probe session
  local_38c2c10e (transcript ebc25ecf). relaymote.log shows "never reached … re-sent once, same uuid 0211928f: ok" at
  08:17:38.858Z (+63.5 s), then "confirmed" at 08:17:43.6Z.
- The transcript has one enqueue at 08:17:40.863Z and exactly one user turn, whose uuid is the original 0211928f. The session replied "OK".
**CI note:** in the v0.2.99 release, the macOS Intel (macos-15-intel x64) job failed at "Self-test the DMG". The Windows, arm64 and
release jobs succeeded, so that version has no Intel DMG. Not investigated; the arm64 DMG is unaffected.

## Usage popover shown as "a box blocking sends" (13-Oct-2026, ~01:45 IST report) — DONE, 0.2.100 live

**Cause (measured on his Desktop 13-Oct):** Desktop keeps closed dialogs in the page at full size.
- The Usage popover after it closes: `data-closed`, `data-side=top`, pointer-events none. Relaymote's own usage read
  opens and closes this popover, so it is often lying in the page.
- A claimed-credit modal (`cloud-credit-claim-modal`): `data-closed`, opacity 0.

Three places tested only offsetWidth/Height, so a closed popover counted as a blocking box: the sidebar scrape (the phone
banner), the send-path cover check, and `mobile/dialog.js`. Live check: the old rule flagged both elements, the new one flags nothing.

**Fix:**
- A shared `desktop.OPEN_DIALOG_FN` requires a dialog that is not data-closed, not anchored (data-side), visible, opacity
  above 0.05 and pointer-events not none.
- A button needs a letter or digit, so no blank glyph is shown.
- A real blocker also gets one "Dismiss (Esc)" button, which sends a trusted Escape key to the window
  (`pressDialogButton` with index -1).

**Proof:** `test/dialog-press.js` builds the measured shapes. The old code fails 6 of its checks; the new code passes them all.
The full suite passes, the v0.2.100 CI is green on all jobs, the installed 0.2.100 is running, and the live scrape returns blocker null.

## g1869 — session links, goal ids, card numbers and "board" are taps in the phone chat (13-Oct-2026, 21:10 IST) — DONE, 0.2.101 live

**Before.** `md()` turned `[title](#local_<uuid>)` into a file link (`data-p="#local_…"`), so a tap asked the file viewer
for "#local_…" and nothing opened. Goal ids, card numbers and "board" were plain text.
**Built (mobile/public/app.js `md()` + `boardLinks()`, board-ui.js `openBoardAt`).**
- `[title](#local_<uuid>)` and a bare `local_<uuid>` → `a.sesslink` → `navOpenFrom(id)` (any open sheet closes first).
  Any other `#target` link (e.g. `#terminal/3`) renders as plain label text.
- `g\d{3,5}` → board with search = that goal: its register card (finished ones too; `data-goal`, flashed) plus every
  ask/session row whose text names it. `#\d{3,5}` → that inbox card expanded + flashed, Answer sheet open and focused
  when it is open, not acted and not FYI; a waiting/resolved/missing card gives a toast that says so. Word "board" → board.
- The board-word pass runs on text outside tags only, after files/URLs are parked: paths (`notes/g1822-x.md`), URLs,
  "PR #12"/"issue #12", "dashboard" and `&#39;` are never linked. Test: `test/session-links.js` (in `npm test`).
**Proof (staged build, real data, no real token).** A harness that served the staged `mobile/public`, the real board.json
(15:17Z) and two real Conductor messages (4853c4dc…, 11-Oct 23:02Z "#1783" and 13-Oct 15:10Z
"[Claude-Desktop-as-API…](#local_58ed4015…) (g1871)"), checked at 375×812 with real clicks:
- the session link opened `local_58ed4015…`, with the header showing that title;
- g1871 opened the board with search "g1871" and one goal card, "g1871 Claude-Desktop-as-API…", flashed;
- #1783 opened the board with the Answer sheet for "#1783 Rentals (g1742)…", the textarea focused, and nothing sent.
**Deployed.** v0.2.101 (the tag also carries g1870); Release workflow success; `relaymote update --apply` → log line
"updated 0.2.100 -> 0.2.101" at 15:40:17Z; daemon pid 160164 serves it. The phone picks up the new bundle on its next
open (or via the "ready, Reload" banner).
**Shared-checkout note.** e7b7512 (g1870) was applied as a zero-context patch and misplaced app.js hunks (the
principal line landed inside `openChat()`). 2afc051 carries the correct layout. 4afc0d5 widens the board-queue
`bid` regex for g1870's `as:` field.

## 13-Oct-2026 ~23:55 IST: Sagar login on the public domain
Cloudflare Access app "Baton" (baton.scarvesmanufacturers.org), allow policy "Ashwar, India": include = ashwarsadh@gmail.com + sagar@kkfashionexports.com (added on Ashwar's "Yes", read back via API). Sagar opens https://baton.scarvesmanufacturers.org/?as=sagar, gets an email PIN, then pairs with Ashwar's pair link + &as=sagar.

## 14-Oct-2026: Share into Relaymote (Android share target), 0.2.106
Ashwar: "In the share menu, I want to receive files from relay mode, and preferably attach in the session I was last using."
- `manifest.webmanifest` `share_target` POST multipart → `/share-target`, field `files` (image/*, PDF, Word/Excel, text/audio/video, */*), plus title/text/url.
- `sw.js` (cache `relaymote-share-v1`) keeps each file at `/__share/<id>/<i>` + `/meta`, then 303 → `/?share=<id>` (`failed` if unreadable).
- `index.js`: a POST reaching the server (worker not running) → 303 `/?share=missed`, before auth, reading nothing.
- `app.js` `receiveShare`: opens `localStorage baton.lastChat` (set on every openChat, no expiry; else the first-screen pick), puts shared text in the box, `uploadFiles` → attachment chips, toast "N files attached to “title” — check it, then tap send", deletes the cache. Never sends.
- Proven: Chrome with the real SW + harness: 3 files (pdf/jpg/docx) POSTed → landed in last-open "Tally lane" (not the first-screen pick "Conductor"), full bytes uploaded, text in box, cache emptied. Phone size 375×812 (pane; its SW registration is refused, so the cache was seeded the way sw.js writes it) → 2 chips in last-open "WhatsApp keeper". `test/share-target.js` 12 checks.
- Android caveat: the installed WebAPK learns share_target only when Chrome refreshes its manifest; if Relaymote is missing from the share menu, remove and re-add the home-screen icon.
- LIVE 14-Oct 12:34 IST: "updated 0.2.105 -> 0.2.106", stop-relaymote -ForUpdate exit 0, "Installation process succeeded", tray restarted; daemon serves `share_target`; POST /share-target → 303 /?share=missed. Install note: GitHub's CDN ran at 0.7-26 KB/s and the updater's download died 3× on its 60 s stall timeout (restarts from zero). The installer was fetched by resuming curl, checked against the signed SHA256SUMS (df2323778f96f403…), and handed to the updater's own `apply()`. The resumable-download fix was proposed as its own task.

## 14-Oct-2026: g1940 Sagar's list showed every session — fixed in 0.2.107
Ashwar: "sagar relaymopte was showing all sessions instead of his sesion or sessions he started or invoked".
- Cause: `/api/sessions` and `/api/bootstrap` narrowed by principal (principal-touch.view), but the daemon's poll pushed SSE `sessions` with the FULL list to every stream (index.js poll), and the phone's EventSource carried no `as=`. The first list change replaced his narrowed list with everyone's.
- Fix: app.js `connectStream` adds `&as=<baton.principal>`; `/api/stream` stores `c.principal = principalOf(req,url)`; poll pushes `touch.view(list, c.principal)` per principal (Ashwar's rows keep `by` marks).
- Proof (headless, real server.js in a temp world, `test/principal-stream.js`): old code → Sagar's stream got all 7 demo sessions; new → only his Conductor; Ashwar's stream 7; `/api/sessions` as sagar agrees.
- Live view at fix time (real data): of 698 sessions, Sagar sees 3 (his Conductor local_e2e162ac + 2 he touched).
- Open: principals.json names Sagar's Conductor `local_e2e162ac…` ("Sagar Conductor"), but the Conductor calls `local_2e263960…` ("Sagar Conductor · second conductor + own board", the g1870 builder lane) his. Only e2e162ac is in his list. principals.json is Ashwar's admin file, so it was left unchanged.
- Not covered: web-push notifications still go to every subscribed phone regardless of principal (alerts.deliver).
- LIVE 14-Oct 20:58 IST: "updated 0.2.106 -> 0.2.107", stop -ForUpdate exit 0, Installation succeeded; installed code (real data) gives Sagar 3 of 698 sessions.

## 14-Oct-2026: g1940 follow-up, push notifications per principal (0.2.108)
Conductor's decision: "each phone gets pushes only for its own principal's sessions, so Ashwar's never reach Sagar's phone, nor the reverse". principals.json stays as is (Sagar's Conductor = local_e2e162ac; 2e263960 is Ashwar's builder lane).
- `push.json` subs carry `as` (principal key; absent = Ashwar). The phone sends `as` in /api/push/subscribe and re-subscribes when Settings › This phone changes; the SW's pushsubscriptionchange (no `as`) keeps what the endpoint had.
- index.js `alertAudience(s)`: Sagar if the session is on his list (touch.view); Ashwar unless another principal STARTED it (`othersOnly`). Push (`push.send(evt,{only})`), the in-app SSE alert, and the "N finished" burst (`coalesceDone(evt, now, group)`) all follow the audience. The backup channel (Ashwar's) is used only when Ashwar is in the audience.
- Proof (headless, real server.js + https stub, `test/principal-push.js`): Sagar's Conductor → sagar only; Ashwar session → ashwar only; Sagar-started → sagar only; Ashwar session Sagar messaged → both; SSE alerts match. Control on the old code: 6 checks FAIL.
- LIVE 14-Oct 21:20 IST: "updated 0.2.107 -> 0.2.108", stop -ForUpdate exit 0, Installation succeeded.
- 🔴 Found while verifying: push.json has 0 subscriptions. FCM returned 410 at 12:42 IST and the sub was pruned. Since 12:40 IST every app open reports `permission=default` (not-granted), which fits a re-added home-screen icon (the 0.2.106 share-target advice) resetting notification permission. Every alert since then logged "DROPPED … no phone subscribed". Fix: Ashwar taps 🔔 in RelayMote once and allows; Sagar's phone the same if he wants alerts.
