---
title: Remote control
description: Use your Code sessions and chats from your other computers' browsers or from scripts, letting trusted computers in without a token, or each device with its own token.
---

# Remote control

Remote control lets your other computers use the Code sessions and chats on this one, from a browser or a script. Turns still run here, with this computer's files and models. It is off by default, and Haruspex has to be open for it to work.

It is not the same as Guest chat (see the `guest-chat` page), which lets other people chat with your Haruspex. Remote control is for you.

## Turn it on

1. Open Settings → Remote control.
2. Turn on **Let your other computers use this Haruspex**.
3. Choose **Who can connect** (below).

Allow port 8788 through this computer's firewall for the computers you mean.

## The certificate warning

The page uses HTTPS with a certificate Haruspex makes itself, so a browser warns on the first visit. Check that the SHA-256 fingerprint in its certificate details matches Settings → Remote control → Advanced → Certificate, then continue; the browser remembers. Expect it again when the certificate is replaced: yearly, or after changing the link address.

## Who can connect

- **Devices with a token**: only devices you add. Click **Add a device…**, give it a name (just a label for the list), choose what it may do, and click **Create link**. Open the link it shows on that computer, or scan the QR code: it works once, within 10 minutes, and the browser stays signed in. For a script, open **Token for a script** instead. Neither is shown again.
- **These computers**: the computers you list, by name or IP address, connect without a token. Names are looked up on your network, so a computer whose address changes keeps working; the list shows where each name points, or "not found".
- **My whole network**: any computer on your local network connects without a token. Only for a network you trust.

With either of the last two, open the address shown under **Open on your other computer** on that computer. Devices with a token work in every mode.

Each device with a token has its own permissions: **Read** (list and follow sessions), **Drive** (start, send, steer and stop), **Approve** (answer **Run this command?** and the agent's questions) and **Settings** (scripts only; off for a new device). **New link** gives a device a fresh link and a new token; **Revoke** cuts it off at once.

## Use it from a browser

The page lists your Code sessions, the open ones first. Pick one to follow it as it runs, send messages, steer or stop a turn, and answer what a turn asks: commands, the agent's questions, MCP tools, skill writes (edit the file first if you like) and whether to use a repo's instructions. **New session** starts one in a folder on this computer, in a new worktree if you tick it; on Windows, pick This PC or a WSL distro first.

`/compact` and the summary divider work as in the Code tab (see `code-sessions`). File names in a session are links: click one to read the file (it can't be edited from the page). Images attached to messages show as thumbnails, and pictures the model put in an answer show as they do here; click one for full size.

**Chat** (the switch atop the list) shows your chats, newest first. Open one to read it or carry it on; its working folder, Python sandbox and memory work as usual, and this computer stays on its chat. Chats answer at once, and sending to one that's answering steers it (see `chat-conversations`); each is marked Writing, Waiting or New. You can stop, continue or retry a reply, and answer **Run this Python?**, **Remember this?** and **Take a screenshot?** from the page.

## Advanced

- **Port**: 8788.
- **Listen on all networks**: on, so other computers can reach it; choosing **These computers** or **My whole network** turns it on. Off, only this computer (or a proxy running on it) can connect.
- **Link address**: the address other computers use to reach this one, if it isn't the one shown, for example a name your router gives it. Links use it, and the page accepts it as this computer's name.
- **Certificate**: its fingerprint, and **Copy certificate** for a script.

## Use it from a script

Scripts use the same API, for Code sessions, chats, jobs and settings: see the `remote-control-api` page.

## What it doesn't do yet

- The Shell can't be used remotely, and the page has no Jobs or Settings (a script can use both). In chat, the page can't attach images, start deep research, or change the working folder or incognito; do those at this computer.
- Files open read-only; edit them at this computer.
- A turn you start from the page can't hand a command to this computer's Shell tab (`open_in_shell`, for sudo and the like): the agent says what to run, for when you're back. A turn started here that is waiting on one shows as waiting, and the page can let it carry on without it.

## Security notes

- Traffic is encrypted. Checking the fingerprint on the first visit is what tells you it's this computer you reached.
- Tokens are stored only as hashes, so Haruspex can't show one again.
- Ten wrong tokens in a minute from one address blocks that address for the rest of the minute.
- Web pages on other sites can't use it, even from a trusted computer: requests must come from the page itself and name this computer.
