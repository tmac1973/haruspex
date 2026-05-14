# Code Duplication Audit — Haruspex

- **Date:** 2026-05-14
- **Scope:** `src/` (TypeScript / Svelte) and `src-tauri/src/` (Rust)
- **Method:** AST-aware grep + file reads. Each finding cites exact file paths, line numbers, and identifiers. Severity is rated 1–10 (10 = highest impact).
- **Files in scope:** 68 TS/Svelte, 26 Rust.

---

## Executive Summary

| # | Area | Layer | Severity | Refactor effort |
| --- | --- | --- | --- | --- |
| R-1 | Sidecar `kill_process_on_port` triplicated | Rust | **9** | M (2–3 h) |
| R-2 | Sidecar health-check poll loop triplicated | Rust | **9** | M (2–3 h) |
| R-3 | `strip_ansi` + `push_log` triplicated | Rust | **8** | S (45 min) |
| R-4 | Model download w/ resume duplicated | Rust | **8** | M (2 h) |
| T-1 | Modal CSS duplicated (`.modal-backdrop`/`.modal`/`.btn`) | TS/Svelte | **9** | S–M (1.5 h) |
| T-2 | Sub-agent `chatCompletion` call duplicated | TS/Svelte | **8** | S (45 min) |
| T-3 | Spreadsheet schema duplicated (`xlsx`/`ods`) | TS/Svelte | **8** | S (15 min) |
| T-4 | `fsWriteWithConflictCheck` boilerplate ×8 | TS/Svelte | **7** | M (1.5 h) |
| R-5 | Sidecar `Status` enum triplicated | Rust | **7** | S (30 min) |
| R-6 | `wait_for_port_release` inner loop triplicated | Rust | **7** | S (20 min) |
| T-5 | `proxy_fetch` + paywall pattern duplicated | TS/Svelte | **7** | S (30 min) |
| T-6 | `toolError(\`${cmd} failed: ${e}\`)` 15+ sites | TS/Svelte | **7** | S (30 min) |
| T-7 | Modal structure (3 components) | TS/Svelte | **7** | M (2 h) |
| R-7 | `reqwest::Client::builder()` 11+ sites | Rust | **6** | S (30 min) |
| T-8 | Email-account resolution triplicated | TS/Svelte | **6** | S (30 min) |
| T-9 | Try/catch wrapping `invoke` in every tool | TS/Svelte | **6** | M (1.5 h) |
| R-8 | `.map_err(\|e\| e.to_string())` 20+ in `fs_tools.rs` | Rust | **5** | S (45 min) |
| T-10 | `getSettings()` × 11 in settings route | TS/Svelte | **5** | S (20 min) |
| T-11 | Sampling-params block duplicated | TS/Svelte | **5** | (folds into T-2) |
| R-9 | Sidecar ports/timeouts scattered | Rust | **4** | S (15 min) |
| R-10 | `format!("127.0.0.1:{}", port)` 15+ | Rust | **3** | S (10 min) |
| T-12 | `displayLabel: (args) => (args.x as string) \|\| ''` 40+ | TS/Svelte | **3** | S (15 min) |

Total estimated effort to address every finding: **~18 hours**. The top six findings (R-1, R-2, R-3, T-1, T-2, T-3) deliver most of the value and can be done in **~7 hours**.

A new **`src-tauri/src/sidecar_utils.rs`** module and a new **`src/lib/agent/tools/_helpers.ts`** module (or `src/lib/utils/`) cover most of the proposed extractions.

---

## Rust Findings (`src-tauri/src/`)

### R-1 — `kill_process_on_port` is copy-pasted across three sidecars (Severity 9)

**Locations**
- `src-tauri/src/whisper.rs:65-121`
- `src-tauri/src/tts.rs:340-395`
- `src-tauri/src/server.rs:227-292`

All three functions are byte-for-byte identical aside from internal logging strings. ~56 lines × 3 = ~170 lines of duplication. Any platform-specific bug (e.g. wrong `lsof` flag, missing taskkill case on Windows) must be fixed in three places.

**Duplication: 100% across ~56 LOC × 3 sites.**

**Fix:** Extract into a new `src-tauri/src/sidecar_utils.rs`:

```rust
// src-tauri/src/sidecar_utils.rs
use std::time::Duration;
use tracing::{info, warn};

pub async fn kill_process_on_port(port: u16, sidecar_name: &str) {
    if std::net::TcpStream::connect(format!("127.0.0.1:{port}")).is_err() {
        return;
    }
    warn!("{sidecar_name}: port {port} occupied, killing existing process");
    #[cfg(unix)]
    kill_unix(port).await;
    #[cfg(windows)]
    kill_windows(port).await;
    wait_for_port_release(port, 20, Duration::from_millis(100)).await;
}

#[cfg(unix)]
async fn kill_unix(port: u16) { /* lsof + libc::kill body lifted from whisper.rs:70-83 */ }

pub async fn wait_for_port_release(port: u16, attempts: usize, interval: Duration) {
    for _ in 0..attempts {
        if std::net::TcpStream::connect(format!("127.0.0.1:{port}")).is_err() { return; }
        tokio::time::sleep(interval).await;
    }
}
```

Then in each sidecar:
```rust
crate::sidecar_utils::kill_process_on_port(WHISPER_PORT, "whisper").await;
```

---

### R-2 — Sidecar health-check polling triplicated (Severity 9)

**Locations**
- `src-tauri/src/whisper.rs:250-286`
- `src-tauri/src/tts.rs:285-322`
- `src-tauri/src/server.rs:708-757`

All three build a 2-second `reqwest::Client`, loop until `HEALTH_POLL_TIMEOUT`, GET `/health`, then update a shared status mutex. The only meaningful differences are the URL and the success-status type.

**Duplication: ~30 LOC × 3 sites.**

**Fix:** Add to `sidecar_utils.rs`:

```rust
pub async fn poll_health<F, Fut>(
    url: &str,
    timeout: Duration,
    interval: Duration,
    name: &'static str,
    mut should_continue: F,
) -> bool
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .expect("reqwest builder");
    let attempts = (timeout.as_millis() / interval.as_millis()) as usize;
    for _ in 0..attempts {
        if !should_continue().await { return false; }
        tokio::time::sleep(interval).await;
        if let Ok(resp) = client.get(url).send().await {
            if resp.status().is_success() {
                tracing::info!("{name} health check passed");
                return true;
            }
        }
    }
    false
}
```

The `should_continue` closure is how each sidecar bails out if its status transitioned away from `Starting`.

---

### R-3 — `strip_ansi` and `push_log` triplicated (Severity 8)

**Locations**
- `src-tauri/src/whisper.rs:32-47` (`strip_ansi`), `:49-54` (`push_log`)
- `src-tauri/src/tts.rs:35-50`, `:53-58`
- `src-tauri/src/server.rs:157-172` (method form), `:174-179`

Verified identical bodies in `whisper.rs` vs `tts.rs`. `server.rs` wraps them as `impl` methods, but the bodies match. About 22 LOC × 3 = 66 lines duplicated.

**Fix:** Add to `sidecar_utils.rs`:

```rust
use std::collections::VecDeque;

pub type LogBuffer = std::sync::Arc<tokio::sync::Mutex<VecDeque<String>>>;

pub fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            for esc_c in chars.by_ref() {
                if esc_c.is_ascii_alphabetic() { break; }
            }
        } else { out.push(c); }
    }
    out
}

pub fn push_log(buf: &mut VecDeque<String>, line: &str, cap: usize) {
    if buf.len() >= cap { buf.pop_front(); }
    buf.push_back(strip_ansi(line));
}
```

Then `use crate::sidecar_utils::{strip_ansi, push_log, LogBuffer};` in each sidecar.

---

### R-4 — Model download with HTTP-range resume duplicated (Severity 8)

**Locations**
- `src-tauri/src/models.rs:289-344` — `download_llama_model`
- `src-tauri/src/models.rs:974-1040` — `download_whisper_model`

Both compute `existing_size`, conditionally set a `Range: bytes=N-` header, validate `2xx || 206`, stream the body with `progress` events to the frontend. ~55 LOC × 2 = ~110 LOC duplicated.

**Fix:** Extract a single private helper in `models.rs`:

```rust
async fn download_with_resume<F>(
    url: &str,
    dest: &Path,
    expected_size: u64,
    mut on_progress: F,
) -> Result<(), String>
where F: FnMut(u64, u64),
{
    /* lift body from models.rs:289-344, accept callback for progress emission */
}
```

Then both `download_llama_model` and `download_whisper_model` become ~15-line wrappers that pass `app.emit("download-progress", ...)` as the closure.

---

### R-5 — Sidecar status enums triplicated (Severity 7)

**Locations**
- `src-tauri/src/whisper.rs:18-23` — `enum WhisperStatus { Stopped, Starting, Ready, Error(String) }`
- `src-tauri/src/tts.rs:17-22` — `enum TtsStatus { … }`
- `src-tauri/src/server.rs:31-36` — `enum ServerStatus { … }`

Byte-identical variants. Adding a new state (e.g. `Restarting`, `Crashed`) requires three edits and three serde-rename audits.

**Fix:**

```rust
// sidecar_utils.rs
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "kind", content = "message", rename_all = "lowercase")]
pub enum SidecarStatus { Stopped, Starting, Ready, Error(String) }
```

Then `pub type WhisperStatus = SidecarStatus;` (or just use `SidecarStatus` directly). Verify Tauri events that emit the tag — if a frontend listener depends on the old payload shape, keep serde reps the same.

---

### R-6 — Port-release wait loop triplicated (Severity 7)

**Locations**
- `whisper.rs:84-90`, `tts.rs:359-365`, `server.rs:253-259`

A 20-iteration / 100ms-sleep poll that exits as soon as the port stops accepting connections. Folds into the `wait_for_port_release` helper in R-1.

---

### R-7 — `reqwest::Client::builder().timeout(...).build().unwrap()` repeated 11+ times (Severity 6)

**Locations (greppable):** `tts.rs:287-290, 429-432`, `whisper.rs:253-256, 319-322`, `server.rs:713-716`, `inference.rs:175-178`, `sandbox_fetch.rs:52-57`, `proxy.rs:279-282, 408-411, 537-540, 766-769`.

**Fix:** Small helper in `sidecar_utils.rs` (or a new `src-tauri/src/http.rs`):

```rust
pub fn client(timeout: Duration) -> reqwest::Client {
    reqwest::Client::builder().timeout(timeout).build().expect("reqwest")
}
pub fn client_2s() -> reqwest::Client { client(Duration::from_secs(2)) }
```

Drop-in replacement: `let client = sidecar_utils::client_2s();`.

---

### R-8 — `.map_err(|e| e.to_string())` saturates `fs_tools.rs` (Severity 5)

**Locations:** `fs_tools.rs:851, 853, 857, 864, 887, 888, 899, 900, 975, 977, 979, 1049, 1051, 1085, 1087, 1091, 1098, 1104, 1116, 1125` — 20+ in the ZIP handling alone. Project-wide it is closer to 80+.

The pattern is fine, but each call site loses context (no operation name, no path).

**Fix:** Add a trait once, in `src-tauri/src/error_ext.rs`:

```rust
pub trait StringErr<T> {
    fn ctx(self, label: &str) -> Result<T, String>;
}
impl<T, E: std::fmt::Display> StringErr<T> for Result<T, E> {
    fn ctx(self, label: &str) -> Result<T, String> {
        self.map_err(|e| format!("{label}: {e}"))
    }
}
```

Then `read_to_string(p).ctx("read manifest")?` reads better and gives a real error to the caller (we currently surface bare `"No such file or directory"` to the UI).

---

### R-9 — Sidecar port/timeout constants scattered (Severity 4)

**Locations**
- `whisper.rs:12` — `WHISPER_PORT: u16 = 8766`
- `whisper.rs:13-14` — `HEALTH_POLL_INTERVAL`, `HEALTH_POLL_TIMEOUT`
- `tts.rs:13` — `TTS_PORT: u16 = 3001`
- `server.rs:13-14`, `server.rs:63` — `8765` as struct default
- `inference.rs:44` — `PROBE_TIMEOUT`

**Fix:** Centralize:

```rust
// sidecar_utils.rs
pub mod ports {
    pub const LLAMA: u16 = 8765;
    pub const WHISPER: u16 = 8766;
    pub const TTS: u16 = 3001;
}
pub mod timing {
    use std::time::Duration;
    pub const HEALTH_POLL_INTERVAL: Duration = Duration::from_millis(500);
    pub const HEALTH_POLL_TIMEOUT: Duration = Duration::from_secs(60);
}
```

CLAUDE.md already documents these ports — keep the doc and code agreeing in one place.

---

### R-10 — `format!("127.0.0.1:{}", port)` repeated 15+ times (Severity 3)

**Locations:** `whisper.rs:66, 71, 85, 100, 114`, `tts.rs:341, 346, 360, 375, 388`, `server.rs:228, 238, 254, 270, 284`.

Folds away naturally once R-1/R-6 are extracted. If kept as standalone, add `fn localhost(port: u16) -> SocketAddr` to `sidecar_utils`.

---

## TypeScript / Svelte Findings (`src/lib/`, `src/routes/`)

### T-1 — Modal CSS duplicated near-verbatim (Severity 9)

**Locations**
- `src/lib/components/FileConflictModal.svelte:51-133`
- `src/lib/components/SandboxApprovalModal.svelte:53-138`

Verified: `.modal-backdrop` (10 lines), `.modal` (9 lines, only `max-width` differs: 520 vs 640), `.modal h2`, `.modal p`, `.btn` (12 lines), `.btn:hover`, `.btn strong`, `.btn span` are identical between the two files. About 60 lines of CSS × 2 files.

**Fix (preferred, ~1.5 h):** Create a shared modal primitive at `src/lib/components/Modal.svelte`:

```svelte
<!-- src/lib/components/Modal.svelte -->
<script lang="ts">
	import type { Snippet } from 'svelte';
	interface Props {
		open: boolean;
		maxWidth?: number;
		children: Snippet;
	}
	let { open, maxWidth = 520, children }: Props = $props();
</script>

{#if open}
	<div class="modal-backdrop">
		<div class="modal" style:max-width="{maxWidth}px">
			{@render children()}
		</div>
	</div>
{/if}

<style>
	.modal-backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.5);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 1000;
		padding: 24px;
	}
	.modal {
		background: var(--bg-primary);
		border: 1px solid var(--border);
		border-radius: 12px;
		padding: 24px 28px;
		width: 100%;
		box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
	}
	.modal :global(h2) { margin: 0 0 12px 0; font-size: 1.15rem; color: var(--text-primary); }
	.modal :global(p)  { margin: 0 0 10px 0; color: var(--text-primary); font-size: 0.9rem; line-height: 1.5; }
</style>
```

Plus a sibling `ModalButton.svelte` for the `.btn` block (≈25 lines today). Then replace the wrapper in `FileConflictModal.svelte:24-48` and `SandboxApprovalModal.svelte:21-50` with `<Modal open={pending != null} maxWidth={640}>…</Modal>`.

Note: `GpuWarningDialog.svelte:39-103` uses different class names (`.backdrop`, `.dialog`) but the same shape — fold it in opportunistically; not required.

---

### T-2 — Sub-agent `chatCompletion` call duplicated (Severity 8)

**Locations**
- `src/lib/agent/tools/web.ts:191-213` (`research_url`)
- `src/lib/agent/tools/email.ts:231-271` (`email_summarize_message`)

Verified identical 11-line core (sampling pull, completion call with the same six params, abort-aware catch).

**Fix:** Drop a helper next to the tool registry, e.g. `src/lib/agent/tools/_subAgent.ts`:

```ts
import { chatCompletion, type ChatMessage } from '$lib/api';
import { getSamplingParams, getChatTemplateKwargs } from '$lib/stores/settings';

export async function runSubAgent(
	messages: ChatMessage[],
	maxTokens: number,
	signal?: AbortSignal
): Promise<string> {
	const s = getSamplingParams();
	const resp = await chatCompletion(
		{
			messages,
			temperature: s.temperature,
			top_p: s.top_p,
			top_k: s.top_k,
			presence_penalty: s.presence_penalty,
			max_tokens: maxTokens,
			chat_template_kwargs: getChatTemplateKwargs()
		},
		signal
	);
	return resp.content?.trim() ?? '';
}
```

Each tool then becomes:
```ts
try {
	const findings = await runSubAgent(messages, RESEARCH_AGENT_MAX_TOKENS, ctx.signal);
	if (!findings) return toolResult(`Sub-agent returned no findings for ${url}.`);
	return toolResult(`Source: ${url}\nFocus: ${focus}\n\n${findings}`);
} catch (e) {
	if (e instanceof DOMException && e.name === 'AbortError') throw e;
	return toolResult(toolError(`Sub-agent failed: ${e}`));
}
```

This also subsumes T-11.

---

### T-3 — Spreadsheet schema duplicated (Severity 8)

**Locations**
- `src/lib/agent/tools/fs-write.ts:272-287` (`fs_write_xlsx`)
- `src/lib/agent/tools/fs-write.ts:352-366` (`fs_write_ods`)

Verified: the `sheets` property — array of `{ name, rows: string[][] }` — is 15 lines, byte-identical except for indentation context. The two `path` descriptions differ only in extension.

**Fix:** Inline constant near the top of the same file:

```ts
const SHEETS_SCHEMA = {
	type: 'array',
	description: 'Array of sheet objects. Each sheet needs a name and rows.',
	items: {
		type: 'object',
		properties: {
			name: { type: 'string', description: 'Sheet name (tab label)' },
			rows: {
				type: 'array',
				description: '2D array: array of rows, each row is an array of cell values.',
				items: { type: 'array', items: { type: 'string' } }
			}
		},
		required: ['name', 'rows']
	}
} as const;
```

Then in each tool registration: `sheets: SHEETS_SCHEMA`. The docx/odt `content` description (lines `201-205` and `317-321`) deserves the same treatment.

---

### T-4 — `fsWriteWithConflictCheck(...)` boilerplate ×8 (Severity 7)

**Locations**
`src/lib/agent/tools/fs-write.ts:179, 213, 250, 295, 329, 374, 408, 438` — confirmed via grep (8 call sites). Each is the same 6-line block:

```ts
return fsWriteWithConflictCheck(
	'fs_write_xxx',
	ctx.workingDir!,
	args.path as string,
	{ /* tool-specific payload */ },
	ctx.filesWrittenThisTurn
);
```

**Fix:** Factor the `execute` plumbing into a builder local to `fs-write.ts`:

```ts
function writeExecutor(
	command: string,
	payload: (args: Record<string, unknown>) => Record<string, unknown>
) {
	return async (args: Record<string, unknown>, ctx: ToolContext) =>
		fsWriteWithConflictCheck(
			command,
			ctx.workingDir!,
			args.path as string,
			payload(args),
			ctx.filesWrittenThisTurn
		);
}
```

Then each registration drops to one line:
```ts
execute: writeExecutor('fs_write_xlsx', (a) => ({ sheets: a.sheets }))
```

---

### T-5 — `proxy_fetch` + paywall pattern duplicated (Severity 7)

**Locations**
- `src/lib/agent/tools/web.ts:103-115` (`fetch_url`)
- `src/lib/agent/tools/web.ts:152-162` (`research_url`)

Same `invoke<string>('proxy_fetch', { url, caller, proxy: getSettings().proxy })` followed by the same `Failed to fetch` early-out and `detectPaywall` call.

**Fix:** Private helper in `web.ts`:

```ts
async function fetchUrl(url: string, caller: string): Promise<{ ok: true; content: string } | { ok: false; error: string }> {
	try {
		const content = await invoke<string>('proxy_fetch', {
			url, caller, proxy: getSettings().proxy
		});
		if (!content || content.startsWith('Failed to fetch')) {
			return { ok: false, error: content || `Failed to fetch URL: ${url}` };
		}
		return { ok: true, content };
	} catch (e) {
		return { ok: false, error: `Failed to fetch URL: ${e}` };
	}
}
```

---

### T-6 — `toolError(\`${cmd} failed: ${e}\`)` at 15+ sites (Severity 7)

**Locations:** sample — `fs-read.ts:46`, `fs-write.ts:89`, plus eight `*_failed: ${e}` variants in `fs-write.ts` (see grep). Inconsistencies are already visible (`Sub-agent failed`, `Research sub-agent failed`, `email_summarize_message sub-agent failed`).

**Fix:** Tiny helper in `src/lib/agent/tools/types.ts` next to `toolError`:

```ts
export function toolInvokeError(command: string, e: unknown): string {
	return toolError(`${command} failed: ${e instanceof Error ? e.message : e}`);
}
```

Use `return toolResult(toolInvokeError('fs_write_xlsx', e));` consistently.

---

### T-7 — Modal structural pattern repeated in 3 components (Severity 7)

**Locations**
- `FileConflictModal.svelte:24-48`
- `SandboxApprovalModal.svelte:22-50`
- `GpuWarningDialog.svelte:19-37`

All three render an `{#if open}` (or pending-store check), a fixed backdrop, a centred dialog, and a footer with one or more action buttons. Resolved by the `Modal.svelte` extraction in T-1.

---

### T-8 — Email-account resolution + missing-account error triplicated (Severity 6)

**Locations**
- `src/lib/agent/tools/email.ts:108, 113-115` (`email_list_recent`)
- `src/lib/agent/tools/email.ts:189, 191-193` (`email_summarize_message`)
- `src/lib/agent/tools/email.ts:303-305` (`email_read_full`)

Each block calls `resolveEmailAccounts(accountId)`, checks `.length === 0`, then returns the same templated error.

**Fix:** Add to the top of `email.ts`:

```ts
function ensureEmailAccount(accountId?: string): EmailAccount[] | ToolResultObject {
	const accounts = resolveEmailAccounts(accountId);
	if (accounts.length === 0) {
		return toolResult(
			toolError(
				accountId
					? `No enabled email account with id ${accountId}.`
					: 'No email accounts are enabled. Ask the user to add one in Settings → Integrations.'
			)
		);
	}
	return accounts;
}
```

Call site:
```ts
const result = ensureEmailAccount(accountId);
if (!Array.isArray(result)) return result;
const accounts = result;
```

---

### T-9 — `try { invoke(...) } catch (e) { return toolResult(toolError(...)) }` everywhere (Severity 6)

**Scope:** every `execute` in `fs-read.ts`, `fs-write.ts`, `email.ts`, `web.ts`, `sandbox.ts`, `python-lint.ts` — 40+ blocks.

**Fix (optional, lower priority than T-6):** A typed wrapper at `src/lib/agent/tools/_invoke.ts`:

```ts
export async function safeInvoke<T>(cmd: string, args: Record<string, unknown>): Promise<T | string> {
	try { return await invoke<T>(cmd, args); }
	catch (e) { return `${cmd} failed: ${e}`; }
}
```

Then `const out = await safeInvoke<string>('fs_read', { path });` followed by `if (typeof out === 'string' && out.startsWith(\`${cmd} failed\`)) ...`. Note: this loses some specificity; consider whether the cure beats the disease. If you adopt T-6 only, the bulk of the win is already captured.

---

### T-10 — `getSettings().X` repeated 11× to seed reactive state (Severity 5)

**Location:** `src/routes/settings/+page.svelte:61-91`.

```ts
let responseFormat = $state<ResponseFormat>(getSettings().responseFormat);
let theme = $state<ThemeMode>(getSettings().theme);
// ... 9 more
```

**Fix:** A single destructure cuts repetition without changing reactivity:

```ts
const s = getSettings();
let responseFormat = $state<ResponseFormat>(s.responseFormat);
let theme = $state<ThemeMode>(s.theme);
let ttsVoice = $state(s.ttsVoice);
// ...
let proxyMode = $state<ProxyMode>(s.proxy.mode);
let proxyUrl = $state(s.proxy.url);
let proxyBypass = $state(s.proxy.bypass);
```

Cosmetic but a real readability win in a 30+ line block. The deeper fix — a `useSettingsField('theme')` helper — buys little because the page already commits on each `onchange`.

---

### T-11 — Sampling-param block duplicated (Severity 5)

**Locations:** `web.ts:192-201`, `email.ts:232-241`. Subsumed by T-2.

---

### T-12 — `displayLabel: (args) => (args.X as string) || ''` at 40+ sites (Severity 3)

**Locations:** every `registerTool` call across `fs-read.ts`, `fs-write.ts`, `web.ts`, `email.ts`, `sandbox.ts`, `python-lint.ts`.

**Fix:** Helper in `src/lib/agent/tools/registry.ts`:

```ts
export const labelArg = (key: string) => (args: Record<string, unknown>) => (args[key] as string) ?? '';
```

Use: `displayLabel: labelArg('path')`. Minor, but worth ~40 fewer arrow functions.

---

## Proposed New Utility Modules

Two new files cover ~80 % of the proposed extractions. Neither requires new dependencies.

### 1. `src-tauri/src/sidecar_utils.rs`

```rust
use std::collections::VecDeque;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;
use tracing::{info, warn};

pub mod ports {
    pub const LLAMA: u16 = 8765;
    pub const WHISPER: u16 = 8766;
    pub const TTS: u16 = 3001;
}

pub mod timing {
    use std::time::Duration;
    pub const HEALTH_POLL_INTERVAL: Duration = Duration::from_millis(500);
    pub const HEALTH_POLL_TIMEOUT: Duration  = Duration::from_secs(60);
    pub const SHORT_HTTP_TIMEOUT: Duration   = Duration::from_secs(2);
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "kind", content = "message", rename_all = "lowercase")]
pub enum SidecarStatus { Stopped, Starting, Ready, Error(String) }

pub type LogBuffer = Arc<Mutex<VecDeque<String>>>;
pub fn new_log_buffer(cap: usize) -> LogBuffer {
    Arc::new(Mutex::new(VecDeque::with_capacity(cap)))
}

pub fn strip_ansi(s: &str) -> String { /* … */ }
pub fn push_log(buf: &mut VecDeque<String>, line: &str, cap: usize) { /* … */ }

pub fn http_client(timeout: Duration) -> reqwest::Client {
    reqwest::Client::builder().timeout(timeout).build().expect("reqwest")
}

pub async fn kill_process_on_port(port: u16, name: &str) { /* … */ }
pub async fn wait_for_port_release(port: u16, attempts: usize, interval: Duration) { /* … */ }

pub async fn poll_health<F, Fut>(
    url: &str, timeout: Duration, interval: Duration, name: &'static str, mut keep_going: F,
) -> bool
where F: FnMut() -> Fut, Fut: std::future::Future<Output = bool> { /* … */ }
```

Wire it in `src-tauri/src/lib.rs`:
```rust
mod sidecar_utils;
```

### 2. `src/lib/agent/tools/_helpers.ts`

```ts
import { invoke } from '@tauri-apps/api/core';
import { chatCompletion, type ChatMessage } from '$lib/api';
import { getSamplingParams, getChatTemplateKwargs, getSettings } from '$lib/stores/settings';
import { toolError } from './types';

export const labelArg = (key: string) =>
	(args: Record<string, unknown>) => (args[key] as string) ?? '';

export function toolInvokeError(command: string, e: unknown): string {
	return toolError(`${command} failed: ${e instanceof Error ? e.message : e}`);
}

export async function runSubAgent(
	messages: ChatMessage[],
	maxTokens: number,
	signal?: AbortSignal
): Promise<string> {
	const s = getSamplingParams();
	const resp = await chatCompletion(
		{
			messages,
			temperature: s.temperature, top_p: s.top_p, top_k: s.top_k,
			presence_penalty: s.presence_penalty,
			max_tokens: maxTokens,
			chat_template_kwargs: getChatTemplateKwargs()
		},
		signal
	);
	return resp.content?.trim() ?? '';
}

export async function proxyFetch(url: string, caller: string): Promise<string> {
	return invoke<string>('proxy_fetch', { url, caller, proxy: getSettings().proxy });
}
```

---

## What I Could Not Verify

- **Cross-language schema duplication.** The TS tool JSON-Schemas (`fs-write.ts:262-291`, etc.) closely mirror the Rust argument structs in `fs_tools.rs`, but I did not read the Rust counterpart for each tool. Confirming would require matching every `#[derive(Deserialize)]` struct in `fs_tools.rs` and friends against the TS `parameters` block. Worth a follow-up pass.
- **Frontend setup/settings overlap.** I only deeply inspected `/routes/settings/+page.svelte`. The same `getSettings()` seeding pattern likely lives in `/routes/setup/+page.svelte`; would need to read it to confirm count and shape.
- **Severity of T-9 vs T-6.** I rated T-9 conservatively at 6 because the wrapper trades specificity for terseness. A code review on a representative `execute` body would settle whether to apply T-9 broadly or keep it limited to T-6.

---

## Suggested Order of Work

1. **R-3** (`strip_ansi`/`push_log`) — smallest, lowest risk; warms up the `sidecar_utils` module.
2. **R-5** (`SidecarStatus` enum) — needed before R-1/R-2 can share types cleanly.
3. **R-1** + **R-6** (`kill_process_on_port`, `wait_for_port_release`).
4. **R-2** (`poll_health`).
5. **R-7**, **R-9**, **R-10** (HTTP client / ports / format helpers) — fall-out from sidecar_utils.
6. **T-3** + **T-4** + **T-6** (spreadsheet schema, write executor, error helper) — low risk, contained to `fs-write.ts` + `types.ts`.
7. **T-2** + **T-11** + **T-5** (sub-agent + proxyFetch helpers).
8. **T-1** + **T-7** (Modal primitive).
9. **R-4** (`download_with_resume`) — touches user-facing progress events, schedule a manual smoke test.
10. **R-8**, **T-8**, **T-9**, **T-10**, **T-12** — polish.

Each step is independently mergeable; release-please will compute a minor bump per `refactor:`-prefixed commit batch (see CLAUDE.md / Conventional Commits).
