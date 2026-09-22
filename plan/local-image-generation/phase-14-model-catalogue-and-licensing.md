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
  `license_url: String`, `commercial_use: bool`, `recommended: bool`,
  `native_edge: u32` and `family: ModelFamily` (`Llm | Whisper | Image`). Add the image entries to the
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
   Each entry also carries `native_edge`, the resolution the model was
   trained at, because a profile's `upscale` is only correct relative to it:
   SD1.5 degrades above 512 and SDXL produces artefacts below 1024, so a
   32px target wants `upscale: 16` on one and `32` on the other. Selecting a
   model sets the profile's upscale from this field rather than leaving the
   user to discover why their sprites look wrong.
   - **Stable Diffusion 1.5** (q8) — CreativeML OpenRAIL-M,
     `commercial_use: true`, ~2 GB download, ~4 GB VRAM, `native_edge: 512`.
     The small, fast baseline and the deepest LoRA ecosystem.
   - **SDXL 1.0** — CreativeML OpenRAIL++-M, `commercial_use: true`, ~7 GB
     download, ~10 GB VRAM, `native_edge: 1024`. Markedly better at following
     composition instructions, which is a precondition of background removal
     rather than a matter of taste.
   - **FLUX.1-schnell** (q4) — Apache 2.0, `commercial_use: true`, ~7 GB
     download, ~12 GB VRAM, `native_edge: 1024`. The most permissive licence
     here, and the one with the largest caveat: Flux is a DiT, so the
     UNet-oriented IP-Adapter and circular-padding node packs this plan
     depends on do not apply to it. It is listed for plain generation and
     reports `referenceConditioning: false` and `seamlessTiling: false`, which
     the job degrades around — two of the three coherence layers unavailable.
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
9. **The LoRA is the licensing trap, not the base model.** `AssetStyle.loras`
   lets a spec name LoRAs, and most published pixel-art LoRAs carry their own
   terms — many trained on scraped commercial game art — so a LoRA can quietly
   contaminate a pipeline whose base model is clean. Haruspex cannot classify a
   file the user supplies, so it must not imply it has: a spec that names a
   LoRA is reported as "custom, licence unknown" in the run report next to the
   base model's licence, the same way a hand-placed checkpoint selected by path
   is. The honest position is to say what we do not know rather than to leave a
   clean base-model licence standing for the whole output.
10. **Catalogue exclusions, recorded so they are not revisited by accident.**
   SD3.5 is under Stability's community licence, which carries a revenue
   threshold; Bria FIBO is non-commercial and needs licensing from Bria;
   FLUX.1-dev and FLUX.2-dev have non-commercial weight licences and FLUX.2-dev
   requires a paid licence for commercial use. Only FLUX.1-dev is listed, and
   only to exercise the warning path.
11. **Newer permissive options worth evaluating when this phase is built.**
   Not committed to here, because none has been run against this pipeline and
   the catalogue's figures are meant to be confirmed against a downloaded
   artifact rather than quoted:
   - **Qwen-Image-2512** (Apache 2.0, ~20B, FP8/GGUF to fit a single 32 GB
     card), with **Qwen-Image-Edit** as its sibling. The Edit model is the
     interesting part and is discussed in step 12.
   - **Z-Image-Turbo** (Apache 2.0, 6B, ~8 steps, fits 16 GB) — the
     fast-iteration option. One roundup notes the repo licence and the weight
     licence should be checked separately; verify the weight file before
     listing it as `commercial_use: true`.
   - **FLUX.2 [klein]** (Apache 2.0, 4B, ~8 GB) and **HiDream-O1** (MIT).
   Each is a DiT, so step 12 applies to all of them.
12. **Seamless tiling does not transfer from UNet to DiT, and neither does
   IP-Adapter.** The circular-padding trick this plan uses (`SeamlessTile` +
   `CircularVAEDecode`) works on UNet models like SD1.5 and SDXL and does not
   work well on DiT models — Flux, Qwen, Z-Image. The remedy for DiT is
   **offset-and-inpaint**: shift the tile by half, inpaint the visible seams,
   shift back. Adding a DiT model to the catalogue therefore means either
   implementing that path or continuing to report `seamlessTiling: false` and
   letting the job degrade, which it already does honestly. What must not
   happen is a catalogue entry claiming a capability the backend cannot
   deliver — that is precisely the "capability claim nobody checks" failure
   `image/types.ts` warns about, and the job would stop degrading and start
   silently shipping seamed textures.

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
- Every image entry has a non-empty `license`, `license_url`, a non-zero size
  and VRAM figure, and a `native_edge`.
- Selecting a model sets the profile's `upscale` so the generation edge lands
  on that model's `native_edge` — a 32px target gets 16 on SD1.5 and 32 on
  SDXL. The failure this prevents is silent: SDXL at 512 produces artefacts
  and nothing in the pipeline would report it.
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
