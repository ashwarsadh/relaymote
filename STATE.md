# Relaymote (baton) — live state

What is TRUE now, with evidence. Requests live in the goal register; this file is where things stand.

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
