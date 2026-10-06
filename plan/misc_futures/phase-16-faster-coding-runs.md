# Phase 16 — Faster coding runs

Depends on: 12 (per-turn telemetry, to measure before and after) / Enables: —

## Goal

An autonomous coding run on a mid-sized plan finishes in hours, not days.

**What prompted it.** Run 99 on 2026-10-05 was cancelled at step 06 of 95, after more than
6 hours. It was a chained guided-planning → assets → coding run, "dark_times_4", Rust and
Bevy, with 12 phases and 243 KB of phase files. The model was Qwen3.8-Flash-Next on the
user's vLLM (compute:3000), with reasoning on.
- Preflight took 56 minutes, and 92% of its output was reasoning.
- Phase 01 took about 3 hours.
- Decode ran at about 60 tok/s, single-stream. Reasoning was 75–92% of every stage's
  output tokens.
- `cargo test --workspace` compiled Bevy from scratch at each phase gate.
- The model's own `run_command` calls fall back to `codeRunCommandTimeoutSecs` (30 s by
  default). A Bevy build doesn't finish in 30 s, so the model retries, backgrounds or works
  around it, and pays for each attempt in reasoning.
- The server allows 16 concurrent sequences. The loop uses one.

At that rate, 95 steps is more than four days. The model is not slow; the run spends its
tokens in the wrong places.

## The facts this rests on

Checked against the code on 2026-10-05:
- **Reasoning is fixed per turn.** `LoopContext.thinkingEnabled` (`loop/iteration.ts`) is set
  once from the job's reasoning mode (`jobTurnPolicy`, `runner.svelte.ts`). Every call in the
  turn sends the same `chat_template_kwargs`. That includes a follow-up whose only job is to
  read a tool result and choose the next tool. The max-iterations final synthesis is already
  the one exception: it forces reasoning off.
- **The model's command timeout is the chat one.** `run_command` (`agent/tools/code.ts`)
  uses `args.timeout_secs` when the model passes one, else the Settings → Shell value. The
  runner's own phase verification uses `VERIFY_TIMEOUT_SECS = 600` (`autonomous-coding/pipeline.ts`).
- **Preflight is the same 80-iteration turn whether or not anyone is there.** A chained run
  is non-interactive (`trigger === 'chained'`), but still re-reads the whole plan to settle
  the verification contract. Guided planning already settled it, and wrote it to
  `DECISIONS-coding.md`.
- **Guided planning never estimates cost.** Nothing tells the user that 95 steps with
  reasoning on is days of compute before they start.

## Part A — measure first: the model benchmark

Before changing code, run the same plan four ways. Then each lever below can be judged
against a baseline, not a guess. Bronze Liver (`~/Projects/bronze-liver`: three phases,
21 steps, Python, stdlib only) is the plan. Run 96 built it with Flash-Next and the job's
reasoning on "inherit": 148 tests passed, and the walkthrough won 110/110.

| Job | Folder | Model | Reasoning |
| --- | --- | --- | --- |
| baseline | (run 96) | Qwen3.8-Flash-Next | inherit (on) |
| flash-low | `bronze-liver-bench-flash-low` | Qwen3.8-Flash-Next | low effort |
| flash-off | `bronze-liver-bench-flash-off` | Qwen3.8-Flash-Next | off |
| thinking-cap | `bronze-liver-bench-thinking-cap` | Thinking Cap (Qwen 3.8 27B) | inherit |
| swift | `bronze-liver-bench-swift` | Swift (Qwen 3.8 27B) | inherit |

Every other setting copies job 24 ("bronze liver"). For each run, record from the DB:
- wall minutes;
- output tokens and the reasoning share;
- repair attempts;
- whether the build gate passed;
- the test count;
- whether the walkthrough wins.

Write the results to `measurements-phase-16.md`.

**What the table decides.**
- If flash-off passes with few repairs, adaptive reasoning (Part B) is worth less than
  just defaulting coding jobs to reasoning off.
- A 27B dense model decodes slower per token than Flash's MoE. It wins only if it writes
  far fewer tokens per step.

## Part B — adaptive reasoning in coding turns

The model reasons when a decision is hard, and acts without reasoning when the next move is
mechanical.

### Files touched

- `src/lib/agent/loop/iteration.ts`: a per-call reasoning decision replaces the per-turn
  constant.
- `src/lib/agent/jobs/runner.svelte.ts`: a new job reasoning mode, `adaptive`.
- `src/lib/components/jobs/JobModelFields.svelte`: the option.
- `src/lib/agent/jobs/types/autonomous-coding/config.ts`: `adaptive` is the default for new
  coding jobs.

### Steps

1. **A call-level policy.** `LoopContext` gains
   `reasoningPolicy: 'fixed' | 'adaptive'`. Under `adaptive`, a call reasons when any of
   these holds:
   - it is the first call of the turn;
   - the previous tool result was an error;
   - the previous tool result was a `run_command` that exited non-zero;
   - three calls in a row have gone without reasoning (a floor, so a long mechanical
     stretch still gets a look).

   Otherwise reasoning is off for that call. The decision goes through the existing
   `getChatTemplateKwargs` / `getOpenRouterReasoningParam` paths, as a per-call argument,
   not a context mutation.
2. **Prefix caching.** Turning reasoning off changes `chat_template_kwargs`, not the
   message prefix, so vLLM's prefix cache still hits. Confirm that on compute:3000 from the
   server's prefix-cache hit rate, before and after.
3. **Telemetry.** Each step records how many of its calls reasoned (in the
   `ContextManagedInfo` beside `trim_events`), so the run history shows the policy working.
4. **Where it applies.** It is the default only for autonomous coding. Chat, research and
   guided planning keep their fixed setting; the option is there for any job.

### Tests

- A unit test on the policy: first call → on; a clean tool result → off; an error or a
  non-zero exit → on; four mechanical calls → the fourth is on.
- A fake-LLM e2e scenario (`e2e/fake-llm`) that asserts on `enable_thinking` in each
  request of a write-then-test turn.

## Part C — builds that don't time out or start from cold

### Files touched

- `src/lib/agent/tools/code.ts`: a job-turn default timeout.
- `src/lib/agent/jobs/runner.svelte.ts`: `jobTurnPolicy` carries it.
- `src/lib/agent/jobs/types/autonomous-coding/prompts.ts` and the guided-planning
  prompts: build-speed guidance.

### Steps

1. **A long default timeout in job turns.** `run_command` in an unattended job turn falls
   back to 600 s, the runner's `VERIFY_TIMEOUT_SECS`, not to Settings → Shell. Chat keeps
   the user's setting. The tool description tells the model the default, so it stops
   backgrounding builds to dodge a 30-second limit.
2. **Phase gates scoped to what the phase touched.** Guided planning writes each phase's
   build gate for that phase's crate or package (`cargo test -p <crate>`,
   `npm test -- <dir>`). The full-workspace command stays as the final gate, in
   `DECISIONS-coding.md`. Preflight checks that each phase gate runs.
3. **Build-speed guidance, for Rust and Bevy only.** When the plan names Bevy, guided
   planning adds the standard dev settings to phase 01:
   - `bevy/dynamic_linking` behind a `dev` feature;
   - `opt-level = 1` for the workspace, `3` for dependencies;
   - a faster linker (`mold` on Linux, `lld` elsewhere), only if it is installed. Preflight
     checks.

   Nothing else gets per-ecosystem advice in this phase.
4. **A shared target directory across a chain's retries.** Already true: the run builds in
   the project folder. Check that nothing cleans `target/` between phases.

### Tests

- `code.test.ts`: a job-turn call without `timeout_secs` gets 600; a chat call gets the
  setting.
- Prompt snapshot tests for the scoped gate and the Bevy block.

## Part D — the plan says what it will cost

### Files touched

- `src/lib/agent/jobs/types/guided-planning/pipeline.ts`: an estimate at the outline
  approval.
- `src/lib/components/jobs/` (the outline approval): the estimate, and an "MVP first"
  choice.

### Steps

1. **An estimate.** At the outline approval, show the steps, the phases, and an estimated
   run time. The time is the step count × the median minutes per step of this model's past
   coding runs, from run history. With no history, it shows only the step count. One line:
   "95 steps, about 40 hours on this model." The method goes in a tooltip.
2. **MVP first.** A choice at the approval: "Plan an MVP first". It asks the planner to cut
   the outline to the smallest playable or usable slice (target: a third of the steps or
   fewer), and puts the rest in `plan/later.md` as unplanned headings. The coding run builds
   only the MVP; the rest is a follow-up planning run.
3. **A soft cap.** Above 60 steps, the approval shows the estimate in the warning colour.
   Nothing is blocked.

### Tests

- The estimate from a seeded run history; no history → step count only.
- The MVP prompt path, in a fake-LLM e2e: the outline shrinks, and `plan/later.md` is
  written.

## Part E — a lighter preflight for chained runs

### Files touched

- `src/lib/agent/jobs/types/autonomous-coding/pipeline.ts`
- `src/lib/agent/jobs/types/autonomous-coding/prompts.ts`

### Steps

1. **Chained runs trust the planner's contract.** When `trigger === 'chained'` and
   `DECISIONS-coding.md` already has a `## Verification command`, preflight is a short
   check, not an interview:
   - run the verification command once;
   - run each phase gate's first command once, with `--no-run` or the equivalent where the
     ecosystem has one;
   - check that the plan files parse;
   - submit.

   The cap is 15 iterations and reasoning is off; an error turns it back on (Part B's
   policy).
2. **A failing check falls back to the full preflight.** It doesn't fail the run.
3. **Interactive runs are unchanged.** A person is there, so the interview is worth the
   time.

### Tests

- `pipeline.test.ts`: chained with a contract → the short path; chained without one → the
  full path; a failing check → the full path.

## Part F — a graphical project proves it draws something

**What prompted it.** dark_times_5 (Go and Ebitengine) finished all 10 phases
with green tests and opened to a black window. The UI font was built with
`opentype.FaceOptions{Size: 12}` and no `DPI`. `golang.org/x/image` reads a
DPI of 0 as a scale of 0, so every glyph had zero size, and the opening
screen is all text. The map drew correctly. Nothing in the run looked at a
frame: the game's `-headless` flag draws a frame but never reads it back, so
"drew a frame" passed with a blank screen.

**The check that found it** (2026-10-05, by hand): run the real game loop for
90 frames and read the screen back at frames 20 and 80. Before the fix, the
creation screen had 0 of 666,624 pixels that weren't black. After it, 10,004
were. About 40 lines of Go.

### Files touched

- `src/lib/agent/jobs/types/guided-planning/pipeline.ts`: the planning
  prompt's verification step, and phase 01 of a graphical plan.
- `src/lib/agent/jobs/types/autonomous-coding/prompts.ts`: preflight and the
  phase prompt.

### Steps

1. **Guided planning recognises a graphical project.** A game engine (Ebiten,
   Bevy, Pygame, raylib, SDL, Godot export, a canvas or WebGL app) or a GUI
   toolkit makes it graphical. The plan's phase 01 then includes a frame
   smoke test, and the verification command runs it:
   - start the real render loop, not a headless stand-in;
   - draw a fixed number of frames of each screen the game opens on, then the
     first in-play frame;
   - read the pixels back;
   - fail when a frame is a single colour, or fewer than 0.5% of its pixels
     differ from the background;
   - exit by itself.

   Name the screens it checks, so a later phase that adds a screen adds it to
   the test.
2. **What it looks like per stack,** given to the planner as examples, one line
   each:
   - Ebiten: `RunGame` with a wrapper whose `Update` returns
     `ebiten.Termination` after N frames and whose `Draw` calls
     `ReadPixels`;
   - Bevy: a system that requests a `Screenshot` and exits;
   - Pygame: `pygame.display.flip`, then `surfarray`;
   - a browser canvas: a headless browser reading back `getImageData`.
3. **It needs a display.** The test reads `DISPLAY` or `WAYLAND_DISPLAY`. Without
   one it fails with "no display — run under xvfb-run", rather than passing
   by skipping. Preflight checks that the verification command can open a
   window here (it can on the user's desktop), and records `xvfb-run` in the
   command when there is no display.
4. **Preflight enforces it.** For a graphical plan whose verification command
   runs no frame check, preflight writes one into DECISIONS-coding.md as an
   open finding, and the phase that sets up rendering builds it.
5. **The phase prompt says what a pass means.** A green build of a graphical
   project is not evidence that anything is visible. When a phase changes
   rendering, fonts, the camera or a screen, the frame test must still pass,
   and the phase's own test adds the screen it introduced.

### Tests

- Prompt snapshots: a plan naming Ebitengine gets the frame-test step; a CLI
  plan doesn't.
- Preflight: a graphical plan with `go test ./...` as its only verification
  gets the open finding.
- Live: re-run the dark_times_5 plan, with the font bug put back, to its
  rendering phase. The frame test fails, naming the creation screen.

## Not in this phase

**Parallel steps.** The server has 15 idle sequences, and independent phases (assets vs.
engine, separate crates) could run at once in separate worktrees, merged at the phase gate.
It is the largest speed-up on paper and the largest change: merge conflicts, two runs sharing
one `target/`, and a progress view that shows more than one step. Revisit after Parts B–E
and the benchmark, if runs are still too slow.

## Build gate

The repo's, as in the overview. Plus `npm run e2e:ui` for the new fake-LLM scenarios.

## Test plan

1. Re-run the benchmark rows for whichever model wins Part A, with Parts B–E in place. Add
   the results to `measurements-phase-16.md`.
2. Re-run a chained Rust + Bevy plan (dark_times_4 cut to its MVP) to its first two phase
   gates. Compare minutes per step with run 99.

## Commits

One per part: `docs(plan): phase 16 benchmark results`,
`feat(jobs): adaptive reasoning for coding turns`,
`feat(jobs): job-length command timeouts and scoped phase gates`,
`feat(planning): run-time estimate and MVP-first`,
`feat(jobs): a short preflight for chained coding runs`,
`feat(planning): a frame smoke test for graphical projects`.

## Rollback

Each part reverts on its own. Part F is prompt text only. Part B's mode is a new enum value, so its config parser must
map an unknown mode to `inherit`; then a job saved with `adaptive` still loads after a
revert.
