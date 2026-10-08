# Phase 03 — Wizard: MoE alternative

The recommendation stays VRAM-fit. When the machine can run a MoE model with
experts in RAM and that model is bigger than the recommendation, the hardware
step offers it as a second choice.

## Steps

### 1. Recommend an offload alternative
`hardware.rs:78-105` returns `offload_alternative: Option<String>` beside the
recommendation. Rule (constants to calibrate during hand-testing):

- discrete GPU with known VRAM ≥ 8 GB, total RAM ≥ 32 GB;
- the VRAM-fit recommendation is below the 24 GB tier;
- the MoE quant passes phase 02's ceiling at `MIN_CONTEXT` or better with the
  switch on.

Today that is `Qwen3.6-35B-A3B-UD-IQ4_NL`. macOS (unified memory, no VRAM
figure) and integrated GPUs get no alternative.

### 2. Hardware step UI
`routes/setup/+page.svelte:233-300`: under the model select, one line when an
alternative exists — "Larger model using system RAM: smarter, slower." with a
**Use this instead** link and a `title` tooltip giving size and that it turns
on Settings → Inference → Let models use system RAM. Choosing it sets the
model and `allowSpillToSystemRam: true`; choosing anything else from the
select sets it back to false. `setSelectedModel` recomputes context with the
flag.

### 3. Wizard start args
`setup.svelte.ts:175-178`: route through `startServer()` (or pass the same
`mtp`, `mmprojOnCpu`, `ramOffload`) so first run matches every later start.

## Verify
- Unit: alternative rule for each tier boundary, iGPU, macOS.
- Hand: wizard on a 12–16 GB machine shows the line, picks it, test query
  runs with experts on CPU.

Docs: `docs/guide/models.md` hardware table note, `getting-started.md` wizard
step.
