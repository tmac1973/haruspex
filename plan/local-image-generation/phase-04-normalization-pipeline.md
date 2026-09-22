# Phase 04 — Normalization: profile, palette, integer downscale, chroma key, outline

**Depends on:** nothing — it is pure image processing and calls no backend ·
**Enables:** 05 (the spec embeds the profile), 08 (palette extraction), 09
(every entry is normalized), 10 (the check thresholds live on the profile).

## Goal

The mechanical coherence layer, in Rust. Given an image and a normalization
profile it produces the final asset: background keyed out, subject cropped and
downscaled by an exact integer factor with nearest-neighbour, every colour
snapped to a shared palette, outline weight made uniform. It also extracts a
palette from an image, which is how the anchor's palette is established in
phase 08.

`NormalizeProfile` is defined here and is the single home for every tunable the
pipeline has, including the thresholds phase 10 checks against. Everything that
later phases would otherwise invent a field for is enumerated in step 1.

This layer is what makes the design survive a weak backend. Reference
conditioning can drift or be unavailable; palette and grid do not care.

## Files touched

- `src-tauri/src/image_gen/mod.rs` — new module.
- `src-tauri/src/image_gen/profile.rs` — new. `NormalizeProfile`, `AssetKind`,
  `KindOverride`, `CheckThresholds`, all `#[ts(export)]`, with `Default`.
- `src-tauri/src/image_gen/palette.rs` — new. `extract_palette(img, n, exclude)`
  by median-cut, and `quantize_to(img, palette)`.
- `src-tauri/src/image_gen/normalize.rs` — new. `chroma_key`,
  `crop_to_content`, `downscale_integer`, `normalize_outline`, and
  `normalize(img, profile, kind)`.
- `src-tauri/src/image_gen/commands.rs` — new. `image_normalize(bytes, profile,
  kind)` → `{ bytes, stats: ImageStats }`; `image_extract_palette(bytes, n,
  exclude)` → colours; `image_effective_profile(profile, kind)` → the resolved
  flat profile, so the TypeScript loop can read `reference_strength` and the
  background colour without duplicating the override logic.
- `src-tauri/src/image_gen/stats.rs` — new. `ImageStats { alpha: f32, entropy:
  f32, palette_distance: f32 }`, computed during normalization.
- `src-tauri/src/lib.rs` — register the module and its three commands.
- `src-tauri/src/image_gen/fixtures/` — new. Small hand-made PNGs for tests.
- `src/lib/assets/normalize.ts` — new. Thin TS wrappers over the three commands.
  Note the module: this is asset-domain code and must not live under
  `src/lib/image/`, which phase 01's layering test forbids.

## Steps

1. `NormalizeProfile`, with these fields and these defaults. Later phases read
   from here and add nothing:
   - `target_size: u32 = 32` — the output edge in pixels.
   - `upscale: u32 = 16` — generation happens at `target_size * upscale`, so 32
     becomes 512. The downscale factor is exactly this number.
     **The right value depends on the model**, which is why it is a profile
     field rather than a constant: SD1.5 is trained at 512 and degrades above
     it, SDXL is trained at 1024 and produces artefacts below it. A 32px
     target wants `upscale: 16` on SD1.5 and `32` on SDXL, and the latter is
     exactly `MAX_GENERATION_EDGE`. Phase 14's catalogue entries carry the
     upscale each model wants, so choosing a model sets it. The effective
     value is clamped so the generation edge never exceeds
     `MAX_GENERATION_EDGE = 1024`: `upscale.min(1024 / target_size).max(1)`.
     Without that clamp a `target_size` of 512 — which phase 06 permits —
     would ask for an 8192 px image no backend will serve.
   - `palette_size: u32 = 16` — how many colours `extract_palette` returns.
   - `palette: Vec<u32>` — empty until phase 08 fills it from the anchor.
   - `background: { color: u32 = 0xFF00FFFF, tolerance: u8 = 40 }` — flat
     chroma magenta, requested in the prompt and keyed out here.
   - `crop: { enabled: bool = true, margin: u32 = 1 }`.
   - `outline: { enabled: bool = true, color: u32 = 0x1A1A1AFF, width: u32 = 2 }`.
   - `reference_strength: f32 = 0.6` — how strongly a generation is pulled
     toward the anchor. It lives here rather than on the request because it is a
     property of the style, and the spec is where style settings are versioned.
   - `checks: CheckThresholds` — `alpha_min: f32 = 0.05`, `alpha_max: f32 =
     0.95`, `entropy_min: f32 = 2.0` (bits per pixel over the quantized
     palette), `palette_distance_max: f32 = 0.15` (fraction of pixels further
     than ΔRGB 48 from their palette entry before snapping).
   - `by_kind: BTreeMap<AssetKind, KindOverride>` — per-kind overrides of any of
     the above. The shipped default sets `texture` to `crop.enabled = false`,
     `outline.enabled = false`, `checks.alpha_min = 0.999` and
     `checks.alpha_max = 1.0`, because a tiling texture is fully opaque and
     cropping or outlining it destroys the tiling.
   - `AssetKind` is `Sprite | Texture | Icon`, the same three phase 05 uses.
2. `effective_profile(profile, kind)` resolves the overrides once and returns a
   flat profile, and is exposed as the `image_effective_profile` command so the
   TypeScript side uses the same resolver rather than a second implementation.
   Every consumer calls it rather than reading `by_kind` itself, so per-kind
   behaviour cannot drift between call sites.
3. `chroma_key(img, color, tolerance)`: set alpha 0 on every pixel within
   `tolerance` of the key colour in RGB distance. The prompt asks the model for
   a flat background of that colour, so this is a threshold rather than a matte
   — deterministic, fast, and testable against a fixture.
4. `crop_to_content(img, margin)`: tightest bounding box of non-transparent
   pixels, expanded by `margin`. Skipped when the effective profile disables it.
5. `downscale_integer(img, target)`: pad up to the nearest multiple of `target`,
   then within each cell pick the **modal** colour rather than the mean —
   averaging is what turns pixel art into mush. Never a fractional resize,
   never bilinear.
6. `extract_palette(img, n, exclude)`: median-cut to `n` colours, excluding any
   colour within the background tolerance of `exclude`, returned sorted by
   luminance so the output is stable for the same input.
7. `quantize_to(img, palette)`: snap each pixel to its nearest palette entry,
   preserving alpha, and return the palette-distance statistic alongside the
   image — it is knowable only here, before snapping, which is why
   `image_normalize` carries it out rather than phase 10 re-deriving it from an
   already-quantized result. No dithering — dithering defeats the uniformity
   this exists to create.
8. `normalize_outline(img, color, width)`: the dilation the dark_times
   `asset-gen` uses — every transparent pixel touching an opaque one becomes the
   outline colour, repeated `width` times.
9. The pass runs key → crop → despeckle → QUANTIZE → downscale → outline.
   Quantizing before downscaling is the non-obvious step and it is what makes
   the output legible: `downscale_integer` takes the modal colour of each
   cell, which is right for pixel art and degenerates on a photograph, where
   every pixel in a cell differs and there is no mode to find. Quantizing at
   full resolution first leaves at most `palette_size` colours per cell, so
   the mode is real. Measured on SDXL output: crossed swords went from a
   broken X to legible and an apple from two stray dots to an apple.
10. `normalize()` returns the PNG bytes **and an `ImageStats`** — alpha
   coverage, entropy over the quantized palette, and the palette distance from
   step 7. Phase 10 evaluates those numbers against thresholds; it never
   re-measures the image. `normalize()` runs: chroma key → crop → downscale →
   quantize → outline,
   each step skipped per the effective profile. The order matters and is
   asserted by a test: keying after quantizing would snap the background into
   the palette, and outlining before downscaling would give a fractional border.
11. Derive every profile type with `#[ts(export)]` and run
    `./scripts/export-ipc-types.sh`.
12. The TS wrappers in `src/lib/assets/normalize.ts` are plain `invoke` calls
    with no logic, so the pipeline has one implementation and it is the Rust one.

## Build gate

```
cd src-tauri && cargo test --lib && cargo clippy --all-targets && cargo fmt -- --check
cd .. && npm run check && npm run lint && npm run format:check && npm run test
./scripts/export-ipc-types.sh   # must report no drift
```

## Test plan

Fixture-driven, which is why the chroma-key approach was chosen over a
segmentation model:

- `chroma_key` on a fixture with a known magenta background leaves exactly the
  subject opaque; a pixel just outside tolerance survives.
- `crop_to_content` finds the right bounding box and honours `margin`; an
  all-transparent image returns an error rather than a zero-size crop.
- `downscale_integer` from 512 to 32 on a fixture of 16×16 solid blocks
  reproduces the blocks exactly — the test that proves modal selection, since
  averaging would blur the boundaries.
- `extract_palette` is deterministic across runs, and excludes the background
  colour when asked.
- `quantize_to` maps every output pixel into the palette, preserves alpha, and
  reports a palette distance that is zero for an already-in-palette fixture.
- `normalize_outline` produces a border of exactly the requested width.
- `normalize` order: a keyed background does not appear in the extracted
  palette of the result — a test that fails if keying runs after quantizing.
- `effective_profile` for `Texture` disables crop and outline and raises
  `alpha_min` to 0.999; for `Sprite` it returns the base values unchanged; and
  the command returns the same object the Rust function does.
- `upscale` clamping: `target_size: 512` with `upscale: 16` yields an effective
  upscale of 2 and a 1024 px generation edge, never 8192.
- `normalize` returns stats whose `palette_distance` is zero for an
  already-in-palette fixture and high for an off-palette one.

## Commit

```
feat(image): add the Rust normalization pipeline, profile and palette extraction
```

## Rollback

Delete `src-tauri/src/image_gen/`, its three command registrations and
`src/lib/assets/normalize.ts`, then re-run `./scripts/export-ipc-types.sh`.
Nothing calls it until phase 08, so removal before then is total; after then it
must be rolled back together with the phases that consume it.
