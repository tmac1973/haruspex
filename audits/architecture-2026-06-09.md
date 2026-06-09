# Architecture Audit — Haruspex

**Date:** 2026-06-09
**Scope:** `src/` (SvelteKit 5 frontend, 152 modules) + `src-tauri/src/` (Rust backend, 66 files, 135 `#[tauri::command]` handlers). ~48k LOC.
**Method:** LOC/command metrics, `madge` circular-dependency scan, `use crate::` dependency mapping, and targeted re-reads to verify every featured finding. Where automated tooling proved unreliable (see Finding A6) the cycle was confirmed by reading the actual import lines.

> **Relationship to prior audits:** This focuses on *architecture* (layering, separation, coupling, cycles, modularity). Tactical code-level smells (per-engine boilerplate, complex functions) are already tracked in `audits/code-duplication-2026-06-08.md` and `audits/code-complexity-2026-06-09.md`; I cross-reference rather than re-derive them, and only promote one to architecture level (God modules).

---

## Executive summary

The backend is **genuinely well-architected**: a thin command layer over per-domain logic over IO, an **acyclic** module graph, and a sidecar pattern for external processes. The frontend is mostly clean MVVM but is undermined by **one God store (`chat.svelte.ts`, 1033 LOC) sitting in a real import cycle** with the sandbox layer. Two Rust modules (`models.rs`, `proxy/mod.rs`) conflate unrelated concerns, and one layering boundary leaks (search proxy writes to the DB). Config constants (ports, timeouts, `127.0.0.1`) are duplicated rather than centralized.

**None of this is structural rot** — the issues are localized and individually fixable. Modularity scores **7/10** (justification at the end).

### Architectural pattern

There is no single GoF-style pattern; it's a composition:

| Tier | Pattern | Evidence |
|---|---|---|
| Frontend | **Layered + MVVM** | `routes/` (pages) → `components/` (View) → `stores/*.svelte.ts` (ViewModel/reactive state) → `agent/`,`sandbox/` (domain) → `api.ts` (gateway) |
| IPC seam | **Client–server over Tauri IPC** | 135 `#[tauri::command]` handlers; TS calls `invoke(...)` |
| Backend | **Layered (controller→domain→IO)** | `db/commands.rs` (thin) → `db/{conversations,jobs,runs,stats}.rs` (domain) → `rusqlite` |
| External procs | **Sidecar / local service-oriented** | llama-server :8765, whisper :8766, koko :3001, Pyodide worker — each an HTTP/worker service on localhost |

So: **Layered architecture with an IPC client–server split and a sidecar tier** — not MVC, and deliberately not microservices (the sidecars are co-located processes, not networked services).

### Findings at a glance

| # | Finding | Category | Importance |
|---|---------|----------|:---:|
| A1 | `chat.svelte.ts` God store **+ real `chat ↔ sandbox` import cycle** | God module / circular dep | **7** |
| A2 | `models.rs` (1265 LOC) = registry + downloader + hardware detection | God module | **6** |
| A3 | `proxy/` writes to `db` — search logic coupled to persistence | Layering violation | **5** |
| A4 | Missing sidecar abstraction; `HEALTH_POLL_TIMEOUT`/ports/`127.0.0.1` duplicated | Missing abstraction / config drift | **5** |
| A5 | `proxy/mod.rs` (969 LOC) mixes `ProxyState` + commands + orchestration | God module | **4** |
| A6 | Circular-dep tooling (`madge`) is blind to `$lib` aliases — cycles go undetected | Observability/process | **3** |
| A7 | `loop.ts ↔ loop/iteration.ts` cycle (type-only, benign) | Circular dep | **2** |

---

## 1. Separation of concerns

**Backend — strong.** The `db/` module documents and follows the split (`db/mod.rs:1-10`): command wrappers in `commands.rs` (27 handlers, each a one-liner delegating to a `Database` method), domain logic in `conversations.rs`/`jobs.rs`/`runs.rs`/`stats.rs`, IO via `rusqlite`. `shell/` (commands in `mod.rs` → `session.rs`/`context.rs` → `pty.rs`/`platform.rs`) and `fs_tools/` (per-format command files → `markdown_inline.rs` parsing → `tokio::fs`) follow the same shape. Command count is well-distributed (db 27, shell 16, models 11, server 9, …) — no single file owns the surface.

**Frontend — mostly clean, one breach.** Components read through store getters; stores hold reactive state; `agent/` owns the loop. The breach is `chat.svelte.ts` (Finding A1), which has absorbed conversation CRUD, working-dir persistence, generation/streaming state, sandbox replay/restore, compaction, context-usage, stats, **and** turn orchestration — crossing the ViewModel/domain line.

**Two backend exceptions:** `models.rs` mixes three domains (A2); `proxy/` reaches into `db` (A3).

---

## 2. Dependency flow & circular dependencies

**Backend: acyclic ✓.** Mapping every `use crate::X`:

```
leaves (no crate deps):  db  fs_tools  models  inference  inference_queue  shell  audio  sidecar_utils  app_log  links
sidecar_utils  ← server, whisper, tts
db             ← proxy (stats), feedback
proxy          ← feedback, sandbox_fetch
fs_tools       ← lint, sandbox_save
```

Longest chain depth 2 (`feedback → proxy → db`). No cycles. Direction is correct (everything points toward leaves; `lib.rs` is the single composition root). The one smell is `proxy → db` (A3). `feedback.rs` fans into 6 modules but is a diagnostic aggregator — acceptable.

**Frontend: at least one real cycle.**

- **A1 (real, runtime):** `stores/chat.svelte.ts:23-29` imports values from `$lib/sandbox/sandbox`, and `sandbox/sandbox.ts:5` imports `getActiveConversationId` back from `$lib/stores/chat.svelte`. Both are **value** imports → genuine runtime cycle.
- **A7 (benign):** `loop.ts:27` imports from `./loop/iteration`; `iteration.ts:37` imports **`import type { AgentLoopOptions }`** back — type-only, erased at compile time.

> ⚠️ **`madge` reported only A7 and missed A1** — see Finding A6. A1 was confirmed by reading the import lines directly.

---

## 3. God objects / modules

`chat.svelte.ts` (1033), `models.rs` (1265), `proxy/mod.rs` (969) — detailed as Findings A1, A2, A5. For reference, the other large files are *not* God modules: `python.worker.ts` (1611) is one cohesive Pyodide harness, `iteration.ts` (903) is one agent-iteration with an explicit recovery chain, `server/mod.rs` (809) is one sidecar lifecycle, `fs_tools/mod.rs` (1043) is mostly `#[cfg(test)]` + re-exports.

---

## 4. Architecture diagram

### Layer dependencies & data flow

```
┌────────────────────────────────────────────────────────────────────────────┐
│  FRONTEND  (SvelteKit SPA, port 1420 dev)                                    │
│                                                                              │
│  routes/ ── +layout.svelte, +page.svelte, setup, settings, shell/[id]        │
│     │ renders                                                                │
│     ▼                                                                        │
│  components/ ── ChatView, ConversationSidebar, SearchStep, jobs/*, shell/*   │
│     │ read getters / call actions                                            │
│     ▼                                                                        │
│  stores/*.svelte.ts ── chat ⚠, server, settings, context, shell, jobs …      │
│     │            ╲__________________ A1 CYCLE __________________             │
│     ▼                                                          ╲             │
│  agent/ ── loop → loop/iteration → tools/registry → parser     sandbox/      │
│     │       (Strategy/CoR recovery, context-budget)            (pyodide      │
│     ▼                                                           worker-pool) │
│  api.ts  ── chatCompletion / SSE stream  ──┐                                 │
└────────────────────────────────────────────┼───────────────────────────────┘
                       Tauri IPC (invoke)     │       HTTP (OpenAI-compatible)
   135 #[tauri::command]  ▼                    ▼
┌────────────────────────────────────────────────────────────────────────────┐
│  RUST BACKEND (Tauri core)                            ▼                       │
│                                                                              │
│  COMMAND LAYER ── db/commands.rs · shell/mod.rs · models.rs · proxy/mod.rs … │
│     │ delegates                                                              │
│     ▼                                                                        │
│  DOMAIN LAYER ── Database impls · ModelManager · ProxyState · LlamaServer    │
│     │            · InferenceQueue · email::{imap,smtp} · Session             │
│     │   ┌─── A3: proxy/ ──→ db.update_engine_stat()  (layering leak)         │
│     ▼   ▼                                                                    │
│  IO LAYER ── rusqlite(SQLite) · tokio::fs · reqwest · pty · sidecar_utils    │
│                                  │                  │                        │
└──────────────────────────────────┼──────────────────┼───────────────────────┘
                                    ▼                  ▼
                       EXTERNAL SIDECARS / SERVICES (localhost)
   ┌──────────────────┬──────────────────┬──────────────────┬────────────────┐
   │ llama-server     │ whisper-server   │ koko (TTS)       │ web (search/   │
   │ :8765  LLM       │ :8766  STT       │ :3001  TTS       │ fetch via      │
   │ (Vulkan)         │ (Vulkan)         │ (CPU)            │ reqwest+proxy) │
   └──────────────────┴──────────────────┴──────────────────┴────────────────┘
                  (Pyodide python.worker runs in-browser, not a process)
```

### Data flow — one chat turn

```
user input → chat.sendMessage() → buildApiPrompt() → runAgentLoop()
  → loop/iteration: api.chatCompletionStream() ──IPC/HTTP──▶ llama-server :8765
       │  (gated by InferenceQueue: capacity 1 local)        ⟵ SSE tokens
       ├─ resolveToolCalls() → tools/registry.executeTool()
       │       ├─ web tool  → invoke('proxy_search'|'proxy_fetch') → reqwest → engines
       │       ├─ fs tool   → invoke('fs_*') → tokio::fs
       │       └─ sandbox   → worker-pool → python.worker (Pyodide)
       └─ onStreamChunk → renderMarkdown → ChatView
  → commitMessage() → invoke('db_save_message') → SQLite
```

### Potential bottlenecks

| Bottleneck | Location | Note |
|---|---|---|
| **Single LLM slot** | `inference_queue.rs` capacity 1 (local) | Serializes all turns across windows — intentional, but the *only* throughput limiter. |
| **`Mutex<Connection>`** | `db/mod.rs:209` | All DB access serialized on one lock; fine for a desktop app, would bottleneck under heavy job-runner concurrency. |
| **`chat.svelte.ts` orchestration** | `stores/chat.svelte.ts` `sendMessage()` | Turn lifecycle, streaming, and persistence all funnel through one module → the change-amplification hotspot. |
| **Synchronous document parsing** | `fs_tools/*` | Large docx/pdf parse on the command thread; no streaming. |

---

## 5. Modularity rating — **7 / 10**

**Why not lower:** backend module boundaries are clean and **acyclic**, the command layer is uniformly thin, domains are split into focused files, and the sidecar tier is properly isolated behind `sidecar_utils`. Adding a search engine, document format, or DB entity is a localized, additive change.

**Why not higher:** (1) one God store on a real import cycle (A1) makes the frontend's core hard to test and change in isolation; (2) two oversized Rust modules conflate concerns (A2, A5); (3) a layering leak couples search to persistence (A3); (4) config constants are copy-pasted, signalling a missing shared module (A4). Each knocks ~0.5–1 off.

---

# Findings & remediation

### Finding A1 — `chat.svelte.ts` God store + real `chat ↔ sandbox` cycle — **7/10**

> **Cycle FIXED** on branch `refactor/break-chat-sandbox-cycle`. Implementation found **three** back-edges (not two): `sandbox/sandbox.ts → getActiveConversationId`, `worker-manager.ts → getWorkingDir`, and `agent/tools/sandbox.ts → getActiveConversation` (transitive via the `agent/tools` barrel that `iteration.ts` imports). All three are broken: ambient ids moved to a new `stores/session.svelte.ts` leaf; the per-chat `sandboxApproved` flag moved off the `Conversation` model into `stores/sandboxApproval.svelte.ts` (`isChatSandboxApproved`/`approveChatSandbox`). No `sandbox/*` or `tools/*` file imports the chat store anymore. The **God-store split** (extracting CRUD / turn orchestration to shrink the 1033-LOC file) is the remaining, lower-priority half of A1 — deferred.

**Locations:** `src/lib/stores/chat.svelte.ts` (1033 LOC, ~45 functions); cycle = `chat.svelte.ts:23-29` ↔ `src/lib/sandbox/sandbox.ts:5` (both verified). `chat.svelte` is imported by 9 modules and imports from 7 areas (`agent`×9, `stores`×3, `sandbox`, `api`, `markdown`, `utils`, `debug`).

It holds ≥7 responsibilities: conversation CRUD (`createConversation` `:439`, `deleteConversation` `:608`, `renameConversation` `:618`), working-dir persistence (`loadWorkingDir` `:126`/`saveWorkingDir` `:145`), generation/streaming state (`:250-301`), sandbox replay/restore (`collectSandboxCalls` `:501`, `replaySandboxCall` `:542`, `restoreSandboxSession` `:558`), compaction (`compactIfNeeded` `:397`), turn orchestration (`sendMessage` `:966+`, `buildApiPrompt` `:723`), and stats.

The cycle exists because `sandbox.ts` needs the *active conversation id* and reaches back into the chat store for it.

**Remediation — break the cycle first (cheap, high-value), then split.** Extract the shared identity into a tiny leaf store both sides depend on:

```ts
// src/lib/stores/activeConversation.svelte.ts  (NEW — leaf, no imports from chat/sandbox)
let activeId = $state<string | null>(null);
export const getActiveConversationId = () => activeId;
export const setActiveConversationId = (id: string | null) => { activeId = id; };
```
```ts
// sandbox/sandbox.ts — was: import { getActiveConversationId } from '$lib/stores/chat.svelte'
import { getActiveConversationId } from '$lib/stores/activeConversation.svelte';
```
```ts
// chat.svelte.ts — re-export for existing callers, set on switch
export { getActiveConversationId } from '$lib/stores/activeConversation.svelte';
import { setActiveConversationId } from '$lib/stores/activeConversation.svelte';
// in setActiveConversation(): setActiveConversationId(id);
```

That alone removes the cycle with no behavior change. Then split along the seams (lower priority): sandbox replay/restore → `agent/sandboxRestore.ts`; conversation CRUD → `stores/conversations.svelte.ts`; turn orchestration → the existing `agent/runTurn.ts`. Target `chat.svelte.ts` ≈ 300 LOC.

**Verify:** after the leaf-store extraction, `npx madge --circular --extensions ts,svelte --ts-config .svelte-kit/tsconfig.json src/` should still report the type-only A7 only — but confirm by grep (A6), since madge can't see `$lib` cycles.

---

### Finding A2 — `models.rs` (1265 LOC) conflates three domains — **6/10**

> **Hardware split DONE** on branch `refactor/split-models-hardware`: the cross-domain concern (#3) is extracted to a new top-level `hardware.rs` module (`HardwareInfo`, `GpuInfo`, VRAM tables, `tier_lookup`, `detect_hardware`, all per-OS `detect_gpu` + `cmd_detect_hardware`), with its tests. `models.rs` drops 1265 → 880 LOC and is now single-domain (model registry + download + commands). The remaining registry-vs-downloader sub-split (a `models/manager.rs`) is **intra-domain** organization, not a concern separation, and carries field-visibility friction (the whisper command reaches `ModelManager.cancel_flag`) — left as optional follow-up. (Also fixed a latent bug: the unsupported-OS `detect_gpu` returned a tuple that didn't match its `GpuInfo` call site — it now returns `GpuInfo`.)

**Location:** `src-tauri/src/models.rs` (verified via declaration scan).

Three unrelated concerns in one file:
1. **Model registry** — `ModelInfo` `:17`, `model_registry()` `:75`, mmproj helpers `:67-75`.
2. **Download/validation** — `ModelManager` `:165`, `resume_total_size` `:174`, `download_speed_bps` `:184`, `impl` `:192`, `compute_sha256` `:514`, `validate_gguf` `:523`.
3. **Cross-platform hardware detection** — `detect_hardware` `:579`, `is_integrated_gpu` `:637`, per-OS `detect_gpu` (`:653` linux, `:737` macos, `:750` windows), `get_linux_*` `:685/:721`, `get_windows_*` `:775/:811/:844`, `run_powershell` `:800`.

Hardware/GPU detection has nothing to do with model downloads; it's bundled only because both feed setup.

**Remediation — split into a module dir (no logic change):**
```
src-tauri/src/models/
  mod.rs        // ModelInfo, model_registry(), the 11 #[tauri::command] handlers
  manager.rs    // ModelManager + download/resume/validate (compute_sha256, validate_gguf)
src-tauri/src/hardware/
  mod.rs        // HardwareInfo, detect_hardware(), tier_lookup(), VRAM tables
  linux.rs · windows.rs · macos.rs   // #[cfg(target_os=...)] detect_gpu()
```
Update `lib.rs` `mod models;` → keep, add `mod hardware;`. The `#[cfg]`-gated `detect_gpu` variants become natural per-file `#[cfg]` modules. Pure move; tests move with their code.

---

### Finding A3 — `proxy/` writes to the DB (search coupled to persistence) — **5/10**

**Location:** `src-tauri/src/proxy/mod.rs:20` `use crate::db::{Database, EngineStatDelta};`; stat recorders take `db: &Database` (`:206`, `:238`, `:261`) and call `db.update_engine_stat(...)` `:227`; commands inject `db: tauri::State<'_, Database>` (`:289`, `:388`) and call `record_global_both`/`record_engine_result` inline (`:298`, `:323`, `:341`, `:366`).

The search subsystem shouldn't know SQLite exists. This is the one place the backend's clean direction bends — search logic depends on the persistence module.

**Remediation — invert via a trait the proxy owns, implemented by `db`:**
```rust
// proxy/stats.rs
pub trait StatSink {
    fn record_engine(&self, engine: &str, delta: &EngineStatDelta);
    fn record_global(&self, counter: GlobalCounter);
}
// commands take `sink: &dyn StatSink` instead of `&Database`
```
```rust
// db/stats.rs — db now depends on proxy's trait, not vice-versa (or define the trait in a neutral module)
impl crate::proxy::stats::StatSink for Database { /* delegate to update_engine_stat */ }
```
`EngineStatDelta`/`GlobalCounter` move to `proxy/stats.rs` (they're search concepts). `proxy` no longer `use crate::db`. *Lighter alternative if a trait feels heavy:* keep recording in-memory in `SearchStats` and have `feedback.rs` (which already depends on both) flush to the DB — proxy stays a leaf.

---

### Finding A4 — missing sidecar abstraction; duplicated ports/timeouts — **5/10**

**Locations (verified):**
- `HEALTH_POLL_TIMEOUT` redeclared: `whisper.rs:16` =30s, `tts.rs:20` =30s, `server/mod.rs:21` =**60s** (divergent).
- `127.0.0.1` literal in 8 files (`sidecar_utils.rs`×3, `server/mod.rs`×2, `proxy/mod.rs`×2, `whisper.rs`, `tts.rs`, `proxy/extract.rs`, `api.ts`, `setup.svelte.ts`).
- Ports are centralized in `sidecar_utils.rs:23-25` (`ports::{LLAMA,WHISPER,TTS}`) and aliased correctly — good — but the *host* and *timeouts* are not.

`server`, `whisper`, and `tts` each re-implement near-identical lifecycle (spawn → `poll_health` → status → logs) around their own `Mutex<Option<CommandChild>>` + `SidecarStatus`. `sidecar_utils` already shares helpers, but no type captures "a sidecar."

**Remediation — centralize the constants now (trivial), abstract later:**
```rust
// sidecar_utils.rs
pub const LOOPBACK: &str = "127.0.0.1";
pub mod timeouts {
    use std::time::Duration;
    pub const HEALTH_POLL: Duration = Duration::from_secs(30);
    pub const HEALTH_POLL_SLOW: Duration = Duration::from_secs(60); // llama cold start
}
```
Then `use crate::sidecar_utils::timeouts::HEALTH_POLL;` in whisper/tts and `HEALTH_POLL_SLOW` in server — divergence becomes explicit, not accidental. The fuller fix (a `Sidecar` struct/trait owning the lifecycle) is justified once a 4th sidecar appears; cross-ref `code-complexity` F1.

---

### Finding A5 — `proxy/mod.rs` (969 LOC) mixes state + commands + orchestration — **4/10**

**Location:** `src-tauri/src/proxy/mod.rs` — `ProxyState` struct `:78` + impl `:89-283` (caches, rate-limit, engine rotation) live in the same file as the 4 `#[tauri::command]` handlers (`:284`, `:385`, `:395`, `:400`) and constants (`:22+`).

**Remediation — extract (pure moves):**
```
proxy/mod.rs      // re-exports + the 4 commands only (~200 LOC)
proxy/state.rs    // ProxyState struct + impl (cache/rate-limit/rotation)
proxy/config.rs   // FETCH_TIMEOUT, *_CACHE_TTL, ENGINE_COOLDOWN, AUTO_ENGINES, ProxyConfig
```
Lower priority than A1–A3 — it's size/cohesion, not a correctness or coupling risk.

---

### Finding A6 — circular-dep tooling is blind to `$lib` aliases — **3/10**

**Evidence:** `npx madge --circular` (with and without `--ts-config`) reports **only** the relative-path cycle A7 and misses the real `$lib`-based A1 cycle (the 41 "warnings" are unresolved `$lib` imports). Any CI relying on madge for cycle detection gives false confidence.

**Remediation — give madge the alias map via a config file:**
```js
// .madgerc
{
  "fileExtensions": ["ts", "svelte"],
  "tsConfig": ".svelte-kit/tsconfig.json",
  "webpackConfig": null,
  "detectiveOptions": { "ts": { "skipTypeImports": true } }
}
```
If madge still can't resolve `$lib` (it often won't follow SvelteKit's generated paths), add a CI grep guard for the known hub instead:
```bash
# fail if sandbox/ imports back into the chat store (regression guard for A1)
! grep -rq "stores/chat.svelte" src/lib/sandbox/
```
`skipTypeImports` also suppresses the benign A7 noise.

---

### Finding A7 — `loop.ts ↔ loop/iteration.ts` type-only cycle — **2/10**

**Location:** `loop.ts:27` ↔ `iteration.ts:37` (`import type { AgentLoopOptions }`). Erased at compile time → no runtime effect; only shows up as madge noise.

**Remediation (optional):** move shared loop types to `agent/loop/types.ts` and have both import from there. Eliminates the edge entirely and is good hygiene, but zero runtime impact — do it only when touching the loop.

---

## Anti-pattern scorecard

| Anti-pattern | Present? | Where / note |
|---|---|---|
| **Spaghetti code** | Localized | `iteration.ts` `runIteration` & `server/mod.rs` `spawn_output_reader` — tracked in `code-complexity` F1/F2, not re-raised here. |
| **Copy-paste** | Yes, tactical | per-engine search clients, document writers, `HEALTH_POLL_TIMEOUT` (A4) — see `code-duplication` R3/R9. |
| **God classes/modules** | Yes | A1 (`chat.svelte.ts`), A2 (`models.rs`), A5 (`proxy/mod.rs`). |
| **Tight coupling** | One real | A3 (`proxy → db`); plus the A1 cycle. |
| **Missing abstractions** | Yes | A4 (sidecar lifecycle; centralized host/timeout config). |
| **Circular deps** | One real + one benign | A1 (runtime), A7 (type-only). |

## Priority order

1. **A1** (7) — cycle break DONE (`refactor/break-chat-sandbox-cycle`); God-store split still pending.
2. **A2** (6) — hardware extracted to `hardware.rs` DONE (`refactor/split-models-hardware`); intra-`models` manager split is optional follow-up.
3. **A3** (5) — decouple `proxy` from `db` (trait or feedback-flush).
4. **A4** (5) — centralize host/timeout constants now; sidecar abstraction later.
5. **A5** (4) — extract `proxy/state.rs` + `proxy/config.rs`.
6. **A6** (3) — fix/replace the cycle-detection in CI so A1-class regressions are caught.
7. **A7** (2) — move shared loop types out, next time the loop is touched.
