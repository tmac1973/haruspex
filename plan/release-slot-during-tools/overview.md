# Release the inference slot during long tools — Project Overview

Step 1 of tmac1973/haruspex#696. Steps 2 and 3 (background tasks, concurrent
Chat) are merged; see `plan/background-tasks-and-concurrent-chat/`.

## Problem

Every turn holds one inference slot for its whole agent loop, tools included.
`withInferenceSlot` (`src/lib/agent/inferenceQueue.svelte.ts`) wraps
`runAgentLoop` in Chat (`stores/chat.svelte.ts`), Code
(`code/runCodeTurn.ts`), Shell (`shell/runShellTurn.ts`), jobs
(`agent/jobs/runner.svelte.ts`) and remote guests (`remote/driver.ts`), and the
Rust queue (`src-tauri/src/inference_queue.rs`) admits only as many turns per
lane as the lane has slots: one, for the default local llama-server.

So while a turn waits on something that isn't the model, every other
conversation, Code session, job and memory pass waits behind it with the model
idle. Step 2 moved video, and images and songs asked for in the background, off
the turn, but plenty still blocks: a blocking image or song, a Code build or
test run, a slow MCP call, a melt render the model waits for, a browser fetch,
and above all a turn waiting for the user to approve a command or answer
`ask_user_question`, which can sit for hours.

## Goals

- A tool call that is still running 5 seconds after it started gives the
  turn's slot back; the turn takes a slot again when the tool ends, before its
  next model call.
- A wait on the user (a Code command approval, `ask_user_question`, the YouTube
  upload confirmation, and any other approval prompt) gives the slot back the
  moment the prompt shows, without waiting 5 seconds.
- Tools that call the model themselves while they run (`delegate`'s
  foreground subtasks, `research_url`'s page summaries) never give the slot
  back, since they are using it.
- A turn taking its slot back goes to the front of its lane's queue: ahead of
  every waiting turn, never interrupting one that is running.
- It applies to every consumer that runs an agent loop: Chat, Code, Shell,
  jobs, remote guests and Code's background subtasks.
- The user sees nothing new while the tool runs. If the turn has to wait to
  continue, the existing "waiting for a slot" state shows, as at the start of a
  turn.

## Non-goals

- Interrupting a model call that is running to let another turn in.
- Saving or restoring llama-server's KV slots ourselves: llama-server's
  `--cache-ram` prompt cache already brings a returning prompt back from RAM.
- Changing how many slots a lane has, or llama-server's `--parallel`.
- A setting for the 5-second threshold.
- Backgrounding more tools (step 2's business) or running more Chat
  conversations at once (step 3's).
- Releasing the slot between model calls when no tool runs (streaming,
  compaction, the final answer).
- Fairness beyond front-of-queue: a fresh turn can wait behind two turns that
  keep giving their slot back and taking it again, until one of them ends.
- Releasing during the repo-trust prompt (`askRepoTrust`): it is asked while
  a Code turn is set up, before the turn takes its slot.

## Users & primary flow

Anyone with a single local slot, which is the default.

1. In Chat conversation A the user asks for something that runs a long tool:
   a blocking picture, or in a Code session `npm test`, or a command that needs
   approval.
2. Five seconds into the tool (at once, for an approval), A's turn gives its
   slot back. A's tool step keeps showing its own progress.
3. The user switches to conversation B and sends a message. B is admitted and
   answers while A's tool still runs.
4. A's tool ends. A asks for its slot back at the front of the queue. If B is
   still answering, A shows "waiting for a slot" until B's turn ends or gives
   its own slot back,
   then continues ahead of anything else that queued meanwhile.
5. Stopping A at any point works as before, whether it holds a slot, has given
   it back, or is waiting for it again.

## Constraints

- The gate is process-wide in Rust, shared by every window; a release and a
  front-of-queue request have to go through its commands
  (`inference_acquire`, `inference_release`, …) and keep its lease, heartbeat,
  window-cleanup and snapshot-broadcast behaviour.
- A turn that has given its slot back holds no ticket, so it can't block the
  lane, and the lease sweeper must not reclaim anything that belongs to it.
- On a lane with one slot, a tool that calls the model inside the parent's
  held slot (`runSubtask`'s no-lender path) would deadlock if the parent had
  released it and the child queued behind a waiting turn; such tools must keep
  the slot.
- `createSlotLender` lends the parent's slot to the first child on parallel
  lanes. That stays correct only while the parent holds the slot during those
  tools.
- Read-only tools can run side by side (`parallelTools.ts`); the batch gives
  the slot back once, when any call in it has run 5 seconds, and takes it back
  once, when the batch ends.
- Abort must behave as today: a stop while released never waits for a slot,
  and a stop while waiting to come back cancels the queued request.
- Tests: vitest for the TS side, `cargo test` for the queue; the IPC types are
  regenerated with `./scripts/export-ipc-types.sh` if a command changes.
- No user-visible setting or copy changes beyond the existing waiting state;
  the guide's pages on chat and Code describe the slot behaviour in a line
  where they talk about queueing (`chat-conversations` and `code`).

## Success criteria

- With one local slot, a Code session running `sleep 30` through its shell
  tool doesn't stop a Chat conversation from answering during those 30
  seconds; the Code turn continues after the command, ahead of a turn that
  queued meanwhile.
- A Code command waiting for approval doesn't stop another conversation from
  answering.
- A Chat picture generated blocking on toolchest doesn't hold the slot while
  the job runs.
- A tool that ends inside 5 seconds never releases (no extra queue round
  trips, checked in the debug log or a test).
- `delegate` and `research_url` on a single slot still work, with no deadlock.
- Stopping a turn while its tool runs, and while it waits to come back, ends
  the turn at once and leaves no ticket in the queue snapshot.
- Rust tests cover front-of-queue admission; vitest covers the timer, the
  user-wait release, the exemptions and abort in each state.

## Decisions

- **Which tool calls give up the slot** → Long tools, by elapsed time: any tool
  still running after the threshold; tools that use the model themselves never
  do.
- **Waits on the user** → Give up the slot at once, the moment the prompt
  shows.
- **Where a returning turn rejoins** → The front of the queue, ahead of
  waiting turns, never interrupting a running one.
- **Threshold** → 5 seconds, fixed, no setting.
- **What the user sees** → Only the existing waiting-for-a-slot state, when the
  returning turn has to wait.
- **Which consumers** → Every agent-loop consumer (Chat, Code, Shell, jobs,
  remote guests, background subtasks), as #696 lists.
- **How the work is split** → Three phases, a PR each: the queue and slot
  primitives; the 5-second release around tools; the release at once on
  waits for the user, with the guide.
