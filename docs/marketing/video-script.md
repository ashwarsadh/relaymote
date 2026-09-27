# Video script outlines — drafts

> For the maintainer. Record on demo data only (`node test/make-demo.js ./demo`, see README › Try it without
> Claude Desktop) — never on real sessions. Screen-record the phone (or a phone-sized browser window) and the
> desktop side by side.

## A. The 60-second overview (Reddit / X / Shorts)

| Time | Picture | Voice-over / caption |
|---|---|---|
| 0–5s | Desktop with six Claude Code sessions, you stand up and leave | "I run a lot of Claude Code sessions. The moment I walk away, they stall." |
| 5–12s | Phone: session list, a red *needs you* dot, push notification arrives | "Relaymote puts every desktop session on my phone — exactly as they are." |
| 12–20s | Answer a permission on the phone; desktop continues the same session | "Not a copy. The same session. Reply here, continue at the desk." |
| 20–28s | Usage limit hit → timer → session resumes by itself | "Usage limit? It resumes when the limit resets. Crash? It picks up again." |
| 28–38s | Board: questions, notes, goals; tap three answers, *Send 3 replies* | "Everything that needs me, on one board. Answers go out in one batch." |
| 38–48s | Add a goal; Relaymote routes it to the right project, opens a new session, groups it | "Give it a goal. It finds the right project and session, and keeps chasing until it's done." |
| 48–55s | Settings › Modules toggles, Models tab | "Every feature is a switch. Map easy to hard tasks to the model you want." |
| 55–60s | Logo, GitHub URL | "Relaymote. Free and open source." |

## B. Deep dives (2–4 minutes each)

1. **Install in two minutes** — the Windows installer; Developer Mode and the debugger explained
   (*Settings › Desktop connection*, *Turn it on for me*); pair with the QR code; Add to Home screen.
   Alternative: "tell your AI to install it" with INSTALL-FOR-AI.md.
2. **Reach it from anywhere** — Cloudflare quick link vs your own address (log in, pick a hostname, done);
   Tailscale; why the access key still protects you.
3. **Conductor and masters** — make a conductor; drop a vague request on it; watch it route to the project
   master; the master spawns workers on the mapped model; *Wake the master* when they finish.
4. **Goal chaser + cache keeper** — add goals; a session stops halfway and gets chased; the cache-keeper timeline
   (idle 30 min → nudged before the 60-minute cache expiry) and why it saves tokens.
5. **The Board** — pending decisions, things to tell you, goals; batch replies; how the Conductor reads them.
6. **Two Claude accounts, one app** — the drift view; *Preview sync*; the three merge modes; *Add an account*
   walkthrough (log out, log in, copy sessions across; Relaymote closes and reopens Claude only after you confirm).
7. **Context care** — the hygiene report (compact / write state first / rotate / archive), archive candidates
   with reasons, and why auto-compact waits for the last warm cycle.
8. **Models by difficulty** — easy/medium/hard/extra-hard mapping; defaults for new sessions; standing
   instructions.

## Shot list / assets to prepare

- Demo data with 6–8 sessions across 3 projects, one waiting on a question, one on a permission, one at a
  usage limit, two goals (one late), one inbox note.
- Phone frame template; captions in the brand coral (`#d97757`) on dark.
- Logo animation: the relaymote sweeping across (from `assets/logo.svg`).
- Screen recordings at 60 fps, cursor highlighting on for desktop shots.
