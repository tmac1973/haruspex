# Phase 06 — Suffix-Aware Phase Gate and an Honest File-Write Nudge

**Depends on:** nothing (touches only artifacts already on `main`; Step 6's
rationale references Phase 01 but requires nothing from it) · **Enables:**
nothing downstream; final defence-in-depth layer

## Goal

Two loose ends in the guided-planning layer. First, `phaseFileProblem`
(`pipeline.ts:310-325`) reads only the first 1000 lines (`pipeline.ts:441-452`)
and checks only a minimum length, a `/^#\s/` first line, and a "Depends on"
match — so a file missing its **entire tail** passes the gate identically to a
complete one. It catches prefix loss only; it caught the original incident purely
because that fragment lost its prefix too. Second, the file-write nudge
(`iteration.ts:853-861`) tells the model *"the file you are describing does not
exist on disk"* — something the code never checked, and which is false whenever a
revise turn correctly concludes nothing needs changing. This phase closes both.

## Files touched

- `src/lib/agent/jobs/types/guided-planning/pipeline.ts` — full-file read and a
  closing-section check in `phaseFileProblem`.
- `src/lib/agent/loop/iteration.ts` — reword the nudge at lines 853-861.
- `src/lib/agent/jobs/types/guided-planning/pipeline.test.ts` — tail-truncation
  cases.

## Steps

1. In the phase-file read (`pipeline.ts:441-452`), drop `limit: 1000` so the
   whole file is available to the gate. A defect past line 1000 is currently
   invisible; phase files run 13-20 KB and are well within the read path's
   existing size cap.
2. In `phaseFileProblem` (lines 310-325), add a fourth check: the file must
   contain the final templated section, matched as `/^##\s+rollback/mi`. Return a
   problem description in the same style as the existing checks, e.g.
   *"file appears truncated — no '## Rollback' section found"*, so
   `ensureWritten`'s bounded retry can target the actual defect.
3. Keep the existing three checks unchanged. The new check is safe precisely
   because `## Rollback` is the **last** section of a template the pipeline
   itself authors (`references/templates.md`, mirrored by `phaseWritePrompt`) —
   unlike the free-form `/^##\s+steps/`-style matchers that commit `65a5aa7`
   deliberately rejected, which tried to guess at headings the model chooses. Add
   a comment saying so, so the distinction is not lost to a future reader.
4. Re-validate the gate against real output before trusting it, exactly as
   `65a5aa7` did: run it over the 5 phase files in
   `/home/tim/Projects/hangman/plan/test-plan/`. All 5 must pass. If any healthy
   file fails, the matcher is too strict — fix the matcher, do not relax the
   file.
5. Reword the nudge at `iteration.ts:853-861`. Remove the false claim about disk
   state, and permit the legitimate no-op:
   *"You have not emitted an fs_write_* tool call this turn. If the file needs
   writing or changing, emit that call now with the complete content as the
   `content` argument and a short relative path. If the file is already correct
   and needs no change, say so directly instead of describing a write."*
   Keep the existing tool-name list (`fs_write_text` for markdown/plain text,
   `fs_write_pdf` / `fs_write_docx` / `fs_write_xlsx` for binary documents) — that
   guidance is accurate and useful.
6. Do **not** add a machine-matched sentinel such as `NO CHANGES NEEDED`. This
   pipeline just broke on magic-string matching (`PLAN OK` vs `<think>`, Phase
   01); a second sentinel would reintroduce the same class of bug. The reword
   alone is sufficient because the nudge is bounded at
   `MAX_FILE_WRITE_RETRIES = 2` (`nudges.ts:34`) and then simply stops.
7. Leave the nudge's firing **condition** unchanged. It is already narrow: it
   runs only inside the zero-tool-calls branch (`iteration.ts:661-667`), so
   investigation turns full of greps and reads never reach it, and it additionally
   requires `expectsFileOutput`, no file written yet this turn, a non-clarifying
   response, and an unexhausted counter (`nudges.ts:100`). The defect was the
   message text, not the trigger.

## Build gate

```bash
npm run check
npm run lint
npm run format:check
npm run test
```

## Test plan

Automated:

- A complete phase file passes `phaseFileProblem` — assert against all 5 real
  files from the hangman run, as `65a5aa7`'s test does.
- A phase file truncated **after** `## Test plan` (no `## Rollback`) is rejected
  with a truncation-specific problem description. This is the regression test: it
  fails against current `main`, where the tail-truncated file passes the gate.
- The original 1,170-byte corrupt fragment is still rejected, and still by the
  heading check — the existing case from `65a5aa7` must keep passing unchanged.
- A file with `## Rollback` present but lowercase / extra spacing still passes,
  proving the matcher's case- and whitespace-insensitivity.
- The overview file's existence-only check is untouched — it has no fixed section
  contract and must not be subjected to the phase gate.

Manual:

- Run a full guided-planning job. Confirm all phase files pass the gate first
  time with no `ensureWritten` retries — visible as a single write per phase in
  the debug log, and as phase-file mtimes that do not move after their Planning
  write.

## Commit

```
fix(guided-planning): catch tail-truncated phase files, drop the false nudge

phaseFileProblem read only the first 1000 lines and checked a size floor, a
top-level heading and a "Depends on" line — so a file missing its entire
tail passed identically to a complete one. It caught the original incident
only because that fragment lost its prefix too. Read the full file and
require the final templated section (## Rollback), which is safe to assert
because the pipeline authors that template.

Also reword the file-write nudge, which told the model "the file you are
describing does not exist on disk" — something the code never checked, and
false whenever a revise turn correctly finds nothing to change. It now
permits saying so instead. The firing condition is unchanged; it was
already narrow.
```

## Rollback

Revert the commit. Both changes are self-contained — a gate predicate and a
prompt string — with no signature or schema effects, and reverting restores the
prior (weaker) gate and the prior wording. Safe to leave partially applied: the
nudge reword and the gate change are independent and can be reverted separately.
