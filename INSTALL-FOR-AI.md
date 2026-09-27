# Installing Relaymote — instructions for an AI agent

You are an AI coding agent (for example Claude Code) and a person has asked you to set up **Relaymote** on this
computer. Relaymote is a phone and desktop client for the Code tab of Claude Desktop. Follow these steps in
order. Run the commands yourself; ask the person only where a step says **ASK**. Report the result at the
end in a few lines.

Principles:
- **Never** paste the pairing link or access key anywhere except to the person in this conversation. It is a
  password to their computer.
- **Ask before** anything that creates something in an account of theirs (a Cloudflare tunnel or DNS record,
  a Tailscale sign-in).
- Do not change Claude Desktop settings other than Developer Mode and the Main Process Debugger (steps 4–5).
- If a step fails, show the person the exact error and the fix from this file; do not improvise risky
  workarounds (for example, do not kill processes you did not start).

## 1. Check the machine

```bash
node --version          # need v18 or newer
```

- **OS:** Windows 10/11 is fully supported. macOS works but is experimental. Linux has no Claude Desktop, so
  Relaymote cannot run there — stop and tell the person.
- **Claude Desktop** must be installed and signed in, with the Code tab used at least once. Its data folder
  exists at `%APPDATA%\Claude` (Windows) or `~/Library/Application Support/Claude` (macOS). If it is missing,
  tell the person to install it from https://claude.ai/download and stop.
- **No Node.js?** On Windows you can use the installer instead (step 2a), which bundles Node. Otherwise
  install Node 18+ (`winget install OpenJS.NodeJS.LTS` on Windows, `brew install node` on macOS) — **ASK**
  first.

## 2. Install

**2a. Windows installer (no Node needed).** Download `Relaymote-Setup-<version>.exe` from
https://github.com/ashwarsadh/relaymote/releases/latest and run it:

```powershell
.\Relaymote-Setup-<version>.exe /VERYSILENT /SUPPRESSMSGBOXES
```

It installs to `%LOCALAPPDATA%\Programs\Relaymote` and puts `relaymote` on the PATH for new terminals. Use the full
path `"%LOCALAPPDATA%\Programs\Relaymote\relaymote.cmd"` in the current terminal.

**2b. From source (Windows or macOS).**

```bash
git clone https://github.com/ashwarsadh/relaymote.git
cd relaymote
npm install
npm link            # optional: puts `relaymote` on the PATH; otherwise use `node bin/relaymote.js`
```

Below, `relaymote` means whichever of these you used.

## 3. Check for a port conflict

Relaymote uses ports **8788** (local control API) and **8790** (the app).

```bash
relaymote status
```

If it reports *Port 8788 is used by another program*, pick two free ports and write them to
`~/.relaymote/settings.json` (create the file if needed; keep other keys):

```json
{ "port": 18788, "appPort": 18790 }
```

## 4. Run setup

```bash
relaymote setup
```

This:
- turns on Claude Desktop's **Developer Mode** (it writes `allowDevTools` to Claude Desktop's
  `developer_settings.json`), which un-hides the **Developer** menu;
- on Windows, tries to switch on the **Main Process Debugger**;
- registers the `relaymote` MCP server with Claude Code (the conductor and master tools);
- on Windows, adds Relaymote to start at sign-in, with a tray icon;
- starts the daemon and opens the app.

If `claude` is not on the PATH, `relaymote mcp install` prints a JSON block to add to `~/.claude.json` under
`mcpServers` — do that.

## 5. Connect Claude Desktop (the Main Process Debugger)

Relaymote acts through Claude Desktop's main-process debugger (port 9229, loopback only). Run `relaymote status` and
look at the *Claude Desktop debugger* line. If it is ✘:

1. If setup printed *Turned on Claude Desktop Developer Mode*, Claude Desktop must restart once to show the
   Developer menu. **ASK** the person to quit Claude Desktop completely (tray / menu-bar icon › Quit) and
   open it again — quitting stops any session that is mid-reply.
2. **Windows:** run `relaymote debugger`. It clicks through Claude Desktop's menus to switch the debugger on.
   **Tell the person first** not to touch the mouse or keyboard for about 20 seconds.
3. **macOS, or if that failed:** tell the person to do it by hand: in Claude Desktop, **Developer › Enable
   Main Process Debugger**, then **OK**. (If there is no Developer menu: **Help › Troubleshooting › Enable
   Developer Mode** first. On Windows the menus are behind the ☰ icon at the top-left of the window.)
4. Run `relaymote status` again until the debugger line is ✔.

The debugger turns itself off whenever Claude Desktop restarts. On Windows Relaymote re-enables it automatically
once Claude Desktop is signed in, after a 3-2-1 countdown on screen; on macOS they repeat step 3 after a restart. Tell them this.

## 6. Choose how the phone reaches the computer — ASK

Ask the person which they want, briefly explaining each option:

| Choice | Command | Notes |
|---|---|---|
| Only this computer | nothing | for trying it out |
| Same Wi-Fi | set `"remote": {"mode": "lan"}` in settings.json, then `relaymote restart` | plain HTTP, no push notifications |
| Tailscale | set `"remote": {"mode": "tailscale"}`, then `relaymote restart` | Tailscale must be installed and signed in on both devices |
| Anywhere, quick link | `relaymote tunnel quick` | no account; the address changes whenever Relaymote restarts |
| Anywhere, own address | `relaymote tunnel login`, then `relaymote tunnel setup <hostname>` | needs a free Cloudflare account with a domain; creates a tunnel and a DNS record — **ASK** for the hostname and confirm before running |

Cloudflare options need `cloudflared` (`winget install Cloudflare.cloudflared` / `brew install cloudflared`)
— **ASK** before installing. `relaymote tunnel login` opens a browser window where the person authorises their
domain; wait for them.

## 7. Pair the phone

```bash
relaymote pair
```

Show the person the QR code (and the link) printed in the terminal, or tell them to open **Settings › Pair a
phone** in the app. They scan it with the phone camera, then use the browser's **Add to Home screen**.

## 8. Optional features — mention them, turn on only if asked

In the app, **Settings**:
- **Models** — model and effort per difficulty (easy / medium / hard / extra hard), and defaults for new
  sessions.
- **Modules › Accounts** — if they use several Claude accounts on this computer, keep their sidebars in sync
  (preview first with `relaymote accounts sync`; `--apply` writes).
- **Modules › Organizer** — on by default: new sessions go into their project's sidebar group.
- **Modules › Goal chaser / Cache keeper** — off by default; they message sessions on their own (nudge unfinished
  goals, time nudges inside the 1-hour prompt cache). Turn on only if asked.
- **Modules › Board / Inbox** — the one-screen list of what needs the person.
- **Finish-the-task hook** — `relaymote hooks install` (off by default; `relaymote hooks remove` undoes it). **ASK** first:
  it changes `~/.claude/settings.json`.
- **Conductor** — in any Claude Code session, the person says *"you are the conductor"*; for a project, *"you
  are the master for this project"*.

## 9. Report

Tell the person, in a few lines: what was installed and where, whether the debugger is connected, which
remote-access mode is on, and that the pairing QR is ready (never repeat the key in a place other than this
conversation).

## Troubleshooting

| Symptom | Fix |
|---|---|
| `relaymote status`: debugger ✘ | step 5 |
| Port in use | step 3 |
| `claude` CLI not found during `mcp install` | add the printed JSON to `~/.claude.json` under `mcpServers` |
| Phone cannot reach the link | the link is local-only — choose a remote-access mode (step 6) |
| Push notifications do not arrive | they need HTTPS: use a Cloudflare mode, then tap 🔔 in the app on the phone |
| Anything else | `relaymote status` output, then https://github.com/ashwarsadh/relaymote/issues |
