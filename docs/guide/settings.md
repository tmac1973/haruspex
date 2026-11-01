---
title: Settings reference
description: What each Settings section holds, its defaults, and which guide page explains it.
---

# Settings reference

Each section lists its main options, defaults and a page with more.

## Open Settings

Click the gear in the header; click it again or **← Back** to close.

## General

Appearance, reply format, lean mode and tool loading.

- **Theme**: System (default), Light or Dark.
- **Highlight color**: the accent color. Default Teal.
- **Response Format**: Minimal, Standard (default) or Rich.
- **Lean mode**: off. See the `lean-mode` page.
- **Load tools when needed**: Auto. See the `tool-loading` page.

See the `chat` page.

## Inference

Where the model runs, which model, and defaults for every tab.

- **Inference backend**: Local (Haruspex-managed) (default), Remote server (advanced) or OpenRouter (cloud).
- **Models**: download and switch local models.
- **Context Size**: 32K (up to 256K).
- **Let models use system RAM**: off.
- **Parallel streams**: 1 (also 2 or 4). More let chats, jobs and Code subtasks run at once.
- **Extra llama-server arguments**: empty. They override Haruspex's own after a restart.
- **Model defaults**: reasoning on, medium effort; replies up to 8192 tokens, 65536 for a file.
- **Server**: status, port, Restart Server; **Run Setup Wizard**.

See the `models` page.

## Chat

What only the Chat tab uses.

- **Max steps per turn**: 10.
- **Default working directory**: none.
- **Additional system prompt**: empty.
- **Enable Python sandbox**: on. **Approval prompt**: Once per chat. **Network access**: Internet and local network. **Execution timeout**: 60 seconds.
- **Pictures in answers** → **Include images in answers**: on.

See the `chat` page.

## Memory

What the assistant remembers between chats.

- **Carry facts and preferences from one conversation into the next**: on. Needs a 65 MB embedding model.
- **Ask before saving something you asked me to remember**: on.
- **Find duplicates**: merges memories that say the same thing, once you approve.
- A list of everything remembered, to edit or delete.

See the `memory` page.

## Skills

Instructions the assistant loads for specific tasks.

- **When the model uses skills**: Automatic (remote models only).
- **Skills**: turn single skills on or off; **Open skills folder**.
- **Other skill folders**: extra folders to read skills from.
- **Repos**: whether Shell and Code use a repo's own skills and AGENTS.md.

See the `skills` page.

## Audio

Voice input and spoken replies.

- **Text-to-speech voice**: Heart (Female). **Read tables by subject**: on.
- **Audio output (TTS playback)** and **Audio input (microphone)**: pick a device.

See the `chat` page.

## Search

Which provider answers web searches.

- **Search provider**: Auto (rotates free engines), DuckDuckGo, Brave Search (key), SearXNG or Browser-assisted.
- **SearXNG Instance URL**: http://localhost:8080.
- **Result recency**: Any time.

See the `search-and-network` page.

## Network

Proxies. They never apply to this computer's own services.

- **Network Proxy**: None (default) or Manual.
- **Web Search Proxy**: Network proxy (default), None or Manual.

See the `search-and-network` page.

## Integrations

Email, calendar and contacts, and MCP servers.

- **Email**: **Add email account**. Any IMAP account; most need an app password.
- **Calendar & Contacts**: **Add a calendar link** or **Add a server account** (CalDAV/CardDAV).
- **MCP integrations**: add a server from the catalog, on this computer or on your network.

See the `integrations` page.

## Screen

- **Let the assistant take a screenshot when you ask it to**: off.
- **Ask before each screenshot**: on.

See the `integrations` page.

## Shell

The Shell tab's terminal and its assistant.

- **Shell binary**: blank, for your `$SHELL`.
- **Recent shell commands attached to each chat message**: 3.
- **Include your shell history file in prompts**: on.
- **Max output bytes per captured command**: 8192.
- **Max steps per turn**: 40, both modes.
- **Start new shells with Full access**: off.
- **Command execution** (Full access): Auto: the terminal when capture works, else a process.
- **Memory limit**: 50 % of RAM.

See the `shell` page.

## Code

How the coding agent works, in the Code tab and the Shell's Full access.

- **run_command timeout**: 30 seconds.
- **Max steps per task**: 40.
- **Subtasks**: Read only, Read and write, or Off. See the `code-subtasks` page.
- **Background log size**: 5 MB per process.
- **Additional system prompt**: empty.
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

## Video generation

- **Backend**: None (default) or llama-toolchest.

See the `video-generation` page.

## Video editing

- **Let the assistant edit videos**: off. **ffmpeg**, **ffprobe**, **melt**: found or set.
- **Format**: 1080p, 60 fps. **Encoder**: x264. **Intro**, **Outro**: none.

See the `video-editing` and `video-render` pages.

## Guest chat

- **Let people on your network chat with this Haruspex**: off. Uses HTTPS.
- **Who can connect**: **People with the link**.
- **Port**: 8787.
- Once on: a link and QR code to share, and guests you can disconnect.

See the `guest-chat` page.

## Remote control

Use your Code sessions from other computers. Off; port 8788.

See the `remote-control` page.

## Feedback

Report a bug or ask for a feature.

- **Open feedback issue…**: a filled-in GitHub issue, API keys removed; check it first.
- **Save Full Diagnostics…**: saves logs to attach to the issue.
- **Let the model report problems with Haruspex's tools**: off. See the `model-feedback` page.

See the `troubleshooting` page.
