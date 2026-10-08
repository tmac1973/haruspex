---
title: Getting started
description: What Haruspex is, the first-run setup wizard, the Chat, Jobs and Shell tabs, and which guide page to read next.
---

# Getting started

Haruspex is a desktop AI app for research and coding that runs on your own computer. It works on Linux, Windows and macOS. There is no account to create and no telemetry.

## What Haruspex does

- **Runs the model locally by default.** Haruspex downloads a model that fits your graphics card and runs it itself. You do not need a separate server such as Ollama or LM Studio.
- **Keeps your data on your device.** Conversations and the model's answers are stored locally. Web searches do go out to the internet, and the optional cloud backend (OpenRouter) is off by default.
- **Researches the web** for current information, and can read and write files in a folder you choose.
- **Helps in a terminal**, and with Code mode turned on, can edit files and run commands for you.

You can also point it at a model server you already run, or at OpenRouter. See the `models` page.

## First run: the setup wizard

The first time you open Haruspex, a wizard asks how you want to run the model:

1. **Download a model** (recommended). Haruspex checks your hardware (GPU, VRAM and RAM), shows the model it recommends, and lets you pick another from the list. You can also choose **Use existing GGUF file** to use a model you already have.
2. **Connect to an existing server** (advanced). Enter the address of an OpenAI-compatible server. Nothing is downloaded.

After a download, the wizard sends a short test question to the model. If the test fails, you can **Retry** or **Skip**; the model may still work. Then press **Start chatting**.

Model files are several gigabytes. On a slow connection, **Choose a different model** lets you switch to a smaller one while the download runs.

To run the wizard again later, use Settings → Inference → **Run Setup Wizard**. Your existing models and settings are kept unless you change them there.

## The main tabs

| Tab | What it is for |
|---|---|
| **Chat** | Ask questions. The assistant can search the web, read and write files in a working folder, run Python, look at images, and use your email, calendar or other connected services if you turn them on. |
| **Jobs** | Save a task and run it later, by hand or on a schedule: research, audit, guided planning, autonomous coding and asset generation. A badge shows when jobs are running or queued. |
| **Shell** | A real terminal with an assistant beside it. Read-only by default: it suggests commands for you to run. You can open several shell tabs. |

Along the top of the window you also find the server status (click it to open the logs), a light/dark toggle, the log viewer, the help list of keyboard shortcuts (**?** or F1), and Settings.

## Check what the model tells you

AI models make mistakes. They can state wrong facts with confidence, misread files, and suggest commands that are wrong or harmful. The small models Haruspex uses on modest hardware make these mistakes more often than large cloud models.

The Shell assistant runs nothing by default. If you turn on **Code mode**, it runs commands in your real terminal: commands it flags as risky ask you first, but commands it thinks are safe run on their own. Only use Code mode on machines and projects you are willing to let the model change. Read every command before you run it, and keep backups.

## Where to go next

- `models` — choosing and downloading models, context size, using your own server or OpenRouter.
- `chat` — web research, files, Python, voice, images and pictures in answers.
- `shell` — the terminal assistant and Code mode.
- `skills` — reusable instructions you run with `/name`, and repo `AGENTS.md` files.
- `jobs` — saved and scheduled tasks, and per-job models.
- `memory` — what Haruspex remembers between chats, and how to edit or turn it off.
- `images` — generating pictures and game art (off by default).
- `integrations` — email, calendar and contacts, MCP servers, screen capture.
- `search-and-network` — search providers and proxies.
- `remote-access` — chat with Haruspex from a phone or laptop on your home network.
- `settings` — a tour of every settings section.
- `shortcuts` — keyboard shortcuts.
- `troubleshooting` — known issues and what to do when something goes wrong.
