# Design Pattern Audit — Haruspex

- **Date:** 2026-05-14
- **Scope:** Rust backend (`src-tauri/src/`) and TS/Svelte frontend (`src/`).
- **Method:** Identifier-level grep + targeted reads to confirm each claimed pattern. Findings cite `file:line` and the identifier. Severity 1–10 (0 = "well-applied; no action").
- **Reference audits in this folder:**
  - [`code-duplication-2026-05-14.md`](./code-duplication-2026-05-14.md)
  - [`code-complexity-2026-05-14.md`](./code-complexity-2026-05-14.md)

> **Note on severity.** Most of the patterns surveyed are well-applied; severity 0 is the dominant rating because the codebase consistently uses idiomatic Tauri / Svelte 5 patterns rather than reinventing them. The eight findings worth acting on are summarized in the **Action Items** section.

---

## Executive Summary

| # | Pattern | Location | Verdict | Severity |
| --- | --- | --- | --- | --- |
| P-1 | Strategy via `match` on provider string (search) | `proxy.rs:1123-1152`, `proxy.rs:715-719` | Anti-pattern at N≈6 backends | **6** |
| P-2 | State machine implicit in `runAgentLoop` flags | `loop.ts:267-293` | Should be formalized | **5** |
| P-3 | Pipeline in `sendMessage` is implicit CoR | `chat.svelte.ts:499-580` | Could be middleware | **4** |
| P-4 | Sidecar trait missing (`Llama`/`Whisper`/`Tts`) | `server.rs`, `whisper.rs`, `tts.rs` | Trait would dedupe ~250 LOC | **5** (folds into duplication R-1/R-2/R-3) |
| P-5 | `fsWriteWithConflictCheck` is a HOF, but each tool re-wires it | `fs-write.ts` | Wrap once via executor factory | **3** (folds into duplication T-4) |
| P-6 | Sub-agent helper missing (research/email summarize) | `web.ts`, `email.ts` | Extract `runSubAgent` | **4** (folds into duplication T-2) |
| P-7 | `AppLogger` is a multi-sink, not a Decorator | `app_log.rs:48-91` | Naming/doc nit; behavior is correct | **1** |
| P-8 | DB facade swallows all errors silently | `src/lib/stores/db.ts` | Bubble auth-relevant errors | **3** |
| — | All other patterns (Tauri singletons, tool registry, sidecar adapters, Tauri events, Tauri commands, Repository, DTOs, Promise-bridged modals, Strategy via registry) | various | Well-applied | 0 |

---

## Creational Patterns

### Singleton via Tauri State — well-applied (Severity 0)

`src-tauri/src/lib.rs:38-53` constructs every long-lived service exactly once and hands ownership to Tauri:

```rust
app.manage(ModelManager::new(app.handle()));
app.manage(Database::new(app.handle()).expect("Failed to initialize database"));
app.manage(LlamaServer::new())
   .manage(ProxyState::new())
   .manage(AudioRecorder::new())
   .manage(WhisperServer::new())
   .manage(TtsEngine::new());
```

Tauri commands then receive them via `tauri::State<'_, T>`. This is the framework-blessed singleton; no `lazy_static`, no `OnceLock` (except in `app_log.rs:15` for the log ring buffer), no global mutability outside `Mutex`/`Arc`. Verdict: **idiomatic, no action**.

### Singleton via Svelte 5 module-level runes — well-applied (Severity 0)

Each `src/lib/stores/*.svelte.ts` is a module-scoped singleton holding `$state` runes, exposed only through getter/setter functions:

- `chat.svelte.ts:125-139` — `conversations`, `activeConversationId`, `workingDir`, `isGenerating`, `errorMessage`
- `server.svelte.ts:45-49` — `serverState`, paired with `listenerInitialized` guard at line 63 to prevent double event subscription
- `setup.svelte.ts:36-44` — `downloadProgress`, `currentModelId`, `currentStep`
- `context.svelte.ts:9-13` — token usage state, with a `$derived` percentage at `:51-54`
- `fileConflict.svelte.ts:34` and `sandboxApproval.svelte.ts:29` — singleton `pending` slots for modal coordination (see "Promise-bridge" pattern below)

Verdict: idiomatic Svelte 5 store layout. **No action.**

### Self-Registering Factory (Tool Registry) — well-applied (Severity 0)

`src/lib/agent/tools/registry.ts:6-10` defines the registry; each tool file calls `registerTool({…})` at module load time (34 `registerTool(` invocations confirmed by grep). Dispatch in `executeTool` (`registry.ts:49-65`) is a `Map.get`, not a switch:

```ts
const reg = tools.get(name);
if (!reg) return toolResult(toolError(`Unknown tool: ${name}`));
return reg.execute(args, ctx);
```

This is technically more **Self-Registering Object** + **Strategy** than classical Factory (it doesn't construct anything — it stores pre-built registrations), but the name doesn't matter; the structure is the correct shape for a 30+ tool surface. Filtering in `getToolSchemas` (`registry.ts:21-44`) cleanly handles category-based exposure (fs / email / sandbox / vision-only). **No action.**

### Builder (`ServerConfig::build_args`) — well-applied (Severity 0)

`src-tauri/src/server.rs:73-107` — `build_args(&self, model_path: &str) -> Vec<String>`. Plain struct + `Default` impl + a single build method. Not the chained `.with_ctx_size(...)` form, but the field-mutation form is idiomatic Rust for a one-shot serializer. **No action.**

### Builder-by-composition (System Prompt) — well-applied (Severity 0)

`src/lib/agent/system-prompt.ts:18-87` — `buildSystemPrompt(workingDir)` composes conditional sections (fs, email, sandbox) into one `ChatMessage`. `injectMessageHints` (`:94-150`) layers in additional turn-specific guidance. Functional composition rather than a class-based Builder; appropriate for the domain. **No action.**

---

## Structural Patterns

### Adapter: Sidecar process wrappers — correctly applied, but duplicated (Severity 5, dup-audit cross-ref)

Each of `LlamaServer` (`server.rs:132-803`), `WhisperServer` (`whisper.rs:56-…`), `TtsEngine` (`tts.rs:60-…`) adapts an opaque external CLI into a Rust struct with `start/stop/get_status` methods. The adapter itself is correct; **the problem is that the adapter is implemented three times instead of via a shared trait**:

```rust
// Proposed: src-tauri/src/sidecar_utils.rs
#[async_trait::async_trait]
pub trait SidecarService: Send + Sync + 'static {
    fn name(&self) -> &'static str;
    fn port(&self) -> u16;
    async fn spawn(&self, app: &AppHandle, args: Vec<String>) -> Result<(), String>;
    async fn stop(&self) -> Result<(), String>;
    async fn status(&self) -> SidecarStatus;
}
```

This **subsumes findings R-1 / R-2 / R-3 in the duplication audit** (port killing, health polling, log helpers). Folding the three sidecars under one trait deletes ~250 LOC and lets `start_server` / `start_whisper` / `start_tts` share `kill_process_on_port` + `poll_health` + `strip_ansi` / `push_log`.

### Adapter: API surface (`api.ts`) — well-applied (Severity 0)

`src/lib/api.ts:126-148` — `resolveChatEndpoint` picks between the local llama-server and a configured remote backend.
`src/lib/api.ts:239-300` — `chatCompletionStream` parses SSE from either side into a uniform `AsyncIterable<StreamChunk>`.

This is a textbook adapter: the agent loop (`loop.ts`) consumes a single interface regardless of which backend serves the request. **No action.**

### Adapter: PDF.js, marked, IMAP/SMTP — well-applied (Severity 0)

- `src/lib/agent/pdf-render.ts:1-81` — wraps PDF.js worker init + canvas rendering into `renderPdfPages(buffer, opts)` returning data URLs. Adapter cleanly hides PDF.js's stateful API.
- `src/lib/markdown.ts` — wraps `marked` with custom code-block renderer, `fixMalformedTables` preprocessor, `stripToolCallArtifacts` postprocessor. Domain-specific extension of a generic parser.
- `src-tauri/src/integrations/email/imap_client.rs:78-100` — connect-per-call adapter over `async-imap`. The "no pooling" decision is documented in the file header and is the right call for this domain (sporadic IMAP traffic).

**No action** on any of these.

### Facade: `lib.rs` invoke handler + `db.ts` — mostly correct (Severity 3 for db.ts error handling)

- `lib.rs:54-…` registers **72 Tauri commands** via `tauri::generate_handler![...]`. This is pass-through more than facade — each command delegates directly to its module — but it's the right shape for Tauri. **No action.**
- `src/lib/stores/db.ts` (`initDb`, `dbSaveMessage`, `dbLoadMessages`, `dbReplaceMessages`, `dbCreateConversation`, `dbRenameConversation`, `dbDeleteConversation`, `dbClearAll`) — facade over `invoke('db_*', …)`. **Issue:** errors are swallowed (`try { … } catch { /* nothing */ }`). For the persistence happy path that's reasonable (UI keeps working when SQLite isn't available); for **save** operations it silently drops data. Recommended fix:

```ts
// src/lib/stores/db.ts
export async function dbSaveMessage(conversationId: string, msg: ChatMessage): Promise<void> {
	try {
		await invoke('db_save_message', { conversationId, message: serializeMessage(msg) });
	} catch (e) {
		// Surface to logs at least; the UI continues to function from in-memory state.
		debugLog('db', 'dbSaveMessage failed', { conversationId, error: String(e) });
	}
}
```

Severity 3 — not catastrophic since in-memory state continues, but unobservable data loss is worth a log line.

### Decorator: `AppLogger` — mislabelled, behaviour is correct (Severity 1)

`src-tauri/src/app_log.rs:48-91` implements `log::Log` and routes every record to two sinks (stderr + in-memory `VecDeque`). It does **not** wrap an inner `Log` — there's no decorated subject. This is the **Tee / Composite Sink** pattern, not Decorator. The behaviour (filtering sidecar-passthrough prefixes from the buffer while keeping them on stderr) is correct and well-commented. Only the naming/comments in any future doc would benefit from precision. **No code change.**

### Proxy: HTTP proxy (`proxy.rs`) and Worker proxy (`worker-manager.ts`) — well-applied (Severity 0)

- `src-tauri/src/proxy.rs` — `ProxyState` holds caches, rate limits, and engine failure cooldowns; `apply_proxy` injects user-configured HTTP proxy; `proxy_search`/`proxy_fetch` are the public surfaces. Paywall sentinel `HARUSPEX_PAYWALL_SIGNAL` (top of file) is a nice UX flag carried through to the frontend.
- `src/lib/sandbox/worker-manager.ts:94-170` — `WorkerManager` proxies calls into the Python worker via `postMessage`, handles cooperative interrupts via `SharedArrayBuffer`, and falls back to `worker.terminate()` on hang. This is the correct Proxy: every call goes through it, lifecycle is centralized.

**No action.**

### Promise-bridged Modal (Mediator-like) — well-applied (Severity 0)

`src/lib/stores/fileConflict.svelte.ts:43-55` and `src/lib/stores/sandboxApproval.svelte.ts:35-50` implement a notable, non-trivial pattern worth calling out:

```ts
let pending = $state<PendingConflict | null>(null);

export function askFileConflict(path: string): Promise<FileConflictChoice> {
	if (pending !== null) return Promise.reject(new Error(…));   // serialized by design
	return new Promise<FileConflictChoice>((resolve) => { pending = { path, resolve }; });
}

export function resolveConflict(choice: FileConflictChoice): void {
	const current = pending;
	if (current === null) return;
	pending = null;
	current.resolve(choice);
}
```

A reactive `$state` cell bridges an async caller (tool wrapper) and a UI component (Svelte modal) via a stored resolver. Reject-on-overlap (line 44-50) intentionally surfaces a programming bug instead of queuing silently. This is **idiomatic for Svelte 5 + Promise-based UI prompts** and is implemented correctly. **No action.**

---

## Behavioral Patterns

### Strategy via `match`-on-string (search backends) — anti-pattern at N≈6 (Severity 6)

**Location:** `src-tauri/src/proxy.rs:1123-1152` (`proxy_search`) and `:715-719` (`search_auto`). Two layers of `match` against `provider`/`engine` strings dispatch to one of six functions: `search_duckduckgo`, `search_mojeek`, `search_brave_html`, `search_brave`, `search_searxng`, plus `search_auto` itself.

```rust
let results = match provider {
    "brave"   => search_brave(&query, key, recency, proxy_ref).await?,
    "searxng" => search_searxng(&query, url, recency, proxy_ref).await?,
    "auto"    => search_auto(&state, &query, recency, deep_research, proxy_ref).await?,
    _         => search_duckduckgo(&query, recency, proxy_ref).await?,
};
```

The pattern works, but at six backends with shared concerns (rate-limit cooldown, paywall detection, proxy injection, result parsing) the duplication starts to bite. Adding a seventh backend requires edits in `proxy_search`, `search_auto`, plus a new function with its own copy of the shared boilerplate.

**Remediation — small `SearchBackend` trait, dispatch via enum tag:**

```rust
// src-tauri/src/proxy/search/mod.rs (after the proxy.rs module split proposed in code-complexity audit C-9)
#[async_trait::async_trait]
pub trait SearchBackend: Send + Sync {
    async fn search(
        &self,
        state: &ProxyState,
        query: &str,
        recency: &str,
        proxy: Option<&ProxyConfig>,
    ) -> Result<Vec<SearchResult>, String>;
}

pub struct DuckDuckGo;
pub struct Mojeek;
pub struct BraveHtml;
pub struct Brave { api_key: String }
pub struct Searxng { instance_url: String }

// proxy_search becomes:
pub async fn proxy_search(state: State<'_, ProxyState>, /* … */) -> Result<Vec<SearchResult>, String> {
    let backend: Box<dyn SearchBackend> = match provider.as_deref() {
        Some("brave")   => Box::new(Brave { api_key: api_key.unwrap_or_default() }),
        Some("searxng") => Box::new(Searxng { instance_url: instance_url.unwrap_or_else(default_searxng) }),
        Some("auto")    => Box::new(AutoBackend::new(deep_research)),
        _               => Box::new(DuckDuckGo),
    };
    backend.search(&state, &query, &recency, proxy.as_ref()).await
}
```

Per-backend file: `proxy/search/{ddg,mojeek,brave,brave_html,searxng,auto}.rs`. Shared concerns (proxy injection, rate limiting, paywall sentinel) move into trait default methods or free helpers in `proxy/search/mod.rs`. After the split, adding a backend = one new file plus one match arm.

Severity 6: maintainability concern, not a bug. Schedule after the duplication-audit / complexity-audit modular split of `proxy.rs` (C-9).

### Strategy via tool registry — correctly applied (Severity 0)

`src/lib/agent/tools/registry.ts:49-65` is the **right** way to do strategy dispatch at this scale (30+ tools). Each tool module owns its full `ToolRegistration` (schema + execute + displayLabel), registers itself on import, and dispatch is `tools.get(name).execute(...)`. Confirmed 34 `registerTool(` call sites across `fs-read.ts`, `fs-write.ts`, `web.ts`, `email.ts`, `sandbox.ts`, `python-lint.ts`. **No action.**

### Chain of Responsibility — applied correctly in inference probe; implicit-and-could-be-explicit in `sendMessage` (Severity 4)

**Correctly applied:** `src-tauri/src/inference.rs:181-191` walks four detection strategies in priority order:

```rust
if let Some(result) = try_llama_toolchest(&client, &normalized, api_key_ref).await { return Ok(result); }
if let Some(result) = try_llama_server(&client, &normalized, api_key_ref).await   { return Ok(result); }
if let Some(result) = try_openai_compat(&client, &normalized, api_key_ref).await  { return Ok(result); }
if let Some(result) = try_ollama_native(&client, &normalized, api_key_ref).await  { return Ok(result); }
```

Each handler is independent; the early-exit semantic is explicit. **No action.**

**Implicit / worth formalizing:** `src/lib/stores/chat.svelte.ts:499-580` — `sendMessage` calls `compactIfNeeded → buildSystemPrompt → spliceLastTurnTools → injectMessageHints → runAgentLoop` in sequence. Each step transforms `messagesForApi` or the conversation state. Adding a new preprocessing concern (e.g., a token-budget pre-trim) currently means editing `sendMessage` directly.

**Optional remediation — a small middleware chain:**

```ts
// src/lib/agent/middleware.ts
export interface MessageMiddleware {
    name: string;
    process(messages: ChatMessage[], ctx: TurnContext): Promise<ChatMessage[]> | ChatMessage[];
}

export async function applyMiddleware(
    initial: ChatMessage[],
    middlewares: MessageMiddleware[],
    ctx: TurnContext
): Promise<ChatMessage[]> {
    let msgs = initial;
    for (const m of middlewares) msgs = await m.process(msgs, ctx);
    return msgs;
}

// chat.svelte.ts (post-refactor; also helps complexity audit C-3)
const middlewares: MessageMiddleware[] = [
    systemPromptMiddleware(currentWorkingDir),
    lastTurnToolsMiddleware(conversation),
    hintsMiddleware({ workingDir: currentWorkingDir, exhaustiveResearch }),
];
const messagesForApi = await applyMiddleware([...historyMessages], middlewares, ctx);
```

Severity 4 — not strictly needed today, but enabling it makes the complexity-audit C-3 refactor cleaner. **Apply opportunistically when splitting `sendMessage`.**

### State Machine implicit in agent loop — should be explicit (Severity 5)

**Location:** `src/lib/agent/loop.ts:267-293` declares 14 mutable per-turn flags inside `runAgentLoop`:

```ts
let iteration = 0;
let usedTools = false;
let fileWrittenThisTurn = false;
let fileWriteRetries = 0;
let webSearchUsed = false;
const fetchedUrlsThisTurn: Set<string> = new Set();
let diversityNudged = false;
let consecutiveRunPythonFailures = 0;
// ... plus lastFinish, streamUsage etc.
```

These flags are inspected at 8+ widely-separated sites (`:378-389`, `:439-446`, `:632-690`, `:765-792`, `:821-841`). Reasoning about which combinations are valid requires holding all 14 in your head.

**Remediation — encapsulate per-concern, not necessarily a full FSM.** A class with named methods reads better than a transition table for this domain:

```ts
// src/lib/agent/loop/nudges.ts
export class NudgeState {
    fileWritten = false;
    fileWriteRetries = 0;
    webSearchUsed = false;
    fetchedUrls = new Set<string>();
    diversityNudged = false;
    private consecutiveRunPythonFailures = 0;

    onToolExecuted(name: string, result: string): void { /* update counters */ }
    needsFileWriteNudge(expectsFile: boolean): boolean { /* condition lives here */ }
    needsDiversityNudge(): boolean { /* … */ }
    needsRunPythonNudge(): boolean { return this.consecutiveRunPythonFailures >= 3; }
    consumeFileWriteNudge(): ChatMessage { /* mark consumed; return nudge message */ }
}
```

After extraction, the 39 `if` branches inside `runAgentLoop` collapse to a handful of `if (nudges.needsX())` calls. Severity 5; **this is the same recommendation as code-complexity audit C-1.**

### Observer — well-applied across both layers (Severity 0)

**Rust side** emits via `app.emit(event, payload)`:
- `src-tauri/src/server.rs:149-155` — `set_status` emits `server-status-changed`
- `src-tauri/src/server.rs` — `gpu-fallback-active`, `gpu-fallback-cleared` events
- `src-tauri/src/models.rs:356-375` — `download-progress-changed`, `download-complete`
- (Whisper and TTS emit analogous status events.)

**TS side** subscribes via `listen<T>(event, handler)`:
- `src/lib/stores/server.svelte.ts:89-103` — three listeners with idempotency guard at `:65-67`
- `src/lib/stores/setup.svelte.ts` — listens for download progress

Plus Svelte 5 in-process observation via `$state` / `$derived` / `$effect` (`context.svelte.ts:51-54` is a good `$derived` example).

The dual-layer story is clean: Rust owns state, emits transitions; TS mirrors state via runes; UI re-renders. **No action.**

### Command — Tauri's `#[tauri::command]` macro (Severity 0)

`tauri::generate_handler![ … ]` in `lib.rs:54-…` registers 72 commands. Each `#[tauri::command]` annotation transforms the function into a serializable Command object the frontend invokes via `invoke('name', args)`. Frontend tool execution itself is also a Command pattern (`loop.ts` collects `tool_calls`, registry resolves to handler, results append to message history). **No action.**

---

## Domain Patterns

### Repository — well-applied on both sides (Severity 0)

- **Rust:** `src-tauri/src/db.rs:45-310` — single `Database` struct wraps `Mutex<rusqlite::Connection>`. All SQLite access centralized here. Queries are inline (not in a query-builder DSL); appropriate for the scale.
- **TS:** `src/lib/stores/db.ts` — facade over the Tauri `db_*` commands, owns the schema↔API mapping (snake_case ↔ camelCase, multimodal-content marker, JSON envelope parsing).

Only nit is the silent-swallow noted under the Facade section (Severity 3). **No structural action.**

### Service Layer — well-applied (Severity 0)

`LlamaServer`, `WhisperServer`, `TtsEngine`, `ModelManager`, `ProxyState`, `AudioRecorder`, `Database` are all service objects: cohesive units owning a single domain (inference / transcription / TTS / model catalog / outbound HTTP / audio capture / persistence), exposed via Tauri State, accessed via DI. **No action** beyond the cross-cutting duplication noted as P-4.

### DTO / Value Objects — well-applied (Severity 0)

Confirmed clean separation between data carriers and behaviour-bearing types:

**Rust DTOs:** `MessageInput`, `DbMessage`, `ConversationSummary`, `ConversationWithMessages` (`db.rs`); `ServerStatus`, `GpuFallbackState`, `ServerConfig` (`server.rs`); `WhisperStatus`, `TtsStatus`; `BackendKind`, `NormalizedModel`, `ProbeResult` (`inference.rs`); `ModelInfo`, `DownloadProgress`, `HardwareInfo` (`models.rs`); `SearchResult`, `ProxyConfig`, `PageImage` (`proxy.rs`); `EmailListing`, `NormalizedMessage`, `EmailAccount` (`integrations/email/*`).

**TS DTOs:** `ChatMessage`, `ToolCall`, `ToolDefinition`, `Usage` (`api.ts:19-82`); `ToolContext`, `ToolRegistration`, `ToolExecOutput` (`tools/types.ts`); `Conversation`, `SearchStep`, `MessageStats` (`chat.svelte.ts`, `loop.ts`).

DTOs are immutable-by-convention; behaviour lives on services. Three sidecar `Status` enums are structurally identical — see duplication audit R-5 for the proposed `SidecarStatus` consolidation (this is a DTO de-duplication, not a pattern issue).

### Domain Model — intentionally thin (Severity 0)

The Rust backend is a data-plane + sidecar orchestrator; the TS frontend is where the agent's domain logic lives (`loop.ts`, system prompts, tool dispatch). Rust uses structs as DTOs almost everywhere; TS uses anemic `Conversation`/`ChatMessage` objects with logic in surrounding stores and functions. **This is appropriate for the architecture** — a richer domain model would be over-engineered for a Tauri app whose backend's job is to expose OS capabilities.

---

## Missing or Latent Patterns

### M-1 — `SidecarService` trait (folds into duplication R-1/R-2/R-3 and complexity C-4)

Three near-identical sidecars share zero abstractions today. The proposed trait, plus a shared `sidecar_utils.rs` module, deletes ~250 LOC and shrinks `impl LlamaServer` from 672 LOC to ~400. See the [duplication audit](./code-duplication-2026-05-14.md) and [complexity audit](./code-complexity-2026-05-14.md) for the full snippets.

### M-2 — `SearchBackend` trait (P-1 above)

See P-1 remediation snippet.

### M-3 — `runSubAgent` helper (folds into duplication T-2)

`src/lib/agent/tools/web.ts:191-213` (`research_url`) and `src/lib/agent/tools/email.ts:231-271` (`email_summarize_message`) hand-roll an identical 11-line sub-LLM-call block. A `runSubAgent(messages, maxTokens, signal)` helper in `src/lib/agent/tools/_helpers.ts` is already proposed in the duplication audit. This pattern is **Template Method** more than Strategy — both call sites do the same orchestration with different prompts.

### M-4 — Higher-order write executor (folds into duplication T-4)

`src/lib/agent/tools/fs-write.ts:69-91` already implements `fsWriteWithConflictCheck` as a HOF — good. But each of eight `fs_write_*` tools then writes a 6-line wrapper to forward to it (`:179, :213, :250, :295, :329, :374, :408, :438`). The Decorator-pattern intent is there; the registration sites just don't use it as a Decorator. The duplication audit T-4 proposes a `writeExecutor(command, payload)` factory that turns each `execute` into one line.

---

## What I Could Not Verify

- **`apply_proxy` body and paywall sentinel constant.** I confirmed `ProxyState`, the search dispatch, and `proxy_fetch` exist, but did not read `apply_proxy` line-by-line. The Strategy / Proxy verdicts assume the body matches the typical "build `reqwest::ClientBuilder` and inject `.proxy(...)`" shape. **What would prove it:** `grep -nA20 "^fn apply_proxy" src-tauri/src/proxy.rs`.
- **`AppLogger` install site.** I verified the impl block exists at `src-tauri/src/app_log.rs:48-91` but did not check where `log::set_logger(...)` is called (likely in `app_log::init()` invoked from `lib.rs::run`). The "behaviour is correct" judgment stands regardless of where it's installed. **What would prove it:** `grep -n "set_logger\|init\(\)" src-tauri/src/app_log.rs src-tauri/src/lib.rs`.
- **Whether `chat.svelte.ts`'s fan-in is actually 0 or the import is `'$lib/stores/chat'` (extension-less).** The repository-pattern verdict for the TS side does not depend on this, but if fan-in is high, splitting read/write surfaces of the chat store (see complexity audit C-14) becomes higher priority. **What would prove it:** `grep -rnE "from '\\\$lib/stores/chat'" src | wc -l`.

---

## Action Items (by priority)

1. **(Severity 6) Extract `SearchBackend` trait** in `src-tauri/src/proxy/search/`. Best done together with complexity-audit C-9 (the `proxy.rs` module split).
2. **(Severity 5) Extract `NudgeState` class** from `runAgentLoop`. Best done as part of complexity-audit C-1 (`runAgentLoop` decomposition).
3. **(Severity 5) Define `SidecarService` trait** + `sidecar_utils.rs`. Drives duplication-audit R-1/R-2/R-3 and complexity-audit C-4.
4. **(Severity 4) Introduce `MessageMiddleware`** to formalize the `sendMessage` pipeline. Best done with complexity-audit C-3 (`sendMessage` decomposition).
5. **(Severity 4) Extract `runSubAgent` helper.** Duplication-audit T-2.
6. **(Severity 3) Surface `db_save_*` errors** through `debugLog` instead of silently swallowing.
7. **(Severity 3) Add `writeExecutor` factory** for `fs_write_*` registrations. Duplication-audit T-4.
8. **(Severity 1) Rename / re-comment `AppLogger`** to "tee log sink" rather than "decorator" in any future docs.

Items 1–5 each have at least one cross-reference into the two prior audits, meaning the same refactor PR can resolve a duplication, complexity, *and* pattern finding simultaneously — a single ~4-day effort delivers compounding cleanup.
