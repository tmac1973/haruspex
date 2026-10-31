---
title: Troubleshooting
description: Known issues and fixes: small-model limits, cut-off answers, commands run without asking, memory-limit kills, finding logs, and reporting a bug.
---

# Troubleshooting

Common problems and what to try. If none of this helps, report a bug (see the last section).

## The model did only half of what I asked

Small local models (Qwen 3.5 4B and 9B) often do only the first part of a two-part request. Ask "research X and make a PDF report" and you may get a good answer in the chat but no file. It may even claim a file that does not exist.

**What to do:** ask again, as a separate message: "write that to a PDF". It almost always works, as the content is already in the conversation. For big tasks, ask one step at a time. Larger models rarely have this problem.

## Coding features make mistakes or get stuck

The Code tab, the Shell's Full access, guided planning, autonomous coding, audit jobs and the Python sandbox need a bigger model. On the 4B and 9B models they often produce code that does not run. They become usable from 16 GB of VRAM, or with a bigger model on another server or OpenRouter. See the `models` page.

If a long task stops and is told to "wrap up", raise Settings → Code → Max steps per task, or Settings → Shell → Max steps per turn (both 40).

## The answer was cut off

Each reply has a length limit, separate from the context size. When a reply hits it, Haruspex says so and never leaves a file half-written. Raise it in Settings → Inference → Model defaults:

- **Max response tokens** for normal chat and shell replies.
- **Max response tokens (file writes)** for turns that write a whole file.

Or ask for a smaller piece of work, or lower **Reasoning effort** there so less goes on thinking.

If instead it says the model's tool call "could not be run", the reply was not cut off and raising the limit will not help. Try again, or ask for the work in smaller steps.

## It ran a command without asking me

The Shell assistant is read-only by default and runs nothing. With **Full access**, it runs commands in your real terminal. Commands it flags as risky (sudo, destructive deletes, piping a download into a shell and similar) stop and ask you first. Commands it thinks are safe run without asking. The check helps but is no guarantee.

If even risky commands ran without a prompt, check Settings → Code → Auto-approve commands. It is off by default; turn it off again to get the prompts back. Also check Settings → Shell → Start new shells with Full access if a tab had Full access when you did not expect it. See the `shell` page.

## A command was stopped for using too much memory

On Linux, each Shell tab's terminal, and each command the assistant runs on its own, may use at most half your RAM by default. Over that, the system stops the process so it cannot freeze your desktop. The shell itself keeps going, and the assistant is told why.

If the command really needs more, raise Settings → Shell → Memory limit (a percentage of RAM; 0 turns it off). Tabs opened after the change use the new limit. This needs Linux with a systemd user session.

## Pictures in answers are missing or wrong

The picture sources are good for places, animals, landmarks and general subjects, and weak for new products and recent events. If no good picture exists, the answer comes without one. Small models may pick a loosely related one. Turn off Settings → Chat → Pictures in answers → Include images in answers to stop them being added unasked.

## Presentations with images are unreliable

Research plus a deck with images in one message often fails. Do it in two or three messages: research first, then the deck. A slide has a title, bullets and one image. Decks are landscape, or portrait for a phone.

## Image generation problems

Image generation is new and off by default. It has been tested most on Linux with an AMD GPU. While it runs it uses most of a 16 GB card, so other GPU work suffers. See the `images` page.

## Games or other programs are slow

Haruspex keeps the model in GPU memory while it runs. Close Haruspex before playing games, or use a smaller model or context size.

## The app will not open (Windows or macOS)

The app is not code-signed. On Windows, click **More info → Run anyway** at the SmartScreen warning. On macOS, right-click the app the first time and choose **Open**.

## Can't reach a server on my network (macOS)

Turn Haruspex on in System Settings → Privacy & Security → Local Network and reopen it. If it's on but fails after an update, toggle it.

## The model server will not start

The status badge at the top of the window names the model of the chat, Code session or job in view. For the Settings → Inference model it also shows the server's state: **Ready**, **Starting**, **Error** or **Stopped**. A session or job with its own remote model shows that model and its server instead. Click the badge to open the logs. Settings → Inference → Server has **Restart Server**, **Start Server** and **Stop Server**, and **Run Setup Wizard** to pick a model again.

If you set Settings → Inference → **Extra llama-server arguments**, clear them and restart: a mistyped argument stops the server starting.

## Find the logs

Click the terminal icon in the toolbar (tooltip "Sidecar Logs"), or click the status badge. The log viewer lists its logs on the left: Haruspex's own (App, Debug, Tools, and search Stats), then the servers (LLM, TTS, Whisper, Image, MCP), then Crashes. **Image** shows either the bundled engine's output or the calls made to your ComfyUI server. Each has **Copy all**.

## Report a bug

When something fails, press **Report issue** beside the error. It saves the diagnostics to Downloads and opens a GitHub issue with the error and its log; drag the file onto the issue. Otherwise use Settings → Feedback → **Open feedback issue…** and **Save Full Diagnostics…**. Secrets are removed; read it before you submit.
