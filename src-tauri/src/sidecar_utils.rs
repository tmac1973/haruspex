//! Shared infrastructure for sidecar process management.
//!
//! Three sidecars (llama-server, whisper-server, koko) share lifecycle
//! concerns: killing orphaned processes on their port, polling a /health
//! endpoint until ready, capturing ANSI-stripped log lines into a ring
//! buffer, and reporting a `Stopped | Starting | Ready | Error` status to
//! the UI. This module owns those primitives so the three sidecar files
//! consume one canonical implementation each.

use crate::sidecar_process::SidecarChild;
use log::{error, info, warn};
use serde::Serialize;
use std::collections::VecDeque;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::{Command, CommandEvent};
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

    /// Overall deadline for a sidecar to answer `/health` and report Ready,
    /// measured from process spawn. Suits the CPU-bound STT/TTS sidecars.
    pub const HEALTH_POLL_TIMEOUT: Duration = Duration::from_secs(30);

    /// Longer health deadline for the LLM server: its first load mmaps a
    /// multi-GB model and initializes Vulkan before `/health` answers.
    pub const HEALTH_POLL_TIMEOUT_SLOW: Duration = Duration::from_secs(60);
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
#[derive(Clone, Debug, Serialize, PartialEq, Eq, ts_rs::TS)]
#[ts(export)]
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

/// Snapshot a sidecar's log ring buffer for the UI's log viewer.
pub async fn snapshot_logs(buf: &LogBuffer) -> Vec<String> {
    buf.lock().await.iter().cloned().collect()
}

/// Clear a sidecar's log ring buffer.
pub async fn clear_logs(buf: &LogBuffer) {
    buf.lock().await.clear();
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

/// Loopback host every sidecar binds to (`--host`) and every local URL
/// points at. One definition so the bind arg and the URL host can't drift.
pub const LOOPBACK: &str = "127.0.0.1";

fn localhost(port: u16) -> String {
    format!("{LOOPBACK}:{port}")
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
pub async fn kill_child(child: &Mutex<Option<SidecarChild>>, name: &str) -> Result<(), String> {
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

/// If a process of ours is bound to `port`, terminate it and wait for the port
/// to release. No-op when the port is already free.
///
/// Only our own processes are killed: a binary run from our install directory,
/// or one the sidecar registry recorded at that pid. This used to kill whatever
/// held the port, which would take down a user's own llama-server on 8765.
/// A port held by something else is an error naming that program, so the
/// sidecar's start fails with a reason Settings can show.
pub async fn kill_process_on_port(
    port: u16,
    name: &str,
    registry: Option<std::path::PathBuf>,
) -> Result<(), String> {
    if std::net::TcpStream::connect(localhost(port)).is_err() {
        return Ok(());
    }
    warn!("{name}: port {port} occupied, checking who holds it");

    let our_dir = std::env::current_exe()
        .ok()
        .and_then(|e| e.parent().map(|d| d.to_string_lossy().into_owned()))
        .unwrap_or_default();
    let recorded = registry
        .as_deref()
        .map(crate::orphans::load)
        .unwrap_or_default();

    for pid in pids_on_port(port) {
        let command = crate::orphans::pid_command(pid);
        if !is_ours(pid, command.as_deref(), &our_dir, &recorded) {
            let held_by = command.unwrap_or_else(|| format!("pid {pid}"));
            warn!("{name}: port {port} is held by {held_by}, not ours — not killing it");
            return Err(format!(
                "Port {port} is in use by another program ({held_by}), so {name} cannot start."
            ));
        }
        info!("Killing our stale {name} (pid {pid}) on port {port}");
        terminate(pid);
    }

    wait_for_port_release(port).await;
    Ok(())
}

/// Is the process at `pid`, with this command line, one of ours?
fn is_ours(
    pid: u32,
    command: Option<&str>,
    our_dir: &str,
    recorded: &[crate::orphans::RunningServer],
) -> bool {
    let Some(command) = command else {
        return false;
    };
    (!our_dir.is_empty() && command.contains(our_dir))
        || recorded
            .iter()
            .any(|r| r.pid == pid && crate::orphans::command_matches(&r.program, Some(command)))
}

/// The pids listening on `port`.
fn pids_on_port(port: u16) -> Vec<u32> {
    #[cfg(unix)]
    let pids = std::process::Command::new("lsof")
        .args(["-t", &format!("-iTCP:{port}"), "-sTCP:LISTEN"])
        .output()
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .filter_map(|l| l.trim().parse().ok())
                .collect()
        })
        .unwrap_or_default();
    #[cfg(windows)]
    let pids = std::process::Command::new("netstat")
        .args(["-ano"])
        .output()
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .filter(|l| l.contains(&format!(":{port} ")) && l.contains("LISTENING"))
                .filter_map(|l| l.split_whitespace().last()?.parse().ok())
                .collect()
        })
        .unwrap_or_default();
    pids
}

fn terminate(pid: u32) {
    #[cfg(unix)]
    unsafe {
        libc::kill(pid as i32, libc::SIGTERM);
    }
    #[cfg(windows)]
    let _ = std::process::Command::new("taskkill")
        .args(["/F", "/PID", &pid.to_string()])
        .output();
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orphans::RunningServer;

    fn record(pid: u32, program: &str) -> RunningServer {
        RunningServer {
            id: "sd-server".into(),
            pid,
            started_at: 0,
            program: program.into(),
        }
    }

    #[test]
    fn our_install_directory_makes_a_process_ours() {
        let dir = "/opt/haruspex";
        assert!(is_ours(
            7,
            Some("/opt/haruspex/llama-server --port 8765"),
            dir,
            &[]
        ));
        assert!(!is_ours(
            7,
            Some("/usr/bin/llama-server --port 8765"),
            dir,
            &[]
        ));
        assert!(
            !is_ours(7, None, dir, &[]),
            "a vanished process is not ours to kill"
        );
    }

    #[test]
    fn a_recorded_pid_is_ours_only_while_it_runs_what_we_recorded() {
        // An AppImage mounts at a new path every launch, so an orphan from the
        // last one is not under today's directory; the registry vouches for it.
        let rec = [record(7, "/tmp/.mount_abc/sd-server")];
        assert!(is_ours(
            7,
            Some("/tmp/.mount_abc/sd-server --listen-port 8767"),
            "/tmp/.mount_new",
            &rec
        ));
        assert!(
            !is_ours(7, Some("/usr/bin/firefox"), "/tmp/.mount_new", &rec),
            "pid reused"
        );
        assert!(
            !is_ours(
                8,
                Some("/tmp/.mount_abc/sd-server"),
                "/tmp/.mount_new",
                &rec
            ),
            "other pid"
        );
    }

    #[test]
    fn an_empty_install_directory_matches_nothing() {
        assert!(!is_ours(7, Some("/anything"), "", &[]));
    }

    /// Someone else's server on the port is left running and named.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_port_held_by_another_program_is_left_alone() {
        if std::process::Command::new("lsof")
            .arg("-v")
            .output()
            .is_err()
        {
            return; // no lsof: the holder cannot be found on this machine
        }
        let port = {
            let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap().port()
        };
        let Ok(mut other) = std::process::Command::new("python3")
            .args([
                "-c",
                &format!(
                    "import socket,time;s=socket.socket();s.bind(('127.0.0.1',{port}));s.listen();time.sleep(30)"
                ),
            ])
            .spawn()
        else {
            return; // no python3: nothing to hold the port with
        };
        // Wait until python3 is genuinely listening, and say so when it never
        // is. `kill_process_on_port` returns `Ok(())` the moment nothing holds
        // the port, so a holder that has not come up yet does not fail this
        // test's subject — it panics on `expect_err` with `not ours: ()`, which
        // names neither the port nor Python. The budget was one second, which a
        // cold interpreter on a loaded CI runner can miss.
        //
        // The early-exit check matters as much as the budget: the port is found
        // by binding a probe listener and dropping it, so python3 can lose the
        // race for it and die with "Address already in use" — and then waiting
        // longer cannot help.
        let mut held = false;
        for _ in 0..200 {
            if std::net::TcpStream::connect(localhost(port)).is_ok() {
                held = true;
                break;
            }
            if let Ok(Some(status)) = other.try_wait() {
                eprintln!("skipping: python3 exited before binding {port} ({status})");
                return;
            }
            sleep(Duration::from_millis(50)).await;
        }
        if !held {
            eprintln!("skipping: python3 never bound {port} within 10s");
            let _ = other.kill();
            let _ = other.wait();
            return;
        }

        let err = kill_process_on_port(port, "test-sidecar", None)
            .await
            .expect_err("a port held by python3 must be reported, not killed");
        // Named by its command line, whatever the platform calls Python
        // (macOS: ".../Python.app/Contents/MacOS/Python").
        assert!(
            err.contains("another program") && err.to_lowercase().contains("python"),
            "{err}"
        );
        assert!(
            other.try_wait().unwrap().is_none(),
            "python3 must still be running"
        );
        other.kill().unwrap();
        other.wait().unwrap();
    }
}
