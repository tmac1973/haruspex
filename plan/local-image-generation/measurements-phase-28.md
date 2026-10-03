# Phase 28 — seamless textures on the bundled engine

2026-10-02. Ming-Image Q8_0 GGUF on sd-server `master-929-3f8527a`, RX discrete
GPU pinned, `--backend te=cpu`, 1024², euler 12 steps, cfg 1. Images and
scripts in `~/Projects/asset-spike/p25q/` (strength sweep) and
`~/Projects/asset-spike/p28/` (`drive.py` + the `seam_pass` ignored test).

## The route

sd-server's A1111 `/sdapi/v1/img2img` repaints only the masked area when the
mask is sent as `mask` (base64 grey PNG, white = repaint). `mask_image` — the
name other A1111 clients use — is silently ignored on this route: the whole
image changes.

## The recipe

1. txt2img the texture.
2. Roll it by half, so the wrap seams cross in the middle.
3. Mask a cross a quarter of the size wide over them, blurred (σ 48 at 1024)
   and doubled, so its middle is solid.
4. img2img the rolled image through the mask, strength 0.75, seed + 1.
5. Blend the repaint into the rolled image through the same mask, after
   shifting the repaint's per-channel mean over the mask to the rolled image's.
   Outside the mask the rolled image is kept byte for byte; its edges are the
   original's middle, so the tile wraps whatever the repaint does.

## Strength (cobblestone)

| Strength | Result |
| --- | --- |
| 0.6 | the old seam still shows as a line |
| 0.75 | seamless; cobbles the same size as the rest (band 128 or 256) |
| 0.9 | the band starts drawing at a different scale |
| 1.0 | cobbles half the size inside the band |

## Five textures

Seam ratio (`tiling::seam_ratio`; the job gates at 3.0 on the normalised image).

| Texture | 1024 base | 1024 tile | 64 base | 64 tile | 2×2 by eye |
| --- | --- | --- | --- | --- | --- |
| grass | 4.47 | 1.98 | 1.43 | 1.47 | seamless |
| water | 3.57 | 5.34 | 1.70 | 1.58 | seamless after tone match |
| cobble | 1.69 | 2.47 | 0.95 | 0.93 | seamless |
| planks | 3.38 | 1.02 | 1.37 | 1.82 | seamless (parquet) |
| sand | 8.19 | 3.04 | 0.91 | 1.12 | seamless |

Without step 5's tone match, water's repaint came back darker over the whole
band and tiled as a grid of dark stripes, though every detail joined. The
ratio does not see a tone shift (it measures steps across the edge, and a
feathered band has none), so this was caught by eye, and the composite now
corrects it.

At 1024 the ratio is noisy on pixel art with drawn grid lines (water's tile
borders): a line landing on the wrap edge scores high. At the size the job
gates, 64, all five pass, bases included — Ming draws repetitive textures, so
the base alone often nearly tiles, and the pass is what makes it exact.

Cost: one extra img2img per texture, ~20 s on this machine.

## Qwen 2.1: the seam pass could not run — 2026-10-03

dark_times_4 on Qwen 2.1 lost all nine textures: each base was drawn, then
the seam pass failed at once with `generate_image returned no results`. On
the idle engine, Qwen img2img worked at 512 and 768 and failed at 1024, mask
or no mask; txt2img at 1024 was fine. A throwaway server with only the VAE
on the GPU logged the cause:

    model manager cannot make enough memory available on Vulkan0:
      need 5390.30 MB device … available 4075.56 MB
    vae encode compute failed

Qwen's VAE (Wan's) needs ~5.4 GB to encode a 1024 image; with Qwen's weights
loaded a 16 GB card has ~4 GB left. Ming's VAE is far smaller, which is why
the pass was only ever tested working. With `--vae-tiling` the same request
succeeded, and the engine now starts Qwen with it.

Also: a texture whose seam pass fails is now kept, judged without the seam
gate, and reported "not seamless", instead of failing — retrying hits the
same wall.
