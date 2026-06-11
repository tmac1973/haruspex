# Codebase Review — Haruspex

**Date:** 2026-06-11
**Scope:** Full codebase — `src/` (SvelteKit 5 frontend) + `src-tauri/src/` (Rust backend), ~58k LOC including tests.
**Method:** Four parallel deep reviews (Rust correctness/safety, frontend correctness/safety, test coverage, prior-audit remediation status), with the critical findings independently re-verified against current `main` (@ 326ea92) before publication.

> **Relationship to prior audits:** `architecture-2026-06-09.md`, `code-complexity-2026-06-09.md`, `code-duplication-2026-06-08.md`, and `design-patterns-2026-06-09.md` already cover structure, complexity, and duplication — and most of their findings have since been fixed (PRs #82–#108). This review deliberately focuses on what they didn't: **bugs, security, and test coverage**. Section 3 tracks the remediation status of the earlier audits instead of re-deriving them.

---

## Executive summary

The codebase is in good structural shape — the prior audits' findings were largely remediated within days, both test suites pass (454 Vitest + 286 cargo tests), and the test quality is well above average. This review found the remaining risk is concentrated in **security**, not structure:

1. **One critical finding:** LLM output is rendered as raw HTML with no sanitization and no CSP, giving any prompt-injecting web page a path to full Tauri IPC access (§1.1).
2. **A cluster of high-severity findings** around the web proxy and document tools: SSRF protection is bypassed by HTTP redirects, and three more byte-boundary slice panics of the exact class already fixed once in PR #107 (§1.2–1.6).
3. **Test coverage is good but inverted:** the single most complex file in the app (the agent loop) is essentially untested and mocked out everywhere, while simpler modules are well covered (§2).
4. **Prior audits: 28 of ~40 findings fixed.** The biggest items still open are the `chat.svelte.ts` God store and the untyped IPC seam (§3).

---

## 1. New findings: bugs & security

All findings below were verified by reading the current code; the critical and high findings were additionally re-confirmed by a second independent check.

### Critical

#### 1.1 Stored XSS: LLM/web-derived markdown rendered unsanitized, with `csp: null`

- **Where:** `src/lib/markdown.ts:594-599` (`renderMarkdown`), rendered via `{@html renderedContent}` in `src/lib/components/ChatMessage.svelte:59` and `{@html renderedStreamingContent}` in `src/lib/components/ChatView.svelte:325`. `src-tauri/tauri.conf.json:23` sets `"csp": null`.
- **What:** `marked` passes raw HTML through untouched (`<img src=x onerror=alert(1)>` survives verbatim; `[x](javascript:...)` becomes a live anchor). `sanitizeForRender` only strips `<tool_call>` artifacts. There is no DOMPurify or equivalent anywhere in the repo. Any assistant message containing HTML executes JS in the main webview **with full Tauri IPC access** (`window.__TAURI_INTERNALS__.invoke(...)` → filesystem tools, shell, email).
- **Reachability:** Does not require a malicious model. Fetched web pages and search snippets flow into the model as research context, so a prompt-injecting page that gets an HTML payload echoed into the rendered answer completes the chain: web page → model output → privileged JS.
- **Fix:** Run `renderMarkdown` output through DOMPurify before every `{@html}`, **and** set a restrictive CSP in `tauri.conf.json` (defense in depth — either alone is insufficient).

### High

#### 1.2 Pyodide sandbox escape via crafted `_repr_html_`

- **Where:** `src/lib/sandbox/python.worker.ts:636-644` (`_haruspex_postprocess`), rendered by `{@html artifact.html}` in `src/lib/components/SearchStep.svelte:265`.
- **What:** HTML artifacts are routed to a sandboxed `<iframe sandbox="allow-scripts">` only when they contain `<script` (lowercased substring check). Script-less payloads like `<img src=x onerror=...>` or `<svg onload=...>` bypass the heuristic and are rendered with `{@html}` directly in the privileged main document. Model-authored Python — which the worker sandbox exists to isolate — can break out into the app with IPC access.
- **Fix:** Render *all* sandbox-produced HTML inside the sandboxed iframe (drop the `<script>` heuristic), or sanitize before `{@html}`. Note this is closed automatically if 1.1's sanitization covers this call site too.

#### 1.3 SSRF protection bypassed by HTTP redirects

- **Where:** `src-tauri/src/proxy/extract.rs:40`, `proxy/images.rs:54` and `:254`, `fs_tools/download.rs:88` (and the search clients).
- **What:** `validate_url()` (scheme + private-IP checks) runs once against the *initial* URL, but every reqwest client is built with `redirect::Policy::limited(5)` and follows 3xx with no per-hop re-validation. A public page answering `302 Location: http://169.254.169.254/...` or `http://127.0.0.1:8765/...` is followed straight into loopback/private networks. `fs_download_url` is the worst case: it streams the internal response to a file in the working dir, which the model can then read back.
- **Fix:** Use a custom `redirect::Policy` closure that re-runs `validate_url`/`is_private_ip` on each hop (`attempt.url()`), or `Policy::none()` with manual hop validation.

#### 1.4–1.6 Three more char-boundary slice panics (same class as PR #107)

PR #107 (`f544809`) fixed exactly this bug in proxy fetch truncation; three siblings remain:

| | Where | Trigger |
|---|---|---|
| 1.4 | `src-tauri/src/tts.rs:245` — `&text[..text.len().min(100)]` | TTS log line; panics when byte 100 lands inside a multibyte char (emoji/CJK in assistant text — common) |
| 1.5 | `src-tauri/src/fs_tools/pdf_read.rs:250` — `&trimmed[..MAX_PDF_TEXT_CHARS]` | Any Unicode-heavy PDF whose extracted text exceeds 500 KB |
| 1.6 | `src-tauri/src/fs_tools/xlsx.rs:281` — `&csv[..MAX_XLSX_CHARS]` | Large spreadsheet with a multibyte char on the 500 KB boundary |

- **Fix:** Extract one shared boundary-safe truncation helper (back off to `is_char_boundary`, as the PR #107 fix does) and use it at all three sites — plus a `grep` or clippy lint pass for other byte-index slices on user-derived strings.

#### 1.7 docx text extractor matches `<w:t` as a prefix, dumping raw XML

- **Where:** `src-tauri/src/fs_tools/docx.rs:43`.
- **What:** `starts_with(b"<w:t")` also fires on `<w:tbl>`, `<w:tc>`, `<w:tr>`, `<w:tab/>` etc., then copies everything up to the next `</w:t>` — pulling raw OOXML markup into the extracted "text". Any .docx with a table or tab character (very common) returns polluted output that then poisons the model's context.
- **Fix:** Require the byte after `<w:t` to be `>`, `/`, or whitespace.

### Medium

#### 1.8 IPv6 holes in `is_private_ip`

`src-tauri/src/proxy/extract.rs:110-121` — the V6 arm only checks loopback/unspecified. IPv4-mapped (`::ffff:127.0.0.1`), unique-local (`fc00::/7`), and link-local (`fe80::/10`) all pass, and the literal-string host guard misses bracketed IPv6 forms. **Fix:** unmap mapped addresses and re-check; reject `fc00::/7` and `fe80::/10`. (Compounds with 1.3.)

#### 1.9 IMAP SEARCH injection via filter fields

`src-tauri/src/integrations/email/imap_client.rs:158-167` — `from`/`subject_contains` values (LLM-controlled tool args) are interpolated into the IMAP SEARCH command with only `"` stripped; CR/LF/backslash survive, and `since_date` isn't sanitized at all. A `\r\n` in a value terminates the line and injects a new command on the authenticated session. Impact is bounded to the user's own mailbox but exceeds the exposed read-only tool surface, and is reachable via prompt injection from a malicious email. **Fix:** reject/strip CR, LF, NUL, and backslash from all three fields.

#### 1.10 `rate_limit_engine` blocks a tokio worker while holding the mutex

`src-tauri/src/proxy/mod.rs:114-123` — locks `last_search_time`, then `std::thread::sleep`s up to 6 s *while holding the guard*, inside an async command. Serializes all concurrent searches (even across engines, since the map is shared) and stalls a tokio worker thread. **Fix:** compute the wait, drop the guard, `tokio::time::sleep().await`.

#### 1.11 Model downloads: no integrity check, and resume can silently corrupt

`src-tauri/src/models.rs:300-347`, `:414-422` (and the whisper copy ~`:649`) — every registry entry has `sha256: String::new()` so verification is skipped (`validate_gguf` checks only 4 magic bytes), and the resume path appends with `Range: bytes=N-` but never checks for `206` — a server answering `200` gets its full body appended after the existing N bytes, producing a corrupt GGUF that is accepted and fed to llama-server. **Fix:** populate and enforce real hashes; on resume, append only on `206`, otherwise truncate and restart.

#### 1.12 Inline artifacts and tok/s stats mis-map after compaction

`src/lib/stores/chat.svelte.ts:406-432` (`compactIfNeeded`) rewrites `conversation.messages` but never remaps `messageSteps`/`messageStats`, which are keyed by message **index**. After compaction the array reindexes, so plots/DataFrames and speed footers render under unrelated messages or vanish (`ChatView.svelte:305-311`). **Fix:** key both maps by a stable message id, or rebuild indices during compaction.

### Low

- **1.13** `replace_messages` not transactional — `src-tauri/src/db/conversations.rs:153-192`; a failed insert mid-loop leaves a truncated conversation. Wrap in one transaction.
- **1.14** docx entity decode order double-decodes — `fs_tools/docx.rs:81`; `&amp;` replaced before `&lt;`/`&gt;` turns `&amp;lt;` into `<`; numeric refs not decoded. Decode `&amp;` last.
- **1.15** xlsx emits `office:value="NaN"` for text cells parsing as non-finite floats — `fs_tools/xlsx.rs:21`. Require `is_finite()`.
- **1.16** First sandbox run can time out during Pyodide boot — `src/lib/sandbox/worker-manager.ts:343-386` arms the exec timer before `waitForReady()`; with `sandboxTimeoutSeconds` near the 5 s floor, first boot trips timeout → terminate → respawn loop. Start the timer at `exec_start`.
- **1.17** `cancelGeneration()` clears `isGenerating` before the turn unwinds — `chat.svelte.ts:631-637` vs the `finally` at `:1022-1028`; a rapid re-send can let a stale `finally` clobber the new turn's `abortController`. Guard turn state with a per-turn token.

### Reviewed and found clean

`fs_tools/path.rs` workdir sandboxing (incl. symlink-escape tests), `inference_queue.rs` admission/cancel/lease logic, `server/mod.rs` generation-counter restart handling, all `db/` queries (fully parameterized, poison-recovery correct), SSE parsing in `api.ts` (multi-byte + partial-chunk safe), tool-call ID generation (monotonic), worker-manager timer/promise cleanup, `dropOldestTurns` orphan-tool-result handling, search/bypass parsers, document writers' XML escaping, smtp (typed mailboxes via lettre), audio (clamped casts, `catch_unwind`).

---

## 2. Test coverage

**Overall:** Good for a desktop app — 35 Vitest files / 454 tests and 286 cargo tests, all passing fast (7.5 s / 6.2 s). Existing tests are mostly real behavioral tests with genuine edge cases (SSE split mid-JSON, symlink escapes, queue lease-sweeping, orphan-run recovery). The problem is *where* coverage is missing, not how much.

### Structural gaps

1. **The agent loop core is untested and mocked everywhere.** `src/lib/agent/loop/iteration.ts` (903 LOC — the most complex file in the app) has tests only for `isCodeContext` and nudges. `chat.test.ts` mocks `runAgentLoop` and `shell.test.ts` mocks `runShellTurn`, so **the store↔loop seam is never exercised anywhere** — each side is tested against a fake of the other.
2. **Component testing: zero of 50 Svelte files.** `@testing-library/svelte` is in devDependencies but imported by no file; jsdom is already configured in `vitest.config.ts`, so starting is cheap.
3. **No e2e layer.** No Playwright/tauri-driver config; the highest-value flows (model download → server start → first chat; sandbox approval) are only verifiable manually.
4. **CI is solid but Linux-only** — `shell/windows.ts` and the Windows branches in `platform.rs` are never compiled or tested in CI; no coverage reporting/thresholds.

### Top untested high-risk modules (prioritized)

| # | Module | What to test first |
|---|---|---|
| 1 | `src/lib/agent/loop/iteration.ts` + `loop.ts` | Tool-call round trip across iterations; abort mid-stream finalizes partial message; max-iterations synthesis; malformed `function.arguments` → tool error, not crash |
| 2 | `src-tauri/src/proxy/extract.rs` / `images.rs` / `paywall.rs` | Zero tests despite PR #107 fixing a real panic here. Regression test for char-boundary truncation; content extraction on fixture HTML; relative-URL rewriting |
| 3 | `src-tauri/src/server/mod.rs` lifecycle | Extract the spawn/health/restart state machine so it's testable without a binary; health-timeout → error status; stop clears state (the orphaned-sidecar dev pain suggests this matters) |
| 4 | `src/lib/agent/compaction.ts` | Threshold boundary; system prompt + recent turns preserved; summary failure leaves originals intact. (Add index-remap tests when fixing 1.12) |
| 5 | `src/lib/stores/sandboxApproval.svelte.ts` | Security gate: deny rejects the run; `allow_chat` scoped to that chat; forget forces re-prompt |
| 6 | `src/lib/agent/tools/email.ts` | Only tool family with no tests; account fan-out, filter arg pass-through |
| 7 | `src-tauri/src/sandbox_fetch.rs` / `sandbox_save.rs` / `sandbox_sync.rs` | Size limits, workdir confinement (mirror `path.rs` guarantees), sync conflicts |
| 8 | `src/lib/stores/db.ts` | No-op when DB unavailable; steps record round-trips; invoke rejection doesn't break callers |
| 9 | `src-tauri/src/models.rs` download command | Cancel leaves resumable partial; 416 restarts from zero; failed validation deletes the file (pairs with 1.11) |
| 10 | `src-tauri/src/tts.rs` / `whisper.rs` | Request construction; sidecar 5xx → user-facing error (pairs with 1.4) |

### Weak tests worth replacing

- `src-tauri/src/shell/platform.rs:118-122` — asserts nothing (pure execution smoke).
- `src-tauri/src/time_util.rs:66-68` — `now_ms_is_positive`, trivially true.
- `src-tauri/src/integrations/email/smtp_client.rs:132-140` — pins a stub's "not implemented" error; will be deleted rather than converted.

---

## 3. Prior audit findings — remediation status

Of the ~40 findings across the four June 8–9 audits, **28 are fixed** (verified against commits and current code), a handful are accepted-as-is, and the following remain genuinely open, ranked:

| Rank | Finding | Status / evidence |
|---|---|---|
| 1 | **A1 remainder — `chat.svelte.ts` God store** | Cycle broken (`314f78c`) but the file is still 1029 LOC; every turn-lifecycle change funnels through it |
| 2 | **X2 — fs_* command/arg name drift across IPC** | The non-codegen fallback (a `commands.ts` const map) is unblocked and was never shipped |
| 3 | **X3 / D8 — hand-mirrored Rust↔TS DTOs** | specta blocked on rustc 1.91, but the ts-rs fallback documented in `x2-x3-typed-ipc-proposal.md` is executable today |
| 4 | **A3 — `proxy → db` layering leak** | Still live at `proxy/mod.rs:20`; the one backward dependency in an otherwise acyclic backend |
| 5 | **F13 — `proxy_search` per-branch telemetry duplication** | `proxy/mod.rs:286-370`; each provider arm repeats timing + stat recording (feeds A3) |
| 6 | **R-search — search engine result-collection dedup** | ~80% identical JSON→`SearchResult` loops across 5 engines in `proxy/search.rs` |
| 7 | **A5 — split `proxy/mod.rs` (984 LOC)** | Pure-move refactor that would make #4 and #5 cleaner |
| 8 | **D4 — job lifecycle scattered across three layers** | Deferred by design; act when the job subsystem grows |
| 9 | **Sandbox-timeout doc drift** | `tools/sandbox.ts:55` tells the model "default 30s"; actual default is 60 s (`settings.ts:284`). One-line fix that affects model behavior |
| 10 | **C7 — five divergent `.btn` style systems** | Needs a deliberate design pass, not mechanical dedup |

Accepted/benign and intentionally not re-raised: C6 (ImageViewerModal is a lightbox, not a dialog), A7 (type-only import cycle, erased at compile time), D5/D6 (idiomatic anemic models / no shared adapter trait — act on growth).

**Stale content in the prior audits** (for anyone re-reading them): `db.rs` is now `db/` (7 files); hardware detection moved to `hardware.rs`; `runIteration` moved to `iteration.ts:457` with the guard chain extracted; A4's constant locations now live in `sidecar_utils::timing`; the remaining `127.0.0.1` literals are SSRF guards and tests, not config violations.

---

## 4. Recommended action plan

**Immediately (security):**
1. Add DOMPurify to every `{@html}` sink + set a real CSP → closes 1.1 and 1.2 together.
2. Per-hop redirect validation in all reqwest clients → closes 1.3 (and fold in the IPv6 fixes, 1.8).
3. Shared boundary-safe truncation helper → closes 1.4–1.6 in one PR, with regression tests (also the #2 test-coverage item).

**Next (correctness):**
4. IMAP filter sanitization (1.9), download resume/206 + hashes (1.11), docx prefix match (1.7), compaction index remap (1.12).

**Then (coverage and structure):**
5. Agent-loop iteration tests — the highest-value testing investment in the repo.
6. Ship the ts-rs DTO fallback + `commands.ts` name map (closes X2/X3 without waiting on specta).
7. `proxy/` cleanup as one arc: split `mod.rs` (A5), extract a `SearchProvider` seam (F13 + R-search), and move stat-writing behind it (A3).
8. Start component testing with the already-installed `@testing-library/svelte`; consider a minimal tauri-driver smoke test for the first-run flow.
