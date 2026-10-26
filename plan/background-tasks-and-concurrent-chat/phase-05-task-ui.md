# Phase 05 — Task cards and the Tasks chip

**Depends on:** 02, 04 · **Enables:** the user-visible side of 06, 07 and 08

## Goal

Show every background task in two places:
- **A generic `TaskCard`** in the conversation or session that started it.
  It replaces `VideoTaskCard` and shows progress, phase, queue position,
  Cancel and the result.
- **A “Tasks” chip at the right of the tab bar**, visible from every tab. It
  lists every running task app-wide, plus Code's background processes and
  subtasks.

## Files touched

- `src/lib/components/tasks/TaskCard.svelte` (new) — the generic card, with
  a result section per kind.
- `src/lib/components/tasks/TaskCard.test.ts` (new).
- `src/lib/components/tasks/TasksChip.svelte` (new) — the chip and its
  popover list.
- `src/lib/components/tasks/TasksChip.test.ts` (new).
- `src/lib/components/video/VideoTaskCard.svelte` — deleted. Its
  video-specific result UI (Open, Show in folder, Studio links, failure
  report) moves into a `VideoTaskResult.svelte` section that `TaskCard`
  uses.
- `src/lib/components/video/VideoTaskResult.svelte` (new).
- `src/lib/components/SearchStep.svelte` — render `TaskCard` for a
  `{kind:'task'}` artifact (l.342).
- `src/lib/sandbox/protocol.ts` — rename the `videoTask` artifact to
  `{ kind: 'task'; taskId; label }`. Keep reading `videoTask` from saved
  conversations as an alias.
- `src/lib/components/TabBar.svelte` — mount `TasksChip` at the right.
- `src/lib/agent/tools/video.ts`, `src/lib/agent/tools/youtube-upload.ts` —
  return the `{kind:'task'}` artifact.
- `src/lib/stores/chat.svelte.ts` — the generic notice toast from phase 02
  gains the task's label: “‘<label>’ finished in ‘<title>’.” When one notice
  turn carries several tasks it says “<n> tasks finished in ‘<title>’.”
- `src/lib/stores/code.svelte.ts` — export `getAllBackgroundWork()`: each
  open session's `background` processes and running background subtasks,
  with the session id.
- `docs/guide/chat.md`, `docs/guide/code-sessions.md` — the Tasks chip.

## Steps

1. `TaskCard`, given a `taskId`, reads `getTask(id)`:
   - **Pending:** “Waiting to start”.
   - **Running:** a progress bar from `percent` (indeterminate when null),
     plus `phase`, `queue_position` (“3rd in the server's queue”), the ETA,
     and Cancel. Cancel calls `task_cancel` with no confirm, since the user
     clicked it.
   - **Ended:** a result section by kind: `VideoTaskResult` for video render
     and upload; image, music and video results come in phases 06–08. On
     Failed it shows the error and `log_tail` behind a disclosure, with the
     Report issue button the card has today.

   A task missing from the store, for example pruned, shows as “Task no
   longer available.”
2. The tools in `video.ts` and `youtube-upload.ts` return the `{kind:'task'}`
   artifact.
3. `TasksChip`:
   - It shows when anything is running: registry tasks in `pending` or
     `running`, or `getAllBackgroundWork()` entries. The label is
     “Tasks: N”, and the `title` tooltip lists them.
   - It also stays visible for 10 minutes after the last task ends, with no
     count, so a finished result can be found again.
   - Clicking opens a popover with one row per item: label, owner (the
     conversation title or Code session name), progress, Cancel or Stop, and
     a link that goes to the owner. For a chat owner, the link calls
     `setActiveTab('chat')` and `setActiveConversation(id)`. For a Code
     owner, it calls `setActiveTab('code')` and opens the session the way
     `CodeSidebar.svelte` does, which also works for one that isn't open.
   - Owner names: chat titles from `getConversations()`; Code session names
     from `code_session_list` (`src/lib/code/db.ts:53`), fetched when the
     popover opens, so sessions that aren't open (or open in another window)
     are named too.
   - Code processes and subtasks stop through their existing calls
     (`code_bg_stop`, the session's subtask stop). They're listed only for
     sessions open in this window, since that's where their state lives.
   - Ended registry tasks from the last 10 minutes are listed under “Done”.
4. Follow the UI copy rule: one short line at the top of the popover at most,
   with detail in tooltips.
5. Guide: a short “See background tasks” section in `docs/guide/chat.md` and
   `docs/guide/code-sessions.md`.

## Build gate

- `npm run check`
- `npm run lint`
- `npm run format:check`
- `npm run test`

## Test plan

- Component tests:
  - `TaskCard` renders pending, running (with and without percent), done
    video, failed (log disclosure) and missing.
  - Cancel invokes `task_cancel`.
- Component tests:
  - `TasksChip` is hidden with nothing running.
  - It counts registry tasks plus Code background work.
  - A row's link calls the right navigation.
  - It lingers for 10 minutes after the last task ends (fake timers).
- Unit: an old `videoTask` artifact in a saved conversation still renders a
  card.
- Manual:
  - Start a render in Chat and a background command in Code. The chip shows
    2 from every tab.
  - Cancel the render from the chip and its card shows Cancelled.

## Commit

`feat(tasks): task cards and a Tasks chip in the tab bar`

## Rollback

Revert the commit. It's UI only. The artifact alias means conversations saved
while it was in place still render after the revert, because the old code
reads `videoTask` and the new artifacts' `task` kind just shows no card.
