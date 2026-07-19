# Phase 03 — Token Ceilings for File Writes, Exposed in Settings

**Depends on:** Phase 02 (Step 7 rewrites the error message Phase 02 introduces)
· **Enables:** nothing downstream; completes Phase 02 by giving its hard-fail
message a real settings path to name

## Goal

`AGENT_LOOP_MAX_TOKENS = 8192` (`iteration.ts:54`) caps every agent turn's
output, and `runEphemeralTurn` never overrides it. An 18 KB markdown phase file
is roughly 4.5–5k tokens before JSON escaping, and the model's `<think>` block
spends the same budget first — which is why truncation is intermittent rather
than constant. Phase 02 makes truncation a loud failure; without this phase it
would simply become a loud *frequent* failure. This phase gives file-writing
turns a 32768-token ceiling and exposes both ceilings in Settings → Inference so
the user can tune them without a rebuild.

## Files touched

- `src/lib/stores/settings.ts` — two new fields on the settings interface (near
  `contextSize`, line 240) and their defaults (near line 448).
- `src/lib/agent/runEphemeralTurn.ts` — resolve the per-turn ceiling from
  `expectsFileOutput` plus settings, preserving the existing explicit override.
- `src/lib/agent/loop/iteration.ts` — update the Phase 02 hard-fail message to
  name the real setting and the effective value.
- `src/lib/components/settings/InferenceSection.svelte` — two number inputs.
- `src/lib/stores/settings.test.ts` — defaults and merge behaviour.
- `src/lib/agent/runEphemeralTurn.test.ts` — ceiling resolution precedence.

## Steps

1. In `settings.ts`, add to the settings interface beside `contextSize`
   (line 240):
   ```ts
   /** Max output tokens for a normal agent turn. */
   maxResponseTokens: number;
   /** Max output tokens for a turn whose job is to write a file. */
   maxResponseTokensFileWrite: number;
   ```
   Add defaults `maxResponseTokens: 8192` and
   `maxResponseTokensFileWrite: 32768` to the defaults object near line 448.
   Preserving 8192 as the base default keeps every non-file turn behaving
   exactly as it does today.
2. Confirm settings load merges unknown/missing keys against defaults, so
   existing installs pick up both fields without an explicit migration — the
   store already merges (see the `mergedInference` handling around line 516). Add
   a test asserting a settings blob saved *without* these keys loads with the
   defaults applied. If that test passes, no migration is needed and this step is
   done. If it fails, the fix is to apply the defaults at load time in the same
   merge site that already handles `mergedInference` — add the two fields to that
   merge rather than introducing a versioned migration framework, which this
   codebase does not have and which two additive numeric fields do not justify.
3. In `runEphemeralTurn.ts`, resolve the ceiling once and pass it into the loop
   options that already accept `maxResponseTokens` (consumed at
   `iteration.ts:156`):
   ```ts
   const settings = getSettings();
   const maxResponseTokens =
   	options.maxResponseTokens ??
   	(options.expectsFileOutput
   		? settings.maxResponseTokensFileWrite
   		: settings.maxResponseTokens);
   ```
   The `??` preserves `shell.svelte.ts:656`'s explicit `16384` override for code
   mode. Importing `getSettings` into the agent layer is already the established
   pattern (`system-prompt.ts:2`, `tools/code.ts:7`).
4. Keep `AGENT_LOOP_MAX_TOKENS = 8192` in `iteration.ts` as the final fallback at
   line 156 (`options.maxResponseTokens ?? AGENT_LOOP_MAX_TOKENS`) so any caller
   that bypasses `runEphemeralTurn` still gets a sane cap. It is now a floor of
   last resort, not the operative value — update its doc comment to say so.
5. Note the deliberate limitation: the ceiling is chosen from `expectsFileOutput`,
   which the guided-planning write turns set explicitly (`pipeline.ts:409`) and
   chat turns infer via `looksLikeFileOutputRequest`. A chat turn that writes a
   large file *without* tripping that heuristic keeps the base ceiling. That is
   acceptable — Phase 02 makes the resulting truncation loud and actionable
   rather than corrupting — and is recorded here so it is not mistaken for an
   oversight.
6. In `InferenceSection.svelte`, add two number inputs beside the existing
   context-size control, following that control's existing markup and binding
   idiom:
   - "Max response tokens" → `maxResponseTokens`
   - "Max response tokens (file writes)" → `maxResponseTokensFileWrite`
   Give each a short helper line: the first governs normal turns; the second
   applies when a turn's job is to write a file, and needs headroom because a
   reasoning model's thinking is spent from the same budget. Clamp both on commit
   to the range 512–131072 — an out-of-range entry is coerced to the nearest
   bound and the coerced value is what persists and is displayed, so a typo can
   never wedge every turn. Use `min`/`max` attributes on the inputs so the UI
   signals the range before the coercion happens.
7. Update the Phase 02 exhausted-retry error to interpolate the effective
   ceiling and name the exact settings path, e.g. *"Response exceeded the
   file-write token ceiling (32768 tokens). Raise Settings → Inference → Max
   response tokens (file writes)."*

## Build gate

```bash
npm run check
npm run lint
npm run format:check
npm run test
```

## Test plan

Automated:

- Defaults are `8192` / `32768`.
- A persisted settings object missing both keys loads with defaults applied and
  no other field lost — the migration-safety test.
- Ceiling resolution precedence: an explicit `options.maxResponseTokens` wins
  over both settings; with no explicit value, `expectsFileOutput: true` selects
  `maxResponseTokensFileWrite` and `false`/absent selects `maxResponseTokens`.
- The clamp coerces out-of-range input to the nearest bound: `0` persists as
  `512`, `999999` persists as `131072`, and an in-range value persists unchanged.

Manual:

- Settings → Inference shows both inputs, they persist across an app restart,
  and editing them takes effect on the next turn without a rebuild.
- Run a guided-planning job end to end and confirm phase files write complete at
  the new ceiling.
- Set the file-write ceiling to 512, run a phase write, and confirm the Phase 02
  hard-fail message appears naming the 512 value and the settings path — this
  verifies the two phases are wired together.

## Commit

```
feat(inference): separate, tunable token ceilings for file-writing turns

AGENT_LOOP_MAX_TOKENS capped every turn at 8192 and runEphemeralTurn never
overrode it. An 18KB phase file is ~5k tokens before JSON escaping, and a
reasoning model spends the same budget on <think> first — so file writes
were truncated intermittently.

File-writing turns (expectsFileOutput) now default to 32768; normal turns
keep 8192. Both are exposed in Settings → Inference. Explicit per-call
overrides still win, preserving shell code mode's 16384.
```

## Rollback

Revert the commit. The settings fields become unread — harmless, and the merge
behaviour means a persisted blob containing them loads fine against the reverted
build, so a user who downgrades loses the tuning but nothing else. Safe to leave
partially applied: adding the fields and defaults without wiring
`runEphemeralTurn` changes no behaviour. If only the UI is reverted, the defaults
still apply and only the tuning surface is lost.
