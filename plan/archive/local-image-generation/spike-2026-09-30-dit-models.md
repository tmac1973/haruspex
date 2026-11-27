# Spike, 2026-09-30 — DiT models with native alpha

Measurements that justify the pivot in phases 17–25. Scripts and every image
are in `~/Projects/asset-spike/` (outside the repo, not committed). Hardware:
Radeon 9070 XT 16 GB (ROCm 7.2), 64 GB RAM, ComfyUI 0.38.0.

## What was compared

Same subjects, same seeds (1 and 2), same style line
("16-bit pixel art, flat shading, bold dark outlines, desaturated
rust-and-concrete palette"), against the last SDXL pipeline run on
`~/Projects/asset-test`.

| Model | Licence | Alpha | Text encoder |
| --- | --- | --- | --- |
| SDXL 1.0 (the current pipeline) | OpenRAIL++-M | chroma key | CLIP, 77 tokens |
| Qwen-Image-2.1, int8 | **Qwen Research License — non-commercial** | native, from a prompt prefix | Qwen3-VL 8B |
| Ming-Image-0.1-Design, int8 | **MIT** | native, but see below | Ling-mini-2.0 |
| Z-Image-Turbo, int8 | Apache 2.0 | none — chroma key | Qwen3 4B |

## Findings

1. **Both alpha models are far better than SDXL for sprites.** SDXL's last run
   was pink, brick-shaped and unreadable. Qwen and Ming produced readable pixel
   art in the right colours on the first try, with no isolation scaffold, no
   prompt budget and no anchor.
2. **The sheet is the coherence mechanism.** Asking for nine named subjects in
   a 3×3 grid in ONE image produces nine sprites in one style, by construction.
   Qwen: 6 of 6 sheets cut by alpha into exactly nine. Separate generations of
   the same subject at different seeds drift in pixel scale and style — so
   coherence comes from batching, not from conditioning.
3. **Ming's documented RGBA prefixes do not work.** 0 of 20 prompts in ComfyUI
   (all ten prefixes, Chinese and English, JSON caption, both encoder quants),
   0 of 3 on the public demo Space, and inclusionAI/Ming-Image#5 reports the
   same from the vendor's own `infer.py`. The VAE is not at fault: a
   transparent sprite round-trips through `ming_image_vae` at 89.2% → 89.2%
   transparent, mean alpha error 1.8/255.
4. **Ming alpha recipe that works: start from a transparent canvas.** Encode a
   fully transparent RGBA image with the Ming VAE and sample from it
   (img2img) at denoise 0.9. 1024: 10 of 10 transparent at denoise 0.8–0.9
   (61–85% of pixels clear, ≤ 4% soft). 0.95 and 1.0 stayed opaque. 2048 also
   needs the vendor's shift — `mu = 1.35` at ≥ 4096 latent tokens, which is
   `ModelSamplingFlux(max_shift=1.35, width=1024, height=1024)`; with ComfyUI's
   extrapolated default it stayed opaque. With it, 4 of 4 transparent.
5. **Ming sheets have layout faults.** Transparent-start sheets cut into exactly
   nine sprites 5 times of 12. The rest: a duplicated subject, a missing one,
   or two touching sprites cut as one. The pipeline must verify the cut, not
   trust it.
6. **Top-down view is ignored in sheets** by both models ("seen top-down from
   directly above" yields three-quarter and side views). Singles followed it
   better (Qwen: the car and the turret).
7. **32 px is too small for complex subjects.** Items survive; characters,
   vehicles and buildings turn to mush. 64 px holds up for everything tested.
   The model draws a pixel grid of roughly 6–8 screen pixels per art pixel at
   1024, so its native "art resolution" for a 1024 sheet cell is well above 32.
8. **Textures are unsolved.** Qwen: painterly, not seamless (wrap-edge jump
   2.7–6.5× the interior mean). Ming: 3 of 5 scored near-seamless by the same metric
   (0.3–0.6), but the metric is fooled — the asphalt, one of those three, and
   the grass both drew a small tile repeated in a grid with visible gutters. Z-Image:
   chunkiest and most tile-like, some framed. Nothing here is a tileable
   texture without further work.
9. **Reference conditioning by editing was not made to work.** Feeding a
   finished Qwen sprite in as `<image1>` returned that sprite under both
   wordings tried. The wiring was not ruled out.
10. **Speed, on this card.** Ming sampling ~19 s at 1024, ~83 s at 2048, 12
    steps; its text encoder on CPU adds ~65 s per new prompt. Qwen ~72–92 s
    at 1024, ~280 s at 2048, 25 steps. A nine-sprite Ming sheet costs about
    as much as two SDXL singles.
11. **Operational.** On 16 GB, both text encoders had to run on CPU (the Qwen
    RGBA VAE decode otherwise runs out of memory). Z-Image hit ROCm GPU faults
    that killed ComfyUI three times unless models were freed between runs.

## Licensing, as read on 2026-09-30

- **Ming-Image-0.1-Design** — MIT, LICENSE file read in both the Hugging Face
  and GitHub repositories. Commercial use permitted.
- **Qwen-Image-2.1** — Qwen Research License (20 Sept 2026). Section 2 grants
  use "FOR NON-COMMERCIAL PURPOSES ONLY", defined as "research or evaluation
  purposes only". QwenDevs said on X that outputs are not licensed Materials
  and users keep the rights to them; that is about ownership, not permission
  to run the model commercially, and the LICENSE file is unchanged. Haruspex
  may offer it as a download; the user carries the restriction.
- **Ideogram 4.0** — non-commercial weights; not tested.

## Where to look

- `cut-qsheet_items_2048_s1.png` — Qwen sheet, cut, at full size, 32 and 64 px.
- `cut-mc_items_1024_s2_d90.png`, `cut-mc_topdown_2048_s1_d90_mu135.png` —
  Ming with the transparent start.
- `sheet-sprites.png`, `sheet-textures.png` — SDXL vs Qwen vs Z-Image singles.
- `ming-sheets-raw.png`, `ming-textures.png` — Ming without the trick.
