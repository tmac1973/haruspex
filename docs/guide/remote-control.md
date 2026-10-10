---
title: Remote control
description: Drive your Code sessions from your own devices or scripts through Haruspex's owner API, with one token per device, and how to reach it safely over Tailscale.
---

# Remote control

Remote control lets your own devices and scripts drive the Code sessions running on this computer, over HTTP. Turns still run here, with this computer's files and models; another device only starts, steers and watches them. It is off by default, and Haruspex has to be open for it to work.

It is not the same as Remote access (see the `remote-access` page), which lets other people chat with your Haruspex. Remote control is for you.

## Turn it on

1. Open Settings → Remote control.
2. Turn on **Let your own devices drive your Code sessions**.
3. Under **Devices**, type a name, choose what it may do, and click **Add device**.
4. Copy the token it shows. You won't see it again; if you lose it, revoke the device and add it again.

**Port** is 8788 by default. The **Address** line shows where it answers.

## What a device may do

Each device has its own token and its own permissions:

- **Read**: list and read Code sessions, and follow them as they run.
- **Drive**: open and start sessions, send messages, steer and stop turns.
- **Approve**: answer **Run this command?** and the questions the agent asks you.

**Revoke** cuts a device off at once. Other devices keep working.

## Reach it from another device

By default only this computer can connect. To reach it from elsewhere, use a private network such as Tailscale or NetBird; Haruspex does not set one up for you.

- **Tailscale**: leave **Listen on all networks** off and run `tailscale serve --bg 8788`. Devices on your tailnet then reach it over HTTPS at your machine's tailnet name.
- **NetBird, or a home network**: turn on **Listen on all networks**, then allow the port only from the devices you mean in your firewall. Traffic is not encrypted this way.

## Use it from a script

Send the token as `Authorization: Bearer <token>`.

- `POST /api/v1/op` with an operation as JSON, for example `{"type":"sessions.list"}` or `{"type":"session.send","id":"…","text":"Fix the failing test"}`.
- `GET /api/v1/events` streams what sessions do (server-sent events).
- `GET /api/v1/health` needs no token.

## What it doesn't do yet

- There is no web page to use it from a browser yet; that comes later.
- Only Code sessions. Chat, the Shell and Settings can't be driven remotely.
- MCP tool approvals, skill writes and the new-repository trust question still have to be answered at this computer; a remote device sees that a turn is waiting on one.

## Security notes

- Tokens are stored only as hashes, so Haruspex can't show one again.
- Ten wrong tokens in a minute from one address blocks that address for the rest of the minute.
- Requests from web pages on other sites are refused.
