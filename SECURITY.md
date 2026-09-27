# Security

Relaymote can send messages to your Claude Code sessions, and those sessions can run commands on your
computer. Treat access to Relaymote like access to your computer.

## Model

- **Control port** (`port`, default 8788) binds to `127.0.0.1` only and is used by the CLI and the
  MCP tools on the same machine.
- **App port** (`appPort`, default 8790) requires the access key on every request (bearer header,
  `?k=` pairing link that is exchanged for an `HttpOnly` cookie, or a verified Cloudflare Access
  JWT when configured). It binds to loopback, plus your Tailscale address when present, plus all
  interfaces only when you choose *Same Wi-Fi*.
- Cloudflare tunnels forward to loopback; the access key is still required behind them.
- Cloudflare Access assertions are verified (RS256 signature against your team's published keys,
  audience, issuer, expiry) — the header alone is never trusted.
- Sub-user keys are limited to the sessions they are granted and to a small set of actions.
- Push notifications are encrypted end to end (RFC 8291) with keys generated on your machine.

## Keys and data

Everything is under `~/.baton` (or `BATON_HOME`): the access key in `mobile/secret.json`, push keys
in `mobile/push.json`, logs in `state/`. Nothing is sent anywhere except through the tunnel you
choose. Revoke every device with **Settings › Pair a phone › Issue a new key** (takes effect after a
restart), or by deleting `mobile/secret.json`.

## Reporting a vulnerability

Please open a GitHub security advisory on this repository (Security › Report a vulnerability)
rather than a public issue.
