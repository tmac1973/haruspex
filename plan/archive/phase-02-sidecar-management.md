# Phase 2: Sidecar Lifecycle Management

## Goal

Implement the Rust-side llama-server sidecar manager: spawning, health-checking, graceful shutdown, GPU-to-CPU fallback, and Tauri command bindings. The frontend gets a reactive server-status store. By the end, the app can launch llama-server, detect when it's healthy, and tear it down cleanly.

## Prerequisites

- Phase 1 complete
- A pre-compiled `llama-server` binary for the dev platform placed in `src-tauri/binaries/` (named with the correct Tauri target triple suffix)
- A GGUF model file available locally for testing

## Deliverables

- **User-testable**: Launch the app → status indicator shows "Starting…" then "Ready" (or "Error" with a message). Closing the app kills the sidecar process.

---

## Tasks

### 2.1 Rust sidecar manager (`src-tauri/src/server.rs`)

Implement `LlamaServer` struct with the following responsibilities:

```rust
pub struct LlamaServer {
    child: Option<Child>,
    port: u16,
    status: Arc<Mutex<ServerStatus>>,
}

#[derive(Clone, Serialize)]
pub enum ServerStatus {
    Stopped,
    Starting,
    Ready,
    Error(String),
}
```

**Methods:**

- `start(model_path: &Path, config: &ServerConfig) -> Result<()>`
  - Spawn `llama-server` via `tauri::api::process::Command::new_sidecar()`
  - Pass flags from architecture doc: `--model`, `--port`, `--ctx-size`, `--n-gpu-layers 99`, `--flash-attn`, `--cache-type-k q8_0`, `--cache-type-v q8_0`, `--jinja`, `--host 127.0.0.1`
  - Capture stdout/stderr to a ring buffer for the log viewer (Phase 7)
  - Set status to `Starting`

- `stop() -> Result<()>`
  - Send SIGTERM (Unix) / `taskkill` (Windows) to the child process
  - Wait with a 5-second timeout, then SIGKILL if still alive
  - Set status to `Stopped`

- `health_poll()`
  - Poll `GET http://127.0.0.1:{port}/health` every 500ms, up to 60 seconds
  - On 200 OK → set status to `Ready`, emit Tauri event `server-status-changed`
  - On timeout → set status to `Error("Health check timed out")`

- `restart_cpu_fallback()`
  - If `start()` fails or health check detects a Vulkan/Metal init error in stderr, retry with `--n-gpu-layers 0`
  - Log the fallback so the user knows they're on CPU

### 2.2 Configuration struct

```rust
pub struct ServerConfig {
    pub port: u16,             // default 8765
    pub ctx_size: u32,         // default 16384
    pub n_gpu_layers: i32,     // default 99 (auto)
    pub flash_attn: bool,      // default true
    pub extra_args: Vec<String>,
}
```

Implement `Default` for `ServerConfig`. Allow overrides from persisted settings (Phase 7).

### 2.3 Tauri commands

Register as Tauri commands in `main.rs`:

```rust
#[tauri::command]
async fn start_server(state: State<'_, LlamaServer>, model_path: String) -> Result<(), String>;

#[tauri::command]
async fn stop_server(state: State<'_, LlamaServer>) -> Result<(), String>;

#[tauri::command]
fn get_server_status(state: State<'_, LlamaServer>) -> ServerStatus;
```

Use `tauri::Manager::manage()` to register `LlamaServer` as app state.

### 2.4 Tauri event emission

Emit `server-status-changed` events whenever `ServerStatus` changes. The frontend subscribes to these.

### 2.5 Frontend server store (`src/lib/stores/server.ts`)

Svelte 5 runes-based store:

```typescript
interface ServerState {
  status: 'stopped' | 'starting' | 'ready' | 'error';
  errorMessage?: string;
  port: number;
  gpuAccelerated: boolean;
}
```

- On app mount, call `get_server_status` to sync initial state.
- Listen to `server-status-changed` Tauri events for reactive updates.
- Export `startServer(modelPath: string)` and `stopServer()` wrappers.

### 2.6 Status indicator component

A minimal `ServerStatusBadge.svelte`:

- Green dot + "Ready" when healthy
- Yellow dot + "Starting..." with a spinner when launching
- Red dot + error message when failed
- Place it in the app layout header

### 2.7 App lifecycle hooks

- On Tauri `window-close-requested` event → call `stop_server` before quitting
- On app startup → auto-start server if a model file exists (skip if first run — Phase 4 handles that)

---

## Test Coverage

| Area | What to test | Tool |
|---|---|---|
| ServerConfig | `Default::default()` produces expected values | cargo test |
| Spawn args | `LlamaServer::build_args()` generates correct CLI flags from config | cargo test |
| GPU fallback | When stderr contains Vulkan error, retry is triggered with `n_gpu_layers=0` | cargo test (mock stderr) |
| Health poll | Polls correct URL; transitions status on 200 / timeout | cargo test (mock HTTP) |
| Graceful shutdown | `stop()` sends signal and waits; status transitions to `Stopped` | cargo test |
| Tauri commands | Commands are registered and callable | cargo test (Tauri test utils) |
| Frontend store | Status updates propagate from Tauri events | Vitest (mock `@tauri-apps/api`) |
| Status badge | Renders correct indicator for each status variant | Vitest + @testing-library/svelte |

### Rust test strategy

Use trait-based abstraction for process spawning so tests can inject a mock:

```rust
#[cfg(test)]
mod tests {
    struct MockProcess { /* ... */ }
    impl Process for MockProcess { /* ... */ }
}
```

---

## Definition of Done

- [ ] `cargo tauri dev` with a model file present → server starts, badge shows "Ready"
- [ ] Closing the app window → llama-server process is terminated (verify with `ps`)
- [ ] If sidecar binary is missing → error status displayed, no crash
- [ ] GPU fallback: simulate by passing bad GPU flags → app recovers to CPU mode
- [ ] All unit tests pass (`cargo test` + `npm run test`)
- [ ] No clippy warnings
