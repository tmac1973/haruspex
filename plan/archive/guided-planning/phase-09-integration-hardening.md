# Phase 09 — Integration hardening + end-to-end verification

**Depends on:** all prior phases · **Enables:** ship.

## Goal

Validate and harden the full feature across its cross-cutting concerns —
resume-across-restart, scheduled/non-interactive degradation, the write
boundary, cancellation, and the chat exposure of the question tool — and fix
whatever the end-to-end runs surface. No new surface area; this is the pass that
turns "each phase works in isolation" into "the feature works together."

## Files touched

- Bug-fix edits across `runner.svelte.ts`, the stage drivers, the tool, and the
  modal as issues are found.
- **NEW** targeted tests:
  - `src/lib/stores/userQuestion.test.ts` — primitive resolve/reject semantics.
  - `src/lib/agent/jobs/guided-planning/verifier.test.ts` — verifier flags a
    seeded ordering violation and a seeded deferred decision.
  - A runner-level test (or harnessed) for milestone persistence/resume
    transitions if feasible without a live model.

## Implementation / checklist

Work the cross-cutting matrix and fix what breaks:

1. **Resume across restart** at every milestone: pre-overview, overview review
   checkpoint, mid-planning, dep-map checkpoint, mid-phase-writing. Each resumes
   to the right place; written files are never lost or duplicated; already-written
   phases are not re-asked.
2. **Non-interactive / scheduled run** invoking `ask_user_question` parks as
   `needs_input` (does not hang, does not guess), persists state, and resumes
   cleanly when opened in the foreground.
3. **Write boundary** holds under adversarial agent behavior: attempts to write
   outside the output dir, absolute paths, and `..` traversal are all rejected
   with recoverable tool errors; the agent never edits code.
4. **Cancellation** mid-question / mid-stage leaves consistent state (no
   half-written file that breaks resume; partial files are tolerated).
5. **Chat exposure:** `ask_user_question` works in normal chat and the model
   doesn't over-call it (tune the tool description / system guidance if it asks
   trivial questions; this is the place to calibrate).
6. **Verifier robustness:** confirm the loop converges and the iteration cap
   surfaces a clear message; confirm a clean plan passes in one verify pass.
7. **Privacy/branding:** the one-time hosted-provider concern is out of scope
   here (that's the separate providers feature) — but confirm nothing in this
   feature sends project contents anywhere except the configured model.

## Build gate

```bash
cargo check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
npm run check && npm run lint && npm run test
```

## Test plan

The checklist above is the test plan; each item is a manual or automated
scenario. Promote the deterministic ones (primitive semantics, verifier
detection, path-boundary rejection) to automated tests; the model-driven
end-to-end flows are manual smokes run once before shipping.

Final end-to-end smoke: from a real idea, run the whole flow on this very
repository, producing a fresh `plan/<slug>/` with an overview and a clean,
dependency-ordered phase set — i.e. reproduce, in-app, what this plan folder
demonstrates by hand.

## Commit

```
test(jobs): guided_planning integration hardening + e2e

Cross-cutting validation and fixes: resume-across-restart at every
milestone, non-interactive needs-input parking, write-boundary
enforcement, cancellation consistency, and chat over-asking calibration.
Adds primitive + verifier unit tests.
```

## Roll-back rule

This phase is fixes + tests; individual fixes revert independently. If a
late-surfaced design issue can't be fixed here, it points back at the specific
earlier phase to amend rather than a forward dependency.
