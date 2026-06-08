# Code Duplication Audit — Haruspex

**Date:** 2026-06-08
**Scope:** Entire application — Rust backend (`src-tauri/src`, ~21.5k LOC) and SvelteKit/TypeScript frontend (`src`, ~27k LOC).
**Method:** Six parallel analysis passes (sidecar/inference layer, `fs_tools`, proxy/db/misc Rust, agent/stores TS, Svelte components/CSS, cross-cutting constants/schema). Every cited `file:line` was read; a sample of the highest-impact citations was independently re-verified with `grep` before inclusion.

### How to read this report

- **Type** uses the requested taxonomy: `exact` (copy-paste), `near` (same logic, different names/shape), `structural` (repeated pattern/boilerplate), `data` (repeated constant/config/schema).
- **Importance (1–10)** weighs value × (low risk) × recurrence. 10 = high-value, low-risk, recurs often. Cross-IPC schema drift (values that *must* agree across the Rust↔TS boundary with no compile-time guard) is weighted up because failures are silent and runtime-only.
- **Effort**: S ≈ <1h mechanical, M ≈ a focused half-day with multiple call sites, L ≈ multi-file refactor touching tests/architecture.
- Findings are grouped by area. A master ranked table is at the top. A concrete **Proposed Utilities Modules** section at the end collects the suggested homes (the "create a utilities module" deliverable).

> Scope honesty: percentages are line-based estimates from reading the code, not output of a clone-detection tool (no `jscpd`/`tokei --files` clone pass was run). Where a claim could not be fully confirmed it is marked **Unable to verify**.

---

## Master ranked findings

| ID | Finding | Type | Area | Sites | ~Dup LOC | Effort | Importance |
|----|---------|------|------|-------|----------|--------|------------|
| R1 | Sidecar library-path env setup (`LD_/DYLD_LIBRARY_PATH`/`PATH`) | exact/near | Rust sidecars | 5 | ~160→~30 | M | **9** |
| F1 | `runAgentLoop` turn-orchestration scaffolding (chat/shell/job/ephemeral) | structural/near | TS agent | 4 | ~120 | L | **8** |
| R2 | llama spawn + respawn block triplicated | near | Rust server | 3 | ~120→~40 | M | **8** |
| R8 | Streaming download w/ resume reimplemented instead of reused | near | Rust models | 2 | ~110 | M | **8** |
| X1 | Sidecar ports / `127.0.0.1` URLs re-hardcoded across IPC | config | Rust+TS | ~12 | n/a | M | **8** |
| F2 | `onToolStart`/`onToolEnd` SearchStep wiring | structural/near | TS agent | 3 | ~75 | M | **7** |
| F3 | Streaming `<think>` accumulation logic | near | TS agent | 3 | ~36 | S | **7** |
| R3 | doc-writer Tauri command boilerplate (resolve→guard→mkdir→write) | structural | Rust fs_tools | 6 | ~120 | M | **7** |
| X2 | fs_* tool names + arg keys declared in both TS schema and Rust cmd | schema | Rust+TS | 15+ | n/a | M/L | **7** |
| C1 | `JobRunView` vs `JobRunDetail` near-duplicate component | near/structural | Svelte | 2 | ~200 | M | **7** |
| C2 | Settings-section scaffolding CSS | exact/near | Svelte | 6–8 | ~110 | M | **7** |
| R9 | reqwest client construction repeated at every egress | structural | Rust proxy | 8 | ~56 | S | **7** |
| R4 | CommandEvent reader loop (whisper/tts) | near | Rust sidecars | 2(+1) | ~60 | M | 6 |
| R5 | Health-poll: tts reimplements `poll_health` + Ready/Error transition ×3 | near/structural | Rust sidecars | 3 | ~40 | M | 7 |
| R10 | ODF zip scaffolding (mimetype/manifest/meta.xml) | structural/data | Rust fs_tools | 3 | ~45 | M | 7 |
| R11 | Image-index construction (`pptx::ImageIndex` not reused) | near | Rust fs_tools | 4 | ~100 | M | 6 |
| F4 | Tool `execute()` invoke+error-wrap boilerplate | structural | TS tools | ~20 | ~60 | M | 6 |
| F5 | Fetch-failure prefix detection | near/data | TS agent | 3 | ~10 | S | 6 |
| C3 | Copy-to-clipboard w/ transient feedback | near | Svelte | 4 | ~48 | S | 6 |
| C4 | `formatBytes`/`formatSpeed` duplicated | exact/near | Svelte | 2 | ~18 | S | 6 |
| C5 | Status-pill CSS + hardcoded `#16a34a` | structural/data | Svelte | 3–4 | ~25 | M | 6 |
| C6 | Bespoke modals bypassing `Modal.svelte` | structural | Svelte | 3 | ~50 | M | 6 |
| X3 | proxy arg/result/`ProxyConfig` structs mirrored Rust↔TS | schema | Rust+TS | 4 pairs | n/a | M | 6 |
| X4 | `ServerConfig` ctx-size default disagrees Rust(16384)/TS(32768) | config | Rust+TS | 2 | n/a | S | 6 |
| R6 | `days_to_ymd` calendar math duplicated | near | Rust | 2 | ~15 | S | 6 |
| R12 | Natural-EMU sizing math (docx/odt) | near | Rust fs_tools | 2 | ~18 | S | 6 |
| R7 | `now_ms`/epoch helpers defined 3× | exact | Rust | 3 | ~12 | S | 5 |
| R13 | doc reader size-guard + `MAX_*_BYTES` redeclared | data/structural | Rust fs_tools | 4–5 | n/a | S | 5 |
| F6 | `err instanceof Error ? … : String(err)` idiom | exact | TS | ~18 | ~18 | S | 4 |
| F7 | WorkerManager timer-teardown trio | structural | TS | 5 | ~15 | S | 5 |
| R14 | sidecar `stop()` methods | near | Rust sidecars | 3 | ~36 | S | 5 |
| R15 | sidecar status/logs Tauri command boilerplate | exact/structural | Rust sidecars | 3 | ~40 | S | 4 |
| R16 | OOXML `[Content_Types].xml`/`.rels` (docx/pptx) | structural/data | Rust fs_tools | 2 | ~20 | M | 5 |
| R17 | `JobSummary` SELECT + row-map (`list_jobs`/`list_due_jobs`) | near | Rust db | 2 | ~35 | S | 5 |
| C7 | Generic `.btn` style block | near | Svelte | 5+ | ~50 | M | 5 |
| C8 | Webkit scrollbar CSS | exact | Svelte | 2 | ~24 | S | 4 |
| C9 | Timestamp/duration format helpers | near | Svelte | 3–4 | n/a | S | 4 |
| X5 | SearXNG default URL `http://localhost:8080` | data | Rust+TS | 4 | n/a | S | 4 |
| X6 | `FETCH_TIMEOUT` const defined 3× (same name, 10s/10s/30s) | config | Rust | 3 | n/a | S | 4 |
| R18 | proxy TTL-cache get/set pairs | near | Rust proxy | 2 | ~20 | S | 4 |
| R19 | ruff sidecar invocation | structural | Rust lint | 2 | ~20 | S | 4 |
| F8 | `fs_write_*` schema/description prose | data | TS tools | 3–4 | ~80% | M | 4 |
| R20 | `assert_odf_mimetype`/`read_zip_entry` test helpers | exact | Rust fs_tools | 2 | ~30 | S | 4 |
| X7 | Image-extension allow-list (TS regex vs Rust) | data | Rust+TS | 2 | n/a | S | 3 |
| R21 | db `#[tauri::command]` thin forwarders | structural | Rust db | 26 | ~150 | L | 3 |
| R22 | ODS/XLSX number-vs-string cell detection | near | Rust fs_tools | 2 | ~4 | S | 3 |

**Aggregate:** ~40 findings; roughly **1,800–2,000 lines** of duplicated/boilerplate code identified as collapsible, plus ~10 cross-language drift points with no compile-time guard. The single biggest mechanical win is the sidecar layer (R1–R5, R14–R15); the biggest architectural win is the agent turn-driver layer (F1–F5).

---

## A. Rust — sidecar / inference layer

### R1 — Library-path env setup duplicated across all three sidecars (+ twice more inside `server/mod.rs`)
- **Locations:** `server/mod.rs:188-217` (`LlamaServer::get_library_paths`) + env blocks at `:254-282`, `:462-482` (CPU fallback), `:571-591` (auto-restart); `whisper.rs:65-114`; `tts.rs:140-190`. (`grep` confirms **20** `LD_LIBRARY_PATH` references across the three files.)
- **Type:** exact (the 3-OS env blocks) / near (path collection)
- **Duplication:** ~95% similar; ~160 lines collapsible to ~30.
- **Extraction:** move `get_library_paths` to `sidecar_utils::library_paths(app)`, add `sidecar_utils::with_library_paths(cmd, app) -> Command` applying the per-OS var.
- **Fix:**
  ```rust
  // sidecar_utils.rs
  pub fn with_library_paths(cmd: Command, app: &AppHandle) -> Command {
      let mut parts = library_paths(app);
      #[cfg(target_os = "linux")]   let (var, sep) = ("LD_LIBRARY_PATH", ":");
      #[cfg(target_os = "macos")]   let (var, sep) = ("DYLD_LIBRARY_PATH", ":");
      #[cfg(target_os = "windows")] let (var, sep) = ("PATH", ";");
      let existing = std::env::var(var).unwrap_or_default();
      if !existing.is_empty() { parts.push(existing); }
      cmd.env(var, parts.join(sep))
  }
  ```
  Call site collapses to `let sidecar = sidecar_utils::with_library_paths(sidecar.args(&args), app);` (tts keeps its extra `ESPEAK_DATA_PATH` env at the call site).
- **Effort:** M — 5 call sites, `let mut sidecar` rebinding. **Importance: 9.**

### R2 — llama spawn + respawn triplicated within `server/mod.rs`
- **Locations:** `server/mod.rs:243-287` (initial), `:456-525` (CPU fallback), `:565-625` (auto-restart). Fallback vs auto-restart arms are ~90% identical (same mmproj lookup, `build_args`, `.map(env)`, `.and_then(spawn)`, `match` on result).
- **Type:** near. **Duplication:** ~85% between the two respawn arms; ~120 lines → ~40.
- **Extraction:** `async fn build_mmproj_args(app, inner, model_path) -> Vec<String>` + `fn spawn_llama(app, args) -> Result<(Receiver<CommandEvent>, CommandChild), String>` (wraps `sidecar("llama-server")` + R1 + `spawn`).
  ```rust
  fn spawn_llama(app: &AppHandle, args: &[String]) -> Result<(Receiver<CommandEvent>, CommandChild), String> {
      let cmd = app.shell().sidecar("llama-server")
          .map_err(|e| format!("Failed to create sidecar command: {e}"))?.args(args);
      sidecar_utils::with_library_paths(cmd, app).spawn()
          .map_err(|e| format!("Failed to spawn llama-server: {e}"))
  }
  ```
- **Effort:** M — the two arms differ in side-effects (banner/poller), so extract the spawn+args core only. **Importance: 8.**

### R4 — CommandEvent reader loop duplicated (whisper/tts)
- **Locations:** `server/mod.rs:312-646` (`spawn_output_reader`, specialized), `whisper.rs:129-163`, `tts.rs:215-256` (~90% identical Stderr/Stdout/Terminated arms; tts adds a `"listening"` sniff).
- **Type:** near. **Duplication:** ~30-line loop ×2 (+1 specialized that should stay).
- **Extraction:** `sidecar_utils::spawn_log_reader(name, rx, status, log, on_stdout: impl FnMut(&str))`. Leave llama’s reader (GPU classify + crash telemetry + fallback) untouched.
- **Effort:** M. **Importance: 6.**

### R5 — Health poll: `tts.rs` reimplements `poll_health`; Ready/Error transition repeated ×3
- **Locations:** canonical `sidecar_utils.rs:193-218` (`poll_health`), used by `server/mod.rs:648-686` and `whisper.rs:168-186`. **`tts.rs:264-298` hand-rolls the same `for _ in 0..60 { … sleep … client.get }` loop** instead of calling it — an active drift. The post-poll Starting→Ready / Starting→Error block repeats in mod.rs and whisper.
- **Type:** near (transition) / structural (tts re-impl).
- **Fix:** add an `accept_any: bool` (or status predicate) param to `poll_health` so tts can adopt it; add `drive_status_on_health(status, ok, name)`:
  ```rust
  pub async fn drive_status_on_health(status: &Arc<Mutex<SidecarStatus>>, ok: bool, name: &str) {
      let mut s = status.lock().await;
      if ok { if *s == SidecarStatus::Starting { *s = SidecarStatus::Ready; } }
      else if *s == SidecarStatus::Starting {
          error!("{name} health check timed out");
          *s = SidecarStatus::Error("Health check timed out".into());
      }
  }
  ```
- **Effort:** M (mod.rs uses generation-guarded status). **Importance: 7** (closes a real drift the helper was meant to prevent).

### R14 — Three near-identical sidecar `stop()` methods
- **Locations:** `server/mod.rs:688-704`, `whisper.rs:191-201`, `tts.rs:303-314`. whisper/tts ~90% identical.
- **Extraction:** `sidecar_utils::kill_child(child: &Mutex<Option<CommandChild>>, name) -> Result<(), String>`; whisper/tts call it then set status. llama’s combined-state struct doesn’t generalize — leave it. **Effort:** S. **Importance: 5.**

### R15 — Sidecar status/logs/clear command + `get_logs`/`clear_logs` bodies
- **Locations:** command wrappers `server/mod.rs:757-771`, `whisper.rs:280-296`, `tts.rs:516-525`; the struct methods `whisper.rs:207-215` and `tts.rs:320-328` are byte-identical.
- **Extraction:** `trait LogStore { fn buffer(&self) -> &LogBuffer; }` with default `get_logs/clear_logs`, **or** a `sidecar_log_commands!(get, clear, Ty)` macro. (Names are referenced in `lib.rs invoke_handler!`, so keep identical.) **Effort:** S. **Importance: 4.**

> Verified non-findings in this layer: `inference_queue.rs` already dedups removal via `reclaim()`; `inference.rs` `try_*` probes share `fetch_json`/`attach_auth` appropriately; `crash_telemetry.rs`, `log_classifier.rs`, `audio.rs` are self-contained.

---

## B. Rust — fs_tools (document/filesystem)

### R3 — Doc-writer Tauri command boilerplate (workdir → resolve → size-guard → refuse → spawn_blocking → mkdir → write)
- **Locations:** `docx.rs:299-337`, `odt.rs:222-261`, `pptx.rs:653-691`, `odp.rs:247-286`, `xlsx.rs:170-203` (`fs_write_ods`), `pdf_write.rs:479-518`; the mkdir+write tail is **byte-identical** in all 6; the head (`workdir_path`→`resolve_in_workdir`→`refuse_if_exists`) also in `download.rs:74-84`, `xlsx.rs:120-133`.
- **Type:** structural. **Duplication:** ~20 lines ×6 (~120).
- **Extraction (in `path.rs`):**
  ```rust
  pub(super) async fn write_bytes_to_workdir(resolved: &Path, bytes: &[u8]) -> Result<(), String> {
      if let Some(parent) = resolved.parent() {
          if !parent.exists() {
              tokio::fs::create_dir_all(parent).await
                  .map_err(|e| format!("Failed to create parent directory: {e}"))?;
          }
      }
      tokio::fs::write(resolved, bytes).await.map_err(|e| format!("Failed to write file: {e}"))
  }
  ```
  Each writer’s tail becomes `write_bytes_to_workdir(&resolved, &bytes).await?;`. **Effort:** M. **Importance: 7.**

### R10 — ODF zip scaffolding duplicated (odt/odp/ods)
- **Locations:** `odt.rs:62-139`, `odp.rs:42-116`, `xlsx.rs:28-72` (`build_ods`). The `mimetype` (STORED) + options block (~6 lines) and the `meta.xml` literal (`<meta:generator>Haruspex</meta:generator>`) are exact ×3; manifest prologue near-exact.
- **Extraction:** new `fs_tools/odf.rs` with `const ODF_META_XML`, `fn odf_options() -> (SimpleFileOptions, SimpleFileOptions)`, `fn write_odf_prologue(zip, mimetype, extra_manifest_entries)`. **Effort:** M. **Importance: 7.**

### R11 — Image-index construction (`pptx::ImageIndex` exists but isn’t reused)
- **Locations:** inline in `docx.rs:106-136`, `odt.rs:30-60`, `odp.rs:29-39`; the clean version is `pptx.rs:94-130` (`struct ImageIndex` + `build_image_index`). docx/odt loops are character-identical.
- **Extraction:** promote `ImageIndex`/`build_image_index` into `fs_tools/images.rs` as `pub(super)`, generic over `impl Iterator<Item=&String>`. Note a lifetime wrinkle: docx/odt parse owned `String` paths while pptx/odp borrow from slides — likely key the index by owned `String`. **Effort:** M. **Importance: 6.**

### R12 — Natural-EMU image sizing math (docx/odt)
- **Locations:** `docx.rs:122-130`+`:229-239`, `odt.rs:46-54`+`:168-176` (~95% identical).
- **Extraction (images.rs):**
  ```rust
  pub(super) fn fit_image_emu(nat_w: u64, nat_h: u64, frac: Option<f32>) -> (u64, u64) {
      let w = match frac { Some(f) => ((MAX_DOC_IMAGE_WIDTH_EMU as f32) * f).round() as u64,
                           None => nat_w.min(MAX_DOC_IMAGE_WIDTH_EMU) }.max(1);
      let h = (((nat_h as f64) * (w as f64) / (nat_w.max(1) as f64)) as u64).max(1);
      (w, h)
  }
  ```
  **Effort:** S. **Importance: 6.**

### R16 — OOXML `[Content_Types].xml` + `_rels/.rels` + per-ext `<Default>` loop (docx/pptx)
- **Locations:** `docx.rs:146-178`, `pptx.rs:146-195` (`write_content_types`/`write_root_rels`). Shared prologue + ext loop exact; `.rels` differs only in `Target=`.
- **Extraction:** new `fs_tools/ooxml.rs` with `content_types_prologue(exts) -> String` and `root_rels(target) -> String` (good home for pptx’s `write_part`/`Zip<'a>` too). **Effort:** M. **Importance: 5.**

### R13 — Reader size-guard + `MAX_*_READ/WRITE_BYTES` constants redeclared
- **Locations:** `MAX_*_READ_BYTES = 50*1_048_576` in `docx.rs:15`, `pdf_read.rs:15`, `xlsx.rs:10`, `absolute.rs:19`; `MAX_WRITE_BYTES = 10*1_048_576` in `docx.rs:16`, `odt.rs:14`, `pdf_write.rs:16`, `absolute.rs:20`. Guard body repeated ~5×.
- **Extraction (path.rs):** `pub(super) const MAX_DOC_READ_BYTES/MAX_DOC_WRITE_BYTES` + `async fn stat_within_limit(resolved, max, fmt) -> Result<(), String>`. **Effort:** S. **Importance: 5.**

### R20 — `assert_odf_mimetype` / `read_zip_entry` test helpers duplicated
- **Locations:** `mod.rs:182-209` (+`read_zip_entry_bytes` `:579-589`) and `xlsx.rs:318-342` — byte-identical. Move to `#[cfg(test)] fs_tools/test_support.rs`. **Effort:** S. **Importance: 4.**

### R22 — ODS/XLSX number-vs-string cell detection
- **Locations:** `xlsx.rs:89-100` and `:147-155` both `cell.parse::<f64>()`; the file comment (`:20-23`) says the two paths must agree. Extract `fn cell_as_number(&str) -> Option<f64>`. **Effort:** S. **Importance: 3** (small, but locks a stated invariant).

> Already well-factored: `escape_xml`, `parse_heading`, `parse_standalone_image_line`, `image_pixel_dimensions`/`px_to_emu`, `load_image_set`. `pptx` is the cleanest module and the natural home to extend (R10/R11/R16).

---

## C. Rust — proxy / db / models / shell / misc

### R8 — Streaming download (resume + progress + `.partial` rename) reimplemented instead of reused
- **Locations:** generic `models.rs:257-395` (`ModelManager::download_file`); `models.rs:951-1079` (`download_whisper_model`) re-implements the whole algorithm inline (~90% identical: Range header, 206 check, throttled `app.emit("download-progress", …)`, rename).
- **Fix:** have `download_whisper_model` call `download_file` (add a `subdir`/parent-mkdir and make it `pub`):
  ```rust
  pub async fn download_whisper_model(app: AppHandle, state: tauri::State<'_, ModelManager>) -> Result<String, String> {
      let p = state.download_file(&app,
          "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin",
          "whisper/ggml-base.en.bin", 148_000_000, "Downloading speech model").await?;
      Ok(p.to_string_lossy().to_string())
  }
  ```
  **Effort:** M. **Importance: 8.**

### R9 — reqwest client construction repeated at every egress
- **Locations:** `proxy/extract.rs:39-46`, `proxy/images.rs:51-58` & `:251-258`, `proxy/search.rs:31-40,165-173,299-307,551-554,634-637` (8 sites). Core: `apply_proxy(Client::builder().timeout(FETCH_TIMEOUT).redirect(limited(5)), proxy)?.build()…`.
- **Fix:**
  ```rust
  pub(crate) fn build_client(proxy: Option<&ProxyConfig>, redirects: bool, cookies: bool) -> Result<reqwest::Client, String> {
      let mut b = reqwest::Client::builder().timeout(FETCH_TIMEOUT);
      if redirects { b = b.redirect(reqwest::redirect::Policy::limited(5)); }
      if cookies   { b = b.cookie_store(true); }
      apply_proxy(b, proxy)?.build().map_err(|e| format!("Failed to create HTTP client: {e}"))
  }
  ```
  **Effort:** S. **Importance: 7.**

### R6 — Howard-Hinnant `days→Y/M/D` calendar math duplicated
- **Locations:** `app_log.rs:122-135` (`days_to_ymd`) and `integrations/email/imap_client.rs:192-215` (`unix_to_imap_date`, inlines the identical algorithm). (`grep` confirms `146097`/`719468` appear in exactly these two files.)
- **Fix:** make `app_log::days_to_ymd` `pub(crate)` (or move to `time_util`); imap_client calls it. **Effort:** S. **Importance: 6.**

### R7 — `now_ms`/epoch helper defined 3×
- **Locations:** `db.rs:1242-1247` (`chrono_now -> i64` millis), `proxy/stats.rs:215-220` (`now_ms -> i64`, identical), `app_log.rs:102-120` (seconds variant). Plus ad-hoc `…as_nanos()` temp-suffix calls in `lint.rs:80-90`, `shell/pty.rs:182-187`.
- **Fix:** one `crate::time_util::now_ms()`/`now_nanos()`. **Effort:** S. **Importance: 5.**

### R17 — `JobSummary` SELECT + row mapping (`list_jobs` / `list_due_jobs`)
- **Locations:** `db.rs:767-803` and `:924-960` — identical 10-column projection + identical `JobSummary { … }` closure; only WHERE/ORDER differ.
- **Fix:** `const JOB_SUMMARY_SELECT: &str` + `fn map_job_summary(&Row) -> rusqlite::Result<JobSummary>`. **Effort:** S. **Importance: 5.**

### R18 — proxy TTL-cache get/set pairs
- **Locations:** `proxy/mod.rs:138-180` — `get_cached_search`/`cache_search` vs `get_cached_fetch`/`cache_fetch` (~90% identical, generic over value type). Extract `cache_get<T: Clone>`/`cache_put<T>` over `&Mutex<HashMap<String, CacheEntry<T>>>`. **Effort:** S. **Importance: 4.**

### R19 — ruff sidecar invocation
- **Locations:** `lint.rs:29-55` and `:175-211` — same sidecar-get/args/output/fallback skeleton (differ in `--select`). Extract `async fn run_ruff(app, select, extra_args, target) -> Option<Vec<u8>>`. **Effort:** S. **Importance: 4.**

### R21 — db `#[tauri::command]` thin forwarders (26)
- **Locations:** `db.rs:1251-1494` — 26 wrappers, each `state.method(args)` with minor `as_deref()`/`&` adaptation. A `db_cmd!` macro is possible but readability-negative and must handle arg adaptation; **recommend leaving as-is** unless a broader codegen pass happens. **Effort:** L. **Importance: 3.**

### Search backends (medium-value, proxy/search.rs)
- **R-search-a (Importance 6):** Brave-API (`:596-621`) and SearXNG (`:669-690`) JSON→`SearchResult` loops are ~80% identical → `fn collect_json_results(items, snippet_key) -> Vec<SearchResult>`.
- **R-search-b (Importance 6):** DDG/Mojeek/Brave-HTML (`:26-84`, `:160-231`, `:294-369`) share recency-map + status-check + body-read + parse-and-warn → `async fn finish_html(resp, engine, anchors, parse)`.

> Verified non-findings: `model_registry()` repetition is acceptable table data (already uses `qwen_*_mmproj_filename()` helpers); `shell/integration.rs` is self-contained OSC-133 parsing.

---

## D. Frontend — agent engine / stores / sandbox (TypeScript)

### F1 — `withInferenceSlot → runAgentLoop` turn-orchestration scaffolding
- **Locations:** `stores/chat.svelte.ts:898-1011`, `shell/runShellTurn.ts:51-111`, `agent/jobs/runner.svelte.ts:324-349`, `agent/runEphemeralTurn.ts:61-95`. `runShellTurn.drive` and `runEphemeralTurn` are ~70% the same function (assemble messages → run loop → capture `finalText`/`runError` → rethrow). Shared `onUsageUpdate→updateContextUsage`, `onCallStats` latch, `onContextManaged→describeContextManaged`, streaming (F3), finalize (F-onComplete).
- **Type:** structural/near. **Extraction:** `$lib/agent/runTurn.ts` exporting `runTurnCore(loopOptions, { citations }): Promise<{ finalText }>` owning streaming/finalize/error; shell + ephemeral delegate; chat keeps its richer commit/diagnosis path on top. F3/F5/F2 fold in naturally. **Effort:** L. **Importance: 8** (core architectural win).

### F3 — Streaming `<think>` accumulation
- **Locations:** `chat.svelte.ts:962-975`, `runShellTurn.ts:92-104`, `runEphemeralTurn.ts:73-87` (verified present, ~95% identical).
- **Fix:**
  ```ts
  // $lib/agent/think-stream.ts
  export function appendStreamDelta(buf: string, delta: StreamChunk['delta']): string {
      if (delta.reasoning_content) { if (!buf.includes('<think>')) buf += '<think>'; buf += delta.reasoning_content; }
      if (delta.content) { if (buf.includes('<think>') && !buf.includes('</think>')) buf += '</think>\n\n'; buf += delta.content; }
      return buf;
  }
  ```
  **Effort:** S. **Importance: 7.**

### F2 — `onToolStart`/`onToolEnd` SearchStep wiring
- **Locations:** `chat.svelte.ts:930-961`, `shell.svelte.ts:402-420`, `runner.svelte.ts:239-273`. The running-step object (5 fields) is identical; the done-map ~90% identical.
- **Fix:** `newRunningStep(call): SearchStep` + `markStepDone(steps, call, result, thumb?, artifacts?, lint?): SearchStep[]` in `$lib/agent/loop`. **Effort:** M (three reactive container shapes; jobs uses `patchStep`). **Importance: 7.**

### F5 — Fetch-failure prefix detection
- **Locations:** `chat.svelte.ts:650-657` (`isFetchFailure`), `agent/loop/iteration.ts:740-743` (`fetchFailed`), `agent/tools/web.ts:154` (subset). Same 3 prefixes (`Failed to fetch`/`Research sub-agent failed`/`Paywalled:`).
- **Fix:** `FETCH_FAILURE_PREFIXES` + `isFetchFailureResult(s)` in `agent/tools/_helpers.ts`. **Effort:** S. **Importance: 6** (loop and citation filter must agree; they drift today).

### F4 — Tool `execute()` invoke + error-wrap boilerplate
- **Locations:** ~20 sites across `tools/web.ts`, `email.ts`, `fs-read.ts`, `fs-write.ts` — `catch (e) { return toolResult(toolInvokeError('cmd', e)); }`. `fs-read.ts`’s `fsRead`/`fsReadAbsolute` already prove the pattern.
- **Fix:** generalize into `invokeTool(command, payload, format?) : Promise<ToolExecOutput>` in `_helpers.ts`. **Effort:** M (several callers keep bespoke formatting). **Importance: 6.**

### F-onComplete — final-text extraction (`stripToolCallArtifacts`+`processCitations`+trim)
- **Locations:** `chat.svelte.ts:976-1008`, `runEphemeralTurn.ts:88-91`, `runShellTurn.ts:105-107`. Fix: `finalizeStreamText(raw, fetchedUrls=[]) -> ProcessedCitations` in `markdown.ts`. **Effort:** S. **Importance: 5.**

### F-vision — `visionSupported` probe
- **Locations:** `chat.svelte.ts:894-896`, `runner.svelte.ts:291-293` (identical). Fix: `isVisionSupported()` in `stores/settings.ts`. **Effort:** S. **Importance: 5.**

### F6 — `err instanceof Error ? err.message : String(err)`
- **Locations:** ~18 occurrences (chat/shell stores, `worker-manager.ts` ×4, `runner.svelte.ts`, `_helpers.ts`, `setup.svelte.ts`, sandbox). Fix: `errMessage(e): string` in `$lib/utils/error.ts`; have `toolInvokeError` call it. **Effort:** S. **Importance: 4.**

### F7 — WorkerManager timer-teardown trio
- **Locations:** `sandbox/worker-manager.ts:272-274,326-328,469-470,495-496,556-558`. Fix: `private clearTimers(p: PendingRun)` — also fixes the latent bug where some sites clear only a subset of the three timers. **Effort:** S. **Importance: 5.**

### F8 — `fs_write_*` schema/description prose
- **Locations:** `tools/fs-write.ts` — image-embed paragraph repeated at `:518,547,599`; `{path,content}` param object at `:480-494,512-522,542-549,594-601`. `SHEETS_SCHEMA`/`SLIDE_SCHEMA` already shared — extend the pattern with `IMAGE_EMBED_HELP` const + `textWriteParams(ext, desc)`. **Effort:** M. **Importance: 4.**

> Already good DRY extractions (preferred patterns / homes for fixes above): `_helpers.ts` (`labelArg`, `runSubAgent`, `proxyFetch`, `toolInvokeError`), `registry.ts`, `context-budget.ts`, the recently-extracted `computeMessageStats`. The `formatSandboxResultForChat` dup in `chat.svelte.ts:350-377` is author-annotated across a deliberate circular-import boundary — not re-reported.

---

## E. Frontend — Svelte components / CSS

### C1 — `JobRunView` vs `JobRunDetail` near-duplicate component
- **Locations:** `components/jobs/JobRunView.svelte` (~312 lines) vs `JobRunDetail.svelte` (~291). Identical `stepStatusLabel` switch (both `:38-51`); status/step/error CSS byte-identical (`JobRunView:130-310` vs `JobRunDetail:121-289`). ~75% overlap (~200 lines); one drives the live run, the other a persisted DB run.
- **Extraction:** presentational `jobs/JobStepCard.svelte` + shared `stepStatusLabel`/status CSS in `agent/jobs/`. **Effort:** M. **Importance: 7.**

### C2 — Settings-section scaffolding CSS
- **Locations:** identical 14-line `section`/`section:last-child`/`h2` block in `settings/SearchSection.svelte:194-210`, `FeedbackSection.svelte:72-88`, `GeneralSection.svelte:86-95`, `AgentSection.svelte:155-165`, `AudioSection.svelte:133-143`, `InferenceSection.svelte:193-203` (+ near variants in `EmailSection`, `ModelsSection`); `.hint` block in 7 files.
- **Extraction:** a `settings/SettingsSection.svelte` wrapper (`title` prop + children) **or** global `.settings-section`/`.settings-hint`. **Effort:** M. **Importance: 7.**

### C3 — Copy-to-clipboard with transient feedback
- **Locations:** `ChatMessage.svelte:38-48`, `ChatView.svelte:43-61`, `LogViewer.svelte:318,350-359`, `SearchStep.svelte:99-109` (~85% similar; timeouts 1200/1500ms).
- **Fix:**
  ```ts
  // $lib/utils/clipboard.svelte.ts
  export function createCopyAction(resetMs = 1500) {
      let state = $state<'idle' | 'copied' | 'failed'>('idle');
      return { get state() { return state; },
          async copy(text: string) {
              try { await navigator.clipboard.writeText(text); state = 'copied'; }
              catch { state = 'failed'; }
              setTimeout(() => (state = 'idle'), resetMs);
          } };
  }
  ```
  (SearchStep needs a keyed variant for its per-step map.) **Effort:** S. **Importance: 6.**

### C4 — `formatBytes`/`formatSpeed` duplicated
- **Locations:** `settings/ModelsSection.svelte:57-65` vs `routes/setup/+page.svelte:40-50`. `formatSpeed` byte-identical; `formatBytes` differs only in thresholds (setup version is the superset). Move both to `$lib/utils/format.ts`. **Effort:** S. **Importance: 6.**

### C5 — Status-pill CSS + hardcoded `#16a34a`
- **Locations:** `jobs/JobRunView.svelte:160-186`, `JobRunDetail.svelte:152-180`, `JobRunHistory.svelte`, `jobs/JobList.svelte:153-163`; `#16a34a` literal in 3 jobs files. Fix: global `.status-pill` + `.status-{running,succeeded,failed}` and a `--success` CSS var. **Effort:** M. **Importance: 6.**

### C6 — Bespoke modals bypassing `Modal.svelte`
- **Locations:** `StartupNoticeDialog.svelte`, `HelpModal.svelte`, `ImageViewerModal.svelte` each re-implement `position:fixed; inset:0; background:rgba(0,0,0,.5)` backdrop (vs the existing `Modal.svelte:42-61` used by `FileConflictModal`/`SandboxApprovalModal`). Extend `Modal` with `dismissable` (Esc + backdrop click) + optional header, migrate the three. **Effort:** M. **Importance: 6.**

### C7 — Generic `.btn` style block
- **Locations:** `settings/FeedbackSection.svelte:103-126`, `EmailSection.svelte:137-149`, `InferenceBackendForm.svelte:362-381`, `EmailAccountForm.svelte:347-359`, `StartupNoticeDialog.svelte:108-121`. Promote one to global `.btn`/`.btn-primary`/`.btn:disabled` (non-modal twin of the existing `ModalButton.svelte`). **Effort:** M. **Importance: 5.**

### C8 — Webkit scrollbar CSS (exact, ×2)
- **Locations:** `ConversationSidebar.svelte:167-179`, `jobs/JobRunHistory.svelte:180-195` — identical 12-line block. Fix: global `.thin-scroll::-webkit-scrollbar*`. **Effort:** S. **Importance: 4.**

### C9 — Timestamp/duration format helpers
- **Locations:** `jobs/JobRunHistory.svelte:26-46` (`formatWhen`/`durationLabel`), `JobRunDetail.svelte:53-56` (`formatWhen`), `routes/setup/+page.svelte:60-62` (`estimatedTime`), `LogViewer.svelte:137` (`formatTimestamp`). Consolidate into `$lib/utils/format.ts` (`formatDuration(ms)`, `formatRelativeTime(ts)`). **Effort:** S. **Importance: 4.**

### EmailAccountForm vs InferenceBackendForm (Importance 5)
- ~40–50% structural overlap (commit/untrack/test-button idioms + `.field`/`.hint`/`.test-row`/input CSS with `color-scheme: light dark`). Realistic win = shared form-control CSS (`.form-field`/`.form-hint`) + a `TestButton.svelte` for the probe row; full logic merge is L and not worth it. **Effort:** M.

> **Unable to verify (component CSS):** exact line counts for the per-section `.field`/input CSS in finding C2/forms were not diffed line-by-line beyond the `color-scheme: light dark` marker (confirmed in AudioSection, SearchSection, AgentSection, both forms). A full prettier-normalized diff of `<style>` blocks would confirm precise overlap.

---

## F. Cross-cutting — constants / config / schema (Rust ↔ TS drift)

These are weighted higher: the value must agree across the IPC boundary with **no compile-time guard** today.

### X1 — Sidecar ports / `127.0.0.1` URLs re-hardcoded across the boundary
- **Canonical:** `sidecar_utils.rs:21-23` (`ports::{LLAMA 8765, WHISPER 8766, TTS 3001}`) + private `localhost()` `:113-115`.
- **Re-hardcoded `8765` (verified):** `api.ts:108`, `stores/server.svelte.ts:48`, `stores/setup.svelte.ts:222`, `settings/InferenceSection.svelte:175`.
- **Re-hardcoded `127.0.0.1` (Rust, despite `localhost()`):** `server/mod.rs:87,654`, `whisper.rs:53,170,234`, `tts.rs:129,278,363`, `api.ts:111`.
- **Risk:** change the LLAMA port → TS client + UI silently disagree with the sidecar; chat breaks with no compile error.
- **Fix:** (Rust) `base_url(port)`/`health_url(port)` in `sidecar_utils`, route all `--host`/health through them. (TS) a single `src/lib/ports.ts` (`export const PORTS = { llama: 8765, whisper: 8766, tts: 3001 }`) consumed by `api.ts`/`server.svelte.ts`/`setup.svelte.ts`, **or** a `get_sidecar_ports()` Tauri command for a true single source. **Effort:** M. **Importance: 8.**

### X2 — fs_* tool names + arg keys declared in both TS schema and Rust command
- **Locations:** 15+ tools — each name exists as (a) a JSON-schema `name` shown to the model, (b) an `invoke()` string in `agent/tools/fs-read.ts`/`fs-write.ts`, (c) a Rust `#[tauri::command]` symbol (`fs_tools/text.rs:11,45`, `xlsx.rs:120`, `docx.rs:300,340`, `images.rs:191`, `odt.rs:223`, `pptx.rs:654`, `pdf_write.rs:480`, + `*_absolute`). Arg keys (`workdir`/`relPath`↔`rel_path`, `sheet`, `overwrite`, `sheets`) must agree via Tauri’s auto snake/camel conversion.
- **Risk:** rename a command/arg → tool breaks at runtime only (surfaces as `toolInvokeError`).
- **Fix:** (min) `src/lib/agent/tools/commands.ts` const map referenced by schema+invoke+tests; (ideal) `tauri-specta`/`ts-rs` codegen for typed command bindings. **Effort:** M (constants) / L (codegen). **Importance: 7.**

### X3 — proxy arg/result/`ProxyConfig` structs mirrored Rust↔TS
- **Locations:** `proxy_search` args `web.ts:68-76` ↔ `proxy/mod.rs:286-296`; `SearchResult` `web.ts:11-15` ↔ `proxy/mod.rs:50-55`; `ImageSearchResult` `web.ts:17-27`; **`ProxyConfig` `settings.ts:117-121` ↔ `proxy/mod.rs:57-70` — the Rust doc-comment literally says “Mirrors the ProxyConfig TS type”** (verified). Fix: `#[derive(specta::Type)]` → emit `src/lib/generated/proxy.ts`; delete the hand-written interfaces. **Effort:** M. **Importance: 6.**

### X4 — `ServerConfig` ctx-size default disagrees across the boundary
- **Locations:** Rust default `server/mod.rs:53-55` (`ctx_size: 16384`) + fallback `:745` (`unwrap_or(16384)`); TS user default `settings.ts:266` (`contextSize: 32768`, always passed e.g. `+layout.svelte:136`). The two defaults **don’t agree**; the Rust one is dead only as long as TS always supplies the value. Fix: make `start_server`’s `ctx_size` mandatory (drop the `16384` fallback) so there’s one default. `n_gpu_layers=99`/`flash_attn=true` are Rust-only (fine). **Effort:** S. **Importance: 6.**

### X5 — SearXNG default URL `http://localhost:8080`
- **Locations:** TS default `settings.ts:265`; Rust fallback `proxy/mod.rs:327` (`unwrap_or("http://localhost:8080")`); placeholders `SearchSection.svelte:103`, `InferenceBackendForm.svelte:172`. Fix: `export const DEFAULT_SEARXNG_URL` in `settings.ts`; drop the redundant Rust fallback (TS always supplies `instanceUrl`). Same pattern applies to TTS voice `af_heart` (`settings.ts:262` / `tts.rs:494`). **Effort:** S. **Importance: 4.**

### X6 — `FETCH_TIMEOUT` defined 3× (same name, divergent values)
- **Locations:** `proxy/mod.rs:22` (10s), `proxy/extract.rs:13` (10s, duplicate), `sandbox_fetch.rs:21` (30s). Confusing: identical name, different value. Fix: one `proxy/timing.rs` with distinct names (`WEB_FETCH_TIMEOUT`, `SANDBOX_FETCH_TIMEOUT`); `extract.rs` imports the shared one. **Effort:** S. **Importance: 4.**

### X7 — Image-extension allow-list (TS regex vs Rust)
- **Locations:** `fs-read.ts:12` `IMAGE_EXT_RE` (png/jpe?g/gif/webp/bmp/ico/tiff) vs `images.rs:48-60` `normalize_image_extension` (png/jpg/jpeg/gif only). Intentionally different (UI preview vs document-embed). **Recommendation:** add cross-referencing comments rather than merge. **Effort:** S. **Importance: 3.**

> **Documentation drift (not a Rust/TS dup, but worth fixing):** sandbox timeout — `settings.ts:276` `sandboxTimeoutSeconds: 60`, but `tools/sandbox.ts:50` prose says “default 30s” and `worker-manager.ts:56` `DEFAULT_TIMEOUT_MS = 30_000`. The user-facing prose contradicts the actual 60s default.

---

## Proposed utilities modules (the “create a utilities module” deliverable)

These are the suggested homes for the fixes above. **Recommendation: do not land these as unused stubs** (they’d trip `clippy`/eslint `no-unused`); create each module together with its first 1–2 migrations, in small PRs grouped as in the roadmap below. Concrete signatures:

### Rust

**`src-tauri/src/sidecar_utils.rs`** (extend existing) — addresses R1, R4, R5, R14, X1:
```rust
pub fn library_paths(app: &AppHandle) -> Vec<String>;                 // moved from server::get_library_paths
pub fn with_library_paths(cmd: Command, app: &AppHandle) -> Command;  // R1
pub fn base_url(port: u16) -> String;                                 // X1
pub fn health_url(port: u16) -> String;                               // X1
pub async fn kill_child(child: &Mutex<Option<CommandChild>>, name: &str) -> Result<(), String>; // R14
pub async fn drive_status_on_health(status: &Arc<Mutex<SidecarStatus>>, ok: bool, name: &str);  // R5
pub fn spawn_log_reader(name: &'static str, rx: Receiver<CommandEvent>,
    status: Arc<Mutex<SidecarStatus>>, log: LogBuffer, on_stdout: impl FnMut(&str) + Send + 'static); // R4
```

**`src-tauri/src/time_util.rs`** (new) — addresses R6, R7:
```rust
pub fn now_ms() -> i64;
pub fn now_nanos() -> u128;
pub fn days_to_ymd(days: i64) -> (i32, u32, u32);   // moved from app_log
```

**`src-tauri/src/fs_tools/path.rs`** (extend) — addresses R3, R13:
```rust
pub(super) const MAX_DOC_READ_BYTES: u64 = 50 * 1_048_576;
pub(super) const MAX_DOC_WRITE_BYTES: usize = 10 * 1_048_576;
pub(super) async fn write_bytes_to_workdir(resolved: &Path, bytes: &[u8]) -> Result<(), String>;
pub(super) async fn stat_within_limit(resolved: &Path, max: u64, fmt: &str) -> Result<(), String>;
```

**New `src-tauri/src/fs_tools/odf.rs`** (R10) and **`fs_tools/ooxml.rs`** (R16); extend **`fs_tools/images.rs`** with `build_image_index` (R11) + `fit_image_emu` (R12); **`#[cfg(test)] fs_tools/test_support.rs`** (R20).

**`src-tauri/src/proxy/` helpers**: `build_client` (R9), `collect_json_results` + `finish_html` (search), `cache_get`/`cache_put` (R18), `proxy/timing.rs` (X6).

### TypeScript

**`src/lib/utils/format.ts`** (new) — C4, C9: `formatBytes`, `formatBytesPerSecond`, `formatDuration(ms)`, `formatRelativeTime(ts)`.
**`src/lib/utils/error.ts`** (new) — F6: `errMessage(e: unknown): string`.
**`src/lib/utils/clipboard.svelte.ts`** (new) — C3: `createCopyAction(resetMs?)`.
**`src/lib/agent/think-stream.ts`** (new) — F3: `appendStreamDelta(buf, delta)`.
**`src/lib/agent/runTurn.ts`** (new) — F1 (+ folds F3, F-onComplete): `runTurnCore(loopOptions, { citations }): Promise<{ finalText }>`.
**`src/lib/agent/loop` step helpers** — F2: `newRunningStep(call)`, `markStepDone(steps, call, …)`.
**`src/lib/agent/tools/_helpers.ts`** (extend) — F4/F5: `invokeTool(command, payload, format?)`, `FETCH_FAILURE_PREFIXES`, `isFetchFailureResult(s)`.
**`src/lib/agent/tools/commands.ts`** (new) — X2: command-name string constants.
**`src/lib/stores/settings.ts`** (extend) — F-vision/X5: `isVisionSupported()`, `DEFAULT_SEARXNG_URL`.
**`src/lib/markdown.ts`** (extend) — F-onComplete: `finalizeStreamText(raw, fetchedUrls?)`.
**`src/lib/ports.ts`** (new) — X1: `PORTS` (ideally fed by a `get_sidecar_ports()` command).

### Global CSS (in the app stylesheet where `--border`/`--accent` live)
- `--success` variable; `.status-pill` + `.status-{running,succeeded,failed}` (C5)
- `.settings-section` / `.settings-hint` (C2)
- `.form-field` / `.form-hint` + form-input rule (forms)
- `.btn` / `.btn-primary` / `.btn:disabled` (C7)
- `.thin-scroll::-webkit-scrollbar*` (C8)

---

## Suggested remediation roadmap (small, reviewable PRs)

1. **Pure utilities (lowest risk, fast):** `time_util` (R6/R7), TS `format.ts`/`error.ts`/`clipboard.svelte.ts` (C3/C4/C9/F6), `appendStreamDelta` (F3), `isVisionSupported`/`finalizeStreamText`/`isFetchFailureResult` (F-vision/F5). Effort S each.
2. **Sidecar layer:** `with_library_paths` + `base_url`/`health_url` + `kill_child` + `drive_status_on_health`, then route tts through `poll_health` (R1/R5/R14/X1). One PR.
3. **fs_tools sharing:** `path.rs` write/stat helpers + `images.rs` index/sizing + `odf.rs` (R3/R10/R11/R12/R13). One PR.
4. **Agent turn core:** `runTurn.ts` + step helpers (F1/F2/F4) — the largest; isolate and lean on existing tests.
5. **CSS consolidation:** global `.status-pill`/`.settings-section`/`.btn`/`.thin-scroll` + `JobStepCard` (C1/C2/C5/C7/C8).
6. **Cross-IPC hardening:** ports single-source (X1), `commands.ts`/specta bindings (X2/X3), drop redundant Rust default fallbacks (X4/X5/X6).

Each step is independently shippable and test-covered by the existing `cargo test` / `vitest` suites. None of the proposed extractions changes runtime behavior except R5 (tts adopting `poll_health` — verify the “any-response = ready” semantics are preserved via the `accept_any` flag) and X4 (making `ctx_size` mandatory — confirm no caller omits it).
