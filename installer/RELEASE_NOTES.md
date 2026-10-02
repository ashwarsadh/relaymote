Relaymote puts your Claude Desktop Code-tab sessions on your phone and in a desktop web app. Each download below includes its own Node.js 22 LTS runtime, so you do not need to install Node.

## 0.2.63

- One queued message, one bubble. A message with an attachment was drawn twice while queued (the just-sent copy and the waiting copy, which differ by the attachment line). It was only ever delivered once.

## 0.2.62

- A message held for a running session keeps its Send now and × until it is really delivered. It used to count as delivered the moment it was queued, which took both controls away.

## 0.2.61

- A queued message with attachments now has Send now and ×, like any other message.
- A queued message that has waited more than two minutes shows how long it has waited.
- Running is read from Claude Desktop's own session state on every refresh; the sidebar label is only the fallback.

## 0.2.60

- Session dots work again. Claude Desktop now keeps its CLI one folder deeper (claude-code/<version>/<build>/claude.exe); Relaymote could not find it, the sidebar refresh aborted, and every session showed a grey dot. Both layouts are found now, and a missing CLI no longer stops the dots, which come from Desktop's own sidebar.
- A compacted session shows one collapsed "Session compacted" row, as in Desktop, instead of the summary as your message.

## 0.2.59

- Usage reads again: Claude Desktop renamed its usage button ("Usage, Weekly …") and its "5-hour limit" to "Session limit", so the menu showed "Could not read usage from the desktop". Both wordings are now read, and a test fails if either shape stops parsing.
- The server logs one line per file opened from a chat link (ok or the reason), for diagnosing links that do not open.

## 0.2.58

**File links open from other projects.** A link such as `development\payroll\RULES.md` written by a session in a different folder used to show NOT_FOUND. Relaymote now also looks in the folders just above the ones your sessions work in, and opens absolute paths there too (only for you, never for a linked guest).

## 0.2.57

**Faster read-aloud speeds.** + now goes up to 1.6, 1.7 and 1.8×.

## 0.2.56

**Fix:** the top sessions in your list are now actually fetched in the background, so opening one of them is instant too (0.2.53 only did this for sessions you had already opened).

## 0.2.55

**Fix:** the compression added in 0.2.53 never switched on, so sessions still travelled to the phone at full size. Opening a session now sends about a tenth of the data.

## 0.2.54

**Read aloud starts sooner.** The first sentence is turned into speech on its own and starts playing while the rest is prepared, so a long message begins in about a second or two instead of up to half a minute. The voice engine stays loaded on the desktop, and the next part (or the next message) is prepared while the current one plays.

**More speeds.** − and + now step through 0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4 and 1.5×; 2× and above are gone. Your last choice is remembered.

## 0.2.53

**Switching sessions is much faster.** A session you opened recently, or one near the top of the list, now appears at once from its last view while the fresh copy loads behind it. The desktop no longer re-reads the whole conversation file on every open, and it compresses what it sends to the phone (about a tenth of the size).

**Read aloud keeps going.** Tap the speaker on any message: when it ends you hear a short beep and the next newer message starts, and so on until the latest. The message being read stays highlighted. Tap the speaker again to pause.

## 0.2.52

**Conductor behaviour settings.** Settings › Advanced now has a Conductor behaviour section: when a goal counts as stuck, how soon to ask again, when to give up, how many sessions to wake per pass, and the warm-cache window for nudges, each with a one-line explanation. Fixed: "Chase after" showed blank and could be ignored because it saved an old setting name.

## 0.2.51

**Tidy-up.** Documentation and release notes now describe Relaymote only. The importer from an older tool and the old-install migration script are removed.

## 0.2.50

**Working sessions come first.** In the session list, sessions that are working (blue dot) now sit above the ones waiting for you (yellow dot), then the rest. Newest first inside each group.

## 0.2.49

**Read aloud sounds natural.** It now uses a free Microsoft neural voice (Indian English, Neerja) instead of the robotic built-in one. No account, no key, no payment. It needs Python with the `edge-tts` package and an internet connection on the desktop; without them it falls back to the built-in voice as before.

## 0.2.48

**Read aloud works again.** In 0.2.46 the phone showed the player but the audio never started: the audio address used the same URL parameter as the login key, so the desktop refused every audio request. Fixed.

## 0.2.47

**Relaymote no longer switches your session while you are typing.** Actions that open a session for you (starting a suggested task, moving or renaming) now wait until you have had no keyboard or mouse input for 2 minutes (was 15 seconds), and give up politely instead of forcing it. If you start typing while it is already switching, it puts you straight back on the session you were on and does not press anything.

## 0.2.46

**Read aloud keeps playing with the screen locked.** The desktop now turns the message into speech and your phone plays it as normal audio, so Chrome no longer silences it when the screen locks. The lock screen and Bluetooth headsets show Play, Pause and a seek bar. Nothing runs in the background unless something is playing. The voice is now the desktop's (Windows David or Zira, the Mac voice, or espeak on Linux) rather than the phone's. If the desktop has no speech engine, the phone voice is used as before.

**Seek bar, Play/Pause, Stop and 15-second skips.** Move back and forth through a message. The position is saved for each message, so a lock, a reload or a phone call resumes where you were instead of starting over.

**After a phone call it carries on by itself.** If a call or another app takes the audio, read-aloud waits and resumes when it is released. A pause you make yourself is never overridden.

## 0.2.44

**Find can include working steps.** The 🔍 bar inside a session has an "Include working steps" box, unticked by default. Unticked, it searches only your messages and the replies, as before. Ticked, it also searches thinking, tool calls and tool output, and opens the folded step that holds a match. The box is remembered for each session.

**Opening a session clears its "needs you" dot.** The dot goes as soon as you open the session in the app, instead of waiting for the desktop to catch up. A new turn that needs you raises it again. A session with an unanswered question or permission prompt keeps its dot until you answer.

## 0.2.43

**Settings › Models shows model names, not ids.** A difficulty level set to a model id (for example by a script or an older version) now shows as the picker's own name, such as "Sonnet 5.5", instead of a second raw entry beside it. This release also brings back the Intel Mac downloads that 0.2.42's build missed.

## 0.2.42

**Model names stay clean for models that do not exist yet.** Instead of removing one known badge character, every label is now cleaned by rule: icon glyphs, invisible formatting characters and emoji badges are dropped, whatever model they sit beside. The model list is only what the desktop picker offers, never a built-in list of names.

**"sonnet" means the newest Sonnet.** Asking for a model by family name picks the newest of that family in the desktop's own list, so a switch to Sonnet lands on Sonnet 5.5 even though the desktop's picker shows it greyed out.

## 0.2.41

**Search sits in the header.** The 🔍 button (it replaces the eye) searches inside the open session. Showing or hiding working steps moved to the ⋯ sheet.

**Searching across sessions shows what was said.** It now matches only your messages and the final replies, never tool steps or ids. Each result shows the text around the match with the word highlighted, and tapping it opens the session at that message.

**No more "finished" alerts for old turns.** When the desktop re-marked sessions unread, the app could announce a turn that had ended hours earlier (one was 21 hours old). A finished alert now needs a turn written in the last 10 minutes, and the same turn is never announced twice.

## 0.2.40

**Model names read cleanly.** The desktop's model picker marks some models with an icon ("new"), and that icon came through as a box next to the name, as in "Sonnet 5.5 □". It is dropped now, and switching to such a model finds it by name again (the stray character had stopped it matching).

## 0.2.39

**"Open session" on a board card lands on the message it is about.** A card can carry an anchor, one message in its session (`relaymote inbox add … --session <id> --anchor <uuid>`, or `inbox link <n> <session id> <uuid>`). Opening it loads history back to that message, scrolls to it and highlights it. A card without an anchor is found by its own words (a phrase in quotes, then a goal id such as g123), taking the match nearest to when the card was raised; if nothing matches, it opens as before.

## 0.2.38

**Find inside a session.** Tap 🔍 in the top bar and type: every match in your messages, the replies and messages from other sessions is highlighted (tool steps are not searched). ▲ goes to older matches and ▼ to newer ones; Enter does the same. The search covers the whole session on the desktop, so a match in history the phone has not loaded yet is found too: ▲ loads older messages until it reaches it. The count ("3/17") counts those as well. Opening the bar does not move what you are reading.

## 0.2.37

**Sending a message no longer moves you.** Scrolled up reading, you stay where you are after you send; at the bottom, the view still follows to your message.

**The page stops twitching in sessions with a video or picture.** Every update rebuilt a sent video at a placeholder size and it grew back a moment later, so everything below it jumped (about 370 px, every few seconds while the session worked). Its real size is now kept.

**A long reply no longer snaps back to its start.** When a reply you had open grew in the same moment a newer message arrived, it came back collapsed and the view jumped to its first line. An opened reply now stays open while it grows.

## 0.2.36

**The suggested reply appears only when the session is idle**, as in the desktop app. While a session is working, the "Suggested" strip and its text are hidden; they come back when the turn ends.

**`~/` file links open.** A link such as `~/.claude/notes.md` now opens from your home folder (owner only; shared users get no `~`). Sign-in and key files (`.credentials.json`, `.env`, `*.pem`, `id_rsa`…) are never shown in the file viewer, wherever they are.

## 0.2.35

**No more "queued" ghost above a message that was delivered.** If the app caught a message in the instant between being queued and being picked up, and you were scrolled up, that "queued · waiting to be picked up" copy could stay on screen above the delivered one, with a live "send now". It is now removed as soon as the message arrives, and never kept from an older page.

## 0.2.34

**The chat stops moving under you.** At the bottom, a new message no longer leaves you looking at the middle of it (content that finished laying out after the scroll used to push the newest text below the edge). Scrolled up to read, nothing moves what you are reading: not new messages, not rows settling above you, not a bar appearing at the top. Tapping Show more or a Working row keeps the thing you tapped where your finger is.

**The "↓ N new" count is of replies you can read.** Tool steps and "Working" rows no longer count, and neither does older history loading at the top: 100 steps and 5 replies reads as 5.

**Fewer buzzes with the app open.** A burst of "Finished" banners vibrates once a minute at most, matching the phone notifications in 0.2.32.

## 0.2.33

**An open web app tells you when a new version is ready.** Leave Relaymote open on your phone and update the desktop, and a banner at the top now says "Relaymote 0.2.33 is ready" with Reload (or ✕ for later). Before, the only sign was a line at the foot of the session drawer.

## 0.2.32

**Hear a message read aloud.** Each message has a 🔊 button. It uses your phone's or browser's own voice (nothing is downloaded or sent anywhere), with − / + to change the speed, a Stop button, and the message scrolling along as it reads; scroll yourself and it stops following for a few seconds. Code blocks are skipped. The speed you pick is remembered.

**Opening a session from the board no longer sends your queued replies.** "Open session ›" is for looking: your replies stay queued, and a card at the bottom says "N messages scheduled" with **Send all** (or **Board** to go back). Closing the board the ordinary way still sends them, as before. A reload while they are held does not send them either.

**A burst of "Finished" alerts is one notification.** When several sessions finish within a minute, the phone shows one notification that updates itself ("3 sessions finished: …") instead of buzzing for each. "Needs your input" alerts are unchanged: each one still alerts.

## 0.2.31

**File paths with spaces open from chat.** A path in backticks such as `` `memento mcp/docs/PLAN.md` `` used to become a link to only the part after the last space (`mcp/docs/PLAN.md`), which the viewer then could not find. A path in a code span now opens whole, a markdown link may point at a path with spaces (plain or in `<...>`), and a bare Windows path such as `D:\My Projects\app\PLAN.md` links in full. The phone and desktop web app pick this up on their next reload.

## 0.2.30

**The file viewer works when your project folder is reached through a link.** On macOS (where temporary folders live behind `/var` → `/private/var`) and on Windows paths with short or linked names, a file that had not been written yet was reported as outside every project instead of "not found", and the 0.2.29 cross-project lookup never got a chance to run. Paths are now compared through their real location. 0.2.29 was not published: its tests caught this on macOS and Windows.

## 0.2.29

**File links from another project now open.** A session often names a file by a path relative to the project it worked in, which may not be its own folder (`docs/marketing/reddit-post.md` from a session started elsewhere). The file viewer used to answer NOT_FOUND. It now also looks in the sibling folders of the projects your sessions work in and opens the file when exactly one matches; if two projects have that path it says so instead of guessing. This applies to the owner only, never to a shared sub-user.

## 0.2.28

**Phone alerts can no longer stop silently.** If every phone's push subscription is gone for 30 minutes, Relaymote now says so once over your backup channel (or `notifications.healthAlarm`), and again when a phone is back; while it lasts it repeats once a day, never more. Each alert is logged with what actually happened (`web push sent 1/1`, pruned or failed phones by name), and one that reached no phone is logged as DROPPED instead of looking delivered. A push service that answers 5xx, 429 or times out no longer costs you the subscription (only 404/410 remove one), and an unreadable `push.json` is refused instead of being replaced by an empty one, which used to unsubscribe every phone. The app now tells the desktop what happened when it re-subscribes on open.

## 0.2.25

**Relaymote puts you back on the session you were on.** When a call has to open another session (a goal, a chip start, a picker change, a compaction, an answer), Relaymote now routes you back, reveals your session's row if the sidebar had scrolled it out of view, and checks that it worked. Before, it clicked the row only if it was visible and never checked, and a goal that hit an error skipped the step entirely.

## 0.2.24

**Your own model and effort choices are kept; everything else starts on the default.** A model or effort you change by hand in a session is left alone for 4 hours (Settings › Models, "Keep my own changes for"); after that, Relaymote may put the Settings › New session default back. With "Use these before a wake" on (the default), Relaymote moves a session to the default before the Conductor or a master wakes it. Chips now start on the default model and effort before their first message: the session that starts a chip is switched for the moment of the start and then put back. New tool: relaymote_prepare_wake, to call before waking sessions with send_message.

## 0.2.23

**Every spawn starts on the model and effort you chose.** A worker started with no model or effort now takes Settings › New session, the same default the phone uses. The Conductor protocol tells it to set model and effort before every wake or spawn; ops lanes may go lower.

**General teachings ship with Relaymote.** Rules that fit anyone (finish the task, clean up, never tune a figure to sit under a threshold, a check must be able to fail) now come in the box and are read with relaymote_protocol "teachings". Your own teachings file stays on your machine and is never shipped.

## 0.2.22

**Only the keyboard pauses the debugger countdown, and only on the last second.** Moving or clicking the mouse never pauses it. A key pressed while the bar shows "1" snoozes it until the keyboard has been quiet for 5 seconds; keys pressed on "3" or "2" are ignored.

## 0.2.21

**The debugger countdown says why it paused, and sits at the top of the screen.** When you move the mouse, click
or type during the "3, 2, 1", the bar now reads, for example, "Relaymote: snoozed - mouse moved. Trying again in 5s".
The bar moved from the bottom of the screen, where it covered Claude's message box, to the top centre.

## 0.2.20

**The debugger countdown waits for you.** If you move the mouse or type during Relaymote's "3, 2, 1", it pauses
("paused while you use the computer - trying again in 5s") and counts down again once you have been still for
5 seconds. If you keep working for a minute, it gives up for now and tries again a minute later. When it is
done, the mouse pointer goes back to exactly where it was.

**Relaymote comes back as soon as Claude Desktop opens, without the tray too.** With "Run Relaymote only while Claude
Desktop is open" on and Relaymote started without its tray icon (headless autostart), Relaymote used to return only on
the 10-minute check. It now starts within a few seconds of Claude Desktop opening.

## 0.2.19

**"Turn it on for me" always says what happened.** Pressing it could end with nothing on screen: Relaymote threw
away the reason the switch-on failed. It now always ends with a result or a plain reason, kept on the card, for
example that Claude Desktop is not signed in, or that Windows blocked the clicks because the computer is locked
or its Remote Desktop session is closed. Windows does not deliver simulated clicks to a locked or disconnected
session. With no answer after 90 seconds, the button says so.

**The debugger comes back on by itself, fast, and without touching the window size.** After Claude Desktop starts
and you are signed in, Relaymote shows a small bar at the bottom of the screen ("Relaymote: turning on Claude's debugger
in 3, 2, 1"), then switches it on in a few seconds. It no longer waits for you to be away from the keyboard. A
maximised Claude window stays maximised; before, it could be restored to a smaller size.

**Run Relaymote only while Claude Desktop is open** (Settings › Advanced, off by default). With the tray icon, Relaymote
starts within seconds of Claude Desktop opening. When Desktop exits, Relaymote runs the account sync if it is on
(that is the only time every account can be written), then stops. It waits for running Relaymote tasks first, and it
stays up if Desktop reopens during the sync.

## 0.2.18

**Markdown and text files a session sends open in Relaymote.** Tapping a sent `.md` file opens it in Relaymote's file
viewer, formatted: headings are real headings that wrap on a phone, lists show as bullets, and bold that runs
across a line break still reads as bold. Other text files (`.txt`, `.log`, `.json`, `.csv`, scripts and the like) open
there as plain text instead of in a new tab. A very large file shows its first 2 MB.

## 0.2.17

**Files a session sends you open in the app.** When a session hands you a file (Claude Code's SendUserFile), the
chat now shows it as its own card: audio and video play and seek in place, images show inline, and every file has a
link that opens it in a new tab. Before, the file usually sat outside the project folder, so Relaymote could not open it,
and the send was hidden inside the "Working" steps. Only files the session actually sent can be opened this way.

## 0.2.16

**The message you are reading stays put.** In a long conversation, after you scrolled up far enough to load older
messages, the next reply could throw those older messages away and jump the view to somewhere else. New replies
now land below without moving what is on screen; the ↓ button says how many arrived. An expanded "Working"
group also stays open while the turn runs.

## 0.2.15

**The connection dot is round.** In 0.2.14 the green dot beside "Relaymote" was stretched into a wide oval. It is a
round dot again, the same size as the others.

## 0.2.14

**Reopening Relaymote continues where you were.** Close the app and open it again within 30 minutes and you land exactly
where you left off: the same session, the Board, or the session list. After longer than that, the first time, or when
that session has gone, Relaymote opens the session that is open in Claude Desktop on your PC, so the most relevant
conversation is in front of you and you can switch from there. The Board no longer opens by itself.

**A green dot when Relaymote is connected.** With no session open, the dot beside "Relaymote" is green while the app is
connected to your PC and Claude Desktop answers, red when Desktop cannot be reached, and grey while connecting.

**"This app cannot be installed" fixed over plain http.** Chrome can only install web apps from an `https://` address.
Opened over a Tailscale or LAN `http://` address, Install and Create shortcut used to fail with that message. Over
http Relaymote now offers no app manifest, so Chrome's **Add to Home screen** makes an ordinary shortcut. Opened over
`https://`, Relaymote installs as an app as before.

## 0.2.13

**Web links in chat are tappable.** A plain `http://` or `https://` address in a message now opens in a new tab
when you tap it. Only web addresses become links, never `javascript:` or `data:`. File paths still open Relaymote's
file viewer, and the path inside a web address is no longer mistaken for a file.

## 0.2.12

**No more console windows.** On Windows, starting Relaymote in the background (`relaymote start`, `relaymote open`, the Start-menu
shortcut, a self-repair, and the restart after an automatic update) could leave an empty "node" console window on
the desktop. Closing it stopped Relaymote. Every background start now goes through the same hidden launcher the sign-in
task uses, so no window appears. The update that installs 0.2.12 is still started by the version you have now, so
one brief window may appear during it; later updates do not show one.

## 0.2.11

**Board replies go as one message.** Every tap on the Board (Done, Yes, Skip, an answer) is now queued instead of
sent on its own. The queue goes to your Conductor as a single message, one `[board]` line per card, when you tap
**Send all as one**, when you close the Board by any route, or the next time you open the app if it was closed
first. A queued card shows what you chose and can be undone until then, and a retry after a dropped connection
is never delivered twice. The old opt-in Batch switch is gone.

**More room for the list on a phone.** Refresh is now the ↻ in the Board's title row, search and the day chips
share one row, and in compact density the footer Done gives way to the X at the top. A day chip now filters the
"For you" cards too, and the list says how many older ones it is holding back, with one tap to show them all. The
Handled count now matches what tapping it shows. A session you open while the app is still starting is no longer
covered by the first screen.

**Updates on locked-down Windows.** Where Windows refuses the updater's first way of starting the installer (seen on
Windows Server as a standard user), it now uses a one-off scheduled task instead, and the tray icon comes back
after the update if it was running before.

## 0.2.10

**Opens where you left off.** A fresh start of the app no longer shows an empty page behind the session list.
If the Board has something only you can do, it opens on the Board; otherwise it opens the session you were last
in (or, the first time, the most recently active one). Anything you tap while it loads wins, and a link to a
session or to the Board still goes straight there.

## 0.2.9

**Automatic updates.** A Windows install now keeps itself current. Every 6 hours Relaymote checks for a new release,
downloads the installer, and installs it only if the release's checksum file carries a valid signature by the Relaymote
release key and the installer matches it. It then restarts, which takes about 15 seconds and never happens while a task
is running. Turn it off under Settings › Main features › Automatic updates. `relaymote update` says whether a newer
release is out; `relaymote update --apply` installs it now. The portable zip and macOS copies only report a new release
for now. Install 0.2.9 once by hand; from then on updates arrive by themselves.

## 0.2.8

**Closing a sheet.** Swipe down to close now starts only on the bar at the top of a sheet (the handle); scrolling
the content back up no longer closes the Board by accident. Every sheet also has an X in that bar, which stays in
view while you scroll. Opening the Board from a link no longer puts the session list behind it, so the first
X, Done or swipe closes the Board instead of seeming to do nothing.

## 0.2.7

A link to the Board's goals (`#board=goals`) now opens the goals register expanded, as the Goals chip does;
before, it opened collapsed and looked empty.

## 0.2.6

**Text size and density** ("Aa" at the foot of the session list). Text size runs from 70% to 150% and
scales the whole layout, not only the fonts, so smaller text fits more sessions, cards and messages on the screen.
Density is Compact (the new default: less white space, same tap targets on a touch screen) or Comfortable (the
earlier look). Both are saved per device. On a desktop window, sheets now open centred and use most of the height.

## 0.2.5

**Idle-CLI reaper: a Remote Control session is now never released, and the option to allow it is gone.** 0.2.4
had a `reaper.spareRemoteControl` setting and a `relaymote reaper --rc-too` flag. Releasing a Remote Control session
clears its phone link, so it disappears from the phone, and a message from the desktop brings it back under a new
link, leaving the old phone entry dead. Both were removed; an old `spareRemoteControl: false` in your settings is
ignored. The guard also covers a session that only has a live Remote Control link.

## 0.2.4

**Idle-CLI reaper** (optional, off by default). Every open session keeps a Claude Code process of about 400 MB,
used or not. The reaper frees the ones idle for 3 hours or more through Claude's own teardown; your next message
resumes the session with its full history. It never touches a session that is running, unread, waiting on you,
queued, on Remote Control, owning a goal or in an await. For its first 24 hours it only logs
what it would free (`relaymote reaper` shows a pass now).

## 0.2.3

Windows: no Relaymote command opens a console window any more. `relaymote setup`, `relaymote debugger` and the
MCP registration (also run by the uninstaller) now start their helpers hidden; in a terminal their output still
shows. A new check fails the build if any future helper could open a window.

## 0.2.2

Model and effort are compared by exact version, never by family. Before, a session on Opus 5.5 lit both
"Opus 5.5" and "Opus 5" on the phone; switching to Opus 5 could pick Opus 5.5 and report success; moving
from Opus 5 to Opus 5.5 skipped the confirm dialog; and a change to High effort that never landed passed as
"Extra high".

## 0.2.1

The 0.2.0 macOS builds did not pass their checks, so 0.2.0 shipped for Windows only. 0.2.1 fixes that and adds
the macOS downloads. Also fixed: account sync now copies a record's modified time exactly on macOS and Linux
(before, it could differ by under a millisecond from the source).

## What's new in 0.2

- **Goal chaser** — goals with owners, checks and due dates; a session that stopped early is nudged, and a
  "done" waits for your verification. **Cache keeper** — nudges land inside a session's 1-hour prompt cache.
- **Board + inbox** — everything that needs you on one screen; tap several answers and send them in one batch.
- **Project index** — transcripts read into the index incrementally: pending and buried questions, fleet tree,
  context size; routing that learns from your corrections.
- **Context hygiene** — which sessions should compact, write state first, rotate or be archived; optional safe
  auto-compact. Archive candidates now come with reasons.
- **Session overviews and roles** — optional, through an engine you choose (off by default).
- **Accounts** — safer sync (group folding opt-in, a fresh check that Claude is closed inside the lock), a check
  after Claude restarts, Gateway-mode groups, undo.
- **Backup alerts** via ntfy, a webhook or a local command; **finish-the-task hook** (optional).
- **Fixes:** web push was rejected by push services; `relaymote stop <task-id>` stopped the whole daemon; "This
  computer only" also listened on the Tailscale address; the session drawer's icons spilled onto the main screen
  on phones.

## Downloads

| File | For |
|---|---|
| `Relaymote-Setup-<version>-x64.exe` | **Windows 10/11 installer (recommended).** Installs for your user only and needs no admin rights. |
| `Relaymote-<version>-win-x64-portable.zip` | Windows without installing. Unzip it, then run `start-relaymote.cmd` (or `relaymote.cmd setup`). |
| `Relaymote-<version>-arm64.dmg` | macOS on Apple Silicon (M1 and newer). **Untested, see below.** |
| `Relaymote-<version>-x64.dmg` | macOS on Intel. **Untested, see below.** |
| `Relaymote-<version>-macos-<arch>-portable.tar.gz` | macOS without the app bundle. Run `./relaymote setup`. |
| `SHA256SUMS.txt` | Checksums for every file above. |

You also need **Claude Desktop**, installed and signed in: https://claude.ai/download

## Windows

1. Run `Relaymote-Setup-<version>-x64.exe`. Windows SmartScreen may say the publisher is unknown, because the installer is not code-signed. Click **More info › Run anyway**.
2. Leave both boxes on the last page ticked:
   - **Start Relaymote when I sign in** starts Relaymote and its tray icon when you log in.
   - **Run first-time setup** checks Claude Desktop, turns on its **Developer Mode** and **main-process debugger** (Relaymote needs the debugger to send messages and resume sessions), registers Relaymote's tools with Claude Code, and opens Relaymote.
3. If setup had to turn Developer Mode on, quit Claude Desktop (tray icon › Quit) and open it again. Relaymote then switches the debugger on by itself once you are signed in, after a 3-2-1 countdown on screen. You can also run **Relaymote — Status** from the Start menu, or `relaymote debugger`.
4. To connect your phone, use **Start menu › Relaymote — Pair a phone** and scan the QR code.

The installer adds a `relaymote` command to your PATH (open a new terminal to use it). Uninstall from **Settings › Apps**. Uninstalling stops Relaymote and removes its autostart and its Claude Code tool registration. It keeps your settings and pairing key in `%USERPROFILE%\.relaymote`; delete that folder yourself if you no longer want them.

## macOS: untested

**We have not tested the macOS builds on a real Mac.** CI builds them, mounts the DMG and runs the bundled CLI, and that is all. Please open an issue if something does not work. The Windows-only extras (tray icon, sign-in autostart, automatic debugger switch-on) are not available on macOS.

The app is **not signed or notarized**, so macOS blocks the first launch:

1. Drag **Relaymote.app** into **Applications**.
2. Open it once. When macOS refuses:
   - macOS 14 and older: right-click Relaymote.app, choose **Open**, then click **Open**.
   - macOS 15 and newer: go to **System Settings › Privacy & Security** and click **Open Anyway**.
   - Or in Terminal: `xattr -dr com.apple.quarantine /Applications/Relaymote.app`
3. The first launch runs setup: it turns on Claude Desktop's Developer Mode and opens Relaymote. Quit and reopen Claude Desktop, then choose **Developer › Enable Main Process Debugger** in Claude Desktop's menu.

The command line is inside the app: `/Applications/Relaymote.app/Contents/Resources/app/relaymote status`. The launcher writes its log to `~/.relaymote/state/launcher.log`.

## Checking a download

On Windows: `certutil -hashfile <file> SHA256`. On macOS: `shasum -a 256 <file>`. Compare the result with `SHA256SUMS.txt`.
