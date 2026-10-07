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

## Decisions made while building it

- **Two steps in Rust, no paths from the frontend.** `skill_draft` checks the
  request and builds the `SKILL.md`; `skill_save` writes the approved text
  after working out the folder again and re-parsing it. An edit that breaks
  the skill, or renames it, is shown in the modal, which stays open; it never
  reaches the model.
- **Which skills an update may touch**: the user's folder and the trusted
  repo's. A built-in, an extra folder's, a `~/.agents/skills/` one, or a
  skill linked in from elsewhere belongs to another tool and is refused, with
  the hint to create a same-named copy, which takes its place.
- **`create_skill` on a taken name** fails when the existing skill is in the
  same place or one that takes precedence. A same-named skill from a
  lower-precedence folder may be overridden.
- **`created-by: haruspex` only on create.** An update keeps the frontmatter
  as it is, so the user's own skill isn't relabelled by a small edit; it is
  rewritten only when the description changes, which drops YAML comments.
- **Offered whenever the turn carries skills and someone is there**, which is
  every interactive Chat and Shell turn. No allowlist can grant them, and the
  registry refuses a call from any other turn.
- **A project skill the user approves** is added to the repo's trust record,
  so the next turn doesn't ask about a "new" skill they just wrote.
- **Stopping the turn** closes the modal and writes nothing.
