# Phase 2 — Planning skills in guided planning

## Goal

A guided planning job can run with one planning skill. The interview asks
that skill's questions, the outline meets its requirements, and the
verifier checks them.

## Work

- **Config**: `GuidedPlanningConfig.planning_skill: string | null`
  (default null), with the usual config migration.
- **Editor**:
  - A "Planning skill" dropdown below the description: None, then skills
    tagged `metadata.haruspex-job: guided-planning`, then "Other skills".
  - Use `listSkills` with the job's working directory as the project root
    when the repo is trusted.
  - The skill's description goes in the option's `title` tooltip.
  - A skill that has since gone missing or been switched off shows as
    "(missing)" and blocks Start with a one-line reason.
- **Snapshot**: at run start, read the skill (`readSkill`) and store
  `{ name, body }` in `PlanningState.skill`. Later stages and a resumed
  session read from there, never from disk. A read failure fails the run
  before the interview starts, with the reason.
- **Prompts** (`pipeline.ts`):
  - **Stage 1**: the skill in `<skill_content name="…">`, and a step 2 that
    reads, roughly:

    > Settle every topic in the skill's Questions that the description
    > doesn't already answer, as well as the problem, goals, non-goals, user
    > flow, constraints and success criteria. Skip a topic the description
    > answers, and record it under Decisions as "from the description". Offer
    > the skill's usual options, recommended first.

    The generic checklist stays: the skill adds to it, it doesn't replace it.
  - **Outline (2a)**: the skill's `## Plan requirements` section, as
    requirements the phase list must meet, alongside the existing rules
    about test-suite ordering.
  - **Verifier**: a fifth kind of problem, a plan requirement the phases
    don't meet. It is blocking unless `## Decisions` records the user
    choosing otherwise.
  - Pull `## Plan requirements` out of the body by heading. A skill without
    that section gives the outline and verifier nothing extra.
- **Run view**: the stage 1 line names the skill used.

## Tests

- Config round-trips `planning_skill`, and old configs load with null.
- The editor lists tagged skills first, and a missing skill blocks Start.
- The snapshot is taken once. Editing the skill mid-run doesn't change
  later prompts, and a resumed run reuses it.
- The stage 1 prompt carries the skill; outline and verifier prompts carry
  only the requirements section.
- `classifyFindings` treats a missed requirement as blocking.
- With no skill chosen, every prompt is unchanged.

## Done when

A 2D game plan run with `plan-2d-game` asks about the window, camera and
HUD without being told to. The overview's Decisions records the answers.
The verifier flags a hand-edited phase file that drops the camera
requirement.
