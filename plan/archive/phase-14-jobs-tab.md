# Phase 14: Jobs Tab (Saved Prompts, Multi-Step Pipelines, In-App Scheduling)

## Goal

Add a **Jobs** tab to the main app — alongside Chat — where users can author, save, edit, run, and schedule prompts. Each job is an ordered list of one or more prompt steps that execute unattended in sequence. Multi-step jobs work around the 9B model's limited multi-step reasoning by decomposing complex tasks into single-objective prompts that hand off intermediate results explicitly. Jobs run foreground in a dedicated run view inside the Jobs tab; the Chat tab is unaffected.

## Prerequisites

- Existing agent loop (`src/lib/agent/loop.ts`) — the runner reuses it for each step.
- Existing sandbox approval flow (`src/lib/stores/sandboxApproval.svelte.ts`) — the runner needs a per-run "auto-approve" override path.
- Existing SQLite persistence layer (`src/lib/stores/db.ts`) — three new tables land via migration.
- Familiarity with `maintenance.md` sections on tool system, Tauri command registration, persistence, build gates, ESLint complexity gates.
- **No** dependency on phase-13 (Workspace tab). This plan introduces the top-level tab bar; phase-13 slots Workspace in as a third tab when it lands.

## Deliverables

- **User-testable**: Top-level tabs `[ Chat | Jobs ]` at the top of the main app. Switching between them preserves each side's state. Chat works exactly as today.
- **User-testable**: In Jobs tab, click "New Job" → editor opens. Set name "Morning headlines", set working dir to `~/news/`, set auto-approve to on, add one step: "Search for today's top 5 financial headlines and write them to `headlines.md`." Save. Job appears in the left-pane list.
- **User-testable**: Click "Run" on the saved job. UI switches to the run view: shows the step's prompt at the top, the model's streaming response below (rendered like a chat message), tool calls shown inline. On completion, the run is marked succeeded; `headlines.md` exists in the workdir.
- **User-testable**: Edit the job, add a second step: "Take the content of `headlines.md` and produce `headlines.pdf` from it." Run. Step 1 runs to completion; step 2 starts in a **fresh conversation** with step 1's final assistant text prepended to its prompt. PDF is produced.
- **User-testable**: Configure the job's schedule as "every 30 minutes" or "daily at 09:00". The job's row shows a "next run at HH:MM" chip. When the time arrives (with the app open), the run starts automatically and appears in the run view; if another job is currently running, this one is queued (visible in a queue indicator).
- **User-testable**: A run that fails mid-pipeline (e.g. step 2's tool errors out) stops, is marked failed with the error captured, and the rest of the pipeline does **not** run.
- **User-testable**: Past runs (succeeded, failed, cancelled) are browsable in a "Runs" panel per job; clicking a past run shows each step's prompt and final output.
- **User-testable**: A running job has a "Cancel" button that aborts the current step's stream and marks the run cancelled. Closing the app while a job is running marks the run "interrupted" on next launch.

---

## Design Decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Step context | **Fresh conversation per step.** Each step boots a clean chat session; no conversation history between steps. | Plays to the 9B model's strength (single-objective prompts) and avoids context bloat in long pipelines. Loses cross-step tool-call history — accepted trade-off. |
| Step handoff | **Prepend prior step's final assistant text to the next step's prompt.** Rendered prompt: `{{prev_output}}\n\n{{step_prompt}}`. Step 1 has no prepend. | Simplest mental model: "the model sees the previous result as part of the new prompt." No template engine, no variable syntax in v1. |
| Execution UI | **Foreground in a dedicated run view inside the Jobs tab.** No background execution; the user watches the run when they want to, but Chat tab remains usable. | Matches existing chat-style streaming UX. Avoids re-entrant agent-loop work. Single visible run at a time. |
| Concurrency | **One job at a time; FIFO queue for overlapping schedule fires.** A badge on the Jobs tab shows queue depth. | Predictable; serializes llama-server load; no parallel-runs UI to build. Skipped runs (the alternative) silently lose work. |
| Scheduling | **In-app scheduler; app must be open.** Missed schedules (app closed) are dropped, not retro-run. | Smallest scope. No OS integration, no headless mode. Acceptable for v1 — most users keep the app open during work hours. |
| Schedule types | **Presets** (`hourly`, `daily at HH:MM`, `weekly on day at HH:MM`) **plus interval** (`every N minutes/hours`). No cron expression. | Covers ~all real cases without a cron parser/validator. |
| Tool approval | **Per-job `auto_approve_tools` boolean.** When true, the run suppresses all sandbox/network/etc. approval prompts and logs each tool call into the run record. When false, the run pauses on a prompt and waits — defeats unattended runs but kept as a safety default for new jobs. | Single coarse-grained switch. Avoids per-tool allowlist UI in v1. The user is approving the **job**, not each invocation. |
| Failure handling | **Stop on first error; mark run failed.** No per-step continue-on-error, no retry in v1. | Partial completion is usually worse than a clean failure the user can re-run after fixing. Easy to add later. |
| Working dir | **Single per-job workdir, shared across all steps in a run.** No per-step override, no per-run subfolder. | Matches the headline use case directly (step 1 writes file, step 2 reads it). Per-run subfolders are a clear v2 extension. |
| Model / inference settings | **Always inherit the app's current settings at run time.** No per-job pinning in v1. | Smallest scope. Users who want reproducibility can pin model globally before a scheduled run. Adding per-job model pinning later is a non-breaking schema add. |
| Run history | **Separate `runs` panel inside the Jobs tab; not in the chat sidebar.** Backed by dedicated `job_runs` / `job_run_steps` tables, **not** the conversation tables. | Keeps the chat sidebar clean. Allows per-job run lists, status filters, and a different schema (no need to model jobs as conversations). Step output rendering can still reuse `ChatMessage.svelte` for visual consistency. |
| Tab nav | **Introduce top-level `[Chat | Jobs]` tab bar in this phase.** Existing chat UI moves into a `<ChatView>` component; main page becomes the tab shell. | Don't gate on phase-13. When Workspace lands, it joins as a third tab — its phase plan can drop the tab-shell work. |
| Cancel | **Cancel button on the active run** aborts the current step's llama stream and marks the run `cancelled`. App-close mid-run is detected on next launch and the orphaned run is marked `interrupted`. | Explicit user escape hatch. Crash recovery avoids "stuck in running" forever. |
| Prompt-size guard | **Soft warning when rendered step prompt exceeds context budget.** No auto-truncation; user is told their pipeline likely won't fit and shown which step is the offender. | Multi-step pipelines can balloon if step 1 emits a 50 KB response. Cheap to compute; expensive to silently auto-truncate. |

---

## Architecture Overview

```
┌────────────────────────────────────────────────────────────────────┐
│ Main page (+page.svelte)                                           │
│  • Tab shell:  [ Chat | Jobs ]   ← introduced in this phase        │
│  • Renders <ChatView/> or <JobsTab/> based on activeTab store      │
└────────────────────────────────────────────────────────────────────┘
       │
       ▼
┌────────────────────────────────────────────────────────────────────┐
│ JobsTab.svelte                                                     │
│  ┌──────────────┬───────────────────────────────┬───────────────┐  │
│  │ JobList      │ JobEditor / JobRunView /      │ JobRunHistory │  │
│  │ (left pane)  │ JobRunDetail (center)         │ (right pane)  │  │
│  └──────────────┴───────────────────────────────┴───────────────┘  │
│  Queue indicator (top-right): "1 running · 2 queued"               │
└────────────────────────────────────────────────────────────────────┘
       │
       ▼
┌────────────────────────────────────────────────────────────────────┐
│ jobs/runner.ts  (TS, frontend; reuses agent loop)                  │
│  • runQueue: reactive FIFO of pending run records                  │
│  • currentRun: the active run + its step states (streaming)        │
│  • For each step: render prompt → start ephemeral chat session →   │
│    call runAgentLoop with auto-approve flag → capture final text → │
│    persist step output → advance / halt on error                   │
└────────────────────────────────────────────────────────────────────┘
       │
       ▼
┌────────────────────────────────────────────────────────────────────┐
│ jobs/scheduler.ts                                                  │
│  • setInterval ticker (30 s) checks jobs.next_due_at <= now()      │
│  • Enqueues a run into runner's queue; recomputes next_due_at      │
└────────────────────────────────────────────────────────────────────┘
       │
       ▼
┌────────────────────────────────────────────────────────────────────┐
│ SQLite (existing app DB, via stores/db.ts migration)               │
│  • jobs, job_steps, job_runs, job_run_steps                        │
└────────────────────────────────────────────────────────────────────┘
```

---

## Data Model

New tables added via a migration in `src/lib/stores/db.ts`. Existing `conversations` / `messages` tables are untouched.

### `jobs`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | INTEGER PK | |
| `name` | TEXT NOT NULL | user-visible label |
| `description` | TEXT | optional |
| `working_dir` | TEXT NOT NULL | absolute path; required |
| `auto_approve_tools` | INTEGER NOT NULL DEFAULT 0 | boolean |
| `schedule_kind` | TEXT NOT NULL DEFAULT 'manual' | `manual` / `hourly` / `daily` / `weekly` / `interval` |
| `schedule_config` | TEXT | JSON: `{ time: 'HH:MM' }`, `{ day: 'mon', time: 'HH:MM' }`, `{ minutes: N }`, or null for `manual`/`hourly` |
| `next_due_at` | INTEGER | unix ms; nullable for `manual` |
| `created_at` | INTEGER NOT NULL | |
| `updated_at` | INTEGER NOT NULL | |

### `job_steps`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | INTEGER PK | |
| `job_id` | INTEGER NOT NULL | FK jobs.id ON DELETE CASCADE |
| `ordering` | INTEGER NOT NULL | 0-based |
| `prompt` | TEXT NOT NULL | author's raw prompt text (no prepend) |

### `job_runs`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | INTEGER PK | |
| `job_id` | INTEGER NOT NULL | FK jobs.id ON DELETE CASCADE |
| `status` | TEXT NOT NULL | `queued` / `running` / `succeeded` / `failed` / `cancelled` / `interrupted` |
| `trigger` | TEXT NOT NULL | `manual` / `scheduled` |
| `queued_at` | INTEGER NOT NULL | |
| `started_at` | INTEGER | nullable until step 1 begins |
| `finished_at` | INTEGER | |
| `error` | TEXT | message of the failing step, if any |

### `job_run_steps`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | INTEGER PK | |
| `run_id` | INTEGER NOT NULL | FK job_runs.id ON DELETE CASCADE |
| `ordering` | INTEGER NOT NULL | 0-based |
| `prompt_authored` | TEXT NOT NULL | snapshot of step prompt at run time |
| `prompt_rendered` | TEXT NOT NULL | with prior-output prepend applied |
| `status` | TEXT NOT NULL | `pending` / `running` / `succeeded` / `failed` / `skipped` / `cancelled` |
| `output` | TEXT | final assistant text |
| `started_at` | INTEGER | |
| `finished_at` | INTEGER | |
| `error` | TEXT | |

Job-step snapshots into the run record (rather than just FK-ing `job_steps`) so that editing a job later doesn't rewrite the history of past runs.

---

## Execution: `jobs/runner.ts`

Public API:

```ts
export const runner = {
	enqueue(jobId: number, trigger: 'manual' | 'scheduled'): Promise<number>,  // returns runId
	cancel(runId: number): Promise<void>,
	queue: ReadableStore<RunState[]>,   // reactive
	current: ReadableStore<RunState | null>
}
```

Where `RunState` carries the run record + per-step state + the currently streaming assistant text (mirrored from the agent loop).

### Per-step execution

1. Mark step `running`, set `started_at`.
2. Compute `prompt_rendered`:
   - Step 0: `prompt_authored`.
   - Step N > 0: `${prevStep.output}\n\n${prompt_authored}`.
   - If `prompt_rendered.length` is suspiciously large (e.g. > 80% of context budget), emit a warning into the run log but proceed.
3. Boot an **ephemeral** chat session (no persistence to `conversations` / `messages`). The session uses:
   - The app's current model, temperature, system prompt.
   - The job's `working_dir` as the active workdir.
   - An auto-approve flag (see below).
4. Send `prompt_rendered` as a user message. Call the existing agent loop. Stream into the `RunState`'s assistant buffer (so the run view UI can render it live).
5. On stream end:
   - Final assistant text → `output`, status `succeeded`.
   - Persist step record.
   - Advance to next step.
6. On error (model error, tool error that escapes the loop, cancellation):
   - Persist step with `failed` / `cancelled` and the error message.
   - Mark the parent run `failed` / `cancelled`.
   - Remaining steps stay `pending` (not skipped — they were never attempted).
   - Stop processing. Pop next run from queue.

### Headless / ephemeral chat session

The current chat store is bound to a persisted conversation row. We need a "headless turn" entry point that runs the agent loop without touching the chat store:

- New helper `runEphemeralTurn({ systemPrompt, userMessage, workdir, autoApprove, onAssistantDelta, onToolCall, signal })` in `src/lib/agent/` that wraps the existing loop.
- It builds an in-memory message array, plumbs the auto-approve flag into the sandbox-approval check site, threads an `AbortSignal` for cancel, and returns the final assistant text.
- Keep the existing chat-bound entry point intact; the ephemeral helper composes the same underlying primitives.

### Auto-approve plumbing

`sandboxApproval` and any sibling approval stores currently `await` a UI promise. Two clean options — pick one:

- **Context-scoped override**: a small `AsyncLocalStorage`-style pattern (using a module-level `currentAutoApprove` set/cleared around the loop call) that the approval store consults first. If true → auto-resolve, log the call into the run's `tool_calls` audit stream.
- **Pass-through parameter**: thread `autoApprove` through `runAgentLoop` and into every tool callsite. More invasive; more honest.

Recommend the context-scoped approach for v1 because it avoids touching every tool callsite. Document the constraint clearly in the runner code.

### Cancel semantics

`runner.cancel(runId)` triggers the `AbortSignal` for the current step's llama stream. Llama-server's HTTP stream is closed; the agent loop's `await` rejects; the step is recorded `cancelled`; the run is marked `cancelled`; the queue advances.

### Crash recovery

On app start, before the runner begins processing the queue: any row in `job_runs` with status `running` or `queued` from a previous session is set to `interrupted` (with an `error` of "app was closed during run").

---

## Scheduler: `jobs/scheduler.ts`

- Single `setInterval` ticker fires every 30 seconds (small, cheap; no need for sub-minute precision).
- Each tick: `SELECT id, schedule_kind, schedule_config, next_due_at FROM jobs WHERE schedule_kind != 'manual' AND next_due_at <= ?`.
- For each due job: `runner.enqueue(jobId, 'scheduled')`, then recompute and persist `next_due_at`.

### `next_due_at` computation

| `schedule_kind` | Next due |
| --- | --- |
| `hourly` | next top-of-hour |
| `daily` | next `HH:MM` (today if still future, else tomorrow) |
| `weekly` | next occurrence of `day` at `HH:MM` |
| `interval` | `last_due_or_now + minutes` (anchored on `next_due_at` so cadence stays steady even if a run took longer than the interval) |

`next_due_at` is recomputed on job create, on job edit (schedule changed), and after each enqueue. `manual` jobs have `next_due_at = NULL`.

---

## UI Components

| Component | Responsibility |
| --- | --- |
| `routes/+page.svelte` | Hosts tab shell. Reads `activeTabStore`. Renders `<ChatView/>` or `<JobsTab/>`. |
| `lib/components/TabBar.svelte` | Two-tab bar with active highlight; emits tab-change events. Extracted from page so phase-13 can extend it. |
| `lib/components/ChatView.svelte` | Extracted from current `+page.svelte` body — all chat UI moves here. |
| `lib/components/jobs/JobsTab.svelte` | Top-level Jobs layout (list / center / history panes). |
| `lib/components/jobs/JobList.svelte` | Left pane: jobs with name, schedule chip, last-run status dot, run button. |
| `lib/components/jobs/JobEditor.svelte` | Center pane (edit mode): name, description, workdir picker (reuses `WorkingDirButton.svelte`), auto-approve toggle, schedule field, ordered step list (add / remove / drag-reorder), save / cancel. |
| `lib/components/jobs/JobScheduleField.svelte` | Schedule subform: kind dropdown + dynamic config inputs. |
| `lib/components/jobs/JobRunView.svelte` | Center pane (run mode): step list with status pills, currently streaming step rendered with `ChatMessage.svelte`, cancel button, queue indicator. |
| `lib/components/jobs/JobRunDetail.svelte` | Center pane (past-run mode): each step's authored prompt, rendered prompt (collapsed), output. |
| `lib/components/jobs/JobRunHistory.svelte` | Right pane: list of past runs for the selected job, with status / trigger / start time, click → loads `JobRunDetail`. |
| `lib/components/jobs/QueueBadge.svelte` | Small indicator near the Jobs tab label and inside the tab: "2 queued" / "running". |

### Stores

| Store | Notes |
| --- | --- |
| `lib/stores/activeTab.svelte.ts` | `'chat' \| 'jobs'`, persisted. |
| `lib/stores/jobs.svelte.ts` | CRUD over `jobs` / `job_steps` tables; reactive list. |
| `lib/stores/jobRuns.svelte.ts` | Read-side for `job_runs` / `job_run_steps`; subscribes to runner events to stay live. |

Runner and scheduler live in `lib/agent/jobs/` (sibling to existing `agent/loop.ts`) since they're execution primitives, not stores.

---

## Step Prompt Editor

In v1, each step is a single plain-text textarea (multi-line, monospace). No template variables, no syntax highlighting. The previous-output prepend is automatic and not editable; the editor shows a small hint under steps 2+ saying "Prior step's output is automatically prepended to this prompt at run time."

A future iteration could add `{{prev}}` / `{{step1.output}}` template variables — schema-compatible (just adds a renderer).

---

## Tool Surface

**No new agent-facing tools.** Jobs is a wrapper around the existing tool surface; the model in each step sees the same tools it has in Chat. The only behavior delta is that auto-approve suppresses the UI prompt for tools that require approval.

---

## Open Questions / Deferred

- Per-step continue-on-error toggle — explicitly deferred to v2.
- Per-step workdir override — deferred.
- Per-run output subfolder under workdir — deferred; users can `mkdir $(date)` in their step prompt today.
- Per-job model / temperature / system-prompt pinning — deferred.
- Template variables in step prompts — deferred; schema-compatible extension.
- OS-level scheduling (systemd / launchd) — deferred until a headless app mode exists.
- Notifications when a scheduled run finishes — deferred; v1 user sees status in the Jobs tab.

---

## Test Plan

### Rust (`src-tauri/`)

No new Rust commands are strictly required (everything runs in TS against the existing agent loop and DB). If the migration is run from Rust side, cover it with a unit test that opens a fresh sqlite file, applies migrations, and asserts the four tables exist with expected columns.

### TS / Svelte (`vitest`)

- `jobs.svelte.ts` — CRUD round-trip (create → list → update → delete cascades steps).
- `scheduler.ts` — `next_due_at` computation for each `schedule_kind` (frozen-time tests).
- `runner.ts` — happy path: 2-step job, second step receives prepended prior output; failure path: step 2 throws, run marked failed, step 3 left pending; cancel path: AbortSignal mid-stream → cancelled status.
- `runner.ts` queue: enqueue two runs back-to-back, assert FIFO ordering.
- Crash-recovery sweep: a fixture DB with a `running` row → after `recoverOrphans()` it is `interrupted`.

### Manual smoke

- All deliverables above. Particular attention to:
  - Cancel mid-stream actually aborts llama-server (check llama-server logs show closed connection).
  - Auto-approve OFF + scheduled run: run blocks at first tool approval (acceptable but document; encourage auto-approve for unattended jobs).
  - Editing a job while a run of it is in flight: the **snapshotted** prompts in `job_run_steps` are what's executed; live edits don't take effect mid-run.

---

## Implementation Order (suggested PR sequence)

1. **Tab shell + ChatView extraction.** Pure refactor. Introduces `TabBar`, `activeTabStore`, and `ChatView`. Chat behavior unchanged. (Sets phase-13 up.)
2. **DB migration + jobs/steps CRUD store + JobList / JobEditor.** Can save and list jobs; cannot run them yet. Schedule field is wired but scheduler not yet ticking.
3. **Ephemeral turn helper + runner (single-job, no queue).** Manual "Run" works for single-step jobs.
4. **Multi-step pipelines + prior-output prepend + failure handling.** Runner walks steps.
5. **Run history persistence + JobRunHistory / JobRunDetail.** Past runs browsable.
6. **Cancel + crash recovery.**
7. **Scheduler + queue.** Scheduled fires enqueue; queue indicator UI.
8. **Polish: prompt-size warning, queue badge on tab, empty-state copy, docs in maintenance.md.**

Each step is independently shippable and user-testable.
