# How Relaymote works

```
 phone / browser ──HTTPS (Cloudflare) or Tailscale/LAN──►  app port 8790  ─┐
                                                                          │   Relaymote daemon (Node.js)
 Claude Code sessions ──MCP (stdio)── mcp/baton-mcp.js ──► control 8788 ─┤    server.js
                                                                          │
         reads files ◄────────────────────────────────────────────────────┤
   %APPDATA%\Claude\claude-code-sessions\…\local_*.json   (session list)  │
   ~/.claude/projects/<folder>/<session>.jsonl            (transcripts)   │
                                                                          │
         acts through ────────────────────────────────────────────────────┘
   Claude Desktop main-process debugger (127.0.0.1:9229)
```

## Reading is files, acting is the desktop app

- **The session list** comes from the JSON files Claude Desktop writes for every Code session
  (title, folder, model, effort, archived). **Transcripts** are the Claude Code `.jsonl` files,
  read from the end so a long session loads quickly. Neither needs the desktop app to be running.
- **Status dots, groups and unread state** come from a passive read of the desktop sidebar every
  30 seconds. It never opens a session just to look at it.
- **Actions** (send, answer a question or permission, change model or effort, rename, archive, start
  a session, press a background-task chip) go through Claude Desktop's main-process debugger.
  Where the app has an internal method for it — for example sending a message to a session — Relaymote
  calls that method directly (`lib/bridge.js`), which needs no clicking. Otherwise it drives the UI
  the way you would (`lib/desktop.js`).
- All UI driving is serialised through one lane, and waits until you have been away from the
  keyboard and mouse for the idle gate, so it never types into what you are doing.

## Modules

| Module | Code |
|---|---|
| App | `mobile/` — HTTP server, server-sent events, push (`mobile/push.js`), the web app in `mobile/public/` |
| Auto-resume | `lib/resume.js` — usage-limit and crash resume |
| Orchestrator | `lib/orchestrator.js`, `lib/worker.js`, `lib/gui-worker.js`, `lib/router.js`, `mcp/baton-mcp.js` |
| Wake the master | `lib/notify.js`, `lib/await.js`, `lib/goal.js` (types `/goal` and `/compact` into the real composer) |
| Auto-start chips | `lib/chipwatch.js` |
| Board | `lib/board-build.js` (writes `board.json` + `board.html`), `mobile/board.js`, `mobile/public/board-ui.js` |
| Inbox | `lib/inbox.js` — append-only numbered inbox, auto-resolve, board answers landed on cards |
| Goal chaser + cache keeper | `lib/goals.js` (append-only `goals.jsonl` ledger, health, warm/cold chase, re-home), `lib/wakes.js`, `mobile/public/goals-ui.js` |
| Project index | `lib/projects.js`, `lib/transcripts.js` (incremental transcript parse), `lib/digests.js`, `lib/index-views.js` (INDEX.md, wiki, map.html), `lib/aliases.js`, `lib/ostasks.js`, `lib/owner.js` (who owns a topic) |
| Organizer | `lib/organizer.js` |
| Conductor | `lib/master-protocol.js` (protocol + rule sections), `lib/conductor-access.js` |
| Context hygiene | `lib/hygiene.js` (verdicts, safe auto-/compact), `lib/archive.js` (archive candidates) |
| Idle-CLI reaper | `lib/reaper.js` (guards run inside the app; releases through its own `teardownQuery`; dry first) |
| Self-update | `lib/updater.js` (GitHub Releases; Ed25519-signed SHA256SUMS.txt, key embedded; signed in CI by `scripts/sign-release.js`; silent Inno install over the app folder via a WMI-launched script) |
| Overviews and roles | `lib/engine.js` (pluggable model engine, off by default), `lib/summarize.js`, `lib/roles.js` |
| Directives | `lib/directions.js` |
| Accounts | `lib/account-sync.js`, `lib/account-sync/*`, `lib/account-scope.js`, `mobile/accounts.js` |
| Alerts | `mobile/push.js`, `mobile/alerts.js` (ntfy / webhook / command backup, rate cap) |
| Finish-the-task hook | `hooks/finish-the-task.js`, `hooks/install.js` |
| Operations | `lib/heal.js`, `lib/launch.js`, `scripts/register-autostart.ps1`, `lib/salvage.js`, `lib/import-ago.js` (import from the predecessor's state format), `lib/dashboard.html` (loopback control page) |
| Remote access | `lib/tunnel.js` (cloudflared), `lib/pair.js` (links + QR), `mobile/access.js` (Cloudflare Access) |
| Settings | `lib/config.js` (`~/.baton/settings.json`, hot-reloaded), `mobile/public/settings-ui.js` |

## Workers

`baton_spawn` runs a task either **headless** (`claude -p`, fast, invisible, needs the Claude Code
CLI to be logged in) or as a **visible Desktop session** (uses the account you are signed in to in
the app). `auto` picks headless when the CLI is logged in. Model and effort are chosen per task by
`lib/router.js` from the difficulty levels in Settings › Models (easy / medium / hard / extra hard); a failed
task can be escalated one level.

## Resume

A session stopped by a usage limit records when the limit resets; Relaymote sends it a short
continuation at that time. A session that was mid-turn when Claude Desktop exited is detected on the
next start and continued. Sessions the app will resume on its own are left alone.

## Limits

Claude Desktop's UI and debugger are not a public API. A desktop update can change the markup Relaymote
drives; reads keep working because they only use files. File an issue with `baton status` output
when an action stops working.
