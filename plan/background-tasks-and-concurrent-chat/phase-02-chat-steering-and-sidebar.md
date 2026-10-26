# Phase 02 — Steering, sidebar marks and background notice turns

**Depends on:** 01 · **Enables:** notice turns from the task registry (04)

## Goal

Make concurrent Chat usable:
- Sending in a busy conversation steers its running turn, as Code does.
- The sidebar shows which conversations are running or waiting, and which
  finished a turn you haven't seen, and the unread mark survives a restart.
- Video notices run as soon as their conversation is idle, whether or not
  it's open, with a toast. This is the delivery path the task registry uses
  in phase 04.

## Files touched

- `src/lib/stores/chatRun.svelte.ts` — `steering`, `steeringDelivered`, and
  handing back steering on cancel.
- `src/lib/stores/chat.svelte.ts` — `sendMessage` steers when busy; notice
  delivery; unread.
- `src/lib/components/ChatView.svelte` — the composer stays enabled while
  busy, and shows queued steering as Code's composer does.
- `src/lib/components/ConversationSidebar.svelte` — running, waiting and
  unread marks.
- `src-tauri/src/db/mod.rs` — migration:
  `ALTER TABLE conversations ADD COLUMN unread INTEGER NOT NULL DEFAULT 0`.
- `src-tauri/src/db/conversations.rs`, `src-tauri/src/db/commands.rs` —
  `unread` in `ConversationSummary`; a `conversation_set_unread(id, unread)`
  command.
- `src/lib/ipc/gen/*` — regenerated with `./scripts/export-ipc-types.sh`.
- `src/lib/stores/db.ts` — the `dbSetUnread` wrapper.
- `src/lib/video/taskWatch.ts` — the chat handler is told about every
  conversation, not only the open one.
- `docs/guide/chat.md` — steering, the sidebar marks, and notices in the
  background.

## Steps

1. Add `steering: SteeringMessage[]` and `steeringDelivered` to `ChatRun`.
   Pass `steering` into `runAgentLoop` the way `CodeSession` does
   (`code.svelte.ts:827-832`): the loop drains it at the next iteration
   through `agent/loop/steeringQueue.ts` and reports delivery with its
   callback. A turn that is cancelled or ends with steering still queued
   hands it back (the loop's existing `onComplete` wrap). The leftover
   messages then run as the next turn's user message, joined with blank
   lines, as Code does at l.933. Leftover steering goes first: the turn's
   finally runs it before `deliverNotices` (step 6), and notices wait for the
   turn after that.
2. `sendMessage(content, images)` on a busy conversation appends to
   `run.steering` and returns. The user bubble shows at once as "queued",
   then as a normal message when it's delivered. Compacting counts as busy,
   and steering sent while compacting waits for the turn.
3. ChatView: the send button stays Send while busy (Stop is beside it).
   Queued steering shows above the composer like `CodeComposer.svelte` does;
   reuse its markup.
4. Sidebar: each row reads `getRun(conv.id)`. A spinner dot means `running`
   or `starting`; a hollow dot means `queued`; a filled accent dot means
   `unread`. The `title` tooltip names the state.
5. Unread: when a turn commits in a conversation that isn't active, set
   `conv.unread = true` and call `dbSetUnread(id, true)`.
   `setActiveConversation` clears it. Load it with the summaries in
   `initChatStore`.
6. Notice delivery: replace `onVideoTaskEnded`'s toast-and-wait with
   `deliverNotices(convId)`:
   - If the conversation's run is idle, take its notices (`takeVideoNotices`)
     and start a turn with them in that conversation, without opening it.
     This needs `sendMessage` to take an explicit conversation id; add
     `sendMessageTo(id, content, images?)` and have `sendMessage(content,
     images)` call it with the active id.
   - If the conversation isn't active, show a toast built by
     `noticeToast(title)` in `chat.svelte.ts`: “A task finished in
     ‘<title>’.” Its action is “Open”, which calls `setActiveConversation`.
     The wording is generic so the image, music and video tasks of later
     phases reuse it.
   - `runCurrentTurn`'s finally runs leftover steering first (step 1). Only
     when there is none does it call `deliverNotices(conversation.id)` for its
     own conversation, replacing `flushVideoNotices` for the active one.
7. `taskWatch.ts`: keep the wildcard `chat:*` handler, which now gets the
   owner, so the store can deliver to any conversation.
8. Run `./scripts/export-ipc-types.sh`.
9. Guide: add “Send while it’s working” and “See which conversations are busy”
   to `docs/guide/chat.md`.

## Build gate

- `npm run check`
- `npm run lint`
- `npm run format:check`
- `npm run test`
- `cd src-tauri && cargo test && cargo clippy && cargo fmt -- --check`
- `./scripts/export-ipc-types.sh`, leaving no diff

## Test plan

- Unit:
  - Sending while busy queues steering, and the loop delivers it at the next
    iteration.
  - Cancelling with steering queued runs the steering as the next turn.
- Unit: a commit in a non-active conversation sets unread, and opening it
  clears it.
- Rust: the migration adds `unread`, and `conversation_set_unread` round-trips.
- Unit: a video notice for an idle, non-open conversation starts a turn there
  and shows a toast. For a busy one it waits, then runs from the turn's
  finally.
- Manual:
  - Render a video in A, open B, and wait. A runs its notice turn, shows
    running then unread in the sidebar, and the toast's Open goes to A.
  - Restart the app and A is still unread.

## Commit

`feat(chat): steer a running turn and mark busy and unread conversations`

## Rollback

Revert the commit. The `unread` column stays in the DB, and that's harmless:
it has a default and older code ignores it. Steering, sidebar marks and notice
delivery are frontend-only and revert together.
