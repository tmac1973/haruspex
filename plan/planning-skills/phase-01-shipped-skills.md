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
- **`/init` moves here**:
  - `src-tauri/src/skills/builtin/init/` becomes
    `resources/skills/init/`, and `BUILTINS` is emptied. The built-in
    source and its plumbing stay, unused, for a skill that must never be
    edited.
  - The `init` body gains `metadata.haruspex-mode: code`.
  - Code mode gating (`codeModeOnly` in `skills/client.ts`) reads a new
    `SkillSummary.codeModeOnly`, set by Rust from that field, instead of
    `source === 'builtin'` plus a name list. A user's own `init` is gated
    only if it sets the field too.
  - Phase 6's tests that expect a built-in `init` move to the shipped
    path.
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
- `metadata.haruspex-mode: code` keeps a skill out of Chat and plain Shell
  (the `/` list, the catalog), and `/init` there still says it needs Code
  mode.
- A shipped `init` that the user deleted stays gone, and `/init` is then
  unknown, like any other missing skill.

## Done when

A fresh profile shows the shipped skills, `init` included, in Settings and
in Code mode's `/` autocomplete. After deleting one and editing another, a restart keeps
both changes, and Restore undoes them.
