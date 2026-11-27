# Phase 03 — Verifier finding severity

**Depends on:** nothing · **Enables:** Phase 05 (the chain gate reads this)

## Goal

Make the verifier's verdict machine-readable enough to answer one question: are
any of these findings the kind an unattended coding run could not survive? The
verifier already sorts findings into four categories but reports them as free
prose. This has it tag each bullet with the category letter it matched, and adds
a runner-side classifier. Useful on its own — the Verification stage can then
say "2 blocking, 1 advisory" instead of pasting a wall of text.

## Files touched

- `src/lib/agent/jobs/types/guided-planning/pipeline.ts` — `verifierPrompt` asks for a leading `(a)`–`(d)` tag on every bullet; new exported `classifyFindings(verdict)`; the VERIFY stage's summary reports the split.
- `src/lib/agent/jobs/types/guided-planning/pipeline.test.ts` — prompt assertion and classifier coverage.

## Steps

1. In `verifierPrompt`, change the reply instruction so each bullet begins with the matched category letter in parentheses, e.g. `- (a) plan/x/phase-02-api.md: depends on phase 03`. Keep the `PLAN OK` contract for a clean plan exactly as it is — `isPlanClean` depends on it.
2. Add `export function classifyFindings(verdict: string): { blocking: string[]; advisory: string[] }`. Split the verdict into bullet lines, read a leading `(x)` tag, and sort: `a` (ordering), `b` (deferred decisions) and `d` (contradictory/unreachable) are blocking; `c` (embedded code) is advisory.
3. Make the fail-safe explicit and commented: a bullet with no tag, or a tag outside `a`–`d`, counts as **blocking**. A verdict the runner cannot read must never be read as permission to proceed.
4. Return empty lists for a clean verdict, so callers can treat "clean" and "no blocking findings" the same way without special-casing.
5. Have the VERIFY stage's not-clean summary lead with the counts, then the verdict text, so the morning's triage starts with a number.
6. Write the tests listed under Test plan.

## Build gate

```
npm run check && npm run lint && npm run test && npm run format:check
```

## Test plan

- `verifierPrompt` contains the tagging instruction and a worked example of a tagged bullet.
- `classifyFindings` on a mixed verdict sorts `(a)`/`(b)`/`(d)` bullets to blocking and `(c)` to advisory.
- An untagged bullet lands in blocking; so does `(z)`.
- A `PLAN OK` verdict yields empty lists.
- Prose before or after the bullet list (models add preamble) does not produce phantom findings — only lines that are bullets are considered.
- A verdict of only `(c)` findings yields zero blocking, which is the case Phase 05 relies on to chain.

## Commit

`feat(jobs): classify guided-planning verification findings by severity`

## Rollback

Revert the commit. The verifier returns to untagged prose and the Verification
summary loses its counts; nothing else reads the classifier until Phase 05, so
reverting this alone is safe as long as Phase 05 is reverted too or not yet
landed.
