---
title: Other computers
description: See and carry on the Code sessions and chats of your other computers running Haruspex, from this one, with their prompts answered here.
---

# Other computers

If you run Haruspex on more than one computer, each can show the others' Code sessions and chats in its own Code and Chat tabs. Nothing is copied: a session or chat keeps running on the computer it belongs to, with that computer's files, models and memory. This one shows it live and sends what you type.

It uses the other computer's Remote control (see the `remote-control` page), so that has to be on there.

## Turn it on

1. On the other computer: Settings → Remote control → turn on **Let your other computers use this Haruspex**, and under **Who can connect** let this computer in (below).
2. On this computer: Settings → Remote control → Other computers → turn on **Show my other computers here**.
3. Computers on your network show under **Found on your network**. Click **Connect…** and check the certificate (below).

The other computer appears under **Your computers** with its status: Connected, Connecting or Offline.

## Let this computer in

On the other computer, Settings → Remote control → Who can connect:

- **These computers**: add this computer's name or address. Use this for a computer on a tailnet (Tailscale and the like).
- **My whole network**: any computer on your local network. It covers home and office addresses (192.168.x.x, 10.x.x.x), not tailnet ones.
- **Devices with a token**: see the token section below.

## Add a computer that isn't found

Computers are found only on the same local network, and only while their Remote control listens on all networks. For any other (over a tailnet, or another subnet), click **Add a computer…**, type its name or address and its port (8788 unless changed), and click **Connect…**.

## Check the certificate

The first time, Haruspex shows the other computer's certificate fingerprint. Check it matches Settings → Remote control → Advanced → Certificate on that computer, then click **Trust**. It's remembered. **Don't trust** stops it being offered again; adding it by hand asks again.

If a computer later shows **Certificate changed**, nothing is sent to it until you click **Check again…** and trust the new one. That's expected when its certificate nears expiry (yearly) and after its name or link address changes. If neither happened, don't trust it.

## When the other computer needs a token

A computer that doesn't let this one in shows **Not letting this computer in**. Either change its Who can connect (above), or on that computer click **Add a device…**, open **Token for a script**, and copy the token. Here, click **Use a token…** and paste it. The token is kept in this computer's secret store.

## What you can do

- **Code**: each computer's sessions are listed under **On <name>** in the Code tab. Open one to follow it, send, steer, stop, `/compact`, fork, and change its effort or model (one of that computer's own). Right-click one to rename or delete it there; a worktree it uses stays. **New session** has a **Where** choice to start a session on another computer, in one of its recent folders or a path you type. File names open read-only.
- **Chat**: its chats are listed under **On <name>** in Chat, marked Writing, Waiting or New. Open one to carry it on: send (or steer while it answers), stop, continue, retry, edit a message, rename, delete, and turn incognito on or off. Pictures, screen captures and speech are taken here and sent.
- **Notebooks**: its notebooks are listed under its name in the Notebooks tab, and search looks in them too. Read them, edit text, tables and checklists, restore earlier versions, and use a notebook's chat; Python runs, files, reordering and columns stay on that computer (see `notebooks`).
- **Prompts**: when one of its turns waits for you (Run this command?, a question, an MCP tool, a skill write, a repo's instructions, Run this Python?, Remember this?, Take a screenshot?, File already exists), the usual dialog opens here marked **On <name>**, with a desktop notification when Haruspex isn't in front. Answer it here or there: whichever is first counts. What you allow applies on that computer.
- Both tabs say **Runs on <name>** on what you opened.
- Each computer has its own colour: a bar on its section in each list, and around its **Runs on** badge. Its tabs in the Code tab name it when you point at them. This computer's rows have none.

## When it's offline

Its sessions and chats stay listed, greyed, as last seen. Clicking one says it's offline. When it comes back, Haruspex reconnects by itself.

## What it doesn't do

- It doesn't copy or merge anything between computers.
- No Shell, Jobs, Settings or Home of the other computer here, and no working folder or deep research in its chats.
- Files open read-only.
- It doesn't pass through a computer: this one shows only the computers it trusts directly.
- Camera prompts are answered on the computer that asked.
- In lean mode on the other computer (see `lean-mode`), only its chats show.
