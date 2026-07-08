# Code Duplication Audit — 2026-07-08

Scope: all first-party TypeScript (`src/lib/**`, `src/routes/**`), Svelte components
(`src/**/*.svelte`), and Rust (`src-tauri/src/**`). Excluded: `*.test.ts`, `#[cfg(test)]`
modules, generated bindings (`src/lib/ipc/gen/*`), vendored code.

Method: token-based clone detection (jscpd, min 50 tokens / 5 lines) over TS + Rust,
plus three manual sweeps (Rust backend, TS lib, Svelte components — jscpd does not
tokenize `.svelte`). Every finding below was verified by reading the cited code.
Findings marked **✅ fixed in this audit** were remediated in the working-tree change
that accompanies this report (see "Utilities module" at the end).

## Measured duplication (jscpd)

| Language   | Files | Lines  | Clones | Duplicated lines | Duplicated tokens |
|------------|-------|--------|--------|------------------|-------------------|
| Rust       | 75    | 25,975 | 52     | 456 (**1.76 %**) | 3,661 (2.40 %)    |
| TypeScript | 97    | 21,156 | 9      | 95 (**0.45 %**)  | 761 (0.85 %)      |
| **Total**  | 172   | 47,131 | 61     | 551 (**1.17 %**) | 4,422 (1.83 %)    |

Svelte components are not covered by these numbers; the manual sweep (findings S1–S11)
estimates a further **~400–500 duplicated lines**, almost all of it repeated `<style>`
blocks — proportionally the most duplicated layer of the app.

Context: this is a **healthy baseline** (industry heuristics treat <3–5 % as good).
The 2026-06-25 audit's remediation sweep (`e3123e8`…`673c311`) removed most of the
big clones: document writers, scrape engines, download-resume, `dbCall` store IPC,
probe/model-pick, sandbox worker internals. Of the 52 remaining Rust clones, 5 are
`#[cfg(test)]`-only and several are intentional platform polymorphism (won't-fix).
The new code since then (PRs #160–#168, notably OpenRouter #168) reintroduced a
handful of small duplications, called out below.

Severity scale: **importance N/10** — weighted by drift risk (will the copies silently
diverge and cause a bug?) more than raw line count. Effort: S ≤ ½ h, M ≤ 2 h, L ≥ ½ day.

---

## Part 1 — TypeScript (`src/lib`)

### T1 · 8/10 — OpenAI SSE stream parsing implemented twice · NEAR DUPLICATE
- **Sites:** `src/lib/api.ts:315-431` (`parseSSELine` + `parseSSE`) vs
  `src/lib/stores/setup.svelte.ts:303-352` (`readSseContent` + `parseSseDelta`)
- **What:** the setup wizard reimplements the full SSE reader — `getReader()` /
  `TextDecoder` / `buffer.split('\n')` / `buffer = lines.pop()` loop, the `data:` prefix
  + `slice(6)` + `[DONE]` sentinel + `JSON.parse` + `choices[0].delta` extraction. The
  copy is a strictly weaker subset (drops tool_calls/usage/error handling). ~40 lines,
  ≈ 2 × the protocol-critical logic. This is the highest-value open item: a protocol
  quirk fixed in one copy (e.g. multi-line `data:` frames, CRLF) will not fix the other.
- **DRY fix:** export the low-level line reader from `api.ts` and rebase both parsers on it:

```ts
// api.ts (new export)
export async function* readSseData(response: Response): AsyncGenerator<string> {
	const reader = response.body!.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split('\n');
		buffer = lines.pop() ?? '';
		for (const line of lines) {
			if (!line.startsWith('data: ')) continue;
			const data = line.slice(6);
			if (data === '[DONE]') return;
			yield data;
		}
	}
}
```

  `parseSSE` keeps its rich `StreamChunk` mapping on top; `setup.svelte.ts` deletes
  `readSseContent`'s reader loop and keeps only its `content || reasoning_content`
  delta pick. **Effort: M.**

### T2 · 7/10 — Sandbox result formatter duplicated verbatim · EXACT · ✅ fixed in this audit
- **Sites (were):** `src/lib/agent/tools/sandbox.ts:15-42` (`formatResult`) vs
  `src/lib/stores/chat.svelte.ts:377-413` (`formatSandboxResultForChat`)
- **What:** 28-line byte-identical formatter (Error/Stderr/Stdout/Result/artifacts
  directive/Notes/duration). The copy existed to avoid a chat-store → agent-tools
  circular import, and carried a literal "Keep in sync with formatResult" comment.
- **Fix applied:** extracted to a leaf module `src/lib/sandbox/format-result.ts`
  (`formatSandboxResult(r: SandboxRunOutput)`, no imports → no cycle); both call sites
  now import it. −40 net lines.

### T3 · 6/10 — Abort/cancel classification repeated 10+ times · STRUCTURAL · ✅ fixed in this audit
- **Sites (were):** `runner.svelte.ts:533,1230,1308` (full 2-line normalize),
  plus bare `e instanceof DOMException && e.name === 'AbortError'` tests in `api.ts:393`,
  `chat.svelte.ts:1110`, `setup.svelte.ts:286`, `tools/code.ts:172`, `tools/web.ts:169`,
  `tools/email.ts:253`, `loop/iteration.ts:459`.
- **Fix applied:** `isAbortError(e)` + `normalizeAbort(e)` added to `src/lib/utils/error.ts`;
  all 10 sites migrated. (Sites that *construct* `new DOMException('Aborted', 'AbortError')`
  are unchanged — different concern.)

### T4 · 5/10 — WorkerManager reject-all-pending + triple timer-clear · EXACT
- **Sites:** `src/lib/sandbox/worker-manager.ts:327-334` (`onWorkerError`) ≡ `565-572`
  (`respawn`); the inner `if (p.timer) clearTimeout(p.timer); if (p.installWatchdog) …;
  if (p.terminateFallback) …;` triple also standalone at `295-297`, `482-483`, `500`,
  `508-509` (~6 sites).
- **DRY fix:** two private methods on the class:

```ts
private clearTimers(p: Pending): void {
	if (p.timer) clearTimeout(p.timer);
	if (p.installWatchdog) clearTimeout(p.installWatchdog);
	if (p.terminateFallback) clearTimeout(p.terminateFallback);
}
private rejectAllPending(reason: Error): void {
	const pending = Array.from(this.pending.values());
	this.pending.clear();
	pending.forEach((p) => { this.clearTimers(p); p.reject(reason); });
}
```
  A forgotten timer-kind in one copy leaks a timeout that later rejects a *new* request
  with a stale error — worth closing. **Effort: S.**

### T5 · 5/10 — Job interfaces re-list the same base fields 3× · SCHEMA
- **Sites:** `src/lib/stores/jobs.svelte.ts:34-47` (`JobSummary`), `111-123`
  (`JobWithSteps`), `126+` (`JobInput`) — `name, description, working_dir,
  auto_approve_tools, job_type, schedule_kind, schedule_config, next_due_at` (+ id /
  timestamps) hand-repeated; they mirror Rust structs across the untyped IPC boundary.
- **DRY fix:** `interface JobCore { … }` + `JobSummary extends JobCore`,
  `JobWithSteps extends JobCore`, `JobInput extends JobCore`. Longer term these belong in
  generated bindings (`src/lib/ipc/gen/`) like the other Rust-mirrored types — blocked on
  the ts-rs/specta decision (see `audits/x2-x3-typed-ipc-proposal.md`). **Effort: S** (extends),
  **L** (codegen).

### T6 · 4/10 — Artifact protocol message shape declared twice · SCHEMA
- **Sites:** `src/lib/sandbox/protocol.ts:98-106` (the `kind: 'artifact'` arm of
  `WorkerToMain`) vs `src/lib/sandbox/worker-manager.ts:87-92` (`toArtifact` param
  re-declares the same `{mime, payload, alt?, truncated?, interactive?}` inline).
- **DRY fix:** export `interface ArtifactMessage {…}` from `protocol.ts`, use
  `{ kind: 'artifact'; id: string } & ArtifactMessage` in the union and
  `toArtifact(msg: ArtifactMessage)`. **Effort: S.**

### T7 · 4/10 — Shell store submit preamble duplicated · NEAR
- **Sites:** `src/lib/stores/shell.svelte.ts:341-357` (`submitChatMessage`) vs
  `429-446` (`submitRecentCommands`); partial third in `tryFlushWatchNotifications:401-421`.
  Shared: isSubmitting/activeSession guards → `fetchLiveContext()` →
  `shell_get_recent_commands` fetch with the same clamp. ~12 lines × 2.
- **DRY fix:** private `#requireSession()` + `#loadRecent(limit)` on the store. Extract
  carefully — the watermark logic around these lines is subtle. **Effort: M.**

### T8 · 4/10 — System-prompt date block spelled 3× · EXACT · ✅ fixed in this audit
- **Sites (were):** `src/lib/shell/system-prompt.ts:38-43` and `103-108`,
  `src/lib/agent/system-prompt.ts:19-24` — identical 6-line `toLocaleDateString` call.
- **Fix applied:** `formatTodayLong()` added to `src/lib/utils/format.ts`; all three
  builders now call it. *Still open (minor):* the shell builders also share the
  env/cwd/history `sessionBlock` join (~6 lines × 2) — a local `buildSessionBlock(opts)`
  would finish the job, but the label strings intentionally differ; verify before unifying.

### T9 · 3/10 — OpenRouter attribution headers hardcoded twice · DATA · ✅ fixed in this audit
- **Sites (were):** `src/lib/openrouter.ts:34-37` exports
  `OPENROUTER_ATTRIBUTION_HEADERS`, but `src/lib/api.ts:254-257`
  (`applyOpenRouterAttribution`) re-hardcoded both headers; the const had zero importers.
- **Fix applied:** `api.ts` now does `Object.assign(headers, OPENROUTER_ATTRIBUTION_HEADERS)`.
  *Still open (trivial):* the repo slug `tmac1973/haruspex` is independently hardcoded in
  `src/lib/feedback.ts:26` — fold into a shared const if it ever changes.

### T10 · 2/10 — Non-2xx error-body read repeated 3× · EXACT · ✅ fixed in this audit
- **Sites (were):** `api.ts:401`, `openrouter.ts:199`, `openrouter.ts:223` —
  `await res.text().catch(() => 'Unknown error')`.
- **Fix applied:** `readErrorText(res)` in new `src/lib/utils/http.ts`; all 3 migrated.

### T11 · 2/10 — Inline `sleep` re-implemented 4× · EXACT · ✅ fixed in this audit
- **Sites (were):** local const in `tools/shell-interactive.ts:40`; inline
  `new Promise((r) => setTimeout(r, …))` in `audio/voiceCapture.svelte.ts:102`,
  `stores/setup.svelte.ts:201`, `tools/pty-exec.ts:119`.
- **Fix applied:** `sleep(ms)` in new `src/lib/utils/async.ts`; all 4 migrated.

### T12 · 2/10 — Qwen non-thinking sampling block duplicated · DATA
- **Sites:** `src/lib/stores/settings.ts:826-835` (`qwen3.5`) vs `837-846`
  (`qwen3.6-27b`) — identical `nonThinking` objects; only `thinking.general.presence_penalty`
  differs. This is an intentional data table (the comment above documents it), so drift
  risk is low. **DRY fix (optional):** hoist `const QWEN_NONTHINKING = {…} as const` and
  spread. **Effort: S.**

### T13 · 1/10 — Legacy settings key literal · DATA
- `src/lib/stores/chat.svelte.ts` hardcodes `'haruspex-settings'` in the one-time
  working-dir migration; `settings.ts:370` owns the same string as `SETTINGS_KEY`.
  Migration-only code — fine to leave; export the const if it's ever touched again.

**Not duplication (checked, clean):** `src/lib/ports.ts` is the single source for
8765/8766/3001 — no stray hardcoded sidecar ports; localStorage keys are single-owner
consts; `api.ts` vs `openrouter.ts` do **not** duplicate chat-request building
(openrouter.ts is catalog/key-status only). jscpd's `code.ts:266↔324` hit is
tool-registration scaffold around genuinely different tools — false positive.

---

## Part 2 — Svelte components (`src/**/*.svelte`)

The biggest duplication mass in the app is repeated `<style>` blocks. Existing shared
primitives (`Modal.svelte`, `ModalButton.svelte`, `actions/activatable.ts`,
`utils/clipboard.svelte.ts`, global `.settings-section` / `.status-pill` / `.thin-scroll`
in `routes/+layout.svelte`) are used by most call sites — the gap is that **no global
`.btn`, `.field`, `.hint`, spinner, or error-box class exists**, so every form re-declares
them.

### S1 · 7/10 — `.btn` + `.field` CSS re-declared in ~10 components · STRUCTURAL
- **Sites:** `.btn/.btn-primary/.btn-danger/.btn-small/:disabled` cluster in
  `InferenceBackendForm.svelte:587-606`, `settings/OpenRouterForm.svelte:409-432`,
  `settings/ApiKeysSection.svelte:146-184`, `StartupNoticeDialog`, `settings/EmailSection`,
  `settings/InferenceSection`, `settings/FeedbackSection`, `settings/ModelsSection`,
  `settings/AudioSection`, `ModalButton`. `.field` blocks in `InferenceBackendForm:464-485`,
  `OpenRouterForm:310-329`, `EmailAccountForm:269-294`, `jobs/JobEditor`.
  `.btn-primary` is byte-identical across most. ~40–50 lines × ~10 files ≈ **the single
  largest duplicated block in the repo (~400 lines)**.
- **DRY fix:** promote to the `:global` block in `+layout.svelte` (exact pattern already
  used for `.settings-section`):

```css
:global(.btn) { padding: 0.45rem 0.9rem; border: 1px solid var(--border);
	border-radius: 6px; background: var(--bg-secondary); color: var(--text-primary);
	cursor: pointer; font-size: 0.85rem; }
:global(.btn:disabled) { opacity: 0.5; cursor: default; }
:global(.btn-primary) { background: var(--accent); color: white; border-color: var(--accent); }
:global(.btn-danger) { color: var(--error-text); border-color: var(--error-border); }
:global(.field) { display: flex; flex-direction: column; gap: 0.3rem; }
:global(.field label) { font-size: 0.8rem; color: var(--text-secondary); }
```
  then delete the local copies (values differ by a pixel here and there — unify to one).
  Mechanical but wide; do it one component family at a time. **Effort: L (spread over PRs).**

### S2 · 7/10 — Probe/catalog state machine triplicated across forms · NEAR
- **Sites:** `InferenceBackendForm.svelte:163-246` (`testConnection`/`onModelChange`/
  `capabilityCommit`), `settings/OpenRouterForm.svelte:50-144` (`loadCatalog`/`testKey`/
  `onModelSelect`), `jobs/JobEditor.svelte:300-370` (`probeModel`/`loadOpenRouterModels`/
  `selectOpenRouterOverride`) — the third re-implements the probe → pick model →
  adopt context/vision flow the first two already do (~80–100 lines × 3). The June sweep
  extracted `pickProbedModel` + shared probe types (`df7e8a1`), but OpenRouter (#168)
  added a second axis (catalog vs probe) and JobEditor now re-glues both.
  `commit(partial) = onConfigChange({...config, ...partial})` and `onContextChange`/
  `onVisionToggle` are near-identical in the two forms.
- **DRY fix:** a `useInferenceProbe`-style helper module (`src/lib/inferenceProbe.ts`
  already exists — extend it) owning `{probing, error, models, pick, adoptCaps}` state;
  the three components render it. This is load-bearing logic that has **already drifted
  once** (the June audit's finding 6). **Effort: L.**

### S3 · 6/10 — `.toggle-row` markup + CSS duplicated in 4 components · STRUCTURAL
- **Sites:** `InferenceBackendForm.svelte:382-421` + `608-630` ≡
  `OpenRouterForm.svelte:251-286` + `378-407` (the "supports vision" and "allow parallel
  inference" toggles are near-verbatim, markup *and* copy); `.toggle-row` CSS also in
  `settings/AgentSection.svelte`, `settings/AudioSection.svelte`. ~43 lines × 2 + CSS × 2.
- **DRY fix:** a `ToggleField.svelte` (`{checked, onchange, title, description}`) plus a
  global `.toggle-row` class; both forms' vision/parallel toggles collapse to two
  `<ToggleField>` uses. **Effort: M.**

### S4 · 4/10 — Modal chrome reimplemented outside `Modal.svelte` · STRUCTURAL
- **Sites:** `ImageViewerModal.svelte:16-40` (own Escape wiring + backdrop + close-button
  CSS `42-78`), `LogViewer.svelte:274-284, 333-337, 528-557` (own backdrop/keydown/close,
  ~40 lines CSS mirroring Modal's). The `×` close-button style appears 4× (`Modal`,
  `LogViewer`, `ImageViewerModal`, `UserQuestionModal.cancel-x`).
- Both bypasses are semi-defensible (different backdrop/zoom needs; large tabbed panel),
  but the Escape-to-close + backdrop-click-target check is identical to `Modal.svelte:48-59`.
- **DRY fix:** extract a `dismissable` action (Escape + backdrop mousedown) used by all
  three, plus one shared close-button class. **Effort: M.**

### S5 · 4/10 — CommandApprovalModal ≡ SandboxApprovalModal · EXACT
- **Sites:** `CommandApprovalModal.svelte:47-69` ≡ `SandboxApprovalModal.svelte:52-74`
  (`.code-preview`, `.button-row` — byte-identical CSS); `FileConflictModal.svelte:50-70`
  shares `.button-row`. Same structure: Modal + `<pre class="code-preview">` + stacked
  ModalButtons.
- **DRY fix:** minimum — global `.code-preview` + `.button-row` classes; better — one
  `ApprovalModal.svelte` parameterized by title/body/buttons. **Effort: S–M.**

### S6 · 3/10 — Spinner + `@keyframes spin` × 3–4 · EXACT
- **Sites:** `SpeakerButton.svelte:73-86`, `MicButton.svelte:130-153`,
  `SearchStep.svelte:556-570` (identical 2px-ring spinner + keyframes);
  `settings/InferenceSection.svelte:394` re-declares the keyframes as `restart-spin`.
- **DRY fix:** global `.spinner` + one `@keyframes spin` in `+layout.svelte`. **Effort: S.**

### S7 · 3/10 — Error-box CSS duplicated · STRUCTURAL
- **Sites:** `OpenRouterForm.svelte:434-442`, `jobs/JobEditor.svelte:1432-1438`, inline
  error spans in `InferenceBackendForm.svelte:583-585`, `EmailAccountForm.svelte:371-374`
  (all `var(--error-bg/-border/-text)` boxes).
- **DRY fix:** global `.error-box` / `.error-text` utilities. **Effort: S.**

### S8 · 4/10 — Status colors hardcoded instead of CSS variables · DATA
- **Sites:** green `#22c55e` (ServerStatusBadge, InferenceBackendForm:580,
  InferenceSection, SearchStep, OpenRouterModelPicker:265, setup page); amber
  `#f59e0b`/`#eab308` (ContextIndicator:15, ServerStatusBadge:49, JobRunView,
  JobScheduleField, shell/ChatSidebar); red `#ef4444`/`#c33`/`#dc2626` (ServerStatusBadge,
  ModalButton:63, EmailAccountForm, MicButton, ModelsSection).
- `+layout.svelte` already defines `--success` and `--error-*`; there is no `--warning`.
  These literals don't adapt between light/dark themes.
- **DRY fix:** add `--warning` (and optionally `--success-strong`) to the theme block;
  replace literals with `var(--success)` / `var(--warning)` / `var(--error-text)`.
  **Effort: M (many sites, trivial each).**

### S9 · 3/10 — `.hint` class re-declared in ~19 components · STRUCTURAL
- **Sites:** EmailAccountForm, both inference forms, ApiKeysSection, most settings
  sections, JobEditor, JobsTab, … (`font-size ~0.78rem; color: var(--text-secondary)`).
- **DRY fix:** one global `.hint`. **Effort: S.**

### S10 · 2/10 — Ad-hoc badge capsules · STRUCTURAL
- `OpenRouterModelPicker.svelte:256-272` (`.badge free/deprecated`),
  `UserQuestionModal.svelte:268` (Recommended), `InferenceBackendForm.svelte:504` (caps
  tag) each roll a small capsule while global `.status-pill` exists. Shapes differ —
  unify opportunistically. **Effort: S.**

### S11 · 1/10 — Streaming-caret `@keyframes blink` × 2
- `ChatMessage.svelte:271-275` ≡ `ChatView.svelte:584-588`. Fold into global CSS
  whenever S6 is done.

---

## Part 3 — Rust (`src-tauri/src`)

The backend is already well-factored (`sidecar_utils.rs`, `text_util.rs`, `time_util.rs`,
`fs_tools/path.rs`, `fs_tools/ooxml.rs`/`odf.rs`, `write_markdown_document`). Sidecar
spawn/health/port logic is fully shared; tts.rs/whisper.rs are thin consumers. The items
below are the remaining gaps. (jscpd hits inside `#[cfg(test)]` — `path.rs:547-586`,
`inference_queue.rs:470-542`, half of `server/mod.rs` — were excluded as test-only;
`shell/platform.rs` per-OS `mod imp` stubs are intentional platform polymorphism, won't-fix.)

### R1 · 7/10 — `db/jobs.rs` INSERT/UPDATE/SELECT column lists · STRUCTURAL
- **Sites:** `db/jobs.rs:47-72` (`create_job` INSERT), `251-277` (`update_job` UPDATE),
  `129-167` (`get_job` SELECT) — the same ~22 job columns and `params![…]` binding order
  hand-enumerated 3×, with hand-counted `?N` placeholders. **Every new job column must be
  edited in 3+ places**; OpenRouter (#168) just did exactly this dance to add
  `model_remote_api_key_id`, and the follow-up test-indentation fix (`dd7e315`) shows how
  fiddly it is. Highest correctness-risk duplication in the repo.
- **DRY fix:** a single column table + binder shared by insert/update:

```rust
const JOB_WRITE_COLS: &[&str] = &["name", "description", /* …, */ "model_remote_api_key_id"];

fn job_write_params<'a>(input: &'a JobInput) -> Vec<&'a dyn rusqlite::ToSql> {
    vec![&input.name, &input.description, /* same order as JOB_WRITE_COLS */]
}
// create_job: build "INSERT INTO jobs (…, created_at, updated_at) VALUES (?1..)" from the table
// update_job: build "UPDATE jobs SET name = ?1, … WHERE id = ?" from the same table
```
  Adding a column then touches the table + struct only. **Effort: M.**

### R2 · 6/10 — workdir vs absolute text read/edit bodies · NEAR
- **Sites:** `fs_tools/text.rs:28-49` (`fs_read_text`) ≡ `fs_tools/absolute.rs:103-124`
  (`fs_read_text_absolute`), ~22 lines; `text.rs:100-119` (`fs_edit_text`) ≡
  `absolute.rs:220-238` (`fs_edit_text_absolute`), ~19 lines. Only the path resolver
  (`resolve_in_workdir` vs `require_absolute`) and the binary-hint string differ —
  metadata/size-cap/read/`render_text_read` and read/`apply_edit`/write are identical.
- **DRY fix:** in `fs_tools/path.rs`:

```rust
pub(super) async fn read_text_at(resolved: &Path, offset: Option<u32>, limit: Option<u32>,
    binary_msg: &str) -> Result<String, String> { /* metadata → cap → read → render_text_read */ }
pub(super) async fn edit_text_at(resolved: &Path, old: &str, new: &str,
    display: &str) -> Result<EditResult, String> { /* metadata → cap → read → apply_edit → write */ }
```
  Each command becomes resolve + one call. The size-cap and truncation semantics — a
  model-facing contract — then can't drift between sandboxed and absolute variants.
  **Effort: M.**

### R3 · 6/10 — Proxy search-engine client construction · EXACT
- **Sites:** `proxy/search.rs:123-127`, `258-262`, `839-842`, `900-903` — each rebuilds
  `apply_proxy(Client::builder().timeout(FETCH_TIMEOUT), proxy)?.build()` with
  `SearchFailure` mapping. `proxy/extract.rs:139` already has `build_fetch_client(proxy)`
  doing this with `String` errors, so the fix is an error-type seam, not new logic.
- **DRY fix:** `fn build_search_client(proxy: Option<&ProxyConfig>) -> Result<Client, SearchFailure>`
  in `search.rs` delegating to `build_fetch_client` and mapping the error. Client config
  (timeout/redirect/proxy policy) is SSRF-adjacent — one seam, not five. **Effort: S.**

### R4 · 5/10 — Shell command session-lookup boilerplate × 8 · STRUCTURAL
- **Sites:** `shell/mod.rs` — `shell_write:180-184`, `shell_mark_ready:197-201`,
  `shell_resize:212-216`, `shell_get_context:280-290`, `shell_get_last_command:298-302`,
  `shell_get_recent_commands:311-317`, `shell_get_recent_history:326-330`,
  `shell_get_scrollback:341-345`. `"shell session not found"` × 8,
  `sessions.lock().map_err` × 10.
- **DRY fix:**

```rust
impl ShellManager {
    fn with_session<T>(&self, id: SessionId,
        f: impl FnOnce(&Session) -> Result<T, String>) -> Result<T, String> {
        let sessions = self.sessions.lock().map_err(|e| e.to_string())?;
        let session = sessions.get(&id).ok_or_else(|| "shell session not found".to_string())?;
        f(session)
    }
}
```
  Each read-only command becomes one call; mutating commands (`shell_kill`,
  `shell_restart`) keep their `&mut` path. **Effort: S.**

### R5 · 5/10 — fs_tools document-reader command skeleton · STRUCTURAL
- **Sites:** `fs_tools/docx.rs:343-356` (`fs_read_docx`), `fs_tools/xlsx.rs:202-218`
  (`fs_read_xlsx`), `fs_tools/pdf_read.rs:203-232` (`fs_read_pdf`) — identical
  resolve → `is_file` guard → `stat_within_limit(…, MAX_DOC_READ_BYTES, fmt)` →
  `spawn_blocking(extract)` → double-`?` unwrap. The write side already has
  `write_markdown_document`; the read side never got its twin.
- **DRY fix:** `read_document_blocking(workdir, rel_path, fmt, extract)` in
  `fs_tools/mod.rs`, mirroring the writer helper. **Effort: S.**

### R6 · 4/10 — `sanitize_appimage_env` duplicated · EXACT
- **Sites:** `links.rs:71-87` (on `std::process::Command`) ≡ `shell/session.rs:92-108`
  (on `portable_pty::CommandBuilder`) — identical APPDIR/`LD_LIBRARY_PATH` filtering,
  written twice because the receiver types differ.
- **DRY fix:** extract the computation: `fn appimage_cleaned_ld_path() -> Option<Option<String>>`
  (`None` = leave, `Some(None)` = remove var, `Some(Some(v))` = set `v`); both callers
  apply it to their own builder. A missed AppImage prefix causes subtle
  launched-process breakage on Linux — keep the list in one place. **Effort: S.**

### R7 · 4/10 — Shell platform probing helpers · NEAR
- `parse_os_release`: `shell/platform.rs:70-93` (file) vs `shell/wsl.rs:113-129`
  (string) — the wsl.rs doc comment literally says "Mirrors the file-based parser in
  platform.rs". Extract `parse_os_release_str(text)`; the file variant reads then delegates.
- `find_on_path`: `shell/platform.rs:352-361` ≡ `shell/catalog.rs:112-121` — exact copy;
  keep one.
- Hidden-window spawn: `CREATE_NO_WINDOW` named const in `platform.rs`/`catalog.rs` but
  raw `0x0800_0000` literal in `context.rs:143-148` and `wsl.rs:46-51` — magic-number
  drift; one `fn hidden_command(program) -> Command` (per the Windows-port gotchas, this
  matters for phase-17). **Effort: S each.**

### R8 · 4/10 — `EngineLifetimeStats` vs `EngineSessionStats` · SCHEMA
- **Sites:** `proxy/stats.rs:~136-166` vs `284-308` — 9–11 identical fields
  (`attempts, successes, total_latency_ms, max_latency_ms, last_*_at, first_choice_*,
  fallback_*`); they differ only in failure representation.
- **DRY fix:** shared `EngineStatsCore` embedded via `#[serde(flatten)]` +
  `#[ts(flatten)]` in both. Note: this changes the generated TS bindings — regenerate
  IPC bindings after (project invariant). **Effort: M.**

### R9 · 3/10 — `SamplingPreset` re-declares `SamplingParams` fields · SCHEMA
- **Sites:** `inference.rs:68-78` vs `83-96`.
- **DRY fix:** `struct SamplingPreset { name: String, label: String,
  #[serde(flatten)] params: SamplingParams }` (+ `#[ts(flatten)]`, regen bindings).
  **Effort: S.**

### R10 · 3/10 — tts/whisper log-buffer accessors · EXACT
- **Sites:** `tts.rs:215-223` ≡ `whisper.rs:119-127` (`get_logs`/`clear_logs`).
- **DRY fix:** `pub async fn snapshot_logs(buf: &LogBuffer) -> Vec<String>` /
  `clear_logs(buf)` in `sidecar_utils.rs`. **Effort: S.**

### R11 · 3/10 — `lint.rs` copies `workdir_path` · EXACT
- **Sites:** `lint.rs:6-12` ≡ `fs_tools/path.rs:135-141`, copied only because the
  original is `pub(super)`.
- **DRY fix:** make `fs_tools::path::workdir_path` `pub(crate)` and import it. **Effort: S.**

### R12 · 3/10 — `GpuInfo` success-tail duplicated · NEAR
- **Sites:** `hardware.rs:159-169` (Linux) vs `285-294` (Windows) — same
  name/integrated/`GpuInfo{available: true, api: Some("Vulkan"), …}` construction.
- **DRY fix:** `fn vulkan_gpu_info(name: Option<String>, vram_mb: Option<u64>) -> GpuInfo`.
  **Effort: S.**

### R13 · 3/10 — Proxy GET + status-guard idiom · NEAR
- **Sites:** `proxy/extract.rs:40-49` ≡ `proxy/images.rs:53-62` (+ `images.rs:255`, `288`)
  — `client.get(url).header("User-Agent", USER_AGENT).send()` + non-2xx guard.
- **DRY fix:** `async fn fetch_ok(client: &Client, url: &str) -> Result<Response, String>`.
  **Effort: S.**

### R14 · 2/10 — `inference_queue.rs` `cancel` vs `release` · NEAR
- **Sites:** `221-238` vs `243-255` — same lock/position/remove/pump skeleton, different
  predicate. **DRY fix:** `fn remove_ticket_where(&self, pred: impl Fn(&Ticket) -> bool) -> bool`.
  **Effort: S.**

### R15 · 2/10 — Extracted-text caps declared per reader · DATA
- `MAX_PDF_TEXT_CHARS` (`pdf_read.rs:246`) and `MAX_XLSX_CHARS` (`xlsx.rs:292`) are both
  `500_000` with near-identical truncate-with-note code around
  `text_util::truncate_at_char_boundary`. **DRY fix:** one `MAX_EXTRACTED_TEXT_CHARS` +
  `truncate_with_note` helper in `text_util.rs`. **Effort: S.**

### R16 · 2/10 — Small serde/DTO field overlaps · SCHEMA
- `db/mod.rs:231-244` (`JobRunSummary`) vs `260-272` (`JobRunWithSteps`) — 8 shared
  fields; `db/runs.rs:11-16` vs `254-259` — 5-line transaction preamble. Both marginal;
  fix opportunistically or leave.

### R17 · 1/10 — `.map_err(|e| e.to_string())` × 73 · IDIOM (no action)
- Idiomatic Tauri command glue. A macro/helper would obscure more than it saves. Won't-fix.

---

## Utilities module — created/extended in this audit ✅

`src/lib/utils/` already existed (from the June sweep: `error.ts`, `format.ts`,
`clampInt.ts`, `clipboard.svelte.ts`, `image.ts`, `imageDrop.ts`). This audit added the
missing common functions and migrated all their call sites:

| Module | Added | Migrated call sites |
|---|---|---|
| `utils/error.ts` | `isAbortError(e)`, `normalizeAbort(e)` | 10 (runner ×3, api, chat, setup, code, web, email, iteration) |
| `utils/async.ts` **(new)** | `sleep(ms)` | 4 (shell-interactive, pty-exec, setup, voiceCapture) |
| `utils/http.ts` **(new)** | `readErrorText(res)` | 3 (api, openrouter ×2) |
| `utils/format.ts` | `formatTodayLong()` | 3 (agent + shell ×2 system prompts) |
| `sandbox/format-result.ts` **(new)** | `formatSandboxResult(r)` (leaf module — breaks the tool↔store cycle) | 2 (run_python tool, chat store) |
| `api.ts` | — | now imports `OPENROUTER_ATTRIBUTION_HEADERS` instead of re-hardcoding it |

Verified: `npm run check` (0 errors), `npm run test` (764/764 pass), `npm run lint`
(0 errors), `npm run format:check` clean. Net **−46 lines** in modified files plus the
three new modules. Findings T2, T3, T8 (date part), T9, T10, T11 are closed by this change.

## Recommended follow-up order (open items, by leverage)

1. **T1** SSE reader unification (protocol correctness, M)
2. **R1** `db/jobs.rs` column table (highest correctness risk, M)
3. **S1 + S9 + S6 + S7** global `.btn`/`.field`/`.hint`/spinner/error-box CSS (bulk of remaining lines; mechanical, spread over PRs)
4. **S2** shared inference probe/catalog helper (already drifted once, L)
5. **R2/R3/R4/R5** Rust helpers — each S/M, independent, good "boy-scout" PRs
6. **R8/R9** serde `flatten` de-dups (remember: regenerate IPC bindings)
7. **T4/T6/T7** sandbox worker-manager + protocol types (S each)

## Unable to verify

- Whether the ~19 `.hint` declarations (S9) are pixel-identical — values were spot-checked
  in 6 of 19 files; unify to one canonical rule and visually diff the settings screens.
- `db/jobs.rs` R1 line refs are for the current `main` (`6d8c566`); the SELECT-mapping
  half of the old June finding 12 (`JOB_SUMMARY_COLS`) was already fixed in `f208ee7` —
  only the INSERT/UPDATE write path remains duplicated.
