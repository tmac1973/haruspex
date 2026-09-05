# Autonomous Coding — Phase-Level Verification

## Problem

Verification runs after **every** checklist item. Its cost is therefore
multiplied by the item count, and the item count is both large and unstable —
two runs over a byte-identical plan produced 25 and 43 items. In the observed
run the model was maintaining a 271-line validator against a 93-line program,
re-reading, re-editing and re-running it on every step. The user cancelled it.

The unit of verification is wrong. A checklist item is "one sitting of work,
committable on its own" — far too small to be worth proving in isolation.
Re-proving 25 times that the word list has 300 words is waste. A *phase* is the
natural unit: it is what the plan author already treats as an increment, and it
is where "does this actually work" becomes a meaningful question.

The plan usually already carries that structure. Guided planning emits a fixed
template (`# Phase NN — Title`, `## Steps`, numbered items), so phases are
available for free — 54 numbered steps across five phases in the sample. But
autonomous coding must also accept a hand-written document with no phases at
all, so grouping cannot be assumed; it has to be established at the start of
the run.

## Goals

- Deep verification runs **once per phase**, not once per item.
- A run against a guided-planning plan reuses the plan's own phases and steps
  rather than re-deriving them, so the checklist is reproducible run to run.
- A run against unstructured input still works: the run establishes phases
  itself before the loop starts.
- A phase that fails verification gets a real chance to be repaired, bounded, and
  without re-running work that already landed and committed.
- The morning report distinguishes "phase verified" from "steps landed but the
  phase never passed".

## Non-goals

- **Merging the guided-planning and autonomous-coding jobs.** Considered and
  rejected: the same plan gets coded more than once (the sample plan was run
  twice), and a merged job would mean re-running a 40-minute planning interview
  to re-code. The two stay separate and composable.
- **Changing per-step commits.** One commit per item is the run's most valuable
  artifact and stays exactly as it is. Only the *verification* cadence moves.
- **Changing the guided-planning output format.** Coding adapts to the template
  that already exists; planning is not modified.
- **Retrying a whole phase.** Steps are not idempotent; re-running eleven landed
  steps risks destroying good work.

## Users & primary flow

1. The user points an autonomous-coding job at a plan directory and starts it.
2. **Preflight** settles open decisions and the verification contract, as today.
3. **Decompose** now produces a *grouped* checklist:
   - Plan files matching the guided-planning template are parsed directly —
     phases and their numbered steps become phases and items, deterministically,
     with no model judgment involved.
   - Anything else is decomposed by the model as today, and additionally grouped
     into phases so verification has boundaries.
4. **The loop** works items in order, committing each, exactly as today. No deep
   verification per item.
5. **At a phase boundary** — the last item of a phase completing — the run
   executes the phase verification command once.
   - Pass: the phase is marked verified and the loop continues.
   - Fail: a **repair item** is injected carrying the failure output, worked with
     a single attempt, then verification runs again. Up to `MAX_PHASE_REPAIR_CYCLES`
     (5) cycles, after which the phase is BLOCKED and the loop moves on to
     phases that do not depend on it.
6. **Finalize** reports per phase: verified, blocked, or never reached.

## Constraints

- `loopState.ts` has **no phase concept**: a flat `TaskItem[]` with per-item
  `attempts` and a three-strikes→BLOCKED rule, round-tripped through
  `TODO-coding.md`. Phases, phase status, and repair-cycle counts all have to
  survive that round trip, because it is the resume path — the plan dir, not the
  DB, carries loop state.
- The checklist is currently **fixed** once decompose produces it. Repair items
  mean the list can grow mid-run, which `parseTodoMarkdown`, `renderTodoMarkdown`
  and the resume logic must all tolerate.
- Item ids are runner-assigned positions (`"01"`, `"02"`). Injected repair items
  need ids that do not collide and do not renumber existing items (a renumber
  would break the PROGRESS notes and the commit messages that reference them).
- The loop consumes a single verification command string. Two-tier checking
  needs a second, cheaper command — see the open question below.
- Stack: SvelteKit 5 runes + TS, tests co-located, vitest.

## Success criteria

- A run against the sample hangman plan produces a checklist whose phases and
  items match the plan's own structure, and produces the **same** checklist when
  run twice.
- Deep verification executes once per phase — 5 times for the sample plan, not
  25 or 43.
- A run against a plan directory containing a single unstructured document still
  produces phases and completes.
- An induced phase failure produces a repair item, re-verifies after it, and
  blocks the phase after 5 cycles rather than looping forever.
- `TODO-coding.md` written by a phase-aware run parses back with phases, phase
  status and repair counts intact — verified by a round-trip test.
- A run interrupted mid-phase resumes without re-running committed steps.
- The report names each phase's verification outcome.

## Decisions

- **Verification unit** → the phase, not the item. Per-item deep verification is
  the cost being removed.
- **Where phases come from** → parsed from the guided-planning template when the
  input matches it (deterministic, reproducible, no model turn); established by
  the model otherwise.
- **Phase verification failure** → inject a repair item carrying the failure
  output, rather than blaming the last item or blocking immediately. Blaming the
  last step misattributes when the breakage came from eight steps earlier;
  blocking immediately gives up without trying.
- **Repair budget** → up to 5 repair *cycles* per phase, each cycle being one
  repair item followed by a fresh verification run. Each repair item gets a
  single attempt, because the cycle is the retry mechanism — giving repair items
  the normal three attempts would allow 15 repair iterations per phase.
- **Job structure** → two separate jobs, unchanged. See Non-goals.

## Open question — carried into Phase 1

The loop consumes **one** verification command. Moving deep verification to
phase boundaries leaves each individual step unverified, so a syntactically
broken file can be committed mid-phase and only be caught at the end of the
phase, several commits later.

The likely answer is a second, cheap per-step check (`node --check`,
`tsc --noEmit`, `cargo check`) recorded alongside the phase command — near-zero
cost, and it preserves the property that a commit is never broken on its face.
That means preflight records **two** commands rather than one, and the Editor
field needs to reflect that.

Deliberately not settled here: it is the first thing Phase 1 must resolve, and
it may turn out that the phase check alone is sufficient given that every commit
is individually revertable.

## Phase outline

1. **Phase-aware state model.** `TaskItem` gains a phase; add phase status and
   repair-cycle counts; extend the `TODO-coding.md` round trip; support injected
   items without renumbering. Pure `loopState.ts` + tests, no behaviour change
   yet — the riskiest part is the resume path, so it lands alone.
2. **Deterministic plan parsing.** Parse the guided-planning template into
   phases and items; fall back to model decomposition when it does not match.
3. **Phase boundaries in the loop.** Run deep verification when a phase's last
   item completes; report per-phase outcomes.
4. **Repair cycles.** Inject repair items on failure, re-verify, bound at 5,
   then BLOCKED.
5. **Two-command contract** (if Phase 1 concludes it is needed): preflight
   records a cheap step check and a deep phase check; Editor and prompts follow.
