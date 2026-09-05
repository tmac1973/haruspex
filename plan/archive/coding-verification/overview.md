# Autonomous Coding — Verification Contract & Run Hygiene

## Problem

An autonomous-coding run built a working single-file Hangman game (run 22, 126
minutes, 25 iterations, 25 clean commits). The app works. But the run's
verification behaviour and the state it left behind are both poor, and both trace
to the same root: **when the verify command field is blank, nothing establishes
what "verified" means, so every iteration invents it from scratch.**

`prompts.ts:93-97` branches on the field. With a command it says "Verify with
`<cmd>`… done ONLY when it passes." Without one it says *"Verify by your own
judgment: build it, run it, or test it — whatever proves this step actually
works. Unverified ≠ done."* That is an open-ended mandate with a hard obligation
attached and no constraints — no mention of reusing a harness, no prohibition on
scratch files, no cleanup. Combined with rule 1 ("Implement EXACTLY the one
checklist item"), each iteration is a fresh context that cannot know a harness
already exists, so it rebuilds one.

What that produced in run 22:

- **13 single-use `verify_*.js` files, ~2,200 lines, 92 KB** — roughly 1.5× the
  1,512-line product, each rebuilding the same jsdom scaffolding and canvas mock.
- **70 of 329 assertions (21%) are string matches against the source the model
  had just written** — e.g. `check('has win branch', source.includes("if
  (game.won)"))`. That is a tautology, not a test. `verify_09.js` is 22 of 31
  that way; `verify_18.js` is 19 of 53.
- **`node_modules` committed to git.** Of 2,220 tracked files, 2,194 are
  dependencies, 13 are scratch scripts, and exactly one is the product. No
  `.gitignore`. 5 MB of history for a single HTML file.
- The run report claims "**760+ automated verification checks passed**" and
  "Blocked items: None… zero failures" — accurate about the plan, silent about
  all of the above.

Timing supports the same reading. The coding loop was 109 of the 126 minutes, and
the per-step cost tracks harness-building rather than step size: steps 01–07
(engine) ran ~2.7 min/step, steps 14–20 (UI, where every `verify_*.js` appears)
ran ~6.7 min/step, steps 21–25 (CSS) ran ~2.6 min/step. Atomic decomposition is
not what cost the time — it took 3 minutes and produced the run's best artifact,
a legible ordered commit history. Per-step verification ceremony cost the time.

## Goals

- A run always has a **settled, concrete verification contract before the loop
  starts**, whether or not the user filled in the field.
- The user is never asked to fill a blank box they have no basis to answer. When
  they don't know, they are shown a proposal derived from their actual repo.
- Verification produces **one persistent artifact** the user can re-run, not N
  disposable scripts.
- **No assertion may pass by matching source text the same iteration wrote.**
- A run leaves the repo clean: no scratch files, no committed dependencies.
- Multi-language repos are supported without the user having to know the
  incantation.

## Non-goals

- **Changing the atomic decomposition.** 25 small steps producing 25 legible
  commits is the run's most valuable output and is cheap (3 minutes). This work
  does not touch step granularity.
- **Mandating a test framework.** Scaffolding is offered, never imposed — a
  single-file HTML project may legitimately want a syntax check and nothing more.
- **Per-file-path verify routing.** Considered and rejected for now: it needs a
  changed-files→command mapping in the loop. One composed command is the starting
  point; revisit if whole-suite runs prove too slow.
- **Retrofitting run 22's output.** The hangman repo is a sample, not something to
  repair.
- Any change to the guided-planning job, which is a separate pipeline.

## Users & primary flow

The user is configuring an autonomous-coding job against a repo, then walking
away. The flow this protects:

1. User creates the job. The verify command field is **optional and explained** —
   if they know their command they type it; if not, they leave it and are told
   preflight will work it out with them.
2. **Preflight** reads the plan, inspects the working directory, and detects the
   stack(s). If no command was supplied it composes one and asks the user to
   confirm via `ask_user_question` — with concrete options drawn from what it
   actually found, not generic suggestions.
3. If the repo has **no test infrastructure at all**, preflight offers a real
   choice: scaffold a minimal harness, syntax-check only, or model's judgment
   confined to one shared file.
4. The settled command is recorded in `DECISIONS-coding.md`, so it survives into
   the unattended run and is visible to the user afterwards.
5. **Each iteration runs that command.** It does not invent its own, does not
   create per-step scripts, and cannot claim "done" on a source-text match.
6. The run ends with the repo clean and one re-runnable verification artifact.

## Constraints

- **Preflight is the only point a human is available.** It already reads every
  plan file, grounds itself in the working directory, asks one question at a time
  via `ask_user_question`, and writes `DECISIONS-coding.md` — all the machinery
  needed is present.
- The loop consumes a single string (`cfg.verify_command`, threaded through
  `pipeline.ts:297` → `runIterationTurn` → `iterationPrompt`). Keeping the
  contract a single command means no change to that plumbing.
- Preflight cannot run shell commands to probe the stack unless it already has
  that tool; detection may have to be file-based (`package.json`, `Cargo.toml`,
  `pyproject.toml`, `go.mod`) — to be confirmed during implementation.
- Stack: SvelteKit 5 runes + TS. Job type lives in
  `src/lib/agent/jobs/types/autonomous-coding/` (`config.ts`, `definition.ts`,
  `prompts.ts`, `pipeline.ts`, `Editor.svelte`). Tests co-located, vitest.

## Success criteria

- A run started with a **blank** verify field reaches the coding loop with a
  concrete command recorded in `DECISIONS-coding.md`.
- A repeat of the hangman scenario produces **zero `verify_*.js` scratch files**
  and leaves no untracked or committed build artifacts.
- `node_modules` (or the language equivalent) is never committed; a `.gitignore`
  exists before the first commit.
- No assertion in the run's verification artifact matches source text written in
  the same iteration — spot-checkable by grepping the artifact for
  `source.includes` / `script.includes` patterns.
- The verification artifact is a single file the user can re-run after the run
  finishes, and it still passes.
- A multi-language repo (e.g. Haruspex itself) yields a single composed command
  covering every detected stack.
- The Editor field explains itself well enough that leaving it blank is an
  informed choice rather than a shrug.

## Decisions

- **Where the contract comes from when the field is blank** → Preflight
  establishes it. It inspects the repo, proposes a concrete command, confirms via
  `ask_user_question`, and records it in `DECISIONS-coding.md`. Chosen over
  static UI suggestions (no repo knowledge) and over merely constraining
  self-verification (every run would still reinvent its approach).
- **Multi-language repos** → Preflight composes a single command joining each
  detected stack with `&&`. The loop stays one command / one exit code and the
  field stays one text box. Accepted cost: the whole chain runs every step.
  Per-area routing was considered and deferred as a possible follow-up if that
  proves too slow.
- **Repos with no test infrastructure** → Preflight offers to scaffold a minimal
  harness, as an explicit choice alongside syntax-check-only and
  model's-judgment-in-one-shared-file. Not automatic: always scaffolding would
  impose a framework and dependencies on projects that don't want them, which is
  what put `node_modules` in the hangman repo.
- **Atomic decomposition** → unchanged. The time cost was verification ceremony,
  not step granularity.

## Phase outline

Dependency-ordered; each independently shippable.

1. **Ban tautological verification and per-step scratch files.** Rewrite the
   blank-field branch of `iterationPrompt`: one persistent artifact, no
   throwaway scripts, no assertion that matches source text the iteration wrote.
   Smallest diff, and it improves every existing job immediately — including runs
   that never get near preflight detection.
2. **Repo hygiene.** Ensure a `.gitignore` covering the detected stack exists
   before the first commit, and that the runner never commits dependency
   directories or scratch files.
3. **Stack detection + composed command in Preflight.** File-based detection,
   `&&` composition, `ask_user_question` confirmation, recorded in
   `DECISIONS-coding.md`.
4. **The no-test-infrastructure path.** Offer scaffold / syntax-only /
   shared-file-judgment, and make scaffolding a real step 0 when chosen.
5. **Editor field guidance.** Explain the field, give per-stack examples, and say
   plainly that blank is fine because preflight will settle it with you.
