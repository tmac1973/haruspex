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

Search can fail or be rate limited. Which search engine is used, and proxies, are covered on the `search-and-network` page. The model can be wrong even with sources, so check anything that matters.

## Let the assistant read and write files

Click the folder icon in the chat box to pick a working directory. The assistant can then read and write files there, and only there. With no folder set, it has no file access at all. The folder belongs to that one conversation and is forgotten when you close the app.

- **Reads:** plain text, Markdown, CSV, JSON, YAML, TOML, PDF (text, or as page images for scans), Word `.docx`, Excel `.xlsx`, and images.
- **Writes:** text files and edits to them, Word `.docx`, OpenDocument `.odt`/`.ods`/`.odp`, Excel `.xlsx`, PowerPoint `.pptx` and PDF. Presentations are experimental.
- **Downloads:** files from a web address into the folder (50 MB limit, programs blocked).
- **Cannot:** delete or move files, run scripts, or touch anything outside the folder.

If a file already exists, the assistant stops and asks: **Overwrite**, **Keep both** (saves under a new name) or **Cancel**.

Small models often do the research and then forget to write the file, sometimes claiming they did. Ask again — "write that to a PDF" — and it usually works.

## Run Python for charts, maths and documents

The assistant can write and run Python in a sandbox inside the app. It comes with numpy, pandas, matplotlib, scipy and others, can install more, and saves files to your working directory. It is on by default, and works best with a larger model.

Before code runs you see **Allow code execution?** By default it asks once per chat. Change this in Settings → Agent → Python Sandbox → Approval prompt (Off, Once per chat, or Every run). The same section sets **Network access** (default: Internet and local network) and the timeout, and **Enable Python sandbox** turns it off.

## Get pictures in answers

With Settings → General → Images → **Include images in answers** on (the default), answers about visual things — a place, an animal, a building — can include one to three pictures from Openverse, Wikimedia Commons and Wikipedia, with credit and licence. Haruspex downloads them itself, so those sites never see your computer. Coverage is thin for new products and recent events. Turning the setting off stops the assistant offering pictures; asking for one still works.

To have the assistant draw a picture instead, see the `images` page.

## Show it an image or a scanned PDF

Drop or paste an image into the chat box to ask about it. The camera button attaches a screenshot. For a scanned PDF, put it in the working directory and ask the assistant to read it. This needs a model that can see images.

## Talk to it and hear answers

- **Speak:** hold the microphone button, or hold `F2`, and release to send. The first time, a speech model is downloaded.
- **Listen:** click the speaker icon on an answer, or press `F3`, to have it read aloud.

Pick the voice and the microphone and speaker in Settings → Audio. Speech is processed on your computer.

## Run the commands from an answer

If an answer tells you to run commands, click the `>_` button in the chat box. It opens the conversation in a new Shell tab, where the commands become buttons you can run. That shell thread is not saved to your chat history. See the `shell` page.

## Keep a chat out of memory

When memory is on, the eye button in the chat box makes the current chat incognito: it is not remembered, and nothing remembered is brought into it. A banner says so. See the `memory` page.

## Where your conversations are kept

Conversations are saved in a database on your computer and are there after a restart. Find them in the sidebar. Chats from other devices through remote access also appear there (see `remote-access`).

## Use a skill

Type `/` to pick one of your skills, or `/name what you want`. See the `skills` page.
