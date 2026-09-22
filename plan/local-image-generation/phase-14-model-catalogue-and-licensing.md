# Phase 14 — Image model catalogue, licensing and opt-in download

**Depends on:** 13 (the engine needs weights to load) · **Enables:** 15, the
end-to-end verification of the local path.

## Goal

Give the local engine weights, through the download machinery that already
exists, with licensing as a first-class field rather than a footnote. A user
opting into the local backend picks from a short curated list, sees what each
model is licensed under in one plain sentence, and downloads it with progress
and cancellation. Nothing is downloaded until they choose.

## Files touched

- `src-tauri/src/models.rs` — extend `ModelInfo` with `license: String`,
  `license_url: String`, `commercial_use: bool`, `recommended: bool`, and
  `family: ModelFamily` (`Llm | Whisper | Image`). Add the image entries to the
  catalogue and `download_image_model`, alongside the existing
  `download_whisper_model`.
- `src/lib/components/settings/ImageSection.svelte` — a model list with
  licence line, size, download/cancel and delete.
- `src/lib/image/local/backend.ts` — resolve `imageLocalModelId` to a file in
  the models directory, falling back to `imageLocalModelPath`. The settings
  fields came from phase 01; this is the phase that gives an id meaning, which
  is why phase 13 reads only the path.
- `src-tauri/src/models.rs` tests; `ImageSection.test.ts`.
- `CLAUDE.md` — note the third model family in the dev-setup section.

## Steps

1. Add `family` to `ModelInfo` and default every existing entry to its current
   family, so the LLM and whisper catalogues are unchanged in behaviour. This is
   a `#[ts(export)]` struct, so `./scripts/export-ipc-types.sh` must run.
2. Add the licensing fields. `commercial_use` is a boolean the UI acts on, not
   just text — it drives the warning in step 5, and a licence string alone would
   leave the decision to the user reading it.
3. The curated list, as GGUF/GGML weights the sidecar can load. The licences
   are the point of the phase; the figures are what the UI gates on:
   - **Stable Diffusion 1.5** (q8) — CreativeML OpenRAIL-M,
     `commercial_use: true`, ~2 GB download, ~4 GB VRAM. The small, fast
     baseline and the deepest LoRA ecosystem.
   - **SDXL 1.0** (q8) — CreativeML OpenRAIL++-M, `commercial_use: true`,
     ~7 GB download, ~10 GB VRAM.
   - **FLUX.1-schnell** (q4) — Apache 2.0, `commercial_use: true`, ~7 GB
     download, ~12 GB VRAM. The most permissive licence here.
   - **FLUX.1-dev** (q4) — non-commercial licence, `commercial_use: false`,
     ~7 GB download, ~12 GB VRAM. Present precisely so the warning path has a
     real entry to exercise, and never `recommended`.
   The sizes and VRAM figures above are the shipped catalogue values; each is
   confirmed against the downloaded artifact when the entry is added, since
   step 4 already downloads and checksums it. Every entry carries a download
   URL and a SHA-256, like the existing LLM and whisper entries, and a test
   asserts both are non-empty for every image entry so one cannot be added
   without them.
   **`recommended` is resolved against the probed machine**, not fixed in the
   data: FLUX.1-schnell at ≥12 GB VRAM, SDXL at ≥10 GB, otherwise SD 1.5. That
   is what makes "the recommended default where VRAM allows" a rule rather than
   a hope, and `commercial_use: false` entries are never recommended at any
   VRAM.
4. `download_image_model` reuses the existing download path — progress events,
   cancellation, checksum, the shared models directory — rather than adding a
   second downloader. The whisper family already proved this generalises.
5. The UI shows, per model: name, size, one sentence naming the licence, and for
   `commercial_use: false` an unmissable warning plus a confirmation the user
   must accept before the download starts. Following the project's copy rule the
   visible text is one short sentence and the full licence text sits behind a
   `title` tooltip and a link.
6. Gate on VRAM using `hardware.rs`: a model whose requirement exceeds available
   VRAM is shown with a warning rather than hidden, since the user knows their
   machine better than the probe does.
7. Selecting a downloaded model sets `imageLocalModelId`, which this phase
   teaches the backend to resolve and which phase 01 made take precedence over
   `imageLocalModelPath`. A hand-placed file selected by
   path still works when no id is set, and is reported as "custom" with no
   licence claim, because Haruspex cannot know one.
8. Deleting a model that is currently loaded stops the engine first.

## Build gate

```
cd src-tauri && cargo test --lib && cargo clippy --all-targets && cargo fmt -- --check
cd .. && npm run check && npm run lint && npm run format:check && npm run test
./scripts/export-ipc-types.sh   # must report no drift
```

## Test plan

- Rust: `list_models` filtered by family returns only image models; existing LLM
  and whisper listings are byte-identical to before the change — the regression
  that matters most here.
- `recommended` resolution: at 16 GB VRAM it is FLUX.1-schnell, at 10 GB SDXL,
  at 6 GB SD 1.5, and FLUX.1-dev is never recommended at any VRAM because
  `commercial_use` is false. This is a test over the catalogue data, so adding a non-permissive
  recommendation later fails the build.
- Every image entry has a non-empty `license`, `license_url` and a non-zero
  size and VRAM figure.
- Download: progress events fire; cancel mid-download leaves no partial file in
  the models directory; a completed download is listed as present.
- UI: a `commercial_use: false` model cannot be downloaded without the
  confirmation — verify it has teeth by removing the guard; a model over
  available VRAM shows a warning and is still selectable.
- Deleting the loaded model stops the engine first, asserted by the engine
  status after the delete.
- A custom path is reported as "custom" with no licence claim.

## Commit

```
feat(image): add an image-model catalogue with licensing and opt-in download
```

## Rollback

Remove the image entries and `download_image_model`, revert `ModelInfo`'s new
fields, re-run `./scripts/export-ipc-types.sh`, and drop the model list from the
settings section. The local engine still works with a hand-placed model path, so
this phase is safe to back out without losing the local backend.
