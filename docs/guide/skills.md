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
- folders you add under Settings → Skills → Other skill folders, or **Add ~/.claude/skills** (Claude Code skills may expect its own tools);
- in the Code tab and the Shell's Full access, a trusted repo's `.agents/skills/` and `.claude/skills/`.

When two skills share a name, a trusted repo's wins, then your Haruspex folder, then `~/.agents/skills/`, then added folders; the loser is marked **Overridden**.

## Manage skills

Settings → Skills lists every skill with where it came from. Switch each on or off, **View** its instructions, open its **Folder**, or **Delete** one from your own folder. A broken skill is greyed out with the reason. **Refresh** rereads the folders.

A skill can need an image or music backend or the video tools (`haruspex-needs: image`, `music` or `video` under `metadata:`). While that is off, it is greyed out and not offered. An image skill is told what the backend can do when it loads. With `haruspex-tools: edit_image`, a call to that tool first loads the skill.

## Run a skill

Type `/` in the Chat or Shell input box: a list of commands and skills narrows as you type; pick with the arrow keys and Enter or Tab, or Esc to close. Type `/name what you want`; a name typed in full, such as `/init`, runs on Enter. The skill's instructions go with your message, so this works on every model, whatever the setting below says.

`/new` starts an empty conversation and `/skills` lists the skills you can run. The Code tab adds `/compact`, which summarises a session's older turns now; text after it says what to keep (`/compact keep the API notes`). See the `code-sessions` page.

## Let the model choose a skill

Settings → Skills → When the model uses skills puts your skills' names and descriptions in front of the model, which loads one when a request matches.

| Option | What it does |
|---|---|
| Automatic (remote models only) | On for remote and OpenRouter models, off for the local model. The default. |
| Always | On for every model. |
| Never | Only `/name` runs a skill. |

Small local models often load a skill and then don't follow it, so Automatic leaves them out.

## Have the model write or update a skill

Ask, for example, "save what we just did as a skill called deploy-check", or ask it to improve one. Every write opens a review window with the whole file in an editor. You can edit it and **Save skill** (or **Save changes**), or **Reject** it with a reason that goes back to the model. Nothing is written until you save. The model can only change skills in your own folder or a trusted repo. Skills it wrote are labelled **Written by the model** in Settings.

## Skills that ship with Haruspex

`init`, `code-audit`, `guided-planning` and the planning skills are copied into your skills folder on first run, labelled **Shipped with Haruspex**. They are ordinary files: edit them, delete them, or replace them with your own of the same name. An update replaces only the ones you haven't edited. An edited one gets a **Restore** button to put it back as shipped. A deleted one stays deleted until you click **Restore deleted shipped skills**.

## Repo instructions (AGENTS.md)

In a git repo with an `AGENTS.md` at its root (or a `CLAUDE.md` when there is none), the Shell assistant reads it into every turn, in both Read-only and Full access. A file in a subfolder nearer your current folder is read too. Up to 8 KB is read per turn; the badge warns when the file was cut.

A repo's instructions and skills come from whoever made it, so the first time Haruspex finds them it asks **Use this repo's instructions?**, with **Use them** or **Ignore them**. It asks again if a different repo appears in that folder, or the repo gains new skills.

Settings → Skills → Repos keeps the answers: switch a repo between Use and Ignore, or **Forget** it to be asked again. While a file is in use, the **AGENTS.md** badge in the Shell sidebar shows it; click it and choose **Stop using this repo's instructions**.

## Draft an AGENTS.md with /init

In the Code tab or with Full access, `/init` reads the repo's manifests, CI, README and agent files and drafts a short `AGENTS.md`: the real build, test and lint commands, conventions and gotchas. It opens for review before saving, and changes an existing file rather than rewriting it. In a Read-only Shell, `/init` only adds a note saying where it works.

## Audit or plan a project

In the Code tab or with Full access, `/code-audit` (optionally followed by a folder) reviews consistency, duplication, logging, secrets, tests and dependencies, rechecks each finding, and reports by severity with a fix order. It changes nothing. For an audit run several times with each finding checked, use an Audit job; see the `jobs` page.

`/guided-planning` followed by your idea asks one multiple-choice question at a time, then writes `overview.md` and numbered phase files to `plan/<name>/` (in Chat it asks where), with your review after each stage. It writes no code. The folder works as an Autonomous coding job's Plan directory.

## Planning skills

A guided planning job can use a planning skill (2D game, 3D game, web app, CLI tool, API service): its questions join the interview, and the plan is checked against it. See the `jobs` page.
