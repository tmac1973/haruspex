# OpenRouter Inference Backend

## Status

**Planning only — no implementation yet.** This document captures the design
for adding OpenRouter as a first-class inference backend option in Settings →
Inference. It's meant to be read, argued with, and edited before any code gets
written.

## Goal

Let Haruspex optionally route inference to [OpenRouter](https://openrouter.ai)
instead of the bundled llama.cpp sidecar (or a self-hosted remote server).
The user enters an API key, picks a model from a dynamically populated list,
and the agent loop, chat store, jobs, and ephemeral turns all work against
OpenRouter's OpenAI-compatible endpoint with no further plumbing.

This keeps Haruspex's privacy stance intact by default — OpenRouter is an
**opt-in, explicitly labeled cloud** backend, distinct from the local and
self-hosted-remote modes. Nothing about adding it changes the default
experience or sends data off-device without the user's affirmative choice.

## Why now

Haruspex already has a two-mode inference architecture (`local` vs `remote`)
where `remote` is explicitly designed to be "OpenAI-compatible." The README
(`README.md:282`) even names OpenRouter by name as something that "will
technically work via the `/v1` endpoint, but … not a supported configuration."
This phase promotes it from "technically works" to "supported and good UX."

## Prerequisites

- The remote-inference plumbing already present in:
  - `src/lib/stores/settings.ts:79-130` — `InferenceBackendConfig`
  - `src/lib/api.ts:156-192` — `resolveChatEndpoint()` (the single routing
    choke point)
  - `src/lib/components/InferenceBackendForm.svelte` — server URL / API key /
    probe / model dropdown
  - `src-tauri/src/inference.rs:238-267` — `probe_inference_server`
  - `src/lib/agent/loop/iteration.ts`, `inferenceQueue.svelte.ts`,
    `runEphemeralTurn.ts` — all already thread a `BackendOverride` through.
- `BackendOverride` per-job overrides (`api.ts:100-107`,
  `stores/jobs.svelte.ts:69-92`) — already work for remote backends.

Nothing in this phase depends on work from any other in-flight phase.

---

## Resolved Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Integration shape | **OpenRouter as a remote-backend preset**, not a third `InferenceMode` | The entire transport (fetch to `${baseUrl}/v1/chat/completions`, Bearer auth, SSE streaming, per-job override) already works for OpenAI-compatible remotes. Adding a third mode would duplicate `resolveChatEndpoint()` and the queue lane logic for no benefit. |
| Mode toggle | A new **"OpenRouter" option** appears alongside "Local" and "Remote server" in `InferenceSection.svelte` | Three radio buttons. Selecting it fills `mode: 'remote'` + `remoteBaseUrl: 'https://openrouter.ai/api'` behind the scenes and swaps the form to a dedicated OpenRouter panel. Keeps the data model unified while giving a tailored UX. |
| Model discovery | **Fetch `GET /api/v1/models` from OpenRouter** and cache the result in-memory (and in localStorage with a TTL). No Rust probe round-trip. | OpenRouter's catalog is OpenAI-shaped (`{"data":[...]}`) and needs no auth, but the existing `probe_inference_server` walks `try_llama_toolchest` / `try_llama_server` first (429-bait against OpenRouter) and returns no context/vision metadata. A dedicated catalog fetch is simpler and richer (context_length, supported_parameters, pricing, reasoning caps, deprecation). |
| Model metadata source | OpenRouter's per-model object carries everything we need: `context_length`, `architecture.input_modalities` (vision), `supported_parameters` (tools / reasoning), `pricing`, `expiration_date` | Replaces the manual context-size / vision entry the generic remote form forces today. |
| API key storage | localStorage via `inferenceBackend.remoteApiKey`, same trust level as the existing remote key and email passwords | Keyring is already a known-deferred item (`settings.ts:148-151`). Don't introduce a new trust boundary for one backend. |
| Attribution headers | Send `HTTP-Referer: https://github.com/tmac1973/haruspex` (or the homepage) and `X-Title: Haruspex` on every OpenRouter request | Optional per OpenRouter but free attribution for the project; harmless if the URL changes. |
| Reasoning models | Drive the thinking toggle from `model.reasoning` (supported_efforts, default_effort, mandatory); render `delta.reasoning` / `delta.reasoning_details` into the existing think-stream panel; **preserve `reasoning_details` across tool-call turns** (echo back unmodified, in order) | Haruspex already streams `reasoning_content` for local models (`api.ts:276-283`); OpenRouter normalizes reasoning across providers to `reasoning`/`reasoning_details`, so this is an additive parse path. Preserving reasoning history across turns is a documented OpenRouter requirement for multi-turn reasoning quality — worth the extra work in v1 to avoid degraded tool-loop reasoning. |
| Privacy labeling | The OpenRouter form carries an explicit "Cloud — prompts leave your device" warning, distinct from the "Remote (self-hosted)" wording | Haruspex's whole pitch is "conversations never leave your device." OpenRouter inherently breaks that; the UI must not pretend otherwise. |
| Fallback array | **Out of scope for v1.** Ship single-model requests; revisit `models[]` fallback routing once we've validated the basic flow. | Mirrors the existing sidecar-failover mindset but adds UX complexity (which backups? per-job?). Defer. |
| Provider data-policy filtering | **Out of scope for v1.** Don't send `provider` preferences or fetch `/api/frontend/all-providers`. | Privacy-conscious users can set the account-level "forbid training-capable providers" toggle on openrouter.ai themselves. A later phase can surface per-provider `dataPolicy` in the model picker. |

---

## Deliverables

User-testable scenarios that must work at the end of this phase:

- **Scenario 1 — Pick OpenRouter**: In Settings → Inference, the user sees
  three options: Local, Remote server, OpenRouter. Choosing OpenRouter shows
  an API-key field and a "Get a key" link to `openrouter.ai/keys`. No server
  URL is shown (it's fixed to `https://openrouter.ai/api`).
- **Scenario 2 — Model list populates**: After entering a key and clicking
  "Load models", the form fetches `GET /api/v1/models` and shows a searchable
  dropdown (~300 entries) with display name, org/id, context length, and a
  free/paid badge. Selecting a model fills context size + vision flag
  automatically from the model card.
- **Scenario 3 — Chat works**: With an OpenRouter model selected, the user
  asks a question in the main chat. The agent loop streams the answer through
  the existing `chatCompletionStream` path; the thinking panel renders
  reasoning tokens for reasoning-capable models and stays hidden for
  non-reasoning ones.
- **Scenario 4 — Tool calling works**: A research question triggers the
  search tool. The non-streaming tool-check call
  (`iteration.ts:sendGuardedCompletion`) returns tool_calls and the loop
  proceeds. Models are filterable in the dropdown by `supported_parameters:
  tools` so the user can't pick a model that can't drive the agent.
- **Scenario 5 — Jobs work**: A job's per-job model override can target an
  OpenRouter model (`JobEditor.svelte`), reusing the same catalog fetch and
  producing a `BackendOverride` that `resolveChatEndpoint` already handles.
- **Scenario 6 — Stop works**: The stop button aborts the in-flight request
  via `AbortController`. The UI surfaces a typed error message on
  `401`/`402`/`429` ("out of credits", "rate limited — retrying in Ns") and
  keeps any partial streamed content.
- **Scenario 7 — Credits visible**: The form shows the key's remaining
  credit limit, fetched from `GET /api/v1/key` on load and on a manual
  "Refresh" action. Free-tier users see the 20 RPM / 50-or-1000 RPD limits.

Explicitly NOT in v1:

- `models[]` fallback routing
- Per-provider routing preferences (`provider` field)
- OpenRouter plugins (web, file-parser, response-healing, context-compression)
- Message transforms
- EU in-region routing
- Per-provider data-policy labels in the model picker
- Structured-output / `response_format` (Haruspex doesn't use it today)
- Key creation / OAuth flow (link out to openrouter.ai/keys instead)

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│ Frontend (SvelteKit)                                             │
│  • InferenceSection.svelte — 3-way radio: local / remote / or    │
│  • OpenRouterForm.svelte (new) — API key, model search dropdown, │
│    credits badge, reasoning-effort selector                      │
│  • InferenceBackendForm.svelte — unchanged (generic remote)     │
│  • settings.ts — adds remoteBackendKind 'openrouter' + catalog   │
│    cache fields on InferenceBackendConfig                        │
│  • api.ts — resolveChatEndpoint() gains an OpenRouter branch that │
│    injects attribution headers; buildRequestBody() learns to     │
│    drop llama.cpp-only params (top_k, min_p, chat_template_kwargs)│
│    when the active backend is OpenRouter                         │
│  • parseSSE — learns to ignore `: OPENROUTER PROCESSING` comment │
│    keepalives and to surface mid-stream `error`/`finish_reason:  │
│    'error'` chunks                                                │
│  • think-stream — extends to read delta.reasoning /              │
│    delta.reasoning_details in addition to reasoning_content      │
└──────────────────────────────────────────────────────────────────┘
                            │ fetch() to
                            │   https://openrouter.ai/api/v1/...
                            ▼
                 (no Rust proxy — straight to OpenRouter)

┌──────────────────────────────────────────────────────────────────┐
│ Rust Backend — src-tauri/src/inference.rs                         │
│  • No new chat-completion proxy. The catalog + key-status fetches │
│    happen frontend-side via fetch() (CORS-permissive on OpenRouter)│
│  • Reuses probe_inference_server's try_openai_compat branch only  │
│    if a user pastes an OpenRouter URL into the generic "Remote"   │
│    form; the dedicated OpenRouter path bypasses probe entirely.  │
│  • InferenceBackendKind gains an 'openrouter' variant for the     │
│    generated ts-rs bindings (run scripts/export-ipc-types.sh).   │
└──────────────────────────────────────────────────────────────────┘
```

### Why no Rust proxy

Chat completions today go straight from the webview via `fetch()` to either
`http://127.0.0.1:8765` (local) or `${remoteBaseUrl}` (remote) — there is no
Rust HTTP proxy in either case (`api.ts:301`). OpenRouter is CORS-open for
browser clients, so adding a Rust proxy would only add latency and a new
failure mode. The API key is already stored in localStorage and sent as a
Bearer header from the frontend for the generic remote path; OpenRouter is
the same pattern.

### Why a dedicated form, not the generic remote form

The generic `InferenceBackendForm` is built around `probe_inference_server`,
which tries llama-toolchest's `/api/service/status`, then llama-server's
`/props`, then OpenAI-compat `/v1/models`, then Ollama's `/api/tags`
(`inference.rs:273-461`). Against OpenRouter that means three guaranteed-404
(or worse, 429) requests before the catalog arrives, with no context/vision
metadata at the end. A dedicated form fetches `GET /api/v1/models` once and
gets `context_length`, `architecture.input_modalities`,
`supported_parameters`, `pricing`, and `reasoning` caps in a single response.

---

## Detailed Changes

### 1. Settings model — `src/lib/stores/settings.ts`

- Add `'openrouter'` to `InferenceBackendKind` (`:31-36`). Re-run
  `scripts/export-ipc-types.sh` so the Rust enum and generated
  `src/lib/ipc/gen/*.ts` stay in sync (CI enforces this — audit X2/X3).
- Add catalog cache fields to `InferenceBackendConfig` (`:79-130`):
  ```ts
  openrouterCatalog: OpenRouterModel[] | null;   // cached /api/v1/models result
  openrouterCatalogAt: number | null;             // epoch ms of last fetch
  openrouterKeyStatus: OpenRouterKeyStatus | null; // cached /api/v1/key result
  openrouterKeyStatusAt: number | null;
  ```
  Defaults all `null`. Deep-merge in `loadSettings()` (`:402-408`) keeps
  upgrading users' configs intact.
- Add a `RemoteReasoningCaps`-shaped helper that derives from an
  `OpenRouterModel.reasoning` object so `isReasoningSupported()` (`:565-571`)
  and `getChatTemplateKwargs()` (`:590-601`) work for OpenRouter models
  without special-casing at every call site.
- `getSamplingParams()` (`:832-838`) currently always returns Qwen-family
  `top_k`/`min_p`/`presence_penalty` from `SAMPLING_PROFILES` (`:644-667`).
  Add a branch: when `remoteBackendKind === 'openrouter'`, omit `top_k` and
  `min_p` (gate on backend kind, not per-model `supported_parameters` —
  simpler and safe; OpenRouter speaks OpenAI's param set) and keep
  `temperature`/`top_p` only.
- Catalog TTL: 24 h (configurable). Stale catalog is shown with a "refresh"
  affordance rather than blocking.

### 2. Settings UI — `src/lib/components/settings/InferenceSection.svelte`

- Add a third radio option to the mode picker (`:136-163`):
  ```
  ( ) Local (Haruspex-managed)
  ( ) Remote server (advanced)
  ( ) OpenRouter (cloud)        ← new
  ```
  The OpenRouter option's hint text carries the privacy warning:
  "Cloud — your prompts leave your device and go to OpenRouter's servers."
- `setInferenceMode('openrouter')` (`:35-75` analog): stops any local sidecar
  (`stopServer()`), sets `mode: 'remote'`, `remoteBaseUrl:
  'https://openrouter.ai/api'`, `remoteBackendKind: 'openrouter'`, clears any
  stale `remoteServerUrls` entry that would collide, and renders the new
  `OpenRouterForm` instead of `InferenceBackendForm`.
- Switching back to local or generic-remote restores the existing forms
  unchanged.

### 3. New component — `src/lib/components/settings/OpenRouterForm.svelte`

Roughly mirrors `InferenceBackendForm.svelte`'s layout but with OpenRouter-
specific fields. Keep under the ESLint `max-lines` 400 / `max-lines-per-
function` 80 thresholds (use small sub-components for the model list and the
credits badge if needed — the audit's `complexity` 15 / `max-depth` 4 limits
apply).

Fields:

- **API key** (password input) — bound to `inferenceBackend.remoteApiKey`.
  "Get a key" link to `https://openrouter.ai/keys`. "Test key" button hits
  `GET /api/v1/key` and shows remaining credits + free-tier limits.
- **Model** — searchable dropdown (combobox) in a split-out
  `OpenRouterModelPicker.svelte` (hand-rolled, no new dependency) listing
  `openrouterCatalog`. Each entry: `name` (display), `id` (mono, e.g.
  `anthropic/claude-sonnet-4.5`), context length, free/paid badge, deprecated
  flag (dimmed + tooltip with `expiration_date`). Filter toggle "Only models
  with tool support" filters on `supported_parameters.includes('tools')`.
  Default: remember last-used model id per-device; first run (no remembered
  id) selects `openrouter/auto`.
- **Reasoning effort** — shown only when `selectedModel.reasoning` is present.
  Dropdown of `supported_efforts` defaulting to `default_effort`. Hidden for
  `mandatory: true` models (locked to required effort).
- **Context size** — auto-filled from `model.context_length`, editable.
- **Vision** — auto-filled from `model.architecture.input_modalities`
  includes `'image'`. Editable override kept for parity with the generic form.
- **Allow parallel inference** — defaults **on** for OpenRouter (hosted API,
  no single-slot constraint) but user-toggleable.
- **Refresh catalog** button — re-fetches `GET /api/v1/models` regardless of
  TTL.

### 4. API layer — `src/lib/api.ts`

- `resolveChatEndpoint()` (`:156-192`) — add an OpenRouter-aware branch. The
  cleanest hook is to check `backend.remoteBackendKind === 'openrouter'` and
  inject the attribution headers in addition to the Bearer token:
  ```ts
  headers['HTTP-Referer'] = 'https://github.com/tmac1973/haruspex';
  headers['X-Title'] = 'Haruspex';
  ```
  The URL and model fields are already correct (`${remoteBaseUrl}/v1/chat/
  completions` = `https://openrouter.ai/api/v1/chat/completions`).
- `buildRequestBody()` (`:194-238`) — gate the llama.cpp-only fields on the
  active backend kind:
  - `top_k`, `min_p` — only emit when `remoteBackendKind !== 'openrouter'`
    (or per-model `supported_parameters` whitelist; simpler to gate on
    backend kind for v1).
  - `chat_template_kwargs` — same gate. OpenRouter ignores unknown body
    fields, but sending `enable_thinking` to a Claude model is misleading and
    the thinking panel should instead be driven by the `reasoning` request
    param.
  - Add the OpenRouter `reasoning` object when the selected model supports it
    and the user picked an effort: `{ reasoning: { effort } }`. This replaces
    `chat_template_kwargs` for OpenRouter reasoning models.
- `parseSSE()` / `parseSSELine()` (`:248-269`, `:318-341`) — two additions:
  - Ignore SSE comment keepalive lines (`: OPENROUTER PROCESSING`). Currently
    `parseSSELine` returns `null` for any line not starting with `data: `,
    which already covers comment lines — **verify** and add an explicit guard
    + test if needed.
  - Surface mid-stream errors: when a chunk carries a top-level `error` and
    `choices[0].finish_reason === 'error'`, yield a typed `StreamChunk` that
    the consumer can render (see `agent/parser.ts` /
    `chat.svelte.ts` for where to convert it into a visible message without
    dropping already-streamed content).
- `combineReasoningAndContent()` (`:276-283`) — extend to also accept
  `reasoning_details` arrays; for v1 concatenate the `text`/`summary` items
  in order. **Preserve `reasoning_details` across tool-call turns** — this is
  a documented OpenRouter requirement for multi-turn reasoning quality. The
  agent loop's message history builder (`iteration.ts`) must echo the prior
  turns' `reasoning_details` back unmodified and in original order. This
  touches the message-construction path in `iteration.ts` and the parser
  (`agent/parser.ts`) where `reasoning_details` must be captured from each
  response and threaded into the subsequent request's assistant message.

### 5. Catalog + key-status fetch — new `src/lib/openrouter.ts`

A small module with two functions, both plain `fetch()` from the frontend:

- `fetchOpenRouterCatalog(signal?): Promise<OpenRouterModel[]>` —
  `GET https://openrouter.ai/api/v1/models` (no auth needed, edge-cached).
  Parse `data[]` into a typed array. Sort by `most-popular`-ish heuristic
  (or just `name`) for the dropdown. Cache in `inferenceBackend.openrouter
  Catalog` with a 24 h TTL.
- `fetchOpenRouterKeyStatus(apiKey, signal?): Promise<OpenRouterKeyStatus>` —
  `GET https://openrouter.ai/api/v1/key` with `Authorization: Bearer <key>`.
  Returns `{ label, limit_remaining, is_free_tier, usage_daily, ... }`.
  Surface the free-tier limits (20 RPM, 50 or 1000 RPD) in the form.

Types (`OpenRouterModel`, `OpenRouterKeyStatus`) live in this module (not in
`src/lib/ipc/gen/` — these aren't Rust-generated). Mirror the OpenRouter
docs schema: `id`, `name`, `context_length`, `architecture.input_modalities`,
`supported_parameters`, `pricing`, `reasoning`, `expiration_date`.

### 6. Inference queue — `src/lib/agent/inferenceQueue.svelte.ts`

`laneFor(backend?)` (`:100-109`) already builds a `remote:<baseUrl>` lane for
any remote backend. OpenRouter lands in `remote:https://openrouter.ai/api`
automatically. No change needed — **verify** the lane string is stable and
that `allowParallelInference: true` (the new OpenRouter default) makes the
queue admit concurrent turns against OpenRouter as expected.

### 7. Per-job override — `src/lib/components/jobs/JobEditor.svelte`

The job editor already reuses `probe_inference_server` (`:268`). Add an
"OpenRouter" affordance to the per-job model picker that reuses the catalog
cache + `OpenRouterForm`-style combobox. The resulting `BackendOverride`
(`api.ts:100-107`) is already consumed unchanged by `resolveChatEndpoint` and
`runEphemeralTurn.ts:103`. **Defer to v1.1 if scope creeps** — v1 can ship
with OpenRouter jobs configured via the global setting only.

### 8. Rust side — `src-tauri/src/inference.rs`

Minimal:

- Add `OpenAiRouter` (or `OpenRouter`) to the `InferenceBackendKind` enum
  mirrored on the Rust side (`:31-36` of `settings.ts` is the TS view; the
  Rust enum lives in `inference.rs` near the probe structs). This keeps the
  generated ts-rs bindings honest even though the Rust probe itself is
  bypassed for the dedicated OpenRouter path.
- Re-run `scripts/export-ipc-types.sh` and commit the regenerated
  `src/lib/ipc/gen/*.ts` + `src/lib/ipc/commands.ts`. CI fails on drift.
- No new Tauri command. The catalog and key-status fetches stay in the
  frontend; OpenRouter is CORS-open and there's no benefit to proxying.

### 9. README + setup wizard

- Update `README.md:282` to remove the "not a supported configuration"
  caveat for OpenRouter and document it as a supported cloud backend with the
  privacy caveat up front.
- First-run wizard (`stores/setup.svelte.ts:15`): the `remote` step stays as
  the self-hosted-remote path. Do NOT add OpenRouter to the first-run
  wizard — it's an advanced/opt-in choice that belongs in Settings, not the
  default onboarding flow. (Open to revisiting if user feedback says
  otherwise.)

---

## Streaming & Error Handling

OpenRouter's streaming has three behaviors the existing `parseSSE` must
cope with:

1. **Comment keepalives**: `: OPENROUTER PROCESSING` lines during long
   upstream waits. `parseSSELine` already returns `null` for non-`data: `
   lines, so this is likely a no-op — **add a regression test** that feeds
   a comment line and asserts `null`.
2. **Final usage chunk**: empty `choices` array with a `usage` object.
   `parseSSELine:264` already handles this and yields it as a chunk. No
   change.
3. **Mid-stream error**: a chunk with top-level `error` and
   `choices[0].finish_reason === 'error'`. Currently `parseSSELine` would
   yield the chunk's (empty) delta and the `error` would be silently
   dropped. Add an `error` field to `StreamChunk` and surface it; the chat
   store's stream consumer (`chat.svelte.ts`) should append the typed error
   message to the visible transcript and keep whatever partial content
   already streamed.

Error mapping (HTTP status → user-visible message), all in the frontend:

| Status | `error_type` | Message |
|---|---|---|
| 401 | `authentication` | "Your OpenRouter API key is invalid or revoked. Re-enter it in Settings." |
| 402 | `payment_required` | "You're out of OpenRouter credits. Top up at openrouter.ai/credits." |
| 429 | `rate_limit_exceeded` | "OpenRouter rate limit hit. Retry-After: Ns." (honor the `Retry-After` header) |
| 503 | `provider_overloaded` | "OpenRouter's provider is overloaded. Try again in a moment." |
| 404 | `not_found` | "This model was removed from OpenRouter. Pick another in Settings." |

`sendChatRequest()` (`api.ts:291-316`) already maps non-2xx to `ApiError`
with the status; extend the message construction to parse OpenRouter's
`{ error: { code, message, metadata: { error_type } } }` envelope and pick
the row above.

---

## Privacy

OpenRouter is a cloud service — using it inherently sends prompts off-device.
This phase preserves Haruspex's privacy stance by:

- **Defaulting to local.** The default `InferenceMode` stays `'local'`. No
  user is ever auto-migrated to OpenRouter.
- **Explicit labeling.** The OpenRouter radio option and form both carry a
  visible "Cloud — prompts leave your device" warning. The server status
  badge (which already shows `"model-id @ host:port"` for remote —
  `server.svelte.ts:235-247`) shows `"model-id @ OpenRouter (cloud)"` for
  OpenRouter so it's always visible which mode the user is in.
- **No opt-in to data-use.** OpenRouter's two privacy toggles (private I/O
  logging, and "use of inputs/outputs" for the 1% discount) both default to
  off account-side; Haruspex sends no signals that would enable either. The
  `provider` preferences field is not sent in v1, so we don't constrain
  routing to zero-retention providers — **document this as a known limitation**
  in the form's privacy hint and link to OpenRouter's account-level setting.
- **No telemetry from Haruspex.** The attribution headers (`HTTP-Referer`,
  `X-Title`) identify the client app to OpenRouter for their public
  leaderboard; they don't carry any user or conversation data.

A future phase can fetch `/api/frontend/all-providers` and label individual
models with their `dataPolicy` (retainsPrompts, retentionDays, training) so
privacy-conscious users can pick zero-retention providers from within
Haruspex. That's deferred (see Resolved Decisions).

---

## Testing

- **Unit tests** (Vitest, co-located `*.test.ts`):
  - `openrouter.test.ts` — catalog parser against a fixture, key-status
    parser, TTL logic.
  - `api.test.ts` (extend) — `resolveChatEndpoint` returns the OpenRouter
    URL + attribution headers when `remoteBackendKind === 'openrouter'`;
    `buildRequestBody` omits `top_k`/`min_p`/`chat_template_kwargs` for
    OpenRouter and includes the `reasoning` object for a reasoning model.
  - `parseSSE` regression tests — comment keepalive ignored, final usage
    chunk yielded, mid-stream error chunk surfaced with `error` field.
  - `settings.test.ts` (extend) — deep-merge preserves existing remote
    configs when the new OpenRouter fields are added; catalog TTL respected.
- **Cargo**: `cargo test` for the `InferenceBackendKind` enum change (just
  the ts-rs export test — re-export targets `src/lib/ipc/gen/`).
- **Manual smoke**: run `make dev`, switch to OpenRouter in Settings, paste a
  real key, run a chat with a reasoning model and a non-reasoning model,
  trigger a tool call, abort a stream, exhaust credits on a free model and
  confirm the 402 message renders.
- **CI gates**: `make check` (lint + format + typecheck + test + cargo
  clippy `-D warnings` + cargo test + IPC drift). Add the `windows-ci` label
  if any `#[cfg(windows)]` branch is touched (none expected here — all
  changes are frontend + a Rust enum addition).

---

## Open Questions

All open questions resolved during planning (see Resolved Decisions table and
the per-section notes above). Summary of the settled answers:

- **Reasoning history across tool turns**: preserve `reasoning_details`
  unmodified and in order across tool-call turns in v1 (touches `iteration.ts`
  message construction + `agent/parser.ts`).
- **Model picker UX at ~300 entries**: hand-rolled combobox in a split-out
  `OpenRouterModelPicker.svelte` (stays under the 400-line ESLint limit). No
  new dependency.
- **Default model**: remember last-used model id per-device; first run
  defaults to `openrouter/auto`.
- **`top_k` / `min_p`**: gate on backend kind — omit for OpenRouter entirely
  (safe; OpenRouter speaks OpenAI's param set). No per-model lookup needed.
