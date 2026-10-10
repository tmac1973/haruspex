---
title: Remote control
description: Use your Code sessions from your other computers' browsers or from scripts, letting trusted computers in without a token, or each device with its own token.
---

# Remote control

Remote control lets your other computers use the Code sessions running on this one, from a web browser or a script. Turns still run here, with this computer's files and models; the other computer only starts, steers and watches them. It is off by default, and Haruspex has to be open for it to work.

It is not the same as Guest chat (see the `guest-chat` page), which lets other people chat with your Haruspex. Remote control is for you.

## Turn it on

1. Open Settings → Remote control.
2. Turn on **Let your other computers use this Haruspex**.
3. Choose **Who can connect** (below).

Allow port 8788 through this computer's firewall for the computers you mean.

## Who can connect

- **Devices with a token**: only devices you add. Click **Add a device…**, give it a name (just a label for the list), choose what it may do, and click **Create link**. Open the link it shows on that computer, or scan the QR code: it works once, within 10 minutes, and the browser stays signed in. For a script, open **Token for a script** instead. Neither is shown again.
- **These computers**: the computers you list, by name or IP address, connect without a token. Names are looked up on your network, so a computer whose address changes keeps working; the list shows where each name points, or "not found".
- **My whole network**: any computer on your local network connects without a token. Only for a network you trust.

With either of the last two, open the address shown under **Open on your other computer** on that computer. Devices with a token work in every mode.

Each device with a token has its own permissions: **Read** (list and follow sessions), **Drive** (start, send, steer and stop) and **Approve** (answer **Run this command?** and the agent's questions). **New link** gives a device a fresh link and a new token; **Revoke** cuts it off at once.

## Use it from a browser

The page lists your Code sessions, the open ones first. Pick one to follow it as it runs, send messages, steer or stop a turn, and answer **Run this command?** and the agent's questions. **New session** starts one in a folder on this computer; on Windows, pick the WSL distro first.

File names in a session are links: click one to read the file (it can't be edited from the page). Images attached to messages show as thumbnails; click one for full size.

## Advanced

- **Port**: 8788.
- **Listen on all networks**: on, so other computers can reach it; choosing **These computers** or **My whole network** turns it on. Off, only this computer (or a proxy running on it) can connect.
- **Link address**: the address other computers use to reach this one, if it isn't the one shown, for example a name your router gives it or a proxy's address. Links use it, and the page accepts it as this computer's name.

## Use it from a script

Send the token as `Authorization: Bearer <token>`.

- `POST /api/v1/op` with an operation as JSON, for example `{"type":"sessions.list"}` or `{"type":"session.send","id":"…","text":"Fix the failing test"}`.
- On Windows, `session.new` takes a `wslDistro` with a Linux `root` (`{"type":"session.new","root":"~/proj","wslDistro":"Ubuntu"}`); `{"type":"wsl.distros"}` lists them.
- `GET /api/v1/events` streams what sessions do (server-sent events).
- `GET /api/v1/health` needs no token.

From a trusted computer, send `X-Haruspex: 1` instead of a token.

## What it doesn't do yet

- Only Code sessions. Chat, the Shell and Settings can't be used remotely.
- Files open read-only; edit them at this computer. Images the model put in an answer aren't shown.
- MCP tool approvals, skill writes and the new-repository trust question are answered at this computer; the page says when a turn is waiting on one.
- A command handed to a Shell tab (`open_in_shell`) waits for you to run it at this computer; the page can only let the turn carry on without it.

## Security notes

- Traffic between computers is not encrypted. Use it on networks you trust.
- Tokens are stored only as hashes, so Haruspex can't show one again.
- Ten wrong tokens in a minute from one address blocks that address for the rest of the minute.
- Web pages on other sites can't use it, even from a trusted computer: requests must come from the page itself and name this computer.
