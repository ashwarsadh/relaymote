# Accounts: several Claude accounts, one app

If you use more than one Claude account on the same computer (say "Work" and "Personal"), Claude
Desktop keeps a separate list for each one. Switch account and your sessions, archive, sidebar
groups and routines seem to vanish. They have not; they sit in the other account's folder.

Relaymote's **Accounts** screen copies them across, so whichever account you sign in to, the app
looks the same.

Turn it on in **Settings › Modules › Accounts**, then open the 👤 button.

## What it copies

| | What | When |
|---|---|---|
| Sessions | every Code session record | any time for an account Claude is not using; the one in use waits until Claude is closed |
| Archive | which sessions are archived (the newest change wins; a clash with no clear order is left alone) | same as sessions |
| Session details | model, effort, last activity (the newer one wins; a copy you looked at more recently is never overwritten by older work) | same as sessions; subscription accounts only, never Gateway mode; usage-limit errors are cleared, never copied |
| Routines | scheduled tasks, with their on/off state | same as sessions |
| Sidebar groups | each account's own groups are repaired if Claude loses them; folding groups **across** accounts is off unless you switch it on (Advanced) | only while Claude Desktop is closed |

Nothing is ever deleted by default. Something missing from one account is copied in, never taken
as "delete it from the other". Before every write Relaymote keeps a backup and a journal, so any sync
can be undone (`relaymote accounts undo`).

## Three ways to sync

Pick one per account on the Accounts screen, or a default in Settings:

- **Keep this account as it is**: nothing is written to it.
- **Add the other accounts' data into this one** (default): new sessions and routines are added,
  and archive marks and session details are carried (each can be switched off under Advanced).
  Nothing is removed.
- **Two-way**: both accounts end up with everything, and the newer details win on both sides.

You can also choose which accounts take part: all accounts on this computer, or only the ones you tick.

## Adding an account

1. In Claude Desktop, log out, then log in with the other account.
2. Open the Code tab once, so Claude creates that account's folder.
3. Come back to Relaymote. The new account appears on the Accounts screen.
4. Press **Copy my sessions into this account** (or choose Two-way), check the preview, then **Sync now**.

The account you are signed in to can only be written while Claude Desktop is closed. **Close Claude,
sync, reopen Claude** does that in one go: it first lists any session that is still working or waiting
for you and waits for your tap. It asks Claude to quit normally; it only force-closes after a second,
separate confirmation. Then it syncs and starts Claude again.

Without it: quit Claude Desktop yourself, press **Sync now**, and open Claude again.

## Every sync starts as a preview

**Preview sync** shows what would change, per account, and changes nothing. **Sync now** writes it.
From the command line:

```sh
relaymote accounts                        # accounts, and what a sync would change
relaymote accounts sync                   # preview only
relaymote accounts sync --apply           # write it
relaymote accounts sync --two-way --to 2 --apply
relaymote accounts undo                   # reverse the last sync (Claude Desktop must be closed)
```

**Sync by itself** (Settings) runs on a timer, on **every** Claude Desktop exit, and once when Relaymote
starts before Claude does, so work that was waiting for Claude to close gets done.

When you switch account in Claude and answer **Bring my things** to Relaymote's question, Relaymote syncs toward
that account only. The account in use can be written only while Claude is closed, so this waits for the
next exit (retried for up to 7 days). It never closes Claude for you.

## Advanced

Under **Advanced** on the Accounts screen, or from the command line:

```sh
relaymote accounts sync --fold --apply     # also fold sidebar groups across accounts (off by default)
relaymote accounts sync --copy-only        # sessions and routines only: no archive marks, no details
relaymote accounts hold on|off             # pause the session-details part only
relaymote accounts freeze local_<id> [why] # this session keeps its own details; unfreeze to include again
relaymote accounts first-run baseline|archived-wins   # how a first-seen archive clash is settled
relaymote accounts journals | undo [journal]
relaymote accounts groups-backups | groups-restore <stamp|latest>
relaymote accounts forget <scope> <group id>          # a group you deleted on purpose is never restored
relaymote accounts verify                  # the last relaunch check
```

- **Undo** backs up what is there now before it restores, so an undo can itself be undone, and it
  rebuilds every account's archive index afterwards.
- **Relaunch check.** After Relaymote writes sidebar groups, it waits until Claude Desktop is open again,
  lets it settle for 3 minutes, and counts both places Claude keeps groups. If Claude put back an older
  copy, the Accounts screen says so.
- **Gateway mode** (third-party inference) keeps its own groups in its own store. Relaymote finds it, seeds it
  once from the account you used last when it is empty, creates its settings copy, and keeps separate
  snapshots. Session details are never written into it.

### Start Claude through Relaymote (Windows, opt-in)

```sh
relaymote accounts launch-hook install     # Claude's startup entry now runs Relaymote first
relaymote accounts launch-hook remove      # puts Claude's own entry back, exactly as it was
```

At sign-in Relaymote runs the repair pass while Claude is still closed (at most 150 seconds), waits for any
other writer to finish, then starts Claude (the Store version through its app id). If anything fails,
Claude still starts.

### Coming from another sync tool

```sh
relaymote accounts import-migrate <dir>            # preview only
relaymote accounts import-migrate <dir> --apply    # import
```

Reads the other tool's `sync-state.json`, `account-labels.json`, `state-sync-freeze.json`,
`HOLD-STATE-SYNC` and `scope-snapshots/` (including groups you deleted on purpose). The source folder is
never changed. It refuses if Relaymote already has sync history; add `--merge` to combine them (Relaymote's own
facts win where both have one).

**Only one sync tool may write.** Switch the other tool's automatic runs off before you turn on
**Sync by itself**. If both must run, point them at the same lock file with the `accounts.lockFile`
setting, so one waits while the other writes.

## Where things are

- Claude Desktop's data: `%APPDATA%\Claude` on Windows, `~/Library/Application Support/Claude` on macOS.
- Relaymote's backups, journals, labels, snapshots and the sync lock: `~/.relaymote/accounts` (or `$RELAYMOTE_HOME/accounts`).
- Account names come from the Claude Code login (`~/.claude.json`) when they match; otherwise
  rename an account yourself on the Accounts screen.

## Platform notes

- **Windows**: everything above, including telling whether Claude Desktop is running, the Store
  (MSIX) version of Claude, and close/sync/reopen.
- **macOS**: the sync itself uses the same files and should work, but it is **untested**. Relaymote checks
  whether Claude is running with `ps`. Close/sync/reopen is not automated; follow the manual steps.
- **Linux**: Claude Desktop does not run there, so there is nothing to sync.
- Sidebar groups need the optional `classic-level` package (installed with Relaymote). Without it the
  other parts still sync.
