# Phase 04 — Parallel streams, extra arguments, compaction

## Steps

### 1. Parallel streams setting
New setting `localParallelSlots: 1 | 2 | 4` (default 1), shown in
Settings → Inference under the RAM checkbox as a three-button row like
Context Size. Tooltip: lets a background job run alongside chat; each reply
shares the GPU and the context pool.

- Rust: `ServerConfig.parallel`; emit `--parallel N`, plus `--kv-unified` when
  N > 1 (an explicit `-np` turns unified KV off upstream unless `-kvu` is also
  given). Restart via `restartServerWhenIdle`.
- Queue: the `local` lane's capacity in `inference_queue.rs` and `laneFor`
  (`inferenceQueue.svelte.ts:114-126`) follow the setting; the local
  descriptor (`descriptor.ts:288-312`) reports `allowParallel: N > 1,
  parallelSlots: N` so sub-agent slot lending works as it does for remote.
- Unified pool: a long stream can evict or terminate another. Check how a
  terminated slot surfaces to the client (error shape) and make sure the job
  runner retries rather than failing the step.

### 2. Extra llama-server arguments
New setting `llamaServerExtraArgs: string` (default empty). One-line text field
in Settings → Inference, `title` tooltip: "Passed to llama-server last, so
these override Haruspex's own. Takes effect on restart." Split with a
shell-words parser (quotes respected), passed as the existing `extraArgs`
(`llamaServer.svelte.ts:157-185`). A start failure with non-empty extra args
names them in the error banner so the user knows what to clear.

### 3. Compaction inside the slot
`chat.svelte.ts:1321` runs `compactIfNeeded()` before `withInferenceSlot` at
`:1440`. Move it inside the slot (as `remote/driver.ts:215-218` already does).
Test: compaction never runs while another holder owns the local lane.

## Verify
- Unit: arg building for N=1/2/4, lane capacity, extra-args parsing, compaction
  ordering.
- Hand: parallel = 2, run a job and chat at once; both stream. Extra args
  `--n-cpu-moe 10` with the RAM switch off loads and overrides.

Docs: `docs/guide/models.md` (parallel and extra args under Context size, or a
short "Advanced" heading), `troubleshooting.md` (clear extra args if the model
won't start).
