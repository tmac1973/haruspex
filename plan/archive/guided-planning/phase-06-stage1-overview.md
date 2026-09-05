# Phase 06 — Stage 1: overview Q&A + write + review checkpoint

**Depends on:** Phase 05 · **Enables:** Phase 07 (planning consumes the approved
overview).

## Goal

Implement the first stage end-to-end: from the job's initial description, the
agent asks one-at-a-time multiple-choice questions (grounded in the codebase)
until it judges the overview complete or the user exits early, writes
`overview.md`, then **pauses at the review checkpoint** where the user approves,
asks for a revision, or signals they edited it themselves. On approval the run
records the `overview_written` milestone and hands off to Stage 2.

## Files touched

- **NEW** `src/lib/agent/jobs/guided-planning/stage-overview.ts` — stage driver
  + system prompt.
- **NEW** `src/lib/agent/jobs/guided-planning/templates.ts` — the overview
  markdown template (shared idea; phases template added in Phase 07).
- **EDIT** `runner.svelte.ts` — call the overview stage from
  `runGuidedPlanningPipeline`, then the checkpoint, then persist the milestone.

## Implementation

### Stage driver (hybrid orchestration)

The runner runs an agent loop for this stage with:

- **System prompt** instructing: ask exactly one `ask_user_question` at a time;
  resolve genuine decisions only; use read-only codebase tools to ground
  questions; when satisfied the overview is fully specified, call
  `fs_write_text` to write `overview.md` using the provided template (including
  the **Decisions appendix** built from the Q&A) and then stop.
- **Allowlist** (from Phase 05): read tools + `fs_write_text` +
  `ask_user_question`.
- **Early-exit control:** a persistent "I'm ready — proceed" affordance. Simplest
  implementation consistent with the primitive: the runner injects, after each
  answered question, a lightweight standing option — i.e. every
  `ask_user_question` modal also carries a sticky "Proceed — I've answered
  enough" control (add a `showProceed` flag to the modal, surfaced for
  guided_planning runs). Choosing it returns a sentinel answer the agent is
  told means "stop asking and write the overview now."

### Overview write + Decisions appendix

The agent composes `overview.md` from the fixed template (Problem · Goals ·
Non-goals · Users & flows · Constraints · Success criteria · **Decisions**). The
Decisions section lists each asked question and the chosen answer — the agent
has them in its own message history, so it writes them directly. Written via the
guarded `fs_write_text` into the output dir.

### Review checkpoint (reuses the question primitive)

After the file is written, the runner sets `pendingCheckpoint = 'overview_review'`
and asks (via `ask_user_question`):

- **Approve** → proceed.
- **Revise** (free-text instructions) → the agent makes the requested edits to
  `overview.md` and re-presents the checkpoint (loop).
- **I'll edit it myself — re-read** → the agent re-reads `overview.md` from disk
  (picking up the user's manual edits) and re-presents the checkpoint.

The loop continues until **Approve**. On approve, `saveMilestone(run, { stage:
'planning', milestone: 'overview_written', pendingCheckpoint: null })`.

### Resume behavior

If parked before `overview_written`: re-enter the overview stage from the start
of the question round (the partial overview, if any, is on disk and re-read).
If parked exactly at the review checkpoint: re-present the checkpoint (the file
exists). After `overview_written`: skip Stage 1 entirely, go to Stage 2.

## Build gate

`npm run check && npm run lint && npm run test`

## Test plan

1. Run with a real idea → agent asks codebase-grounded MC questions one at a
   time; answers shape later questions.
2. Early-exit: choose "Proceed — I've answered enough" → agent stops asking and
   writes `overview.md`.
3. `overview.md` follows the template and has a populated Decisions appendix.
4. Checkpoint **Revise**: give an instruction ("add a non-goal about X") → file
   updated, checkpoint re-shown.
5. Checkpoint **edit-myself**: edit the file on disk, choose re-read → agent
   reflects the manual edits.
6. Checkpoint **Approve** → milestone persisted; run proceeds (Stage 2 is a
   stub until Phase 07).
7. Kill the app at the checkpoint → reopen/resume → checkpoint re-presented, file
   intact.

## Commit

```
feat(jobs): guided_planning stage 1 — overview Q&A + checkpoint

One-at-a-time, codebase-grounded questioning with an early-exit control,
writes overview.md (fixed template + Decisions appendix), then a
review checkpoint (approve / revise / edit-myself loop). Persists the
overview_written milestone for resume.
```

## Roll-back rule

Revert the stage file + the runner call; the scaffolding (Phase 05) still runs
but does nothing past start. No data migration involved.
