# Design Pattern Audit — Haruspex

**Date:** 2026-06-09
**Scope:** `src/` (SvelteKit 5 / TypeScript, 118 files) + `src-tauri/src/` (Rust, 66 files), ~55k LOC.
**Method:** Parallel exploration across the four GoF/domain categories, then direct re-read and verification of every finding rated ≥ 5/10. Citations marked **Unable to verify** were surfaced by exploration but not personally re-read; the line numbers may drift.

---

## Executive summary

Haruspex is a **pattern-light, idiomatic-first** codebase. It leans on the platform's native idioms — Tauri managed state, Svelte 5 runes, Rust `OnceLock` — instead of hand-rolling GoF machinery, and that is the right call for a single-process desktop app. The patterns that *do* appear are mostly well-placed:

- **Strong:** Tool registry (Strategy + Command), agent recovery chain (Chain of Responsibility), Tauri events + runes (Observer), `proxy/` caching + engine rotation (Proxy), document-format adapters (Adapter), `Database` facade (Repository/Facade).
- **Weak / worth attention:** No service layer (commands call the DB directly — mostly fine, one genuine leak), anemic domain models, one unguarded `JSON.parse` in an otherwise-careful fallback chain, and a couple of "managed singleton" footguns around `.unwrap()` on poisoned mutexes.

There is **no payment processing, no auth-method strategy, no DB connection pool, and no DI container** in this app — those prompts items are N/A and noted as such rather than invented.

| # | Finding | Category | Importance |
|---|---------|----------|:---:|
| 1 | Unguarded `JSON.parse` on structured tool-call path discards recoverable calls | Behavioral (robustness) | **3** |
| 2 | `db_update_last_message_steps` inline SQL bypasses the repository | Domain (layering) | **5** |
| 3 | `Mutex::lock().unwrap()` on managed singletons can cascade-panic | Creational (robustness) | **5** |
| 4 | No service layer; scheduling/business logic scattered | Domain | **4** |
| 5 | Anemic domain models (pure data bags) | Domain | **3** |
| 6 | Adapter impls share no trait (document formats, email) | Structural | **3** |
| 7 | `Date.now()`-based tool-call IDs can collide | Behavioral | **3** |
| 8 | Missing: typed IPC / command facade (cross-cuts DTO duplication) | Domain | **4** |

---

## CREATIONAL PATTERNS

### Singleton — **Tauri managed state (Service Locator), verified**

The app uses Tauri's `app.manage(T)` as its singleton mechanism — one instance per type, retrieved by handlers via `tauri::State<'_, T>`. Verified at `src-tauri/src/lib.rs:55-86`:

```rust
app.manage(Database::new(app.handle()).expect("Failed to initialize database")); // lib.rs:56
.manage(LlamaServer::new())        // :79
.manage(InferenceQueue::new())     // :80
.manage(ProxyState::new())         // :81
.manage(SearchStats::new())        // :82
.manage(AudioRecorder::new()) .manage(WhisperServer::new())
.manage(TtsEngine::new()) .manage(ShellManager::new())
```

This is the **correct, idiomatic** Tauri singleton — no global statics, lifetime tied to the app, type-safe retrieval. The `Database` itself wraps `conn: Mutex<Connection>` (private, `db/mod.rs:208-209`), which is the right shape for a single-writer SQLite handle.

Genuine module-scoped singletons elsewhere are also idiomatic:
- `app_log.rs:15` — `static BUFFER: OnceLock<Mutex<VecDeque<String>>>` (log ring buffer). Correct lazy init.
- `integrations/email/imap_client.rs:59` — `static CONFIG: OnceLock<Arc<ClientConfig>>` memoizes the rustls config + crypto-provider install. Correct (pure, deterministic) — doubles as a Proxy/memoization (see Structural).
- `fs_tools/pdf_read.rs:19` — `static PDFIUM_AVAILABLE: OnceLock<bool>` for lazy capability detection.
- Frontend "singletons" are Svelte-5 module-level runes (`stores/server.svelte.ts:47`, `stores/context.svelte.ts`, `stores/activeTab.svelte.ts`, `stores/settings.ts:344`). Idiomatic — single-threaded JS, no race risk.

**Verdict:** Appropriate and correct. No simpler solution warranted. See Finding 3 for the one robustness caveat.

### Factory — present, lightweight, correct

Plain `new()` constructors (`ProxyState::new` `proxy/mod.rs:90`, `Database::new` `db/mod.rs:213`, `LlamaServer::new` `server/mod.rs`) and small helper factories (`sidecar_utils.rs:108` `http_client(timeout)`, `sidecar_utils.rs:73` `new_log_buffer()`). The closest to a *selecting* factory is `integrations/email/provider.rs:122` `preset_by_id(id) -> Option<&'static EmailProviderPreset>` (static lookup table). All appropriate; **no abstract-factory over-engineering** — good.

### Builder — functional, not struct-based

No `*Builder` structs. Instead, step-wise construction via functions: `agent/system-prompt.ts:18` `buildSystemPrompt()`, `shell/system-prompt.ts:39` `buildShellSystemPrompt()`, and `server/mod.rs:65` `ServerConfig::build_args()` (pushes CLI flags into a `Vec<String>`). For these sizes a fluent builder would be over-engineering; the functional approach is correct.

> **N/A from prompt:** No DB connection-pool builder (single SQLite handle by design), no payment/request builders.

---

## STRUCTURAL PATTERNS

### Adapter — document formats & email (Finding 6)

The `fs_tools/` modules each adapt an external format to a shared in-memory shape: `text.rs`, `docx.rs`, `odt.rs`, `pdf_read.rs`, `xlsx.rs`, `pptx.rs`. Shared wire types (`XlsxSheet` `fs_tools/xlsx.rs`, `PptxSlide` `fs_tools/pptx.rs`) keep ODS/XLSX and ODP/PPTX writers DRY. Email similarly wraps `async-imap`/`lettre` behind `imap_client.rs` + `smtp_client.rs` over a common `EmailAccount`.

`src/lib/api.ts:127` `resolveChatEndpoint()` is a clean **backend adapter** — branches on `backend.mode` (`'local'` → `127.0.0.1:8765`, `'remote'` → user URL) so all callers route through one gate. Adding Anthropic/Mistral touches only this function.

**Caveat (3/10):** None of these adapters share a Rust `trait` — they're coupled by naming convention and a dispatcher. Pragmatic and fine today; if a third caller ever needs "read *any* document → blocks," a `trait DocumentCodec { fn read(...); fn write(...); }` would prevent drift. Not worth doing pre-emptively.

### Facade — pervasive and well-factored

- `db/mod.rs` `Database` — facade over SQLite (migrations, PRAGMAs, per-domain methods in sibling files). See Repository below.
- `proxy/mod.rs:283+` — `proxy_search()` / `proxy_fetch()` hide engine rotation, caching, rate-limit cooldowns from the UI.
- `fs_tools/mod.rs` — thin command re-exports over the format modules.
- `agent/tools/registry.ts` — registry facade replacing a 30-arm switch (verified, see Strategy/Command).

All appropriate; the facades are what let the UI stay stable while internals churn.

### Decorator / Middleware — inline-function style

No trait-chain middleware (no axum/tower layers). Instead, targeted wrapping functions:
- `proxy/bypass.rs:56` `apply_proxy(ClientBuilder, proxy)` decorates every outbound `reqwest` client with proxy + bypass rules. *Unable to verify exact line.*
- `proxy/paywall.rs:7` `detect_paywall_signal(html)` post-processes fetched HTML before return. *Unable to verify exact line.*
- `inference_queue.rs` acts as admission-control middleware around every inference turn (acquire → POST → release). **Verified**: FIFO `Vec` of tickets, `capacity()` gate at `:106-119`, `LEASE_TTL_MS = 5 min` orphan reclaim at `:41`.

Lightweight and correct for single-use cases.

### Proxy — caching, lazy load, rotation (verified shape)

- `proxy/mod.rs` `ProxyState` — `search_cache` / `fetch_cache` (HashMap + TTL) checked before network; round-robin `rotation_order()` / `advance_rotation_cursor()` over `AUTO_ENGINES`. Textbook caching proxy. *Line numbers from exploration; structure confirmed via `lib.rs:81` registration.*
- `fs_tools/pdf_read.rs` — lazy PDFium binding with pure-Rust fallback (Proxy + Strategy).
- `imap_client.rs:59` `tls_config()` — memoizing proxy over rustls config.

**Verdict:** Best-implemented structural area. No changes recommended.

---

## BEHAVIORAL PATTERNS

### Strategy — verified

- **Tool-call extraction** `agent/parser.ts:181-223` `resolveToolCalls()` — three interchangeable strategies in priority order: structured `tool_calls` → Qwen `<tool_call>{json}</tool_call>` → Hermes `<function=…>`. **Verified, well-documented.** (But see Finding 1.)
- **Inference backend** `stores/server.svelte.ts` local vs remote.
- **Tool dispatch by name** via the registry (below) — each tool is a strategy.

### Observer — verified

Tauri `emit`/`listen` + Svelte runes:
- `inference_queue.rs` `emit_snapshot()` → `app.emit(QUEUE_EVENT, snapshot)`; frontend `agent/inferenceQueue.svelte.ts` `listen<RawTicket[]>(QUEUE_EVENT, …)` applies it to `$state`. Cross-window coordination — polling would be wrong here, so Observer is appropriate.
- `stores/server.svelte.ts` listens for `server-status-changed`, `gpu-fallback-active/-cleared`.
- Shell PTY: `shell://output` / `shell://exit` events → `Terminal.svelte`.

### Chain of Responsibility — agent recovery (verified, exemplary)

`agent/loop/iteration.ts:482-489` — recovery guards composed with `??` so the first non-null short-circuits:

```ts
const recovered =
    tryContinueOnLength(ctx, state, response, iteration) ??
    tryMalformedToolCall(ctx, state, response, iteration) ??
    tryDegradedOutput(state, response, iteration) ??
    tryNarrateRecovery(ctx, nudges, response, iteration) ??
    tryFileWriteRecovery(ctx, nudges, response, iteration);
if (recovered) return recovered;
```

Each handler owns its precondition and returns `IterationOutcome | null`. This is a clean, readable CoR — far better than nested `if`. **No change recommended.**

### Command — verified

- **Tool registry** `agent/tools/registry.ts` — `registerTool()` populates a `Map`, `executeTool(name, args, ctx)` dispatches (`:92-110`), `getToolSchemas()` filters per-mode (`:66-87`). Each tool object = a command. Explicitly "Replaces the 30-arm switch statement" (`:90`). **Excellent.**
- **Inference queue** `inference_queue.rs` — `#[tauri::command]` acquire/cancel/release/heartbeat/snapshot as discrete actions over FIFO queue state.
- **Job system** `stores/jobs.svelte.ts` + `db/jobs.rs` + `db/runs.rs` — CRUD + run-state transitions as Tauri commands.

---

## DOMAIN PATTERNS

### Repository — clean, with one leak (Finding 2)

`Database` owns `conn: Mutex<Connection>` (`db/mod.rs:208`), and per-domain CRUD lives in sibling `impl Database` blocks: `db/conversations.rs`, `db/jobs.rs`, `db/runs.rs`, `db/stats.rs`. All SQL is parameterized and contained — a proper repository boundary. The one exception is Finding 2.

### Service layer — absent (Finding 4)

Commands in `db/commands.rs` delegate straight to `Database` methods (correct, thin). Business logic that *would* live in a service is scattered: scheduling math in `stores/jobs.svelte.ts` (`computeNextDueAt`), email prep in `integrations/email/sub_agent.rs` (`prepare()`), orchestration in `agent/loop.ts`. For an app this size that's acceptable; the email module (`imap_client` + `sub_agent`) is the closest thing to a service and is a good template if you ever consolidate job execution.

### DTO / Value objects — good separation, some duplication (Finding 8)

DB structs derive `Serialize`/`Deserialize` and cross IPC directly (`db/mod.rs:18-206`). The email module shows the *better* pattern explicitly: `SummarizerInput` (private domain type) vs `SummarizerInputJson` (`#[derive(Serialize)]` wire DTO) with a `From` impl (`integrations/email/commands.rs:26-46`). Every Rust DTO is hand-mirrored in TS (`stores/db.ts`, `stores/jobs.svelte.ts`, `api.ts`) — that duplication is the real cost (see Finding 8 and the existing `audits/x2-x3-typed-ipc-proposal.md`).

### Domain model — anemic (Finding 5)

`Conversation`, `Job`, `JobRun`, etc. are pure data bags with no behavior. The sole exception is `EmailAccount::validate()` (`integrations/email/auth.rs:82`). This is idiomatic Rust (behavior in free functions / `impl Database`) and fine here — flagged low.

---

# Findings & remediations

### Finding 1 — Unguarded `JSON.parse` on the structured tool-call path discards recoverable calls — **3/10**

**Location:** `src/lib/agent/parser.ts:184-189` (verified). **Status: FIXED** on branch `fix/parser-unguarded-json-parse`.

> **Severity corrected (was 7/10).** My initial framing claimed the throw becomes an *uncaught exception* that skips the recovery chain. That was wrong: the sole call site already wraps the call in try/catch at `iteration.ts:434-438` (`catch (e) { parseError = e; }`), so a malformed structured arg never crashed a turn — it was caught, logged, and left `toolCalls` empty, flowing into the normal no-tool-calls recovery/nudge path. This is a robustness/quality fix, not a crash fix.

The two *fallback* strategies are carefully guarded ("Falls through if no parseable call was found"), but the **primary** path parsed model-supplied JSON with no try/catch:

```ts
if (response.tool_calls && response.tool_calls.length > 0) {
    return response.tool_calls.map((tc: ToolCall) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: JSON.parse(tc.function.arguments)   // ← throws on malformed args
    }));
}
```

A remote OpenAI-compatible server (or a quantized local model) can emit `tool_calls` with truncated/invalid `arguments`. The throw, though caught upstream, **discarded the entire response's tool calls**: (1) a partial-valid batch (3 calls, 1 malformed) lost all 3; (2) the text-format fallbacks at lines 198-219 never ran, so a co-emitted valid `<tool_call>`/`<function=>` payload was lost and the turn burned on a nudge instead of executing.

**Verification:** unit tests only (`parser.test.ts`, 4 new cases). There is no reliable UI repro — the pre-fix behavior was already non-crashing, and the malformed-structured input can't be forced deterministically from the UI (local Qwen uses the text `<tool_call>` path, not the structured field).

**Remediation applied (drop-in):**

```ts
if (response.tool_calls && response.tool_calls.length > 0) {
    const parsed: ResolvedToolCall[] = [];
    for (const tc of response.tool_calls) {
        let args: Record<string, unknown>;
        try {
            args = JSON.parse(tc.function.arguments);
        } catch {
            // Malformed structured args — fall through to text-based
            // fallbacks / malformed-tool-call recovery instead of throwing.
            continue;
        }
        parsed.push({ id: tc.id, name: tc.function.name, arguments: args });
    }
    if (parsed.length > 0) return parsed;
    // else: drop to content-based fallbacks below
}
```

(Empty `arguments` like `""` also throw today — the `try` covers that too. If a tool legitimately takes no args, normalize `""`/`undefined` → `{}` before parsing.)

---

### Finding 2 — `db_update_last_message_steps` runs SQL outside the repository — **5/10**

**Location:** `src-tauri/src/db/commands.rs:52-69` (verified). **Status: FIXED** on branch `fix/parser-unguarded-json-parse` — query moved to `Database::update_last_message_steps` in `db/conversations.rs`; the command now delegates and the orphaned `use rusqlite::params;` import was removed.

Every other command delegates to a `Database` method; this one reaches into the (private, same-module-accessible) `conn` and writes SQL inline:

```rust
#[tauri::command]
pub fn db_update_last_message_steps(state, conversation_id, steps) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    conn.execute("UPDATE messages SET steps = ?1 WHERE id = ( \
        SELECT id FROM messages WHERE conversation_id = ?2 \
        ORDER BY sort_order DESC LIMIT 1 )", params![steps, conversation_id])
        .map_err(|e| format!("Update failed: {}", e))?;
    Ok(())
}
```

Not a visibility violation (`commands.rs` is a child module via `use super::*`), but it's the only place the repository boundary leaks, and it also `unwrap()`s the lock (Finding 3).

**Remediation:** move the query into `db/conversations.rs` next to its siblings:

```rust
// db/conversations.rs (inside impl Database)
pub fn update_last_message_steps(&self, conversation_id: &str, steps: Option<&str>) -> Result<(), String> {
    let conn = self.conn.lock().map_err(|e| format!("DB lock poisoned: {e}"))?;
    conn.execute(
        "UPDATE messages SET steps = ?1 \
         WHERE id = (SELECT id FROM messages WHERE conversation_id = ?2 \
                     ORDER BY sort_order DESC LIMIT 1)",
        params![steps, conversation_id],
    ).map_err(|e| format!("Update failed: {e}"))?;
    Ok(())
}
```
```rust
// db/commands.rs
#[tauri::command]
pub fn db_update_last_message_steps(state: tauri::State<'_, Database>, conversation_id: String, steps: Option<String>) -> Result<(), String> {
    state.update_last_message_steps(&conversation_id, steps.as_deref())
}
```

---

### Finding 3 — `Mutex::lock().unwrap()` on managed singletons can cascade-panic — **5/10**

**Locations:** `db/commands.rs:58` (verified); the same `.lock().unwrap()` idiom recurs across `db/*.rs`, `inference_queue.rs`, `server/mod.rs` (pattern, not exhaustively verified). **Status: FIXED for the `Database` singleton** on branch `fix/parser-unguarded-json-parse` — added a private `Database::conn()` helper (option 2, poison-recovery via `into_inner()`, with a `log::warn!`) and collapsed all ~31 production `self.conn.lock().unwrap()` sites to `self.conn()`. `db/tests.rs` left as-is (test code; panic-on-poison is acceptable).

> **No action needed elsewhere (audited).** The cascade-panic was specific to `Database`'s bare `.lock().unwrap()`. The other two singletons do not share it: `server/mod.rs` uses `tokio::sync::Mutex` (`.lock().await`, e.g. `:166`), which **cannot poison**; and `inference_queue.rs` uses `std::sync::Mutex` but already handles every poisoned-lock case (`map_err(..)?` `:165`, `match` `:188/:209/:255`, `if let Ok` `:232`, `unwrap_or_default()` `:284`, `.ok()?` `:291`) rather than `.unwrap()`-ing — so no panic risk. A `conn()`-style `into_inner()` recovery there would be *less* safe than the current stall, since recovering the queue's `Inner { tickets, senders, running }` after a mid-mutation panic could resume on inconsistent counts. Leave both as-is.

`std::sync::Mutex` poisons if a thread panics while holding the lock. With `.unwrap()`, the *first* panic inside any DB/queue critical section turns every subsequent command on that singleton into a panic too — a single bad row can take down all DB access for the session. For a long-lived desktop singleton this is a real availability risk, not theoretical.

**Remediation options (pick one, apply consistently):**
1. **Cheap:** map the poison error to a `String` instead of `unwrap()` — `self.conn.lock().map_err(|e| format!("DB lock poisoned: {e}"))?` (shown in Finding 2). Turns a cascade-panic into a recoverable per-call error.
2. **Robust:** recover the guard — `let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());` when the protected data stays valid after a panic (true for the SQLite handle).
3. **Structural:** adopt `parking_lot::Mutex` (no poisoning, `lock()` returns the guard directly) for these hot singletons.

Given the volume of call sites, a small helper (`fn conn(&self) -> Result<MutexGuard<Connection>, String>`) on `Database` keeps the fix one-line-per-method.

---

### Finding 4 — No service layer; scheduling/orchestration logic scattered — **4/10**

**Locations:** `src/lib/stores/jobs.svelte.ts` (`computeNextDueAt`, `nextDailyDue`, `nextWeeklyDue`), `db/jobs.rs` + `db/runs.rs` (state transitions), `agent/loop.ts`.

Job scheduling math lives in the frontend store, run-state transitions live in the repository, and the runner orchestration lives in the agent loop — to understand "how a scheduled job fires and records a run" you read three layers. Acceptable at current size; flagged because the job subsystem is the one area likely to grow.

**Remediation (only if jobs grow):** introduce a `JobService` (Rust) that owns the create → schedule → run → record-run pipeline and calls `Database` for persistence, so commands stay thin and the lifecycle is in one file. No snippet — this is a refactor decision, not a drop-in.

---

### Finding 5 — Anemic domain models — **3/10**

**Locations:** `db/mod.rs:18-206` (all DTO structs, no `impl`).

Idiomatic for this codebase; not worth changing wholesale. If you ever want invariants enforced at one chokepoint, a thin `impl` (e.g. `Job::next_due_at(&self, now) -> Option<i64>` co-locating the scheduling rules currently in TS) is the highest-value spot.

---

### Finding 6 — Adapters share no common trait — **3/10**

See Structural § Adapter. Pragmatic today. Only act if a generic "process any document" caller appears; then extract `trait DocumentCodec`.

---

### Finding 7 — `Date.now()`-based tool-call IDs can collide — **3/10**

**Location:** `src/lib/agent/parser.ts:202,215` (verified) — fallback IDs are `` `call_${Date.now()}_${i}` ``.

Within one response the `_${i}` suffix disambiguates, so collisions are unlikely in practice. But IDs are not unique *across* iterations within the same millisecond, and these IDs flow into `tool_call_id` correlation. Low severity; note it.

**Remediation:** seed with a monotonic counter instead of wall-clock:

```ts
let toolCallSeq = 0;
const nextToolCallId = () => `call_${(toolCallSeq++).toString(36)}`;
// …
id: nextToolCallId(),
```

---

### Finding 8 — Missing pattern: typed IPC / generated DTOs — **4/10**

Every Rust `#[derive(Serialize)]` DTO is hand-mirrored as a TS interface (`stores/db.ts`, `stores/jobs.svelte.ts`, `api.ts`). This is the duplication the existing `audits/x2-x3-typed-ipc-proposal.md` and memory `[[specta_ipc_adoption]]` already track (tauri-specta blocked on rustc 1.91; `ts-rs` is the fallback). Recording here for completeness so the pattern audit and the IPC proposal cross-reference. No new action — defer to that proposal.

> **Memory note:** consistent with the recalled `tauri-specta adoption blocked` memory — verify against `audits/x2-x3-typed-ipc-proposal.md` before acting.

---

## Patterns deliberately *absent* (correctly)

- **Singleton via global mutable static** — replaced by Tauri managed state. ✓
- **Abstract Factory / DI container** — unnecessary in a single-process app. ✓
- **Strategy for auth methods / payment processing** — N/A (no payments; email auth is config-driven presets, not a runtime algorithm swap). ✓
- **DB connection pool** — single SQLite writer behind a `Mutex` is the right model for an embedded DB. ✓

---

## Priority order

1. ~~**Findings 2 + 3** (5/5)~~ — DONE (`fix/parser-unguarded-json-parse`): inline SQL moved into `Database`; `Database::conn()` poison-recovery helper across all DB call sites. No follow-up needed — `server/mod.rs` (tokio mutex, can't poison) and `inference_queue.rs` (already handles poison, never `.unwrap()`s) don't share the bug; see Finding 3.
2. ~~**Finding 1** (3)~~ — DONE (`fix/parser-unguarded-json-parse`); robustness fix, unit-tested.
3. **Finding 7** (3) — trivial, do alongside any parser work.
4. **Findings 4, 5, 6, 8** — design notes; act only when the relevant subsystem grows or the IPC proposal lands.
