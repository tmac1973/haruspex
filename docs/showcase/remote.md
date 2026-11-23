---
title: Remote & sharing
description: Let people on your network chat with your Haruspex, and use it from your other computers or from a script.
---

## Let someone chat from their phone

Turn on guest chat and share the link or QR code. Guests chat in a browser using your computer's model, with web tools only.

Tab: a phone or tablet's browser on your network
Required settings: Settings → Guest chat → Let people on your network chat with this Haruspex

Prompt:

> What's a good vegetarian dinner I can make in 20 minutes?

Example output:

The guest's browser shows a small chat page with the answer, plus **Listen**, **Stop** and **New chat**. Their conversation appears in your sidebar under their name.
<!-- media: guest chat page on a phone, next to the QR code in Settings → Guest chat -->

Read more: guest-chat

## Use your Code sessions from another computer's browser

Turn on Remote control and open its page on your laptop. Follow a session, send messages and answer its prompts; turns still run on the main computer.

Tab: a browser on your other computer
Required settings: Settings → Remote control → Let your other computers use this Haruspex; Who can connect

Prompt:

> Run the tests again and fix whatever still fails.

Example output:

The page lists your Code sessions, open ones first. The session runs on the main computer, and a **Run this command?** prompt shows on the page for you to answer.
<!-- media: Remote control page in a laptop browser following a Code session -->

Read more: remote-control, code-sessions

## Carry on another computer's sessions and chats

Each Haruspex can show your other computers' Code sessions and chats under On <name>. Open one and keep going; it still runs on the computer it belongs to.

Tab: Code or Chat
Required settings: Settings → Remote control on the other computer; Settings → Remote control → Other computers → Show my other computers here; a second computer running Haruspex

Prompt:

> Where did we get to with the login page?

Example output:

The session is listed under **On desktop** and marked **Runs on desktop**. Prompts its turns wait on open here, marked **On desktop**, and what you allow applies there.
<!-- media: Code tab with a section "On desktop" and the Runs on badge -->

Read more: other-computers, remote-control

## Drive Haruspex from a script

Send operations to Remote control's HTTP API with a token: start chats and sessions, run jobs, or read Home's cards.

Tab: a script on another computer
Required settings: Settings → Remote control → Add a device… → Token for a script; Advanced → Copy certificate

Prompt:

> curl --cacert haruspex.pem -H "Authorization: Bearer $TOKEN" -d '{"type":"jobs.run","jobId":"…"}' https://desktop:8788/api/v1/op

Example output:

```json
{"value": {"runId": "…"}}
```

Follow the run with `GET /api/v1/events`, which sends `job-run` as its status and steps change.

Read more: remote-control-api, remote-control
