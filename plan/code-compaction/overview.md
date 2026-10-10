# Code Tab Compaction — Overview

## The problem

A Code turn sends the whole saved thread: every earlier user message, answer,
tool call and tool result (`runCodeTurn` → `prepareMessages`). Only the
per-request fit (`fitMessagesToBudget`) keeps it inside the window. The fit
works on a copy, so the saved thread never shrinks. On a long session:

1. **The prompt cache is lost every turn.** The fit starts again from the full
   thread each turn and changes the prompt from near its start:
   - it drops a different number of old turns;
   - it stubs a different set of tool results (largest first);
   - it writes `[Older messages dropped …: N message(s) removed.]` into the
     system message, and N changes every turn.

   llama-server reuses only an identical prefix, so the whole prompt is
   processed again before every answer.
2. **Dropped turns are forgotten without a trace.** Nothing summarises them, so
   the model loses earlier decisions and doesn't know it has.
3. **The saved thread and its writes keep growing.** Every tool result is kept
   for good, and `persist()` writes all of it once per turn.

Chat avoids most of this. `compactIfNeeded` summarises at 80% of the window,
before the fit has to drop anything. The Code tab never got that step.

## The design

### What is saved

`CodeSessionState` gains one optional field:

```ts
compaction?: { at: number; summary: string; summarizedAt: number } | null;
```

- `messages[0, at)` are summarised by `summary`. The model never sees them
  again.
- `messages` itself is **not rewritten**. The transcript still shows every
  message, and forks, `messageSteps`, `messageStats`, `messageStops` and
  `fileNotes` keep their indices. Nothing needs remapping. This is the main
  difference from Chat, which replaces its messages and remaps every
  index-keyed record (`remapIndexedRecords`).
- Only the latest compaction is kept. A later one summarises the earlier
  summary together with the turns since then.

### What the model sees

```
[system prompt] + [summary, as a leading system message] + messages.slice(at)
```

`mergeLeadingSystemMessages` already merges a leading system message into the
system prompt. The prefix then stays identical from one turn to the next until
the next compaction, so the prompt cache works between compactions.

### When it runs

- **Automatically, before a turn.** It runs when the estimated prompt
  (`estimateMessagesTokens(view) × getTokenCalibration()`) reaches 75% of the
  session backend's window. That is below Chat's 80%, because a Code turn
  grows much more within itself than a chat turn. It never runs during a turn:
  in a turn, the in-loop trim and the fit still do the work.
- **By hand, with `/compact`** (phase 4).

### Where the cut goes

The cut always falls on the opening message of a turn: a user message the user
typed, or a watch notice. Tool call/result pairs are never split. Keep the
newest turns verbatim, up to about 25% of the window and at least the last
turn. If the last turn alone is over 25%, the cut goes at its opening and the
fit deals with the rest. If there is nothing older to summarise, skip.

### How it summarises

- **Use the session's backend** (`resolveBackendDescriptor(session.backend)`).
  Chat always uses the global backend; a Code session may be on another model
  with another window.
- **Queue for the inference slot** (`withInferenceSlot({ consumer: 'code' })`)
  like any other model call.
- **Write the summary input compactly** rather than sending raw messages:
  - an assistant tool call becomes `→ name(main argument)`;
  - a tool result becomes its first and last ~600 characters
    (`truncateCapturedOutput`), so the outcome survives but file contents
    don't;
  - reasoning (`<think>`) is removed.
- **Summarise in chunks.** If the rendered span plus the earlier summary is
  over the request budget (window minus the summary reserve), split it at turn
  boundaries and summarise each chunk, carrying the summary forward:
  `s_k = summarize(s_{k-1}, chunk_k)`.
- **Use a prompt written for coding.** The summary should cover:
  - the task and how it has changed;
  - the user's instructions and preferences for this session;
  - decisions and why they were made;
  - files created or changed, by path;
  - commands that ran and what came of them (tests passing or failing);
  - what was tried and failed;
  - open TODOs and where the session left off.

  It should also tell the model that file contents are not kept and that it
  should read a file again rather than recall it.
- **Size the reply to the window:** `max_tokens = min(4096, window / 16)`.

### When it fails

If the summary call fails, keep running. Log it, leave `compaction`
unchanged, and run the turn as today, with the fit as the backstop. A Stop
during summarising stops the turn, as a Stop does now.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Rewrite `messages` or keep a cut index | Cut index | The transcript stays whole, and forks and the index-keyed records keep working |
| Number of summaries kept | One, rolled forward | Simple; the newest summary covers everything before it |
| Payload version | Stay on `CODE_SESSION_VERSION = 1` | The field is optional. An older build decodes it as no compaction and runs as today. |
| Trigger | 75% before a turn, plus `/compact` | Below the fit's budget, so the fit rarely has to drop turns |
| Backend | The session's | A per-session model can have a different window |

## Invariants

- The cut index always points at a turn's opening message, never between a
  tool call and its results.
- `compaction.at <= messages.length`. A fork at `at' <= at` drops the
  compaction. A fork at `at' > at` keeps it. Rust's `fork_thread` mirrors the
  TypeScript side, with a test on each side.
- The model's view is built in one place (`modelThread(state)`). Nothing else
  slices `messages` for the model.
- Settings stay plain JSON, and the summary string is snapshotted like the rest
  of the thread.

## Out of scope (for issues)

- Shell → Full access uses the same fit-only path, but its thread is not saved
  and is already cut to 40 messages.
- Chat rewrites its history when it compacts. It could use the cut-index model
  too, so users keep their scrollback.
- The token calibration is one global value shared by every backend.
- Chat's summary request has no fit of its own and can overflow on very long
  chats. Its error isn't caught in `sendMessage`.
- Saved Code threads still grow, since the full transcript is kept. Old tool
  results could be stored clipped once they are behind the cut. Measure first.
