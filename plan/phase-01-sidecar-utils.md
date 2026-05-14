# Phase 01 — `sidecar_utils.rs` foundation

**Severity addressed:** 9 · **Effort:** ~3 hours · **Risk:** Low

Resolves duplication-audit findings R-1 (kill_process_on_port), R-2 (health-check polling), R-3 (strip_ansi / push_log), R-5 (status enum), R-6 (port-release wait), R-7 (reqwest client builder), R-10 (localhost format), and design-pattern P-4 / M-1 (missing sidecar abstraction).

## Goal

Create one shared module owning all three sidecars' duplicated infrastructure, then make `whisper.rs`, `tts.rs`, and `server.rs` consume it. Zero behavioural change — log lines, status events, and command surface are unchanged.

## Files touched

- **NEW** `src-tauri/src/sidecar_utils.rs`
- **EDIT** `src-tauri/src/lib.rs` (add `mod sidecar_utils;`)
- **EDIT** `src-tauri/src/whisper.rs` (replace local helpers)
- **EDIT** `src-tauri/src/tts.rs` (replace local helpers)
- **EDIT** `src-tauri/src/server.rs` (replace local helpers)

## Implementation

### Step 1 — create the module

```rust
// src-tauri/src/sidecar_utils.rs
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
    pub const HEALTH_POLL_TIMEOUT: Duration = Duration::from_secs(60);
    pub const SHORT_HTTP_TIMEOUT: Duration = Duration::from_secs(2);
    pub const PORT_RELEASE_INTERVAL: Duration = Duration::from_millis(100);
    pub const PORT_RELEASE_ATTEMPTS: usize = 20;
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "type", content = "message")]
pub enum SidecarStatus {
    Stopped,
    Starting,
    Ready,
    Error(String),
}

pub type LogBuffer = Arc<Mutex<VecDeque<String>>>;

pub fn new_log_buffer(cap: usize) -> LogBuffer {
    Arc::new(Mutex::new(VecDeque::with_capacity(cap)))
}

pub fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            for esc in chars.by_ref() {
                if esc.is_ascii_alphabetic() { break; }
            }
        } else {
            out.push(c);
        }
    }
    out
}

pub fn push_log(buf: &mut VecDeque<String>, line: &str, cap: usize) {
    if buf.len() >= cap { buf.pop_front(); }
    buf.push_back(strip_ansi(line));
}

pub fn http_client(timeout: Duration) -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .expect("reqwest::Client::builder")
}

fn localhost(port: u16) -> String { format!("127.0.0.1:{port}") }

pub async fn wait_for_port_release(port: u16) {
    for _ in 0..timing::PORT_RELEASE_ATTEMPTS {
        if std::net::TcpStream::connect(localhost(port)).is_err() { return; }
        tokio::time::sleep(timing::PORT_RELEASE_INTERVAL).await;
    }
}

pub async fn kill_process_on_port(port: u16, name: &str) {
    if std::net::TcpStream::connect(localhost(port)).is_err() {
        return;
    }
    warn!("{name}: port {port} occupied, killing existing process");

    #[cfg(unix)]
    if let Ok(output) = std::process::Command::new("lsof")
        .args(["-t", "-i", &format!(":{port}")])
        .output()
    {
        for pid_str in String::from_utf8_lossy(&output.stdout).trim().lines() {
            if let Ok(pid) = pid_str.trim().parse::<i32>() {
                info!("Killing process {pid} on port {port}");
                unsafe { libc::kill(pid, libc::SIGTERM); }
            }
        }
    }

    #[cfg(windows)]
    {
        // Lift the body of the matching cfg(windows) block from whisper.rs:91–119 here.
    }

    wait_for_port_release(port).await;
}

pub async fn poll_health<F, Fut>(
    url: &str,
    name: &'static str,
    mut keep_going: F,
) -> bool
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    let client = http_client(timing::SHORT_HTTP_TIMEOUT);
    let attempts = (timing::HEALTH_POLL_TIMEOUT.as_millis()
        / timing::HEALTH_POLL_INTERVAL.as_millis()) as usize;
    for _ in 0..attempts {
        if !keep_going().await { return false; }
        tokio::time::sleep(timing::HEALTH_POLL_INTERVAL).await;
        if let Ok(resp) = client.get(url).send().await {
            if resp.status().is_success() {
                info!("{name} health check passed");
                return true;
            }
        }
    }
    false
}
```

### Step 2 — wire `mod sidecar_utils;` into `lib.rs`

Add `mod sidecar_utils;` to the module list at the top of `src-tauri/src/lib.rs`.

### Step 3 — migrate `whisper.rs`

- Delete `strip_ansi`, `push_log`, `kill_process_on_port` (currently lines 32–47, 49–54, 65–121).
- Replace `use` block additions:
  ```rust
  use crate::sidecar_utils::{
      http_client, kill_process_on_port, new_log_buffer, poll_health, push_log,
      strip_ansi, timing, LogBuffer, SidecarStatus,
  };
  ```
- Replace the local `WhisperStatus` enum (lines 18–23) with `type WhisperStatus = SidecarStatus;` (keep the alias for now to avoid touching every consumer site in one PR).
- Update health check (lines 250–286) to call `poll_health(&url, "whisper", || async { *status.lock().await == SidecarStatus::Starting }).await`.
- Update the constructor's `log_buffer` field to use `new_log_buffer(LOG_RING_BUFFER_SIZE)`.

### Step 4 — migrate `tts.rs` analogously

Same edits as Step 3, targeting `TtsStatus` → `type TtsStatus = SidecarStatus`, helper lines 35–58 and 340–395.

### Step 5 — migrate `server.rs`

Same edits, plus: the `impl LlamaServer { fn strip_ansi … fn push_log … fn detect_gpu_error …}` block currently has these as private methods. Replace `Self::strip_ansi(s)` call sites with `strip_ansi(s)`, `Self::push_log(inner, line)` with `push_log(&mut inner.log_buffer, line, LOG_RING_BUFFER_SIZE)`, and `Self::kill_process_on_port(port)` with `kill_process_on_port(port, "llama-server")`.

### Step 6 — verify type alias compatibility

`SidecarStatus` serializes as `{ "type": "Stopped" | "Starting" | "Ready" | "Error", "message": "..." }`. Confirm by reading the frontend listener in `src/lib/stores/server.svelte.ts:51-60`:
- Current code does `payload.type.toLowerCase()` and `payload.type === 'Error'` — both forms are preserved by the `#[serde(tag = "type", content = "message")]` attribute above.
- **If the serde shape differs**, do not proceed — adjust serde attrs first.

## Build gate

```bash
cargo check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
npm run check
```

## Test plan

### Smoke

1. `GDK_BACKEND=x11 npm run tauri dev`
2. App launches. Server-status badge transitions from "stopped" → "starting" → "ready" within ~10 s.
3. Open Settings → Logs (or wherever the Log Viewer lives). Confirm all three tabs (LLM / Whisper / TTS) show log output.

### Targeted

4. **Port-kill path** — before launching the app, run a dummy listener on port 8765:
   ```bash
   python3 -m http.server 8765 &
   ```
   Launch the app. Confirm the log shows "llama-server: port 8765 occupied, killing existing process" and the sidecar then comes up. Kill the python process if it survived.
5. **Health-check timeout** — temporarily rename the `llama-server` binary so it can't spawn (e.g. `mv src-tauri/binaries/llama-server-* /tmp/`). Launch the app. Status should transition to `error` within ~60s. Restore the binary afterwards.
6. **Log ring buffer** — let the app run for 60 s while generating two long chat replies. Confirm the Log tab caps at the documented buffer size (no unbounded growth).

### Agent prompts (paste into chat)

- *"What is the capital of France?"* — exercises `/v1/chat/completions` on llama-server. Reply should arrive normally.
- Click the **mic** button, say "Hello, this is a test", stop recording. Whisper transcribes. The transcript text appears in the composer.
- Hit the speaker icon on an assistant reply. TTS plays audio. Confirm no errors in the koko log tab.

If all six steps pass, commit:

```
refactor: extract sidecar_utils for shared infra (#TBD)

Centralizes kill_process_on_port, strip_ansi/push_log, health
polling, the reqwest client builder, and a shared SidecarStatus
enum into src-tauri/src/sidecar_utils.rs. Deletes ~250 LOC of
duplication across whisper.rs / tts.rs / server.rs.

Resolves audits/code-duplication-2026-05-14.md R-1, R-2, R-3,
R-5, R-6, R-7, R-10 and design-patterns-2026-05-14.md P-4.
```
