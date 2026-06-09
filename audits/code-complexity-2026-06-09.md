# Code Complexity Audit — Haruspex

**Date:** 2026-06-09
**Scope:** `src/` (SvelteKit/TS) + `src-tauri/src/` (Rust). ~48.2k LOC across 66 TS, 50 Svelte, 60 Rust files (tests excluded).
**Method:** Quantitative scan (decision-point counting within brace-bracketed function bodies) to rank hotspots, then in-depth structured review of the top ~40 functions across 6 subsystem clusters.

> **Metric caveats.** Cyclomatic complexity (CC) here counts real decision points (`if`/`else if`/`while`/`for`/`case`/`catch`/`&&`/`||`/ternary; Rust `match` arms count). The automated pre-scan inflated TS/Svelte CC by counting `=>` arrows — the numbers below are the **reviewed** values, not the raw scan. CC distinguishes **essential** complexity (a lookup table with 80 arms is high-CC but low cognitive load) from **accidental** complexity (deep nesting + mixed abstraction). Recommendations target the latter.

---

## Executive Summary

The codebase is generally well-factored: small files, co-located tests, clear module names, strong Rust test coverage. Complexity concentrates in a **handful of "god functions"** that accreted branching over time, plus **two structural issues** (a 2.3k-line `db.rs` and a duplicated document-builder family).

### Top findings by importance

| # | Finding | Location | Importance |
|---|---------|----------|:---:|
| F1 | `spawn_output_reader` — 240-LOC event loop, 3 interleaved async recovery paths, 6-deep nesting | `src-tauri/src/server/mod.rs:269` | **9/10** |
| F2 | `runIteration` — 390 LOC, ~18 sequential guard branches, 5 responsibilities | `src/lib/agent/loop/iteration.ts:370` | **9/10** |
| F3 | `init` (python worker) — 280-LOC god function, 7 responsibilities | `src/lib/sandbox/python.worker.ts:814` | **8/10** |
| F4 | `db.rs` — one `Database` impl mixing 4 entities + 25 command wrappers (2367 LOC) | `src-tauri/src/db.rs` | **8/10** |
| F5 | `runTestQuery` — 168 LOC, 5-deep SSE-parse + timer + polling tangle | `src/lib/stores/setup.svelte.ts:141` | **7/10** |
| F6 | `build_pdf` — 361 LOC, page-break + font-select logic triplicated | `src-tauri/src/fs_tools/pdf_write.rs:115` | **7/10** |
| F7 | `detect_hardware` — CC 11, dual if/else-if threshold ladders + magic numbers | `src-tauri/src/models.rs:542` | **6/10** |
| F8 | `sendMessage` — 134 LOC, 10+ inline callbacks (callback hell) | `src/lib/stores/chat.svelte.ts:860` | **6/10** |
| F9 | `download_file` — 139 LOC mixing FS/HTTP-resume/stream/progress | `src-tauri/src/models.rs:257` | **6/10** |
| F10 | Message-dispatch switches (`onMessage`, worker switch) — 13–16 cases, inline cleanup | `worker-manager.ts:199`, `python.worker.ts:1458` | **6/10** |
| F11 | Document-builder duplication (DOCX/ODT/ODP paragraph emit + zip scaffold) | `src-tauri/src/fs_tools/*.rs` | **6/10** |
| F12 | `search_auto` — CC 12, inline engine ordering + 3-way fallback | `src-tauri/src/proxy/search.rs:436` | **5/10** |
| F13 | `proxy_search` — 5-way provider match with duplicated telemetry | `src-tauri/src/proxy/mod.rs:286` | **5/10** |
| F14 | `update_engine_stat` — CC 8, validation tangled with SQL param mapping | `src-tauri/src/db.rs:527` | **4/10** |
| F15 | Dispatch-table candidates (`stepLabel`, `coerceFunctionStyleValue`, `diagnoseEmptyResponse`) — low cognitive load, verbose | `SearchStep.svelte:120`, `parser.ts:71`, `diagnostics.ts:11` | **3/10** |
| F16 | `capture_recent_commands` / `pending_command` — duplicated command-line resolution | `src-tauri/src/shell/integration.rs:342` | **4/10** |

### Aggregate metrics

- **Functions ≥ 50 LOC:** ~131 (flagged by scan). **Functions with reviewed CC ≥ 11:** ~12 genuine cases (the raw count of 165 was arrow-inflated).
- **Files > 300 LOC:** ~35. **Files > 700 LOC:** 16. **Largest:** `db.rs` (2367), `python.worker.ts` (1533), `models.rs` (1223), `fs_tools/mod.rs` (1043), `chat.svelte.ts` (994).
- **No class > 500 LOC** in the OOP sense; the equivalent is `db.rs`'s single `impl Database` block (see F4).

### Coupling snapshot

**Afferent (most depended-on) frontend modules** — the stable core, churn here is expensive:

| Module | Imported by | Note |
|---|---:|---|
| `$lib/stores/settings` | 40 | Settings store is the app's hub. |
| `$lib/api` | 28 | OpenAI-compatible client. |
| `$lib/debug-log` | 17 | Logging — low risk, leaf utility. |
| `$lib/stores/chat.svelte` | 10 | Also high efferent (17 imports) → unstable + central. |

**Efferent (most-importing) modules** — likely doing too much: `python.worker.ts` (33), `+layout.svelte` (27), `chat.svelte.ts` (17). Rust: `server/mod.rs` and `proxy/mod.rs` (15 each).

**Instability hotspot:** `chat.svelte.ts` has both high afferent (10) **and** high efferent (17) coupling — it is simultaneously central and unstable, the classic refactor-risk quadrant. See F8.

---

## Detailed Findings

### F1 — `spawn_output_reader`: triple recovery path in one event loop — **9/10**
**`src-tauri/src/server/mod.rs:269`** · ~241 LOC · CC ~18 · max nesting 6

The single most complex function in the codebase. A `match` over 5 `CommandEvent` variants (Stdout/Stderr/Terminated/Error/`_`), where the `Terminated` arm interleaves **three** distinct async recovery flows — GPU-layer fallback, auto-restart, and crash-telemetry reporting — each re-acquiring the `inner` lock, with crash-report construction nested 6 deep (lines ~337–369). GPU-error detection is spliced into the `Stderr` arm (~293–310), so the fallback decision depends on state mutated in a sibling arm.

**Remediation — extract each recovery flow behind a guard that returns an intent, keep the loop a thin dispatcher:**
```rust
// Each returns Some(()) when it owns the recovery, after mutating state under one lock.
async fn try_gpu_fallback(inner: &Arc<Mutex<ServerInner>>) -> Option<()> {
    let mut s = inner.lock().await;
    if s.status == ServerStatus::Starting
        && !s.gpu_fallback_attempted
        && s.gpu_error_detected
        && s.config.n_gpu_layers != 0
    {
        s.gpu_fallback_attempted = true;
        s.gpu_error_detected = false;
        s.config.n_gpu_layers = 0;
        return Some(());
    }
    None
}

CommandEvent::Terminated(payload) => {
    if let Some(report) = build_crash_report(&inner, payload, generation, &model_path).await {
        crash_telemetry::record(&app, &report);
    }
    if try_gpu_fallback(&inner).await.is_some() {
        respawn(&app, &inner).await;          // fallback path
    } else if try_auto_restart(&inner).await.is_some() {
        respawn(&app, &inner).await;          // restart path
    } else {
        report_terminal_error(&inner, &app).await;
    }
}
```
This drops the arm from ~120 LOC to ~10 and makes each recovery path independently testable.

---

### F2 — `runIteration`: 5 responsibilities, ~18 guard branches — **9/10**
**`src/lib/agent/loop/iteration.ts:370`** · ~390 LOC · CC ~18 · max nesting 4

The agent loop's per-turn function does, in one body: (1) parse tool calls, (2) guard against truncation/malformed output (lines ~448–502), (3) emit corrective "nudges" — narrate/file-write/diversity (~509–594), (4) execute tools and dispatch by name (~689–748), (5) stream final synthesis or continue. Roughly 11 of the `if (toolCalls.length === 0 && …)` guards stack sequentially with near-identical preconditions.

**Remediation — convert each guard into a `handle*` function returning a control signal; main loop becomes a dispatcher:**
```typescript
type Branch = 'continue' | null;

function handleLengthTruncation(s: LoopState, calls: ResolvedToolCall[], r: ChatCompletionResponse, msgs: ChatMessage[]): Branch {
	if (calls.length === 0 && s.usedTools && r.finish_reason === 'length') {
		msgs.push({ role: 'assistant', content: r.content ?? '' });
		msgs.push({ role: 'user', content: 'Continue.' });
		return 'continue';
	}
	return null;
}

// In runIteration, replace the stacked guards with:
for (const guard of [handleLengthTruncation, handleMalformedToolCall, handleNarrateRecovery, /* … */]) {
	if (guard(state, toolCalls, response, messages) === 'continue') return 'continue';
}
```
Move the guard family into a sibling `iteration-guards.ts`; leave `runIteration` as orchestration only. Same module also owns `isCodeContext` (CC 6, 4-deep) which is a clean extraction candidate (`isPythonCodeContext(messages, i)` helper).

---

### F3 — `init` (python worker): 280-LOC god function — **8/10**
**`src/lib/sandbox/python.worker.ts:814`** · ~280 LOC · CC ~8 (boot conditionals) but **7 responsibilities**

Boots Pyodide **and** configures local-first `fetch` interception, installs optional doc wheels, wraps micropip for phantom-dep fixes, installs matplotlib/plotly/bokeh hooks, registers JS↔Python bridges, and negotiates proxy mode. The CC is modest; the cost is cognitive — seven unrelated setup concerns in one Promise chain with nested type-guard ternaries (~923–965, ~1019–1031).

**Remediation — sequence named phases:**
```typescript
async function init(): Promise<void> {
	if (initStarted) return;
	initStarted = true;
	try {
		installLocalFirstFetch();
		pyodide = await loadPyodide({ indexURL });
		await setupPackages(pyodide);   // wheels + micropip wrap
		await setupPlotHooks(pyodide);  // matplotlib/plotly/bokeh
		await setupJSBridges(pyodide);  // save/fetch/sync bridges
		post({ kind: 'ready' });
	} catch (err) {
		post({ kind: 'load_error', error: String(err) });
	}
}
```
Each `setup*` is independently reviewable and the boot sequence reads as a checklist.

---

### F4 — `db.rs`: one impl block, four entities, 25 command wrappers — **8/10**
**`src-tauri/src/db.rs`** · 2367 LOC · `impl Database` spans lines 213–1246

The individual methods are *narrow* (most CC ≤ 3 — `get_job`, `get_job_run`, `lifetime_stats_snapshot` are simple row-assembly). The problem is **module cohesion**: one `Database` struct owns four unrelated domains plus a flat list of 25 `#[tauri::command]` wrappers. Confirmed boundaries:

| Domain | Lines | Methods |
|---|---|---|
| Migrations | 251–373 | `migrate` |
| Conversations | 374–525 | 8 |
| Search/engine stats | 527–742 | `update_engine_stat`, `lifetime_stats_snapshot`, `reset_lifetime_stats` |
| Jobs | 744–996 | 9 |
| Job runs | 998–1246 | 6 |
| Tauri command wrappers | 1249+ | ~25 |

**Remediation — split into a `db/` module folder, keep the shared connection in `mod.rs`:**
```
src-tauri/src/db/
├── mod.rs            // Database { conn: Mutex<Connection> } + migrate()
├── conversations.rs  // impl Database { fn list_conversations … }  (or a ConversationStore)
├── stats.rs
├── jobs.rs
├── runs.rs
└── commands.rs       // the #[tauri::command] wrappers
```
Rust allows multiple `impl Database` blocks across files in the same module, so this is a pure file-move with no API change. Also dedupe the repeated `row.get::<_, i64>(n)? as u64` row-assembly via a `from_row` constructor:
```rust
impl EngineLifetimeStats {
	fn from_row(row: &rusqlite::Row) -> rusqlite::Result<Self> {
		Ok(Self { engine: row.get(0)?, attempts: row.get::<_, i64>(1)? as u64, /* … */ })
	}
}
// query_map([], EngineLifetimeStats::from_row)?.collect::<Result<Vec<_>,_>>()?
```

---

### F5 — `runTestQuery`: SSE parse + timers + polling in one body — **7/10**
**`src/lib/stores/setup.svelte.ts:141`** · 168 LOC · CC ~11 · **max nesting 5**

Conflates: model-setup invokes, server-ready polling loop, HTTP streaming, SSE frame parsing (`data:` / `[DONE]`), and UI state writes. The 5-deep nest (`while → for line → try JSON.parse → delta access → assign`) plus a scattered `resetIdleTimer` closure make control flow hard to follow.

**Remediation — extract the two reusable concerns:**
```typescript
async function readSSEStream(reader: ReadableStreamDefaultReader<Uint8Array>, onIdle: () => void): Promise<string> {
	const dec = new TextDecoder();
	let buffer = '', out = '';
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += dec.decode(value, { stream: true });
		const lines = buffer.split('\n');
		buffer = lines.pop() ?? '';
		for (const line of lines) {
			const text = parseSSELine(line); // returns delta content or null on [DONE]/non-data
			if (text) { out += text; onIdle(); }
		}
	}
	return out;
}

async function waitForModelReady(timeoutMs: number): Promise<boolean> { /* the polling loop */ }
```
`runTestQuery` then orchestrates `waitForModelReady` → fetch → `readSSEStream`.

---

### F6 — `build_pdf`: triplicated page-break/font-select — **7/10**
**`src-tauri/src/fs_tools/pdf_write.rs:115`** · 361 LOC · CC ~13 · max nesting 6

The `match DocumentBlock` arms (Lines/MonoBlock/Image) each re-implement page-break checks and font selection. A page-break **closure** defined inside `build_pdf` captures 8 variables and is called 4× (~243, ~303, ~350, ~416). Helvetica rendering (~241–283) and Courier rendering (~301–337) are near-identical save for font choice.

**Remediation — extract the two repeated operations as free functions taking `&mut` cursor/ops:**
```rust
fn break_if_needed(cursor_y: &mut f32, ops: &mut Vec<Op>, pages: &mut Vec<Page>, needed_h: f32, layout: &PageLayout) {
	if *cursor_y - needed_h < layout.bottom { pages.push(flush_page(ops)); *cursor_y = layout.top_y; }
}
fn set_font_if_needed(ops: &mut Vec<Op>, last: &mut Option<FontKey>, target: FontKey, size_pt: f32) {
	if *last != Some(target) { ops.push(Op::SetFont { /* … */ }); *last = Some(target); }
}
```
Removes ~90 LOC of duplication and the 8-capture closure.

---

### F7 — `detect_hardware`: dual threshold ladders + magic numbers — **6/10**
**`src-tauri/src/models.rs:542`** · 72 LOC · **CC 11** · max nesting 4

Two parallel if/else-if hierarchies (model-quant selection and context-size selection) with repeated magic VRAM thresholds (4096/6144/8192/12288/16384/24576), and it mixes hardware detection with business-rule selection.

**Remediation — table-driven lookups + separate detection from recommendation:**
```rust
const QUANT_BY_VRAM: &[(u64, &str)] = &[
	(6144, "Qwen3.5-4B-Q6_K"), (8192, "Qwen3.5-9B-Q4_K_M"),
	(12288, "Qwen3.5-9B-Q5_K_M"), (16384, "Qwen3.5-9B-Q6_K"), (u64::MAX, "Qwen3.5-9B-Q8_0"),
];
fn recommend_quant(vram_mb: u64) -> &'static str {
	QUANT_BY_VRAM.iter().find(|(t, _)| vram_mb < *t).map(|(_, q)| *q).unwrap()
}
// detect_hardware() returns raw HardwareInfo; recommend_model_and_context(&hw) is a pure fn.
```
Collapses CC 11 → ~2 per function and centralizes the thresholds.

---

### F8 — `sendMessage`: callback hell — **6/10**
**`src/lib/stores/chat.svelte.ts:860`** · 134 LOC · CC ~6 but 10+ inline callbacks · nesting 3

The body passes 10+ inline closures (`onUsageUpdate`, `onContextManaged`, `onCallStats`, `onToolStart/Progress/End`, `onStreamChunk`, `onComplete`, `onError`) to the agent loop, mixing low-level state writes with high-level citation/formatting in `onComplete`. Compounded by F-coupling: this file is both highly depended-on (10) and highly depending (17).

**Remediation — hoist the callback bundle into a factory, extract `onComplete`:**
```typescript
function createAgentLoopCallbacks(conv: Conversation, turnStats: TurnStats, ctxSize: number) {
	return {
		onUsageUpdate: (u: Usage) => { updateContextUsage(u, ctxSize); conv.contextUsage = { promptTokens: u.prompt_tokens, completionTokens: u.completion_tokens }; },
		onCallStats:   (s) => { turnStats.lastCallStats = s; },
		onComplete:    makeOnComplete(conv, turnStats),
		/* … */
	};
}
```
Improves testability and lets the file be split into chat-state vs. agent-orchestration concerns later.

---

### F9 — `download_file`: FS + HTTP-resume + stream + progress — **6/10**
**`src-tauri/src/models.rs:257`** · 139 LOC · CC ~6 · max nesting 4

Five concerns in one async fn: existence check, partial-resume sizing, Range-request + status handling (incl. 206), chunk streaming with throttled progress emit, and finalize-rename. The cancel-flag lock is taken inside the stream loop.

**Remediation — split the stream loop out:**
```rust
async fn download_file(&self, app: &AppHandle, url: &str, filename: &str, expected: u64, stage: &str) -> Result<PathBuf, String> {
	let (final_path, partial) = self.paths_for(filename);
	if final_path.exists() { return Ok(final_path); }
	let existing = partial_size(&partial).await;
	let resp = self.fetch_with_resume(url, existing).await?;
	let total = total_size(existing, &resp, expected);
	self.stream_to_partial(&partial, resp, total, existing, app, stage).await?;
	fs::rename(&partial, &final_path).await.map_err(|e| e.to_string())?;
	Ok(final_path)
}
```

---

### F10 — message-dispatch switches — **6/10**
**`src/lib/sandbox/worker-manager.ts:199` (`onMessage`, 13 cases, CC 16)** and **`src/lib/sandbox/python.worker.ts:1458` (9 cases, CC 11)**

Both route worker messages via large `switch`es with inline timer/cleanup and null-guards per case (e.g. `onMessage` clears three timeouts inline in the `done` case).

**Remediation — dispatch table + extracted cleanup, lowers each path to ~CC 3:**
```typescript
private clearRunTimers(p: PendingRun) {
	if (p.timer) clearTimeout(p.timer);
	if (p.installWatchdog) clearTimeout(p.installWatchdog);
	if (p.terminateFallback) clearTimeout(p.terminateFallback);
}
private readonly handlers: Record<WorkerToMain['kind'], (m: any) => void> = {
	ready: () => this.handleReady(),
	done:  (m) => this.handleDone(m),
	install_progress: (m) => this.handleInstallProgress(m),
	/* … */
};
private onMessage(m: WorkerToMain) { this.handlers[m.kind]?.(m); }
```

---

### F11 — document-builder duplication — **6/10**
**`src-tauri/src/fs_tools/{docx,odt,odp,xlsx}.rs`**

`build_docx:96` (168 LOC) and `build_odt:21` (176 LOC) share a near-identical paragraph dispatch (image / heading / plain) with duplicated `escape_xml` + `format!` boilerplate (~60 LOC overlap). `fs_read_xlsx:193` inlines CSV quoting that `build_ods` also needs. All four share a manifest→styles→meta→content zip scaffold (~50 LOC each).

**Remediation (priority order):**
1. Extract per-paragraph emitters shared by DOCX/ODT-flavored callers: `emit_image_paragraph`, `emit_heading_paragraph`, `emit_text_paragraph`.
2. Extract `cell_to_csv_value(&Data) -> String` from `fs_read_xlsx`, reuse in `build_ods`.
3. **Defer** the generic zip-scaffold abstraction — the Pictures/ vs word/media/ and manifest differences make a shared helper risk over-coupling; only consolidate if a 4th format lands.

> **Not a defect:** `ascii_fold_for_pdf` (`markdown_inline.rs:581`, CC ~85) is an **essential** Unicode→ASCII lookup table. Leave it as a `match` (clearer than a `phf` map and avoids the dependency). Same for the `Data`-enum match in `fs_read_xlsx`.

---

### F12 / F13 — proxy search orchestration — **5/10**
**`search_auto` (`proxy/search.rs:436`, CC 12, nesting 5)** assembles `healthy`/`unhealthy` engine lists inline then runs a 3-way result match with `last_error` accumulation. **`proxy_search` (`proxy/mod.rs:286`, CC 8)** is a 5-way provider `match` with duplicated telemetry-recording per branch.

**Remediation:**
```rust
// search_auto: extract ordering
fn order_engines<'a>(state: &ProxyState, rotation: &[&'a str], cooldown: Duration) -> Vec<&'a str> {
	let (mut healthy, mut unhealthy) = (Vec::new(), Vec::new());
	for &e in rotation {
		if state.is_engine_healthy(e, cooldown) { healthy.push(e) } else { unhealthy.push(e) }
	}
	healthy.into_iter().chain(unhealthy).collect()
}
```
For `proxy_search`, a `SearchProvider` enum/trait that owns its own telemetry `record` call removes the per-branch duplication. Lower priority — `proxy/mod.rs` as a whole (969 LOC: dispatch + caching + rate-limit + stats) is a candidate to split caching/stats into sibling modules.

---

### F14 — `update_engine_stat`: validation tangled with SQL mapping — **4/10**
**`src-tauri/src/db.rs:527`** · 98 LOC · CC 8

Validates the failure column, then a 7-arm match maps it to a tuple of SQL bind params, interleaved with conditional timestamp computation.

**Remediation —** extract `fn delta_to_bind_params(delta) -> Result<BindParams, String>` so the public method is validation-free assembly + one `execute`.

---

### F16 — duplicated command-line resolution — **4/10**
**`src-tauri/src/shell/integration.rs:342` (`capture_recent_commands`) and `pending_command`** both resolve a command line from C/B markers with identical logic (~379–388 and ~448–457).

**Remediation —** extract `resolve_command_line(c: &Marker, b: &Marker, &self) -> (String, bool)` and call from both. (Note: `capture_recent_commands` runs 3 sequential `rposition` scans — acceptable given the 256-entry marker ring, but worth a comment documenting the bound.)

---

### F15 — verbose-but-simple dispatch (low priority) — **3/10**
These have **low cognitive complexity** (flat, no nesting) but read as long switch/if-chains. Optional polish, not debt:

- **`stepLabel` (`SearchStep.svelte:120`, 18-case switch):** replace with a `Record<string, (q: string) => string>` template map.
- **`coerceFunctionStyleValue` (`parser.ts:71`, CC 8):** a `[matcher, coerce]` table reads cleaner, but the current guard-clause chain is fine — defer.
- **`diagnoseEmptyResponse` (`diagnostics.ts:11`, CC 8):** a `DiagnosisRule[]` array makes the precedence explicit; worthwhile only if rules keep growing.

---

## What's Healthy (no action)

- **`crash_telemetry::record` (`server/mod.rs` sibling, CC 4)** — exemplary: decisions resolved into early match arms, linear body, single fallible op. Use as a style reference.
- **`build_ods` (`xlsx.rs:31`)**, **`buildLoopContext` (`iteration.ts:97`)**, **`parser.ts` extractors** — clean, single-responsibility, appropriately sized.
- **`LogViewer.svelte` (819 LOC)** — the size is markup + CSS; the TS logic is straightforward polling with helpers already extracted via `{#snippet}`. `parseLine` (CC 5) is fine.
- **Rust test coverage** in `db.rs` and `models.rs` (60+ and 10 tests) — refactors above are safe to perform behind these.

---

## Suggested sequencing

1. **F1 + F2** (the two riskiest god-functions; both have surrounding tests). High correctness payoff.
2. **F4** (db.rs module split) — mechanical file-move, no behavior change, unblocks future churn.
3. **F3, F5, F8** (frontend god-functions / callback hell).
4. **F6, F11** (document-builder DRY) — bundle into one PR.
5. **F7, F9, F10, F12–F16** — opportunistic, low-risk cleanups.

## Unable to verify / notes

- The automated pre-scan flagged a `push` at `chat.svelte.ts:647` with high CC; on inspection this is `urls.push(...)` inside `extractUrlsFromSteps`, **not a function** — false positive, excluded.
- CC values are reviewed estimates from reading the code, not output of a calibrated tool (no `rust-code-analysis`/`ts-complexity` in the toolchain). To get authoritative numbers, add `cargo install rust-code-analysis-cli` and an ESLint `complexity` rule (`"complexity": ["warn", 10]`) — that would prove/adjust every CC figure above.
