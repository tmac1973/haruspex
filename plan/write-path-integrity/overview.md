# Write-Path Integrity — Project Overview

## Problem

A file written by an LLM tool call can land on disk silently corrupted — as a
"middle slice" with both a prefix and a suffix missing — while the tool reports
`Wrote: <path>` and the job continues as if nothing happened. This was observed
in production: a guided-planning run wrote `phase-02` as a 1,170-byte fragment
starting mid-document at `### 9. Score panel` and cut off mid-CSS-property, where
a healthy file is ~18 KB. Commit `65a5aa7` added detection and recovery for that
symptom, but the mechanism that produces it was never fixed.

Static tracing of the code on `main` (`a03a4fa`) found the mechanism, and found
that a second, independent defect is manufacturing far more exposure to it than
anyone realised. The verifier's clean verdict can never be recognised for a
reasoning model, so every guided-planning run burns all three verify rounds and
coerces the model into rewriting files it has nothing to fix — each rewrite a
fresh opportunity for the corruption to fire. The harness is not merely failing
to catch corruption; it is generating the conditions for it on every run.

## Goals

- A truncated or ambiguous tool call **never** results in a write. It fails
  loudly and retryably instead.
- A failed write **never** destroys the previously-good file on disk.
- The guided-planning verifier's `PLAN OK` verdict is recognised, so a clean plan
  ends verification in one round instead of three.
- The file-write token ceiling is large enough for real documents (32 KB default)
  and tunable by the user without a rebuild.
- Every defect fixed here is covered by a regression test that fails against
  today's code.
- Existing tool-calling behaviour for models that emit the loose `<function=`
  grammar is preserved exactly — zero regression risk for working models.

## Non-goals

- **Content recovery.** We do not attempt to continue, reassemble, or repair a
  truncated generation. Rejection is the whole strategy; recovery machinery is a
  possible later project once rejection makes the failure rate measurable.
- **Verification speed work beyond the verdict fix.** Fresh contexts per phase, a
  "verification lite" mode, and a skip-verification checkbox
  (`plan/futures.md` #3) are deferred to a separate project informed by measured
  numbers, not guesses.
- **Per-job and per-phase model selection** (`plan/futures.md` #1, #2, #7).
- **The outline-approval modal's presentation** (`plan/futures.md` #4).
- **Auditing other job types for context accumulation.** Only the guided-planning
  pipeline is touched here.
- **Changing the main chat UI's reasoning display.** The shell tab's rendering is
  verified as unaffected, not redesigned.

## Users & primary flow

The user is the operator of a local Haruspex install running a long agent job —
principally guided planning — against a local reasoning model (Qwen 3.6 27B is
the observed case).

The end-to-end flow this work protects:

1. The user starts a guided-planning job and approves an outline.
2. The Planning step writes one `phase-NN-*.md` file per phase via
   `fs_write_text`. Files are 13–20 KB; the model emits long `<think>` blocks
   before any content.
3. If a generation is cut short by the token ceiling, the call is **rejected with
   a clear error** and the loop retries — rather than being salvaged into a
   fragment and written.
4. The Verification step reviews the files and replies `PLAN OK`. The pipeline
   **recognises** that verdict and ends verification immediately.
5. If the verifier does find real problems, the revise turn runs — and the
   file-write nudge only fires when the file genuinely does not exist on disk.
6. The user is presented with a complete, uncorrupted plan.

## Constraints

- **Stack:** Tauri 2.x + SvelteKit 5 (Svelte 5 runes, TypeScript, static adapter)
  + Rust. Changes span four layers: the parser (`src/lib/agent/parser.ts`), the
  agent loop (`src/lib/agent/loop/iteration.ts`), the TS tool layer
  (`src/lib/agent/tools/fs-write.ts`), and the Rust fs layer
  (`src-tauri/src/fs_tools/`). Dependency ordering between phases matters.
- **The loose `<function=` grammar is load-bearing.** `parser.test.ts:215` and
  `:228` encode real emissions with no closing tags
  (`<function=email_summarize_message> <parameter=accountId> abc-123 …`). Making
  the grammar strict for everyone would break working tool calling for models
  that rely on it. Any tightening must be conditional on `finish_reason`.
- **`finalizeStreamText` has exactly one caller** (`runEphemeralTurn.ts:113`), and
  its output reaches guided-planning notes (`pipeline.ts:412`, `:597`),
  autonomous-coding summaries (`autonomous-coding/pipeline.ts:427`, `:438`), and
  the shell tab's assistant message (`shell.svelte.ts:525`). The main chat UI does
  not use it.
- **Tool calls are never streamed.** They come from a non-streaming
  `await response.json()` (`api.ts:619`, `:650`); `ToolCallDelta` has no consumer.
  There is no SSE accumulator to fix, and SSE line buffering is already correct.
- **Testing:** tests co-located as `foo.test.ts`, run via `npm run test`
  (vitest); Rust via `cargo test` from `src-tauri/`. Gates are `npm run check`,
  `npm run lint`, `npm run format:check`, `cargo clippy`, `cargo fmt -- --check`.
- **Formatting:** tabs, single quotes, no trailing commas (Prettier); Rust 4-space
  indent, 100-char width.

## Success criteria

- A generation cut off by the token ceiling produces **no file on disk** and a
  visible error, verified by a regression test that reproduces the truncated
  `<function=` payload from the real incident.
- All existing `parser.test.ts` cases still pass unchanged, including the
  unclosed-tag fallbacks at `:215`, `:228`, `:250` and `:262`.
- A verifier reply of `<think>…</think>\n\nPLAN OK` is recognised as clean by
  `isPlanClean`, verified by a unit test.
- A guided-planning run against a reasoning model whose plan is **already clean**
  ends verification after one round — i.e. `PLAN OK` is recognised the first time
  it is emitted, rather than being missed so every `MAX_VERIFY_ROUNDS` is burned.
  A run that finds real problems is expected to take two rounds (find, revise,
  re-verify clean); rewriting an incongruous phase file is the revise path
  working as designed, not a defect.
- The verifier's account of what it changed matches what changed on disk. The
  failure this catches is a *contradiction* — run 19 rewrote all five phase files
  during Verification while its `review-summary.md` claimed "No files were
  modified" — not the mere fact that a file was rewritten.
- A second `fs_write_text` to the same path within one turn returns an error, not
  a success — verified by a test.
- A write that fails partway leaves the original file byte-identical, verified by
  a Rust test.
- `phaseFileProblem` rejects a file whose tail is missing, verified against a
  truncated fixture.
- Settings → Inference exposes both token ceilings; the file-write ceiling
  defaults to 32768 and the base to 8192, and existing installs migrate without
  losing settings.

## Decisions

- **Failure strategy when content can't be trusted** → Fail loudly, never guess.
  Reject the call, surface a clear error, let the agent loop retry. Correctness
  over completion.
- **The 8192-token cap** → Raise it for file-output turns *and* make it tunable:
  two independent settings in Settings → Inference — base (default 8192) and
  file-writing turns (default 32768). `iteration.ts` picks per-turn via
  `expectsFileOutput`.
- **The `<function=` fallback parser** → Gate on `finish_reason`. Keep the loose
  grammar exactly as-is when `finish_reason === 'stop'`; reject the fallback
  entirely when `finish_reason === 'length'`. Zero regression risk for working
  models.
- **Duplicate `<parameter=key>` in the fallback** → Reject the call as ambiguous
  rather than silently keeping the last value or guessing at concatenation.
- **Repeat writes to the same path within one turn** → Reject with guidance,
  telling the model to send complete content in a single call or use
  `fs_edit_text`.
- **Atomic writes** → Temp file + rename across all three write paths
  (`write_bytes_to_workdir`, `fs_write_text_absolute`, `edit_text_at`). Sibling
  temp file so the rename is same-filesystem and atomic. No `fsync` — the threat
  is a failed write destroying a good file, not power loss.
- **Verdict parsing (`isPlanClean` never matches)** → Strip `<think>` blocks in
  `finalizeStreamText` so every `finalText` consumer gets visible text, rather
  than patching the single call site.
- **Scope of futures.md #3 (verification speed)** → Correctness only. Ship the
  verdict fix and corruption hardening, then re-run and measure before doing any
  further speed work.
- **`phaseFileProblem` suffix blindness** → Read the full file (drop
  `limit: 1000`) and require the final templated section (`## Rollback`). The
  phase template is pipeline-authored, so this is a contract we control — unlike
  the free-form heading matchers `65a5aa7` correctly avoided.
