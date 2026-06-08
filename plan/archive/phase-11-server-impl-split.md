# Phase 11 — `impl LlamaServer` decomposition

**Severity addressed:** 6 · **Effort:** ~3 hours · **Risk:** Medium

Resolves complexity-audit C-4 (672-line impl block) and C-12 (`spawn_output_reader` depth 10).

**Prerequisite:** Phase 01 complete. `sidecar_utils.rs` exists and `LlamaServer` already consumes the shared helpers, so the impl block is already ~500 LOC smaller than it was at audit time.

## Goal

Pull the two longest concerns out of `impl LlamaServer`:

1. **Log classification** — the inline GPU-error detection in `spawn_output_reader` (currently `server.rs:417-704`, depth 10) becomes a pure `classify_line(&str) -> LogSignal` function.
2. **Output reader async task** — `spawn_output_reader` becomes a thin spawn over a free `run_output_reader(...)` function.

After this phase, `impl LlamaServer` is ≤ 300 LOC and `spawn_output_reader` is ≤ 30 LOC.

## Files touched

- **EDIT** `src-tauri/src/server.rs`
- **NEW** `src-tauri/src/server/log_classifier.rs` — pure log-line classifier
- **NEW** `src-tauri/src/server/output_reader.rs` — async task body

If you want, promote `server.rs` to a module: `server/mod.rs` + the two new files. This is consistent with Phase 02 (`fs_tools/`) and Phase 06 (`proxy/`). Decide based on whether `server.rs` keeps growing — if it stays at ~600 LOC, a flat module is fine.

## Implementation

### Step 1 — `log_classifier.rs`

```rust
// src-tauri/src/server/log_classifier.rs (or top of server.rs as a child module)

pub const GPU_ERROR_PATTERNS: &[&str] = &[
    // lift from current server.rs GPU_ERROR_PATTERNS constant
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogSignal {
    GpuError,
    Ready,
    Plain,
}

pub fn classify(line: &str) -> LogSignal {
    let lower = line.to_lowercase();

    let has_gpu_keyword = GPU_ERROR_PATTERNS.iter().any(|p| lower.contains(p));
    let has_error_word = lower.contains("error") || lower.contains("fail") || lower.contains("not found");
    if has_gpu_keyword && has_error_word {
        return LogSignal::GpuError;
    }

    // ready needle — lift the exact substring server.rs uses today
    if line.contains("server is listening") /* or whichever marker triggers Ready */ {
        return LogSignal::Ready;
    }

    LogSignal::Plain
}
```

### Step 2 — `output_reader.rs`

```rust
// src-tauri/src/server/output_reader.rs
use std::sync::Arc;
use tauri::{AppHandle, Manager};
use tauri::async_runtime::Receiver;
use tauri_plugin_shell::process::CommandEvent;
use tokio::sync::Mutex;
use tracing::{error, info};

use crate::sidecar_utils::{push_log, SidecarStatus};
use super::ServerInner;            // crate::server::ServerInner if you flatten
use super::log_classifier::{classify, LogSignal};

pub async fn run_output_reader(
    inner: Arc<Mutex<ServerInner>>,
    mut rx: Receiver<CommandEvent>,
    app: AppHandle,
    generation: u64,
) {
    while let Some(event) = rx.recv().await {
        let line = match &event {
            CommandEvent::Stdout(b) | CommandEvent::Stderr(b) => {
                String::from_utf8_lossy(b).to_string()
            }
            _ => continue,
        };
        info!("llama-server: {line}");

        let mut state = inner.lock().await;
        if state.generation != generation {
            return; // a newer spawn has taken over; this reader is stale
        }
        push_log(&mut state.log_buffer, &line, crate::server::LOG_RING_BUFFER_SIZE);

        match classify(&line) {
            LogSignal::GpuError => {
                state.gpu_error_detected = true;
                state.gpu_error_reason = Some(extract_gpu_error_reason(&line));
                // existing on-detect behaviour from server.rs
            }
            LogSignal::Ready => {
                state.status = SidecarStatus::Ready;
                drop(state);
                let _ = app.emit("server-status-changed", &SidecarStatus::Ready);
            }
            LogSignal::Plain => {}
        }
    }
}

fn extract_gpu_error_reason(line: &str) -> String {
    // lift whatever extraction logic the current spawn_output_reader uses
    line.to_string()
}
```

### Step 3 — replace `LlamaServer::spawn_output_reader`

```rust
// server.rs
fn spawn_output_reader(
    inner: Arc<Mutex<ServerInner>>,
    app: AppHandle,
    _model_path: String,                  // kept if still used for logging
    rx: tauri::async_runtime::Receiver<tauri_plugin_shell::process::CommandEvent>,
    generation: u64,
) {
    tauri::async_runtime::spawn(async move {
        crate::server::output_reader::run_output_reader(inner, rx, app, generation).await;
    });
}
```

Or — better — make the spawn the caller's responsibility and delete the wrapper:

```rust
// in start() / spawn_and_monitor() body
tauri::async_runtime::spawn(run_output_reader(inner.clone(), rx, app.clone(), generation));
```

## Build gate

```bash
cargo check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```

## Test plan

### Smoke

1. App launches. Status badge transitions to `ready` within ~10 s.

### Targeted — log-classifier behaviour

2. **Normal start:** look at the LLM log tab. The "ready" needle line should be present; status badge is green/ready.
3. **GPU error simulated:**
   - Edit `~/.config/haruspex/...` (or wherever inference settings live) to force a bogus GPU layer count, OR
   - Launch with no GPU driver available (try `WGPU_BACKEND=null GDK_BACKEND=x11 npm run tauri dev` if Vulkan is the path),
   - Confirm:
     - The CPU-fallback banner appears.
     - The frontend receives a `gpu-fallback-active` event (visible if the banner shows up).
     - The classifier's `GpuError` path fired (check the App log for whatever debug line you wired into `extract_gpu_error_reason`).
4. **Recover:** dismiss the fallback banner. Manually restart the server (Settings → restart). New start emits `gpu-fallback-cleared`; banner goes away.

### Targeted — stale generation

5. **Hot restart:** in dev mode, save a frontend file to trigger HMR. The llama-server spawned by the previous Tauri instance gets killed and a new one spawned. Confirm the old reader's "stale generation" branch fires correctly (no panics, no double-emit of `Ready`). Inspect the App log for any `error` lines around the transition.

### Targeted — long runs

6. Run a 30-minute idle session. Check the LLM log buffer length — should cap at `LOG_RING_BUFFER_SIZE` rather than growing unbounded. (This is `push_log`'s job, already covered by Phase 01, but worth re-validating here.)

If 2–6 pass, commit:

```
refactor: extract log classifier and output reader from LlamaServer (#TBD)

GPU-error detection and the output-reader async task lifted out
of impl LlamaServer into src-tauri/src/server/{log_classifier,
output_reader}.rs. Reader depth drops from 10 → 4; impl block
shrinks to ~300 LOC. No behavioural change to status events,
GPU-fallback transitions, or log buffer.

Resolves audits/code-complexity-2026-05-14.md C-4, C-12.
```
