# Code Complexity Audit — Haruspex

- **Date:** 2026-05-14
- **Scope:** `src/` (TypeScript / Svelte) and `src-tauri/src/` (Rust). Tests excluded.
- **Method:** Per-file LOC; per-function brace-depth + line range (AWK); cyclomatic indicators counted by branch keywords (`if`, `for`, `while`, `match`/`case`, `catch`, `&&`, `||`). Coupling from explicit `use crate::*` / `import … from '$lib/*'`.
- **Totals scanned:** 26 Rust files (≈15 k LOC), 68 TS/Svelte source files (≈15 k LOC).
- **Thresholds used:** function > 50 LOC, file > 300 LOC, cyclomatic > 10, max nesting > 4. These match the prompt's request.

> Cyclomatic numbers below are **approximations** computed from branch-keyword counts (≈ 1 + ifs + loops + cases + `&&` + `||` + catches). They're directionally accurate for ranking but not exact. Where I cite an exact value (e.g. `≈83`), treat ±15% as the real uncertainty.

---

## Executive Summary

| # | Subject | Layer | Severity | Effort | Primary metric |
| --- | --- | --- | --- | --- | --- |
| C-1 | `runAgentLoop` (loop.ts:242-842, 601 LOC) | TS | **10** | L (1–2 d) | cyclomatic ≈83 |
| C-2 | `fs_tools.rs` — 5 625 LOC, doc-builders 200–500 LOC each | Rust | **10** | L (2–3 d) | file size, function size |
| C-3 | `sendMessage` (chat.svelte.ts:499-756, 258 LOC) | TS | **9** | M (4–6 h) | cyclomatic ≈48 |
| C-4 | `impl LlamaServer` (server.rs:132-803, 672 LOC) | Rust | **9** | M–L (1 d) | depth 11, file 973 LOC |
| C-5 | `settings/+page.svelte` (1 628 LOC; 435 script / 612 style) | Svelte | **8** | M (4–6 h) | file size, low cohesion |
| C-6 | `python.worker.ts::init` (497-715, 219 LOC) | TS | **8** | M (3–4 h) | function size, mixed abstraction |
| C-7 | `build_pdf` (fs_tools.rs:3093-3533, 441 LOC) | Rust | **8** | M (4–6 h) | depth 8, cyclomatic ≈35 |
| C-8 | `build_pptx` (fs_tools.rs:1587-2093, 507 LOC) | Rust | **8** | M (4–6 h) | depth 8 |
| C-9 | `proxy.rs` — 2 145 LOC, mixed responsibilities | Rust | **7** | M (1 d) | file size, low cohesion |
| C-10 | `routes/+page.svelte` (1 041 LOC, 295 script) | Svelte | **7** | M (4 h) | file size |
| C-11 | `models.rs::impl ModelManager` (170-507, 338 LOC) | Rust | **6** | S–M (3 h) | impl size, cyclomatic ≈30 |
| C-12 | `server.rs::spawn_output_reader` (417-704, 288 LOC) | Rust | **6** | S–M (2 h) | depth 10 |
| C-13 | `setup/+page.svelte` (765 LOC) | Svelte | **5** | S (1–2 h) | file size |
| C-14 | `chat.svelte.ts` (756 LOC, fan-in 0 but 28 exports) | TS | **5** | S (2 h) | low cohesion |
| C-15 | `$lib/stores/settings` fan-in 22 — hub coupling | TS | **5** | n/a | instability ≈0.3 (stable hub) |
| C-16 | `LlamaServer` afferent coupling = 0 (privately owned via `lib.rs`) | Rust | **3** | n/a | unstable but acceptable |

Top 8 items (severity ≥ 8) capture > 80% of the technical debt and would take **roughly 4–6 engineering days** to address in earnest.

---

## Detailed Findings

### C-1 — `runAgentLoop` is a 601-line god function (Severity 10)

**Location:** `src/lib/agent/loop.ts:242-842`

- LOC: **601** (vs 50-line threshold → 12×)
- Cyclomatic (approx): `1 + 39 if + 9 for + 1 while + 21 && + 10 || + 2 catch ≈ 83`
- Max brace nesting: 6
- Tracks 14+ pieces of per-turn mutable state in the same scope: `pendingImages`, `filesWrittenThisTurn`, `iteration`, `usedTools`, `fileWrittenThisTurn`, `fileWriteRetries`, `webSearchUsed`, `fetchedUrlsThisTurn`, `diversityNudged`, `consecutiveRunPythonFailures`, `lastFinish`, `streamUsage`, plus the message array (`loop.ts:266-293`).

**Why it's a problem.** Cognitive complexity here is genuinely high — the function multiplexes prompt assembly, streaming, tool dispatch, paywall handling, three independent nudge heuristics (fileWrite, diversity, runPython failures), and length-truncation retry. Reading lines 760–820 requires holding all of the above counters in your head. The 39 `if` statements are not branching on one polymorphic dispatch — they're 39 independently-conceived checks at the same level of abstraction as the loop iteration itself.

**Remediation — extract one helper per concern.** Each of these is a structural extraction; the bodies already exist in `loop.ts`.

```ts
// src/lib/agent/loop/nudges.ts
export class NudgeState {
	fileWritten = false;
	fileWriteRetries = 0;
	webSearchUsed = false;
	fetchedUrls = new Set<string>();
	diversityNudged = false;
	consecutiveRunPythonFailures = 0;

	considerFileWriteNudge(usedTools: boolean, expectsFile: boolean): ChatMessage | null { /* current 786-792 block */ }
	considerDiversityNudge(): ChatMessage | null { /* current ~440-446 block */ }
	considerRunPythonNudge(toolName: string, result: string): string {
		if (toolName !== 'run_python') return result;
		if (result.startsWith('Error:')) this.consecutiveRunPythonFailures++;
		else this.consecutiveRunPythonFailures = 0;
		if (this.consecutiveRunPythonFailures >= 3) return result + RUN_PYTHON_NUDGE_HINT;
		return result;
	}
}
```

```ts
// src/lib/agent/loop/iteration.ts
async function runIteration(ctx: LoopContext, nudges: NudgeState): Promise<IterationResult> {
	// Body of the current `while (iteration < maxIterations)` block, returning
	// `{ shouldContinue: boolean, assistantMessage?: ChatMessage }`.
}

export async function runAgentLoop(options: AgentLoopOptions): Promise<void> {
	const ctx = buildLoopContext(options);
	const nudges = new NudgeState();
	for (let i = 0; i < ctx.maxIterations; i++) {
		const result = await runIteration(ctx, nudges);
		if (!result.shouldContinue) return;
	}
}
```

Target: each extracted helper ≤ 80 LOC, runAgentLoop ≤ 50 LOC. The three "consider*Nudge" methods make their respective heuristics independently unit-testable — `parser.test.ts` and `search.test.ts` already exist as templates.

---

### C-2 — `fs_tools.rs` is a 5 625-line monolith with four megafunctions (Severity 10)

**Location:** `src-tauri/src/fs_tools.rs`

- File LOC: **5 625** (vs 300-line threshold → 18×)
- Function sizes:
  - `build_pptx` lines `1587-2093` — **507 LOC**, max depth 8, ~26 branches
  - `build_pdf` lines `3093-3533` — **441 LOC**, max depth 8, ~34 branches
  - `build_odp` lines `2101-2331` — **231 LOC**
  - `build_docx` lines `782-983` — **202 LOC**
  - `build_odt` lines `997-1197` — **201 LOC**
- Cohesion: extremely low. The file contains PDF rendering, DOCX/ODT/PPTX/ODP zip-XML assembly, XLSX/ODS spreadsheet building, Markdown inline parsing, image loading, PDF text reconstruction, and the `fs_*` Tauri commands. Eight distinct subdomains glued together because they all involve writing files.

**Why it's a problem.** Build times balloon: any edit to `parse_inline_markdown` (line 2378) triggers recompile of the PDF/DOCX/PPTX/ODP/ODT modules even though only one consumes it. Reviewing a PR touching `build_pptx` requires scrolling past 1 500 LOC of unrelated code. Adding a new format (e.g. `.rtf`) means appending to the bottom of a 5 600-line file rather than dropping a sibling.

**Remediation — split by format into a module tree.** This is a mechanical refactor with high upfront effort but low risk (everything stays compiled by `mod.rs`):

```
src-tauri/src/fs_tools/
├── mod.rs              // re-exports + Tauri commands (`fs_list_dir`, `fs_read_text`, `fs_write_text`, etc.)
├── path.rs             // resolve_in_workdir, fs_find_available_path, fs_list_dir
├── markdown_inline.rs  // parse_inline_markdown, wrap_styled_words, wrap_to_width
├── pdf_read.rs         // fs_read_pdf, reconstruct_page_layout, ascii_fold_for_pdf
├── pdf_write.rs        // build_pdf (3093-3533) + helpers
├── docx.rs             // build_docx, extract_docx_text
├── odt.rs              // build_odt
├── pptx.rs             // build_pptx (1587-2093)
├── odp.rs              // build_odp
├── xlsx.rs             // build_ods, build_xlsx, fs_read_xlsx, fs_write_xlsx
├── image.rs            // fs_read_image, LoadedImage, extract_markdown_image_paths
└── download.rs         // fs_download_url
```

Verify by running `cargo check` after each `mod` is moved — Rust's privacy rules will catch any helper that was implicitly relied on across modules. Then split `build_pdf` and `build_pptx` themselves (C-7, C-8).

---

### C-3 — `sendMessage` is a 258-line orchestration function (Severity 9)

**Location:** `src/lib/stores/chat.svelte.ts:499-756`

- LOC: **258**
- Cyclomatic (approx): `1 + 23 if + 1 catch + 10 && + 9 || + 4 ternary ≈ 48`
- Max depth: 6
- Concerns multiplexed: input validation, conversation creation, compaction, system-prompt assembly, prior-turn tool splicing, hint injection, agent-loop call, streaming callbacks, error mapping, abort handling, debug logging, paywall/searchSteps capture, source URL extraction, message persistence, tok/s stat capture.

**Why it's a problem.** Same shape as C-1: dozens of `if`s at one abstraction level. The reactive store, the API surface, the prompt assembly, and the persistence layer are all interleaved.

**Remediation — pull prompt assembly + callback wiring out into pure helpers.**

```ts
// chat.svelte.ts
export async function sendMessage(content: string): Promise<void> {
	if (!content.trim() || isGenerating || isCompacting) return;
	const conv = ensureActiveConversation();
	if (!conv) return;
	await compactIfNeeded();
	finalizeUserTurn(conv, content);

	isGenerating = true;
	resetTurnState();
	abortController = new AbortController();

	const stats = new CallStatsTracker();
	try {
		const messagesForApi = buildApiPrompt(conv, content);
		await runAgentLoop({
			messages: messagesForApi,
			signal: abortController.signal,
			workingDir,
			...streamCallbacks(conv, stats)
		});
		commitAssistantMessage(conv, stats);
	} catch (e) {
		handleTurnError(conv, e);
	} finally {
		isGenerating = false;
	}
}
```

`buildApiPrompt` absorbs `chat.svelte.ts:548-590` (prompt assembly, lastTurnTools splice, hint injection). `streamCallbacks` absorbs the onDelta / onToolCall / onCallStats wiring. `commitAssistantMessage` + `handleTurnError` absorb the post-loop branches. After the split each helper sits ≤ 50 LOC with ≤ 4 conditions.

---

### C-4 — `impl LlamaServer` block (Severity 9)

**Location:** `src-tauri/src/server.rs:132-803`

- Impl block LOC: **672**
- File LOC: **973**
- Inside the impl: `if:47`, `for:12`, `while:3`, `match:4`, max depth 11 (deepest in the repo)
- Long methods inside:
  - `spawn_output_reader` lines `417-704` — **288 LOC**, depth 10
  - `start` lines `189-292` — **104 LOC**
  - `spawn_health_poller` lines `706-755` — 50 LOC
  - `kill_process_on_port` lines `227-292` — 66 LOC (duplicated; see code-duplication audit R-1)

**Why it's a problem.** Single struct owns sidecar lifecycle, log buffering, GPU detection, GPU fallback, child-process plumbing, status notifications, and Tauri event emission. `spawn_output_reader` is the worst — it nests `while → match → if-chain → if … → … → if` ten levels deep just to classify a log line and decide whether to flip the CPU-fallback flag.

**Remediation — extract two pure helpers and one async sub-task.**

```rust
// server/log_classifier.rs
pub enum LogSignal {
    GpuError,
    Ready,
    Plain,
}

pub fn classify(line: &str) -> LogSignal { /* GPU_ERROR_PATTERNS + ready needle */ }

// server/output_reader.rs
pub async fn run_output_reader(
    inner: Arc<Mutex<ServerInner>>,
    mut rx: Receiver<CommandEvent>,
    app: AppHandle,
    generation: u64,
) {
    while let Some(event) = rx.recv().await {
        let line = event_to_line(&event);
        let signal = classify(&line);
        let mut state = inner.lock().await;
        if state.generation != generation { return; }      // stale reader
        state.push_log(&line);
        match signal { /* 3 short arms */ }
    }
}
```

After this, `LlamaServer::spawn_output_reader` shrinks from 288 LOC to a 10-line spawn. Combine with R-1/R-2/R-3 from the duplication audit (move log/port/health helpers into `sidecar_utils.rs`) and the `impl` block falls below 300 LOC.

---

### C-5 — `routes/settings/+page.svelte` is 1 628 lines (Severity 8)

**Location:** `src/routes/settings/+page.svelte`

- File LOC: **1 628**
- Script block: lines `1-436` (435 LOC)
- Style block: lines `1016-1628` (612 LOC) — largest stylesheet in the repo
- Imports: 10
- Concerns mixed in one page: inference mode toggling, email account CRUD, TTS voice, table reading toggle, response format, theme, search provider + keys, proxy config, working-dir settings, debug-log clearing.

**Why it's a problem.** Touching one preference reloads/redrafts the entire settings page during dev. Each "settings family" (inference / email / search / tts / proxy) is logically a tab but lives in a flat template.

**Remediation — extract by settings family.**

```
src/lib/components/settings/
├── InferenceSection.svelte   // current InferenceBackendForm usage + setInferenceMode (102-160)
├── EmailSection.svelte       // loadEmailPresets + EmailAccountForm list (167-214)
├── TtsSection.svelte         // setTtsVoice, toggleTableReading (216-235)
├── SearchSection.svelte      // braveApiKey, searxngUrl, searchProvider, searchRecency
├── ProxySection.svelte       // proxyMode/Url/Bypass
└── ResponseFormatSection.svelte
```

The settings route then becomes a thin orchestrator (≈ 80 LOC) plus a `<style>` block that delegates per-section CSS to the components. The 612-line stylesheet collapses by ~70 % once each section owns its scoped styles. This refactor is mechanical and reduces merge conflicts when multiple features land settings changes simultaneously.

---

### C-6 — `python.worker.ts::init` (Severity 8)

**Location:** `src/lib/sandbox/python.worker.ts:497-715`

- LOC: **219**
- Cyclomatic (approx): `1 + 21 if + 4 for + 1 catch ≈ 27`
- Max depth: 6
- Mixed abstraction levels in one body: Pyodide loading + CDN URL strings, npm-package eager-load list, `globals.set(...)` callback registration for **eight** distinct bridges (`_haruspex_save`, `_haruspex_delete`, `_haruspex_fetch`, `_haruspex_emit_image`, `_haruspex_skip_http_patch`, `_haruspex_working_dir_set`, plus two more), runtime-config waiter handling, and finally a `runPython(HARUSPEX_INIT_PY)` call.

**Why it's a problem.** Each `globals.set` block is a self-contained adapter (Python ↔ TS message bridge). They have nothing to do with each other except sharing the same Pyodide handle.

**Remediation — register bridges via a table.**

```ts
// src/lib/sandbox/bridges.ts
interface PyodideBridge {
	name: string;
	register(py: PyodideInterface): void;
}

export const BRIDGES: PyodideBridge[] = [
	{ name: '_haruspex_save',         register: registerSave },
	{ name: '_haruspex_delete',       register: registerDelete },
	{ name: '_haruspex_fetch',        register: registerFetch },
	{ name: '_haruspex_emit_image',   register: registerEmitImage },
	// …
];
```

Then `init` becomes:

```ts
async function init(): Promise<void> {
	if (initStarted) return;
	initStarted = true;
	pyodide = await loadPyodide({ indexURL: PYODIDE_CDN_URL });
	await pyodide.loadPackage(['micropip', 'Pillow', 'lxml', 'typing_extensions']);
	pyodide.globals.set('_haruspex_doc_wheels_url', WHEELS_URL);
	for (const b of BRIDGES) b.register(pyodide);
	const cfg = await waitForProxyMode();
	pyodide.globals.set('_haruspex_skip_http_patch', cfg.mode === 'manual');
	pyodide.globals.set('_haruspex_working_dir_set', cfg.workingDirSet);
	await pyodide.runPythonAsync(HARUSPEX_INIT_PY);
}
```

Each bridge becomes a 15–25 LOC module — independently reviewable and testable.

---

### C-7 — `build_pdf` is 441 LOC with depth 8 (Severity 8)

**Location:** `src-tauri/src/fs_tools.rs:3093-3533`

- LOC: **441**, branches: ~34, max depth 8
- Responsibilities folded together: image registration, page layout constants, font metrics, line layout, page break logic, image-positioning math, raster export.

**Remediation — pull a `PdfLayoutEngine`.**

```rust
// fs_tools/pdf_write.rs (after the C-2 split)
struct PdfLayout {
    cursor_y: Mm,
    page_width: Mm,
    margins: PdfMargins,
}

impl PdfLayout {
    fn write_text_run(&mut self, doc: &mut PdfDocument, run: &InlineRun) { /* … */ }
    fn write_image(&mut self, doc: &mut PdfDocument, img: &LoadedImage) { /* … */ }
    fn new_page(&mut self, doc: &mut PdfDocument) { /* … */ }
}

pub fn build_pdf(lines: &[&str], images: &HashMap<String, LoadedImage>) -> Result<Vec<u8>, String> {
    let mut doc = PdfDocument::new("Document");
    let registered = register_images(&mut doc, images)?;
    let mut layout = PdfLayout::new();
    for raw in lines { /* dispatch on parsed line type; ≤ 50 LOC total */ }
    Ok(doc.save_to_bytes()?)
}
```

`build_pdf` falls to ~50 LOC; layout math is unit-testable in isolation.

---

### C-8 — `build_pptx` is 507 LOC with depth 8 (Severity 8)

**Location:** `src-tauri/src/fs_tools.rs:1587-2093`

- LOC: **507**, branches: ~23, max depth 8
- The function generates an entire OPC (Office Open XML) package by hand: `[Content_Types].xml`, `_rels/.rels`, `ppt/presentation.xml`, per-slide XML, per-slide rels, theme XML, slide layout, slide master, media files. Each is a separate inline string concatenation.

**Remediation — split per OPC part.**

```rust
// fs_tools/pptx.rs
fn write_content_types(zip: &mut ZipWriter<…>, exts: &BTreeSet<&str>, slides: usize) -> ZipResult<()> { … }
fn write_root_rels(zip: &mut ZipWriter<…>) -> ZipResult<()> { … }
fn write_presentation_xml(…) -> ZipResult<()> { … }
fn write_slide(…, idx: usize, slide: &PptxSlide, image_idx: Option<usize>) -> ZipResult<()> { … }
fn write_slide_rels(…) -> ZipResult<()> { … }
fn write_theme(…) -> ZipResult<()> { … }
fn write_slide_layout(…) -> ZipResult<()> { … }
fn write_slide_master(…) -> ZipResult<()> { … }
fn write_media(…) -> ZipResult<()> { … }

pub fn build_pptx(slides: &[PptxSlide], images: &HashMap<String, LoadedImage>) -> Result<Vec<u8>, String> {
    if slides.is_empty() { return Err("At least one slide is required".to_string()); }
    let image_index = assign_image_indices(slides);
    let unique_exts = collect_extensions(&image_index, images);
    let mut buf = Vec::new();
    {
        let mut zip = ZipWriter::new(Cursor::new(&mut buf));
        write_content_types(&mut zip, &unique_exts, slides.len())?;
        write_root_rels(&mut zip)?;
        write_presentation_xml(&mut zip, slides.len())?;
        for (i, slide) in slides.iter().enumerate() {
            write_slide(&mut zip, i + 1, slide, image_index.get(&slide.image), …)?;
            write_slide_rels(&mut zip, i + 1, slide.image.is_some())?;
        }
        write_theme(&mut zip)?;
        write_slide_layout(&mut zip)?;
        write_slide_master(&mut zip)?;
        for path in &ordered_image_paths { write_media(&mut zip, path, &images[*path])? }
        zip.finish().map_err(|e| e.to_string())?;
    }
    Ok(buf)
}
```

After the split, `build_odp` (line 2101, 231 LOC) gets the same treatment since the OPC layout is parallel.

---

### C-9 — `proxy.rs` mixes six search backends, fetch, image extraction, paywall, IP filtering (Severity 7)

**Location:** `src-tauri/src/proxy.rs` (2 145 LOC, 26 functions)

- DuckDuckGo, Mojeek, Brave HTML, Brave API, SearXNG, "auto" routing — 6 separate search backends sharing only the `SearchResult` struct.
- Long functions: `extract_page_images` (1274-1379, 106 LOC), `search_auto` (668-757, 90 LOC), `search_brave` (959-1032, 74 LOC), `parse_commons_imageinfo` (1523-1604, 82 LOC).
- Indicators across the file: `if:76, for:41, match:18, ||:18` — moderate per-function but high total.

**Why it's a problem.** Each backend is independent; testing or replacing one shouldn't require pulling in 2 000 lines.

**Remediation — module split mirroring C-2.**

```
src-tauri/src/proxy/
├── mod.rs            // ProxyState, ProxyConfig, public proxy_* Tauri commands (proxy_search, proxy_fetch, proxy_image_search, proxy_fetch_url_images)
├── bypass.rs         // parse_bypass_list, should_bypass, is_private_ip
├── extract.rs        // extract_text, extract_body_text, try_select_text, strip_html_tags
├── paywall.rs        // detect_paywall_signal
├── search/
│   ├── mod.rs        // SearchResult + search_auto dispatcher
│   ├── ddg.rs        // search_duckduckgo, parse_ddg_html
│   ├── mojeek.rs     // search_mojeek, parse_mojeek_html
│   ├── brave.rs      // search_brave, search_brave_html, parse_brave_html
│   └── searxng.rs    // search_searxng
└── images/
    ├── mod.rs        // proxy_image_search, proxy_fetch_url_images
    ├── page.rs       // extract_page_images
    └── commons.rs    // parse_commons_imageinfo, commons_extmetadata_string
```

No public API change required — `pub use search::*;` from `proxy/mod.rs`.

---

### C-10 — `routes/+page.svelte` (Severity 7)

**Location:** `src/routes/+page.svelte` (1 041 LOC)

- Script block: 1-296 (295 LOC), style: 542-1041 (499 LOC)
- Embedded concerns: conversation sidebar with rename, copy-debug-log handler, message-list scroll management, keyboard shortcuts (Cmd+K, Cmd+Enter, etc.), send-message handler, CPU-fallback dismissal, GPU-restart action, abort/copy actions, drag-and-drop file handling.

**Remediation — extract two components and a `useKeyboardShortcuts` action.**

```svelte
<!-- src/lib/components/ConversationSidebar.svelte -->
<!-- Owns: conversation list, rename inline editor, keyboard nav over conversations -->

<!-- src/lib/components/MessageScrollHost.svelte -->
<!-- Owns: scrollToBottom, handleScroll, handleScrollToBottom, "stick to bottom" state -->
```

```ts
// src/lib/actions/keyboardShortcuts.ts
export function shortcuts(node: HTMLElement, map: Record<string, () => void>) { … }
```

Page route ends ≈ 250 LOC, 7 imports.

---

### C-11 — `impl ModelManager` (Severity 6)

**Location:** `src-tauri/src/models.rs:170-507`

- Impl LOC: **338**
- Whole-file branches: `if:66, for:22, ||:12, ?:31`

The impl owns: model registry walking, on-disk catalog reads, download orchestration (which itself contains the resume logic flagged as R-4 in the duplication audit), cancellation handling, progress events, and disk-space probing.

**Remediation.** Two-step:

1. Apply R-4 from the duplication audit (extract `download_with_resume`).
2. Split `impl ModelManager` into `impl ModelManager` (state) + `impl ModelDownloader` (download lifecycle):

```rust
// models/downloader.rs
pub struct ModelDownloader { /* client, in_flight: HashMap<…>, cancel_tokens: … */ }
impl ModelDownloader {
    pub async fn start(&self, app: &AppHandle, info: &ModelInfo) -> Result<(), String>;
    pub async fn cancel(&self, model_id: &str);
}
```

Brings the manager `impl` under 200 LOC and decouples "what models exist" from "downloading them".

---

### C-12 — `spawn_output_reader` depth 10 (Severity 6)

Already covered structurally by C-4. Highlighting separately because depth 10 is the deepest nesting in the codebase and the easiest individual win (extract `classify(line: &str) -> LogSignal`, see C-4 snippet). Severity 6 because once C-4 is applied this disappears.

---

### C-13 — `routes/setup/+page.svelte` (Severity 5)

**Location:** `src/routes/setup/+page.svelte` (765 LOC; script 295, style 407)

Linear setup wizard with five steps (welcome → hardware → download → test → chat). Lower priority than C-5/C-10 because the steps are already clearly delineated. Suggested: lift each step to a `<SetupStepFoo>` component and keep only navigation logic in the route.

---

### C-14 — `chat.svelte.ts` exports 28 functions (Severity 5)

**Location:** `src/lib/stores/chat.svelte.ts` (756 LOC)

`grep -c "^export" src/lib/stores/chat.svelte.ts` is 28. Most are getters (`getIsGenerating`, `getStreamingContent`, `getErrorMessage`, …). This is fine for a Svelte 5 store except that mutating concerns (`sendMessage`, `cancelGeneration`, `deleteConversation`, `createConversation`, `renameConversation`, `clearAllConversations`) and side-effecting persistence concerns (`compactIfNeeded`, `restoreSandboxSession`, `setActiveConversation`) live alongside the read-side surface.

**Remediation.** Mostly cosmetic — fan-in is actually 0 (no `import` of `chat.svelte` found by grep), which means the file is probably consumed via `$lib/stores/chat` resolved by SvelteKit and is *used everywhere*. Verify by:

```bash
grep -rn "from '\\\$lib/stores/chat'" src
```

If the consumer list is large, split read/write surfaces:

```
src/lib/stores/chat/
├── index.ts           // re-exports
├── state.svelte.ts    // reactive primitives + getters
├── actions.ts         // sendMessage, cancelGeneration, deleteConversation, ...
└── persistence.ts     // restoreSandboxSession, compactIfNeeded, dbSave*
```

---

### C-15 — `$lib/stores/settings` fan-in = 22 (Severity 5)

**Coupling table** (afferent / efferent for the heaviest TS modules):

| Module | Afferent (fan-in) | Efferent (fan-out) | Instability `Ce/(Ca+Ce)` | Verdict |
| --- | --- | --- | --- | --- |
| `$lib/stores/settings` | **22** | low | ≈ 0.1 | Stable hub — fine, but keep API narrow |
| `$lib/api` | 16 | low | ≈ 0.1 | Stable hub |
| `$lib/debug-log` | 9 | low | ≈ 0.1 | Stable hub |
| `$lib/agent/loop` | 4 | 6 | ≈ 0.6 | Volatile core — split per C-1 |
| `$lib/markdown` | 4 | 12 | ≈ 0.75 | Volatile — but it's mostly stateless transforms; acceptable |
| `$lib/stores/chat.svelte.ts` | 0¹ | 12 | n/a | See C-14; verify with the grep above |

¹ `import '$lib/stores/chat'` resolves to the actual `chat.svelte.ts` file via SvelteKit's `+.svelte.ts` convention; my grep only counted exact-path matches. **Unable to verify** the true fan-in without `grep -rn "stores/chat"`.

`$lib/stores/settings` is the clearest hub. Twenty-two files reading its surface means any breaking change to a field (e.g. renaming `proxy.mode`) hits all of them. This is a stable dependency and acceptable — but **flag in the README** that the public surface (`getSettings()`, `updateSettings(...)`, the `ResponseFormat`/`ProxyMode`/etc. enums) is treated as semver-stable. A type-level lint already enforces this implicitly (TS will fail across all 22 sites), so no code change needed beyond awareness.

---

### C-16 — Rust-side coupling looks fine (Severity 3)

Per-file `use crate::X` counts:

- 4 files import once each (`sandbox_save.rs`, `sandbox_fetch.rs`, `lint.rs`, `integrations/email/smtp_client.rs` each `use crate::*` once).
- Every other Rust module has **zero** `use crate::` imports — they're leaf modules called from `lib.rs`.
- `lib.rs:54-…` registers **72 Tauri commands** via `tauri::generate_handler![…]`, importing the modules as `mod foo;` and forwarding `foo::*` directly into the handler.

This means the Rust side is a star topology: `lib.rs` is the hub, every other file is a spoke. No circular dependencies, no transitive coupling chains. Instability is effectively 0 for every spoke (no afferent crate-internal usage) and 1.0 for `lib.rs` (depends on all spokes, depended on by none). This is the **textbook stable-abstractions principle layout** for a Tauri app and needs no action.

The only weakness: when one spoke needs a helper from another (e.g. R-1/R-2/R-3 in the duplication audit), it currently copy-pastes. The proposed `sidecar_utils.rs` module will turn three spokes into shared-utility consumers — that's fine as long as `sidecar_utils` itself stays leaf (no `use crate::` of other spokes).

---

## Items I Could Not Verify

- **TS module fan-in.** My grep used `from '$lib/<path>'` to count imports. SvelteKit resolves `'$lib/stores/chat'` to `chat.svelte.ts`, `chat.ts`, or `chat/index.ts` depending on what's on disk. The reported fan-in of 0 for `chat.svelte.ts` and `setup.svelte.ts` is suspicious. **What would prove it:** `grep -rnE "from '\\\$lib/stores/(chat|setup|server|context|fileConflict|sandboxApproval)'" src`. If the real numbers are non-trivial, recalculate instability for those stores.
- **Exact cyclomatic complexity.** My per-function counts approximate cyclomatic by tallying branch keywords. They overcount slightly (every `&&`/`||` adds a path but so does the `if` they sit inside, double-counted) and miss ternaries with colon-only matches. **What would prove the exact numbers:** run `tokei` for LOC and `cargo-geiger` / `eslint-plugin-complexity` (rule `complexity: ['error', 10]`) for cyclomatic. Adding the ESLint rule is a 10-minute change to `eslint.config.js`:

  ```js
  // eslint.config.js
  rules: {
      'complexity': ['warn', 15],
      'max-depth': ['warn', 4],
      'max-lines-per-function': ['warn', { max: 80, skipBlankLines: true, skipComments: true }]
  }
  ```

- **Whether the proposed `fs_tools/` and `proxy/` module splits break anything in the Tauri command surface.** They shouldn't (Rust privacy is path-only) but the `tauri::generate_handler!` macro path strings in `lib.rs:54-…` need to be updated to the new module paths. **What would prove it:** apply the split locally, run `cargo check` once.

---

## Suggested Order of Work

The complexity audit interacts with the duplication audit (`audits/code-duplication-2026-05-14.md`). Suggested merge order:

1. **Apply duplication audit R-1 / R-2 / R-3 first** (extract `sidecar_utils.rs`). This deletes ~250 LOC from `server.rs`/`tts.rs`/`whisper.rs` and shrinks the `impl LlamaServer` block from 672 → ~500 LOC before C-4 is even attempted.
2. **C-12 / C-4** — split `spawn_output_reader` and extract `LogClassifier`.
3. **C-2** — `fs_tools.rs` module tree. Mechanical, high ROI, unlocks C-7 / C-8.
4. **C-7 / C-8** — refactor `build_pdf` / `build_pptx` (and `build_odp` opportunistically).
5. **C-9** — `proxy.rs` module tree.
6. **C-1** — `runAgentLoop` extraction. High value, but expensive — schedule deliberately.
7. **C-3 / C-6** — `sendMessage` and `python.worker.ts::init` extractions.
8. **C-5 / C-10 / C-13** — Svelte route splits, in priority order.
9. **C-14** — chat store split (after verifying fan-in).
10. **Add ESLint complexity rules** (snippet above) so this doesn't regress.

Estimated total: **6–8 engineering days** for full remediation; the top eight items (severity ≥ 8) deliver **~80 % of the win in ~4 days**.
