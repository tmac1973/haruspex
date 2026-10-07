# Phase 1 — Shipped skills

## Goal

Haruspex can ship skills that land in the user's skills folder as ordinary
files, which the user can edit, replace or delete, and which a later release
updates only when the user hasn't touched them.

## Work

- **Bundling**: `src-tauri/resources/skills/<name>/` (a `SKILL.md` plus any
  files), added to `bundle.resources` in `tauri.conf.json`. In dev, read from
  the source tree like the other resources.
- **Seeding** (`skills/shipped.rs`), run once at startup before the first
  window asks for skills:
  - For each bundled skill, apply the rules in the overview's table against
    `<app data>/shipped-skills.json`: `{ "<name>": { "hash": "<sha256 of
    SKILL.md as last copied>" } }`.
  - Copy whole folders, not just `SKILL.md`. "Unchanged" means every file
    matches the hashes recorded at the last copy.
  - A failure to seed one skill is logged and skipped; it never stops startup.
- **Settings → Skills**:
  - A "Shipped with Haruspex" badge on these skills, from the record, not
    from frontmatter.
  - A **Restore** action per shipped skill, with a confirm when it would
    overwrite edits.
  - "Restore shipped skills" for any the user deleted. It clears their
    "deleted" state and seeds them again.
- **IPC**: `skills_shipped` (names, and whether each is edited) and
  `skill_restore_shipped(name | null)`. Run `./scripts/export-ipc-types.sh`.
- **Deleting** a shipped skill in Settings uses the existing
  `skill_delete_user` and leaves the record, so the next start doesn't
  re-add it.

## Tests

- First run copies every bundled skill. A second run changes nothing.
- A user's own folder with a shipped name is left alone and never
  overwritten.
- Deleted skills stay deleted across restarts until restored.
- A new release's text replaces an unedited skill, but not an edited one.
- Restore puts back the shipped text, files included.

## Done when

A fresh profile shows the shipped skills in Settings and in `/`
autocomplete. After deleting one and editing another, a restart keeps
both changes, and Restore undoes them.
