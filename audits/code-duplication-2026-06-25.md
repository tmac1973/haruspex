# Code Duplication Audit — 2026-06-25

Scope: all first-party Rust (`src-tauri/src/**`) and TypeScript/Svelte (`src/**`)
source. Generated and vendored files, `#[cfg(test)]` modules, and `*.test.ts`
fixtures were excluded. Every finding below was confirmed by reading all the
sites it names; the six **high** findings were additionally spot-verified by
hand.

Severity rubric: **high** = ~20+ duplicated lines or core behavior that will
drift if one copy changes; **medium** = a block/pattern repeated 2–4 times;
**low** = a small repeated idiom; **trivial** = cosmetic/negligible.

## Summary

| Severity | Count | Areas |
|---|---|---|
| high | 6 | doc writers, sidecar download, search engines, store IPC, server probe |
| medium | 24 | proxy fetch, ODF/email helpers, agent loop, settings forms, stores, sandbox |
| low | 15 | constructors, audit helpers, CSS blocks, error idioms |
| trivial | 9 | one-liners / shared constants declared twice |

Cross-cutting themes:
- **Sidecar/HTTP plumbing** (Rust `proxy/*`, `models.rs`) repeats client-build,
  status-check, and download-resume logic across many functions.
- **Document writers** (`fs_tools/{docx,odt,odp,pptx,pdf_write,xlsx}.rs`) are
  structurally parallel — the same "walk paragraphs → classify → emit" and
  "write package media" loops re-coded per format.
- **Agent tool/loop glue** (`src/lib/agent/**`) repeats sampling-param mapping,
  inference-slot wrapping, and recovery-nudge pushes.
- **Store IPC + form probing** (`src/lib/stores/**`, settings/job forms) repeat
  the `invoke → reload → catch/log` and `probe → pick model → adopt caps`
  skeletons.

---

## High

### 1. `docx.rs` and `odt.rs` builders are near line-for-line parallel
- **Primary:** `src-tauri/src/fs_tools/docx.rs:219-240` (image-index + `natural_emu` precompute) and `docx.rs:312-341` (body dispatch loop)
- **Duplicates:** `src-tauri/src/fs_tools/odt.rs:69-90` (precompute, byte-identical apart from a comment); `odt.rs:187-208` (body dispatch loop)
- **What:** Identical precompute — `build_image_index(...)` then the `for path in &ordered_image_paths { image_pixel_dimensions → px_to_emu }` loop populating `natural_emu: HashMap<&String,(u64,u64)>`. The body loops share the same control flow: `parse_standalone_image_line` → `image_index.get` → `fit_image_emu` → emit image; else `parse_heading` + `escape_xml` + match heading level. Only the final emit calls differ (`docx_*_paragraph` vs `odt_*_paragraph`, odt adding an EMU→cm conversion).
- **Why unify:** A shared "walk paragraphs, classify image/heading/text, dispatch to a format-specific emitter" driver (emitters passed as a small trait or closures) collapses ~45 duplicated lines per file and guarantees the two formats can't drift in how they detect images/headings.

### 2. `fs_write_docx` / `fs_write_odt` / `fs_write_pdf` are essentially the same function
- **Primary:** `src-tauri/src/fs_tools/docx.rs:355-382` (`fs_write_docx`)
- **Duplicates:** `src-tauri/src/fs_tools/odt.rs:222-250` (`fs_write_odt`); `src-tauri/src/fs_tools/pdf_write.rs:497-525` (`fs_write_pdf`)
- **What:** Identical sequence: `workdir_path_for_write` → `resolve_in_workdir` → `content.len() > MAX_WRITE_BYTES` check with the same message → `refuse_if_exists` → `load_markdown_images` → `spawn_blocking` doing `content.lines().filter(non-empty).collect()` then the builder → `write_bytes_to_workdir`. docx/odt differ only in `build_docx`/`build_odt` and the task-failure string; pdf differs only in not filtering blank lines. The short 4-line preamble also recurs in `fs_write_pptx`, `fs_write_odp`, `fs_write_xlsx`, `fs_write_ods`.
- **Why unify:** A `write_markdown_doc(workdir, rel_path, content, overwrite, drop_blank_lines, build_fn)` helper removes ~25 duplicated lines per command and keeps the size-cap / overwrite-guard / image-preload behavior in one place.

### 3. Scrape-engine fetch skeleton (Mojeek / Brave-HTML / Startpage / Yahoo / DuckDuckGo)
- **Primary:** `src-tauri/src/proxy/search.rs:224-291` (`search_mojeek`)
- **Duplicates:** `search.rs:342-413` (`search_brave_html`); `search.rs:476-544` (`search_startpage`); `search.rs:622-689` (`search_yahoo`); near-variant `search.rs:100-158` (`search_duckduckgo`)
- **What:** Each function is the same end-to-end body: build client via `apply_proxy(Client::builder().timeout(FETCH_TIMEOUT).redirect(Policy::limited(5)))…build()` with identical `SearchFailure::other(...)` mapping; a `match recency` block; `format!` a URL; a `client.get(&url).header("User-Agent", USER_AGENT)…send()` with `classify_reqwest_err`; a non-2xx guard; `resp.text().await`; then `parse_X_html(...)` + `if results.is_empty() { warn_empty_scrape(...) }`. Startpage/Brave/Yahoo even share the same three-header GET at `372-382`, `498-508`, `644-654`. Only recency literals, URL, label, and needle list differ.
- **Why unify:** A single `scrape_engine(proxy, url, headers, label, needles, parse_fn)` helper (engine-specific extraction already lives in the `parse_*_html` fns) collapses ~40 duplicated lines per engine. Today a change to client config, header policy, status handling, or error classification must be edited in 4-5 places and silently drifts if one is missed.

### 4. Resumable file-download-with-progress reimplemented for whisper
- **Primary:** `src-tauri/src/models.rs:495-635` (`ModelManager::download_file`)
- **Duplicates:** `models.rs:971-1084` (`download_whisper_model` body)
- **What:** `download_whisper_model` re-implements the entire `download_file` algorithm inline: `existing_size` from `.partial`, `Range: bytes=N-` header, the `!success && != 206` status check, the `resumed`/`base_offset` 206-vs-200 logic, `resume_total_size(...)`, the append-vs-truncate `OpenOptions` branch, and the `bytes_stream` loop with per-chunk cancel check, `write_all`, and 100ms-throttled `download-progress` emit using `download_speed_bps`, then the `.partial`→final rename. ~90 lines duplicated (verified parallel at `530-624` vs `988-1060`).
- **Why unify:** Any change to resume semantics, the 206 corruption guard, or progress throttling has to be made twice or the whisper path drifts — it already diverges slightly (whisper verifies SHA *before* rename, `download_file` after). `download_whisper_model` could call `download_file` against a `whisper/` subdir.

### 5. Store IPC wrapper: `try { invoke; reload } catch { logDebug('jobs', …); return fallback }`
- **Primary:** `src/lib/stores/jobs.svelte.ts:261-343` (loadJobs, createJob, updateJob, deleteJob, getJob, listDueJobs, setJobNextDueAt, replaceJobSteps)
- **Duplicates:** `src/lib/stores/jobRuns.svelte.ts:56-201` (10 functions); `src/lib/stores/promptCatalog.svelte.ts:38-69` (3 functions)
- **What:** ~20 functions repeat the identical skeleton: `try { const x = await invoke<…>('db_…', args); [await reload();] return x } catch (e) { logDebug('jobs', '<name> failed', { …ids, error: String(e) }); return null/false/[]/0 }` — same `'jobs'` log category, same `error: String(e)`, same "reload list after mutation" pattern (22 `logDebug('jobs', …)` catch sites confirmed).
- **Why unify:** A `dbCall(channel, args, { fallback, log, reload })` helper collapses ~20 near-identical bodies to one-liners so the error-logging convention and the post-mutation refresh rule can't drift between the three job stores.

### 6. Remote-server probe handler (probe → pick model → adopt context/vision)
- **Primary:** `src/lib/components/InferenceBackendForm.svelte:170-237` (testConnection + onModelChange)
- **Duplicates:** `src/lib/components/jobs/JobEditor.svelte:226-281` (onModelChange + probeModel)
- **What:** Both invoke `probe_inference_server` with `{ baseUrl, apiKey }`, pick a model with the exact precedence `models.find(id===current) ?? models.find(loaded===true) ?? models[0]`, adopt the picked model's `context_size`/`vision_supported`, then fall back to server-level `default_context_size`. Both reset `probeError/probedModels` on URL change and declare duplicate local `ProbeResult`/model interfaces for the same Rust payload.
- **Why unify:** This is the load-bearing "what model/context did the server offer" logic and the copies have **already drifted** (InferenceBackendForm commits caps via `capabilityCommit`, JobEditor doesn't). A shared `probeAndPickModel(baseUrl, apiKey, currentId)` returning `{ models, pickedId, contextSize, vision }` keeps Settings and per-job overrides in sync.

---

## Medium

### 7. `wrap_to_width` and `wrap_styled_words` duplicate the greedy word-wrap algorithm
- **Primary:** `src-tauri/src/fs_tools/markdown_inline.rs:333-385` (`wrap_to_width`)
- **Duplicates:** `markdown_inline.rs:698-760` (`wrap_styled_words`)
- **What:** Identical greedy wrapper (`max_chars==0` early return; per-word `chars().count()`; hard-break words longer than `max_chars`; same `candidate` pack-or-flush; final flush). Only the element type differs — plain `String` words vs `StyledWord` retaining bold/italic.
- **Why unify:** One generic word-wrapper parameterized over the element (with "split long word" + "char-length" closures) so table wrapping and flowing PDF text can't diverge.

### 8. ODF manifest prologue duplicated across odt/odp/ods writers
- **Primary:** `src-tauri/src/fs_tools/odt.rs:108-115`
- **Duplicates:** `src-tauri/src/fs_tools/odp.rs:48-55`; `src-tauri/src/fs_tools/xlsx.rs:49-54` (in `build_ods`)
- **What:** The same `manifest:manifest` opening plus four fixed `file-entry` rows (root, content.xml, styles.xml, meta.xml), differing only by the root `media-type` MIME. `odf.rs` already factors out `ODF_META_XML`/`odf_options()` but not this prologue.
- **Why unify:** A `manifest_prologue(root_mime)` in `odf.rs` keeps all ODF manifests consistent and matches the existing partial extraction.

### 9. Directory-listing loop and sort comparator duplicated
- **Primary:** `src-tauri/src/fs_tools/path.rs:306-342` (`fs_list_dir`)
- **Duplicates:** `src-tauri/src/fs_tools/absolute.rs:147-180` (`fs_list_dir_absolute`); `MAX_DIR_ENTRIES` also declared twice (`path.rs:11`, `absolute.rs:23`)
- **What:** Same `read_dir` loop with `>= MAX_DIR_ENTRIES` truncation, same per-entry `DirEntry` collection, byte-identical `sort_by` comparator (dirs-first then case-insensitive name). Only difference: the workdir version skips dotfiles.
- **Why unify:** `collect_dir_entries(resolved, include_hidden) -> (Vec<DirEntry>, bool)` plus a single `MAX_DIR_ENTRIES`/comparator removes ~20 duplicated lines and keeps truncation/ordering in lockstep.

### 10. Plain fetch flow shared by `extract.rs` and `images.rs`
- **Primary:** `src-tauri/src/proxy/extract.rs:38-72` (`fetch_and_extract`)
- **Duplicates:** `src-tauri/src/proxy/images.rs:53-94` (`proxy_fetch_url_images`); client-build sub-block at `images.rs:254-261` (`proxy_image_search`)
- **What:** The `apply_proxy(Client::builder().timeout(FETCH_TIMEOUT).redirect(validating_redirect_policy()))…build()` block is byte-identical at `38-45`, `53-60`, `254-261`. The first two also share the GET + `!is_success()` guard + content-type sniff + `text().await`.
- **Why unify:** A `build_fetch_client(proxy)` (ideally `fetch_html(url, proxy)`) removes the **SSRF-critical** `validating_redirect_policy` wiring from three copies — if one copy forgets it, the redirect-SSRF hole reopens.

### 10b. Non-2xx status → `SearchFailure::Http` block
- **Primary:** `src-tauri/src/proxy/search.rs:981-986` (`search_searxng`)
- **Duplicates:** `search.rs:135-140`, `:262-267`, `:384-389`, `:510-515`, `:656-661`
- **What:** Identical 5-line `if !resp.status().is_success() { return Err(SearchFailure::new(Http, format!("<label> error: {}", resp.status()))) }`, differing only by label (6×).
- **Why unify:** A one-line `ensure_success(resp, label)?`. Overlaps finding 3 but also covers searxng/duckduckgo, worth a dedicated helper.

### 11. Char-count truncate-with-marker
- **Primary:** `src-tauri/src/integrations/email/parser.rs:236-248` (body cap in `parse_rfc5322`)
- **Duplicates:** `src-tauri/src/integrations/email/sub_agent.rs:39-51` (`prepare`)
- **What:** Both "if `chars().count() > N`, cut to first N chars and append a `[truncated…]` marker" — one via `char_indices`, the other char-by-char.
- **Why unify:** A `truncate_chars(s, n, marker)` next to the existing `text_util` truncation helpers; the hand-rolled char loops are easy to get wrong on multibyte input.

### 11b. Whitespace-collapse loop in `parser.rs`
- **Primary:** `src-tauri/src/integrations/email/parser.rs:116-134` (`make_snippet`)
- **Duplicates:** `parser.rs:149-163` (`html_to_plain`)
- **What:** Identical `last_was_space` run-collapsing loop ending in `out.trim().to_string()`; `make_snippet` only adds a length cap. (A third variant via `split_whitespace().join(" ")` exists in `proxy/extract.rs:232` and `search.rs:452-457` — different module, larger refactor.)
- **Why unify:** A `collapse_whitespace(iter)` helper; the two copies in `parser.rs` unify cleanly.

### 12. `JobSummary` SELECT + row mapping duplicated
- **Primary:** `src-tauri/src/db/jobs.rs:48-76` (`list_jobs`)
- **Duplicates:** `db/jobs.rs:271-302` (`list_due_jobs`)
- **What:** Identical 12-column SELECT (incl. the `step_count` subquery) and identical `query_map` closure with the same indices and `i64 != 0` bool decode. Only `WHERE`/`ORDER BY` differ.
- **Why unify:** A `const JOB_SUMMARY_COLS` + `fn row_to_job_summary(row)` so adding a field touches one place.

### 13. `shell_spawn` / `shell_restart` spawn body duplicated
- **Primary:** `src-tauri/src/shell/mod.rs:133-158` (`shell_spawn`)
- **Duplicates:** `shell/mod.rs:233-258` (`shell_restart`)
- **What:** Same sequence: `alloc_id()`, `resolve_spawn_target`, `pty::resolve_cwd()`, `integration_dir(&app)`, the 9-arg `Session::spawn(...)`, `insert(id, session)`, build `ShellSpawnResult`. `shell_restart` only prepends an old-session removal.
- **Why unify:** A private `spawn_session(...)` helper so the error-prone 9-arg call lives once.

### 14. `WalkBuilder` traversal + rel-path computation duplicated
- **Primary:** `src-tauri/src/code_tools.rs:437-450` (`code_grep` walk preamble)
- **Duplicates:** `code_tools.rs:586-599` (`code_glob` walk loop)
- **What:** Same `WalkBuilder::new(root).require_git(false).build()` loop, skip non-files, then `strip_prefix(&root_path)…to_string_lossy()` rel-path.
- **Why unify:** A `walk_files(root, |rel, path| …)` keeps the gitignore config and rel-path derivation (the search-correctness contract) aligned.

### 15. Truncate-and-spill overflow formatting (code.ts vs pty-exec.ts)
- **Primary:** `src/lib/agent/tools/pty-exec.ts:227-238` (`spillIfLarge`)
- **Duplicates:** `src/lib/agent/tools/code.ts:107-119` (inside `formatRunResult`)
- **What:** Both run `truncateCapturedOutput(text, RUN_OUTPUT_MAX_BYTES)`, return inline when it fits, else `invoke('code_write_overflow', …)` in try/catch and append an identical `Full output (… bytes) saved to … — read it with fs_read_text…` note. Line-for-line equivalent. code.ts already imports `RUN_OUTPUT_MAX_BYTES` from pty-exec but not `spillIfLarge`.
- **Why unify:** The overflow note/spill must stay identical for the model to re-read dropped output; code.ts should call the exported `spillIfLarge`.

### 16. Per-job inference-slot + ephemeral-turn wrapper repeated 3× in runner
- **Primary:** `src/lib/agent/jobs/runner.svelte.ts:431-460` (`runOneStep`)
- **Duplicates:** `runner.svelte.ts:615-662` (`runAuditSampleStep`); `runner.svelte.ts:700-724` (`verifyClusterTurn`)
- **What:** All three set `waitingForSlot: true`, call `withInferenceSlot` with the same `consumer`/`signal`/`onAdmitted` options, wrapping `runWithAutoApprove(() => runEphemeralTurn({ userMessage, workingDir, contextSize: jobContextSize(job), visionSupported: jobVisionSupported(job), backend: jobBackendOverride(job), signal, … }))`.
- **Why unify:** A `runJobTurn(job, runId, stepIndex, extraOpts)` helper collapses ~20 repeated lines and stops the three call sites drifting.

### 17. Sampling-param spread repeated 4×
- **Primary:** `src/lib/agent/loop/iteration.ts:533-538` (`runModelCall`)
- **Duplicates:** `iteration.ts:433-437` (`forceFinalToolCall`); `iteration.ts:479-483` (`streamFinalSynthesis`); `src/lib/agent/tools/_helpers.ts:104-108` (`runSubAgent`)
- **What:** The same five-field map (`temperature/top_p/top_k/min_p/presence_penalty`) from `getSamplingParams()` onto the request body, each paired with `max_tokens` + `chat_template_kwargs`.
- **Why unify:** A `samplingToRequest(sampling, maxTokens, templateKwargs)` helper so a new/renamed sampling field changes one place.

### 18. Assistant-echo + user-nudge push pair across recovery guards
- **Primary:** `src/lib/agent/loop/iteration.ts:751-762` (`tryNarrateRecovery`)
- **Duplicates:** `iteration.ts:661-662` (`tryContinueOnLength`); `:787-802` (`tryFileWriteRecovery`); `:832-836` (diversity gate); near-variant `:687-699` (`tryMalformedToolCall`, pushes `stripToolCallArtifacts(response.content)`)
- **What:** Each pushes `{ role:'assistant', content: response.content || '' }` then `{ role:'user', content: <nudge> }` and returns `'continue'`.
- **Why unify:** A `pushNudge(ctx, response, nudgeText)` standardizes the assistant-echo (making the malformed-case artifact strip an explicit, consistent choice).

### 19. Test-connection async skeleton (flag/error/ok reset around invoke)
- **Primary:** `src/lib/components/EmailAccountForm.svelte:84-113` (testConnection)
- **Duplicates:** `src/lib/components/InferenceBackendForm.svelte:170-216` (testConnection); `src/lib/components/jobs/JobEditor.svelte:239-281` (probeModel)
- **What:** All share `flag=true; error=null; try { await invoke(...) } catch (e) { error=String(e) } finally { flag=false }` with a `{flag ? '…ing' : 'label'}` button.
- **Why unify:** A `runWithStatus(setFlag, setError, fn)` helper (probe-specific body is the only real difference, covered in finding 6).

### 20. Download-progress flow (seed → listen → invoke → unlisten)
- **Primary:** `src/lib/components/settings/ModelsSection.svelte:72-120` (downloadModel + cancelDownload)
- **Duplicates:** `src/lib/stores/setup.svelte.ts:109-140` (startDownload + cancelDownload)
- **What:** Both seed the same `{ downloaded:0, total:0, speed_bps:0, stage:'Starting...' }`, attach `listen<DownloadProgress>('download-progress', …)`, `invoke('download_model', …)`, and `unlisten()` on both paths; both cancels call `invoke('cancel_download')` then null progress.
- **Why unify:** A `downloadModelWithProgress(modelId, onProgress)` centralizes the listener lifecycle (the easy place to leak an `unlisten`).

### 21. List-row keyboard activation idiom (`role=button tabindex=0` + Enter/Space)
- **Primary:** `src/lib/components/jobs/JobList.svelte:92-105`
- **Duplicates:** `src/lib/components/jobs/JobRunHistory.svelte:86-98`
- **What:** Identical clickable-row markup + `onkeydown` Enter/Space handler, plus near-verbatim `.rows`/`.empty`/`.title`/`.row` CSS.
- **Why unify:** A shared `use:activatable` action/snippet + shared row styling removes the easy-to-mis-handle a11y key branch.

### 22. Per-message turn-commit bookkeeping (steps/stats/stops keyed by index)
- **Primary:** `src/lib/stores/chat.svelte.ts:846-876` (`commitMessage`)
- **Duplicates:** `src/lib/stores/shell.svelte.ts:474-502` (`recordAssistantTurn`)
- **What:** Both append the assistant message and write `messageSteps[idx]`, `computeMessageStats(...)` → `messageStats[idx]`, and a non-`'complete'` stop → `messageStops[idx]`, keyed by the assistant index. Already share `computeMessageStats`.
- **Why unify:** An `attachTurnMetadata(target, index, steps, stats, stopReason)` keeps the keying identical (drift renders footers under the wrong message).

### 23. Agent-loop callback bundle (onToolStart/onToolEnd/onCallStats/onContextManaged)
- **Primary:** `src/lib/stores/chat.svelte.ts:947-990` (`buildAgentLoopCallbacks`)
- **Duplicates:** `src/lib/stores/shell.svelte.ts:565-575` (inline callbacks for `runShellTurn`)
- **What:** Identical `onToolStart` (push `newRunningStep`), `onToolEnd` (`markStepDone`), `onCallStats` (latch), `onContextManaged` (`describeContextManaged`).
- **Why unify:** A shared factory taking a `{ get/set searchSteps, setNotice, setStats }` sink.

### 24. Settings store-setter idiom in section components
- **Primary:** `src/lib/components/settings/ShellSection.svelte:8-48`
- **Duplicates:** `GeneralSection.svelte:13-22`; `AudioSection.svelte:31-39,57-65`; `SearchSection.svelte:21-50`; `AgentSection.svelte:16-44`
- **What:** Every section repeats `let x = $state(getSettings().x)` + per-field `setX/toggleX/saveX` calling `updateSettings({x})` (~30 setters). The clamp-and-persist sub-pattern (`Math.max(MIN, Math.min(MAX, …))` then persist) recurs at ShellSection:13-15,19-21,37-39,45-47 and AgentSection:41-43 (5 copies).
- **Why unify:** A `boundSetting(key)` helper + `clampInt(v,min,max)` util removes the mechanical repetition.

### 25. Per-request `respond` helper triplicated in WorkerManager
- **Primary:** `src/lib/sandbox/worker-manager.ts:594-607` (`handleSaveRequest`)
- **Duplicates:** `worker-manager.ts:636-644` (`handleDeleteRequest`); `worker-manager.ts:666-681` (`handleFetchRequest`)
- **What:** Each defines a local `respond(resp)` doing `if (!this.worker) return; this.worker.postMessage({ kind:'<x>_response', id, request_id, ...resp })`. Only `kind` + `resp` shape differ.
- **Why unify:** A `respondTo(msg, kind, resp)` removes the repeated null-guard and id/request_id plumbing.

### 26. PyProxy→Uint8Array/string coercion repeated across host bridges
- **Primary:** `src/lib/sandbox/python.worker.ts:1043-1066` (`_haruspex_save`)
- **Duplicates:** `python.worker.ts:953-969` (`_haruspex_emit_image`); `python.worker.ts:981-997` (`_haruspex_fetch`)
- **What:** The same "if `instanceof Uint8Array` copy; else if `.toJs` call+recheck; else reject" sequence to detach Pyodide-owned buffers before `postMessage`, hand-written 3×.
- **Why unify:** One `coerceToOwnedBytes(value)` helper — the WASM-detach behavior is subtle (DataCloneError), so three copies risk divergence.

### 27. `handleRun` / `handleInstall` share identical guard + catch/finally
- **Primary:** `src/lib/sandbox/python.worker.ts:1452-1460` + `1527-1537` (`handleRun`)
- **Duplicates:** `python.worker.ts:1539-1547` + `1562-1571` (`handleInstall`)
- **What:** Both open with the identical `if (!pyodide) { post({kind:'done', …'Pyodide is not loaded'}); return; }` guard, set `currentRunId`/`t0`, and close with the identical `catch → post done with error` + `finally { currentRunId = '' }`.
- **Why unify:** A `withRunContext(id, fn)` wrapper owns the guard, timing, error→`done`, and id cleanup.

### 28. `fromSession` / `fromLifetime` duplicate the `UnifiedStatsRow` field copy
- **Primary:** `src/lib/feedback.ts:173-195` (`fromSession`)
- **Duplicates:** `feedback.ts:197-219` (`fromLifetime`)
- **What:** Both map engine stats to `UnifiedStatsRow`; the 10 non-failure fields are copied identically, only `failures` is sourced differently (`failures_by_kind.http ?? 0` vs flattened `fail_http`).
- **Why unify:** One builder taking a `failures: Record<FailureKey, number>` arg; adding a field then touches one place.

---

## Low

### 29. Image media-write loop repeated across all four package writers
- **Primary:** `src-tauri/src/fs_tools/pptx.rs:331-339` (`write_media`)
- **Duplicates:** `docx.rs:292-301`; `odt.rs:166-172`; `odp.rs:215-225` (plus ODF image-manifest loops `odt.rs:123-131`, `odp.rs:57-68`)
- **What:** Each iterates the ordered image set doing `zip.start_file(format!("{prefix}image{N}.{ext}"))` + `write_all(&img.bytes)`, differing only by path prefix and index source (which are equal by construction of `build_image_index`).
- **Why unify:** A `write_media_files(zip, prefix, ordered, images, opts)` in `images.rs` centralizes the deterministic `image{N}.{ext}` naming the four writers must agree on.

### 30. `classify()` re-implements `parse_heading()`'s prefix matching
- **Primary:** `src-tauri/src/fs_tools/pdf_write.rs:35-46` (`classify`)
- **Duplicates:** `src-tauri/src/fs_tools/markdown_inline.rs:8-19` (`parse_heading`)
- **What:** `classify` re-does the `strip_prefix("# "/"## "/"### ")` ladder to attach font sizes instead of returning a level.
- **Why unify:** `classify` could call `parse_heading` and map level → (size, leading) so recognized heading prefixes live in one place.

### 31. TTS health-poll → status transition duplicates `drive_status_on_health`
- **Primary:** `src-tauri/src/sidecar_utils.rs:266-276` (`drive_status_on_health`)
- **Duplicates:** `src-tauri/src/tts.rs:189-198`
- **What:** The "if ok && Starting→Ready, else Starting→Error" transition already exists as a helper; the TTS `start` task re-codes it inline. (The server poller `server/mod.rs:578-588` is a third, generation-guarded variant that legitimately can't share.)
- **Why unify:** TTS can call the existing helper instead of drifting from it.

### 32. `NormalizedModel`-from-id construction + "N model(s)" note repeated
- **Primary:** `src-tauri/src/inference.rs:370-382` (`try_llama_server`)
- **Duplicates:** `inference.rs:411-423` (`try_openai_compat`); `inference.rs:656-676` (`parse_ollama_tags`); pluralization at `385-389`, `424-428`, `449-453`
- **What:** Three copies of the all-`None` `NormalizedModel { display_name: id.clone(), id, context_size, …None }` (only `context_size` varies) and three copies of the `"({} model{})"` pluralization.
- **Why unify:** A `NormalizedModel::basic(id, context_size)` constructor + `model_count_note(n)` helper.

### 33. Unavailable-GPU struct literal repeated across cfg branches
- **Primary:** `src-tauri/src/hardware.rs:135-142` (linux no-vulkan return)
- **Duplicates:** `hardware.rs:276-283` (windows); `hardware.rs:398-406` (fallback). Success tails also identical at `159-169` (linux) and `285-294` (windows).
- **What:** Three identical `GpuInfo { available:false, name:None, api:None, vram_mb:None, integrated:false }` literals plus two identical success tails.
- **Why unify:** `GpuInfo::unavailable()` (and a small `GpuInfo::vulkan(name, vram)`) removes the repeated field lists.

### 34. llama-server `stop()` re-implements `kill_child`
- **Primary:** `src-tauri/src/sidecar_utils.rs:194-201` (`kill_child`)
- **Duplicates:** `src-tauri/src/server/mod.rs:592-604` (`LlamaServer::stop`)
- **What:** `stop()` manually does `child.take()` → log → `child.kill()` → set `Stopped`, which is what `kill_child` (used by tts) does; interleaved with a `config.port` read.
- **Why unify:** Hoist the port read so `kill_child(&inner.child, "llama-server")` is reused.

### 35. `getSamplingParams` + `getChatTemplateKwargs` codeContext pair repeated 3×
- **Primary:** `src/lib/agent/loop/iteration.ts:604-608` (`runIteration`)
- **Duplicates:** `iteration.ts:416-420` (`forceFinalToolCall`); `iteration.ts:1051-1055` (`runMaxIterationsFinalSynthesis`)
- **What:** Identical `sampling = getSamplingParams({ codeContext: ctx.codeMode || isCodeContext(ctx.messages), thinkingEnabled })` + `templateKwargs = getChatTemplateKwargs(...)`.
- **Why unify:** A `samplingFor(ctx)` so the "is this a code turn" rule lives once.

### 36. `SEVERITY_RANK` map defined twice
- **Primary:** `src/lib/agent/jobs/auditCluster.ts:48-53`
- **Duplicates:** `src/lib/agent/jobs/auditReport.ts:37`
- **What:** Same `{ high:3, medium:2, low:1, trivial:0 }` ranking.
- **Why unify:** One exported constant prevents clustering-sort and report-sort diverging.

### 37. Cluster location-string formatting duplicated
- **Primary:** `src/lib/agent/jobs/auditReport.ts:40-44` (`formatLocation`)
- **Duplicates:** `src/lib/agent/jobs/auditPipeline.ts:159-164` (`loc` in `buildVerifyPrompt`)
- **What:** Both turn `file` + `lineStart`/`lineEnd` into `file` / `file:line` / `file:start-end`.
- **Why unify:** `buildVerifyPrompt` should reuse the existing `formatLocation`.

### 38. Sort tie-breakers duplicated between cluster and report comparators
- **Primary:** `src/lib/agent/jobs/auditReport.ts:60-67` (`bySeverityThenConsensus`)
- **Duplicates:** `src/lib/agent/jobs/auditCluster.ts:239-245` (inline `clusters.sort`)
- **What:** Identical secondary tie-breakers `a.file.localeCompare(b.file) || (a.lineStart ?? Infinity) - (b.lineStart ?? Infinity)`; only the primary key differs.
- **Why unify:** Share the location tie-break helper (partial — primary keys differ).

### 39. "Too many images pending" guard + `MAX_PENDING_IMAGES` constant
- **Primary:** `src/lib/agent/tools/fs-read.ts:349-355` (`fs_read_image`)
- **Duplicates:** `fs-read.ts:237-243` (`fs_read_pdf_pages`); `src/lib/agent/tools/shell-interactive.ts:230-236` (`shell_snapshot`)
- **What:** Each compares `ctx.pendingImages.length` against a per-file `MAX_PENDING_IMAGES` and returns a `toolError`. The cap is declared independently — and **inconsistently** (6 in fs-read, 4 in shell-interactive).
- **Why unify:** The cap is a shared inference-stability invariant (overflow "crashes llama-server" per comments) — it needs one source of truth, not two values.

### 40. `formatDuration` reimplemented locally
- **Primary:** `src/lib/utils/format.ts:22-30` (shared, already imported by `JobRunHistory.svelte:9`)
- **Duplicates:** `src/lib/stores/shell.svelte.ts:627-633`
- **What:** shell.svelte.ts defines its own `formatDuration(ms)` lacking the hours tier.
- **Why unify:** Import `$lib/utils/format`.

### 41. Radio "option card" + select/textarea field CSS repeated verbatim
- **Primary:** `src/lib/components/settings/SearchSection.svelte:224-307`
- **Duplicates:** `AgentSection.svelte:206-239`; `InferenceSection.svelte:245-280`; `GeneralSection.svelte:118-153`
- **What:** The selectable radio-card and form-field input/select/textarea styling duplicated ~20-35 CSS lines per component, only the class name changing.
- **Why unify:** Promote to shared global classes (repo already has design tokens + global `.thin-scroll`). CSS-only, hence low.

### 42. `chatCompletionStream` / `chatCompletion` request prelude
- **Primary:** `src/lib/api.ts:348-360` (`chatCompletionStream`)
- **Duplicates:** `api.ts:397-409` (`chatCompletion`)
- **What:** Same five-line prelude (`resolveChatEndpoint` → `buildRequestBody` → `reqId` → `logDebug('api', …)` → `sendChatRequest`), differing only by the `stream` flag/label.
- **Why unify:** A `prepareChatRequest(options, signal, port, stream)`; low because the heavy lifting is already factored — only glue repeats.

### 43. Inline `err instanceof Error ? err.message : String(err)` while `errMessage` util exists
- **Primary:** `src/lib/sandbox/python.worker.ts:1209` (`init`)
- **Duplicates:** `python.worker.ts:1299, 1401, 1484, 1507, 1528, 1563`
- **What:** The exact ternary re-inlined 7× though `$lib/utils/error`'s `errMessage()` exists (and `worker-manager.ts` already uses it).
- **Why unify:** Import and use `errMessage` for consistency.

---

## Trivial

- **Recency→param `match` blocks** — `src-tauri/src/proxy/search.rs:116-123, 239-246, 357-364, 904-911`. Same shape, but per-engine literals differ; only a helper taking the four suffixes unifies it.
- **JSON parse + `Parse` map_err** — `proxy/search.rs:937-942` and `:988-993`. Identical `resp.json().await.map_err(Parse …)`.
- **IMAP date `format!` idiom** — `src-tauri/src/integrations/email/imap_client.rs:208` and `:234-236`. A `format_imap_date(d,m,y)` helper.
- **`SELECT INBOX` map_err** — `imap_client.rs:128-131, 262-265, 351-354`. Same `select("INBOX")…map_err`.
- **`codeRoot(ctx)` "no working directory" guard** — `src/lib/agent/tools/code.ts:157-158, 286-287, 344-345`.
- **Shell-mode read dispatch ternary** — `src/lib/agent/tools/fs-read.ts:176-178` and `:207-209`.
- **`<think>…</think>` strip regex** — `src/lib/agent/loop/iteration.ts:236` and `src/lib/agent/compaction.ts:36,62`.
- **`PROTECTED_TURNS = 4`** declared in both `src/lib/agent/context-budget.ts:38` and `src/lib/agent/compaction.ts:5`.
- **AbortError rethrow** `if (e instanceof DOMException && e.name === 'AbortError') throw e;` — `web.ts:169`, `email.ts:253`, `code.ts:184` (+ equality variants in `runner.svelte.ts:470,590`). Idiomatic.

---

## Notes on what was checked and found clean

- **Sidecar spawn/health/port-wait** — already well-centralized in `sidecar_utils`
  (`with_library_paths`, `poll_health`, `kill_process_on_port`,
  `spawn_log_reader`, `kill_child`); only the small leftovers in findings 31/34 remain.
- **User-agent rotation** — a single `USER_AGENT` const, already centralized.
- **Email MIME parsing** — single parse path; only the whitespace/truncation
  helpers (11/11b) duplicate.
- **`loop.ts` vs `loop/iteration.ts`** — `loop.ts` is a thin delegating driver; no copied logic.
- **Tool error/result shaping** — `toolError`/`toolResult`/`fsRead`/registry dispatch already de-duplicate this.
- **Quant/model-tier lookups** — centralized (`hardware::tier_lookup` + `QUANT_BY_VRAM_MB`, `models::recommended_context_for`).
- **`platform.rs` per-OS modules** — genuinely distinct implementations, not copy-paste.
- **`worker-dispatch.ts` / `protocol.ts`** — the shared abstractions that already de-duplicate settle logic.
