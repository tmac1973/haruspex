# Guided Planning — Implementation Plan

Phased, dependency-ordered implementation plan for the `guided_planning` job
type and its reusable human-in-the-loop question primitive. See
[`overview.md`](./overview.md) for the project definition and the full Decisions
appendix.

## Phase map (strictly dependency-ordered)

| # | File | Phase | Depends on |
|---|---|---|---|
| 1 | `phase-01-hitl-primitive.md` | Reusable question store + global modal | — |
| 2 | `phase-02-question-tool.md` | `ask_user_question` tool (chat + all jobs) | 1 |
| 3 | `phase-03-db-job-model.md` | DB schema + job model + run-state persistence | — |
| 4 | `phase-04-job-editor-form.md` | Job-editor form for guided_planning | 3 |
| 5 | `phase-05-runner-scaffolding.md` | Runner scaffolding + interactive run context | 1,2,3,4 |
| 6 | `phase-06-stage1-overview.md` | Stage 1: overview Q&A + write + checkpoint | 5 |
| 7 | `phase-07-stage2-planning.md` | Stage 2: planning Q&A + verifier loop + write phases | 6 |
| 8 | `phase-08-run-view.md` | Run-view additions | 3,5,6,7 |
| 9 | `phase-09-integration-hardening.md` | Integration hardening + e2e | all |

Phases 1–2 and 3–4 are two independent foundation tracks (no cross-dependency);
they can be built in parallel. Everything from Phase 5 on is sequential.

## Locked decisions (full list in `overview.md`)

Overview stage: interactive job + reusable primitive · checkpoint with
editable/agent-revisable overview · full question modal (single/multi-select,
descriptions, recommended, free-text) · output folder chosen at creation
(default `plan/<slug>/`) · agent-judged completeness + early-exit · explore
codebase throughout · resume from last milestone · full job-editor kickoff ·
plan-folder-only writes · verify pass + approved dep map · question tool exposed
everywhere · Decisions appendix · fixed doc templates.

Planning stage: **hybrid orchestration** (runner gates stages/checkpoints/verify,
agent drives Q&A) · **DB-backed run state** · **pause-to-needs-input** when no
user · **reuse JobRunView + targeted additions** · **fresh-context verifier,
loop until clean**.

## Mechanical choices resolved (no deferrals)

- **Question tool schema:** `ask_user_question(question: string, options:
  Array<{ label, description?, recommended? }>, allow_multiple?: boolean)`. A
  free-text answer is always available (injected by the modal, not the schema).
  Returns the chosen label(s) or the free-text string.
- **Primitive:** `src/lib/stores/userQuestion.svelte.ts` mirrors
  `fileConflict.svelte.ts` — `askUserQuestion(req): Promise<UserAnswer>`,
  `getPendingQuestion()`, `resolveUserQuestion(answer)`. Global modal mounted in
  the root layout, same as `FileConflictModal`.
- **Interactive vs non-interactive** is a property of the *run context* set by
  the runner, not the modal. Interactive → modal awaits; non-interactive →
  pause-to-needs-input (Phase 5). Chat is always interactive.
- **Checkpoints reuse the question primitive:** overview review =
  `ask_user_question` with options `Approve` / `Revise (free-text instructions)`
  / `I'll edit it myself — re-read`; dep-map approval = `Approve` / `Revise`.
- **Write boundary** enforced two ways: the runner pins the tool allowlist to
  read tools + `fs_write_text` + `ask_user_question`, and `fs_write_text` calls
  are validated to resolve inside the configured output folder. Plan-folder
  writes are auto-approved (no file-conflict modal noise); questions are always
  interactive.
- **Output slug** derived from the job name (sanitized kebab-case); default
  output dir `plan/<slug>/` relative to the job's working dir; user-overridable
  field on the job.
- **Model:** the job's configured model / model override, like any job.
- **Doc templates:** overview = Problem · Goals · Non-goals · Users & flows ·
  Constraints · Success criteria · Decisions. Phase files = Goal · Depends on /
  Enables · Files touched · Steps · Build gate · Test plan · Commit · Rollback.

## Global build gate (every phase)

```bash
npm run check && npm run lint && npm run test
cargo check --manifest-path src-tauri/Cargo.toml   # phases touching Rust (3, 5)
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
```
