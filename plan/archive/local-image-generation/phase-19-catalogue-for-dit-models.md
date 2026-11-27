# Phase 19 — A catalogue for multi-file DiT models

> **Revised (2026-10-01).** This catalogue now also feeds phase 27, which
> installs the files into the user's ComfyUI. Each file therefore also names
> its ComfyUI folder kind (`diffusion_models`, `text_encoders`, `vae`). Sizes
> and SHA-256 come from Hugging Face's tree API (the LFS `oid`):
> `Comfy-Org/Ming-Image` — `diffusion_models/ming_image_0.1_design_int8_convrot`
> 6 175 239 953, `text_encoders/ming_image_0.1_ling_mini_2.0_w4a8` 12 813 574 339,
> `vae/ming_image_vae_bf16` 253 816 696; `Comfy-Org/Qwen-Image-2.1` —
> `diffusion_models/qwen_image_2.1_int8_convrot` 7 256 783 064,
> `text_encoders/qwen3vl_8b_int8_convrot` 9 350 798 360,
> `vae/qwen_image_2.1_vae_bf16` 675 509 688. The ComfyUI half ships first;
> the local-engine half (paths per role in `local/backend.ts`, the tokenizer)
> still waits on 24.

**Depends on:** 17 (step 5), 18 · **Enables:** 24.

## Goal

Settings → Image offers Ming-Image-0.1-Design as the recommended model and
Qwen-Image-2.1 as an optional, clearly non-commercial one, each downloaded as
the set of files it actually needs. SD1.5 and SDXL leave the catalogue unless
phase 17 found a machine class only they can serve.

## Why the catalogue's shape changes

Phase 14 deliberately built one file per entry, and deferred FLUX partly
because "Flux needs separate text encoders and a VAE — three or four downloads
and a different shape of entry". Both models this plan now depends on have
exactly that shape:

| Model | Files (ComfyUI layout) | Size |
| --- | --- | --- |
| Ming-Image-0.1-Design | DiT int8 6.2 GB, Ling-mini-2.0 w4a8 12.8 GB, VAE 0.25 GB | ~19 GB |
| Qwen-Image-2.1 | DiT int8 7.3 GB, Qwen3-VL 8B int8 9.4 GB, VAE 0.7 GB | ~17 GB |

The bundled engine (phase 24) additionally needs Ming's `tokenizer.json`.

## Files touched

- `src-tauri/src/image_models.rs` — `ImageModelInfo.files: Vec<ModelFile>`
  (`role`, `filename`, `url`, `sha256`, `size_bytes`), replacing the single
  file fields. `#[ts(export)]` — run `./scripts/export-ipc-types.sh`.
- `download_image_model` — downloads every file of an entry through the
  existing `ModelManager::download_file`, with progress summed across files
  and one cancel for the lot.
- `src/lib/components/settings/ImageSection.svelte` — one row per model, size
  as the total, licence line as before.
- `src/lib/image/local/backend.ts` — resolve each role to a path.
- Tests beside each.

## Steps

1. **Entry shape.** `files` lists every file an entry needs with its role
   (`diffusion`, `text_encoder`, `vae`, `tokenizer`). An entry is
   "downloaded" only when every file is present and verified; a partial set
   shows as incomplete, with the missing roles in the `title` tooltip.
2. **Ming-Image-0.1-Design.** `license: "MIT"`, `commercial_use: true`,
   `recommended` wherever it runs. Files from `Comfy-Org/Ming-Image`: the int8
   DiT, the w4a8 text encoder (the int8 one is 19.5 GB and made no difference
   to alpha in the spike), the VAE; plus `mllm/tokenizer.json` from
   `inclusionAI/Ming-Image-0.1-Design`. SHA-256 of each taken from the
   downloaded artifact, as phase 14 required.
3. **Qwen-Image-2.1.** `license: "Qwen Research License (non-commercial)"`,
   `commercial_use: false`, never `recommended`. Its row uses the existing
   non-commercial warning and confirmation. The `title` tooltip states the
   distinction the spike found: the images belong to the user, but the licence
   restricts running the model for commercial work. The tooltip carries a link
   to the licence.
4. **SD1.5 and SDXL are removed.** Phase 17 found Ming runs in about 7 GB of
   VRAM at full speed with its text encoder on the CPU
   (`measurements-phase-17.md` §5). Machines below 8 GB, which SD1.5 served,
   lose image generation; their Settings row says why.
5. **Hardware line.** Each entry states VRAM and RAM needs: the text encoder
   runs on CPU (spike, finding 11), so RAM is part of the requirement — for
   Ming about 8 GB VRAM and 24 GB RAM (`measurements-phase-17.md` §5). The
   bundled engine would additionally need the 36.7 GB BF16 encoder (§4); do
   not list that file until phase 24 works. A
   machine short of either sees a warning, not a hidden row, as phase 14 did
   for VRAM.
6. **`native_edge`.** Both DiT entries carry 1024; they also generate at 2048.
   `upscaleForEdge` no longer decides generation size — phase 21 does — so
   check whether anything still reads `native_edge` after phase 21 and delete
   the field if nothing does.

## Build gate

```
cd src-tauri && cargo test --lib && cargo clippy --all-targets && cargo fmt -- --check
cd .. && npm run check && npm run lint && npm run format:check && npm run test
./scripts/export-ipc-types.sh   # must report no drift
```

## Test plan

- Every entry has at least a diffusion, text encoder and VAE file, each with
  a URL, SHA-256 and non-zero size — the existing "carries what a download
  needs" test, now per file.
- An entry with one of three files on disk is not "downloaded".
- Cancelling mid-way through the second file leaves neither partial file nor
  the completed first file claimed as a finished entry.
- `commercial_use: false` is never recommended at any VRAM (existing test,
  still passing).
- The UI cannot start the Qwen download without the confirmation — verify
  the guard has teeth by removing it.

## Commit

```
feat(image): multi-file catalogue entries for Ming-Image and Qwen-Image-2.1
```

## Rollback

Revert, and re-run `./scripts/export-ipc-types.sh`. Downloaded files stay on
disk under `models/image/` and are ignored by the reverted catalogue.
