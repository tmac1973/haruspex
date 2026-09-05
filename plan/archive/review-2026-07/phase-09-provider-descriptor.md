# Phase 09 — Backend provider descriptor

**Commit scope:** `refactor(inference)` · **Language:** TS · **Depends on:** nothing (deliberately last: largest blast radius, no dependents)

Decision locked: **full descriptor refactor.** The local/remote seam is the
codebase's leakiest abstraction — Qwen-tuned sampling params leaked to remote
models until #172, `server.svelte.ts` models `'remote'` as a pseudo server
status, and capability flags (vision, context, reasoning) are scattered. One
resolved descriptor per backend kills the bug class.

---

## 1. The type

New `src/lib/inference/descriptor.ts`:

```ts
export interface BackendDescriptor {
	kind: 'local' | 'remote' | 'openrouter';
	baseUrl: string;            // sidecar baseUrl(PORTS.llama) for local
	apiKey?: string;
	modelId: string;            // placeholder for local (llama-server ignores it)
	contextSize: number;
	vision: boolean;
	/** True only for the bundled local Qwen models — gates the tuned
	 *  sampling profile AND chat_template_kwargs. Nothing else may test
	 *  model names for this purpose. */
	qwenTuning: boolean;
	reasoningMode: /* reuse the existing reasoning-mode union from settings/openrouter */;
	allowParallel: boolean;     // drives inferenceQueue capacity
}
```

## 2. The resolver

`resolveBackendDescriptor(override?: BackendOverride): BackendDescriptor` —
the **only** place that reads `inferenceBackend` settings, OpenRouter model
metadata, probe results (`inferenceProbe.ts`), and per-job overrides. Pure
function of (settings snapshot, optional override); no caching beyond what
the settings store already provides.

- Local → sidecar URL, active model's family → `qwenTuning`, settings
  context size, mmproj-derived `vision`.
- Remote (self-hosted) → user URL/key/model, probe-derived or user-edited
  context/vision, `qwenTuning: false` **unless** the model family detection
  (`settings.ts:963`) positively identifies a Qwen — preserving the
  legitimate remote-Qwen case that #172 kept.
- OpenRouter → catalog metadata (context, vision, reasoning), `qwenTuning: false`.
- Job override (`BackendOverride`) → its explicit fields win; unspecified
  fields fall back to the override's own config, never to the global
  backend's (a job pointed at server X must not inherit server Y's quirks).

## 3. Call-site migration (the actual work)

| Site | Change |
| --- | --- |
| `api.ts:187 resolveChatEndpoint` | Reimplement on the resolver; keep its signature so streaming helpers don't churn. Delete the placeholder-URL special case — the descriptor always has a real `baseUrl`. |
| `settings.ts:1044 getSamplingParams` | Takes `descriptor: BackendDescriptor`; the profile applies iff `descriptor.qwenTuning`. Delete internal mode-reading. |
| `settings.ts:744 getChatTemplateKwargs` | Same: kwargs emitted iff `descriptor.qwenTuning`. |
| `settings.ts:963` model-family detection | Becomes an input **to the resolver only**; no other module imports it. |
| Agent loop (`loop.ts` / `LoopContext`) | `LoopContext` gains `descriptor`; resolved **once per turn** in `runTurn.ts` / `runEphemeralTurn.ts` / `runShellTurn.ts` and passed down. Tools and iteration code read `ctx.descriptor.vision` etc. instead of re-deriving. |
| Jobs runner | Maps a job's remote config through the same resolver via `BackendOverride` — delete any parallel plumbing. |
| `inferenceQueue.svelte.ts` | Capacity decision reads `descriptor.allowParallel`. |
| `server.svelte.ts` | The `'remote'` pseudo-status **stays** — it's a UI badge concern (`ServerStatusType:17`), documented as such. The invariant after this phase: no request-path or agent code branches on server status or mode strings; only UI does. |

Grep-driven completeness check:
`grep -rn "inferenceBackend.mode\|=== 'remote'\|=== 'local'" src/lib` — every
hit outside `descriptor.ts`, `server.svelte.ts`, and settings-UI components
must be migrated or justified in the PR.

## 4. What this phase does NOT do

- No Rust changes. The sidecar lifecycle, probe commands, and
  `inference_queue.rs` are untouched.
- No new backend kinds, no UI changes, no settings-schema migration —
  the settings blob shape stays identical; only *readers* move.

---

## Tests & acceptance

- Resolver matrix tests (`descriptor.test.ts`): local-Qwen, local-imported-
  non-Qwen, remote-generic, remote-Qwen, OpenRouter-with-metadata, job
  override, override-fallback isolation.
- **Regression pinning #172:** a remote non-Qwen descriptor produces empty
  template kwargs and no Qwen sampling profile — this is the test that must
  fail if anyone re-scatters the logic.
- Existing `api.test.ts`, loop tests, and `openrouter.test.ts` updated to
  construct descriptors instead of mocking settings mode.
- Manual: chat against local model, a self-hosted remote, and OpenRouter;
  run a job with a per-job remote override while chatting locally
  (exercises the parallel-provider path).
