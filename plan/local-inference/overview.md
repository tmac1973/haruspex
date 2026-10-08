# Local Inference Review

Locked 2026-10-08.

## Problem

**1. We switch off llama.cpp's own memory fitting.** Since PR #16653
(2025-12-15) llama-server fits the model to the hardware by default
(`--fit on`): it projects memory per device, then fills layers onto the GPU
and overflows MoE expert tensors to the CPU through generated `-ot` overrides —
an automatic `--n-cpu-moe`. It aborts the moment `n_gpu_layers` differs from
its default (`common/fit.cpp:463`), and we always pass `--n-gpu-layers 99`
(`server/mod.rs:110`, default at `:77-93`). We saw the symptom and silenced it:
d1800ef added a benign-pattern for "n_gpu_layers already set by user to 99,
abort". So no local model can ever place weights in system RAM, and the two
MoE models (`Qwen3.6-35B-A3B`, 18 GB and 26.6 GB) are offered only to 24 GB+
cards even though their experts are exactly what runs acceptably from RAM
(community figures: 14–22 tok/s on a 16 GB card).

**2. "Allow spill to system RAM" doesn't do what it says.** It only unlocks
context buttons (`InferenceSection.svelte:405-418`); no flag changes. The
spill then happens at the driver level (GTT over PCIe on AMD), which is the
slow way to use RAM.

**3. The pin is six weeks and three stable tags behind.** `LLAMA_CPP_VERSION`
is `v0.3.0` (2026-08-25); latest stable is `v0.6.0` (2026-10-05), with Vulkan
FA fixes, RDNA4 mat-vec tuning and fit improvements. `build-sidecars.sh:220`
silently clones `master` when the tag clone fails.

**4. llama-server's other defaults are unmanaged.** It keeps a host-RAM prompt
cache of **8 GiB by default** (`--cache-ram`), which competes with offloaded
experts. It also defaults to 4 unified slots (`-np auto` + `--kv-unified`,
PR #16736); we force `--parallel 1`, which is right for most users but leaves
no way up.

**5. Small bugs on the same path.**
- Chat compaction (`chat.svelte.ts:1321`) calls the model before acquiring the
  inference slot (`:1440`), so it can collide with a running job on the
  single local slot.
- The wizard's `start_server` (`setup.svelte.ts:175-178`) omits `mtp` and
  `mmprojOnCpu`.
- `extra_args` is plumbed end to end but nothing sets it.

## Decisions

| Question | Decision |
|---|---|
| Who gets RAM offload | **Opt-in.** Default stays all-in-VRAM (`-ngl 99`), as today. |
| The switch | **Repurpose `allowSpillToSystemRam`.** On = omit `--n-gpu-layers` so llama.cpp `--fit` places layers and experts. No new setting. |
| Wizard | **Show MoE-with-offload as an alternative** beside the VRAM-fit recommendation, not as the default. Choosing it turns the switch on. |
| llama.cpp version | **v0.6.0**, keep tracking stable `vX.Y.Z` tags; build fails instead of falling back to master. |
| Parallel streams | **Default 1**, Settings choice for 2 or 4 (unified KV). Local queue lane capacity follows. |
| Prompt cache RAM | **We set `--cache-ram`**, scaled to RAM left after offload, capped at 2 GiB. |
| Power-user escape hatch | **Extra llama-server arguments** text field, appended last. |
| Adjacent fixes | All four: compaction queue, wizard args, build fallback, fit-abort classifier. |
| Model review | **Separate follow-up**, filed as a GitHub issue. |

Rejected: computing `--n-cpu-moe` ourselves (duplicates upstream fit and needs
per-model tensor tables we'd have to maintain); a separate Advanced panel
(one checkbox plus one text field doesn't need a disclosure).

Not available yet: `--moe-cache-mib` (PR #29887, merged 2026-10-07, after
v0.6.0; Vulkan path "not fully optimised"). Revisit at the next stable tag; the
extra-args field covers anyone who wants it on a nightly build.

## Phases

| Phase | What | Depends on |
|---|---|---|
| [01](phase-01-llama-bump.md) | v0.6.0 bump, build hardening, flag audit | — |
| [02](phase-02-ram-offload.md) | RAM offload switch, fit-aware context ceiling, `--cache-ram` | 01 |
| [03](phase-03-wizard.md) | Wizard MoE alternative, wizard start args | 02 |
| [04](phase-04-advanced.md) | Parallel streams, extra args, compaction in queue | 01 |

Each phase is one PR. Phases 02–04 change things users see, so each updates
`docs/guide/models.md` (and `troubleshooting.md` where relevant) in the same PR.

## Invariants

- Default behaviour for a user who never touches the switch is unchanged:
  same flags except the version bump and `--cache-ram`.
- `-c` is always explicit. Fit never shrinks context we chose; it only moves
  weights. Our context ceiling stays the single source of truth for sizes.
- CPU fallback keeps passing `--n-gpu-layers 0` (explicit, so fit stays out).
- Extra args go last so they override ours.
