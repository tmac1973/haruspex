# Planning skills for guided planning — Project Overview

## Problem

Guided planning asks the same questions whatever is being planned, and on
every model. That isn't the model's fault: stage 1's prompt hands it a fixed
checklist ("the problem, goals, non-goals, the primary user flow, key
constraints, and success criteria"), and a capable model works through
exactly that list. Nothing in it says "this is a game, so ask about the
camera".

So the questions that matter for a kind of project go unasked unless the
user thinks of them and writes them into the description. One 2D game plan
never asked about window size, the camera, or a HUD, and the finished game
had a fixed camera the player could walk off the edge of.

## Goals

- When starting a guided planning job, the user picks a **planning skill**
  for the kind of project: a 2D game, a web app, and so on.
- The interview covers that skill's questions, skipping any the description
  already answers, and the plan meets the skill's requirements whatever the
  answers were.
- The verifier checks the plan against those requirements.
- Haruspex ships a few planning skills as **ordinary skills on disk** in the
  user's skills folder. The user can edit, replace or delete them like any
  other skill, and an update doesn't undo that.
- The user can write their own planning skills, by hand or by asking Chat
  (`create_skill`).

## Non-goals

- **Picking the skill automatically.** The user chooses it in the editor.
  Suggesting one from the description is a later addition (see Follow-ups).
- **More than one skill per job.**
- **Skills in other job types.** Autonomous coding gets the plan, which
  already carries every answer in `## Decisions`; it doesn't need the skill.
- **Designing for the 9B.** The target is the larger models Haruspex ships
  for machines with the VRAM. The 9B should still work, but no 9B
  workaround is built until a hand test shows it's needed.

## Design decisions

**A planning skill is an ordinary skill with two sections.** It is found,
parsed, switched off and overridden like any other. Its body has:

- `## Questions`: topics the interview must settle, each with why it matters
  and the usual options, so the model can offer good choices with a
  recommended one first.
- `## Plan requirements`: what every plan of this kind must include
  whatever the answers. For example, "the first playable phase opens the
  window at the agreed size, and the player can't leave the playable area
  unless the user chose that". These are what the verifier checks.

Frontmatter marks it for the editor with `metadata.haruspex-job:
guided-planning`. The editor lists those skills first, then every other
usable skill under "Other skills", so a skill written without the tag still
works.

**The user picks it; the job keeps a copy.** The editor gets a "Planning
skill" dropdown, defaulting to none. The pick is stored in the job config by
name. When the run starts, the skill's text is copied into the run's
`PlanningState`, so a resumed or re-run session uses the same text even if
the skill is edited in between. Project skills count when the job's working
directory is a repo the user trusts, the same rule as Shell Code mode.

**Which stages see it:**

| Stage | Gets | Why |
|---|---|---|
| 1, overview interview | the whole skill | asks its questions, and records each answer under `## Decisions` |
| 2a, outline | `## Plan requirements` | shapes the phases around them |
| 2b, phase writes | nothing new | the outline already reflects the requirements |
| Verifier | `## Plan requirements` | a requirement the plan misses is a finding |

**Shipped skills live on disk, not in the binary.** They are bundled as app
resources under `resources/skills/<name>/SKILL.md` and copied into
`<app data>/skills/` at startup. A record of what was shipped,
`<app data>/shipped-skills.json` (outside the skills folder), stores each
skill's name and the hash of the text last copied in. Rules:

| On disk | Shipped text | Action |
|---|---|---|
| Never shipped, and no folder of that name | — | copy it in |
| Never shipped, but the user has a folder of that name | — | leave it; theirs wins |
| Shipped, folder now gone | — | the user deleted it; never re-add it |
| Shipped, file unchanged since | changed in this release | update it in place |
| Shipped, file edited by the user | — | leave it |

Settings → Skills labels these skills "Shipped with Haruspex". A **Restore**
action puts one back as shipped, after a confirm when that overwrites the
user's edits. "Restore shipped skills" brings back any that were deleted.

**`/init` moves to the same path** (decided with Tim). Today it is compiled
into the app (`include_str!`), so it can be overridden but not edited or
deleted. It becomes a shipped skill on disk like the planning skills.
Whether a skill is Code mode only is then set by a frontmatter field,
`metadata.haruspex-mode: code`, rather than by its being built in, and any
skill can use that field. A user's own `init` folder still wins, as it
already does.

## Phases

1. **Shipped skills** — bundling, seeding into the user's folder, the record,
   update and delete rules, Settings label and Restore; `/init` moves onto
   it, with Code mode gating from frontmatter.
2. **Planning skills in guided planning** — the editor dropdown, the snapshot,
   the stage 1, outline and verifier prompts.
3. **The shipped planning skills** — writing `plan-2d-game`, `plan-web-app`
   and the others with Tim, then hand-testing each on a real plan.

## Follow-ups

- **Suggesting a skill** from the description when the job is created,
  which the user confirms or changes.
- **A coverage check** after stage 1 that compares `## Decisions` against
  the skill's questions and sends the model back for any it skipped. Only if
  hand tests show models skipping them.
