# Code tab subtasks — Project Overview

## Problem

A Code-tab turn does everything in one agent loop on one inference stream. When
a request has independent parts — "find every caller of X, check how the tests
mock Y, and read the CI config" — the model works through them one after
another, and every file it reads stays in the parent's context. On a local model
that context fills quickly, compaction kicks in, and detail is lost. Users who
run a server with several parallel slots (Settings → Inference → Parallel
streams, or a remote backend that advertises `parallel`) get no benefit from
them in the Code tab beyond read-only tool batches (`agent/loop/parallelTools.ts`).

The pieces for running child work already exist — per-lane admission in
`src-tauri/src/inference_queue.rs`, slot borrowing via `createSlotLender`
(`'subagent'` consumer), a headless loop in `agent/runEphemeralTurn.ts`,
worktrees made for forks, and notification turns for watched background
commands (`agent/tools/code-bg.ts`) — but nothing lets the Code agent hand a
self-contained piece of work to a child agent and get a short report back.

## Goals

- The Code-tab agent can delegate a self-contained task to a child agent through
  a tool, and several delegations in one response run at the same time, up to
  the lane's capacity.
- Each child starts with a fresh, small context and returns only a capped
  report, so the parent's context grows by the report, not by the child's work.
- Read-only children (explore, investigate, review) work in any folder.
- Writing children work in their own git worktree, and their changes are applied
  back to the session's folder automatically when clean; on conflict the parent
  model is given the diff and the conflict to resolve.
- Children can run in the background: the parent's turn ends, and each child's
  finish wakes the session with a notification turn, the way watched background
  commands do.
- Settings → Code → Subtasks chooses Off, Read only (the default) or Read and
  write; the delegate tool offers only the modes the setting allows.
- Each child is visible as a card in the parent's thread: live steps while it
  runs, a status, its own stop button, and its saved transcript after reload.
- The Remote control web client shows each subtask as a collapsed card with
  task, status and report.

## Non-goals

- No subtasks in the Shell tab's Code mode, chat, or jobs.
- No nesting: a child never gets the delegate tool.
- No per-subtask model choice and no separate subtask model setting; children
  use the session's backend and model.
- No user-facing command to force delegation; the model decides, within what
  Settings → Code → Subtasks allows.
- No writing children in folders that aren't git repositories, and no
  copy-the-folder fallback.
- No change to how many requests a lane admits; real concurrency is still the
  lane's capacity.
- No live child steps in the web client.

## Users & primary flow

Users of the Code tab, with any model; the speed benefit appears when the lane
admits more than one request at once.

1. The user sends a request in a Code session.
2. The parent agent decides parts of it are independent and calls the delegate
   tool once per part in one response, each with a task description and a mode
   (read-only or write), optionally in the background.
3. Each child appears as a card under the parent's tool round, showing its task
   and live steps. Children run side by side as slots allow; the rest show as
   queued.
4. A read-only child explores and returns a report. A writing child edits files
   in its own worktree, runs commands under the session's approval rules, and
   returns a report; its diff is applied to the session's folder when clean.
5. Blocking delegations: the parent's loop resumes once all of that response's
   children finish, with their reports as the tool results. Background
   delegations: the tool returns at once, the parent can finish its turn, and
   each child's completion starts a notification turn carrying its report.
6. After reload, each card still shows the child's task, status, report, and
   expandable transcript.

## Constraints

- Tauri 2 + SvelteKit 5 (runes), TypeScript; Rust for the inference queue, code
  sessions DB and git/worktree commands.
- Every model call goes through `withInferenceSlot` / `createSlotLender`; a child
  never bypasses the queue, and the parent's held slot is lent to one child.
- On the local llama-server lane, capacity defaults to 1, so children run one
  after another; `--parallel N` divides the KV context per stream.
- At most 4 children run at once per response (`MAX_PARALLEL_TOOL_CALLS`) and at
  most 8 are started per parent turn.
- One writer per folder (`CodeWriteGuard`) stays the rule for the session's
  folder; writing children write only inside their own worktree.
- Changing a Tauri command or `#[ts(export)]` struct requires
  `./scripts/export-ipc-types.sh`.
- User-visible changes update `docs/guide/` in the same PR (Guide check).
- UI copy: one short sentence per section; detail in tooltips.
- Design for capable models; the 9B default is the floor, not the target.

## Success criteria

- A response with three read-only delegate calls on a lane with capacity ≥ 3
  runs the three children concurrently (visible in the queue snapshot), and the
  parent receives three reports in call order.
- On a capacity-1 lane, the same response completes with children run in turn
  and no deadlock.
- A child's report is capped in length; the parent's prompt tokens after
  delegation grow by roughly the reports, not the children's tool output.
- Stopping the parent turn cancels blocking children; background children keep
  running and each has a working stop button; closing or deleting the session
  stops them all.
- A writing child's clean diff lands in the session's folder; a conflicting one
  leaves the folder untouched and hands the parent the diff and conflict.
- Cards and transcripts survive a reload; the web client shows collapsed cards.
- A live test passes, driven through Remote control against a capable model
  with 4 streams, on a scratch repo made for it:
  1. Create an empty git repo in a scratch folder and open a Code session on it.
  2. Have the agent build a small game from scratch: *Lantern*, a browser
     roguelike in TypeScript with Vite and Vitest — a seeded dungeon generator,
     a turn loop, a player with a light radius that shrinks each turn, oil
     pickups that refill it, monsters that move toward the player, and a canvas
     renderer. The agent commits it with passing tests.
  3. Clone that commit into two folders. In each, give the same follow-up
     work: three read-only asks (review the turn loop for bugs, list every magic
     number, report which modules have no tests) and three writing asks (add a
     high-score table in `localStorage`, add a second monster type that flees
     the light, add sound effects behind a mute toggle). One session runs with
     Settings → Code → Subtasks at Read and write; the baseline runs
     afterwards with it Off. The two never run at the same time, so neither
     takes server slots from the other.
  4. Both sessions finish with tests passing and every ask done. The subtask
     session shows lower wall time and lower peak parent prompt tokens, at
     least one blocking batch ran children concurrently, at least one writing
     child's diff auto-applied, and one background child woke the session with
     a notification turn.
  5. Results (wall time, peak parent prompt tokens, child counts, any
     conflicts, anything that went wrong) are recorded in a GitHub issue.
- `npm run check`, `npm run lint`, `npm run test`, `cargo test`, `cargo clippy`
  pass; the Code tab guide page describes subtasks.

## Decisions

- **Scope** → All three phases: read-only children, writing children in
  worktrees, background children.
- **Who starts subtasks** → The model, via a tool.
- **When the tool is offered** → In the Code tab regardless of stream count,
  governed by Settings → Code → Subtasks.
- **Subtasks setting** → A global dropdown in Settings → Code: Off / Read only /
  Read and write, defaulting to Read only. (Added after the overview was first
  approved.)
- **Child model** → Same backend and model as the session.
- **Limits** → 4 at once per response, 8 per parent turn.
- **Nesting** → One level only; children never get the delegate tool.
- **Child transcript** → Saved with the session and viewable in its card.
- **Merge-back for writing children** → Auto-apply when clean; on conflict the
  parent model gets the diff and conflict to resolve.
- **Non-git folders** → Read-only subtasks only; write mode refused with a
  one-line reason.
- **Command approvals in writing children** → Inherit the session's approval;
  otherwise the usual approval prompt names the subtask, its card shows
  "Waiting for your approval", and only that child waits.
- **Stop with background children** → Stops the turn only; children have their
  own stop; closing/deleting the session stops them all.
- **Web client** → Collapsed card with task, status and report; no live steps.
- **Shell's Code mode** → Not included; Code tab only.
- **Judging success** → Live test driven through Remote control on a scratch
  repo: the agent builds a small browser roguelike (*Lantern*), then two clones
  get the same follow-up work, run one after the other with Subtasks at Read and
  write and then Off,
  comparing wall time and parent context use.
