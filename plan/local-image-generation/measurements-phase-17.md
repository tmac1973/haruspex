# Phase 17 — measurements, 2026-09-30

Answers to the five questions in `phase-17-measurements-that-decide-the-design.md`.
Same machine as the spike: Radeon 9070 XT 16 GB (ROCm 7.2 in ComfyUI, RADV
Vulkan for sd.cpp), Ryzen 9800X3D, 64 GB RAM, ComfyUI 0.38.0.

Model throughout: Ming-Image-0.1-Design, int8 DiT, w4a8 Ling text encoder on
CPU, 12 steps, CFG 1, euler, simple scheduler, the transparent start at
denoise 0.9 unless stated. Style line as in the spike. Scripts `p17.py`,
`p17_analyze.py`, `p17_floor.py`, `p17_sdcpp.py`; every image as
`raw/p17_*.png`; every number in `p17_step*.jsonl` — all in
`~/Projects/asset-spike/`.

## Summary of decisions

| Question | Answer | Decides |
| --- | --- | --- |
| 1. Transparent start on singles | **48 of 48** transparent, every subject right | Phase 21 retries can fall back to singles |
| 2. Sheet size | **3×3 at 1024**: 8 of 8 exact, subjects right and in place | Phase 21 default: nine per sheet, 1024, positions spelled out |
| 3. Consistency between sheets | **Prompt plus palette.** Reference images made it worse | Phase 22 builds no style reference; phase 18 step 5 adds no field |
| 4. Bundled engine | **Not usable today** on this machine | Phase 24 is blocked, not a version bump |
| 5. Hardware floor | Runs in **~7 GB VRAM** at the same speed, **~24 GB RAM** | Phase 19 drops SD1.5 and SDXL |

## 1. The transparent start on single sprites

The eight sprite subjects from the spike, seeds 1–3, at both flow shifts
(`mu` 1.35, the vendor's value; `mu` 1.15, ComfyUI's stock template at 1024).

| Shift | Transparent | One piece | Clear pixels | Soft pixels, worst |
| --- | --- | --- | --- | --- |
| 1.35 | 24/24 | 23/24 | 53–95% | 1.2% |
| 1.15 | 24/24 | 23/24 | 61–96% | 1.1% |

The two "two pieces" results are the same burnt car (seed 2) with a detached
scrap of debris — a correct image. Every subject was right by eye
(`p17-step1-singles.png`).

**Shift at 1024 does not matter; at 2048 it does** (spike, finding 4). Phase 18
uses 1.35 everywhere, which matches the vendor at both sizes.

Two observations for phase 21, not failures: subject size within the frame
varies a lot by seed (a coin 20% or 80% of the frame), which the crop absorbs;
and "seen top-down from directly above" was followed for the car and ignored
for the survivor and the dog, as in the spike.

## 2. Sheet size

Items and top-down lists, seeds 1–4, positions spelled out in the prompt
("top left: …; top centre: …", or "Row 1, left to right: …" for 2×2 and 4×4).
"Exact" means the cut gave exactly g×g pieces in g rows of g. Subjects were
then checked by eye for the 3×3 and 4×4 sheets.

| Grid | Size | List | Exact | Faults | Transparent | Sampling s/sheet |
| --- | --- | --- | --- | --- | --- | --- |
| 2×2 | 1024 | items | 4/4 | – | 4/4 | 18 |
| 2×2 | 1024 | top-down | 4/4 | – | 4/4 | 18 |
| 2×2 | 2048 | items | 2/4 | 2 extra | 4/4 | 83 |
| 2×2 | 2048 | top-down | 4/4 | – | 4/4 | 83 |
| **3×3** | **1024** | **items** | **4/4** | – | 4/4 | 18 |
| **3×3** | **1024** | **top-down** | **4/4** | – | 4/4 | 19 |
| 3×3 | 2048 | items | 4/4 | – | 4/4 | 83 |
| 3×3 | 2048 | top-down | 3/4 | 1 extra | 4/4 | 84 |
| 4×4 | 1024 | items | 3/4 | 1 opaque | 3/4 | 19 |
| 4×4 | 1024 | top-down | 3/4 | 1 opaque | 3/4 | 21 |
| 4×4 | 2048 | items | 2/4 | 2 extra | 4/4 | 84 |
| 4×4 | 2048 | top-down | 3/4 | 1 opaque | 4/4 | 84 |

Plus about 65 s of CPU text encoding whenever the prompt changes.

What the faults were, by eye:

- **2048 is worse, not better.** The model draws sprites at about the same
  size in pixels whatever the canvas, so a 2048 sheet gets no more detail per
  sprite — just more empty canvas, which it fills with duplicates (the 2×2
  items sheets drew extra swords and coins, the 4×4 drew a fifth row with a
  second tin of food). It is also 4.5× slower. **Sheets are 1024.**
- The one 3×3 "extra" at 2048 is a false alarm: a shopping trolley's handle
  drawn detached. Phase 20's join gap should be scaled to the sprite, not the
  canvas.
- **4×4 at 1024**: every transparent sheet had all sixteen subjects, right and
  in order. The two failures were the same seed (2) in both lists coming back
  opaque on a flat grey backdrop — layouts intact, so the chroma-key fallback
  would recover them. 16 per sheet is viable; 9 is the default because it was
  8 of 8 and costs nothing that matters (2.1 s per sprite against 1.2 s).
- **3×3 at 1024**: 8 of 8 exact, every subject correct and in its stated
  position, in both lists. Consistent across seeds too
  (`p17-step2-g3_1024.png`).

**Positions in the prompt** (step 2b). The same 3×3 sheets without positions,
as the spike prompted them: 6 of 8 exact at `mu` 1.35 and 6 of 8 at 1.15. All
four failures were seed 2: opaque twice at 1.35, an extra and a merge at 1.15.
With positions, seed 2 was exact in both lists. Small numbers — one seed's
worth of difference — but positions cost nothing and phase 21 already spells
them out, so they stay.

**Transparent-start failures overall at 1024:** 6 of 103 sheets and singles
across steps 1, 2, 2b and 3 came back opaque, all on a flat backdrop — two of
them in step 3's reference-image conditions, and all six at seed 2, which
says more about that seed than about a rate. The
chroma key stays as the fallback (phase 20 step 5), and a sheet that comes
back opaque is keyed, not regenerated.

## 3. Consistency between sheets

Eighteen items split across two sheets: A (the nine used above) and B (nine
others). Seeds 1–3. Metric: build a 16-colour palette from A's opaque pixels;
report the mean distance from each opaque pixel of another sheet to its
nearest palette colour (0–1, RGB, lower is closer to A).

| Sheet compared with A's palette | Mean | Per seed |
| --- | --- | --- |
| A itself (floor) | 0.044 | 0.045, 0.042, 0.045 |
| A at another seed (same subjects) | 0.052 | 0.050, 0.058, 0.047 |
| **B, prompt only** | **0.056** | 0.056, 0.059, 0.052 |
| B, sheet A as reference image | 0.061 | 0.061, 0.051, 0.072 |
| B, one sprite of A as reference | 0.069 | 0.074, 0.065, 0.067 |
| B, deliberately different style (control) | 0.089 | 0.076, 0.105, 0.085 |

- **Prompt only is already close.** A different nine subjects under the same
  style line sit about as far from A's palette as A's own subjects at another
  seed (0.056 against 0.052), against 0.089 for a sheet asked to look
  different. By eye the B sheets share A's outline weight, pixel size and rust
  palette (`p17s3` renders in the spike folder).
- **Reference images made it worse.** With the whole sheet A as the reference,
  Ming treated it as the image to edit: it redrew sheet A and squeezed B's
  subjects in between (2 merged sheets, 1 opaque). With one sprite from A on an
  empty canvas, it did not copy the sprite, but drew B smaller, came back
  opaque once, and moved *further* from A's palette.
- **Decision: prompt plus palette.** Every sheet uses the anchor's style line
  and is quantized to the anchor's palette, which pulls the remaining 0.056
  towards the floor by construction. No style reference is built; phase 18
  step 5's `styleReference` is recorded as not needed.

## 4. The bundled engine (sd-server)

stable-diffusion.cpp `master-929-3f8527a` (27 Sept), Linux Vulkan build,
against the ComfyUI files.

- **It needs the BF16 text encoder.** It refuses the int8 and w4a8 ones:
  "Ming-Image INT8/W4A8 text encoder experts are not supported; use the BF16
  text encoder". That is a 36.7 GB download, on top of the 6.2 GB DiT.
- **Two Vulkan devices.** The Ryzen iGPU appears as `Vulkan1`; unpinned, the
  engine may choose it. Pinning must be explicit
  (`--backend diffusion=Vulkan0,vae=Vulkan0,te=cpu`).
- **It did not work.** With the text encoder on the GPU the device was lost
  (`ErrorDeviceLost`) during prompt encoding. With it on the CPU and the model
  pinned to the 9070 XT, sampling ran at **~120 s per step** — about 80 times
  slower than ComfyUI's 1.5 s on the same card — and the VAE failed
  ("wan_vae segment 1/1 failed during weight preparation"), so the alpha
  question could not be answered.
- Not tried: the BF16 DiT (12.3 GB) in case int8 convrot is the slow path on
  Vulkan; any NVIDIA or Metal machine.

**Decision:** phase 24 is blocked as written. Without a working local engine,
Ming is ComfyUI-only for now. Phase 24 is re-scoped to re-test on a newer
sd.cpp build and on non-AMD hardware before any code; meanwhile the local
backend keeps whatever phase 19 leaves it able to load, and the settings copy
says the local engine does not run Ming yet.

## 5. The hardware floor

ComfyUI restarted with `--reserve-vram` to leave less of the card usable;
three 3×3 sheets each; VRAM from the driver (the desktop uses about 1.2–1.5 GB
of that), RAM as ComfyUI's peak resident set.

| Reserved | Peak VRAM (whole card) | Peak RAM (ComfyUI) | s/sheet | Results |
| --- | --- | --- | --- | --- |
| none | 15.8 GB | 17.0 GB | 18 | 3/3 exact, identical images |
| 10 GB | 8.8 GB | 24.2 GB | 20 | 3/3 exact, identical images |
| 12 GB | 8.1 GB | 22.9 GB | 20 | 3/3 exact, identical images |

The 8 GB run is left out: a stray ComfyUI restart from the previous run
overlapped it and its numbers are not trustworthy.

`--reserve-vram` is advisory — with 12 GB reserved ComfyUI still used about
6.7 GB — but that is the finding: Ming sits in **about 7 GB of VRAM** at full
speed once the text encoder is on the CPU, and the same seeds gave
byte-identical sheets. It needs **about 24 GB of RAM** for the encoder.

**Decision:** SD1.5 and SDXL leave the catalogue (phase 19 step 4). Machines
below 8 GB of VRAM, which SD1.5 served, lose image generation; the
catalogue's hardware line says so, and the Settings row warns rather than
hides, as before.

## Changes these make to phases 18–25

- **18** — `max_shift` 1.35 at a 1024 reference size for all sizes. No
  `styleReference`. Sheet prompts spell out positions (phase 21 step 2
  already says so).
- **19** — SD1.5 and SDXL removed. Hardware line: ~8 GB VRAM, ~24 GB RAM.
  The local engine's Ming entry would need the 36.7 GB BF16 encoder; do not
  add it until phase 24 works.
- **20** — the join gap for `split_sheet` scales with sprite size, not canvas
  size.
- **21** — nine per sheet at 1024; never 2048. A sheet that comes back opaque
  is keyed, not regenerated.
- **22** — consistency is the style line plus the palette; nothing else.
- **24** — blocked; re-scoped as above.
