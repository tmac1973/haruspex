# Phase 16 — Guide, showcase and end-to-end pass

**Depends on:** 01–15 · **Enables:** the release (the branch is ready for its
one PR)

## Goal
The `notebooks` guide page describes the finished feature in under 6 KB. A
"Notebooks" showcase subject covers flows A–F from the overview. Every success
criterion in the overview is checked in the running app against a real
model. Gaps found are fixed here or filed as issues.

## Files touched
- `docs/guide/notebooks.md`: final pass over the sections added in phases
  02–15. Headings say what the user wants to do: "Keep research in a
  notebook", "Edit tables and checklists", "Ask an agent", "Undo an agent's
  change", "Find something", "Save from a chat", "Export and import", "Use
  notebooks from your phone or another computer", "Refresh on a schedule",
  "Find broken links", "What notebooks don't do". Full Settings paths. Under
  6,000 bytes, with compact tables and no Prettier.
- `src/lib/guide/guide.ts`: add `notebooks` to `ORDER` after `chat`.
- `docs/guide/settings.md`, `docs/guide/getting-started.md`: mention the tab
  and Settings → Notebooks.
- `docs/showcase/notebooks.md` (new):
  - six cards: research to notebook (Chat), organize my notes (Notebooks),
    extract from a PDF (Notebooks), bugs to a checklist (Code), outline a
    folder (Shell), and chart a table with Python (Notebooks)
  - each card has the description, `Tab:`, `Required settings:`, `Prompt:`,
    `Example output:` and `Read more: notebooks` fields
- `scripts/build-showcase.mjs`: add `notebooks` to `ORDER` after `research`.
- `src/lib/guide/pages.test.ts`: unchanged; it enforces the size limit.

## Steps
1. Edit the guide page down to size and check it reads standalone.
2. Write the showcase page and run `node scripts/build-showcase.mjs`.
3. End-to-end pass. Before handing any check to Tim, offer to drive it with
   `npm run drive` and the owner API. Go through each overview success
   criterion and flows A–F with a real model, plus:
   - lean mode hides everything (tab, tools, ops)
   - turning the tab off hides tools, buttons and ops
   - a fresh install has the tab on
4. Fix what's broken in this phase. File anything deferred as one GitHub
   issue with a checklist. Put the paired-computer hand test, which needs a
   second machine, there if it wasn't run.
5. Open the single PR for the branch. Its body names `docs/guide/notebooks.md`
   and the showcase page, and lists the per-phase commits.

## Build gate
- `cd src-tauri && cargo fmt -- --check && cargo clippy -- -D warnings && cargo test`
- `./scripts/export-ipc-types.sh` (no drift)
- `npm run format:check && npm run check && npm run lint && npm run test && npm run build:web`
- `node scripts/guide-check.mjs < /dev/null`
- `node scripts/build-showcase.mjs`

## Test plan
The end-to-end pass in step 3, recorded as a checklist in the PR body, with
each success criterion marked passed, or failed and filed.

## Commit
`docs(notebooks): finish the notebooks guide page and add showcase examples`

## Rollback
Revert the commit. The docs go back to their per-phase state, which still
passes the Guide check.
