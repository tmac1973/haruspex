---
title: Chat
description: Asking questions, web and deep research, sources, working with files, the Python sandbox, pictures, vision, voice, incognito and saved chats.
---

# Chat

The Chat tab is where you ask questions. The assistant can search the web, read and write files in a folder you pick, run Python, look at images and talk.

## Ask a question and get a researched answer

Type a question and press `Enter` (`Shift`+`Enter` for a new line). When the question needs current facts, the assistant searches the web, reads pages and answers. `Ctrl`/`Cmd` + `N` starts a new conversation, and `Esc` stops a reply.

- **Sources** — answers cite their sources with numbers, and numbered chips under the answer show each site. Click a chip to open the page in your browser.
- **Deep research** — click the magnifying-glass button in the chat box ("Deep research ON — will search more sources"). Answers are slower but use more sources.
- **Stopped early?** — a turn gets 10 steps (searches, page reads, replies), 25 with deep research. Raise it in Settings → Chat → Max steps per turn.

Search can fail or be rate limited. Which search engine is used, and proxies, are covered on the `search-and-network` page. The model can be wrong even with sources, so check anything that matters.

## Run several conversations at once

While one conversation answers, send in another, or send more in the same one to steer it. See the `chat-conversations` page.

## Let the assistant read and write files

Click the folder icon in the chat box to pick a working directory. The assistant can then read and write files there and nowhere else. Each chat keeps its own. A new chat starts in Settings → Chat → Default working directory, or with none.

- **Reads:** plain text, Markdown, CSV, JSON, YAML, TOML, PDF (text, or as page images for scans), Word `.docx`, Excel `.xlsx`, and images.
- **Writes:** text files and edits to them, PDF, Word `.docx`, Excel `.xlsx`, PowerPoint `.pptx` and OpenDocument `.odt`/`.ods`/`.odp`. The extension picks the format. See the `slides` page.
- **Downloads:** files from a web address into the folder (50 MB limit, programs blocked).
- **Cannot:** delete or move files, run scripts, or touch anything outside the folder.

If the file exists, the assistant asks: **Overwrite**, **Keep both** (saves under a new name) or **Cancel**. It rewrites a document or sheet it made in the same answer without asking.

Small models may forget to write the file, or claim they did: ask again.

## Run Python for charts, maths and documents

The assistant can write and run Python in a sandbox inside the app. It comes with numpy, pandas, matplotlib, scipy and others, installs more, shows its charts in the answer, and saves files to your working directory. It is on by default, and works best with a larger model. Click **code** on a run's step to see it. The assistant sees up to about 20 KB of each run's output; the middle of anything longer is cut.

Before code runs you see **Allow code execution?** By default it asks once per chat. Change this in Settings → Chat → Python Sandbox → Approval prompt (Off, Once per chat, or Every run). The same section sets **Network access** (default: Internet and local network) and the timeout, and **Enable Python sandbox** turns it off.

## Get pictures in answers

With Settings → Chat → Pictures in answers → **Include images in answers** on (the default), answers about visual things — a place, an animal, a building — can include one to three pictures from Openverse, Wikimedia Commons and Wikipedia, with credit and licence. Haruspex downloads them itself, so those sites never see your computer. Coverage is thin for new products and recent events. They aren't added to a picture the assistant drew unless you ask. Turning the setting off stops the assistant offering pictures; asking for one still works.

To have the assistant draw a picture instead, see the `images` page; for a song, the `music` page.

## Show it an image or a scanned PDF

Drop or paste an image into the chat box to ask about it. The camera button attaches a screenshot: choose **Screen**, **Window…** to pick one window (on macOS and Windows, type to filter the list, then click or press Enter), or **Region…** to drag out part of the screen (Haruspex hides while the screen is taken). For a scanned PDF, put it in the working directory and ask the assistant to read it. This needs a model that can see images.

## Talk to it and hear answers

- **Speak:** hold the microphone button, or hold `F2`, and release to send. The first time, a speech model is downloaded.
- **Listen:** click the speaker icon on an answer, or press `F3`, to have it read aloud.

Pick the voice, microphone and speaker in Settings → Audio. Speech is processed on your computer.

## Run the commands from an answer

If an answer tells you to run commands, click the `>_` button in the chat box. It opens the conversation in a new Shell tab, where the commands become buttons you can run. That shell thread is not saved to your chat history. See the `shell` page.

## Keep a chat out of memory

When memory is on, the eye button in the chat box makes the current chat incognito: it is not remembered, and nothing remembered is brought into it. A banner says so. See the `memory` page.

## Where your conversations are kept

Conversations are saved in a database on your computer and are there after a restart. Find them in the sidebar. Chats from other people's devices through Guest chat also appear there (see `guest-chat`).

## When a chat gets long

Once a chat fills most of the model's context, Haruspex summarises its older messages before your next one. Every message stays in the chat; **Earlier messages summarised** marks where the model's view starts and opens the summary. The model doesn't see the exact words above it any more.

## Use a skill

Type `/` to pick one of your skills, or `/name what you want`. See the `skills` page.
