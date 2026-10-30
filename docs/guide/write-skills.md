---
title: Write your own skills
description: Have the model write or change a skill, make your own version of a shipped skill that lists only your changes, and the metadata keys Haruspex reads.
---

# Write your own skills

A skill is a folder holding a `SKILL.md`. You can write one by hand in your skills folder (Settings → Skills → Open skills folder), or ask the model to write it. For where skills live and how to run them, see the `skills` page.

## Have the model write or update a skill

Ask, for example, "save what we just did as a skill called deploy-check", or ask it to improve one. Every write opens the whole file in a review editor. Edit it and **Save skill** (or **Save changes**), or **Reject** it with a reason that goes back to the model. Nothing is written until you save.

The model can only change skills in your own folder or a trusted repo. To change a shipped skill or one from another folder, it saves your own copy under the same name, which takes its place. Skills it wrote are labelled **Written by the model** in Settings → Skills.

When a skill uses the picture, music or video tools, the model can record that it needs them, so the skill is hidden while they are off. Check for `haruspex-needs` in the review editor, and add it yourself if it's missing.

## Make your own version of a skill

A skill can build on another one. Its own instructions then list only what you do differently, and the other skill's steps load ahead of them each time it runs. When the shipped skill is updated, your version gets the update too.

For example, to cut your episodes your way, ask: "make a skill called my-episode that builds on cut-video: my clips are in raw/ in filename order, cut silences over 0.8 seconds, and always use a frame from the intro for the thumbnail." The saved skill holds those three changes and `haruspex-builds-on: cut-video`. Run it with `/my-episode`.

This works on every model and whatever Settings → Skills → When the model uses skills says, because the base skill is loaded with yours rather than by the model.

What it doesn't do:

- Build in more than one level. The model can't save a skill that builds on one that builds on another, and in a file you write by hand only the first level loads.
- Load the base skill's own files. Only its instructions come along.
- Keep working if the base skill is deleted. Your skill then runs on its own steps, and the model tells you the base is missing. Switching the base off in Settings → Skills only stops it being offered by itself; your skill still loads it.

If you'd rather have a skill that stands alone, ask for a full copy instead. It won't pick up updates, but nothing else can break it.

## Metadata Haruspex reads

These go under `metadata:` in the frontmatter. Other tools ignore them.

| Key | What it does |
|---|---|
| `haruspex-needs` | `image`, `music` or `video`, separated by spaces. While one is off, the skill is greyed out and not offered. |
| `haruspex-builds-on` | Another skill's name. Its instructions load ahead of this one's. |
| `haruspex-tools` | Tool names. The first call to one of them loads this skill first. |
