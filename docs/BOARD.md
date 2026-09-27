# The Board

The Board is an optional module (**Settings › Modules › Board**) that turns a JSON file into a
tappable to-do list on your phone. Each tap becomes one line of text delivered to your **Conductor**
session (Settings › Advanced › Conductor session id), which reads it and acts.

Use it when one coordinating session keeps a running list of things that need you (decisions,
questions, stuck sessions) and you want to clear them from your phone with a tap.

## Where the files live

All of these sit in the board folder: `~/.baton/board/` by default, or `board.dir` in settings.

| File | Written by | What it holds |
|---|---|---|
| `board.json` | Relaymote (`lib/board-build.js`) or anything else | what the app shows |
| `inbox.jsonl` | `lib/inbox.js` | the inbox: an append-only ledger of things only you can do |
| `board-actions.jsonl` | the app | every tap, as an audit log |
| `hygiene.json` | optional, another tool | per-session context verdicts; shown when present |

When the Board and Goal chaser modules are on, Relaymote writes `board.json` itself every 10 minutes and
whenever you open the Board. It also writes a desktop page, `board.html` (`board.html` in the data
folder, or `board.html` in settings). If a `board.json` or `board.html` in that place was written by
something else (no `"generator": "baton"`), Relaymote leaves it alone unless you set `board.generate` to
true. Before it writes `board.html`, Relaymote checks the page script for a quoted string left open at
the end of a line. A real newline inside a string literal is a syntax error that kills the whole
script, so the page would render but no button or filter would work. If the check finds one, the page
is not written and the build reports the line.

## Format

```json
{
  "generator": "baton",
  "built_at": "2026-01-01T09:00:00Z",
  "conductor": "local_…",
  "owner_name": "you",
  "counts": { "decide": 2, "nudge": 1, "buried": 0, "un": 1, "open": 0 },
  "projects": ["backend", "web"],
  "rows": [
    { "id": "local_…", "title": "Migrate database to Postgres 17", "bucket": "decide",
      "ask": "Run the migration tonight or wait for the backup?", "ask_kind": "decision", "project": "backend", "age": 1 }
  ],
  "inbox": [
    { "n": 12, "text": "Renew the TLS certificate before Friday", "ask": "Renew it today?", "ask_kind": "do",
      "session": "local_…", "project": "web", "ts": "2026-01-01T08:00:00Z", "note": "" }
  ],
  "inbox_waiting": [ { "n": 9, "text": "…", "status": "waiting" } ],
  "inbox_resolved": [ { "n": 7, "text": "…", "tier": "high", "why": "you tapped \"done\" on the board", "evidence": "…", "at": "…" } ],
  "goals": [
    { "id": "g1", "title": "Ship v2 API", "status": "open", "condition": "STUCK", "project": "backend",
      "due": "2026-01-15", "checks": ["docs", "tests"], "closed_at": null }
  ],
  "finished_older": 4,
  "finished_keep_days": 3,
  "goals_health": { "at": "…", "counts": { "STUCK": 1 }, "items": [], "events24": [] },
  "hygiene": null
}
```

- **rows** are sessions that need something. `id` is the session id, so a row can open the session.
  `bucket` is one of `decide`, `nudge`, `buried`, `un` or `open`. The app groups rows by bucket.
  **There is no age cut-off on the counts.** A row counts until it is handled, because a lane that
  has waited two weeks needs you more than one that has waited two days. The 3d/7d/14d chips are a
  filter you choose, and they start at All. A chip's number and the list it shows come from one
  predicate (`Filter` in `mobile/public/board-ui.js`), and the server's counts use the same one.
- **inbox** holds the open items: things only you can do, numbered by `n`, newest first. Numbers never
  change. `ask_kind` is `decide`, `do` or `fyi`. An item without one shows a **NO QUESTION** badge,
  because the session never said what it needs from you. `session` is the recorded lane, or a full
  session id named in the text, or an 8-hex `local_xxxxxxxx` prefix resolved through the project index.
- **inbox_waiting** is the *In flight* drawer: items someone else is working on.
- **inbox_resolved** is the *Probably handled* drawer: items the auto-resolver thinks are dealt with,
  each with its evidence and a **Reinstate** button.
- **goals** holds the open goals, plus goals finished (done, closed, failed or dropped) in the last
  `finished_keep_days` days, which appear in the *Finished* drawer. Older finished goals are only
  counted, in `finished_older`.
- **goals_health** is the goal register's health: verify-now, delivered, ownerless or never handed
  over, stuck or late, and the last 24 hours of changes (`goals-events.jsonl`).
- **hygiene** is `hygiene.json` passed through untouched when it exists. The app shows its `counts`
  and its `sessions` (or `items`) list.
- `conductor` is used when no Conductor session is set in Settings.

## The inbox

`lib/inbox.js` keeps `inbox.jsonl`. Every change appends a row `{ n, at, op, …changed fields }`. The
ledger is never rewritten, so an item's history is its lines (`baton inbox show <n>`).

```
baton inbox                       open items, newest first (--all: everything)
baton inbox add "<text>" [--session <id>] [--log]
baton inbox ask <n> decide|do|fyi "<one-line ask, ≤200 chars>"
baton inbox link|reopen|text|note|kind|done|drop|wait|sweep|show …   (baton inbox help)
```

The MCP tools are `baton_inbox_add` (any session; it records the caller's own session), `baton_inbox`
(read) and `baton_inbox_update` (master or Conductor only).

**Auto-resolver** (module `inboxAutoResolve`, off by default). It never moves an item straight to
`done`:

- Your tap on the card flags it `resolved?` at **high** confidence.
- A pure record ("fyi", "no action") older than `inbox.recordDays` is flagged at **low** confidence.
- A `resolved?` item closes by itself after `inbox.graceDays`, and only when it was earned: a high
  flag, or an answer from the Board that landed on the card. You can Reinstate an item at any time,
  which reopens it and pins it, and the resolver never touches a pinned item again.
- Speech in the item's lane only *marks* it (`seen_in_lane` / `replied_in_lane`). A lane that carried
  on and then ended marks it `orphaned`. That means ownerless, not done.
- Anything matching `inbox.criticalWords` (money, deletion, anything sent outward) is never touched
  on weak evidence.

Every word list is a config key (null means the built-in generic list, and an array replaces it).

Answers typed on the Board are copied onto the card they answer, as a note plus `answered_at`.

## What a tap sends

| Tap | Line delivered to the Conductor |
|---|---|
| Yes on a row | `yes <id>   # <title>` |
| Skip on a row | `skip <id>   # <title>` |
| Answer on a row | `answer <id>: <your text>   # <title>` |
| Done on an inbox item | `done #<n>   # #<n> <text>` |
| Answer on an inbox item | `answer #<n>: <your text>   # #<n> <text>` |
| Reinstate on a probably-handled item | `reopen #<n>   # #<n> <text>` |

In **Batch** mode, taps are queued and sent as one message, one line each. **Clear all FYI** queues a
Done for every FYI card on screen, and **Yes to all Nudge** queues a Yes for every Nudge row. Neither
sends anything until you tap *Send N replies*. On Relaymote's own board a delivered Done also closes the
inbox item, and a delivered Reinstate reopens and pins it.

Tell your Conductor session once what these lines mean (for example in its CLAUDE.md), and it can
act on them.
