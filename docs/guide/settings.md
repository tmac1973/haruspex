---
title: Settings reference
description: What each Settings section holds, its defaults, and where to read more.
---

# Settings reference

## Open Settings

Click the gear in the header; **← Back** closes.

## General

Appearance, Home, sleep during jobs, running in the background, replies, lean mode and tool loading.

- **Show the Home tab**: on.
- **Keep the computer awake** while a job runs: All jobs, Not Home cards (default) or Never (see `jobs`).
- **Background**: **Keep running in the tray** and **Start at login**, both off (see `tray`).
- **Theme**: System (default), Light or Dark.
- **Highlight color**: Teal (default).
- **Response Format**: Minimal, Standard (default) or Rich.
- **Lean mode**: Off (default), Lean or Lean + files (see `lean-mode`).
- **Load tools when needed**: Auto (see `tool-loading`).

See the `chat` page.

## Inference

Where the model runs, which model, and defaults.

- **Inference backend**: Local (Haruspex-managed) (default), Remote server (advanced) or OpenRouter (cloud).
- **Models**: download and switch local models.
- **Context Size**: 32K (up to 256K).
- **Let models use system RAM**: off.
- **Parallel streams**: 1 (also 2 or 4).
- **Extra llama-server arguments**: empty; they override Haruspex's.
- **Model defaults**: reasoning on, medium effort; replies to 8192 tokens, 65536 for a file.
- **Server**: status, port, Restart Server; **Run Setup Wizard**.

See the `models` page.

## Chat

What only the Chat tab uses.

- **Max steps per turn**: 10.
- **Default working directory**: none.
- **Additional system prompt**: empty.
- **Enable Python sandbox**: on. **Approval prompt**: Once per chat. **Network access**: Internet and local network. **Execution timeout**: 60 seconds.
- **Include images in answers**: on.

See the `chat` page.

## Memory

What the assistant remembers between chats.

- **Carry facts and preferences from one conversation into the next**: on. Needs a 65 MB model.
- **Ask before saving something you asked me to remember**: on.
- **Find duplicates**: merges repeated memories, if you approve.
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
- **Speech engine**: Kokoro, on this computer. **llama.cpp server** speaks through a llama-server v0.8.0 or newer, or llama-toolchest, with an address, key and speech model; reading answers aloud stays on Kokoro.
- **Saved voices**: none. **Add from file…** saves a reference clip once you tick that it is your voice or one you may use.
- **Audio output (TTS playback)** and **Audio input (microphone)**: pick a device.
- **Speech model**: Fast (base.en, English only). Accurate (large-v3-turbo) understands more languages and long dictation better; it is a 1.6 GB download shared with the video tools.

See the `chat` and `speech` pages.

## Search

Which provider answers web searches.

- **Search provider**: Auto (rotates engines), DuckDuckGo, Brave Search (key), SearXNG or Browser-assisted.
- **SearXNG Instance URL**: http://localhost:8080.
- **Result recency**: Any time.

See the `search-and-network` page.

## Network

Proxies, never used for this computer's own services.

- **Network Proxy**: None (default) or Manual.
- **Web Search Proxy**: Network proxy (default), None or Manual.

See the `search-and-network` page.

## Integrations

- **Email**: **Add email account**. Any IMAP account; most need an app password.
- **Calendar & Contacts**: **Add a calendar link** or **Add a server account** (CalDAV/CardDAV).

See the `integrations` page.

## MCP servers

Add a server (catalog, local or network), pick its tools, or **Update** it. A count on its rail entry means one needs you.

See the `integrations` page.

## Screen

- **Let the assistant take a screenshot when you ask it to**: off.
- **Ask before each screenshot**: on.

See the `integrations` page.

## More sections

Cameras, Shell, Code, Image, Music, Video generation, Video editing, Guest chat, Remote control, Feedback and Licences: see the `settings-tools` page.
