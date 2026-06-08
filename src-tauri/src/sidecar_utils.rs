//! Shared infrastructure for sidecar process management.
//!
//! Three sidecars (llama-server, whisper-server, koko) share lifecycle
//! concerns: killing orphaned processes on their port, polling a /health
//! endpoint until ready, capturing ANSI-stripped log lines into a ring
//! buffer, and reporting a `Stopped | Starting | Ready | Error` status to
//! the UI. This module owns those primitives so the three sidecar files
//! consume one canonical implementation each.

use log::{error, info, warn};
use serde::Serialize;
use std::collections::VecDeque;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::{Command, CommandChild, CommandEvent};
use tokio::sync::Mutex;
use tokio::time::sleep;

/// Default ports for the three sidecars. Kept in one place so any
/// process trying to find a sidecar agrees on the number.
pub mod ports {
    pub const LLAMA: u16 = 8765;
    pub const WHISPER: u16 = 8766;
    pub const TTS: u16 = 3001;
}

/// Common timeouts. Tweak in one place rather than chasing magic
/// numbers across three sidecar files.
pub mod timing {
    use std::time::Duration;

    /// How long to sleep between successive `/health` polls.
    pub const HEALTH_POLL_INTERVAL: Duration = Duration::from_millis(500);

    /// Per-request timeout on a /health GET. Short because the endpoint
    /// is supposed to be cheap; if it isn't answering quickly the sidecar
    /// isn't really ready.
    pub const SHORT_HTTP_TIMEOUT: Duration = Duration::from_secs(2);

    /// Sleep between `wait_for_port_release` polls.
    pub const PORT_RELEASE_INTERVAL: Duration = Duration::from_millis(100);

    /// Number of `wait_for_port_release` polls before giving up. 20 ×
    /// 100ms = 2s, matches the implicit cap the three sidecars used
    /// individually before this consolidation.
    pub const PORT_RELEASE_ATTEMPTS: usize = 20;
}

/// Maximum entries kept in a sidecar's in-memory log ring buffer.
/// Constant rather than parameter because every consumer agreed on
/// 1000 before this consolidation.
pub const LOG_RING_BUFFER_SIZE: usize = 1000;

/// Unified lifecycle state for every sidecar.
///
/// Serialized with `#[serde(tag = "type", content = "message")]` so the
/// frontend can pattern-match by `payload.type === "Ready"` for unit
/// variants and `payload.type === "Error"` + `payload.message` for the
/// failure variant. `MicButton.svelte` and `server.svelte.ts` consume
/// this shape directly.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "type", content = "message")]
pub enum SidecarStatus {
    Stopped,
    Starting,
    Ready,
    Error(String),
}

pub type LogBuffer = Arc<Mutex<VecDeque<String>>>;

pub fn new_log_buffer() -> LogBuffer {
    Arc::new(Mutex::new(VecDeque::with_capacity(LOG_RING_BUFFER_SIZE)))
}

/// Strip ANSI escape sequences (color codes, cursor moves) from a log
/// line so the UI's log viewer doesn't render `[31m...[0m` literally.
pub fn strip_ansi(s: &str) -> String {
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

/// Append a log line to the ring buffer, evicting the oldest entry when
/// at capacity. ANSI is stripped on the way in.
pub fn push_log(buffer: &mut VecDeque<String>, line: &str) {
    if buffer.len() >= LOG_RING_BUFFER_SIZE {
        buffer.pop_front();
    }
    buffer.push_back(strip_ansi(line));
}

/// Build a reqwest::Client with a uniform timeout. The builder only
/// fails on configuration mistakes (e.g. invalid TLS roots), so an
/// expect() is sound — there is no runtime failure mode.
pub fn http_client(timeout: Duration) -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .expect("reqwest::Client::builder")
}

fn localhost(port: u16) -> String {
    format!("127.0.0.1:{port}")
}

/// `http://127.0.0.1:<port>` — the base URL every sidecar's local HTTP
/// endpoints hang off. One definition so the host/scheme can't drift.
pub fn base_url(port: u16) -> String {
    format!("http://{}", localhost(port))
}

/// `http://127.0.0.1:<port>/health` — the readiness endpoint.
pub fn health_url(port: u16) -> String {
    format!("{}/health", base_url(port))
}

/// Directories a bundled sidecar must search for its shared libraries:
/// the executable's own dir (dev: target/debug; prod: install bin dir)
/// plus the packaged `binaries/libs` and the resource dir. Order matters —
/// the exe dir wins so a dev symlink shadows a stale packaged copy.
pub fn library_paths(app: &AppHandle) -> Vec<String> {
    let mut paths = Vec::new();
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            paths.push(exe_dir.to_string_lossy().to_string());
        }
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
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

/// Apply the platform's shared-library search-path env var
/// (`LD_LIBRARY_PATH` on Linux, `DYLD_LIBRARY_PATH` on macOS, `PATH` on
/// Windows) to a sidecar command, appending any existing value so the
/// process still finds system libraries. Every sidecar spawn routes
/// through this so the path logic lives in exactly one place.
pub fn with_library_paths(cmd: Command, app: &AppHandle) -> Command {
    let mut parts = library_paths(app);
    #[cfg(target_os = "linux")]
    let (var, sep) = ("LD_LIBRARY_PATH", ":");
    #[cfg(target_os = "macos")]
    let (var, sep) = ("DYLD_LIBRARY_PATH", ":");
    #[cfg(target_os = "windows")]
    let (var, sep) = ("PATH", ";");
    let existing = std::env::var(var).unwrap_or_default();
    if !existing.is_empty() {
        parts.push(existing);
    }
    cmd.env(var, parts.join(sep))
}

/// Kill a sidecar's child process if one is running, clearing the handle.
/// No-op when nothing is running. The caller sets the status afterward
/// (the three sidecars track status differently enough that folding it in
/// here doesn't generalize cleanly).
pub async fn kill_child(child: &Mutex<Option<CommandChild>>, name: &str) -> Result<(), String> {
    if let Some(c) = child.lock().await.take() {
        info!("Stopping {name}");
        c.kill()
            .map_err(|e| format!("Failed to kill {name}: {e}"))?;
    }
    Ok(())
}

/// Spawn the async task that drains a sidecar's `CommandEvent` stream into
/// its log ring buffer and status. Shared by whisper-server and koko (the
/// llama-server reader is richer — GPU classify, crash telemetry, fallback —
/// and stays bespoke).
///
/// - stdout/stderr lines are logged and pushed to `log`.
/// - if a stdout line contains any `ready_markers` substring, status flips
///   `Starting → Ready` (koko's "listening" sniff; pass `&[]` to disable).
/// - on `Terminated`, status flips to `Error` unless it was already `Stopped`.
pub fn spawn_log_reader(
    name: &'static str,
    mut rx: tauri::async_runtime::Receiver<CommandEvent>,
    status: Arc<Mutex<SidecarStatus>>,
    log: LogBuffer,
    ready_markers: &'static [&'static str],
) {
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stderr(line) => {
                    let s = String::from_utf8_lossy(&line);
                    let trimmed = s.trim();
                    info!("{name}: {}", trimmed);
                    let mut buf = log.lock().await;
                    push_log(&mut buf, trimmed);
                }
                CommandEvent::Stdout(line) => {
                    let s = String::from_utf8_lossy(&line);
                    let trimmed = s.trim();
                    if !trimmed.is_empty() {
                        info!("{name}: {}", trimmed);
                        let mut buf = log.lock().await;
                        push_log(&mut buf, trimmed);
                    }
                    if ready_markers.iter().any(|m| trimmed.contains(m)) {
                        let mut st = status.lock().await;
                        if *st == SidecarStatus::Starting {
                            *st = SidecarStatus::Ready;
                            info!("{name} is ready");
                        }
                    }
                }
                CommandEvent::Terminated(payload) => {
                    let code = payload.code.unwrap_or(-1);
                    warn!("{name} exited with code: {}", code);
                    let mut buf = log.lock().await;
                    push_log(&mut buf, &format!("[terminated] code={}", code));
                    drop(buf);
                    let mut st = status.lock().await;
                    if *st != SidecarStatus::Stopped {
                        *st = SidecarStatus::Error(format!("Exited with code {}", code));
                    }
                }
                _ => {}
            }
        }
    });
}

/// Drive a plain `Arc<Mutex<SidecarStatus>>` from `Starting` to `Ready`
/// (on a successful health poll) or to `Error` (on timeout). Shared by the
/// sidecars whose status is a bare mutex; llama-server tracks status inside
/// a richer generation-guarded struct and handles this itself.
pub async fn drive_status_on_health(status: &Arc<Mutex<SidecarStatus>>, ok: bool, name: &str) {
    let mut s = status.lock().await;
    if ok {
        if *s == SidecarStatus::Starting {
            *s = SidecarStatus::Ready;
        }
    } else if *s == SidecarStatus::Starting {
        error!("{name} health check timed out");
        *s = SidecarStatus::Error("Health check timed out".to_string());
    }
}

/// Block briefly until `port` stops accepting connections. Used after
/// a kill to confirm the previous process actually let go before we
/// spawn its replacement.
pub async fn wait_for_port_release(port: u16) {
    for _ in 0..timing::PORT_RELEASE_ATTEMPTS {
        if std::net::TcpStream::connect(localhost(port)).is_err() {
            return;
        }
        sleep(timing::PORT_RELEASE_INTERVAL).await;
    }
    warn!("Failed to free port {port}");
}

/// If a process is currently bound to `port`, terminate it and wait for
/// the port to release. No-op when the port is already free. `name` is
/// used purely for the warning log line so operators can tell which
/// sidecar's preflight triggered the kill.
pub async fn kill_process_on_port(port: u16, name: &str) {
    if std::net::TcpStream::connect(localhost(port)).is_err() {
        return;
    }

    warn!("{name}: port {port} occupied, attempting to kill the existing process");

    #[cfg(unix)]
    {
        if let Ok(output) = std::process::Command::new("lsof")
            .args(["-t", "-i", &format!(":{port}")])
            .output()
        {
            for pid_str in String::from_utf8_lossy(&output.stdout).trim().lines() {
                if let Ok(pid) = pid_str.trim().parse::<i32>() {
                    info!("Killing process {pid} on port {port}");
                    unsafe {
                        libc::kill(pid, libc::SIGTERM);
                    }
                }
            }
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
                if line.contains(&format!(":{port}")) && line.contains("LISTENING") {
                    if let Some(pid_str) = line.split_whitespace().last() {
                        if let Ok(pid) = pid_str.parse::<u32>() {
                            info!("Killing process {pid} on port {port}");
                            let _ = std::process::Command::new("taskkill")
                                .args(["/F", "/PID", &pid.to_string()])
                                .output();
                        }
                    }
                }
            }
        }
    }

    wait_for_port_release(port).await;
}

/// Poll `url` (typically a `/health` endpoint) until it returns 2xx,
/// the caller's `keep_going` predicate returns false, or `timeout`
/// elapses. Returns true on a successful poll, false on caller-abort
/// or timeout.
///
/// The caller is responsible for transitioning status on success —
/// this function only reports the outcome. `keep_going` is invoked
/// *before* each sleep+poll, so a caller that wants to short-circuit
/// when status moves away from `Starting` can do so without racing
/// the loop body.
///
/// `accept_any` treats *any* HTTP response as success rather than only
/// 2xx — koko's root endpoint may answer 4xx yet still mean "process is
/// up", so its readiness backstop sets this true.
pub async fn poll_health<F, Fut>(
    url: &str,
    name: &'static str,
    timeout: Duration,
    accept_any: bool,
    mut keep_going: F,
) -> bool
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    let client = http_client(timing::SHORT_HTTP_TIMEOUT);
    let attempts = (timeout.as_millis() / timing::HEALTH_POLL_INTERVAL.as_millis()) as usize;
    for _ in 0..attempts {
        if !keep_going().await {
            return false;
        }
        sleep(timing::HEALTH_POLL_INTERVAL).await;
        if let Ok(resp) = client.get(url).send().await {
            if resp.status().is_success() || accept_any {
                info!("{name} health check passed");
                return true;
            }
        }
    }
    false
}
