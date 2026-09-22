# Phase 17 — Model residency on shared-memory machines

**Depends on:** 09 (the generation loop, so there is a stage boundary to swap
at) · 13 (the local engine, which owns the image model's lifetime) ·
**Enables:** the asset job on integrated-GPU laptops, which is most laptops.

## Why this phase exists

The asset job uses two models. The spec and quality-gate stages want the LLM;
the anchor and generation stages want the image model. On a machine with
discrete VRAM plus system RAM these live in different places and nobody
notices. On an integrated GPU they are the same pool, and the job asks for both
at once.

Measured on a CachyOS laptop with a Radeon 780M and 16 GB of system RAM:

| Figure | Value |
| --- | --- |
| `mem_info_vram_total` (what `hardware.rs` reads) | 16384 MiB |
| Kernel GTT limit (`mem_info_gtt_total`) | 7884 MiB |
| Vulkan device-local heap | 7.90 GiB |
| Physical RAM | 16 GB, shared with the OS |

The first row is an aperture, not a reservation — it is the same RAM the OS is
already using, counted a second time. The real ceiling on what the Vulkan
backend can allocate is the third row, and it agrees with the second.

Two separate defects follow, and they are worth fixing in one phase because
neither is safe alone: correcting the recommendation without sequencing the
job just recommends a smaller model that still has to share, and sequencing the
job without correcting the recommendation still hands a 16 GB laptop a 6.94 GB
checkpoint.

### Defect 1 — the image recommendation trusts a number it should not

`image_models.rs::recommended_id(vram_mb)` returns `sdxl` at
`vram_mb >= 10_240`. Its input comes from `hardware.rs::get_linux_vram_mb()`,
which reads `mem_info_vram_total` and takes the largest value across cards —
deliberately, so a discrete GPU is not shadowed by an integrated one's small
carve-out. That reasoning is sound when a carve-out is small. It fails when the
carve-out is the whole of system memory, which is what a modern APU reports.

So the machine above is recommended SDXL at 6.94 GB against a 7.7 GiB ceiling
it must also share with the LLM.

`hardware.rs` already knows better everywhere else: it carries `gpu_integrated`,
forces 4-bit quant on integrated GPUs because they "share system memory", and
guards context sizing with `Some(vram_mb) if !gpu.integrated`. The image path is
the one place that takes a bare `u32` and trusts it. The existing tests
(`4_096`, `8_192`, `10_240`, `24_576`) never exercise a UMA machine, which is
why this survived.

### Defect 2 — nothing sequences the two models

Neither engine is told to get out of the way while the other works. The
plumbing to do it already exists on both sides and is not used together:

- `ImageEngine::start(app, model_path)` / `stop()` / `loaded_model()` in
  `image_engine.rs`;
- `LlamaServer::start(..)` / `stop()` in `server/mod.rs`.

This is orchestration, not new machinery. What it is not is free — a reload
costs seconds to tens of seconds, and the generation stage is the long one, so
the swap must happen at stage boundaries and not per entry.

## Goal

Make the asset job complete on a shared-memory machine: recommend a model that
fits what the GPU can actually allocate, and arrange that only one of the two
models is resident at a time.

## Files touched

- `src-tauri/src/hardware.rs` — report a usable figure on shared-memory
  machines, not the aperture. `get_linux_vram_mb` and whatever carries it.
- `src-tauri/src/image_models.rs` — `recommended_id` learns about integrated
  GPUs; `image_model_recommended` passes the flag through.
- `src/lib/agent/jobs/types/asset-generation/` — the stage sequence that
  releases one model before acquiring the other.
- `src-tauri/src/server/mod.rs`, `src-tauri/src/image_engine.rs` — only if the
  existing start/stop surfaces prove insufficient. Prefer using them as they
  are.
- `docs/image-generation.md` — a section on shared-memory machines.
- Tests for each.

## Steps

### 1. Report what can be allocated, not what is advertised

On Linux, read `mem_info_gtt_total` alongside `mem_info_vram_total` and, when
the device is integrated, report the smaller. The GTT figure is the kernel's
own limit on how much system RAM it will hand the GPU, and it matched the
Vulkan heap exactly on the test machine.

Keep the existing "largest across cards" behaviour for discrete GPUs — it is
there for a reason and a laptop with both an APU and a dGPU still needs it.

Do not attempt this on Windows or macOS in this phase. Apple Silicon is
genuinely unified and `detect_gpu` already special-cases it; Windows reads a
registry value whose UMA semantics have not been checked. Say so rather than
guessing.

### 2. The image recommendation takes the integrated flag

Change `recommended_id` to accept whether the GPU is integrated, and never
recommend SDXL on one regardless of the reported figure — not because 6.94 GB
could never fit, but because on a shared pool the figure that would justify it
is not trustworthy and the LLM needs room in the same pool.

Add the UMA case to the test table. The current cases pass either way, which
is what let this through; a test that fails before the change and passes after
is the point.

### 3. Sequence the job so one model is resident at a time

Establish, by reading the stage code rather than assuming, where the real
boundaries are. The expectation from the phase 06 design is:

| Stage | Wants |
| --- | --- |
| Spec (load or derive) | LLM |
| Style anchor | image |
| Generation loop | image |
| Quality gate | LLM, if it judges with the model |
| Report | neither |

If that holds, there are two transitions, not five, and the generation loop —
the expensive stage — sits entirely inside one residency.

Gate the whole behaviour on the machine needing it. A discrete-GPU user must
not pay two model reloads per run to solve a problem they do not have. The
condition is the integrated flag from step 1, not a setting the user has to
find.

The LLM side needs care the image side does not: the image engine is opt-in and
already starts and stops on demand, whereas the LLM is the app's main
inference server and something else may be using it. Stopping it mid-run
because an asset job wants the memory is a decision with consequences beyond
this job, and this phase must either establish that it is safe or confine
itself to the image side. **Do not assume.**

### 4. Verify on the machine that has the problem

Run a small spec (`~/Projects/asset-smoke`, 4 entries) end to end on the 780M
laptop with the bundled engine, and record: peak memory, whether it completed,
and the wall-clock cost of the swaps. A phase about memory that was never run
against a constrained machine has not been verified, only written.

This is the same lesson as (10) in the TODO — stubbed tests were green through
every real failure this project has had.

## Build gate

```
cd src-tauri && cargo test --lib && cargo clippy --all-targets && cargo fmt -- --check
cd .. && npm run check && npm run lint && npm run format:check && npm run test
./scripts/export-ipc-types.sh   # recommended_id's signature crosses IPC
```

## Test plan

- `get_linux_vram_mb` on a synthetic sysfs tree: an integrated card reporting a
  16384 MiB aperture and a 7884 MiB GTT reports the GTT; a discrete card with
  no GTT file is unchanged; a machine with both still reports the discrete
  card's figure.
- `recommended_id` never returns `sdxl` when the GPU is integrated, at any
  reported VRAM including 24576. Verify it has teeth by reverting the guard and
  watching it fail.
- The existing discrete-GPU cases are untouched.
- The stage sequence releases the first model before acquiring the second, by
  observing the calls rather than by reading the code — a test that only
  asserts the current call order proves nothing about residency.
- On a machine reporting a discrete GPU, no swap occurs at all.
- The step 4 run written down in this folder, with its numbers.

## Commit

```
fix(image): size the model to what a shared-memory GPU can actually allocate
```

## Rollback

Steps 1 and 2 are independent of 3 and revert alone; the worst case of
reverting them is a recommendation that was already wrong. Step 3 is gated on
the integrated flag, so reverting it restores today's behaviour for every user
who was not affected — which is all of them, since nobody has run this on an
integrated GPU yet.
