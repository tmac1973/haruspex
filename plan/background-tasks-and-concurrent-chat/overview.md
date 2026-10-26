# Background tasks and concurrent chat — Project Overview

Steps 2 and 3 of tmac1973/haruspex#696. Step 1 (releasing the inference slot
while a long tool call runs) is a separate change and is not part of this plan.

## Problem

Generation is getting slow. Toolchest image and music jobs already take
minutes, and toolchest video jobs will take much longer. Today every image and
music tool waits for its job inside the agent turn (`followJob`, ComfyUI's
history poll, sd-server's and Lemonade's synchronous requests), so the turn,
and the conversation, is stuck until the job ends. Only video renders and
YouTube uploads (`src/lib/video/`) run in the background, and those notices
are delivered only when their conversation is open, and are lost if the app
restarts.

Chat also runs one turn at a time across all conversations. Its run state
(`isGenerating`, `streamingContent`, `abortController`, the error banner, the
startup queue) is module-level in `src/lib/stores/chat.svelte.ts`, so while one
conversation works the user can open another but cannot send in it. The owner
web client (`src/lib/engine/chat.svelte.ts`, `src/web/`) inherits the same
single-busy-chat assumption. The Code tab doesn't have this problem: each
`CodeSession` carries its own run state.

## Goals

- One background-task registry for long generation and video work, owned by a
  Chat conversation (`chat:<id>`) or a Code session (`code:<id>`), with
  progress, Cancel, and a result.
- Video generation always runs as a background task. Image and music
  generation stay blocking by default, and the model can pass
  `background: true` to run them as background tasks.
- Background generation works on every image and music backend: toolchest,
  ComfyUI, the bundled sd-server and Lemonade.
- The existing video render and YouTube upload tasks move onto the registry.
- When a task ends, its owner gets a notice turn. If the owner is busy, the
  notice waits until it's idle. A Chat conversation that isn't open runs its
  notice turn anyway, with a toast and a running-then-unread mark in the
  sidebar.
- Tasks survive a restart where they can: server-side jobs (toolchest image,
  music and video; ComfyUI; the ACE music server) are saved and followed again
  on launch. Work that ends with the app is marked failed, and its owner gets
  a notice: melt renders, YouTube uploads, and sd-server and Lemonade requests
  (both are single synchronous requests with no job to reattach to).
- Tasks are visible in two places: as a card in the conversation or session
  that started them, and in an app-wide indicator listing every running task
  (including Code's existing background processes and subtasks, read from
  where they live today).
- Chat conversations run turns concurrently, each with its own run state,
  Stop, error banner and context gauge. With one local inference slot they
  queue; with more slots, or against remote or toolchest servers, they run in
  parallel.
- Sending in a busy Chat conversation steers its running turn, as Code does.
- The owner web client reports and controls each chat's busy state
  separately.
- A toolchest `generate_video` tool for Chat and Code, built last.

## Non-goals

- Releasing the inference slot during long tool calls (step 1 of #696).
- Background tasks for scheduled jobs or the Shell; they keep blocking calls.
- Moving Code's `code_bg` processes or background delegate subtasks into the
  registry. They are listed in the app-wide indicator but keep their own
  mechanics.
- Backgrounding arbitrary chat turns.
- An app-side cap on concurrent generation tasks for servers that queue jobs
  themselves (toolchest, ComfyUI).
- Reattaching to local processes after a restart.
- Remote guest chat (`src/lib/remote/driver.ts`), which already has its own
  turn state.
- Listing Code background processes and subtasks of sessions detached into
  another window. Their state lives in that window, so each window's Tasks
  chip lists the ones for its own sessions. Registry tasks are listed in
  every window.

## Users & primary flow

The user is someone running Haruspex with a generation backend configured
(often a llama-toolchest server).

1. In Chat conversation A, the user asks for a video. The model calls the
   video tool; it returns a task id at once, and a task card appears in the
   thread with progress and Cancel. The model replies that the video is
   rendering, and the turn ends.
2. The Tasks chip at the right of the tab bar shows one running task.
3. The user opens conversation B and asks something else. B's turn runs
   alongside anything else in flight, queued behind A's slot only if the
   inference lane has a single slot.
4. While B's turn runs, the user sends a follow-up in B; it steers B's
   running turn.
5. The video finishes. A isn't open, so A gets a toast, runs a notice turn in
   the background (the model checks and reports the result), and the sidebar
   marks A as running, then unread.
6. The user opens A and sees the report and the finished task card.
7. If the app had been closed mid-render, on launch the toolchest job would be
   followed again from its saved id, and the notice would arrive the same way.

The same applies in a Code session: the card is in its transcript, and the
notice turn runs when the session is idle. A Code session that isn't open
keeps its notice until it is next opened.

## Constraints

- Tauri 2 + SvelteKit 5 runes; Rust side in `src-tauri/src/`. Changing a
  Tauri command or a `#[ts(export)]` struct means running
  `./scripts/export-ipc-types.sh`.
- The model may be the 9B default: a background tool's result has to say
  plainly that the task started and that a notification turn will follow, with
  no polling (the wording Code already uses for `run_command` watches).
- Notice turns are user-role messages, recognisable by prefix (as
  `isVideoNotice` / `isSubtaskNotification` do today).
- Inference admission stays with the Rust inference queue; concurrent chats
  only change who asks, not how slots are given out.
- Toolchest deletes job outputs after about a day, so reattach after a long
  shutdown can find the job gone; that ends the task as failed.
- The bundled sd-server and Lemonade can't queue, so generation requests to
  them, blocking or background, run one at a time behind a lock in Rust.
- The toolchest video API isn't final; the last phase assumes the
  image/music job lifecycle and lists what to confirm.
- User guide pages (`docs/guide/`) change with every user-visible step.

## Success criteria

- Two Chat conversations can each have a turn running at once, each with its
  own streaming text, Stop and error banner. Stopping one leaves the other
  running.
- Sending in a busy conversation steers its running turn.
- `generate_image` / music tools with `background: true`, and every video
  render, return within a second with a task card; the job continues after
  the turn ends.
- Cancelling from the card or the app-wide indicator cancels the job on the
  server.
- A finished task in a conversation that isn't open runs its notice turn
  without the user opening it, and the sidebar shows it running, then unread.
- A finished task in a busy owner runs its notice turn after the current turn
  ends, never during it.
- Closing the app mid toolchest job and reopening it reattaches the job and
  delivers its notice; a sd-server task interrupted the same way is reported
  as failed.
- The owner web client shows each busy chat separately and can send to and
  stop any chat.
- `npm run check`, `npm run lint`, `npm run test`, `cargo test` and
  `cargo clippy` pass; the guide pages describe the new behaviour.

## Decisions

- **Which generation runs in the background** → Video always; image and music
  opt-in with `background: true`.
- **Which backends** → All image backends (toolchest, ComfyUI, sd-server,
  Lemonade), both music backends (toolchest, the ACE server), and toolchest
  video.
- **Restart behaviour** → Reattach server-side jobs; mark the rest failed
  with a notice. Corrected during review: Lemonade has no job API, so it is
  in the second group.
- **Notice for a busy owner** → Queue until the owner is idle.
- **Notice for a Chat conversation that isn't open** → Run it in the
  background, with a toast and a sidebar mark.
- **Where tasks are listed** → A card in the owning thread plus an app-wide
  indicator.
- **Which surfaces start background tasks** → Chat and Code only.
- **Concurrency cap** → None app-side for servers that queue; one at a time on
  sd-server and Lemonade.
- **Owner web client** → Full per-chat busy state in this project.
- **Code's existing background work** → Shown in the app-wide indicator, not
  migrated; each window lists its own sessions' processes and subtasks.
- **Toolchest video API** → Last phase, assuming the image/music job shape.
- **Sending in a busy Chat conversation** → Steers the running turn, like Code.
