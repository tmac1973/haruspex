# Guided Planning — Project Overview

**Status:** Definition (awaiting review) · **Type:** New feature · **Output of:** Stage 1 (overview) of the guided-planning workflow, applied to itself.

---

## Problem

Starting a new project or feature, the user has a repeatable workflow they want
formalized inside Haruspex:

1. Describe the idea (free text).
2. The agent asks multiple-choice questions, one at a time, exhaustively, until
   a complete **project overview** is nailed down — then writes it to disk.
3. The agent produces a **detailed, phased implementation plan** (one or more
   markdown files), dependency-ordered so nothing in an early phase depends on a
   later one, and with **every decision resolved up front** (no deferrals).

Today this is impossible in-app: Haruspex jobs run autonomously and
auto-approve every tool, with **no mechanism for the agent to pause and ask the
user a question mid-run**. There is also no general human-in-the-loop question
primitive for chat or jobs.

## Goals

- A **`guided_planning` job type** that turns a raw idea into (a) a project
  overview document and (b) a set of dependency-ordered phase plan files —
  planning only, no code.
- A **reusable "ask the user a question" tool + modal** (single/multi-select,
  per-option descriptions, recommended highlight, always a free-text answer),
  exposed to **chat and all jobs** in v1.
- A reusable **interactive job mode**: a job that can block mid-run waiting on
  user input, built so future job types can reuse it (`guided_planning` is the
  first consumer).
- A **two-stage flow** (overview → plan) with review checkpoints, plus rigorous
  enforcement of dependency ordering and decision-completeness.
- **Milestone-level resumability** so a long session survives an app
  close/crash.

## Non-goals

- **No code generation or scaffolding.** The agent writes only markdown plan
  files into the chosen output folder; it never creates or edits code (not even
  empty stubs).
- **No auto-implementation** of the produced plan in v1.
- **No mid-question resume.** Resume granularity is the last completed milestone
  (overview written, or each phase file), not the exact question.
- **No scheduling-specific behavior** for guided planning (it's interactive by
  nature); the question tool must simply *degrade gracefully* if ever invoked
  where no user is present.

## Users & primary flow

Single user (the developer), in-app. End-to-end flow:

1. **Create** a `guided_planning` job via the **full job-editor form** (name,
   working dir, output folder defaulting to `plan/<feature-slug>/`, model
   override, and an **initial description** field). Run it.
2. **Stage 1 — Overview Q&A.** The agent asks multiple-choice questions **one at
   a time**, **grounding itself in the existing codebase** (read-only) as it
   goes. It continues until it judges the overview complete; a persistent **"I'm
   ready — proceed"** control lets the user end the round early.
3. The agent **writes `overview.md`** (fixed template; see below) into the
   output folder, ending with a **Decisions appendix** recording each question
   and chosen answer.
4. **Checkpoint — review the overview.** The run pauses. The user can **edit the
   overview directly** (on disk / in-app) *or* **ask the agent to revise it**,
   looping until the user **approves**. The agent re-reads the file before
   continuing so edits shape the plan.
5. **Stage 2 — Planning Q&A.** Same one-at-a-time, codebase-grounded questioning
   until all planning decisions are resolved.
6. **Verify pass.** A dedicated step checks that each phase depends only on
   earlier phases and that no decision is deferred, revising until clean.
7. **Checkpoint — approve the dependency map.** The agent shows a phase /
   dependency-order map; the user approves before final files are written.
8. The agent **writes the phase files** (`phase-01-*.md`, `phase-02-*.md`, …;
   fixed template) into the output folder.
9. **Done.** Files persist on disk. The user reviews/edits them or re-runs.

At any point the run can be cancelled (existing job-cancel). Closing the app
mid-run resumes from the **last completed milestone**.

## Constraints & architecture context

- **Built on the existing jobs system** (`src/lib/stores/jobs.svelte.ts`,
  `src/lib/agent/jobs/runner.svelte.ts`, jobs schema in
  `src-tauri/src/db/mod.rs`), the **tool registry**
  (`src/lib/agent/tools/registry.ts`), and the established **modal-await
  pattern** (`FileConflictModal` / `CommandApprovalModal`): a tool `await`s a
  Promise that a root-mounted modal resolves on user click, **without** pausing
  the agent loop. The question tool reuses exactly this pattern.
- **Write boundary:** the agent may **read any file** in the working dir (for
  grounding) but may **write only inside the chosen output plan folder**,
  enforced via tool allowlist / path restriction.
- **Question tool exposed everywhere** (chat + all jobs) must **degrade
  gracefully** when no interactive user is present (e.g. a scheduled/headless
  job run): rather than blocking forever, it errors or surfaces a
  "needs-input" state. (Detailed behavior is a planning-stage decision.)
- **Model:** uses the job's configured model / model override, like any job.
- **One question at a time** is a hard interaction requirement.

## Success criteria

- A user can go from a raw idea to a written overview and a set of phase files
  entirely in-app, driven by one-at-a-time multiple-choice questions with a
  free-text escape hatch.
- Produced phase plans are **dependency-ordered** (verified) and contain **no
  deferred decisions**.
- The question modal supports single-select, multi-select, per-option
  descriptions, a recommended highlight, and free-text answers.
- The overview is reviewable/editable at a checkpoint (self-edit or
  agent-revise) and the dependency map is approved before files are written.
- A session resumes from its last milestone after an app restart.
- Output lands in the chosen folder (default `plan/<feature-slug>/`), with a
  Decisions appendix in the overview.
- The question tool + interactive job mode are reusable infrastructure, not
  bespoke to guided planning.

## Document templates (fixed)

**`overview.md`** sections: Problem · Goals · Non-goals · Users & primary flow ·
Constraints & context · Success criteria · **Decisions** (Q&A appendix).

**`phase-NN-*.md`** sections (matching the repo's existing plan convention):
Goal · Files touched · Implementation steps · Build gate · Test plan · Commit
message · Roll-back rule. Plus a short **Depends on / Enables** header so the
dependency ordering is explicit and machine-checkable by the verify pass.

---

## Decisions

1. **Workflow home** → *Interactive job + reusable primitive.* `guided_planning`
   is a job type, and the "pause for user input" capability is built as
   first-class reusable infrastructure other job types can later use.
2. **Stage flow** → *Checkpoint + editable overview.* Overview written, then a
   review pause where the user edits directly **or** asks the agent to revise,
   looping until approved, before planning begins.
3. **Question modal capabilities** → *Full.* Single- and multi-select,
   per-option descriptions, a recommended highlight, and an always-present
   free-text answer.
4. **Output layout** → *Folder chosen at job creation*, defaulting to
   `plan/<feature-slug>/`.
5. **When to stop questioning** → *Agent decides completeness + a persistent
   "I'm ready — proceed" early-exit control.*
6. **Code grounding** → *Explore throughout.* Read-only codebase tools in both
   the overview and planning stages.
7. **Resumability** → *Resume from last milestone* (state persisted at stage
   boundaries; never lose written files).
8. **Kickoff** → *Full job-editor form* with an initial-description field.
9. **Write boundary** → *Plan folder only* for writes; reads allowed anywhere in
   the working dir; never touches code.
10. **Plan rigor** → *Verify pass + approved dependency map.* Self-check ordering
    and decision-completeness, revise until clean, then user approves a
    phase/dependency map before final files are written.
11. **Question-tool exposure (v1)** → *Everywhere* — chat and all jobs (with
    graceful degradation when no user is present).
12. **Decision log** → *Decisions section in `overview.md`.*
13. **Doc templates** → *Fixed templates for both* the overview and phase files.
