---
title: Settings reference
description: What each Settings section holds, its most-used options with their defaults, and which guide page explains it in detail.
---

# Settings reference

Settings has seventeen sections. Each gives its main options, their defaults and the page with more.

## Open Settings

Click the gear at the right of the header; click it again, or **← Back**, to close it.

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
- **Context Size**: 32K by default (32K to 256K).
- **Let models use system RAM**: off.
- **Parallel streams**: 1 (also 2 or 4). More lets a job or Code subtasks run beside chat; each needs its own memory.
- **Extra llama-server arguments**: empty. They override Haruspex's own, from the next server restart.
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

- **Carry facts and preferences from one conversation into the next**: on. It needs a 65 MB embedding model, downloaded when you ask.
- **Ask before saving something you asked me to remember**: on.
- **Find duplicates**: merges memories that say the same thing, after you approve each.
- A list of everything remembered, to edit or delete.

See the `memory` page.

## Skills

Instructions the assistant can load for specific tasks.

- **When the model uses skills**: Automatic (remote models only).
- **Skills**: turn single skills on or off; **Open skills folder**.
- **Other skill folders**: extra folders to read skills from.
- **Repos**: whether Shell and Code use a repo's own skills and AGENTS.md.

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

How the coding agent works, in the Code tab and the Shell's Full access.

- **run_command timeout**: 30 seconds.
- **Max steps per task**: 40.
- **Subtasks**: Read only, Read and write, or Off. See the `code-subtasks` page.
- **Background log size**: 5 MB per process.
- **Auto-approve commands**: off.

See the `code` page.

## Image

Where pictures are generated, if anywhere.

- **Backend**: None (default), ComfyUI, Bundled engine (where it can run), Lemonade or llama-toolchest.

See the `images` page.

## Music

Where songs are made, if anywhere.

- **Backend**: None (default) or llama-toolchest.
- **Default length**: 30 seconds.

See the `music` page.

## Video

- **ffmpeg**, **ffprobe**, **melt**: found on PATH or in Kdenlive unless you set a path.
- **Format**: 1080p, 60 fps. **Intro**, **Outro**: none.

See the `video` page.

## Guest chat

- **Let people on your network chat with this Haruspex**: off. Uses HTTPS.
- **Who can connect**: **People with the link**.
- **Port**: 8787.
- Once it is on: a link and QR code to share, and a list of guests you can disconnect.

See the `guest-chat` page.

## Remote control

Use your Code sessions from your other computers. Off; port 8788.

See the `remote-control` page.

## Feedback

Report a bug or ask for a feature.

- **Open feedback issue…**: opens a filled-in GitHub issue in your browser. API keys are removed; check it before sending.
- **Save Full Diagnostics…**: saves logs to attach to the issue.

See the `troubleshooting` page.
