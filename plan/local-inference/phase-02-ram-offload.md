# Phase 02 — RAM offload switch

`allowSpillToSystemRam` becomes a real switch: on, llama.cpp `--fit` places
layers and MoE experts across GPU and RAM; off, everything stays in VRAM as
today.

## Steps

### 1. Make GPU layers optional in `ServerConfig`
`n_gpu_layers: Option<u32>` (`server/mod.rs:54-93`). `None` → omit the flag,
so fit runs (`-ngl` defaults to `auto`). Default stays `Some(99)`. CPU fallback
(`:790-849`) sets `Some(0)`.

### 2. Plumb the switch
`start_server` (`:985-1045`) gains `ram_offload: Option<bool>` (default false).
`startServer()` (`llamaServer.svelte.ts:157-185`) passes
`getSettings().allowSpillToSystemRam`. Toggling it uses the existing deferred
restart (`restartServerWhenIdle`). Regenerate IPC types
(`./scripts/export-ipc-types.sh`).

Leave fit's defaults alone: `--fit-target` 1024 MiB already matches
`VRAM_RESERVE_BYTES`, and `--fit-ctx` is irrelevant because `-c` is explicit.
Fit accounts for the mmproj and MTP drafter itself. Keep
`--spec-draft-ngl all` so the drafter is never split.

### 3. Fit failure handling
With the switch on, a genuine fit failure ("failed to fit params" without
"already set by user") must route to the existing CPU fallback, not be
swallowed by the d1800ef benign pattern. Narrow that pattern to the
"already set by user" text and add a classifier test for each case.

### 4. Context ceiling that knows about RAM
Add `expert_bytes: Option<u64>` to `ModelInfo` (Rust-only, like
`kv_bytes_per_token`) for the two `Qwen3.6-35B-A3B` entries, measured from the
GGUF tensor list (`ffn_*_exps`). `context_ceiling_for` (`models.rs:758-779`)
takes `ram_offload` and total RAM:

- Off: unchanged.
- On, MoE: KV and non-expert weights must fit in VRAM
  (`weights − expert_bytes + reserves + kv ≤ vram`), and experts must fit in
  `ram_budget = total_ram − 6 GiB − cache_ram`.
- On, dense: `weights + reserves + kv ≤ vram + ram_budget` (fit moves whole
  layers; slow, but the user opted in).

`context_fit_ceiling` and `recommended_context_size` (`:1512-1547`) take the
flag; `InferenceSection.svelte:56-96` passes it and re-snaps when it changes.

### 5. `--cache-ram`
Pure function in `server/mod.rs`, always emitted:
`cache_ram_mib = clamp((total_ram − offloaded_bytes − 8 GiB) / 4, 0, 2048)`,
where `offloaded_bytes` is `expert_bytes` (MoE, switch on), the estimated
spill (dense, switch on), or 0. Unit-test the edges (16 GB machine with
offload → 0).

### 6. Copy
Rename the checkbox to **Let models use system RAM**, with a tooltip: larger
models and contexts fit, replies get slower, MoE models lose the least. Update
the `allowSpillToSystemRam` doc comment (`settings.ts:377-384`); the field name
stays to avoid a settings migration.

## Verify
- Unit: arg building (flag omitted/present), ceiling maths for each case,
  cache-ram function, classifier.
- Hand (16 GB card + 32 GB RAM if available, otherwise cap VRAM with a
  smaller card): `Qwen3.6-35B-A3B-UD-IQ4_NL` with the switch on loads, log
  shows expert overrides to CPU, record tok/s at 32K. Same model with the
  switch off is greyed/refused as today.

Docs: `docs/guide/models.md` (context section), `troubleshooting.md` if it
mentions spill.

## As built (2026-10-08)

One change from the steps above: **no `expert_bytes` in this phase.** With
offload on, fit moves experts first and then whole dense layers, each taking
its KV share with it, so what bounds the context is VRAM + RAM together for
MoE and dense alike. `context_ceiling_for` adds `FitOptions::ram_budget_bytes`
(`ram_offload_budget`: total RAM − 6 GiB − the 2 GiB cache cap) to VRAM.
`--cache-ram` counts the whole model file as offloaded when the switch is on,
which only errs towards a smaller cache. Per-model expert sizes are still
needed for phase 03's "runs well" rule, so they move there:

| Quant | File | Experts (`ffn_*_exps`) | Non-expert |
|---|---|---|---|
| Qwen3.6-35B-A3B-UD-IQ4_NL | 18,029,898,240 | 15,474,884,608 (85.8%) | 2,555,013,632 |
| Qwen3.6-35B-A3B-UD-Q5_K_XL | 26,581,518,848 | 23,903,338,496 (89.9%) | 2,678,180,352 |

Measured from the GGUF tensor tables (Q5 from a range read of the header,
the parser cross-checked exactly against the full IQ4_NL file).

Fit on v0.6.0, RX 7900 XTX, IQ4_NL MoE at 32K, q8_0 KV, no `-ngl`,
`--fit-target 6144` to leave ≈9.6 GB usable:

- "context size set by user to 32768 -> no change"; experts overflow to CPU.
  Peak VRAM ≈10.1 GB, so the target holds. Fit adds ≈4 s to startup.
- 38.6 tok/s with the default load mode; 36.6 with `--load-mode none`, which
  llama.cpp's warning suggests. Default kept.
- Fit's own log lines only show at `-lv 4`; success reads "successfully fit
  params". The benign classifier pattern is now just "already set by user".
