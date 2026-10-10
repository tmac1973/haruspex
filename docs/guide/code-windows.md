---
title: Code tab on Windows
description: The Code tab on Windows — a project in a Windows folder (PowerShell) or a WSL distro (bash); picking one, how commands, files, git and the editor behave, and what isn't supported.
---

# Code tab on Windows

On Windows a Code session works in one of two places, picked per session:

- **This PC**: a Windows folder such as `C:\Users\you\myproject`. Commands run in PowerShell.
- **A WSL2 distro**, such as Ubuntu: a Linux folder inside it. Everything the agent does happens inside the distro, as if you were working in its terminal.

## Start a session

Click **New session** and pick the **Location**: **This PC (Windows)** or a distro.

- For This PC, type the folder (`C:\Users\you\myproject`) or use **Browse…**. Only folders on a local drive work, not network shares.
- For a distro, type the Linux path (`~/myproject`). **Browse…** opens Explorer on the distro; picking a folder there (`\\wsl.localhost\Ubuntu\home\…`) fills in both.

A folder under `/mnt/c/…` is your Windows drive seen from Linux. It works, but every file access crosses to Windows and is slow; pick This PC for a Windows folder.

**Open in Code** in a Shell tab starts a session in that terminal's folder: a PowerShell tab's on This PC, a WSL tab's in its distro.

## A Windows folder (This PC)

- **Commands** run in PowerShell 7 if it's installed, otherwise Windows PowerShell 5.1, which has no `&&` or `||`.
- **The Microsoft Store's PowerShell 7** isn't used by default: Windows starts it outside Haruspex's control, so Stop and the time limit may leave what a command started running, and the memory limit doesn't apply. To use it anyway, turn on Settings → Code → PowerShell 7 from the Microsoft Store. `winget install Microsoft.PowerShell` installs a PowerShell 7 without those limits.
- **Stop**, a time limit or closing the session ends a command and everything it started. **Background processes** stop when Haruspex quits, crashes included.
- **Settings → Shell → Memory limit** caps each command; one that goes over is stopped and the agent is told.
- **Files** keep their line endings: rewriting a file with Windows (CRLF) line endings keeps them, and so does saving from an editor window.
- **Git** is Git for Windows, with your usual config and credentials.
- **Open in Shell** and the agent's terminal hand-offs, such as a command that needs an administrator, open a PowerShell tab in the folder.

## A folder in a WSL distro

You need WSL2 with a distro installed (`wsl --install` in PowerShell, then open the distro once), and your project's tools installed inside it.

- **Commands** run with bash inside the distro. **Stop**, a time limit or closing the session ends them there, children included.
- **Background processes** run inside the distro; quitting Haruspex stops them, and the next start stops any a crash left running.
- **Files** are read and written through the distro. A link (symlink) inside the project is followed; one pointing outside it is refused.
- **Git** is the distro's own git. A worktree fork is made beside the repository inside the distro.
- **Editor windows** check for changes every few seconds, so an edit made in a Linux editor shows up shortly after. If a folder can't be watched, the editor says **Live reload unavailable**.
- **Open in Shell** opens a Shell tab in the same distro and folder, whatever the Shell tab's own picker says.
- **Settings → Shell → Memory limit** applies only if lingering is on for your Linux user (`sudo loginctl enable-linger $USER` in the distro).
- **AGENTS.md and project skills** are read from the repository inside the distro. Settings → Skills lists it as `<path> (<distro>)`.

## What isn't supported

- `cmd` as the agent's shell.
- Network shares (`\\server\share`) as project folders.
- `localhost` inside a distro may not reach servers running on Windows, unless WSL's mirrored networking is on.
- Running Haruspex itself elevated, or inside WSL.
