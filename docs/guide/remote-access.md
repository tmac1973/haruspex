---
title: Remote access
description: Let phones and other devices on your local network chat with your Haruspex through a browser link or QR code, what guests can do, and the security limits.
---

# Remote access

Remote access serves a small chat page on your local network, so another device can chat with your Haruspex using your computer's GPU. It is off by default. Guests need only a browser, so phones and tablets work.

It is useful when your main machine is busy with something else, like a game, and you want to ask a question from another device.

## Turn it on

1. Open Settings → Remote access.
2. Turn on **Let people on your network chat with this Haruspex**.
3. Share **The link to share**: click **Copy**, or let the other person scan the QR code.

**Port** sets the port the page is served on (the default is 8787). On Windows, the firewall asks the first time whether to allow Haruspex on your network; say yes, or nobody can connect. On Linux and macOS you may need to open that port in your firewall yourself.

If there is no link, your computer has no network address: it is probably offline, or on a network that does not let devices reach each other.

## What guests can do

Guests open the link, give a name (or **Skip**), and chat. They can:

- ask questions, and the assistant can search the web and read web pages for them;
- answer the assistant's clarifying questions on their own screen;
- stop an answer with **Stop**, and start over with **New chat**;
- hear an answer with **Listen**, if text-to-speech is set up on your computer.

Guests use whichever model your Haruspex is running.

## What guests can't do

Guests get web tools only. They cannot read or write files on your computer, run commands, use the shell, or reach your email, calendar or MCP servers. No wording of a prompt changes that.

Their chats are never added to your memory, so nothing a guest says becomes something the assistant remembers about you.

A guest's questions share your computer's model with you, so a busy guest can slow your own chats. Up to 8 guests can be connected at once, and the total number of messages per minute is limited.

## See and manage who is connected

Settings → Remote access lists who is connected and what each guest is asking right now. Each guest's full conversation is saved on your machine and appears in your sidebar under their name.

- **Disconnect** removes one guest.
- **Rotate link (cuts off everyone using the old one)** makes a new link. Anyone using the old link is cut off and needs the new one.
- Turning remote access off stops the page entirely.

## Security notes

- Anyone on your network who has the link can chat with your Haruspex. The link contains a long secret, so treat it like a password.
- Traffic is not encrypted. Use remote access only on networks you trust, such as your home network, not public Wi-Fi.
- It works on your local network only. Haruspex does not make it reachable from the internet.
