# Phase 5 — The model writing skills

## Goal

The model can save a procedure as a skill, or improve one, and the user
approves every write.

## Work

- Tools (category `skills-write`):
  - `create_skill(name, description, body, where?)`.
  - `update_skill(name, description?, body)`.
  - Not offered for deletion; the user deletes in Settings.
- Offered in interactive Chat, Shell and Code turns only, never in jobs or
  remote turns. Not tied to the autonomous-use setting: "save that as a skill"
  is an explicit request.
- **Where it goes**: the user's skills folder by default. In Code mode,
  `where: "project"` targets `.agents/skills/` in the repo — the approval
  modal names the destination.
- **Approval modal**: the full `SKILL.md` for a new skill, or the change for
  an update, in the CodeMirror editor so the user can edit before saving.
  Approve or Reject; no "for this session". Rejecting returns the reason to
  the model.
- **Validation before the modal**: the phase 1 rules. A bad name is turned
  back to the model with the reason, not shown to the user.
- **Labelling**: the written file carries `metadata: { created-by: haruspex }`,
  which the Settings list shows as "written by the model".
- **Name collisions**: `create_skill` on an existing name fails and tells the
  model to use `update_skill`. Updating a built-in or extra-folder skill is
  refused; the model can create a user copy instead.

## Tests

- Validation errors returned to the model without opening the modal.
- Approve writes the edited text; Reject writes nothing.
- The tools are absent from jobs and remote turns, and refused at execution if
  called anyway.
- Project destination only in Code mode.

## Done when

"Save what we just did as a skill called deploy-check" produces an approval
modal, and the approved skill shows up in Settings and in `/` autocomplete.
