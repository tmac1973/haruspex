# Qwen-Image-2.1 Turbo against the base model — measured 2026-10-15

Should Qwen-Image-2.1-Turbo replace Qwen-Image-2.1, be offered beside it, or
neither? Measured on an AMD Radeon AI PRO R9700 (32 GB, RADV), Fedora 44.

## What Turbo is

The same 7B model distilled to sample in **8 steps at CFG 1**, against the base
model's 25. It ships its own noise schedule, `sample_sigmas` in
`model_index.json`:

    1.0, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568 (, 0)

That schedule stays near full noise for six of its eight steps and falls late.
Neither engine's stock scheduler produces it.

Same licence as the base model: the Qwen Research License, its LICENSE file
byte-identical. Same text encoder (Qwen3-VL-8B) and VAE. The files are the same
size: Comfy-Org's `qwen_image_2.1_turbo_int8_convrot.safetensors` is 7.26 GB,
as the base int8 is, and unsloth's `qwen-image-2.1-turbo-Q4_K_M.gguf` is
4.20 GB against leejet's base Q4_K at 4.20 GB.

## Method

Four prompts (a photo of a snowy cabin, a poster with the title text "LISBOA",
a pixel-art knight sprite sheet, a close-up portrait) and two transparent ones
wrapped as the app wraps them (`qwen21Transparent`: a potion, a tree), two seeds
each, 1024 × 1024. Three settings per engine:

- **base25**: the base model, 25 steps, euler, as shipped until now.
- **turbo8**: Turbo, 8 steps, the engine's stock schedule (sd.cpp's Flux
  scheduler; ComfyUI's `simple`).
- **turbo sigmas**: Turbo on its own schedule (`--sigmas` for sd-server,
  `ManualSigmas` + `SamplerCustom` in ComfyUI).

Plus the bundled engine's seamless-texture pass, reproduced exactly (texture,
roll by half, repaint `tiling::seam_mask` at strength 0.75, `tiling::composite`,
`tiling::seam_ratio`) on five textures × two seeds.

## Speed

| Engine | base25 | Turbo | |
|---|---|---|---|
| sd-server, Q4 GGUF, a 1024 image end to end | 48.6 s | 18.8 s | 2.6× |
| ComfyUI, int8, sampling with the prompt already encoded, idle GPU | 16.4 s | 5.0 s | 3.3× |

The two schedules cost the same. ComfyUI's text encoder runs on the CPU in our
graphs, so a new prompt adds about 45 s there whichever model draws it.

## Quality

Turbo is no worse than the base model on any prompt, in either engine. Text
rendering held ("LISBOA" spelled right in all 12 posters). On its own schedule
Turbo is cleaner than on the stock one: the stock schedule drew grainier,
over-sharpened portraits and textures, and its sprite sheets kept the
character less consistent from cell to cell.

## Transparency

Fraction of pixels under half alpha, potion and tree × 2 seeds:

| Engine | base25 | turbo8 | turbo sigmas |
|---|---|---|---|
| sd-server | 0.63 0.69 0.62 0.63 | 0.65 0.72 0.62 0.61 | 0.64 0.71 0.63 0.62 |
| ComfyUI | 0.58 0.84 0.52 0.69 | 0.64 0.84 0.52 0.63 | 0.61 0.85 0.52 0.67 |

All 24 transparent requests came back transparent.

## Seamless textures (sd-server)

Seam ratio after the repaint (the job's gate fails above 3):

| | cobble | grass | water | planks | sand |
|---|---|---|---|---|---|
| base25 | 1.56 1.55 | 1.13 1.34 | 1.92 2.30 | **4.96** 2.78 | 1.20 1.12 |
| turbo8 | 1.42 1.66 | 1.29 1.42 | 1.98 2.33 | **4.43** 1.95 | 1.14 1.13 |
| turbo sigmas | 1.62 1.53 | 1.07 1.21 | 1.50 1.77 | **3.20** 1.67 | 1.02 1.09 |

Turbo's schedule seams best. At strength 0.75 the repaint starts at noise
0.954, near full, so the raw repaint of the grass came back visibly darker
across the band, but `composite`'s tone match removes it. One planks seed fails
under every setting.

## Decision

Replace, in both engines, on Turbo's own schedule.

- **Bundled engine**: entry `qwen21` keeps its id and lists the Turbo GGUF;
  `engine_args` starts sd-server with `--sigmas`. A user with the base model
  downloads only the 4.2 GB DiT; the finished download deletes the old one.
- **ComfyUI**: a family of its own, `qwen21_turbo` (filename contains `turbo`),
  with `qwen21_turbo_t2i.json`. The install set is Turbo. A base model already
  on a server stays `qwen21` and keeps its 25-step graph, because Turbo's
  schedule on the base model, or 8 stock steps, would not be what was measured.

Not taken: Comfy-Org's Turbo LoRA for the base model. It adds a file and a
loader node to reach what the Turbo checkpoint, the same size, does alone.
