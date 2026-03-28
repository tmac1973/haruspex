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

    fn push_log(inner: &mut ServerInner, line: &str) {
        if inner.log_buffer.len() >= LOG_RING_BUFFER_SIZE {
            inner.log_buffer.pop_front();
        }
        inner.log_buffer.push_back(line.to_string());
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
        }

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
        }
    }

    fn get_sidecar_dir(app: &AppHandle) -> Option<String> {
        // llama-server discovers its backends (libggml-*.so) via /proc/self/exe.
        // In dev mode, Tauri copies the sidecar to target/debug/llama-server,
        // so the .so files need to be there too (symlinked by scripts/link-sidecar-libs.sh).
        // In production, they'll be in the resource dir alongside the binary.

        // First: check the executable's own directory (works for both dev and prod)
        if let Ok(exe_path) = std::env::current_exe() {
            if let Some(exe_dir) = exe_path.parent() {
                return Some(exe_dir.to_string_lossy().to_string());
            }
        }

        // Fallback: resource dir
        let resource_dir = app.path().resource_dir().ok()?;
        Some(resource_dir.to_string_lossy().to_string())
    }

    async fn spawn_and_monitor(&self, app: &AppHandle, model_path: &str) -> Result<(), String> {
        self.set_status(ServerStatus::Starting, app).await;

        let args = {
            let inner = self.inner.lock().await;
            inner.config.build_args(model_path)
        };

        info!("Starting llama-server with args: {:?}", args);

        let mut sidecar = app
            .shell()
            .sidecar("llama-server")
            .map_err(|e| format!("Failed to create sidecar command: {}", e))?
            .args(&args);

        // Set LD_LIBRARY_PATH so llama-server can find its bundled .so files
        // (backends are discovered via /proc/self/exe, but libllama.so etc. need LD_LIBRARY_PATH)
        if let Some(bin_dir) = Self::get_sidecar_dir(app) {
            info!("Setting LD_LIBRARY_PATH to: {}", bin_dir);
            let existing = std::env::var("LD_LIBRARY_PATH").unwrap_or_default();
            let new_path = if existing.is_empty() {
                bin_dir
            } else {
                format!("{}:{}", bin_dir, existing)
            };
            sidecar = sidecar.env("LD_LIBRARY_PATH", new_path);
        }

        let (rx, child) = sidecar
            .spawn()
            .map_err(|e| format!("Failed to spawn llama-server: {}", e))?;

        {
            let mut inner = self.inner.lock().await;
            inner.child = Some(child);
        }

        // Spawn stdout/stderr reader
        Self::spawn_output_reader(self.inner.clone(), app.clone(), model_path.to_string(), rx);

        // Spawn health poller
        Self::spawn_health_poller(self.inner.clone(), app.clone());

        Ok(())
    }

    fn spawn_output_reader(
        inner: Arc<Mutex<ServerInner>>,
        app: AppHandle,
        model_path: String,
        mut rx: tauri::async_runtime::Receiver<tauri_plugin_shell::process::CommandEvent>,
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
                        }
                    }
                    CommandEvent::Terminated(payload) => {
                        let code = payload.code.unwrap_or(-1);
                        info!("llama-server exited with code: {}", code);

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

                            let args = {
                                let state = inner.lock().await;
                                state.config.build_args(&model_path)
                            };

                            let sidecar_result = app
                                .shell()
                                .sidecar("llama-server")
                                .map(|cmd| {
                                    let mut cmd = cmd.args(&args);
                                    if let Some(bin_dir) = Self::get_sidecar_dir(&app) {
                                        let existing =
                                            std::env::var("LD_LIBRARY_PATH").unwrap_or_default();
                                        let new_path = if existing.is_empty() {
                                            bin_dir
                                        } else {
                                            format!("{}:{}", bin_dir, existing)
                                        };
                                        cmd = cmd.env("LD_LIBRARY_PATH", new_path);
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
                                    // Spawn a new reader for the fallback process
                                    Self::spawn_output_reader(
                                        inner.clone(),
                                        app.clone(),
                                        model_path,
                                        new_rx,
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

    fn spawn_health_poller(inner: Arc<Mutex<ServerInner>>, app: AppHandle) {
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
                    if state.status != ServerStatus::Starting {
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
}

// Tauri commands

#[tauri::command]
pub async fn start_server(
    app: AppHandle,
    state: tauri::State<'_, LlamaServer>,
    model_path: String,
) -> Result<(), String> {
    state.start(&app, &model_path, None).await
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
        };

        for i in 0..LOG_RING_BUFFER_SIZE + 100 {
            LlamaServer::push_log(&mut inner, &format!("line {}", i));
        }

        assert_eq!(inner.log_buffer.len(), LOG_RING_BUFFER_SIZE);
        assert_eq!(inner.log_buffer.front().unwrap(), "line 100");
    }
}
