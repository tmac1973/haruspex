# Phase 2 — Skills in turns, and Settings → Skills

## Goal

The model can see and load skills in Chat, Shell and Shell Code mode when
autonomous use is on, and the user can manage skills in Settings.

## Work

- **Catalog in the prompt.** When autonomous use resolves to on and at least
  one skill is enabled, `buildSystemPrompt`, `buildShellSystemPrompt` and
  `buildShellCodeSystemPrompt` add a short SKILLS section: one line per skill
  (`- name: description`) and one sentence on calling `load_skill` when a
  skill matches the request. Passed in as an option, like `memorySection`, so
  jobs and remote guests can't pick it up by accident.
- **Tools** (new category `skills`):
  - `load_skill(name)`: returns the body wrapped in
    `<skill_content name="…">`, with the skill's folder and its file list.
    `name` is an enum of the skills in the catalog, so the model can't invent
    one. A skill already loaded in this conversation returns a short "already
    loaded" instead of a second copy.
  - `read_skill_file(name, path)`: returns one file via `skill_read_file`.
  - Offered in Chat, Shell and Code mode when autonomous use is on. Not in jobs
    or remote turns. Re-checked in `executeTool`, as `remember_this` is.
  - Both are read-only, so they join `PARALLEL_SAFE_TOOLS` if #353 has merged.
- **Project root and trust.** Code mode passes the root of the repo the
  shell's cwd is in (the nearest folder with a `.git` entry) to `skills_list`;
  outside a repo there is no project, so `~` is never treated as one. Chat and
  Shell pass none. The first time a repo has project skills, a modal asks once
  whether to use them; the answer goes in `skills.trustedRepos`. (Phase 3
  extends the question to the repo's `AGENTS.md`.)
- **Keeping skills in context.** The in-loop trimmer and the pre-send fit skip
  messages carrying `<skill_content`, so a long turn doesn't silently drop
  the instructions it is following.
- **Settings → Skills** (new section):
  - The list from `skills_list`: name, description, source, and badges for
    invalid, shadowed and written by the model. An invalid skill shows its
    error.
  - Per skill: on/off switch, View (read-only in the CodeMirror editor),
    Open folder, and Delete for user-folder skills only.
  - "Open skills folder", "Add folder…" for extra sources, and the
    autonomous-use setting (Automatic / Always / Only when I use /name).
  - The trusted repos, each with a switch.
  - One sentence of copy, per the UI rules; the format note goes in a tooltip.

## Tests

- Prompt builders include the section only when asked, and list only enabled,
  valid, unshadowed skills.
- Tool exposure across Chat, Shell, Code, jobs and remote turns, with
  autonomous use on and off.
- `auto` resolves to on for remote and OpenRouter, off for local.
- Trimming leaves `<skill_content>` messages in place; a second `load_skill`
  of the same skill doesn't duplicate it.
- An untrusted repo's skills are absent until the user says yes.
- Settings section: toggling, deleting a user skill, invalid-skill rendering.

## Done when

A skill in `<app data>/skills/` is loaded by a remote model in Chat without
being named, and is absent from the prompt on the local model with the
default setting.
