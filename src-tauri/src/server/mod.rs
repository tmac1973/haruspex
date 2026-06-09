use log::{error, info, warn};
use serde::Serialize;
use std::collections::VecDeque;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;
use tokio::sync::Mutex;

use crate::sidecar_utils::{
    self, kill_process_on_port, ports, push_log, strip_ansi, wait_for_port_release, SidecarStatus,
    LOG_RING_BUFFER_SIZE,
};

mod crash_telemetry;
mod log_classifier;
use log_classifier::{classify, LogSignal};

const HEALTH_POLL_TIMEOUT: Duration = Duration::from_secs(60);

/// Lifecycle state of the llama-server sidecar. Type alias onto
/// `SidecarStatus` so all three sidecars share one wire shape.
pub type ServerStatus = SidecarStatus;

/// Surfaced to the UI when the CPU-fallback respawn succeeds. The banner
/// in the chat header reads `reason` so the user can see *why* their
/// 5080 isn't being used (typically VRAM exhaustion at mmproj load), and
/// the "Restart on GPU" action calls stop+start to retry.
#[derive(Clone, Debug, Serialize)]
pub struct GpuFallbackState {
    /// First GPU-related error line captured from llama-server stderr —
    /// usually the most informative root-cause line (e.g. the
    /// `Device memory allocation of size X failed` log that precedes the
    /// abort). ANSI codes are stripped before storage.
    pub reason: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct ServerConfig {
    pub port: u16,
    pub ctx_size: u32,
    pub n_gpu_layers: i32,
    pub flash_attn: bool,
    pub extra_args: Vec<String>,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            port: ports::LLAMA,
            // Placeholder for the pre-start `LlamaServer::new()` state only;
            // every real `start_server` overrides this with the caller's
            // value. The user-facing default lives in TS (`DEFAULT_CONTEXT_SIZE`).
            ctx_size: 16384,
            n_gpu_layers: 99,
            flash_attn: true,
            extra_args: Vec::new(),
        }
    }
}

impl ServerConfig {
    pub fn build_args(&self, model_path: &str) -> Vec<String> {
        let mut args = vec![
            "--model".to_string(),
            model_path.to_string(),
            "--port".to_string(),
            self.port.to_string(),
            "--ctx-size".to_string(),
            self.ctx_size.to_string(),
            "--n-gpu-layers".to_string(),
            self.n_gpu_layers.to_string(),
            "--cache-type-k".to_string(),
            "q8_0".to_string(),
            "--cache-type-v".to_string(),
            "q8_0".to_string(),
            // Haruspex only runs one conversation through llama-server at a
            // time, so we don't benefit from multiple parallel slots. Forcing
            // --parallel 1 gives the single slot the full KV budget and
            // eliminates the "failed to find free space in the KV cache /
            // purging slot N" warnings that show up in stderr whenever stale
            // slots from earlier turns get evicted to make room for a new
            // batch.
            "--parallel".to_string(),
            "1".to_string(),
            "--jinja".to_string(),
            "--host".to_string(),
            "127.0.0.1".to_string(),
        ];

        args.push("--flash-attn".to_string());
        args.push(if self.flash_attn { "on" } else { "off" }.to_string());

        args.extend(self.extra_args.clone());
        args
    }
}

struct ServerInner {
    child: Option<CommandChild>,
    status: ServerStatus,
    config: ServerConfig,
    log_buffer: VecDeque<String>,
    gpu_fallback_attempted: bool,
    gpu_error_detected: bool,
    /// First GPU-error stderr line captured during the current start
    /// attempt. Kept across the in-process fallback respawn so the UI
    /// banner can show the root cause; cleared on the next manual
    /// `start()` call (so a successful retry hides the banner).
    gpu_error_reason: Option<String>,
    /// True once a CPU-fallback respawn has actually been launched.
    /// Drives the "Running on CPU" banner. Cleared on the next manual
    /// `start()` call.
    cpu_fallback_active: bool,
    generation: u64, // incremented on each start, used to ignore stale events
    /// When the current child process was spawned — used to report uptime in
    /// crash telemetry (how long it survived before dying).
    started_at: Option<Instant>,
}

impl ServerInner {
    /// Inspect a stderr line for a GPU-init failure and arm the CPU-fallback
    /// path. Keeps the *first* matching line as the reason — it's almost
    /// always the most informative root cause (e.g. `Device memory allocation
    /// of size X failed`); subsequent lines are downstream effects (assert
    /// aborts, buffer alloc retries) that read worse out of context.
    fn note_stderr_gpu_error(&mut self, line_str: &str) {
        if classify(line_str) == LogSignal::GpuError && !self.gpu_fallback_attempted {
            warn!("GPU error detected, will attempt CPU fallback on exit");
            self.gpu_error_detected = true;
            if self.gpu_error_reason.is_none() {
                let cleaned = strip_ansi(line_str).trim().to_string();
                if !cleaned.is_empty() {
                    self.gpu_error_reason = Some(cleaned);
                }
            }
        }
    }
}

pub struct LlamaServer {
    inner: Arc<Mutex<ServerInner>>,
}

impl LlamaServer {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(ServerInner {
                child: None,
                status: ServerStatus::Stopped,
                config: ServerConfig::default(),
                log_buffer: VecDeque::with_capacity(LOG_RING_BUFFER_SIZE),
                gpu_fallback_attempted: false,
                gpu_error_detected: false,
                gpu_error_reason: None,
                cpu_fallback_active: false,
                generation: 0,
                started_at: None,
            })),
        }
    }

    async fn set_status(&self, status: ServerStatus, app: &AppHandle) {
        let mut inner = self.inner.lock().await;
        if inner.status != status {
            inner.status = status.clone();
            let _ = app.emit("server-status-changed", &status);
        }
    }

    pub async fn start(
        &self,
        app: &AppHandle,
        model_path: &str,
        config: Option<ServerConfig>,
    ) -> Result<(), String> {
        // Stop any existing instance first
        self.stop().await?;

        let config = config.unwrap_or_default();

        // Kill any orphaned process on the port (e.g., from a previous hot-reload)
        kill_process_on_port(config.port, "llama-server").await;

        if !Path::new(model_path).exists() {
            let msg = format!("Model file not found: {}", model_path);
            self.set_status(ServerStatus::Error(msg.clone()), app).await;
            return Err(msg);
        }

        {
            let mut inner = self.inner.lock().await;
            inner.config = config;
            inner.gpu_fallback_attempted = false;
            inner.gpu_error_detected = false;
            inner.gpu_error_reason = None;
            inner.cpu_fallback_active = false;
        }
        // Banner clears as soon as a fresh start begins, regardless of
        // whether this attempt ultimately ends up on GPU or falls back
        // again. The frontend store wipes its own copy on `startServer()`,
        // but we also emit the cleared state so any other listener (or a
        // late `get_cpu_fallback_state` poll) sees the truth.
        let _ = app.emit("gpu-fallback-cleared", ());

        self.spawn_and_monitor(app, model_path).await
    }

    async fn spawn_and_monitor(&self, app: &AppHandle, model_path: &str) -> Result<(), String> {
        self.set_status(ServerStatus::Starting, app).await;

        let args = Self::build_llama_args(app, &self.inner, model_path).await;

        info!("Starting llama-server with args: {:?}", args);

        let (rx, child) = Self::spawn_llama(app, &args)?;

        let gen = {
            let mut inner = self.inner.lock().await;
            inner.child = Some(child);
            inner.started_at = Some(Instant::now());
            inner.generation += 1;
            inner.generation
        };

        // Spawn stdout/stderr reader
        Self::spawn_output_reader(
            self.inner.clone(),
            app.clone(),
            model_path.to_string(),
            rx,
            gen,
        );

        // Spawn health poller
        Self::spawn_health_poller(self.inner.clone(), app.clone(), gen);

        Ok(())
    }

    /// Build the llama-server CLI args for `model_path`: the configured base
    /// args plus `--mmproj` when the model has a multimodal projector. Shared
    /// by the initial spawn and both respawn paths (CPU fallback, auto-restart).
    async fn build_llama_args(
        app: &AppHandle,
        inner: &Arc<Mutex<ServerInner>>,
        model_path: &str,
    ) -> Vec<String> {
        let mmproj_path = {
            use tauri::Manager;
            app.try_state::<crate::models::ModelManager>()
                .and_then(|mgr| mgr.find_mmproj_for_model(std::path::Path::new(model_path)))
        };
        let state = inner.lock().await;
        let mut args = state.config.build_args(model_path);
        if let Some(path) = mmproj_path.as_ref() {
            args.push("--mmproj".to_string());
            args.push(path.to_string_lossy().to_string());
            info!("Vision projector enabled: {}", path.display());
        }
        args
    }

    /// Spawn the llama-server sidecar with `args` and the platform library
    /// paths applied. Returns the event stream + child handle. Shared by the
    /// initial spawn and both respawn paths.
    fn spawn_llama(
        app: &AppHandle,
        args: &[String],
    ) -> Result<
        (
            tauri::async_runtime::Receiver<tauri_plugin_shell::process::CommandEvent>,
            CommandChild,
        ),
        String,
    > {
        let cmd = app
            .shell()
            .sidecar("llama-server")
            .map_err(|e| format!("Failed to create sidecar command: {}", e))?
            .args(args);
        sidecar_utils::with_library_paths(cmd, app)
            .spawn()
            .map_err(|e| format!("Failed to spawn llama-server: {}", e))
    }

    fn spawn_output_reader(
        inner: Arc<Mutex<ServerInner>>,
        app: AppHandle,
        model_path: String,
        mut rx: tauri::async_runtime::Receiver<tauri_plugin_shell::process::CommandEvent>,
        generation: u64,
    ) {
        tauri::async_runtime::spawn(async move {
            use tauri_plugin_shell::process::CommandEvent;

            while let Some(event) = rx.recv().await {
                match event {
                    CommandEvent::Stdout(line) => {
                        let line_str = String::from_utf8_lossy(&line).to_string();
                        info!("llama-server: {}", line_str);
                        let mut state = inner.lock().await;
                        push_log(&mut state.log_buffer, &line_str);
                    }
                    CommandEvent::Stderr(line) => {
                        let line_str = String::from_utf8_lossy(&line).to_string();
                        warn!("llama-server stderr: {}", line_str);
                        let mut state = inner.lock().await;
                        push_log(&mut state.log_buffer, &format!("[stderr] {}", line_str));
                        state.note_stderr_gpu_error(&line_str);
                    }
                    CommandEvent::Terminated(payload) => {
                        Self::handle_termination(
                            &inner,
                            &app,
                            &model_path,
                            generation,
                            payload.code,
                            payload.signal,
                        )
                        .await;
                        // The process is gone; this reader's rx is spent. Any
                        // recovery path has already spawned a fresh reader.
                        return;
                    }
                    CommandEvent::Error(err) => {
                        error!("llama-server error: {}", err);
                        let mut state = inner.lock().await;
                        push_log(&mut state.log_buffer, &format!("[error] {}", err));
                    }
                    _ => {}
                }
            }
        });
    }

    /// Handle a `Terminated` event for `generation`: skip stale generations,
    /// record crash telemetry, then route to exactly one recovery path
    /// (CPU fallback, auto-restart) or report a terminal error.
    async fn handle_termination(
        inner: &Arc<Mutex<ServerInner>>,
        app: &AppHandle,
        model_path: &str,
        generation: u64,
        code: Option<i32>,
        signal: Option<i32>,
    ) {
        let exit_code = code.unwrap_or(-1);
        info!(
            "llama-server (gen {}) exited with code: {} signal: {:?}",
            generation, exit_code, signal
        );

        // Ignore termination events from old generations.
        {
            let state = inner.lock().await;
            if state.generation != generation {
                info!(
                    "Ignoring stale termination event from generation {}",
                    generation
                );
                return;
            }
        }

        // Capture a post-mortem before any recovery logic mutates state.
        if let Some(report) =
            Self::capture_crash_report(inner, code, signal, generation, model_path).await
        {
            crash_telemetry::record(app, &report);
        }

        if Self::take_gpu_fallback(inner).await {
            Self::respawn_cpu_fallback(inner, app, model_path, generation).await;
            return;
        }

        // Crashed mid-operation: if the server was Ready and this wasn't a
        // clean stop, attempt one auto-restart. This recovers from in-request
        // crashes (e.g. image batch overflow during vision processing) without
        // requiring the user to manually restart.
        let should_auto_restart = {
            let state = inner.lock().await;
            matches!(state.status, ServerStatus::Ready)
        };
        if should_auto_restart {
            Self::respawn_auto_restart(inner, app, model_path, generation).await;
            return;
        }

        // Not a recovery situation — report error.
        let mut state = inner.lock().await;
        if state.status != ServerStatus::Stopped {
            state.status = ServerStatus::Error(format!("Server exited with code {}", exit_code));
            let _ = app.emit("server-status-changed", &state.status);
        }
    }

    /// Build a crash post-mortem from the current state, or `None` for a clean
    /// stop (status already `Stopped`) or a non-crash exit. A clean stop sets
    /// the status to `Stopped` first, so we skip those; anything else (a crash
    /// signal, or a non-zero exit while Starting/Ready) is recorded with the
    /// last stderr lines — where llama.cpp prints the abort reason.
    async fn capture_crash_report(
        inner: &Arc<Mutex<ServerInner>>,
        code: Option<i32>,
        signal: Option<i32>,
        generation: u64,
        model_path: &str,
    ) -> Option<crash_telemetry::CrashReport> {
        let state = inner.lock().await;
        let clean_stop = state.status == ServerStatus::Stopped;
        let crashed = signal
            .map(crash_telemetry::is_crash_signal)
            .unwrap_or(false)
            || code.map(|c| c != 0).unwrap_or(true);
        if clean_stop || !crashed {
            return None;
        }
        Some(crash_telemetry::CrashReport {
            generation,
            code,
            signal,
            status_before: format!("{:?}", state.status),
            model_path: model_path.to_string(),
            n_gpu_layers: state.config.n_gpu_layers,
            ctx_size: state.config.ctx_size,
            flash_attn: state.config.flash_attn,
            cpu_fallback_active: state.cpu_fallback_active,
            uptime_secs: state.started_at.map(|t| t.elapsed().as_secs()),
            recent_log: state
                .log_buffer
                .iter()
                .rev()
                .take(crash_telemetry::TAIL_LINES)
                .rev()
                .cloned()
                .collect(),
        })
    }

    /// Clear the dead child and decide whether to attempt a one-shot CPU
    /// fallback. Returns `true` (and arms the fallback flags) only when a GPU
    /// error was detected during a `Starting` attempt that used GPU layers.
    async fn take_gpu_fallback(inner: &Arc<Mutex<ServerInner>>) -> bool {
        let mut state = inner.lock().await;
        state.child = None;
        if state.status == ServerStatus::Starting
            && !state.gpu_fallback_attempted
            && state.gpu_error_detected
            && state.config.n_gpu_layers != 0
        {
            state.gpu_fallback_attempted = true;
            state.gpu_error_detected = false;
            state.config.n_gpu_layers = 0;
            true
        } else {
            false
        }
    }

    /// Respawn on CPU (`--n-gpu-layers 0`) after a GPU-init failure and surface
    /// the captured reason to the UI banner. The health poller is still running
    /// and will pick up the new process, so we only spawn a fresh reader.
    async fn respawn_cpu_fallback(
        inner: &Arc<Mutex<ServerInner>>,
        app: &AppHandle,
        model_path: &str,
        generation: u64,
    ) {
        warn!("Attempting CPU fallback (--n-gpu-layers 0)");
        let args = Self::build_llama_args(app, inner, model_path).await;
        match Self::spawn_llama(app, &args) {
            Ok((new_rx, new_child)) => {
                let fallback_state = {
                    let mut state = inner.lock().await;
                    state.child = Some(new_child);
                    state.started_at = Some(Instant::now());
                    state.cpu_fallback_active = true;
                    // Reason was captured from the pre-abort stderr; if none
                    // was matched, fall back to a generic message so the banner
                    // still has something to display.
                    let reason = state.gpu_error_reason.clone().unwrap_or_else(|| {
                        "GPU initialization failed — running on CPU.".to_string()
                    });
                    GpuFallbackState { reason }
                };
                let _ = app.emit("gpu-fallback-active", &fallback_state);
                Self::spawn_output_reader(
                    inner.clone(),
                    app.clone(),
                    model_path.to_string(),
                    new_rx,
                    generation,
                );
            }
            Err(e) => {
                error!("CPU fallback failed: {}", e);
                let mut state = inner.lock().await;
                state.status = ServerStatus::Error(format!("CPU fallback failed: {}", e));
                let _ = app.emit("server-status-changed", &state.status);
            }
        }
    }

    /// Respawn after a mid-operation crash while `Ready`. Moves status back to
    /// `Starting` and restarts both the reader and the health poller for the
    /// new process.
    async fn respawn_auto_restart(
        inner: &Arc<Mutex<ServerInner>>,
        app: &AppHandle,
        model_path: &str,
        generation: u64,
    ) {
        warn!("llama-server crashed while Ready — attempting auto-restart");
        {
            let mut state = inner.lock().await;
            state.status = ServerStatus::Starting;
            let _ = app.emit("server-status-changed", &state.status);
        }
        let args = Self::build_llama_args(app, inner, model_path).await;
        match Self::spawn_llama(app, &args) {
            Ok((new_rx, new_child)) => {
                {
                    let mut state = inner.lock().await;
                    state.child = Some(new_child);
                    state.started_at = Some(Instant::now());
                }
                Self::spawn_output_reader(
                    inner.clone(),
                    app.clone(),
                    model_path.to_string(),
                    new_rx,
                    generation,
                );
                Self::spawn_health_poller(inner.clone(), app.clone(), generation);
            }
            Err(e) => {
                error!("Auto-restart failed: {}", e);
                let mut state = inner.lock().await;
                state.status = ServerStatus::Error(format!("Auto-restart failed: {}", e));
                let _ = app.emit("server-status-changed", &state.status);
            }
        }
    }

    fn spawn_health_poller(inner: Arc<Mutex<ServerInner>>, app: AppHandle, generation: u64) {
        tauri::async_runtime::spawn(async move {
            let port = {
                let state = inner.lock().await;
                state.config.port
            };
            let url = sidecar_utils::health_url(port);

            // keep_going: bail if this poller's generation is stale (a
            // newer start() has taken over) or if the status has moved
            // off Starting (e.g. an explicit stop or an early error).
            let inner_for_keep = Arc::clone(&inner);
            let ok = sidecar_utils::poll_health(
                &url,
                "llama-server",
                HEALTH_POLL_TIMEOUT,
                false,
                move || {
                    let s = Arc::clone(&inner_for_keep);
                    async move {
                        let state = s.lock().await;
                        state.generation == generation && state.status == ServerStatus::Starting
                    }
                },
            )
            .await;

            let mut state = inner.lock().await;
            if state.generation != generation {
                return; // stale poller; another start() has taken over
            }
            if ok {
                if state.status == ServerStatus::Starting {
                    state.status = ServerStatus::Ready;
                    let _ = app.emit("server-status-changed", &ServerStatus::Ready);
                }
            } else if state.status == ServerStatus::Starting {
                let msg = "Health check timed out after 60 seconds".to_string();
                error!("{}", msg);
                state.status = ServerStatus::Error(msg.clone());
                let _ = app.emit("server-status-changed", &ServerStatus::Error(msg));
            }
        });
    }

    pub async fn stop(&self) -> Result<(), String> {
        let port = {
            let mut inner = self.inner.lock().await;
            let port = inner.config.port;
            if let Some(child) = inner.child.take() {
                info!("Stopping llama-server");
                child
                    .kill()
                    .map_err(|e| format!("Failed to kill llama-server: {}", e))?;
            }
            inner.status = ServerStatus::Stopped;
            port
        };

        wait_for_port_release(port).await;
        Ok(())
    }

    pub async fn get_status(&self) -> ServerStatus {
        let inner = self.inner.lock().await;
        inner.status.clone()
    }

    pub async fn get_logs(&self) -> Vec<String> {
        let inner = self.inner.lock().await;
        inner.log_buffer.iter().cloned().collect()
    }

    pub async fn clear_logs(&self) {
        let mut inner = self.inner.lock().await;
        inner.log_buffer.clear();
    }

    pub async fn get_cpu_fallback_state(&self) -> Option<GpuFallbackState> {
        let inner = self.inner.lock().await;
        if !inner.cpu_fallback_active {
            return None;
        }
        let reason = inner
            .gpu_error_reason
            .clone()
            .unwrap_or_else(|| "GPU initialization failed — running on CPU.".to_string());
        Some(GpuFallbackState { reason })
    }
}

// Tauri commands

#[tauri::command]
pub async fn start_server(
    app: AppHandle,
    state: tauri::State<'_, LlamaServer>,
    model_path: String,
    // Required: the TS caller always resolves this to `DEFAULT_CONTEXT_SIZE`
    // before invoking, so there's a single user-facing default (audit X4).
    ctx_size: u32,
    extra_args: Option<Vec<String>>,
) -> Result<(), String> {
    let config = ServerConfig {
        ctx_size,
        extra_args: extra_args.unwrap_or_default(),
        ..Default::default()
    };
    state.start(&app, &model_path, Some(config)).await
}

#[tauri::command]
pub async fn stop_server(state: tauri::State<'_, LlamaServer>) -> Result<(), String> {
    state.stop().await
}

#[tauri::command]
pub async fn get_server_status(state: tauri::State<'_, LlamaServer>) -> Result<ServerStatus, ()> {
    Ok(state.get_status().await)
}

#[tauri::command]
pub async fn get_server_logs(state: tauri::State<'_, LlamaServer>) -> Result<Vec<String>, ()> {
    Ok(state.get_logs().await)
}

#[tauri::command]
pub async fn clear_server_logs(state: tauri::State<'_, LlamaServer>) -> Result<(), ()> {
    state.clear_logs().await;
    Ok(())
}

#[tauri::command]
pub async fn get_cpu_fallback_state(
    state: tauri::State<'_, LlamaServer>,
) -> Result<Option<GpuFallbackState>, ()> {
    Ok(state.get_cpu_fallback_state().await)
}

/// Read the persisted llama-server crash log (empty string if none yet).
#[tauri::command]
pub fn get_llama_crash_log(app: AppHandle) -> String {
    crash_telemetry::read(&app)
}

/// Path to the crash log file, so the UI can point the user at it on disk.
#[tauri::command]
pub fn get_llama_crash_log_path(app: AppHandle) -> Option<String> {
    crash_telemetry::crash_log_path(&app).map(|p| p.to_string_lossy().to_string())
}

/// Delete the persisted crash log.
#[tauri::command]
pub fn clear_llama_crash_log(app: AppHandle) {
    crash_telemetry::clear(&app);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_values() {
        let config = ServerConfig::default();
        assert_eq!(config.port, 8765);
        assert_eq!(config.ctx_size, 16384);
        assert_eq!(config.n_gpu_layers, 99);
        assert!(config.flash_attn);
        assert!(config.extra_args.is_empty());
    }

    #[test]
    fn build_args_includes_all_flags() {
        let config = ServerConfig::default();
        let args = config.build_args("/path/to/model.gguf");

        assert!(args.contains(&"--model".to_string()));
        assert!(args.contains(&"/path/to/model.gguf".to_string()));
        assert!(args.contains(&"--port".to_string()));
        assert!(args.contains(&"8765".to_string()));
        assert!(args.contains(&"--ctx-size".to_string()));
        assert!(args.contains(&"16384".to_string()));
        assert!(args.contains(&"--n-gpu-layers".to_string()));
        assert!(args.contains(&"99".to_string()));
        assert!(args.contains(&"--flash-attn".to_string()));
        assert!(args.contains(&"on".to_string()));
        assert!(args.contains(&"--cache-type-k".to_string()));
        assert!(args.contains(&"q8_0".to_string()));
        // Parallel must be pinned to 1 — Haruspex only runs one conversation
        // through llama-server at a time and the KV cache gets fragmented by
        // stale slots otherwise, producing "failed to find free space"
        // warnings in stderr.
        assert!(args.contains(&"--parallel".to_string()));
        let parallel_idx = args.iter().position(|a| a == "--parallel").unwrap();
        assert_eq!(args[parallel_idx + 1], "1");
        assert!(args.contains(&"--jinja".to_string()));
        assert!(args.contains(&"--host".to_string()));
        assert!(args.contains(&"127.0.0.1".to_string()));
    }

    #[test]
    fn build_args_without_flash_attn() {
        let config = ServerConfig {
            flash_attn: false,
            ..Default::default()
        };
        let args = config.build_args("/path/to/model.gguf");
        assert!(args.contains(&"--flash-attn".to_string()));
        assert!(args.contains(&"off".to_string()));
        assert!(!args.contains(&"on".to_string()));
    }

    #[test]
    fn build_args_cpu_only() {
        let config = ServerConfig {
            n_gpu_layers: 0,
            ..Default::default()
        };
        let args = config.build_args("/path/to/model.gguf");
        assert!(args.contains(&"0".to_string()));
    }

    #[test]
    fn build_args_extra_args() {
        let config = ServerConfig {
            extra_args: vec![
                "--verbose".to_string(),
                "--threads".to_string(),
                "4".to_string(),
            ],
            ..Default::default()
        };
        let args = config.build_args("/path/to/model.gguf");
        assert!(args.contains(&"--verbose".to_string()));
        assert!(args.contains(&"--threads".to_string()));
        assert!(args.contains(&"4".to_string()));
    }

    #[test]
    fn log_buffer_capacity() {
        let mut inner = ServerInner {
            child: None,
            status: ServerStatus::Stopped,
            config: ServerConfig::default(),
            log_buffer: VecDeque::with_capacity(LOG_RING_BUFFER_SIZE),
            gpu_fallback_attempted: false,
            gpu_error_detected: false,
            gpu_error_reason: None,
            cpu_fallback_active: false,
            generation: 0,
            started_at: None,
        };

        for i in 0..LOG_RING_BUFFER_SIZE + 100 {
            push_log(&mut inner.log_buffer, &format!("line {}", i));
        }

        assert_eq!(inner.log_buffer.len(), LOG_RING_BUFFER_SIZE);
        assert_eq!(inner.log_buffer.front().unwrap(), "line 100");
    }
}
