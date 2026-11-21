# Phase 01 — A "prompt" inference priority

**Depends on:** nothing · **Enables:** Phase 03 (judging events at the next free
slot)

## Goal

Add a third priority to the inference queue, between foreground and background.
A prompt ticket waits for any running or waiting foreground turn in its lane,
the way background does, but goes before every waiting background ticket. That
lets a camera judgement run as soon as the current chat turn finishes, ahead of
memory extraction, Home cards and background jobs. A chat turn sent after the
judgement has started waits only for that one call (about 80–200 tokens).

## Files touched

- `src-tauri/src/inference_queue.rs`: add `Priority::Prompt`; parse and print
  `"prompt"`; order tickets as Foreground > Prompt > Background.
- `src/lib/agent/inferenceQueue.svelte.ts`: widen the priority type to
  `'foreground' | 'prompt' | 'background'`.
- `src/lib/ipc/gen/*`: regenerated if the priority is in an exported type.
- `src-tauri/src/inference_queue.rs` tests: the new ordering.

## Steps

1. In `Priority`, add `Prompt` between `Foreground` and `Background`.
   `from_str("prompt")` gives `Prompt`, and `as_str` gives `"prompt"`.
2. Wherever a ticket is picked (the `Priority::Foreground` check at about line
   227 and the background check at about 246), apply three rules:
   - A Prompt ticket is blocked by a running or waiting Foreground ticket in
     its lane, exactly as Background is.
   - A Prompt ticket is never blocked by a Background ticket.
   - A Background ticket is also blocked by any waiting Prompt ticket in its
     lane.
3. Reservations from a turn that gave its slot back (`front`) still win over
   Prompt, so a tool-using chat turn picking its slot back up isn't cut in on.
4. Update the TS type. Make no other caller changes in this phase.
5. Run `./scripts/export-ipc-types.sh` and commit any drift.

## Build gate

- `cd src-tauri && cargo fmt -- --check && cargo clippy -- -D warnings && cargo test inference_queue`
- `npm run check && npm run lint && npm run test -- inferenceQueue`

## Test plan

Rust unit tests:

- A waiting Prompt ticket is granted before a waiting Background ticket queued
  earlier.
- A waiting Prompt ticket isn't granted while a Foreground turn runs or waits
  in its lane.
- A `front` reservation beats a Prompt ticket.
- Prompt in one lane doesn't block another lane.

## Commit

`feat(inference): add a prompt priority between foreground and background`

## Rollback

Revert the commit. Nothing uses `prompt` until Phase 03, so this is safe to
leave in on its own.
