# Phase 03 — Multi-Token Prediction for Qwen 3.8 27B

Turns on llama.cpp's self-speculative decoding using the MTP head bundled in
the Qwen 3.8 27B weights. Depends on phase 01 (the registry entry has to exist
before it can carry a flag).

## Why this is one flag and not a feature

The head is already in the file. From a direct read of the GGUF metadata:
`Qwen3.8-27B-IQ4_NL.gguf` declares `qwen35.nextn_predict_layers: 1`,
`block_count: 65` (64 transformer layers plus the MTP layer), and carries four
`blk.64.nextn.*` tensors. No second download, no separate draft model.

`--spec-type draft-mtp` is accepted by llama-server on our pinned b9565
(`arg.cpp:3647`, whose `set_examples` includes `LLAMA_EXAMPLE_SERVER`; the
type name is `draft-mtp`, per the name map at `speculative.cpp:23-33` — plain
`mtp` throws `unknown speculative type`). With no `-md` draft model given,
`server-context.cpp:961-970` creates the MTP draft context against the target
model, which is exactly the bundled-head case.

**It must be per-model.** The same GGUF survey found no `nextn` tensors in
`Qwen3.6-27B-IQ4_NL`, `Qwen3.6-35B-A3B-UD-IQ4_NL`, `Qwen3.5-9B-IQ4_NL`, or
`Qwen3.5-9B-UD-Q6_K_XL` — Unsloth's conversions strip the head for those even
where the HF config declares one. And `find_any_model` (`models.rs:478`) will
happily start the server on a GGUF the user dropped in themselves, about which
we know nothing. A blanket flag would break all of those.

## Steps

### 1. Declare the capability in the registry

`ModelInfo` gains:

```rust
/// True when this GGUF bundles a multi-token-prediction head that
/// llama-server can use as a self-speculative draft. Verified per file by
/// checking for `blk.N.nextn.*` tensors — the HF config declaring
/// `mtp_num_hidden_layers` is NOT sufficient, since the conversion may
/// have stripped it.
pub mtp: bool,
```

`true` on the Qwen 3.8 27B entry only; `false` everywhere else including all
legacy entries. Unlike phase 01's `kv_bytes_per_token`, this field **is**
serialized and exported — the Settings UI needs it to decide whether to show
the toggle — so regenerate the IPC bindings
(`scripts/export-ipc-types.sh`) and expect `scripts/check-ipc.mjs` to demand
it (see `project_audit_remediation_2026_06`).

Plus a lookup for the server module, which resolves models by path, not id:

```rust
/// Whether the GGUF at `filename` is a lineup model with a bundled MTP head.
/// Unknown filenames — user-imported models — return false.
pub fn model_supports_mtp(filename: &str) -> bool
```

### 2. Pass the flag

`ServerConfig` (`server/mod.rs:54`) gains `mtp: bool`, default `false`.
`build_args` (`:78`) pushes `--spec-type draft-mtp` when set, before
`extra_args` so a power user can still override.

The `start_server` command (`:774`) takes `mtp: Option<bool>` — the *user
preference* — and ANDs it with the registry capability:

```rust
let mtp = mtp.unwrap_or(true) && models::model_supports_mtp(&filename_of(&model_path));
```

Defaulting `None` to `true` keeps the setup flow (`setup.svelte.ts:171`,
which passes no extra fields) consistent with the main path without having to
thread the setting through first-run.

`startServer` (`server.svelte.ts:145`) gains the parameter and passes
`getSettings().mtpEnabled`.

### 3. The setting and its control

`mtpEnabled: boolean`, default `true`. Rendered in `ModelsSection.svelte:206`
as a `.toggle-row` — but **only when the active model advertises `mtp`**, so
users of every other model never see a control that does nothing.

Copy should say what it does and what to do when it misbehaves, e.g.
*"Predict several tokens at once using the model's built-in draft head.
Faster responses on Qwen 3.8 27B. Turn off if output looks corrupted."*

Changing it requires a server restart, like context size — follow whatever
that control already does to prompt for one rather than inventing a second
pattern.

### 4. Account for the MTP context in the VRAM math

`server-context.cpp:817-892` reserves a *separate* context for the draft
before fitting the target model. `context_ceiling_for` (`models.rs:366`)
models weights + mmproj + per-token KV + a fixed
`COMPUTE_OVERHEAD_BYTES` (512 MB) and knows nothing about it. Left alone, the
app will keep recommending a context that no longer fits, and users will
silently ride the context-backoff ladder down after every start.

Add an MTP allowance to the fixed cost when the flag is on. **I don't have a
principled number for it** — the comment block above `CONTEXT_LADDER` already
concedes the existing estimates "should be calibrated against the VRAM
llama-server actually reports", and this one is no different. Start at 512 MB,
then read the actual buffer sizes llama-server prints at startup with and
without the flag on the 24 GB card and correct it. Whatever the outcome,
record the measured figure in the comment next to the constant so the next
person doesn't have to re-measure.

Note this makes `context_ceiling_for` depend on a setting, not just the model.
Pass the flag in as a parameter rather than reaching for settings inside
`models.rs` — the callers (Settings context cap, first-run recommendation)
both know it.

### 5. Fall back on a failed start

A bad `--spec-type` interaction kills the server during startup, and the
supervisor's existing recovery paths don't cover it: `classify`
(`server/log_classifier.rs`, consumed at `server/mod.rs:150`) recognizes GPU
errors and context-allocation errors, and MTP failures are neither. The
symptom would be a server that won't start, with the cause buried in stderr.

Mirror the CPU-fallback pattern that already exists for GPU errors
(`gpu_fallback_attempted` / `cpu_fallback_active`, `server/mod.rs:119-129`):
on a start failure with MTP enabled, respawn once without it and surface a
banner saying so. This is the largest piece of work in the phase and is worth
it precisely because MTP is the newest, least-proven flag we pass.

If that proves too big for one PR, the acceptable fallback is to classify the
failure and put the cause in the error banner with a pointer to the toggle —
but a user whose app won't start needs the app to fix itself, not to read
about it.

## Risks

Vulkan MTP is new and not fully settled upstream. Two known open issues at the
time of writing: llama.cpp **#26827** (`fix(mtp): serialize multi-ubatch
decode execution`) and **#27237** (Qwen3.5-27B producing garbage output on
Vulkan at batch size 512, correct at 1024/4096). Our whole stack is Vulkan.

That is the case for the toggle, the start-failure fallback, and for treating
the speedup as unproven until measured on the actual hardware rather than
assumed from the mechanism.

## Verification

- Startup log shows `creating MTP draft context against the target model`
  (`server-context.cpp:963`). If that line is absent the flag isn't taking
  effect and everything below is measuring nothing.
- Tokens/sec on a fixed prompt, MTP on vs off, same context size and quant.
  Decode-bound single-stream generation is the only place this helps; prompt
  processing should be unchanged.
- **Output sanity, deliberately and at length.** Given #27237, run a long
  generation and a tool-calling agent turn and read the output. Speculative
  decoding is supposed to be output-identical to greedy decoding of the target
  model; anything that looks subtly wrong means off, not tuning.
- VRAM actually consumed, on vs off, at the same context — the number that
  settles step 4.
- Toggle off, restart, confirm the flag disappears from the spawned args and
  behavior returns to baseline.
- Confirm a user-imported GGUF (not in the registry) never gets the flag, and
  that switching from the 3.8 27B to a 9B model drops it.
