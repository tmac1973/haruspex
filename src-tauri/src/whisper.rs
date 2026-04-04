use log::{error, info, warn};
use serde::Serialize;
use std::collections::VecDeque;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;
use tokio::sync::Mutex;
use tokio::time::sleep;

const WHISPER_PORT: u16 = 8766;
const HEALTH_POLL_INTERVAL: Duration = Duration::from_millis(500);
const HEALTH_POLL_TIMEOUT: Duration = Duration::from_secs(30);
const LOG_RING_BUFFER_SIZE: usize = 1000;

#[derive(Clone, Debug, Serialize, PartialEq)]
pub enum WhisperStatus {
    Stopped,
    Starting,
    Ready,
    Error(String),
}

pub struct WhisperServer {
    child: Mutex<Option<CommandChild>>,
    status: Arc<Mutex<WhisperStatus>>,
    log_buffer: Arc<Mutex<VecDeque<String>>>,
}

/// Strip ANSI escape sequences (e.g. color codes) from a string.
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

fn push_log(buffer: &mut VecDeque<String>, line: &str) {
    if buffer.len() >= LOG_RING_BUFFER_SIZE {
        buffer.pop_front();
    }
    buffer.push_back(strip_ansi(line));
}

impl WhisperServer {
    pub fn new() -> Self {
        Self {
            child: Mutex::new(None),
            status: Arc::new(Mutex::new(WhisperStatus::Stopped)),
            log_buffer: Arc::new(Mutex::new(VecDeque::with_capacity(LOG_RING_BUFFER_SIZE))),
        }
    }

    async fn kill_process_on_port(port: u16) {
        if std::net::TcpStream::connect(format!("127.0.0.1:{}", port)).is_ok() {
            warn!("Port {} occupied, killing existing process", port);
            #[cfg(unix)]
            {
                if let Ok(output) = std::process::Command::new("lsof")
                    .args(["-t", "-i", &format!(":{}", port)])
                    .output()
                {
                    let pids = String::from_utf8_lossy(&output.stdout);
                    for pid_str in pids.trim().lines() {
                        if let Ok(pid) = pid_str.trim().parse::<i32>() {
                            info!("Killing process {} on port {}", pid, port);
                            unsafe {
                                libc::kill(pid, libc::SIGTERM);
                            }
                        }
                    }
                }
                for _ in 0..20 {
                    if std::net::TcpStream::connect(format!("127.0.0.1:{}", port)).is_err() {
                        return;
                    }
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
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
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            }
        }
    }

    pub async fn start(&self, app: &AppHandle, model_path: &str) -> Result<(), String> {
        self.stop().await?;
        Self::kill_process_on_port(WHISPER_PORT).await;

        {
            let mut status = self.status.lock().await;
            *status = WhisperStatus::Starting;
        }

        info!("Starting whisper-server with model: {}", model_path);

        let args = vec![
            "--model".to_string(),
            model_path.to_string(),
            "--host".to_string(),
            "127.0.0.1".to_string(),
            "--port".to_string(),
            WHISPER_PORT.to_string(),
        ];

        let mut sidecar = app
            .shell()
            .sidecar("whisper-server")
            .map_err(|e| format!("Failed to create whisper sidecar: {}", e))?
            .args(&args);

        // Set library path so whisper-server can find its bundled shared libraries
        {
            let mut lib_paths = Vec::new();
            if let Ok(exe_path) = std::env::current_exe() {
                if let Some(exe_dir) = exe_path.parent() {
                    lib_paths.push(exe_dir.to_string_lossy().to_string());
                }
            }
            if let Ok(resource_dir) = app.path().resource_dir() {
                let libs_dir = resource_dir.join("binaries").join("libs");
                if libs_dir.exists() {
                    let libs_str = libs_dir.to_string_lossy().to_string();
                    if !lib_paths.contains(&libs_str) {
                        lib_paths.push(libs_str);
                    }
                }
                let resource_str = resource_dir.to_string_lossy().to_string();
                if !lib_paths.contains(&resource_str) {
                    lib_paths.push(resource_str);
                }
            }

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

        let (mut rx, child) = sidecar
            .spawn()
            .map_err(|e| format!("Failed to spawn whisper-server: {}", e))?;

        {
            let mut c = self.child.lock().await;
            *c = Some(child);
        }

        // Spawn stderr reader
        let status_clone = Arc::clone(&self.status);
        let log_buffer_clone = Arc::clone(&self.log_buffer);
        tauri::async_runtime::spawn(async move {
            use tauri_plugin_shell::process::CommandEvent;
            while let Some(event) = rx.recv().await {
                match event {
                    CommandEvent::Stderr(line) => {
                        let line_str = String::from_utf8_lossy(&line);
                        let trimmed = line_str.trim();
                        info!("whisper-server: {}", trimmed);
                        let mut buf = log_buffer_clone.lock().await;
                        push_log(&mut buf, trimmed);
                    }
                    CommandEvent::Stdout(line) => {
                        let line_str = String::from_utf8_lossy(&line);
                        let trimmed = line_str.trim();
                        if !trimmed.is_empty() {
                            info!("whisper-server: {}", trimmed);
                            let mut buf = log_buffer_clone.lock().await;
                            push_log(&mut buf, trimmed);
                        }
                    }
                    CommandEvent::Terminated(payload) => {
                        let code = payload.code.unwrap_or(-1);
                        warn!("whisper-server exited with code: {}", code);
                        let msg = format!("[terminated] code={}", code);
                        let mut buf = log_buffer_clone.lock().await;
                        push_log(&mut buf, &msg);
                        let mut status = status_clone.lock().await;
                        if *status != WhisperStatus::Stopped {
                            *status = WhisperStatus::Error(format!("Exited with code {}", code));
                        }
                    }
                    _ => {}
                }
            }
        });

        // Health poll
        let status_for_health = Arc::clone(&self.status);
        tauri::async_runtime::spawn(async move {
            let client = reqwest::Client::builder()
                .timeout(Duration::from_secs(2))
                .build()
                .unwrap();

            let url = format!("http://127.0.0.1:{}/health", WHISPER_PORT);
            let max_attempts =
                (HEALTH_POLL_TIMEOUT.as_millis() / HEALTH_POLL_INTERVAL.as_millis()) as usize;

            for _ in 0..max_attempts {
                {
                    let status = status_for_health.lock().await;
                    if *status != WhisperStatus::Starting {
                        return;
                    }
                }
                sleep(HEALTH_POLL_INTERVAL).await;

                if let Ok(resp) = client.get(&url).send().await {
                    if resp.status().is_success() {
                        info!("whisper-server health check passed");
                        let mut status = status_for_health.lock().await;
                        *status = WhisperStatus::Ready;
                        return;
                    }
                }
            }

            let mut status = status_for_health.lock().await;
            if *status == WhisperStatus::Starting {
                error!("whisper-server health check timed out");
                *status = WhisperStatus::Error("Health check timed out".to_string());
            }
        });

        Ok(())
    }

    pub async fn stop(&self) -> Result<(), String> {
        let mut child = self.child.lock().await;
        if let Some(c) = child.take() {
            info!("Stopping whisper-server");
            c.kill()
                .map_err(|e| format!("Failed to kill whisper-server: {}", e))?;
        }
        let mut status = self.status.lock().await;
        *status = WhisperStatus::Stopped;
        Ok(())
    }

    pub async fn get_status(&self) -> WhisperStatus {
        self.status.lock().await.clone()
    }

    pub async fn get_logs(&self) -> Vec<String> {
        let buffer = self.log_buffer.lock().await;
        buffer.iter().cloned().collect()
    }

    pub async fn transcribe(&self, audio_data: Vec<u8>) -> Result<String, String> {
        let status = self.status.lock().await;
        if *status != WhisperStatus::Ready {
            return Err("Whisper server is not ready".to_string());
        }
        drop(status);

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|e| format!("HTTP client error: {}", e))?;

        let part = reqwest::multipart::Part::bytes(audio_data)
            .file_name("recording.wav")
            .mime_str("audio/wav")
            .map_err(|e| format!("Multipart error: {}", e))?;

        let form = reqwest::multipart::Form::new().part("file", part);

        let resp = client
            .post(format!("http://127.0.0.1:{}/inference", WHISPER_PORT))
            .multipart(form)
            .send()
            .await
            .map_err(|e| format!("Transcription request failed: {}", e))?;

        if !resp.status().is_success() {
            return Err(format!(
                "Transcription failed with status: {}",
                resp.status()
            ));
        }

        let body = resp
            .text()
            .await
            .map_err(|e| format!("Failed to read response: {}", e))?;

        // whisper-server returns JSON with "text" field
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&body) {
            if let Some(text) = parsed.get("text").and_then(|v| v.as_str()) {
                return Ok(text.trim().to_string());
            }
        }

        // Fallback: return raw body trimmed
        Ok(body.trim().to_string())
    }
}

// Tauri commands

#[tauri::command]
pub async fn start_whisper(
    app: AppHandle,
    state: tauri::State<'_, WhisperServer>,
    model_path: String,
) -> Result<(), String> {
    state.start(&app, &model_path).await
}

#[tauri::command]
pub async fn stop_whisper(state: tauri::State<'_, WhisperServer>) -> Result<(), String> {
    state.stop().await
}

#[tauri::command]
pub async fn get_whisper_status(
    state: tauri::State<'_, WhisperServer>,
) -> Result<WhisperStatus, ()> {
    Ok(state.get_status().await)
}

#[tauri::command]
pub async fn get_whisper_logs(
    state: tauri::State<'_, WhisperServer>,
) -> Result<Vec<String>, ()> {
    Ok(state.get_logs().await)
}

#[tauri::command]
pub async fn transcribe_audio(
    state: tauri::State<'_, WhisperServer>,
    audio: Vec<u8>,
) -> Result<String, String> {
    state.transcribe(audio).await
}
