# Phase 20 — Normalization for images that arrive with alpha, and cutting a sheet

**Depends on:** 18 · **Enables:** 21.

## Goal

The Rust pipeline trusts alpha that a model produced instead of keying a
backdrop that is not there, handles the soft edge a DiT leaves, and can cut
one generated sheet into its separate sprites. The chroma key stays, as the
fallback for an opaque result.

## Why

`normalize()` keys first and asks questions later: it always runs
`chroma_key` against the profile's colour, then border detection when that
removed too little. On an image with real alpha the configured key is magenta
and matches nothing, border detection then finds the dominant border colour of
what is — under the alpha — arbitrary hidden RGB (Qwen leaves purple there,
spike image `test_qwen_sword.png`), and keys it. At best that is wasted work;
at worst it punches holes in a subject that happens to share the hidden colour.

The cut is image processing, so it belongs here in Rust beside the rest of it,
not in the job.

## Files touched

- `src-tauri/src/image_gen/normalize.rs` — alpha detection, soft-edge
  threshold, `split_sheet`.
- `src-tauri/src/image_gen/commands.rs` — a `split_sheet` command returning
  the pieces with their bounding boxes.
- `src-tauri/src/image_gen/profile.rs` — `alpha_threshold`.
- `src/lib/assets/normalize.ts` — the wrapper for the new command.
- Fixtures: two sheets from the spike (one that cuts exactly, one with a
  merge), downscaled to 512 so they are small enough to commit, in a new
  `src-tauri/tests/fixtures/image_gen/`. The image tests have been synthetic
  until now; these are the first real images in the suite, and they are there
  as a regression check behind the synthetic tests, not instead of them.

## Steps

1. **Trust real alpha.** Before keying, measure the fraction of pixels with
   alpha below 8. Above a floor (start at 5%, the spike's worst transparent
   sheet was 61%) the image carries its own background: skip both keys. Below
   it, key as today. Record which path ran in `ImageStats` so the report can
   say "keyed" for a model that failed to give alpha.
2. **Hidden colour.** Zero the RGB of every pixel whose alpha is 0, before
   anything reads colour. Otherwise palette extraction and the downscale's
   colour averaging both see the purple under Qwen's alpha.
3. **Soft edges.** A DiT leaves up to 4% of pixels partly transparent (spike,
   finding 4). Pixel art wants none. Threshold at `alpha_threshold` (default
   128) to fully opaque or fully clear, after the downscale, where the edge
   pixels have already been averaged — thresholding first gives a jagged
   silhouette at 1024 that the downscale then has to average back.
4. **`split_sheet`.** Connected components on the thresholded alpha, after
   joining components closer than a gap proportional to the median piece
   size, not the canvas (the spike's `cut.py` used `width / 170` pixels, and
   that split a shopping trolley from its own handle on a 2048 sheet;
   `measurements-phase-17.md` §2). Drop components below a size floor as specks.
   Return each piece cropped, with its bounding box and centroid in sheet
   coordinates, in reading order.
5. **Keep the key.** The chroma key and border detection stay as they are for
   the opaque path. The first spike without the transparent start keyed Ming's
   white backdrops and cut four of six sheets cleanly; a model that fails to
   give alpha on one image must still produce a set.

## Build gate

```
cd src-tauri && cargo test --lib && cargo clippy --all-targets && cargo fmt -- --check
cd .. && npm run check && npm run lint && npm run format:check && npm run test
./scripts/export-ipc-types.sh   # must report no drift
```

## Test plan

Synthetic images first, per lesson 12 — a fixture passes whatever the code
does if the fixture is the only input:

- An RGBA image with 60% transparent pixels and a magenta-hued subject comes
  out with the subject intact: no key ran. Delete the alpha check and watch
  the subject lose its magenta.
- An opaque image on a flat backdrop still keys exactly as before (every
  existing keying test passes unchanged).
- Hidden RGB under alpha 0 never reaches the palette: a transparent region
  full of pure purple produces no purple palette entry.
- After normalization no pixel has alpha strictly between 0 and 255.
- `split_sheet` on nine separated squares returns nine, in reading order; on
  a square with a detached dot inside the join gap returns one; on two squares
  touching returns one (the merge is reported to the caller, not guessed at).
- The two committed fixtures: nine pieces from the exact sheet; eight from the
  merged one.

## Commit

```
feat(image): trust alpha a model produced, and cut a sheet into its sprites
```

## Rollback

Revert. Transparent results then go through the key again, which is wasteful
but not wrong for most subjects; nothing calls `split_sheet` until phase 21.
