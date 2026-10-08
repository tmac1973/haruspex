# Phase 3 — Keeping the guide current

## Goal

The guide changes in the same PR as the feature it describes, and CI says
so when it doesn't.

## Work

- **`CLAUDE.md`**: a "User guide" section.
  - A change users can see (a setting, a tool, a job type, a slash command, a
    shortcut, a changed behaviour) updates its page in `docs/guide/` in the
    same PR, and the PR body names the page.
  - The writing rules from phase 1.
- **CI** (`ci.yml`, a `guide` job):
  - Diff the PR against its base.
  - Fail when it touches any of the paths below but nothing under
    `docs/guide/`.
  - The `no-docs` label skips the check, for refactors, tests and internal
    changes.
  - The failure message names the paths that triggered it and the label that
    skips it.

  Paths that trigger it:
  - `src/lib/components/settings/**`, except tests;
  - `src/lib/agent/tools/**`, except tests and `registry.ts`;
  - `src/lib/agent/jobs/types/**`, except tests;
  - `src/lib/slash/**`;
  - `src/lib/components/HelpModal.svelte` (shortcuts);
  - `src-tauri/resources/skills/**` (shipped skills).
- **The label**:
  - Create `no-docs` in the repo.
  - Like `windows-ci`, adding it re-runs the check through the `labeled`
    event. Make sure the `guide` job runs on `labeled`, unlike the others,
    which skip it.
- **Drift tests** (Vitest):
  - Every shortcut in `HelpModal.svelte`'s `SECTIONS` appears on the
    `shortcuts` page. Move `SECTIONS` to its own module so a test can import
    it.
  - Every Settings section title appears on the `settings` page.

## Tests

The CI script's path matching runs on a fixture list of changed files:
- triggers without guide changes;
- passes with them;
- passes for test-only changes;
- skips with the label.

## Done when

A test PR touching a Settings section fails `guide`, passes after a guide
edit, and passes with `no-docs` instead.
