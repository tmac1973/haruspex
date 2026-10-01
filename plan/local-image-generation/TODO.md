# Local image generation — where this stands, and what to do next

**Read this first.** It is written for a fresh session with no memory of the
work. Everything below is on branch `feat/image-generation`, **nothing
pushed**.

Last worked on: 2026-09-30.

---

## What this feature is

Haruspex generates game art from a short description, using a diffusion model
on the user's own machine. A job type (`asset_generation`) walks a spec of
assets, generates them, normalizes them to a pixel grid and a shared palette,
checks them, and writes a report. Guided planning can chain into it, and it into
autonomous coding, so an overnight run goes plan → art → code.

The plan lives beside this file: `overview.md` (read its "Revision" section
first) and `phase-01..25`.

---

## Where it stands

Phases 01–15 built a pipeline around SD1.5/SDXL: an IP-Adapter style anchor, a
chroma-keyed backdrop, per-asset generation. It works end to end, and its
output was poor.

On 2026-09-30 a spike compared two newer models that produce alpha —
Qwen-Image-2.1 and Ming-Image-0.1-Design — and they were far better. **Read
`spike-2026-09-30-dit-models.md`.** The short version:

- Generate several sprites in ONE image (a 3×3 sheet), cut them apart by
  alpha. They share a style by construction. This replaces IP-Adapter.
- **Ming-Image (MIT)** is the default. Its documented transparency prompts do
  not work; starting the sampler from the VAE latent of a transparent canvas
  at denoise 0.9 does (10 of 10 at 1024; at 2048 also needs `max_shift` 1.35).
- **Qwen-Image-2.1** is non-commercial (Qwen Research License); an option only.
- Sheets have layout faults (5 of 12 cut exactly into nine) — verify the cut.
- 64 px, not 32, as the default target size.
- Textures are unsolved.

The plan was rewritten around this: phases 17–25. Phase 16 is superseded.

## Phase status

| Phase | What it is | State |
| --- | --- | --- |
| 01–14 | Backend, ComfyUI, settings, normalization, spec, job, anchor, loop, gate, chain, local engine, catalogue | **done** (SD-era; parts replaced by 18–24) |
| 15 | Hardening, docs, end-to-end | **half done** — remainder folded into 25 |
| 16 | Anchor quality, seed honesty, baseline | **superseded**, never started |
| 17 | Measurements that decide the design | **done** — `measurements-phase-17.md` |
| 18 | Transparency in the backend; Ming + Qwen workflows | **done** — live-checked on Ming and Qwen 2.1 |
| 19 | Multi-file catalogue: Ming, Qwen 2.1 | not started |
| 20 | Normalization for alpha; cutting a sheet | **next** |
| 21 | Generate sprites and icons in sheets | not started |
| 22 | The first sheet is the anchor | not started |
| 23 | Textures | not started |
| 24 | Bundled engine runs Ming | **blocked** — sd.cpp cannot run Ming usably here (§4) |
| 25 | Verify end to end; procedural comparison | not started |

Critical path: 18 → 20 → 21 → 22. 19 and 23 can interleave once 18 is in.
24 waits on a newer sd.cpp or different hardware.

Phase 17 settled (read `measurements-phase-17.md`): transparent start works
on singles (48/48); nine per sheet at 1024 with positions spelled out (8/8
exact, subjects right) and never 2048; sheets stay consistent through the
style line plus the palette — reference images made it worse; Ming runs in
~7 GB VRAM + ~24 GB RAM, so SD1.5/SDXL go; the bundled sd-server cannot run
Ming usably on this machine yet.

---

## Lessons learned — do not rediscover these

### About the models

1. **The anchor's palette governs everything.** Every asset is quantized into
   the anchor's colours. A palette that collapsed onto one hue turns the whole
   set that colour. Still true after the pivot — phase 22 takes the palette
   from the cut pieces of the anchor sheet.
2. **CLIP reads 77 tokens** (SD1.5 and SDXL). Neither DiT family uses CLIP;
   `promptBudget.ts` goes in phase 21.
3. **Naming the key colour bleeds it into the art** (SDXL: said twice, 30% of
   subject pixels). Only matters on the opaque fallback now.
4. **Style-first decides the medium** on SD models. Not re-measured on DiT.
5. **"reference sheet" and "2x2 grid" produce floor plans on SD.** Not true on
   DiT: "a sprite sheet of nine separate game sprites in a 3 by 3 grid"
   produced exactly that on both Qwen and Ming.
6. **Ground or terrain as an anchor subject fills the background** (SD).
7. **Generation size must match the model.** SDXL at 1024, SD1.5 at 512. The
   DiT models generate at 1024 and 2048; a sheet cell must be at least four
   times the target size.
8. **Textures need a stated feature scale**, or detail averages to grey.
9. **`seed: null` is not random** — it falls through to the template's 0.
   Fixed in phase 18.
10. **Ming's RGBA prefixes do nothing** — in ComfyUI, the demo Space and the
    vendor's own code (inclusionAI/Ming-Image#5). The transparent-canvas start
    is the recipe. Its VAE round-trips alpha exactly, so do not blame decode.
11. **Top-down view is ignored in sheets** by both DiT models.
12. **Separate generations drift** in pixel scale and style even on the good
    models. Coherence comes from batching into a sheet.

### About working on this

13. **Stubbed tests hid every model problem.** The suite was green through all
    of them. Every real bug came from running against a real model and looking
    at the output.
14. **Measure before changing a threshold.** Twice a threshold looked wrong and
    the cause was upstream.
15. **Beware vacuous tests.** Test a function against synthetic inputs, not
    just today's fixture.
16. **Do not iterate on prompts with single samples.** Fixed seeds, several of
    them, and count.
17. **Check a claim against a second implementation before debugging your
    own.** Ming's missing alpha looked like a ComfyUI bug for an hour; the
    demo Space and a vendor issue showed it was the model.

---

## How to run things

### ComfyUI

`~/comfy/ComfyUI`, its own venv (uv-managed Python 3.12, ROCm torch — do NOT
use the system `python3`). Updated on 2026-09-30 from `e638023d` to
`8cfe5e1e` for Ming-Image support.

```bash
cd ~/comfy/ComfyUI
.venv/bin/python main.py --listen 127.0.0.1 --port 8188 --enable-cors-header
```

`--enable-cors-header` is required for Haruspex (ComfyUI returns 403 to any
request carrying an `Origin`, and a webview always sends one). The spike
scripts do not need it.

Models on disk (~110 GB): Ming int8 DiT + w4a8, int8 and BF16 text encoders
+ VAE (the BF16 encoder, 36.7 GB, only for the sd.cpp test — delete it if
disk matters); Qwen-Image-2.1 int8 + Qwen3-VL int8 + VAE; Z-Image-Turbo
int8; SDXL; SD1.5.

On this 16 GB card: run text encoders with `device: cpu` (Qwen's RGBA VAE
otherwise runs out of memory). Z-Image hit ROCm GPU faults that killed
ComfyUI unless models were freed between runs; `spike.py` restarts ComfyUI
when that happens.

### The spike

`~/Projects/asset-spike/` — not in the repo. `spike.py` drives ComfyUI
directly (graphs for Qwen 2.1, Z-Image, Ming); `mingclear2.py` and
`mingclear3.py` are the transparent-start recipe; `cut.py` cuts sheets;
`sheet.py` builds comparison sheets. Phase 17 continues here.

### Test projects

`~/Projects/asset-test` (82 entries, post-apocalyptic top-down, the hard case)
and `~/Projects/asset-smoke` (4 entries, quick).

## The build gate

```bash
cd src-tauri && cargo test --lib && cargo clippy --all-targets && cargo fmt -- --check
cd .. && npm run check && npm run lint && npm run format:check && npm run test
./scripts/export-ipc-types.sh   # must report no drift
```

At the last code commit: 1090 Rust tests, 2432 JS tests, clippy silent, no
drift.

## Also outstanding, unrelated to images

The **dark_times_3 controlled re-run** has never been done. The autonomous
coding pipeline fixes from the start of this work — the empty-phase guard,
the context-trimming cliff, the mute-preflight toggle — are committed and have
never been tested against a real run. `~/Projects/dark_times_3` is prepared
with the plan and `DECISIONS-coding.md` and no TODO/PROGRESS/REPORT.
