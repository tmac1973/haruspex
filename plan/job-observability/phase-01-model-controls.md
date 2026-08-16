# Phase 01 — Per-Job Reasoning and Sampling Control

Makes the two model-behavior knobs that jobs currently have no access to —
reasoning on/off and sampling params — explicit, per-job, and correct for
override backends. This is the phase that would have fixed the run that
prompted the plan.

## Steps

### 1. Persist the probe's capability data

`probe_inference_server` already returns per-model `reasoning:
RemoteReasoningCaps | null` and `sampling: RemoteSamplingCaps | null`
(`src/lib/inferenceProbe.ts:30-31`), and `JobEditor.probeModel()`
(`JobEditor.svelte:262`) already receives them and throws them away.

Add one column rather than eight:

```sql
ALTER TABLE jobs ADD COLUMN model_advanced TEXT
```

appended to the idempotent migration list in `src-tauri/src/db/mod.rs:446`,
alongside the `model_remote_*` columns it belongs with. It holds frontend-owned
JSON, following the precedent set by `type_config` — Rust stores it verbatim,
so no Rust changes beyond the column, the two structs at `db/mod.rs:145`/`:181`,
and the job read/write in `db/jobs.rs`.

Shape (parsed and serialized in a new `src/lib/agent/jobs/modelAdvanced.ts`
with the same defensive-parse discipline as
`autonomous-coding/config.ts` — every field optional, unknown values fall back
to `null`/inherit):

```ts
interface JobModelAdvanced {
  /** 'inherit' = use the global thinkingEnabled setting. */
  reasoning: 'inherit' | 'on' | 'off';
  sampling: {
    source: 'server' | 'profile' | 'custom';
    /** Only meaningful when source === 'custom'. */
    params: SamplingParams | null;
  };
  /** Verbatim from the last successful probe of the override server. */
  discovered: {
    reasoning: RemoteReasoningCaps | null;
    sampling: RemoteSamplingCaps | null;
  } | null;
}
```

`probeModel()` writes `discovered` from the picked model on every successful
probe, next to where it already adopts `context_size`. Re-picking a different
model from `probedModels` must re-write it — the caps are per-model, not
per-server.

### 2. Teach the descriptor about override capabilities

`resolveOverrideDescriptor` (`descriptor.ts:266`) currently hard-codes
`discoveredSampling: null` and derives `reasoningMode` from
`modelFamilyFromId(override.modelId)` alone. Extend `BackendOverride` with the
`JobModelAdvanced` fields and resolve in this precedence:

- `discoveredSampling` — `advanced.discovered.sampling` when present, else null
  (unchanged behavior for overrides that were never probed).
- `reasoningMode` — discovered caps first (mirroring `resolveRemoteDescriptor`'s
  toolchest branch at `descriptor.ts:235`: honor `caps.toggle ===
  'chat_template_kwargs'` and its reported `kwarg`), then the model-id family
  fallback, then `{kind:'none'}`.
- `reasoningSupported` — true if either source says so.

This is the actual fix for the unmatched `qwen3.8-27b` id: the toolchest probe
reports the model's real reasoning toggle, so the kwarg gets sent regardless of
whether the id matches a hard-coded substring.

Keep the rule stated in the doc comment at `descriptor.ts:173` intact — quirks
still come from the override's own data, never inherited from the global
backend. Discovered caps are the override's own data now.

### 3. Sampling source policy

`getSamplingParams` (`settings.ts:1038`) gains the source policy:

- `'server'` → return `{}`. Every field undefined means `buildRequestBody`
  omits it (`api.ts:357-374`), so the server's own configuration wins
  completely. This becomes the **default for any override with discovered
  toolchest caps** — if the server publishes presets, it is the authority.
- `'profile'` → today's behavior: discovered presets layered over built-ins via
  `toolchestSamplingParams` (`settings.ts:1016`), or the built-in family
  profile.
- `'custom'` → the job's stored `params`, with undefined fields omitted rather
  than back-filled, so "clear this field" means "don't send it".

The OpenRouter trimming at `settings.ts:1046` (drop `top_k`/`min_p`) must still
apply to `'custom'` — a user-entered `top_k` should not 400 a stricter upstream
provider.

### 4. Thread reasoning through the ephemeral turn

`EphemeralTurnOptions` (`runEphemeralTurn.ts:24`) gains:

```ts
/** Per-job reasoning override; null/undefined = the global setting. */
thinkingEnabled?: boolean | null;
```

passed straight into `runTurnCore` — `AgentLoopOptions` already accepts it
(`loop.ts:207`) and `iteration.ts:175` already defaults it to null, so nothing
downstream changes.

**Inject it in the runner, not in each pipeline.** `ctx.runJobTurn` is typed
`Omit<EphemeralTurnOptions, 'workingDir' | 'backend' | 'signal'>`
(`types/types.ts:46`), and the runner already owns those three. Adding
`thinkingEnabled` to the same runner-owned set means all four job types get the
control without touching a single pipeline, and no pipeline can accidentally
diverge. A pipeline that later needs a per-stage override can still pass one —
but nothing should in this phase.

### 5. Advanced section in the shared job editor

The reasoning and sampling controls go in `JobEditor.svelte`, in a collapsed
`<details>` next to the existing per-job model override — not in
`autonomous-coding/Editor.svelte`. The model override is already shared across
every job type (`ModelOverrideConfig` in `jobs.svelte.ts:75`), and these
controls are the same kind of thing.

- **Reasoning**: `Inherit global setting (currently: on/off) / Always on /
  Always off`, showing the resolved global state in the label so "inherit"
  isn't a mystery.
- **Sampling**: `Server defaults / App-tuned profile / Custom`, with the five
  fields revealed only for Custom, each blank-means-omitted.
- When the probe reported `reasoning.supported` but a toggle we cannot drive
  (`caps.toggle !== 'chat_template_kwargs'`), say so next to the control rather
  than offering a switch that does nothing. `descriptor.ts:238` already
  distinguishes these cases; the UI should too.

## Verification

- `cargo test`, `cargo clippy`, `cargo fmt -- --check` — the migration and the
  two structs.
- New `modelAdvanced.test.ts`: defensive parse (unknown strings → inherit,
  malformed JSON → defaults, missing `discovered` → null), round-trip.
- `descriptor.test.ts`: an override with discovered toolchest reasoning caps
  gets the reported kwarg even when the model id matches no family — the
  regression that caused this plan. Plus: discovered sampling reaches
  `discoveredSampling`; an unprobed override behaves exactly as today.
- `settings.test.ts`: each of the three sampling sources; `'server'` returns an
  empty object; `'custom'` omits blank fields; OpenRouter still drops
  `top_k`/`min_p` under `'custom'`.
- `runner.test.ts`: `thinkingEnabled` resolved from the job and injected into
  every `runJobTurn` call, for a job of each type.
- Manual: re-run last night's job with reasoning forced off against the same
  plan, and record wall clock before/after in this file. Confirm in the
  llama-toolchest server logs that `enable_thinking: false` arrives and that no
  sampling fields are sent under `Server defaults`.
