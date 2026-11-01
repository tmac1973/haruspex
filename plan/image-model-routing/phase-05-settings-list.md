# Phase 05 — Settings → Image as an ordered list

**Depends on:** 02, 03, 04 · **Enables:** users running several image models;
06 (names to offer the chat model).

## Goal
Settings → Image shows the saved entries as an ordered list. Order is routing
priority. One row's editor is open at a time and is today's Connection editor
(backend, saved servers, address, key, model, Probe, capability line) for that
entry. **Add model** appends an entry. The bundled engine's catalogue section
and the ComfyUI, Lemonade and toolchest install panels show for the open entry.

> **Moved here from Phase 03:** migrating the `comfy:key` and `lemonade:key`
> secrets into named keys (`migrateImageKeys()` beside `migrateJobApiKeys()`,
> with `imageKeysReady()` awaited before a ComfyUI or Lemonade call); the
> `ApiKeyPicker` for every backend; `secret: ""` for `COMFYUI` and Lemonade in
> Rust; and the filed issue to drop the single-backend fields one release
> later. `imageEntries()` switches to reading `imageModels` as it is, and the
> editor writes entries instead of the old fields (`updateSettings` stops
> rewriting the list from them).

## Files touched
- `src/lib/components/settings/ImageSection.svelte` — split: the list and its
  rows stay here; the per-entry editor moves out.
- `src/lib/components/settings/ImageEntryEditor.svelte` (new) — today's
  Connection section, Bundled engine section, install panels, Test generation
  and custom workflow `<details>`, bound to one entry by id; writes through
  `updateImageModel`.
- `src/lib/components/settings/ImageEntryRow.svelte` (new) — name (editable on
  the open row), backend and host, the capability line (from `caps`, or
  "Not probed yet."), and ↑ ↓ Remove buttons with `aria-label`s.
- `src/lib/image/entries.ts` — `moveImageModel(id, delta)`,
  `removeImageModel(id)`, `addImageModel(backend)` (named `uniqueName(defaultName(entry), host,
  taken)`, so a second new ComfyUI entry is "ComfyUI 2"; fills address and
  key from `prefillFromInference('image')` for toolchest, as `persistKind`
  does now; choosing a model renames it to the model's display name unless
  `renamed`),
  `renameImageModel(id, name)` (sets `renamed: true`; empty resets to the
  display name and `renamed: false`; duplicates get " (host)" via
  `uniqueName`).
- `ImageSection.svelte`'s Probe and Test generation, and `ReviewAssets.svelte`,
  use the open entry (or entry 1 outside Settings) instead of
  `firstImageEntry()`.
- `src/lib/components/settings/ImageSection.test.ts`,
  `ImageEntryEditor.test.ts` (new), `ImageEntryRow.test.ts` (new).
- `e2e/ui/` — a Playwright spec: add two entries, reorder, remove.
- `docs/guide/images.md` — the "Choosing a backend" part becomes "Adding image
  models": the list, order as priority, failover, and that the bundled engine
  runs one model at a time.

## Steps
1. Section heading "Image models" with one help sentence: "Image tools use the
   first model in this list that can do the job." Detail goes in a `title`
   tooltip.
2. Each row is a button that opens its editor; opening another closes the
   first (same pattern as the job editor's one-open-section, PR #834). A new
   entry opens on creation.
3. The editor's backend select lists the four backends, with no None (Remove
   deletes an entry). Changing it sets `backend`, clears `url`, `model`,
   `caps`, `capsAt` and `options`, keeps `keyId`, and resets the name to
   `defaultName` unless `renamed`. Toolchest fills address and key from
   `prefillFromInference('image')` when empty. Leaving `local` stops the engine only if no other
   entry is `local`.
4. The bundled engine: two `local` entries may exist; the editor's Start/Stop
   and catalogue show for the open one. The engine restarts on the other
   model when a call routes to it (`ensureRunning` already restarts for a new
   model id).
5. Remove asks no confirmation (the entry is one Add away) but stops a running
   engine that only it used.
6. The "has image models" hint (`toolchestHint`) shows when the list is empty.
7. UI copy follows the one-short-sentence rule; Settings paths in full.

## Build gate
`npm run check`, `npm run lint`, `npm run format:check`, `npm run test`,
`CI=1 npx playwright test e2e/ui/<new spec>`.

## Test plan
- Component tests: add two entries, move the second up, the saved order
  changes; remove one; renaming to empty restores the display name; a
  duplicate name gets the host; the open editor probes its own entry and saves
  `caps`.
- Playwright: the flow above, plus that only one editor is open.
- Live (dev app), two servers: a klein entry on asmodean's toolchest and an
  entry on asmodean's ComfyUI (:8188); one turn draws on one and edits on the
  other, and stopping one server's entry moves the draw to the other.
- Live (dev app): asmodean toolchest with Ming-Image and klein entries; ask
  Chat to draw a transparent sprite, then edit it with a second picture; the
  draw runs on Ming-Image and the edit on klein; the results name them.

## Commit
`feat(image): list several image models in Settings → Image`

## Rollback
Revert the commit. The saved list stays and Phase 04's routing keeps using
it; the user just loses the screen to edit more than entry 1. Safe to leave.
