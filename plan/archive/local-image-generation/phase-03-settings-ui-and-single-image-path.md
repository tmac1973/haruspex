# Phase 03 — Settings → Image, backend probe, and the single-image path

**Depends on:** 01, 02 · **Enables:** every later phase can assume a configured,
probed backend; this is also the milestone that proves the layering constraint.

## Goal

Make the backend reachable and observable by a human. A Settings → Image section
selects the backend, takes a URL and optional API key, and probes it with
feedback. A `generateOneImage()` helper wraps `resolveImageBackend().generate()`
for callers that want a single picture and nothing else, and a "Test generation"
button in Settings uses exactly that helper to produce a small image and display
it.

That button is not a toy. It is the observable proof the overview asks for: a
single image, from a prompt, through the configured backend, with **no spec, no
anchor, no job and no job runner**. When a later plan adds an image tab or an
inline chat image, this is the call it makes.

## Files touched

- `src/lib/image/generateOne.ts` — new. `generateOneImage({ prompt, width,
  height, seed?, signal?, onProgress? })` → `ImageResult`.
- `src/lib/components/settings/ImageSection.svelte` — new. Backend picker, base
  URL, API key, the optional custom-workflow pair, Probe, Test generation, and
  the result preview.
- `src/lib/components/settings/` — register the section wherever the existing
  sections are listed (same pattern as `ShellSection.svelte`).
- `src-tauri/src/image_cache/commands.rs` — add `image_store_bytes(bytes,
  mime)` returning the content hash, so the preview can be displayed through the
  existing `haruspex-img://` scheme rather than a data URL.
- `src-tauri/src/lib.rs` — register the new command.
- `src/lib/image/generateOne.test.ts`, `ImageSection.test.ts` — new.
- `src/lib/image/singleImageIsolation.test.ts` — new. The additive-proof test.

## Steps

1. Write `generateOneImage()`: resolve the configured backend, call `generate()`
   with a request built from the arguments and sensible defaults (seed null
   meaning "let the backend choose", model unset meaning "the configured
   checkpoint"), return the result. It adds no
   normalization, no palette, no anchor — a chat turn asking for a picture of a
   cat must not be quantized to somebody's tileset.
2. Add `image_store_bytes` to the image-cache commands: hash the bytes, write
   them into the existing cache directory, insert the row the cache's own
   schema expects, return the hash. Reuse the cache's existing insert path
   rather than writing a second one, so the sweep keeps working.
3. Run `./scripts/export-ipc-types.sh` — a new Tauri command means CI checks for
   drift.
4. Build `ImageSection.svelte`:
   - a select for backend kind (None / ComfyUI),
   - base URL, API key and default-checkpoint inputs, shown only when a backend
     is selected,
   - a **Probe** button calling `backend.probe()`, showing ok/failed and the
     returned detail,
   - file pickers for `imageComfyWorkflowPath` and `imageComfyFieldMapPath`,
     behind a collapsed "Custom workflow" disclosure since the bundled
     templates are the default path; setting one without the other is refused
     with one sentence naming the other,
   - a **Test generation** button calling `generateOneImage()` with the fixed
     prompt `'a red apple on a plain background'` at 512×512, storing the bytes
     via `image_store_bytes`, and rendering `haruspex-img://localhost/<hash>`,
   - a capabilities line listing what the probed backend reports.
   Copy follows the project rule: one short sentence per section, detail in a
   `title` tooltip, and the settings path named rather than described.
5. Wire cancellation: the Test generation button becomes Stop while running and
   aborts the `AbortController` it passed in.
6. Write `singleImageIsolation.test.ts`: import `generateOne.ts` in a test that
   mocks only the backend registry, and assert a full generate round-trip works
   with nothing from `src/lib/agent/` loaded. Pair it with the phase-01 file
   scan so both the static and the runtime halves of the constraint are covered.

## Build gate

```
npm run check && npm run lint && npm run format:check && npm run test
./scripts/export-ipc-types.sh   # must report no drift
cd src-tauri && cargo test --lib && cargo clippy --all-targets && cargo fmt -- --check
```

## Test plan

- `generateOne.test.ts` — calls the resolved backend once with the given prompt
  and size; propagates an abort; surfaces a backend error unchanged.
- `singleImageIsolation.test.ts` — the round-trip succeeds without importing the
  jobs layer. Verify it has teeth by temporarily importing a job module into
  `generateOne.ts` and confirming failure.
- `ImageSection.test.ts` — selecting None hides the URL fields; Probe renders
  the returned detail on success and on failure; Test generation calls
  `generateOneImage` exactly once and renders an image for the returned hash;
  Stop aborts.
- Rust: a unit test that `image_store_bytes` returns a stable hash for fixed
  bytes and that a second store of the same bytes does not duplicate the file.
- Manual: with a real ComfyUI configured, Probe reports the device and Test
  generation renders a picture inside the app.

## Commit

```
feat(image): add Settings → Image with a probe and a single-image test path
```

## Rollback

Remove the settings section and its registration, delete `generateOne.ts` and
the isolation test, and drop `image_store_bytes` plus its registration, then
re-run `./scripts/export-ipc-types.sh`. The backend and its ComfyUI
implementation survive untouched; only the human-facing surface goes.
