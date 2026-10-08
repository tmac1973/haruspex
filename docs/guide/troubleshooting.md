---
title: Troubleshooting
description: Known issues and fixes: small-model limits, cut-off answers, commands run without asking, memory-limit kills, finding logs, and reporting a bug.
---

# Troubleshooting

Common problems, what causes them, and what to try. If none of this helps, report a bug (see the end of this page).

## The model did only half of what I asked

Small local models (Qwen 3.5 4B and 9B) often do only the first part of a two-part request. Ask "research X and make a PDF report" and you may get a good answer in the chat but no file. Sometimes the model even says it made a file that does not exist.

**What to do:** ask again, as a separate message: "write that to a PDF". The second request almost always works, because the content is already in the conversation. For big tasks, ask one step at a time. Larger models rarely have this problem.

## Coding features make mistakes or get stuck

Code mode, guided planning, autonomous coding, audit jobs and the Python sandbox need a bigger model. On the 4B and 9B models they often produce code that does not run. They become usable from 16 GB of VRAM, or with a bigger model on another server or OpenRouter. See the `models` page.

If a long coding task stops and is told to "wrap up", raise Settings → Shell → Max steps per task (default 40).

## The answer was cut off

Each reply has a length limit, separate from the context size. When a reply hits it, Haruspex says so, and a file is never left half-written. Raise the limit in Settings → Agent → Response Length:

- **Max response tokens** for normal chat and shell replies.
- **Max response tokens (file writes)** for turns that write a whole file.

You can also ask for a smaller piece of work, or lower Settings → Agent → Reasoning effort so less of the budget goes on thinking.

## It ran a command without asking me

The Shell assistant is read-only by default and runs nothing. With **Code mode** on, it runs commands in your real terminal. Commands it flags as risky (sudo, destructive deletes, piping a download into a shell and similar) stop and ask you first. Commands it thinks are safe run without asking. The check helps, but it is not a guarantee.

If even risky commands ran without a prompt, check Settings → Shell → Auto-approve commands. It is off by default; turn it off again to get the prompts back. Also check Settings → Shell → Enable Code mode by default in new shells if Code mode was on when you did not expect it. See the `shell` page.

## A command was stopped for using too much memory

On Linux, each Shell tab's terminal, and each command the assistant runs on its own, may use at most half your RAM by default. Over that, the system stops the process so it cannot freeze your desktop. The shell itself keeps going, and the assistant is told why.

If the command really needs more, raise Settings → Shell → Memory limit (a percentage of RAM; 0 turns it off). Tabs opened after the change use the new limit. This needs Linux with a systemd user session.

## Pictures in answers are missing or wrong

The picture sources are good for places, animals, landmarks and general subjects, and weak for new products and recent events. If no good picture exists, the answer comes without one. Small models sometimes pick a loosely related picture. Turning off Settings → Agent → Pictures in answers → Include images in answers stops them being added unasked.

## Presentations with images are unreliable

Asking for research and a slide deck with images in one message often fails. Do it in two or three messages: research first, then the presentation. Slides support a title, bullet points and one image.

## Image generation problems

Image generation is new and off by default. It has been tested most on Linux with an AMD GPU. While it runs it uses most of a 16 GB card, so other GPU work suffers. See the `images` page.

## Games or other programs are slow

Haruspex keeps the model in GPU memory while it runs. Close Haruspex before playing games, or use a smaller model or context size.

## The app will not open (Windows or macOS)

The app is not code-signed. On Windows, click **More info → Run anyway** at the SmartScreen warning. On macOS, right-click the app the first time and choose **Open**.

## The model server will not start

The status badge at the top of the window shows **Ready**, **Starting…**, **Error** or **Stopped**. Click it to open the logs. Settings → Inference → Server has **Restart Server**, **Start Server** and **Stop Server**, and **Run Setup Wizard** to pick a model again.

## Find the logs

Click the terminal icon in the toolbar (tooltip "Sidecar Logs"), or click the status badge. The log viewer has tabs for the app, the model server (LLM), speech (TTS, Whisper), MCP servers, crashes, and more. Each tab has a button to copy its log for a bug report.

## Report a bug

Go to Settings → Feedback and press **Open feedback issue…**. It opens a pre-filled GitHub issue in your browser with the app version, system info and settings (API keys removed). Read it before you submit. To add logs, press **Save Full Diagnostics…** and drag the saved file onto the issue.
