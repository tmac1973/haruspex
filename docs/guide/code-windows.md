---
title: Code tab on Windows
description: Using the Code tab on Windows through WSL — what it needs, picking a project in a distro, how commands, files, git and the editor behave there, and what isn't supported.
---

# Code tab on Windows

On Windows the Code tab works on projects inside a WSL2 Linux distro, such as Ubuntu. Everything the agent does — commands, file edits, git, background processes — happens inside that distro, as if you were working in its terminal. Folders on the Windows side (`C:\…`) can't be a project yet.

## What you need

- WSL2 with at least one distro installed. In PowerShell: `wsl --install`, then open the distro once to create your Linux user.
- The tools your project uses, installed inside the distro (`git`, `python3`, `node`, a compiler). Windows programs aren't used.

The Code tab appears once Haruspex finds a WSL2 distro. If you install one while Haruspex is running, restart it.

## Start a session in a distro

Click **New session**, pick the distro, and type the project's Linux path, such as `~/myproject` or `/home/you/myproject`. **Browse…** opens Explorer on the distro; picking a folder there (`\\wsl.localhost\Ubuntu\home\…`) fills in both. Either way the session stores the Linux path, so one folder is always one project.

A folder under `/mnt/c/…` is your Windows drive seen from Linux. It works, but every file access crosses to Windows and is slow; keep projects in your Linux home.

**Open in Code** in a Shell tab running a WSL distro starts a session in that terminal's folder and distro.

## How things work there

- **Commands** run with bash inside the distro, in the project folder. **Stop**, a time limit or closing the session ends them there, children included.
- **Background processes** run inside the distro too; quitting Haruspex stops them. If Haruspex crashes, the next start stops what was left running.
- **Files** are read and written through the distro. A link (symlink) inside the project is followed; one pointing outside it is refused.
- **Git** is the distro's own git, with your Linux config and credentials. A worktree fork is made beside the repository inside the distro, so `git worktree list` there shows it.
- **Editor windows** open the files through the distro and check for changes every few seconds, so an edit made in a Linux editor shows up shortly after. If a folder can't be watched, the editor says **Live reload unavailable**; saving still checks for changes.
- **Open in Shell** and the agent's terminal hand-offs open a Shell tab in the same distro and folder, whatever the Shell tab's own picker says.
- **Settings → Shell → Memory limit** caps the agent's commands only if lingering is on for your Linux user (`sudo loginctl enable-linger $USER` in the distro). Without it they run with no limit: the user's systemd stops between `wsl` calls, and a limit would kill commands with it.
- **AGENTS.md and project skills** are read from the repository inside the distro, symlinks included. Settings → Skills lists such a repository as `<path> (<distro>)`.

## What isn't supported

- Projects in Windows folders, and PowerShell as the agent's shell.
- `localhost` inside the distro may not reach servers running on Windows (such as the one Haruspex starts), unless WSL's mirrored networking is on.
- Running Haruspex itself inside WSL.
