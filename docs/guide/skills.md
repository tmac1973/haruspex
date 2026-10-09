---
title: Skills and repo instructions
description: Skills (SKILL.md folders) — where they live, running them with /name, letting the model use or write them, AGENTS.md, repo trust and /init.
---

# Skills and repo instructions

A skill is a folder holding a `SKILL.md`: a name, a description of when to use it, and instructions. Haruspex uses the open Agent Skills format (agentskills.io) that other AI tools use, so a skill written for another tool usually works unchanged.

## Where skills are read from

Haruspex reads skills from:

- its own skills folder (Settings → Skills → Open skills folder), inside the app's data folder, for example `~/.local/share/com.haruspex.app/skills/` on Linux;
- `~/.agents/skills/`, shared with other tools;
- folders you add under Settings → Skills → Other skill folders, with a one-click **Add ~/.claude/skills** button (Claude Code skills may expect Claude Code's own tools);
- in the Code tab and the Shell's Full access, a trusted repo's `.agents/skills/` and `.claude/skills/`.

When two skills share a name, a trusted repo's wins, then your Haruspex folder, then `~/.agents/skills/`, then added folders. The losing one is marked **Overridden**.

## Manage skills

Settings → Skills lists every skill with where it came from. You can switch each one on or off, **View** its instructions, open its **Folder**, or **Delete** one from your own folder. A broken skill is shown greyed out with the reason it can't be used. **Refresh** rereads the folders.

## Run a skill

Type `/` in the Chat or Shell input box. A list of commands and skills opens and narrows as you type; use the arrow keys, then Enter or Tab to pick, or Esc to close it. Then type `/name what you want`. The skill's instructions go with your message, so this works on every model, whatever the setting below says.

Two built-in commands are always there: `/new` starts over with an empty conversation, and `/skills` lists the skills you can run.

## Let the model choose a skill

Settings → Skills → When the model uses skills puts your skills' names and descriptions in front of the model, which loads one when a request matches.

| Option                         | What it does                                                               |
| ------------------------------ | -------------------------------------------------------------------------- |
| Automatic (remote models only) | On for remote and OpenRouter models, off for the local model. The default. |
| Always                         | On for every model.                                                        |
| Never                          | Only `/name` runs a skill.                                                 |

Small local models often load a skill and then don't follow it, which is why Automatic leaves them out.

## Have the model write or update a skill

Ask, for example, "save what we just did as a skill called deploy-check", or ask it to improve one. Every write opens a review window with the whole file in an editor. You can edit it and **Save skill** (or **Save changes**), or **Reject** it with a reason that goes back to the model. Nothing is written until you save. The model can only change skills in your own folder or a trusted repo. Skills it wrote are labelled **Written by the model** in Settings.

## Skills that ship with Haruspex

`init` and the planning skills are copied into your skills folder on first run, labelled **Shipped with Haruspex**. They are ordinary files: edit them, delete them, or replace them with your own of the same name. An update replaces only the ones you haven't edited. An edited one gets a **Restore** button to put it back as shipped. A deleted one stays deleted until you click **Restore deleted shipped skills**.

## Repo instructions (AGENTS.md)

In a git repo with an `AGENTS.md` at its root (or a `CLAUDE.md` when there is none), the Shell assistant reads it into every turn, in both Read-only and Full access. A file in a subfolder nearer your current folder is read too. Up to 8 KB is read per turn; the badge warns when the file was cut.

A repo's instructions and skills were written by whoever made the repo, so the first time Haruspex finds them it asks **Use this repo's instructions?**, with **Use them** or **Ignore them**. It asks again if a different repo appears in that folder, or the repo gains new skills.

Answers are kept in Settings → Skills → Repos, where you can switch each repo between Use and Ignore, or **Forget** it to be asked again. While a file is in use, the **AGENTS.md** badge in the Shell sidebar shows it; click it and choose **Stop using this repo's instructions**.

## Draft an AGENTS.md with /init

In the Code tab or with Full access, `/init` reads the repo's manifests, CI workflows, README and other agent files, and drafts a short `AGENTS.md`: the real build, test and lint commands, conventions and gotchas. It opens for review before anything is saved, and changes an existing file rather than rewriting it. In a Read-only Shell, `/init` only adds a note saying where it works.

## Planning skills

When you create a guided planning job you can pick a planning skill (2D game, 3D game, web app, CLI tool, API service). Its questions join the planning interview and its requirements are checked in the plan. See the `jobs` page.
