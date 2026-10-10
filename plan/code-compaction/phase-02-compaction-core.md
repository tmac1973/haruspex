# Phase 2 — Compaction core

**Depends on:** — · **Guide:** none (`no-docs`; nothing calls it yet)

## Goal

Pure, unit-tested building blocks in `src/lib/code/compaction.ts`, plus the
saved field and the Rust fork. No store or UI changes.

## Saved shape (`src/lib/code/session.ts`)

```ts
export interface CodeCompaction {
	/** messages[0, at) are covered by `summary`; the model sees messages[at…]. */
	at: number;
	summary: string;
	summarizedAt: number;
}
// CodeSessionSnapshot / CodeSessionState gain:
compaction?: CodeCompaction | null;
```

- `encodeCodeSession` writes the field. `decodeCodeSession` validates it: `at`
  must be an integer in `(0, messages.length]` and `summary` must be a
  non-empty string. Anything else decodes as `null`, so the session runs
  uncompacted rather than failing.
- Stay on `CODE_SESSION_VERSION = 1`. The field is optional, and an older
  build simply ignores it. Say so in the module comment.

## Rust (`src-tauri/src/db/code_sessions.rs`)

`fork_thread(thread, at)`: keep `compaction` when `compaction.at < at`, and
otherwise remove the key. Update the doc comment saying the shape is "mirrored
in one place". Add tests for a fork before, at and after the cut, and for a
thread with no compaction.

## Functions (`src/lib/code/compaction.ts`)

```ts
/** What the model is sent: a leading summary note, then messages[at…]. */
export function modelThread(s: { messages: ChatMessage[]; compaction?: CodeCompaction | null }): ChatMessage[];

/** Compact now? The view's calibrated estimate is at least 75% of the window. */
export function shouldCompactCode(view: ChatMessage[], contextSize: number): boolean;

/**
 * Where to cut: the opening message of the oldest turn to keep verbatim.
 * Keeps the newest turns, up to 25% of the window and at least the last one.
 * Never before the current cut or between a call and its results. Null when
 * there is nothing new to summarise.
 */
export function chooseCut(messages: ChatMessage[], from: number, contextSize: number): number | null;

/** The span as compact text: calls as `→ name(arg)`, results clipped, reasoning removed. */
export function renderForSummary(messages: ChatMessage[]): string[]; // one string per turn

/**
 * Roll the summary forward over the turns in chunks that each fit the request
 * budget. One model call per chunk, against `backend`.
 */
export async function summarizeTurns(opts: {
	previous: string | null;
	turns: string[];
	backend: BackendOverride | null;
	contextSize: number;
	signal: AbortSignal;
}): Promise<string>;

/** All of the above: returns the new compaction, or null when there is nothing to do. */
export async function compactCodeThread(...): Promise<CodeCompaction | null>;
```

- **Turn boundaries.** A turn opens at a `user` message: one the user typed, a
  watch notice, or a steering message. Reuse `forkPoint` to identify a user
  message rather than writing a second check.
- **The summary note in `modelThread`.** A `system` message:
  `[Summary of this session's earlier turns]\n…`. `mergeLeadingSystemMessages`
  in `prepareMessages` merges it into the system prompt.
- **`summarizeTurns`** uses `chatCompletion` with:
  - `chat_template_kwargs` from the session's descriptor;
  - `temperature 0.3`;
  - `max_tokens = min(4096, contextSize / 16)`.

  The summary is written for coding (see overview). Remove `<think>` from the
  reply. An empty reply throws, so the caller falls back.

## Tests (`compaction.test.ts`)

- `chooseCut`:
  - always lands on a turn opening;
  - never splits a tool pair;
  - keeps at least the last turn;
  - is null when everything is recent;
  - never moves backwards from `from`.
- `renderForSummary` clips a 40 KB tool result and names the call.
- `summarizeTurns`, with `chatCompletion` mocked:
  - one call when everything fits;
  - several calls, each carrying the previous summary, when it doesn't;
  - every request fits the budget;
  - the session backend is passed through.
- `modelThread` with no compaction is the thread unchanged. With one, it is
  the note plus `messages.slice(at)`.
- Session encode/decode round trip. A bad `compaction` decodes as `null`.
