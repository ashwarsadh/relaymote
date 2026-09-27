# Reddit post — draft

> Draft for the maintainer to edit and post by hand. Suggested subreddits: r/ClaudeAI, r/ClaudeCode,
> r/selfhosted, r/SideProject. Read each subreddit's self-promotion rules first; lead with the problem, keep the
> link at the end, answer comments. Replace the GIF/screenshot placeholders before posting.

---

**Title options**

1. I built a free, open-source phone app for Claude Code that mirrors my desktop sessions — and keeps them
   working while I'm away
2. Relaymote: every Claude Code session on your phone, auto-resume after usage limits, and a "conductor" that runs
   the rest
3. Stop babysitting Claude Code sessions — Relaymote puts them all in your pocket (open source, Windows/macOS)

---

**Body**

I run a lot of Claude Code sessions in Claude Desktop — five or ten at once across different projects. The
moment I walk away, they stall: one asks a question, one needs a permission, one hits the usage limit, one
finishes and just sits there. So I built **Relaymote** and I've been using it daily for a while. It's now open
source (MIT).

**What it does**

- **Your desktop, on your phone — not a copy.** Every Code-tab session exactly as Claude Desktop shows it: same
  list, same groups, same conversation. Reply on the phone, carry on at the desk. Nothing to switch on per
  session, and it keeps working after Claude restarts (unlike Remote Control, which you re-enable and which
  continues in a separate session).
- **Nothing stalls.** Usage-limit stops resume by themselves when the limit resets. Sessions cut off by a
  crash pick up where they were. Push notifications when something needs you.
- **Goal chaser.** Give a goal ("ship the v2 API, with docs and tests") and Relaymote works out which project and
  session it belongs to, sends it there — or starts a new session in the right folder and files it in the
  right group — and keeps nudging until it's done. If a session stops halfway, it gets chased.
- **Cache keeper.** Claude's prompt cache lasts about an hour. Relaymote nudges idle sessions with pending work
  *before* their cache goes cold, so they continue on a warm cache instead of re-reading everything —
  noticeably fewer tokens for long-running work.
- **The Board.** One screen with everything that needs you: questions to decide, things sessions want to tell
  you, pending goals. Tap your answers; they go out in one batch.
- **Conductor + masters.** One "conductor" session knows all your projects and routes any request to the right
  one; each project has a "master" that spawns and tracks workers with the right model for the job (map
  easy/medium/hard/extra-hard to Sonnet/Opus and effort levels in Settings).
- **Data organizer.** Every new session lands in its project's sidebar group automatically.
- **Nothing you say is lost.** Every request becomes a numbered inbox item or a goal with an owner; the board
  shows what is still open, and a session that says "done" has to show evidence before it closes.
- **Context care.** It tells you which sessions should compact, write their state down, or be retired — and can
  compact a session itself, but only in its last warm cache window and only after it has written its state down.
- **Several Claude accounts, one identical app.** Work and personal account on one PC? Relaymote keeps sessions,
  groups, archive and routines in sync, so switching accounts doesn't scramble your sidebar. Preview before
  anything is written; nothing is ever deleted.

Everything is a toggle — use it as just a phone client, or turn on the orchestration bits.

**How it works:** a small local Node service next to Claude Desktop. It reads sessions from disk and acts
through Claude Desktop's own main-process debugger (Developer Mode → Enable Main Process Debugger). Reach it
from your phone over Cloudflare (free, one click, even with your own domain), Tailscale or Wi-Fi, pair with a
QR code. No accounts, no cloud of mine, your key never leaves your machine.

**Install:** Windows installer (macOS DMG is experimental — testers welcome!). Or tell your AI agent: *"Set up
Relaymote for me, follow INSTALL-FOR-AI.md"* — it does the whole thing and shows you the QR code.

[GIF: phone replying to a desktop session] · [screenshot: Board] · [screenshot: Settings › Modules]

GitHub: https://github.com/ashwarsadh/relaymote

Not affiliated with Anthropic. Feedback and bug reports very welcome — especially from Mac users.

---

**Prepared answers for likely comments**

- *"Isn't this just Remote Control?"* — Remote Control continues one session in the Claude app and has to be
  switched on again after a restart. Relaymote shows all your desktop sessions as they are, plus resume, goals,
  the board and multi-account sync.
- *"Is the debugger safe?"* — It listens on 127.0.0.1 only. The app port needs your access key (inside the QR
  code); Cloudflare Access can be added on top. Treat the pairing link like a password.
- *"Does it use my API key / cost money?"* — No. It drives the Claude Desktop you're already signed in to.
  The cache keeper is there to *reduce* token use.
- *"Will it break when Claude Desktop updates?"* — Possibly for actions (the debugger isn't a public API);
  reading sessions keeps working. Updates follow quickly — file an issue with `relaymote status`.
- *"Does it need an LLM key for the smart bits?"* — No. Routing uses a free heuristic by default. Session
  overviews are optional and use an engine you pick: any OpenAI-compatible server, or your own Claude plan.
