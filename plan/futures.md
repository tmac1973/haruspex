# Futures

Running list of things to address. Status annotations added 2026-07-19.

## Open

- When in jobs with a different model than the system settings the model and context size indicator in the top right corner show the model/context usage for the system settings, not the model used for the job. Ideally the indicator would change when viewing a running job to indicate the model/context for that running job, but change back to the system model/context when viewing the chat/shell tabs. Alternatively we could put that info in the job step card instead and just not show the model/context indicator in the upper right when on the jobs tab. This might be the more flexible option

- It would be nice to able to specify a different model for each phase of a job. I.E. do the planning with one model, verification with the next.

- In the guided planning job the step 2 outline approval modal presents a wall of text that the agent has written that is not very nice to look at. The font is a bit large, there's no visual breaks between the phases outlined. We should work on this.

- We may want to look at adding a second model selector for the shell tab in settings -> inference. The default could/should be to just use the main local model for everything, just as it is today, but we could offer an opt-in to select a different model (local, remote, or openrouter) for the shell tab. If the chat tab and the shell tab use different local models of course they would have to queue to use that model (wait for the other model to unload, then load then new one) Thoughts?

- The output of a guided planning job is in /home/tim/Projects/hangman/plan. Have a look and tell me what you think. It was produced by qwen3.6 27b. It won't be as good as something you would produce, so no need to nitpick, but broadly is it cohesive?
  - **Still open.** Those files were read repeatedly as test fixtures while building the
    write-path fixes, but never actually reviewed as a plan. There is now a second,
    larger sample too: `/home/tim/Projects/hangman2/plan/test-plan/` (158 KB vs 89 KB,
    and the run that produced it caught a real bug in its own phase 03 during
    verification).

## Partially done

- Audit all job types to make sure where it makes sense we are using new contexts as the inference slows down the longer the context is. The verification phase of the guided planning is taking hours for a small 6 phase plan, compared to 20 minutes for the planning step. It might take days for a larger plan. We need to make sure that we are doing everything we can to speed up verification. We might even consider an option for a "verification lite" phase or skipping verification entirely as a checkbox option.
  - **The verification slowness is largely fixed** (PR #187). It was mostly not model
    slowness: `isPlanClean` matched `startsWith('PLAN OK')` against text that still
    contained the model's `<think>` block, so a reasoning model's clean verdict could
    never be recognised. Every run burned all three verify rounds and fired a revise
    turn each round against files that were already correct.
  - Measured on the same job, before → after: **verification 41 min → 12 min**, total
    **65 min → 42 min**, while producing a *larger* plan (89 KB → 158 KB).
  - **Still open:** the context audit across other job types (research, audit,
    autonomous-coding), a "verification lite" mode, and a skip-verification checkbox.
    Deliberately deferred so they could be scoped against real numbers rather than
    against the 41-minute figure, which turned out to be mostly a bug.

## Done

- ~~I've had a few issues where during a guided planning job one of the plan files that had been written in step 3 and then was going through verification in step 4 seeming got corrupted. When read the plan file in question started with step 9, and everything that presumably had existing in the file before step 9 was gone. No idea how this happened, whether it was a fault of the llm or something else entirely, but lets audit the job and tooling to make sure it wasn't because of some truncation or something that was caused by our code.~~
  - **Fixed in PR #187** — and yes, it was our code, in three independent places.
    1. A generation cut off by the 8192-token ceiling left truncated JSON in the tool
       call. The parser silently discarded it and fell through to regex salvage, which
       rebuilt a plausible-looking call out of a fragment — duplicate `<parameter=>`
       keys overwrote each other (lost the prefix) and the unclosed-tag match ran to
       end of string (lost the suffix).
    2. A second write to the same path in one turn silently replaced the first and
       still reported success, so a chunked write kept only the last chunk.
    3. Writes were a bare `fs::write` (truncate-then-write), so a failed write
       destroyed the previously-good file.
  - Plan and full rationale: `plan/write-path-integrity/`.

## Notes

- **#1, #2 and the shell-tab selector are really one project.** All three are the same
  underlying change: model selection stops being a single global and becomes
  per-context — per-job, per-phase, per-tab. Built piecemeal they'd touch the same
  selector and queueing code three times over. Worth planning together even if shipped
  separately.
- **The outline modal is genuinely standalone and small.** Good filler work.
