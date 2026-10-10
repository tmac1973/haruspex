---
title: Settings reference
description: What each Settings section holds, its most-used options with their defaults, and which guide page explains it in detail.
---

# Settings reference

Settings has fifteen sections, listed down the left side. Each one below gives the main options, their defaults and the page with more detail.

## Open Settings

Click the gear button at the right of the header; click it again, or **← Back**, to close it. There is no shortcut for it. Settings remembers the last section you opened.

## General

Appearance and how replies are formatted.

- **Theme**: System (default), Light or Dark.
- **Highlight color**: the accent color. Default Teal.
- **Response Format**: Minimal, Standard (default) or Rich.

See the `chat` page.

## Inference

Where the model runs, which model is used and how big the context is.

- **Inference backend**: Local (Haruspex-managed) (default), Remote server (advanced) or OpenRouter (cloud).
- **Models**: download and switch local models.
- **Context Size**: 32K by default (8K to 256K).
- **Let models use system RAM**: off.
- **Parallel streams**: 1 (also 2 or 4). More lets a background job run beside chat. Each stream gets the full context size, so it needs more memory (larger sizes may grey out), and replies slow while two run.
- **Extra llama-server arguments**: empty. Added after Haruspex's own arguments, so they override them. Takes effect when the server restarts.
- **Server**: status, port and Restart Server; **Run Setup Wizard**.

See the `models` page.

## Agent

How the model reasons and how long its replies may be, the Python sandbox, and pictures in answers.

- **Reasoning mode**: on. **Reasoning effort**: medium.
- **Additional system prompt**: empty.
- **Max response tokens**: 8192. **Max response tokens (file writes)**: 65536.
- **Enable Python sandbox**: on. **Approval prompt**: Once per chat. **Network access**: Internet and local network. **Execution timeout (seconds)**: 60.
- **Pictures in answers** → **Include images in answers**: on.

See the `chat` page.

## Memory

What the assistant remembers between chats.

- **Carry facts and preferences from one conversation into the next**: on. It needs a small embedding model (about 65 MB), downloaded only when you ask.
- **Ask before saving something you asked me to remember**: on.
- **Find duplicates**: merges memories that say the same thing, after you approve each.
- A list of everything remembered, to edit or delete.

See the `memory` page.

## Skills

Instructions the assistant can load for specific tasks.

- **When the model uses skills**: Automatic (remote models only).
- **Skills**: turn single skills on or off; **Open skills folder**.
- **Other skill folders**: extra folders to read skills from.
- **Repos**: whether the Shell assistant and Code sessions use a repo's own skills and AGENTS.md.

See the `skills` page.

## Audio

Voice input and spoken replies.

- **Text-to-speech voice**: Heart (Female).
- **Read tables by subject**: on.
- **Audio output (TTS playback)** and **Audio input (microphone)**: pick a device; **Refresh** rescans.

See the `chat` page.

## Search

Which provider answers web searches.

- **Search provider**: Auto (rotates free engines). Also DuckDuckGo, Brave Search (API key required), SearXNG (self-hosted) and Browser-assisted.
- **SearXNG Instance URL**: http://localhost:8080.
- **Result recency**: Any time.

See the `search-and-network` page.

## Network

Proxy settings for network connections. Proxies never apply to this computer's own services.

- **Network Proxy**: None (default) or Manual.
- **Web Search Proxy**: Network proxy (default), None or Manual.

See the `search-and-network` page.

## Integrations

Email, calendar and contacts, and MCP servers.

- **Email**: **Add email account**. Any IMAP account; most need an app password.
- **Calendar & Contacts**: **Add a calendar link** or **Add a server account** (CalDAV/CardDAV).
- **MCP integrations**: **Add from the catalog**, **Add a server on this computer** or **Add a server on your network**.

See the `integrations` page.

## Screen

Whether the assistant can see your screen.

- **Let the assistant take a screenshot when you ask it to**: off.

See the `integrations` page.

## Shell

The Shell tab's terminal and its assistant.

- **Shell binary**: blank, which uses your `$SHELL`.
- **Recent shell commands attached to each chat message**: 3.
- **Include your shell history file in prompts**: on.
- **Max output bytes per captured command**: 8192.
- **Start new shells with Full access**: off, so new tabs start Read-only.
- **Command execution**: Auto (the terminal when capture works, else a separate process), for Full access.
- **Memory limit**: 50 % of RAM.

See the `shell` page.

## Code

How the coding agent runs commands, in the Code tab and in the Shell assistant with Full access.

- **run_command timeout**: 30 seconds.
- **Max steps per task**: 40.
- **Background log size**: 5 MB per process.
- **Auto-approve commands**: off.

See the `code` page.

## Image

Where pictures are generated, if anywhere.

- **Backend**: None (default), ComfyUI or Bundled engine. Nothing is downloaded or started until you pick one. Bundled engine is hidden where it can't run.

See the `images` page.

## Remote access

Let people on your network chat with this Haruspex.

- **Let people on your network chat with this Haruspex**: off. Traffic is not encrypted.
- **Port**: 8787.
- Once it is on: a link and QR code to share, and a list of guests you can disconnect.

See the `remote-access` page.

## Remote control

Drive your Code sessions from your own devices. Off; port 8788.

See the `remote-control` page.

## Feedback

Report a bug or ask for a feature.

- **Open feedback issue…**: opens a filled-in GitHub issue in your browser. API keys are removed, but check it before you send it.
- **Save Full Diagnostics…**: saves logs to a file you can attach to the issue.

See the `troubleshooting` page.
