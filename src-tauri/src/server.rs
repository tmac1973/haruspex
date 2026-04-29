use log::{error, info, warn};
use serde::Serialize;
use std::collections::VecDeque;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;
use tokio::sync::Mutex;
use tokio::time::sleep;

const HEALTH_POLL_INTERVAL: Duration = Duration::from_millis(500);
const HEALTH_POLL_TIMEOUT: Duration = Duration::from_secs(60);
const LOG_RING_BUFFER_SIZE: usize = 1000;

// GPU error patterns that trigger CPU fallback
const GPU_ERROR_PATTERNS: &[&str] = &[
    "vulkan",
    "vk_",
    "GGML_CUDA",
    "metal",
    "gpu",
    "failed to initialize",
    "no device found",
    "out of memory",
];

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(tag = "type", content = "message")]
pub enum ServerStatus {
    Stopped,
    Starting,
    Ready,
    Error(String),
}

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
            port: 8765,
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

    fn strip_ansi(s: &str) -> String {
        let mut result = String::with_capacity(s.len());
        let mut chars = s.chars();
        while let Some(c) = chars.next() {
            if c == '\x1b' {
                for esc_c in chars.by_ref() {
                    if esc_c.is_ascii_alphabetic() {
                        break;
                    }
                }
            } else {
                result.push(c);
            }
        }
        result
    }

    fn push_log(inner: &mut ServerInner, line: &str) {
        if inner.log_buffer.len() >= LOG_RING_BUFFER_SIZE {
            inner.log_buffer.pop_front();
        }
        inner.log_buffer.push_back(Self::strip_ansi(line));
    }

    fn detect_gpu_error(line: &str) -> bool {
        let lower = line.to_lowercase();
        GPU_ERROR_PATTERNS
            .iter()
            .any(|pattern| lower.contains(pattern))
            && (lower.contains("error") || lower.contains("fail") || lower.contains("not found"))
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
        Self::kill_process_on_port(config.port).await;

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

    async fn kill_process_on_port(port: u16) {
        if std::net::TcpStream::connect(format!("127.0.0.1:{}", port)).is_ok() {
            warn!(
                "Port {} is occupied, attempting to kill the existing process",
                port
            );

            #[cfg(unix)]
            {
                // Use lsof to find and kill the process
                if let Ok(output) = std::process::Command::new("lsof")
                    .args(["-t", "-i", &format!(":{}", port)])
                    .output()
                {
                    let pids = String::from_utf8_lossy(&output.stdout);
                    for pid_str in pids.trim().lines() {
                        if let Ok(pid) = pid_str.trim().parse::<i32>() {
                            info!("Killing orphaned process {} on port {}", pid, port);
                            unsafe {
                                libc::kill(pid, libc::SIGTERM);
                            }
                        }
                    }
                }

                // Wait for port to be released
                for _ in 0..20 {
                    if std::net::TcpStream::connect(format!("127.0.0.1:{}", port)).is_err() {
                        return;
                    }
                    sleep(Duration::from_millis(100)).await;
                }
                warn!("Failed to free port {}", port);
            }

            #[cfg(windows)]
            {
                if let Ok(output) = std::process::Command::new("netstat")
                    .args(["-ano"])
                    .output()
                {
                    let stdout = String::from_utf8_lossy(&output.stdout);
                    for line in stdout.lines() {
                        if line.contains(&format!(":{}", port)) && line.contains("LISTENING") {
                            if let Some(pid_str) = line.split_whitespace().last() {
                                if let Ok(pid) = pid_str.parse::<u32>() {
                                    info!("Killing process {} on port {}", pid, port);
                                    let _ = std::process::Command::new("taskkill")
                                        .args(["/F", "/PID", &pid.to_string()])
                                        .output();
                                }
                            }
                        }
                    }
                }

                for _ in 0..20 {
                    if std::net::TcpStream::connect(format!("127.0.0.1:{}", port)).is_err() {
                        return;
                    }
                    sleep(Duration::from_millis(100)).await;
                }
                warn!("Failed to free port {}", port);
            }
        }
    }

    fn get_library_paths(app: &AppHandle) -> Vec<String> {
        // In dev mode, .so files are symlinked to target/debug/ (same dir as the exe).
        // In production, Tauri places externalBin in /usr/bin/ but resources (libs)
        // in the resource dir (e.g. /usr/lib/haruspex/). We need both paths.
        let mut paths = Vec::new();

        if let Ok(exe_path) = std::env::current_exe() {
            if let Some(exe_dir) = exe_path.parent() {
                paths.push(exe_dir.to_string_lossy().to_string());
            }
        }

        if let Ok(resource_dir) = app.path().resource_dir() {
            // Libs are bundled as resources at binaries/libs/* so they end up
            // in <resource_dir>/binaries/libs/ in production installs.
            let libs_dir = resource_dir.join("binaries").join("libs");
            if libs_dir.exists() {
                let libs_str = libs_dir.to_string_lossy().to_string();
                if !paths.contains(&libs_str) {
                    paths.push(libs_str);
                }
            }
            let resource_str = resource_dir.to_string_lossy().to_string();
            if !paths.contains(&resource_str) {
                paths.push(resource_str);
            }
        }

        paths
    }

    async fn spawn_and_monitor(&self, app: &AppHandle, model_path: &str) -> Result<(), String> {
        self.set_status(ServerStatus::Starting, app).await;

        // If the model has a multimodal projector, append --mmproj to the args
        // so llama-server loads vision support.
        let mmproj_path = {
            use tauri::Manager;
            app.try_state::<crate::models::ModelManager>()
                .and_then(|mgr| mgr.find_mmproj_for_model(std::path::Path::new(model_path)))
        };

        let args = {
            let inner = self.inner.lock().await;
            let mut args = inner.config.build_args(model_path);
            if let Some(path) = mmproj_path.as_ref() {
                args.push("--mmproj".to_string());
                args.push(path.to_string_lossy().to_string());
                info!("Vision projector enabled: {}", path.display());
            }
            args
        };

        info!("Starting llama-server with args: {:?}", args);

        let mut sidecar = app
            .shell()
            .sidecar("llama-server")
            .map_err(|e| format!("Failed to create sidecar command: {}", e))?
            .args(&args);

        // Set library path so llama-server can find its bundled shared libraries
        {
            let lib_paths = Self::get_library_paths(app);
            info!("Setting library paths to: {:?}", lib_paths);

            #[cfg(target_os = "linux")]
            {
                let mut parts = lib_paths;
                let existing = std::env::var("LD_LIBRARY_PATH").unwrap_or_default();
                if !existing.is_empty() {
                    parts.push(existing);
                }
                sidecar = sidecar.env("LD_LIBRARY_PATH", parts.join(":"));
            }

            #[cfg(target_os = "macos")]
            {
                let mut parts = lib_paths;
                let existing = std::env::var("DYLD_LIBRARY_PATH").unwrap_or_default();
                if !existing.is_empty() {
                    parts.push(existing);
                }
                sidecar = sidecar.env("DYLD_LIBRARY_PATH", parts.join(":"));
            }

            #[cfg(target_os = "windows")]
            {
                let mut parts = lib_paths;
                let existing = std::env::var("PATH").unwrap_or_default();
                if !existing.is_empty() {
                    parts.push(existing);
                }
                sidecar = sidecar.env("PATH", parts.join(";"));
            }
        }

        let (rx, child) = sidecar
            .spawn()
            .map_err(|e| format!("Failed to spawn llama-server: {}", e))?;

        let gen = {
            let mut inner = self.inner.lock().await;
            inner.child = Some(child);
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
                        Self::push_log(&mut state, &line_str);
                    }
                    CommandEvent::Stderr(line) => {
                        let line_str = String::from_utf8_lossy(&line).to_string();
                        warn!("llama-server stderr: {}", line_str);
                        let mut state = inner.lock().await;
                        Self::push_log(&mut state, &format!("[stderr] {}", line_str));

                        if Self::detect_gpu_error(&line_str) && !state.gpu_fallback_attempted {
                            warn!("GPU error detected, will attempt CPU fallback on exit");
                            state.gpu_error_detected = true;
                            // Keep the *first* matching line — it's almost
                            // always the most informative root cause (e.g.
                            // `Device memory allocation of size X failed`).
                            // Subsequent lines are downstream effects (assert
                            // aborts, buffer alloc retries) that read worse
                            // out of context.
                            if state.gpu_error_reason.is_none() {
                                let cleaned = Self::strip_ansi(&line_str).trim().to_string();
                                if !cleaned.is_empty() {
                                    state.gpu_error_reason = Some(cleaned);
                                }
                            }
                        }
                    }
                    CommandEvent::Terminated(payload) => {
                        let code = payload.code.unwrap_or(-1);
                        info!(
                            "llama-server (gen {}) exited with code: {}",
                            generation, code
                        );

                        // Ignore termination events from old generations
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

                        let should_fallback = {
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
                        };

                        if should_fallback {
                            warn!("Attempting CPU fallback (--n-gpu-layers 0)");

                            let mmproj_path = {
                                use tauri::Manager;
                                app.try_state::<crate::models::ModelManager>()
                                    .and_then(|mgr| {
                                        mgr.find_mmproj_for_model(std::path::Path::new(&model_path))
                                    })
                            };

                            let args = {
                                let state = inner.lock().await;
                                let mut args = state.config.build_args(&model_path);
                                if let Some(path) = mmproj_path.as_ref() {
                                    args.push("--mmproj".to_string());
                                    args.push(path.to_string_lossy().to_string());
                                }
                                args
                            };

                            let sidecar_result = app
                                .shell()
                                .sidecar("llama-server")
                                .map(|cmd| {
                                    let mut cmd = cmd.args(&args);

                                    #[cfg(target_os = "linux")]
                                    {
                                        let mut parts = Self::get_library_paths(&app);
                                        let existing =
                                            std::env::var("LD_LIBRARY_PATH").unwrap_or_default();
                                        if !existing.is_empty() {
                                            parts.push(existing);
                                        }
                                        cmd = cmd.env("LD_LIBRARY_PATH", parts.join(":"));
                                    }

                                    #[cfg(target_os = "macos")]
                                    {
                                        let mut parts = Self::get_library_paths(&app);
                                        let existing =
                                            std::env::var("DYLD_LIBRARY_PATH").unwrap_or_default();
                                        if !existing.is_empty() {
                                            parts.push(existing);
                                        }
                                        cmd = cmd.env("DYLD_LIBRARY_PATH", parts.join(":"));
                                    }

                                    cmd
                                })
                                .and_then(|cmd| cmd.spawn());

                            match sidecar_result {
                                Ok((new_rx, new_child)) => {
                                    let fallback_state = {
                                        let mut state = inner.lock().await;
                                        state.child = Some(new_child);
                                        state.cpu_fallback_active = true;
                                        // Reason was captured from the
                                        // pre-abort stderr; if for some
                                        // reason none was matched, fall back
                                        // to a generic message so the banner
                                        // still has something to display.
                                        let reason =
                                            state.gpu_error_reason.clone().unwrap_or_else(|| {
                                                "GPU initialization failed — running on CPU."
                                                    .to_string()
                                            });
                                        GpuFallbackState { reason }
                                    };
                                    let _ = app.emit("gpu-fallback-active", &fallback_state);
                                    // Spawn a new reader for the fallback process
                                    Self::spawn_output_reader(
                                        inner.clone(),
                                        app.clone(),
                                        model_path,
                                        new_rx,
                                        generation,
                                    );
                                    // Health poller is still running, it will pick up the new process
                                }
                                Err(e) => {
                                    error!("CPU fallback failed: {}", e);
                                    let mut state = inner.lock().await;
                                    state.status =
                                        ServerStatus::Error(format!("CPU fallback failed: {}", e));
                                    let _ = app.emit("server-status-changed", &state.status);
                                }
                            }
                            return;
                        }

                        // Crashed mid-operation: if the server was Ready and this
                        // wasn't a clean stop, attempt one auto-restart. This
                        // recovers from in-request crashes (e.g. image batch
                        // overflow during vision processing) without requiring
                        // the user to manually restart.
                        let should_auto_restart = {
                            let state = inner.lock().await;
                            matches!(state.status, ServerStatus::Ready)
                        };

                        if should_auto_restart {
                            warn!("llama-server crashed while Ready — attempting auto-restart");
                            {
                                let mut state = inner.lock().await;
                                state.status = ServerStatus::Starting;
                                let _ = app.emit("server-status-changed", &state.status);
                            }

                            let mmproj_path = {
                                use tauri::Manager;
                                app.try_state::<crate::models::ModelManager>()
                                    .and_then(|mgr| {
                                        mgr.find_mmproj_for_model(std::path::Path::new(&model_path))
                                    })
                            };

                            let args = {
                                let state = inner.lock().await;
                                let mut args = state.config.build_args(&model_path);
                                if let Some(path) = mmproj_path.as_ref() {
                                    args.push("--mmproj".to_string());
                                    args.push(path.to_string_lossy().to_string());
                                }
                                args
                            };

                            let sidecar_result = app
                                .shell()
                                .sidecar("llama-server")
                                .map(|cmd| {
                                    let mut cmd = cmd.args(&args);

                                    #[cfg(target_os = "linux")]
                                    {
                                        let mut parts = Self::get_library_paths(&app);
                                        let existing =
                                            std::env::var("LD_LIBRARY_PATH").unwrap_or_default();
                                        if !existing.is_empty() {
                                            parts.push(existing);
                                        }
                                        cmd = cmd.env("LD_LIBRARY_PATH", parts.join(":"));
                                    }

                                    #[cfg(target_os = "macos")]
                                    {
                                        let mut parts = Self::get_library_paths(&app);
                                        let existing =
                                            std::env::var("DYLD_LIBRARY_PATH").unwrap_or_default();
                                        if !existing.is_empty() {
                                            parts.push(existing);
                                        }
                                        cmd = cmd.env("DYLD_LIBRARY_PATH", parts.join(":"));
                                    }

                                    cmd
                                })
                                .and_then(|cmd| cmd.spawn());

                            match sidecar_result {
                                Ok((new_rx, new_child)) => {
                                    {
                                        let mut state = inner.lock().await;
                                        state.child = Some(new_child);
                                    }
                                    Self::spawn_output_reader(
                                        inner.clone(),
                                        app.clone(),
                                        model_path,
                                        new_rx,
                                        generation,
                                    );
                                    // Restart the health poller for the new process
                                    Self::spawn_health_poller(
                                        inner.clone(),
                                        app.clone(),
                                        generation,
                                    );
                                }
                                Err(e) => {
                                    error!("Auto-restart failed: {}", e);
                                    let mut state = inner.lock().await;
                                    state.status =
                                        ServerStatus::Error(format!("Auto-restart failed: {}", e));
                                    let _ = app.emit("server-status-changed", &state.status);
                                }
                            }
                            return;
                        }

                        // Not a fallback situation — report error
                        let mut state = inner.lock().await;
                        if state.status != ServerStatus::Stopped {
                            state.status =
                                ServerStatus::Error(format!("Server exited with code {}", code));
                            let _ = app.emit("server-status-changed", &state.status);
                        }
                    }
                    CommandEvent::Error(err) => {
                        error!("llama-server error: {}", err);
                        let mut state = inner.lock().await;
                        Self::push_log(&mut state, &format!("[error] {}", err));
                    }
                    _ => {}
                }
            }
        });
    }

    fn spawn_health_poller(inner: Arc<Mutex<ServerInner>>, app: AppHandle, generation: u64) {
        tauri::async_runtime::spawn(async move {
            let port = {
                let state = inner.lock().await;
                state.config.port
            };

            let client = reqwest::Client::builder()
                .timeout(Duration::from_secs(2))
                .build()
                .unwrap();

            let url = format!("http://127.0.0.1:{}/health", port);
            let max_attempts =
                (HEALTH_POLL_TIMEOUT.as_millis() / HEALTH_POLL_INTERVAL.as_millis()) as usize;

            for _ in 0..max_attempts {
                {
                    let state = inner.lock().await;
                    if state.generation != generation || state.status != ServerStatus::Starting {
                        return;
                    }
                }

                sleep(HEALTH_POLL_INTERVAL).await;

                match client.get(&url).send().await {
                    Ok(resp) if resp.status().is_success() => {
                        info!("llama-server health check passed");
                        let mut state = inner.lock().await;
                        if state.status == ServerStatus::Starting {
                            state.status = ServerStatus::Ready;
                            let _ = app.emit("server-status-changed", &ServerStatus::Ready);
                        }
                        return;
                    }
                    _ => continue,
                }
            }

            // Timed out
            let mut state = inner.lock().await;
            if state.status == ServerStatus::Starting {
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

        // Wait for the port to be released
        for _ in 0..20 {
            if std::net::TcpStream::connect(format!("127.0.0.1:{}", port)).is_err() {
                return Ok(()); // Port is free
            }
            sleep(Duration::from_millis(100)).await;
        }
        warn!("Port {} still in use after stop", port);
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
    ctx_size: Option<u32>,
    extra_args: Option<Vec<String>>,
) -> Result<(), String> {
    let config = ServerConfig {
        ctx_size: ctx_size.unwrap_or(16384),
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
pub async fn get_cpu_fallback_state(
    state: tauri::State<'_, LlamaServer>,
) -> Result<Option<GpuFallbackState>, ()> {
    Ok(state.get_cpu_fallback_state().await)
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
    fn detect_gpu_error_vulkan() {
        assert!(LlamaServer::detect_gpu_error(
            "Vulkan error: failed to initialize device"
        ));
        assert!(LlamaServer::detect_gpu_error(
            "vk_create_device: error creating device"
        ));
    }

    #[test]
    fn detect_gpu_error_metal() {
        assert!(LlamaServer::detect_gpu_error(
            "Metal: failed to create device"
        ));
    }

    #[test]
    fn detect_gpu_error_no_false_positives() {
        assert!(!LlamaServer::detect_gpu_error("Model loaded successfully"));
        assert!(!LlamaServer::detect_gpu_error(
            "Using Vulkan backend with NVIDIA GPU"
        ));
        assert!(!LlamaServer::detect_gpu_error("GPU layers: 99"));
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
        };

        for i in 0..LOG_RING_BUFFER_SIZE + 100 {
            LlamaServer::push_log(&mut inner, &format!("line {}", i));
        }

        assert_eq!(inner.log_buffer.len(), LOG_RING_BUFFER_SIZE);
        assert_eq!(inner.log_buffer.front().unwrap(), "line 100");
    }
}
