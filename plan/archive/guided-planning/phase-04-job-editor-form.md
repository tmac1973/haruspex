# Phase 04 — Job-editor form for guided_planning

**Depends on:** Phase 03 · **Enables:** creating/running the job (driven in
Phase 05+).

## Goal

Let the user create and edit a `guided_planning` job through the existing
job-editor UI: name, working dir, output folder, model override, and an
**initial description** field. After this phase you can create, persist, reload,
and edit the job — running it does nothing meaningful yet (that's Phase 05).

## Files touched

- **EDIT** `src/lib/components/jobs/JobEditor.svelte` — render a
  `guided_planning` variant of the form.
- **EDIT** the job-type picker (wherever a new job's type is chosen) — add
  "Guided planning".
- **EDIT** `src/lib/stores/jobs.svelte.ts` — create/update plumbing for the new
  fields (mirrors how audit fields are saved).
- Possibly **EDIT** `src/lib/components/jobs/JobList.svelte` — a type badge/icon
  for guided_planning.

## Implementation

### Form fields (guided_planning variant)

| Field | Maps to | Notes |
|---|---|---|
| Name | `jobs.name` | Also the slug source. |
| Working dir | `jobs.working_dir` | The project the agent reads/plans against. |
| Output folder | `jobs.plan_output_dir` | Defaults to `plan/<slug>/` (derive slug from name on blur/first edit); editable. Relative to working dir. |
| Model override | existing `model_remote_*` fields | Reuse the existing model-override UI unchanged. |
| Initial description | `jobs.initial_description` | Multi-line; "Describe what you want to build." This is the Stage-1 seed. |

Hide the research/audit-specific fields (steps list, audit config) for this job
type — the form already branches by `job_type` for audit; add a
`guided_planning` branch the same way.

### Slug derivation

`slugify(name)` (lowercase, kebab, strip unsafe chars). When the user hasn't
edited `plan_output_dir`, keep it in sync with the name as `plan/<slug>/`; once
they edit it, stop auto-syncing. Validate the path stays relative (no `..`,
no absolute) — surface an inline error if not (the runtime guard in Phase 05 is
the real enforcement, but fail early here).

### Validation

- Working dir required (the agent needs somewhere to read/write).
- Initial description required (non-empty) to enable "Run".

## Build gate

`npm run check && npm run lint && npm run test`

## Test plan

1. Create a guided_planning job: fill name → output folder auto-fills
   `plan/<slug>/`; edit output folder → auto-sync stops.
2. Save, restart app, reopen — all fields persist (validates Phase 03 plumbing
   end-to-end through the UI).
3. Switch an existing job's type / create each type — the correct field set
   shows for research / audit / guided_planning.
4. Empty working dir or description blocks Run with an inline message.
5. Output folder with `..` is rejected inline.

## Commit

```
feat(jobs): guided_planning job-editor form

JobEditor renders a guided_planning variant (name, working dir, output
folder defaulting to plan/<slug>/, model override, initial description),
persisted via the Phase 03 schema. Running it is wired in Phase 05.
```

## Roll-back rule

UI-only over the Phase 03 schema; revert the editor changes to remove the form
variant without touching data.
