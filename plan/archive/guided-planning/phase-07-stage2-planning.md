# Phase 07 — Stage 2: planning Q&A + verifier loop + dep-map approval + write phases

**Depends on:** Phase 06 · **Enables:** the complete feature (Phase 08 polishes
the view; Phase 09 hardens).

## Goal

From the approved `overview.md`, drive the planning stage to a finished, written,
dependency-ordered set of phase files with no deferred decisions: one-at-a-time
planning Q&A, a **fresh-context verifier that loops until clean**, the
**dependency-map approval checkpoint**, then writing `phase-NN-*.md` files —
each a milestone for resume.

## Files touched

- **NEW** `src/lib/agent/jobs/guided-planning/stage-planning.ts` — stage driver
  + planning system prompt.
- **NEW** `src/lib/agent/jobs/guided-planning/verifier.ts` — fresh-context
  verifier sub-agent + loop.
- **EDIT** `src/lib/agent/jobs/guided-planning/templates.ts` — the phase-file
  template.
- **EDIT** `runner.svelte.ts` — sequence planning → verify → approval → write.

## Implementation

### Planning Q&A

Agent loop with the same allowlist; system prompt: read the approved
`overview.md` and the codebase, ask one `ask_user_question` at a time to resolve
*implementation* decisions (the same early-exit/proceed control as Stage 1),
then produce a **draft phase outline** — an in-memory structured list
`PhaseOutline[]` (`{ id, title, dependsOn: id[], enables, summary }`) plus draft
bodies. The outline is what the verifier and the dep-map approval operate on; it
is also persisted into `planning_state.approvedOutline` once approved.

### Fresh-context verifier loop (the rigor guarantee)

`verifier.ts` runs an **independent sub-agent** (fresh context — pass it only the
overview + the draft outline/bodies, not the planning conversation) whose sole
job is to find:

- **Ordering violations:** any phase whose `dependsOn` references a later phase,
  or a body that requires something introduced in a later phase.
- **Deferred/unresolved decisions:** any "TBD", "decide later", "we'll figure
  out", optionality, or unstated choice in a phase body.

It returns a structured issue list (forced final tool, e.g. `submit_review` with
`{ issues: [{ phase, kind, detail }] }`). The runner then:

```
loop:
  issues = verify(outline, bodies)
  if issues empty: break
  main agent revises outline/bodies to resolve issues (it may ask the user a
    question if a deferred decision needs a real answer)
  -> re-verify
```

This is the **loop-until-clean** decision. Cap iterations (e.g. 5) with a clear
surfaced message if hit, rather than looping forever.

### Dependency-map approval checkpoint

Once the verifier is clean, set `pendingCheckpoint = 'dep_map'` and present the
phase/dependency map to the user via `ask_user_question`:

- Render the ordered phases with their `dependsOn` as the question body.
- Options: **Approve** → write files. **Revise** (free-text) → main agent
  applies the change, re-runs the verifier loop, re-presents.

On approve, persist `approvedOutline` into `planning_state`.

### Write phase files (each a milestone)

For each phase in order, write `phase-NN-<slug>.md` via guarded `fs_write_text`
using the fixed template (Goal · Depends on / Enables · Files touched · Steps ·
Build gate · Test plan · Commit · Rollback). After each file:
`saveMilestone(run, { milestone: 'phase_NN_written' })`. After the last, set
`stage: 'done'`.

### Resume behavior

- Parked during planning Q&A (pre-outline): re-enter planning from the start of
  the round (overview on disk is the anchor).
- Parked at the dep-map checkpoint: `approvedOutline` may be null but the draft
  is regenerated; simplest correct behavior is to re-run the (cheap, cached)
  verifier and re-present the map. If already approved (`approvedOutline` set)
  but some `phase_NN_written` milestones exist: resume writing from the next
  unwritten phase using the persisted `approvedOutline` — **no re-questioning**.
- `stage: 'done'`: nothing to do.

## Build gate

`npm run check && npm run lint && npm run test`

## Test plan

1. Full run on a real feature idea → planning questions → a clean phase set is
   written; open the files: ordered, templated, no "TBD"/deferred language.
2. **Verifier catches ordering:** seed a draft where phase 2 depends on phase 4
   (temporary forced fixture) → verifier flags it → revision fixes order before
   approval.
3. **Verifier catches deferral:** a body containing "decide later" → flagged →
   resolved (may trigger a user question).
4. Dep-map **Revise** ("merge phases 3 and 4") → applied, re-verified, re-shown.
5. Dep-map **Approve** → files written; `approvedOutline` persisted.
6. Kill app after 2 of N phase files written → resume → remaining phases written
   from `approvedOutline` with **no** re-questioning.
7. Verifier iteration cap hit → surfaced clearly, run not hung.

## Commit

```
feat(jobs): guided_planning stage 2 — planning, verifier loop, output

Planning Q&A produces a phase outline; an independent fresh-context
verifier loops until no ordering violations or deferred decisions
remain; user approves the dependency map; phase-NN files are written
(each a resume milestone) from the approved outline.
```

## Roll-back rule

Revert the stage + verifier files and the runner sequencing; Stage 1 (Phase 06)
still works and writes the overview. The output folder may contain a partial
phase set — harmless markdown, easily deleted.
