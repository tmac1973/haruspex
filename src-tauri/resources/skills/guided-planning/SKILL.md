---
name: guided-planning
description: Turn an idea into a written project overview and a dependency-ordered, phased implementation plan by interviewing the user one question at a time, writing markdown files to a plan/ folder (planning only, no code). Use when the user wants to scope, plan, spec or design a project or feature, asks for an implementation plan, roadmap or design doc, or says "help me plan X", "let's spec this out" or "guided planning".
---

# Guided planning

Take the user from an idea to two kinds of file, written to disk as markdown:

1. `overview.md`: what the project is, and every decision made about it.
2. `phase-NN-<slug>.md`: a phased implementation plan, ordered so each phase
   needs only earlier ones.

The files follow the same layout as a guided planning job (Jobs tab), so the
folder can be handed to an Autonomous coding job as its Plan directory.

**Planning only. Never write or edit code while using this skill.**

Work in two stages, with the user's review between them:

```
Stage 1: interview → write overview.md → user reviews it
Stage 2: interview → write each phase file → check the plan → user approves
```

If the user only wants the overview, stop after stage 1. If they already have
an overview, read it and start at stage 2.

## Rules

- **One question per `ask_user_question` call.** Never ask in plain text and
  never put two questions in one call. Give 2–4 concrete options with a
  one-line description each, and mark the one you suggest with
  `recommended: true`. The user can always type their own answer. Use
  `allow_multiple` only for "which of these" questions.
- **Ask until nothing is vague, then stop.** Tell the user at the start that
  they can answer "proceed" to any question to end the interview, and stop
  asking at once when they do.
- **No deferred decisions.** Never write "TBD", "decide later", or an
  unresolved either/or. Anything unresolved is a question to ask.
- **Read the code first.** In an existing project, look before asking:
  `code_glob` and `code_grep` to find things, `fs_read_text` to read them. Use
  real paths, real dependencies and the patterns already there. A new, empty
  project has nothing to read.
- **Phases depend only on earlier phases.** Someone must be able to build the
  plan top to bottom without ever needing something a later phase adds. This
  matters more than anything else in the plan.
- **Record every decision** in the overview's `## Decisions`: each question
  and the answer chosen.

## Where the files go

Write into `plan/<feature-slug>/` under the project folder, where
`<feature-slug>` is the feature's name in lowercase kebab-case. If there is no
project folder (for example in Chat), ask where to put the plan before writing
anything. Write only inside that folder.

## Planning skills

Haruspex ships planning skills for common kinds of project: `plan-2d-game`,
`plan-3d-game`, `plan-web-app`, `plan-cli-tool` and `plan-api-service`, plus
any the user wrote. If one fits the project and `load_skill` is available,
load it before the interview. Settle every topic under its `## Questions`
that the description doesn't already answer, and hold the phases to its
`## Plan requirements` unless the user chose otherwise.

## Stage 1: the overview

1. Say in one or two sentences that you'll ask one multiple-choice question at
   a time, and that "proceed" ends the interview.
2. Read the project, if there is one.
3. Ask, one question at a time, until you've settled the problem, goals,
   non-goals, the main user flow, constraints and success criteria. Let each
   answer shape the next question.
4. Settle how the work will be checked: propose one real shell command that
   runs the project's tests, or else builds or type-checks it, and confirm it
   with one question. It must be read-only, quick, and pass after every phase,
   starting with the first. Name a file in it only if that file exists now;
   prefer whole-project forms like `npm test`, `cargo check`,
   `python3 -m pytest -q` or `go build ./...`. If it runs a test suite the plan
   creates, the first phase must create that suite.
5. Write `overview.md` with `fs_write_text`, using the overview layout below.
6. Tell the user it's written and ask them to review it: approve, ask for
   changes, or edit the file themselves and tell you to re-read it. Repeat
   until they approve. Don't start stage 2 before that.

## Stage 2: the phases

1. Read the approved `overview.md` again, and the code it touches.
2. Ask, one question at a time, about every implementation choice the overview
   doesn't settle: architecture, libraries, data model, order of work.
3. List the phases in dependency order, with what each depends on, and show
   the list to the user.
4. Write each phase to its own file, one `fs_write_text` call per file, using
   the phase layout below. After the last one, list the folder with
   `fs_list_dir` and write any phase that's missing.
5. Check the plan in a separate pass. Read every file back from disk with
   `fs_read_text`, as if someone else wrote it, and look for:
   - a phase that depends on a later phase, or whose steps need something a
     later phase adds;
   - a decision left open: "TBD", "decide later", "X or Y";
   - a planning skill's requirement the plan doesn't meet;
   - a build gate or test command that isn't a real command (no inline
     `-c "…"` programs, no heredocs).
     Fix what you find and check again until the pass is clean.
6. Show the user the phase list with each phase's dependencies, and ask them
   to approve or ask for changes. Apply changes, check again, and show it
   again. Stop when they approve, and say the folder can be used as the Plan
   directory of an Autonomous coding job (Jobs tab).

## Overview layout

````markdown
# <Project> — Project Overview

## Problem

What's wrong or missing today, and who it affects. One or two short paragraphs.

## Goals

Concrete outcomes this work must achieve, as bullets.

## Non-goals

What this work will not do, as bullets.

## Users & primary flow

Who uses it, and the main flow step by step.

## Constraints

Existing stack, platforms, performance, data, compatibility, deadlines.

## Success criteria

Observable, checkable statements of done.

## Verification command

```
<the one command settled in stage 1, alone in this block>
```

## Decisions

- **<Question topic>** → <answer chosen>.
````

The `## Verification command` block holds only the command: an Autonomous
coding job reads it from there and runs it after every phase.

## Phase layout

```markdown
# Phase NN — <Title>

**Depends on:** <earlier phase numbers, or "nothing"> · **Enables:** <what it unblocks>

## Goal

One paragraph: what this phase delivers and why. Each phase is a shippable,
checkable step.

## Files touched

Each file to create or change, with a one-line note. Real paths.

## Steps

Numbered, concrete steps with every decision made. State signatures and rules
rather than writing the code out.

## Build gate

The commands that must pass before the phase is done.

## Test plan

The scenarios that show the phase works, automated or by hand.

## Commit

A conventional-commits message for the phase. Leave this section out if the
project doesn't use git.

## Rollback

How to back the phase out, and whether it's safe half-applied.
```

Number phases with two digits (`phase-01-…`, `phase-02-…`) so they sort in
order, and keep the heading as `# Phase NN — Title`.
