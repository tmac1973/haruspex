# Local image generation — where this stands, and what to do next

**Read this first.** It is written for a fresh session with no memory of the
work. Everything below is on branch `feat/image-generation`, 45 commits ahead
of `origin/main`, working tree clean. The branch is pushed to
`origin/feat/image-generation`; **nothing is merged to `main`**.

Last worked on: 2026-09-22.

---

## What this feature is

Haruspex generates game art from a short description, using a diffusion model
on the user's own machine. A job type (`asset_generation`) walks a spec of
assets, generates each one, normalizes it to a pixel grid and a shared palette,
checks it, and writes a report. Guided planning can chain into it, and it into
autonomous coding, so an overnight run goes plan → art → code.

The plan lives beside this file: `overview.md` and `phase-01..18`.

---

## Phase status

| Phase | What it is | State |
| --- | --- | --- |
| 01 | Image backend interface, registry, settings | **done** |
| 02 | ComfyUI backend, bundled field-mapped workflows | **done** |
| 03 | Settings → Image, probe, single-image test path | **done** |
| 04 | Rust normalization pipeline (key, crop, quantize, downscale, outline) | **done** |
| 05 | Asset spec schema, parser, writer, validation | **done** |
| 06 | `asset_generation` job type, five stages | **done** |
| 07 | Spec stage — load or derive | **done** |
| 08 | Style anchor stage | **done** |
| 09 | Generation loop, per-entry degradation | **done** |
| 10 | Quality gate, bounded retries, report, contact sheet | **done** |
| 11 | Chain: guided planning → assets → coding | **done, never run for real** |
| 12 | Fetch/bundle the stable-diffusion.cpp sidecar | **done** |
| 13 | Local engine supervision + backend | **done, never run through a job** |
| 14 | Model catalogue and licensing | **done** |
| 15 | Hardening, docs, end-to-end verification | **half done** — see below |
| 16 | Anchor quality, seed honesty, quality baseline | **not started** |
| 17 | Model residency on shared-memory (iGPU) machines | **not started** |
| 18 | Settings → Image as a form, checkpoint dropdown | **not started** |

### Phase 15, precisely

Done: the success criteria that can be tests are tests
(`asset-generation/endToEnd.test.ts`), the Windows path-escape rules have their
own group, live checks are env-gated behind `HARUSPEX_IMAGE_E2E=1` +
`HARUSPEX_IMAGE_BACKEND_URL`, and `docs/image-generation.md` is a full guide.

**Not done, and all of it needs a human at a machine:**

- The coherence judgement — open a run's `contact-sheet.png` and decide whether
  the set reads as one game. No test can answer this. If it fails, name the
  layer (reference conditioning, palette, or grid) and the remedy is bounded to
  DATA: profile defaults, prompt wording, sampler settings.
- A full asset job against the **bundled engine**. The engine is verified to
  start, load SD1.5, register Vulkan and answer both routes; no job has ever
  run through it.
- **macOS and Windows: nothing is verified at all.** The `sd-libs`
  co-location logic is Linux-tested only; macOS uses `DYLD_LIBRARY_PATH` and
  Metal.
- Packaged builds: that sidecars and `sd-libs` land correctly and nothing
  starts at boot.

---

## The state of the art it actually produces

Be honest about this: **the pipeline works end to end, and the output is not
good yet.**

The last real run (89 entries, post-apocalyptic top-down tileset, SDXL via
ComfyUI) produced assets that all looked alike — everything pink and grey and
brick-shaped, including water and grass. Earlier runs produced everything green.
An earlier smaller run (4 entries) produced a decent coin and cobblestone and a
poor sword.

The user's own read: the procedurally generated tilemaps an earlier autonomous
coding run produced **may look better** than these. That comparison is phase 16
step 4 and is still outstanding.

---

## Lessons learned — do not rediscover these

Each one cost a real run.

### About the pipeline

1. **The anchor's palette governs everything.** Every asset is quantized into
   colours extracted from the style anchor. An anchor whose palette collapsed
   onto one hue turns the whole set that colour whatever each prompt says. This
   is the single highest-leverage thing in the design and the one most likely
   to be wrong.
2. **CLIP reads 77 tokens.** SD1.5 and SDXL both. A longer prompt is not
   rejected — ComfyUI chunks it — but later chunks barely register, so whatever
   comes last is effectively dropped. Most failures traced back to this.
   Reordering does not help; only total length does.
3. **Naming the key colour bleeds it into the art.** Measured on SDXL:
   naming it twice tinted 30% of subject pixels that colour, once 12%, a
   neutral backdrop 0%. Since the palette comes from the art, a magenta
   backdrop said twice is how a set comes out pink.
4. **Style-first decides the medium** — leading with subjects and appending the
   style produced an oil painting; leading with "16-bit pixel art" produced
   pixel art. But this only holds when the style is SHORT, because of (2).
5. **"reference sheet" and "2x2 grid" produce floor plans.** Reliably.
6. **Naming ground or terrain as an anchor subject fills the background with
   it**, destroying the flat backdrop the key depends on. Textures are excluded
   from anchor subjects for this reason.
7. **SDXL is markedly better than SD1.5 at composition**, which is a
   precondition of background removal rather than a matter of taste. Measured:
   subjects SD1.5 could not produce at all came out cleanly. `upscale` must be
   32 for SDXL (native 1024) and 16 for SD1.5 (native 512) at a 32px target;
   generating below native produces mush.
8. **Textures need a stated feature scale.** SDXL rendered cobblestone as
   hundreds of tiny tiles; downscaled to 32px each stone was under a pixel and
   the result was flat grey (entropy 0.00). Sprites want ONE large subject;
   textures want FEW large features.
9. **`seed: null` is not random** — it falls through to the workflow template's
   default of 0. Every unpinned first attempt is identical. This is phase 16
   step 2 and is still unfixed.

### About working on this

10. **Stubbed tests hid every one of these.** The suite was green through all
    of it. Every real bug came from running the thing against real ComfyUI and
    looking at the output.
11. **Measure before changing a threshold.** Twice a threshold looked wrong and
    the real cause was upstream: `palette_distance_max` looked too tight but
    `palette_size` was too small, and a hue check looked broken but the palette
    was full of backdrop. Both times the fix was the cause, not the number.
12. **Beware vacuous tests.** Several mutations survived because a test only
    exercised the currently-committed fixture, which had everything switched
    on — a hardcoded `true` passed identically. Test a function against
    synthetic inputs, not just against today's data.
13. **Do not iterate on prompts with single samples.** Diffusion output is high
    variance; one generation proves little. Fixed seeds and A/B pairs, or don't
    bother.

---

## Open issues, in the order worth doing

### 1. Let the derivation turn choose the anchor subjects — phase 16 step 3b

**This is the next thing to do.** `anchorSubjects()` picks round-robin across
kinds, which on the real spec chose a survivor, a heart icon, a raider and a
radiation icon — two humanoids and two flat symbols. SDXL rendered large
character portraits, the palette came out pink and grey, and every asset was
quantized into it.

Two tangled failures, one fix:

- **Composition** — a subject list that is mostly humanoid characters composes
  as a character sheet whatever the closing instruction says.
- **Spread** — four subjects cannot span a set containing asphalt, concrete,
  grass, water, rust, blood and characters. Whatever four are picked, the
  palette describes those four.

Neither is fixable mechanically, because both need to know what the subjects
LOOK like. The derivation turn does: it wrote all 89 entries. So add an
explicit list to the spec — three or four short phrases chosen for visual
spread — and have `anchorSubjects()` use it when present, falling back to the
current behaviour when absent (older and hand-written specs).

Verify by measurement, not eye: with the list present, `image_palette_spread`
should use more hue buckets on the same spec, and the assets' median
`palette_distance` should fall.

### 2. Evaluate a non-CLIP model — related to phase 16 step 3

Qwen-Image or Z-Image-Turbo use an LLM text encoder rather than CLIP, so
lesson (2) — the 77-token window, which caused most of the failures — simply
does not apply. Every workaround built for it (style budgets, subject
truncation, whole-prompt budgeting) is scaffolding around a limitation these
models do not have.

The cost: both are DiTs, so IP-Adapter reference conditioning and
circular-padding seamless tiling stop working — two of three coherence layers.
The DiT tiling remedy is offset-and-inpaint (shift the tile by half, inpaint
the seams, shift back), which is real work.

But the reframe matters: those layers exist because SD1.5 drifts. A model that
follows prompts well enough may not need reference conditioning at all, and
palette and grid are mechanical and keep working. That is a thing to measure,
not assume.

Practical: **Z-Image-Turbo first** (6B, Apache 2.0, ~8 steps, fits 16 GB) —
same no-CLIP benefit, fast enough to iterate. Qwen-Image is ~20B and needs a Q4
GGUF on a 9070 XT. Qwen-Image-Edit is the long game: generate one hero asset
then *edit* it into variants, which is a better coherence strategy than
conditioning.

**Do 1 and 2 separately, in that order.** Doing both at once means not knowing
which helped.

**Qwen-Image 2.1 (released 2026, checked 2026-09-22).** 7B on an MMDiT
architecture, native 2K, generation and editing in a single checkpoint — and
it outputs **RGBA with a real alpha channel**. Licence: Qwen Research
License, **non-commercial only**; commercial use needs a separate agreement
from Alibaba. Earlier Qwen-Image releases were Apache 2.0; this one is not.

Three things follow, and they pull in different directions.

*The alpha channel may delete a whole layer of this design.* Background
removal is a chroma key against a flat backdrop the prompt asks for and the
model does not reliably give — that is the constraint in overview.md
("Models do not obey colour or composition instructions"), and it is the
direct cause of lessons (3) and (6): naming the key colour bleeds it into
the art, and naming ground among the anchor subjects destroys the backdrop.
A model that emits its own alpha needs no key, no flat backdrop, and no
colour named in the prompt at all. That is a bigger win than the 77-token
fix, and it is worth measuring on that basis alone.

*7B is tractable where ~20B was not.* The sizing note above is about the
original Qwen-Image and does not carry over. This is in Z-Image-Turbo's
class rather than a 9070 XT-only experiment.

*The licence disqualifies it as a default.* An overview goal is to default
to commercially safe weights "so a user who later sells their game is
protected by the default rather than by having read a licence", and
`recommended_id` never recommends a non-commercial model at any VRAM. So
2.1 can be a catalogue entry with `commercial_use: false` behind the
existing confirm dialog, and it can be what WE evaluate against — but it
cannot become what a user gets by doing nothing. Whatever it teaches about
alpha has to be portable to a permissive model, or it is a dead end for the
shipped default.

Still unchecked: whether ComfyUI's Qwen-Image 2.1 support covers what this
pipeline needs, and whether stable-diffusion.cpp can load it at all — the
bundled engine matters more than the ComfyUI path for shipping.

Either way it does not displace issue 1 — the anchor-subject fix is cheaper,
is a known cause, and its result is what tells you whether a better base
model is even needed.

### 3. Phase 16's other steps

- **Seed honesty** (step 2): `seed: null` resolves to the template default 0
  rather than a random seed, so `meta.seed` records a seed nobody chose and the
  anchor recipe's reproducibility claim is weaker than it reads.
- **Texture feature scale** (from the SDXL findings): texture prompts need to
  say how many features span the tile.
- **Isolation is not guaranteed** — a coin filled the frame despite being told
  not to. Better prompt adherence raises the hit rate; phase 10's retry path
  stays load-bearing.
- **The procedural comparison** (step 4): generate the same small set both ways
  and write down which looks better, including if the answer is the procedural
  one. It decides how much further this is worth pushing.

### 4. Finish phase 15

Everything in the "not done" list above. Mostly needs hands on macOS/Windows
machines and a human judging a contact sheet.

---

### 5. Settings → Image is a sentence with input boxes in it — phase 18

Independent of everything above, and cheap. The panel puts a trailing prose
fragment after every control (`<input> <span>server address</span>`), so it
reads as a sentence rather than a form, and the checkpoint is free text the
user types from memory.

The probe already fetches the full checkpoint list from
`object_info/CheckpointLoaderSimple` and throws it away after testing the
configured name for membership, so the dropdown is surfacing data already on
the wire. Wanted shape: URL, optional API key, Probe, then a checkpoint picked
from what the server reported.

Worth doing whenever there is an hour spare — it touches none of the quality
work and cannot conflict with it.

### 6. The job needs both models at once, and an iGPU has room for one — phase 17

Not urgent on the dev machines, and blocking for the laptops most users have.

The asset job wants the LLM for the spec and quality-gate stages and the image
model for the anchor and generation stages. On integrated graphics those are
one shared pool. Measured on a Radeon 780M with 16 GB system RAM: the GPU can
actually allocate ~7.7 GiB (`mem_info_gtt_total`, matching the Vulkan heap),
while `mem_info_vram_total` — which is what `hardware.rs` reads — reports
16384 MiB, an aperture rather than a reservation.

Two defects fall out. `recommended_id` would offer that laptop SDXL at 6.94 GB
against a 7.7 GiB ceiling it must also share with the LLM; and nothing
sequences the two models, so both are resident at once. `hardware.rs` already
carries a `gpu_integrated` flag and guards quant and context sizing with it —
the image path is the one place that takes a bare `u32` and trusts it.

Both engines already expose start/stop (`ImageEngine`, `LlamaServer`), so the
sequencing is orchestration rather than new plumbing. The open question the
phase must answer rather than assume: whether stopping the app's main
inference server mid-run is safe, given something other than this job may be
using it.

## How to run it

ComfyUI lives at `~/comfy/ComfyUI`. Start it with its own venv (uv-managed
Python 3.12, ROCm torch — do NOT use the system `python3`):

```bash
cd ~/comfy/ComfyUI
.venv/bin/python main.py --listen 127.0.0.1 --port 8188 --enable-cors-header
```

**`--enable-cors-header` is required.** ComfyUI returns 403 to any request
carrying an `Origin` header, and a webview always sends one. Without it
Haruspex cannot reach it at all. (A narrow origin is safer than the default
`*`, which lets any page you visit drive your ComfyUI.)

Settings → Image: backend ComfyUI, URL `http://127.0.0.1:8188`, checkpoint
`sd_xl_base_1.0.safetensors`.

Test projects: `~/Projects/asset-test` (89 entries, the hard case) and
`~/Projects/asset-smoke` (4 entries, quick).

To re-run cleanly: delete `assets/haruspex-anchor.png` and `.json`, delete
`assets/generated/`, and check `normalize.upscale` is 32 for SDXL.

## The build gate

```bash
cd src-tauri && cargo test --lib && cargo clippy --all-targets && cargo fmt -- --check
cd .. && npm run check && npm run lint && npm run format:check && npm run test
./scripts/export-ipc-types.sh   # must report no drift
```

At last commit: 1090 Rust tests, 2432 JS tests, clippy silent, no drift.

## Also outstanding, unrelated to images

The **dark_times_3 controlled re-run** has never been done. The autonomous
coding pipeline fixes from the start of this work — the empty-phase guard,
the context-trimming cliff, the mute-preflight toggle — are committed and have
never been tested against a real run. `~/Projects/dark_times_3` is prepared
with the plan and `DECISIONS-coding.md` and no TODO/PROGRESS/REPORT.
