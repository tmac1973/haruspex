# Phase 24 re-measured: the bundled engine with GGUF weights

2026-10-02, sd.cpp `master-929` (still the latest release), RX 9070 XT,
Vulkan (RADV). Outputs in `~/Projects/asset-spike/p25q/`, converted weights in
`~/Projects/asset-spike/sdcpp/gguf/`.

## Why phase 24 looked blocked

The September test ran the ComfyUI files: int8 "convrot" DiT and a bf16 (or
int8/w4a8) text encoder. RADV reports `bf16: 0`, and the int8 convrot path is
new in sd.cpp: both fell onto slow paths. Qwen-Image-2.1 from the same kind
of files measured **39 s/step at 512 px** with the DiT on the GPU, and its
int8 text encoder **crashed (SIGBUS) on Vulkan** — it ran only on the CPU.

## With GGUF weights

| Model | Files | 1024 sheet, end to end | Transparency |
|---|---|---|---|
| Qwen-Image-2.1 | DiT Q4_K (4.2 GB, leejet), Qwen3-VL-8B Q4_K_M (5.0 GB, Qwen) | **49 s** at 25 steps, CFG 1; 91 s at CFG 4 | by prompt: 0.80–0.83 transparent, 4 of 4 |
| Ming-Image 0.1 Design | DiT Q8_0 (6.5 GB) and Ling-mini-2.0 Q4_K (10.5 GB), **converted here** with `sd-cli -M convert` | **33–39 s** at 12 steps | plain t2i: opaque (as in ComfyUI); transparent start (`-i clear.png --strength 0.9` + RGBA phrase): 0.75 |

Qwen at 512 px: 3.1 steps/s with everything on the GPU (against 39 s/step
from the int8 files). Both sheets were laid out exactly, subjects right.

Ming's first VAE decode ran out of VRAM (11.2 GB wanted, 7.9 GB free with
ComfyUI's process and the desktop resident); sd.cpp retried with 256 px tiles
on its own and succeeded.

## What it would take to ship

- **Weights.** Qwen GGUFs are published (leejet, Qwen). Ming's are not: they
  would be converted from Comfy-Org's bf16 files — on the user's machine
  (needs the 36.7 GB bf16 encoder and ~5 minutes) or once, by us, and hosted
  (Ming is MIT, so redistribution is allowed).
- **Licence.** Qwen-Image-2.1 is research and evaluation only: an opt-in at
  most. Ming is the one that can be the default.
- **VRAM.** Ming's encoder Q4_K is 10.5 GB; with the DiT that exceeds 16 GB,
  so sd.cpp's auto-fit splits it. Smaller cards need the encoder on the CPU
  (not yet timed) or a smaller quant.
- **Pin.** `fetch-sdcpp.sh` pins `master-890`; Ming needs ≥ `master-929`.

## VRAM, and the server route — measured 2026-10-02

One transparent 1024 Ming sheet, `sd-cli`, peak VRAM above a 2.0 GB desktop
baseline:

| | all on GPU | text encoder on CPU |
|---|---|---|
| wall time | 39 s | **27 s** |
| peak VRAM | 9.4 GB | **7.2 GB** |
| prompt encoding | 10.5 s | 4.1 s |

With the encoder "on the GPU", sd.cpp's auto-fit kept its 9.3 GB of weights in
RAM and streamed them over, so the CPU is both cheaper and faster; the engine
now passes `--backend te=cpu` for Ming. Both runs' first full-size VAE decode
wanted ~11 GB and retried in 256 px tiles on its own.

Through `sd-server` with the app's exact arguments and its `/sdapi/v1/img2img`
body (clear canvas, strength 0.9, RGBA phrase): RGBA, 0.846 transparent, the
seed reported in `info`, 26 s, sheet exact.
