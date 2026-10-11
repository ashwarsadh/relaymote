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
