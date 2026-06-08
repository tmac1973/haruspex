# Proposal: Typed Rust↔TS IPC bindings (audit findings X2 + X3)

**Date:** 2026-06-08
**Status:** Proposal — needs a go / no-go decision before any code.
**Addresses:** duplication-audit findings **X2** (tool/command names + arg shapes declared in both TS and Rust) and **X3** (data structs mirrored in both languages). These were deferred from step 6 because the real fix is a **codegen pipeline**, which is an architecture commitment rather than a refactor.

---

## 1. The problem, concretely

Every frontend↔backend call crosses Tauri's IPC as JSON. Both ends are hand-written and matched **at runtime**:

```ts
// TS — stringly-typed; nothing checks the name or arg keys at compile time
await invoke<ServerStatus>('get_server_status');
await invoke('db_save_message', { conversationId, role, content });
```
```rust
#[tauri::command]
pub async fn db_save_message(state: State<'_, Database>, conversation_id: String, role: String, content: String) -> Result<i64, String> { … }
```

Rename a Rust command or an argument and **TypeScript still compiles** — the call fails at runtime ("command not found" / missing arg), surfacing as a chat-time `toolInvokeError`, not a build error. Same story for the data shapes: `ProxyConfig`, `SearchResult`, `ServerStatus`, `ModelInfo`, etc. are declared once in Rust (`#[derive(Serialize/Deserialize)]`) and again as a hand-written TS `interface`. Add a field on one side and it's silently dropped at the boundary.

### Current surface (measured)
| Thing | Count | Notes |
|---|---|---|
| `#[tauri::command]` definitions | **134** | across 33 files; `db.rs` alone has 27 |
| Registered in `generate_handler!` (lib.rs) | **134** | |
| Distinct commands actually `invoke()`d from TS | **~45** | the rest are backend-internal; **only these 45 + their types need bindings** |
| `invoke(...)` call sites in `src/` | **59** | 2 use a dynamic name (`clearCommands[tab]`, `fs-write` command param) |
| Rust serde structs/enums crossing the boundary | **38+** | incl. `ServerStatus`, `ServerConfig`, `ModelInfo`, `DownloadProgress`, `SearchResult`, `ProxyConfig`, ~13 db/job/run types, shell + search-stats types |
| Hand-written TS mirrors of those | ~matching | e.g. `SearchResult` (web.ts), `ProxyConfig` (settings.ts), `ServerStatus` (server.svelte.ts), `ShellContextResponse` (Terminal.svelte) |
| `app.emit` ↔ `listen` event channels | **7** | `server-status-changed`, `download-progress`, `gpu-fallback-active/-cleared`, `inference://queue`, `shell://output`, `shell://exit` |

Concrete drift already visible in the tree:
- `proxy/mod.rs` `ProxyConfig` once carried the comment *"Mirrors the ProxyConfig TS type"* — a self-admitted manual sync point.
- `ShellContextResponse`: the Rust struct has `completed_total: u64`; the TS mirror in `Terminal.svelte` **omits it**.

Stack: **Tauri 2.10.3**, SvelteKit + Vite (`adapter-static`, SPA), serde, **no codegen today**. `src/lib/api.ts` wraps the llama-server *HTTP* API but there is **no wrapper around `invoke`** — every call is raw + inline cast.

---

## 2. What "codegen" means and the two options

Make **one side the source of truth (Rust) and generate the other (TS)** so they cannot drift. Two mature tools:

### Option A — `ts-rs` (types only)
A `#[derive(TS)]` macro that emits `.ts` type definitions from Rust structs.
- ✅ Fixes **X3** (struct mirrors): delete the hand-written TS interfaces, import generated ones.
- ❌ Does **not** fix **X2**: you still call `invoke('db_save_message', {...})` stringly — names/args unchecked.
- Lighter footprint; types only.

### Option B — `tauri-specta` v2 (types **and** typed command/event bindings) — recommended
Generates a `bindings.ts` with **typed function wrappers** for every command plus all referenced types and typed events:

```ts
// generated src/lib/bindings.ts
import { commands, events } from '$lib/bindings';

await commands.getServerStatus();              // returns ServerStatus, fully typed
await commands.dbSaveMessage(conversationId, role, content);  // arg names/types checked
events.serverStatusChanged.listen((e) => { e.payload /* : ServerStatus */ });
```

- ✅ Fixes **X2 and X3 and** the 7 events. Renaming a Rust command/arg/field → regenerate → **TypeScript compile error** at every call site. That's exactly the guarantee these findings ask for.
- Built for Tauri 2; it's the Tauri-native answer.

**Recommendation: Option B (`tauri-specta`).** X2 (command/arg drift) is the higher-risk half, and ts-rs leaves it unsolved. The only reason to pick A is if you decide command-name safety isn't worth the extra wiring.

> ⚠️ **Maturity caveat:** `tauri-specta` v2 is at release-candidate (`2.0.0-rc.x`), as is its `specta` core. It's widely used and stable in practice, but it's pre-1.0 — pin exact versions and expect occasional churn on upgrades. This is the main reason this is a *decision*, not an automatic yes.

---

## 3. What adoption looks like (Option B)

### 3a. Dependencies (`src-tauri/Cargo.toml`)
```toml
specta = "=2.0.0-rc.22"
specta-typescript = "=0.0.9"
tauri-specta = { version = "=2.0.0-rc.21", features = ["derive", "typescript"] }
```
(exact RC versions pinned at implementation time)

### 3b. Annotate the boundary types
Add `specta::Type` to every struct/enum used by a *bound* command or event (~38, but realistically the subset reachable from the ~45 invoked commands):
```rust
#[derive(Clone, Debug, Serialize, specta::Type)]
pub struct SearchResult { pub title: String, pub url: String, pub snippet: String }
```
Mechanical, but touches many files. **Verification point:** `ServerStatus`/`SidecarStatus` uses `#[serde(tag = "type", content = "message")]`; specta honors serde enum reprs, but this exact tagged-enum shape must be confirmed to generate the existing `{ type: 'Error'; message: string }` wire form.

### 3c. Builder in `lib.rs` (replaces `generate_handler!`)
```rust
use tauri_specta::{collect_commands, collect_events, Builder};

let builder = Builder::<tauri::Wry>::new()
    .commands(collect_commands![server::get_server_status, db::db_save_message, /* …the bound set… */])
    .events(collect_events![ServerStatusChanged, DownloadProgress, /* … */]);

#[cfg(debug_assertions)]
builder
    .export(specta_typescript::Typescript::default(), "../src/lib/bindings.ts")
    .expect("export bindings");

tauri::Builder::default()
    .invoke_handler(builder.invoke_handler())
    .setup(move |app| { builder.mount_events(app); Ok(()) })
    // …
```

### 3d. Events become typed structs
```rust
#[derive(Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
pub struct DownloadProgress { /* … */ }
// emit: DownloadProgress { … }.emit(&app)?;   listen: events.downloadProgress.listen(...)
```

### 3e. Keep bindings fresh (CI)
The file is generated on a debug build (a `cargo test` triggers it). Add a CI check that regenerates and `git diff --exit-code`s `src/lib/bindings.ts` so a Rust change without regeneration fails the build. (Alternative: generate in `build.rs` — simpler but writes into `src/` on every build, which is noisier.)

### 3f. Migrate call sites
Replace raw `invoke('x', …)` with `commands.x(…)` and delete the hand-written TS mirrors, importing generated types instead. ~59 call sites + ~38 interface deletions. Can be done **incrementally** (see §5).

---

## 4. Cost / benefit

**Benefits**
- Eliminates 38+ hand-mirrored type definitions and makes all ~45 invoked commands + 7 events compile-time-checked end to end.
- Renames/field changes in Rust become TS compile errors instead of runtime tool failures.
- New commands get a typed wrapper for free.

**Costs / ongoing**
- New deps (RC-stage) + `specta::Type` derives across ~38 types.
- `lib.rs` handler registration rewritten (134 entries) — mechanical but large diff, and the `collect_commands!` list must stay correct.
- A generated, committed `bindings.ts` + a CI freshness check + a team rule ("regenerate after touching a bound command").
- Upgrade friction while specta/tauri-specta are pre-1.0.
- Serde-attribute edge cases to validate (tagged enums, `#[serde(default)]`, `Option`, `Result<_, String>` error mapping).

**For a solo/small project:** this pays off if the IPC surface keeps growing and you've been bitten by (or want to prevent) silent boundary drift. It is *not* worth it purely to delete 38 small interfaces.

---

## 5. Suggested phased path (if "go")

Incremental, each phase shippable and reversible:

1. **Spike (½–1 day):** add deps, derive `specta::Type` on **one domain** (e.g. `server` — `ServerStatus`/`ServerConfig`/`GpuFallbackState`, 3 commands, 2 events). Stand up the `Builder`, export `bindings.ts`, migrate `server.svelte.ts` to `commands.*`. **Confirm the tagged-enum `ServerStatus` generates the exact current wire shape.** This validates the whole approach on the trickiest type before committing.
2. **Types-first sweep:** derive `specta::Type` across the remaining bound structs; delete hand-written mirrors as each domain's types become available. (X3 largely done here.)
3. **Commands by domain:** migrate `invoke` → `commands.*` per area (models, proxy/search, db, shell, fs-tools). The ~89 backend-internal commands still register but need no TS wrapper.
4. **Events:** convert the 7 channels to `tauri_specta::Event`.
5. **CI guard:** add the "bindings up to date" check; document the regenerate step.

**Rough effort:** spike ~1 day; full migration ~3–5 focused days given 134 commands / 38 types / 59 call sites — spread across the phased PRs.

---

## 6. Decision needed

1. **Go / no-go** on typed IPC codegen at all?
2. If go: **Option B (tauri-specta, fixes X2+X3+events)** — recommended — or **Option A (ts-rs, X3 only, lighter)**?
3. **Scope:** bind only the ~45 TS-invoked commands (recommended) or all 134?
4. Comfortable with an **RC-stage dependency** and a committed generated file + CI freshness check?

My recommendation: **do the §5 phase-1 spike** behind a branch (low cost, ~1 day), see the generated `bindings.ts` and confirm the tagged-enum shape, then decide on the full rollout from real evidence rather than this estimate. If the spike feels heavy, fall back to **ts-rs for X3 only** and leave X2 as documented runtime risk.
