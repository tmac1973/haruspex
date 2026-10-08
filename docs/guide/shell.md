---
title: Shell and Code mode
description: The Shell tab's terminal and assistant sidebar, sending output to it, Code mode, command approval, the memory limit and repo instructions.
---

# Shell and Code mode

The Shell tab is a real terminal with an assistant beside it. By default the assistant only reads and suggests. Turn on Code mode and it can edit files and run commands in that terminal.

## Open a terminal

It works on Linux, macOS and Windows. On Windows a picker in the tab lets you choose a PowerShell version or a WSL2 distro. Click **+** for another tab; each tab has its own terminal and its own assistant. A tab can be detached into its own window. Right-click the terminal for Copy, Paste and **Restart shell**.

Your `$SHELL` is used unless you set Settings → Shell → Shell binary. Command capture needs shell integration: bash and zsh get Haruspex's hooks, and fish 4 sends the needed markers itself. Other shells still work as terminals, but their commands are not captured, so copy the text you want into the assistant box instead. The badge in the sidebar header shows whether capture is working.

## Ask about what just happened

- **F4**, or the `>_` button by the input box, sends your recent commands and their output to the assistant with no question.
- Anything you type is sent with your last 3 completed commands (command, output, exit code, folder). Change the number in Settings → Shell → Recent shell commands attached to each chat message; `0` sends only your question.
- The camera button captures a window and sends it.

Long output is cut in the middle before it is sent (Settings → Shell → Max output bytes per captured command, 8 KiB by default). By default the last 10 lines of your shell history file are also sent; turn that off in Settings → Shell → Include your shell history file in prompts.

**Ctrl+Shift+A** shows or hides the sidebar, and **Ctrl+`** moves focus between terminal and assistant.

## Read-only mode (the default)

The assistant can read config files and logs and suggest fixes, but it never runs anything. Each suggested command is a card with two buttons: **Paste** types it at your prompt without pressing Enter, and **Run** types it, presses Enter and sends the output back. Commands that match risky patterns, such as `sudo`, `rm -rf`, `dd of=`, a pipe to a shell or `Remove-Item -Recurse -Force`, get a red chip and ask again before they are typed. The check is a short pattern list: a command without a chip is not proven safe.

## Let the assistant edit files and run commands

Click **Code** in the sidebar header to turn on Code mode for that tab. It is off by default; Settings → Shell → Enable Code mode by default in new shells changes that for new tabs.

In Code mode the assistant runs commands in your live terminal, so they share your folder, environment and venv and show in your scrollback. Commands that look safe run on their own. A risky one opens **Run this command?** with **Allow for this session**, **Allow once** or **Deny** (the model is told it was denied). A command that reaches outside the project always asks.

Settings → Code → Auto-approve commands ("Run risk-flagged commands without prompting") skips that prompt. It is off by default; only turn it on if you fully trust the model on this machine.

For servers and long builds the assistant can start a command in the background, and ask to be told when it finishes, so the terminal isn't blocked. Each command has a time limit (Settings → Code → run_command timeout, 30 seconds by default), and a task stops after a number of steps (Settings → Code → Max steps per task, 40 by default). Those settings, and auto-approve, are shared with the Code tab (see the `code` page).

When you return to a folder with an earlier coding session, the sidebar offers **Keep** or **Start fresh**.

Code mode needs a capable model. Small local models make mistakes and get stuck; see the `models` page. Read the AI safety disclaimer in the README before using it.

## Stop runaway commands (memory limit)

Settings → Shell → Memory limit caps each command the assistant runs on its own, and each tab's terminal as a whole (your own commands too), at a share of your RAM: 50% by default, `0` turns it off. Over the limit, the system kills only the process using the memory; the shell and its scrollback stay. The assistant is told why, so it looks for the bug instead of re-running it. This needs Linux with a systemd user session. Tabs opened after a change use the new limit.

## Repo instructions (AGENTS.md)

In a git repo with an `AGENTS.md` (or `CLAUDE.md`), the assistant reads it into every turn, in both modes. The first time, Haruspex asks whether to use the repo's instructions. While the file is in use, an **AGENTS.md** badge shows in the sidebar; click it to stop using them. In Code mode, `/init` drafts an `AGENTS.md` for you. See the `skills` page for details.
