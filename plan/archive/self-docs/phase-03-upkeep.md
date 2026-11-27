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

## Decisions made while building it

- **The check is its own workflow, `guide.yml`, not a job in `ci.yml`.**
  Adding or removing `no-docs` (`labeled` / `unlabeled`) then re-runs only
  this check. It also sees every PR: `ci.yml`'s path filter skips prose-only
  ones, but a guide-only PR is exactly what it should pass.
- **`ci.yml` now runs for `docs/guide/**`.** The guide is compiled into the
  app and tested (`src/lib/guide/`), so a PR that only edits a page still
  needs the tests for size, format and drift. That's the same exception
  `docs/image-generation.md` already had.
- **The matching lives in `scripts/guide-check.mjs`,** a plain module that
  the workflow pipes `git diff --name-only` into, and that
  `src/lib/guide/check.test.ts` imports to test the rules.
- **Tool plumbing doesn't count:** `registry`, `types`, `index`, `coerce`,
  `_helpers` and `mcp-names` under `agent/tools/`, and any `*.test.ts`.
- **Shortcuts moved to `src/lib/shortcuts.ts`.** The `shortcuts` page now
  writes keys exactly as the app does (⌘, ⌥), so the drift test can match
  them as written.
