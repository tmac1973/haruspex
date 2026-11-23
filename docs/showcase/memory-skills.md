---
title: Memory & skills
description: Have Haruspex remember your preferences across chats, keep a chat private, and save how you like things done as skills you run with /name.
---

## Ask it to remember something

Say what to remember and the assistant saves it at once. By default it shows **Remember this?** with the exact text first.

Tab: Chat
Required settings: None

Prompt:

> Remember that I use fish, not bash, and I'm on Fedora.

Example output:

**Remember this?** "Uses the fish shell, not bash, on Fedora" with **Remember it**, **Allow for this session** and **Don't save**. Later answers that use it show **Recalled 1 memory**.

Read more: memory

## Keep a chat out of memory

Click the eye button in the chat box to make the chat incognito. It isn't read for memories, and nothing remembered is brought into it.

Tab: Chat
Required settings: None

Prompt:

> What are the early signs of burnout, and when should I see a doctor?

Example output:

A banner in the chat says "Incognito — this chat won't be remembered", and the answer uses nothing from your stored memories.

Read more: memory, chat

## Review or delete what it remembers

Settings → Memory lists every stored fact with its kind and whether you asked for it. Edit or delete one, or merge duplicates.

Tab: Settings
Required settings: None

Prompt:

> fish

Example output:

Typed into the filter, it narrows **Remembered facts** to the matching ones, each marked **preference**, **fact**, **project** or **correction**, with **Edit**, **Copy** and **Delete**. **Find duplicates** suggests one sentence for each group of repeats; nothing changes until you press **Merge**.

Read more: memory

## Run a skill with /name

A skill is a folder of instructions. Type `/` in the chat box to pick one, or `/name` followed by what you want.

Tab: Chat or Shell
Required settings: None

Prompt:

> /guided-planning a small app to track which plants I've watered

Example output:

The assistant asks one multiple-choice question at a time about your idea, then asks where to save the plan and writes `overview.md` and numbered phase files to `plan/<name>/`, with your review after each stage. It writes no code.

Read more: skills

## Save what you just did as a skill

Ask the model to write a skill from the conversation. The whole file opens in a review editor, and nothing is saved until you click **Save skill**.

Tab: Chat
Required settings: None

Prompt:

> Save what we just did as a skill called weekly-report: read the CSVs in this folder, chart spending by category and save it as a PDF.

Example output:

A review editor opens with the new `SKILL.md`: its name, a description of when to use it, and the steps. Edit it, then **Save skill**, or **Reject** with a reason. It then shows in Settings → Skills as **Written by the model**, and runs with `/weekly-report`.

Read more: write-skills, skills

## Make your own version of a shipped skill

A skill can build on another, listing only what you do differently. When the shipped skill is updated, your version gets the update too.

Tab: Chat
Required settings: None

Prompt:

> Make a skill called my-episode that builds on cut-video: my clips are in raw/ in filename order, cut silences over 0.8 seconds, and use a frame from the intro for the thumbnail.

Example output:

The review editor shows a short `SKILL.md` holding those three changes and `haruspex-builds-on: cut-video`. After you save it, `/my-episode` runs cut-video's steps with yours on top.

Read more: write-skills

## Draft an AGENTS.md for a repo

`/init` reads the repo's manifests, CI, README and agent files and drafts a short `AGENTS.md` with the real build, test and lint commands. It opens for review before saving.

Tab: Code
Required settings: None

Prompt:

> /init

Example output:

A review editor opens with a draft `AGENTS.md`:

- **Build:** `npm run build`
- **Test:** `npm test`
- **Conventions:** tabs, single quotes, …

Code sessions and the Shell assistant then use it, once you choose **Use them** for that repo.

Read more: skills, code
