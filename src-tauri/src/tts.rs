use log::{error, info, warn};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;
use tokio::sync::Mutex;
use tokio::time::sleep;

const TTS_PORT: u16 = 3001;

#[derive(Clone, Debug, PartialEq)]
enum TtsStatus {
    Stopped,
    Starting,
    Ready,
    Error(String),
}

// TtsEngine is Send + Sync because it only contains Send+Sync types.
// Audio playback happens on a dedicated thread (not stored in the struct).
pub struct TtsEngine {
    child: Mutex<Option<CommandChild>>,
    status: Arc<Mutex<TtsStatus>>,
    playing: Arc<AtomicBool>,
    stop_flag: Arc<AtomicBool>,
}

impl TtsEngine {
    pub fn new() -> Self {
        Self {
            child: Mutex::new(None),
            status: Arc::new(Mutex::new(TtsStatus::Stopped)),
            playing: Arc::new(AtomicBool::new(false)),
            stop_flag: Arc::new(AtomicBool::new(false)),
        }
    }

    pub async fn start(&self, app: &AppHandle) -> Result<(), String> {
        {
            let status = self.status.lock().await;
            if *status == TtsStatus::Ready || *status == TtsStatus::Starting {
                return Ok(());
            }
        }

        self.stop().await?;
        Self::kill_process_on_port(TTS_PORT).await;

        {
            let mut status = self.status.lock().await;
            *status = TtsStatus::Starting;
        }

        info!("Starting Kokoro TTS server on port {}", TTS_PORT);

        let mut sidecar = app
            .shell()
            .sidecar("koko")
            .map_err(|e| format!("Failed to create koko sidecar: {}", e))?
            .args([
                "openai",
                "--ip",
                "127.0.0.1",
                "--port",
                &TTS_PORT.to_string(),
            ]);

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
        }

        let (mut rx, child) = sidecar
            .spawn()
            .map_err(|e| format!("Failed to spawn koko: {}", e))?;

        {
            let mut c = self.child.lock().await;
            *c = Some(child);
        }

        let status_clone = Arc::clone(&self.status);
        tauri::async_runtime::spawn(async move {
            use tauri_plugin_shell::process::CommandEvent;
            while let Some(event) = rx.recv().await {
                match event {
                    CommandEvent::Stderr(line) => {
                        let line_str = String::from_utf8_lossy(&line);
                        info!("koko: {}", line_str.trim());
                    }
                    CommandEvent::Stdout(line) => {
                        let line_str = String::from_utf8_lossy(&line);
                        let trimmed = line_str.trim();
                        if !trimmed.is_empty() {
                            info!("koko: {}", trimmed);
                        }
                        if trimmed.contains("listening") || trimmed.contains("Listening") {
                            let mut status = status_clone.lock().await;
                            if *status == TtsStatus::Starting {
                                *status = TtsStatus::Ready;
                                info!("Kokoro TTS server is ready");
                            }
                        }
                    }
                    CommandEvent::Terminated(payload) => {
                        let code = payload.code.unwrap_or(-1);
                        warn!("koko exited with code: {}", code);
                        let mut status = status_clone.lock().await;
                        if *status != TtsStatus::Stopped {
                            *status = TtsStatus::Error(format!("Exited with code {}", code));
                        }
                    }
                    _ => {}
                }
            }
        });

        let status_for_health = Arc::clone(&self.status);
        tauri::async_runtime::spawn(async move {
            let client = reqwest::Client::builder()
                .timeout(Duration::from_secs(2))
                .build()
                .unwrap();

            for _ in 0..60 {
                {
                    let status = status_for_health.lock().await;
                    if *status == TtsStatus::Ready || *status != TtsStatus::Starting {
                        return;
                    }
                }
                sleep(Duration::from_millis(500)).await;

                if let Ok(resp) = client
                    .get(format!("http://127.0.0.1:{}/", TTS_PORT))
                    .send()
                    .await
                {
                    if resp.status().as_u16() > 0 {
                        let mut status = status_for_health.lock().await;
                        if *status == TtsStatus::Starting {
                            *status = TtsStatus::Ready;
                            info!("Kokoro TTS server ready (health poll)");
                        }
                        return;
                    }
                }
            }

            let mut status = status_for_health.lock().await;
            if *status == TtsStatus::Starting {
                *status = TtsStatus::Error("TTS server startup timed out".to_string());
                error!("Kokoro TTS server startup timed out");
            }
        });

        Ok(())
    }

    pub async fn stop(&self) -> Result<(), String> {
        let mut child = self.child.lock().await;
        if let Some(c) = child.take() {
            info!("Stopping koko TTS server");
            c.kill()
                .map_err(|e| format!("Failed to kill koko: {}", e))?;
        }
        let mut status = self.status.lock().await;
        *status = TtsStatus::Stopped;
        self.stop_flag.store(true, Ordering::SeqCst);
        Ok(())
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
                    sleep(Duration::from_millis(100)).await;
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
                    sleep(Duration::from_millis(100)).await;
                }
            }
        }
    }

    pub async fn is_ready(&self) -> bool {
        *self.status.lock().await == TtsStatus::Ready
    }

    pub async fn synthesize_and_play(&self, text: &str, voice: &str) -> Result<(), String> {
        let status = self.status.lock().await;
        if *status != TtsStatus::Ready {
            return Err("TTS server not ready".to_string());
        }
        drop(status);

        if text.trim().is_empty() {
            return Err("No text to speak".to_string());
        }

        info!(
            "TTS request: {} chars, voice='{}', text: {:?}",
            text.len(),
            voice,
            &text[..text.len().min(100)]
        );

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(120))
            .build()
            .map_err(|e| format!("HTTP client error: {}", e))?;

        let body = serde_json::json!({
            "model": "tts-1",
            "input": text,
            "voice": voice,
            "response_format": "pcm"
        });

        let resp = client
            .post(format!("http://127.0.0.1:{}/v1/audio/speech", TTS_PORT))
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("TTS request failed: {}", e))?;

        if !resp.status().is_success() {
            let err_text = resp.text().await.unwrap_or_default();
            return Err(format!("TTS failed: {}", err_text));
        }

        let audio_bytes = resp
            .bytes()
            .await
            .map_err(|e| format!("Failed to read TTS response: {}", e))?;

        info!("TTS response: {} bytes", audio_bytes.len());

        if audio_bytes.len() < 100 {
            return Err("TTS produced no audio".to_string());
        }

        // PCM format from koko: 16-bit signed integer, mono, 24kHz
        let samples: Vec<f32> = audio_bytes
            .chunks_exact(2)
            .map(|chunk| i16::from_le_bytes([chunk[0], chunk[1]]) as f32 / 32768.0)
            .collect();

        info!(
            "Playing {} samples ({:.1}s)",
            samples.len(),
            samples.len() as f32 / 24000.0
        );

        // Play audio on a dedicated thread (OutputStream is not Send on macOS)
        self.stop_flag.store(false, Ordering::SeqCst);
        self.playing.store(true, Ordering::SeqCst);

        let playing = Arc::clone(&self.playing);
        let stop_flag = Arc::clone(&self.stop_flag);

        std::thread::spawn(move || {
            use rodio::{OutputStreamBuilder, Sink};

            let stream = match OutputStreamBuilder::open_default_stream() {
                Ok(s) => s,
                Err(e) => {
                    error!("Audio output error: {}", e);
                    playing.store(false, Ordering::SeqCst);
                    return;
                }
            };

            let sink = Sink::connect_new(stream.mixer());
            let source = rodio::buffer::SamplesBuffer::new(1, 24000, samples);
            sink.append(source);

            // Wait for playback to complete or stop signal
            while !sink.empty() && !stop_flag.load(Ordering::SeqCst) {
                std::thread::sleep(std::time::Duration::from_millis(100));
            }

            if stop_flag.load(Ordering::SeqCst) {
                sink.stop();
            }

            playing.store(false, Ordering::SeqCst);
        });

        Ok(())
    }

    pub fn stop_playback(&self) {
        self.stop_flag.store(true, Ordering::SeqCst);
    }

    pub fn is_playing(&self) -> bool {
        self.playing.load(Ordering::SeqCst)
    }
}

// Tauri commands

#[tauri::command]
pub async fn tts_initialize(
    app: AppHandle,
    state: tauri::State<'_, TtsEngine>,
) -> Result<(), String> {
    state.start(&app).await?;

    // Wait for the server to become ready before returning,
    // so the caller can immediately synthesize after this resolves.
    for _ in 0..60 {
        if state.is_ready().await {
            return Ok(());
        }
        sleep(Duration::from_millis(500)).await;
    }
    Err("TTS server failed to become ready".to_string())
}

#[tauri::command]
pub async fn tts_synthesize_and_play(
    state: tauri::State<'_, TtsEngine>,
    text: String,
    voice: Option<String>,
) -> Result<(), String> {
    let voice = voice.unwrap_or_else(|| "af_heart".to_string());
    state.synthesize_and_play(&text, &voice).await
}

#[tauri::command]
pub fn tts_stop_playback(state: tauri::State<'_, TtsEngine>) -> Result<(), String> {
    state.stop_playback();
    Ok(())
}

#[tauri::command]
pub fn tts_is_playing(state: tauri::State<'_, TtsEngine>) -> bool {
    state.is_playing()
}

#[tauri::command]
pub async fn tts_is_initialized(state: tauri::State<'_, TtsEngine>) -> Result<bool, ()> {
    Ok(state.is_ready().await)
}

#[tauri::command]
pub async fn tts_list_voices() -> Result<Vec<String>, ()> {
    Ok(vec![
        "af_heart".to_string(),
        "af_sky".to_string(),
        "af_nicole".to_string(),
        "af_bella".to_string(),
        "af_nova".to_string(),
        "af_sarah".to_string(),
        "af_alloy".to_string(),
        "af_river".to_string(),
        "am_adam".to_string(),
        "am_michael".to_string(),
        "am_echo".to_string(),
        "am_eric".to_string(),
        "am_liam".to_string(),
        "ef_dora".to_string(),
        "em_alex".to_string(),
    ])
}
