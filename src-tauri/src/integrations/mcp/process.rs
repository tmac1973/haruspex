//! Supervising MCP server child processes.
//!
//! Lifecycle before protocol. For a desktop app the servers that matter are
//! local stdio children, and lifecycle is the part that actually bites: a
//! crashed server that leaves the UI claiming "connected", a child that
//! outlives the app, a hang that never resolves. This module owns all of that
//! so Phase 03 can be about negotiation and nothing else.
//!
//! **Built around rmcp's transport, not a hand-rolled spawn.** rmcp's
//! [`TokioChildProcess`] spawns the child itself and owns its stdin/stdout —
//! those pipes *are* the protocol transport. The supervisor is therefore built
//! around that type, which shapes two things:
//!
//! - Only stderr is ours to read. stdout belongs to the transport.
//! - The child handle is not exposed, so `try_wait()` is unavailable. Exit is
//!   detected by **stderr reaching EOF**, which happens when the process dies.
//!   The tradeoff is that we log the child's own last words rather than a
//!   numeric exit status, and the log tail is what the UI shows anyway.
//!
//! **Readiness is provisional.** Phase 03 replaces it with the first successful
//! protocol response. Until then a server is Ready once it has survived
//! [`timing::STARTUP_SETTLE`] without exiting — enough to separate "started"
//! from "died on launch", which is the distinction that matters to a user
//! staring at a status dot. It cannot see a server that starts and then hangs;
//! that is a protocol-level fact, and [`McpSupervisor::record_timeout`] is the
//! hook Phase 03 drives for it.
//!
//! **Nothing auto-restarts.** A server that crashes on startup would spin
//! forever, burning CPU and filling the log ring. Restart is a user action.

use log::{info, warn};
use rmcp::transport::TokioChildProcess;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::AppHandle;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::Mutex;

use super::orphans::{self, RunningServer};
use crate::sidecar_utils::{new_log_buffer, push_log, LogBuffer, SidecarStatus};

pub mod timing {
    use std::time::Duration;

    /// How long a freshly spawned server must stay alive before it counts as
    /// Ready. A server that is going to die on launch dies well inside this;
    /// anything longer just makes a healthy start feel slow.
    pub const STARTUP_SETTLE: Duration = Duration::from_millis(250);

    /// Upper bound on the whole stop sequence. Deliberately longer than the
    /// 3s rmcp spends waiting inside `graceful_shutdown` before it kills, so
    /// the graceful path gets to finish; if it does not, dropping the handle
    /// kills the child anyway.
    pub const STOP_GRACE: Duration = Duration::from_secs(5);
}

/// Consecutive request timeouts before a server is declared broken. One
/// timeout is a slow tool; three in a row is a server that has stopped
/// answering. Phase 03 feeds this from real requests.
pub const MAX_CONSECUTIVE_TIMEOUTS: u32 = 3;

/// Log lines quoted into an `Error` status. Enough to show the cause, short
/// enough to sit in a settings row.
const ERROR_TAIL_LINES: usize = 5;

/// Everything needed to spawn — and later respawn — one server.
///
/// Phase 04 builds these from catalog entries and user configuration; nothing
/// stores them yet.
#[derive(Clone, Debug, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct SpawnConfig {
    /// Stable id for this configured server. Also the key in the supervisor's
    /// map and in the orphan registry.
    pub id: String,
    /// Absolute path to the program. Never a bare name resolved off `PATH` —
    /// see `runtimes.rs` on why a `PATH` we do not control is a bug source.
    pub program: PathBuf,
    #[serde(default)]
    pub args: Vec<String>,
    /// Explicit environment for the child, applied on top of a cleared
    /// environment.
    #[serde(default)]
    pub env: Vec<(String, String)>,
    #[serde(default)]
    pub cwd: Option<PathBuf>,
}

/// One supervised server.
///
/// Deliberately does not hold the `SpawnConfig`: Phase 04 stores configuration
/// in settings, and a second copy here would be the one that goes stale. The
/// supervisor's job is the running process, not the record of how to make one.
struct ServerHandle {
    status: Arc<Mutex<SidecarStatus>>,
    log: LogBuffer,
    pid: Option<u32>,
    /// The transport, and with it ownership of the child. Phase 03 moves this
    /// into an rmcp service; until then the supervisor holds it so `stop` can
    /// shut it down gracefully.
    process: Option<TokioChildProcess>,
    consecutive_timeouts: u32,
}

/// Tauri-managed state: every MCP server this app has spawned.
#[derive(Default)]
pub struct McpSupervisor {
    servers: Mutex<HashMap<String, ServerHandle>>,
}

impl McpSupervisor {
    pub fn new() -> Self {
        Self::default()
    }

    /// Spawn a server and wait out the settle window.
    ///
    /// Errors if the id is already running: restarting is [`Self::stop`] then
    /// `start`, so that the caller — and the user — decides.
    pub async fn start(&self, app: &AppHandle, config: SpawnConfig) -> Result<(), String> {
        {
            let servers = self.servers.lock().await;
            if let Some(existing) = servers.get(&config.id) {
                let status = existing.status.lock().await;
                if !matches!(*status, SidecarStatus::Stopped | SidecarStatus::Error(_)) {
                    return Err(format!("server {} is already running", config.id));
                }
            }
        }

        let status = Arc::new(Mutex::new(SidecarStatus::Starting));
        let log = new_log_buffer();
        let exited = Arc::new(AtomicBool::new(false));

        let mut cmd = tokio::process::Command::new(&config.program);
        cmd.args(&config.args);
        // Cleared, not inherited: an MCP server must behave the same on the
        // user's machine as on ours, and the ambient environment is where that
        // guarantee goes to die. The catalog supplies what a server needs.
        cmd.env_clear();
        for (key, value) in &config.env {
            cmd.env(key, value);
        }
        if let Some(cwd) = &config.cwd {
            cmd.current_dir(cwd);
        }

        let (process, stderr) = TokioChildProcess::builder(cmd)
            // rmcp inherits stderr by default, which would send a server's
            // diagnostics to our own console instead of its log ring.
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("could not start {}: {e}", config.program.display()))?;

        let pid = process.id();
        if let Some(pid) = pid {
            orphans::register(
                app,
                RunningServer {
                    id: config.id.clone(),
                    pid,
                    started_at: std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_secs())
                        .unwrap_or_default(),
                    program: config.program.to_string_lossy().to_string(),
                },
            );
        }

        if let Some(stderr) = stderr {
            spawn_stderr_reader(
                config.id.clone(),
                stderr,
                status.clone(),
                log.clone(),
                exited.clone(),
            );
        }

        let id = config.id.clone();
        self.servers.lock().await.insert(
            id.clone(),
            ServerHandle {
                status: status.clone(),
                log: log.clone(),
                pid,
                process: Some(process),
                consecutive_timeouts: 0,
            },
        );

        match settle(&status, &exited, &log).await {
            SidecarStatus::Ready => {
                info!("mcp: server {id} started (pid {pid:?})");
                Ok(())
            }
            SidecarStatus::Error(reason) => {
                orphans::deregister(app, &id);
                Err(reason)
            }
            other => Err(format!("server {id} did not start: {other:?}")),
        }
    }

    /// Stop a server: graceful first, killed if it will not go.
    ///
    /// Idempotent — stopping something already stopped is not an error.
    pub async fn stop(&self, app: &AppHandle, id: &str) -> Result<(), String> {
        let mut servers = self.servers.lock().await;
        let Some(handle) = servers.get_mut(id) else {
            return Ok(());
        };

        // Set Stopped *before* shutting down, so the stderr reader sees a
        // deliberate stop when the pipe closes and does not report a crash.
        *handle.status.lock().await = SidecarStatus::Stopped;
        handle.consecutive_timeouts = 0;

        if let Some(mut process) = handle.process.take() {
            match tokio::time::timeout(timing::STOP_GRACE, process.graceful_shutdown()).await {
                Ok(Ok(())) => {}
                Ok(Err(e)) => warn!("mcp: {id} did not shut down cleanly: {e}"),
                Err(_) => warn!("mcp: {id} ignored the stop deadline; killing it"),
            }
            // Dropping the transport kills the child if it is somehow still
            // alive; rmcp's ChildWithCleanup does that in its Drop.
            drop(process);
        }
        handle.pid = None;
        orphans::deregister(app, id);
        info!("mcp: server {id} stopped");
        Ok(())
    }

    /// Stop every server. Used on app exit, from both the window-destroyed and
    /// run-exit paths — neither covers every quit on its own.
    pub async fn stop_all(&self, app: &AppHandle) {
        let ids: Vec<String> = self.servers.lock().await.keys().cloned().collect();
        for id in ids {
            let _ = self.stop(app, &id).await;
        }
    }

    pub async fn status(&self, id: &str) -> SidecarStatus {
        match self.servers.lock().await.get(id) {
            Some(handle) => handle.status.lock().await.clone(),
            None => SidecarStatus::Stopped,
        }
    }

    pub async fn logs(&self, id: &str) -> Vec<String> {
        match self.servers.lock().await.get(id) {
            Some(handle) => handle.log.lock().await.iter().cloned().collect(),
            None => Vec::new(),
        }
    }

    pub async fn clear_logs(&self, id: &str) {
        if let Some(handle) = self.servers.lock().await.get(id) {
            handle.log.lock().await.clear();
        }
    }

    /// Record a request that timed out.
    ///
    /// A single timeout fails only that request — the server stays up, because
    /// one slow tool call is not a broken server. [`MAX_CONSECUTIVE_TIMEOUTS`]
    /// in a row is, and moves it to `Error`. Returns whether that happened.
    ///
    /// Unused until Phase 03 has requests to time out; the mechanism belongs
    /// here with the rest of the lifecycle.
    #[allow(dead_code)]
    pub async fn record_timeout(&self, id: &str) -> bool {
        let mut servers = self.servers.lock().await;
        let Some(handle) = servers.get_mut(id) else {
            return false;
        };
        handle.consecutive_timeouts += 1;
        if handle.consecutive_timeouts < MAX_CONSECUTIVE_TIMEOUTS {
            return false;
        }
        let mut status = handle.status.lock().await;
        if matches!(*status, SidecarStatus::Ready | SidecarStatus::Starting) {
            *status = SidecarStatus::Error(format!(
                "stopped responding after {MAX_CONSECUTIVE_TIMEOUTS} timed-out requests"
            ));
            warn!("mcp: server {id} stopped responding");
            return true;
        }
        false
    }

    /// Record a request that answered, clearing the timeout streak. Paired
    /// with [`Self::record_timeout`], and unused for the same reason.
    #[allow(dead_code)]
    pub async fn record_success(&self, id: &str) {
        if let Some(handle) = self.servers.lock().await.get_mut(id) {
            handle.consecutive_timeouts = 0;
        }
    }
}

/// Drain a child's stderr into its log ring, and treat EOF as the child
/// exiting.
///
/// This is the crash detector. rmcp does not hand back the child handle, so
/// there is nothing to `wait()` on; the pipe closing is the signal.
fn spawn_stderr_reader(
    id: String,
    stderr: tokio::process::ChildStderr,
    status: Arc<Mutex<SidecarStatus>>,
    log: LogBuffer,
    exited: Arc<AtomicBool>,
) {
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    let mut buf = log.lock().await;
                    push_log(&mut buf, &line);
                }
                Ok(None) => break,
                Err(e) => {
                    let mut buf = log.lock().await;
                    push_log(&mut buf, &format!("[stderr read failed: {e}]"));
                    break;
                }
            }
        }

        exited.store(true, Ordering::SeqCst);
        let mut current = status.lock().await;
        // A deliberate stop already set Stopped, and an existing Error has a
        // more specific reason than "it exited". Neither should be overwritten.
        if matches!(*current, SidecarStatus::Starting | SidecarStatus::Ready) {
            let reason = format!("server exited unexpectedly{}", log_tail(&log).await);
            warn!("mcp: server {id} exited unexpectedly");
            *current = SidecarStatus::Error(reason);
        }
    });
}

/// Wait out the settle window and decide what the server's status is.
///
/// This is the whole of Phase 02's readiness rule, in one place so the tests
/// exercise the real decision rather than a paraphrase of it. Phase 03 replaces
/// the sleep with the first successful protocol response.
async fn settle(
    status: &Arc<Mutex<SidecarStatus>>,
    exited: &Arc<AtomicBool>,
    log: &LogBuffer,
) -> SidecarStatus {
    tokio::time::sleep(timing::STARTUP_SETTLE).await;
    let mut current = status.lock().await;
    if exited.load(Ordering::SeqCst) {
        // The stderr reader may have set its own Error already; its reason is
        // the more specific one, so only fill in when it has not.
        if matches!(*current, SidecarStatus::Starting) {
            *current =
                SidecarStatus::Error(format!("server exited on startup{}", log_tail(log).await));
        }
    } else if matches!(*current, SidecarStatus::Starting) {
        *current = SidecarStatus::Ready;
    }
    current.clone()
}

/// The last few log lines, formatted for appending to an error message.
async fn log_tail(log: &LogBuffer) -> String {
    let buf = log.lock().await;
    let lines: Vec<String> = buf
        .iter()
        .rev()
        .take(ERROR_TAIL_LINES)
        .rev()
        .cloned()
        .collect();
    if lines.is_empty() {
        String::new()
    } else {
        format!(": {}", lines.join(" | "))
    }
}

#[tauri::command]
pub async fn mcp_start_server(
    app: AppHandle,
    supervisor: tauri::State<'_, McpSupervisor>,
    config: SpawnConfig,
) -> Result<(), String> {
    supervisor.start(&app, config).await
}

#[tauri::command]
pub async fn mcp_stop_server(
    app: AppHandle,
    supervisor: tauri::State<'_, McpSupervisor>,
    id: String,
) -> Result<(), String> {
    supervisor.stop(&app, &id).await
}

#[tauri::command]
pub async fn mcp_server_status(
    supervisor: tauri::State<'_, McpSupervisor>,
    id: String,
) -> Result<SidecarStatus, String> {
    Ok(supervisor.status(&id).await)
}

#[tauri::command]
pub async fn mcp_server_logs(
    supervisor: tauri::State<'_, McpSupervisor>,
    id: String,
) -> Result<Vec<String>, String> {
    Ok(supervisor.logs(&id).await)
}

#[tauri::command]
pub async fn mcp_clear_server_logs(
    supervisor: tauri::State<'_, McpSupervisor>,
    id: String,
) -> Result<(), String> {
    supervisor.clear_logs(&id).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    /// The fixture stands in for an MCP server: it speaks no protocol, but it
    /// can start, crash, hang and echo, which is the matrix the supervisor has
    /// to survive. Run through the bundled Node from Phase 01.
    fn fixture_config(id: &str, mode: &str) -> Option<SpawnConfig> {
        let node = crate::runtimes::node_path().ok()?;
        // CI stubs the sidecars with `#!/bin/sh` placeholders rather than
        // fetching real ones, so confirm this is actually Node before relying
        // on it. Skipping beats a failure that says nothing about our code.
        let version = std::process::Command::new(&node).arg("--version").output();
        let usable = version.is_ok_and(|out| {
            out.status.success() && String::from_utf8_lossy(&out.stdout).starts_with('v')
        });
        if !usable {
            eprintln!("skipping: no usable bundled node (run ./scripts/fetch-node.sh)");
            return None;
        }
        let script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join("mcp-echo-server.js");
        assert!(script.is_file(), "fixture missing at {}", script.display());
        Some(SpawnConfig {
            id: id.to_string(),
            program: node,
            args: vec![script.to_string_lossy().to_string(), mode.to_string()],
            env: Vec::new(),
            cwd: None,
        })
    }

    /// Spawn the fixture the way `start` does, without needing an `AppHandle`.
    /// The orphan registry is exercised separately in `orphans.rs`.
    fn spawn_fixture(
        config: &SpawnConfig,
    ) -> (TokioChildProcess, Option<tokio::process::ChildStderr>) {
        let mut cmd = tokio::process::Command::new(&config.program);
        cmd.args(&config.args);
        cmd.env_clear();
        TokioChildProcess::builder(cmd)
            .stderr(Stdio::piped())
            .spawn()
            .expect("fixture should spawn")
    }

    async fn run_fixture(mode: &str) -> Option<(SidecarStatus, Vec<String>)> {
        let config = fixture_config("test", mode)?;
        let (process, stderr) = spawn_fixture(&config);
        let status = Arc::new(Mutex::new(SidecarStatus::Starting));
        let log = new_log_buffer();
        let exited = Arc::new(AtomicBool::new(false));
        spawn_stderr_reader(
            "test".into(),
            stderr.expect("stderr is piped"),
            status.clone(),
            log.clone(),
            exited.clone(),
        );
        let settled = settle(&status, &exited, &log).await;
        let lines = log.lock().await.iter().cloned().collect();
        drop(process);
        Some((settled, lines))
    }

    #[tokio::test]
    async fn a_normal_server_settles_into_ready_and_captures_its_stderr() {
        let Some((status, logs)) = run_fixture("normal").await else {
            return;
        };
        assert_eq!(status, SidecarStatus::Ready);
        assert!(
            logs.iter().any(|l| l.contains("fixture: ready")),
            "the server's own diagnostics must reach the log ring, got {logs:?}"
        );
    }

    #[tokio::test]
    async fn a_server_that_exits_immediately_lands_in_error_with_its_last_words() {
        let Some((status, logs)) = run_fixture("exit-immediately").await else {
            return;
        };
        let SidecarStatus::Error(reason) = status else {
            panic!("expected Error, got {status:?}");
        };
        assert!(
            reason.contains("exit"),
            "the reason should say it exited, got {reason:?}"
        );
        assert!(
            reason.contains("exiting immediately"),
            "the log tail should be quoted into the reason, got {reason:?}"
        );
        assert!(!logs.is_empty());
    }

    #[tokio::test]
    async fn a_hung_server_is_ready_because_process_liveness_cannot_see_a_hang() {
        // Documents the limit deliberately: a server that starts and then
        // never answers is indistinguishable from a healthy idle one at the
        // process level. Detecting it is a protocol fact — see
        // `record_timeout`, which Phase 03 drives.
        let Some((status, _)) = run_fixture("hang").await else {
            return;
        };
        assert_eq!(status, SidecarStatus::Ready);
    }

    #[tokio::test]
    async fn a_noisy_server_does_not_grow_its_log_ring_without_bound() {
        let Some((status, logs)) = run_fixture("noisy").await else {
            return;
        };
        assert_eq!(status, SidecarStatus::Ready);
        assert!(
            logs.len() >= 50,
            "expected the noisy output, got {}",
            logs.len()
        );
        assert!(
            logs.len() <= crate::sidecar_utils::LOG_RING_BUFFER_SIZE,
            "the ring buffer must bound the log"
        );
    }

    #[tokio::test]
    async fn a_deliberate_stop_is_not_reported_as_a_crash() {
        let Some(config) = fixture_config("test", "normal") else {
            return;
        };
        let (mut process, stderr) = spawn_fixture(&config);
        let status = Arc::new(Mutex::new(SidecarStatus::Ready));
        let log = new_log_buffer();
        let exited = Arc::new(AtomicBool::new(false));
        spawn_stderr_reader(
            "test".into(),
            stderr.expect("stderr is piped"),
            status.clone(),
            log,
            exited,
        );

        // What `stop` does: mark Stopped before shutting anything down, so the
        // stderr EOF that follows is understood as deliberate.
        *status.lock().await = SidecarStatus::Stopped;
        let _ = tokio::time::timeout(timing::STOP_GRACE, process.graceful_shutdown()).await;
        drop(process);
        tokio::time::sleep(Duration::from_millis(200)).await;

        assert_eq!(
            *status.lock().await,
            SidecarStatus::Stopped,
            "a user-initiated stop must not surface as an error"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_server_killed_from_outside_reports_error_not_a_stale_ready() {
        // The failure this guards against: the user kills a server from a task
        // manager, and Settings keeps showing a green dot while every tool call
        // fails. SIGKILL gives the child no chance to say anything, so the only
        // signal is its stderr pipe closing.
        let Some(config) = fixture_config("test", "normal") else {
            return;
        };
        let (process, stderr) = spawn_fixture(&config);
        let pid = process.id().expect("a spawned child has a pid");
        let status = Arc::new(Mutex::new(SidecarStatus::Ready));
        let log = new_log_buffer();
        let exited = Arc::new(AtomicBool::new(false));
        spawn_stderr_reader(
            "test".into(),
            stderr.expect("stderr is piped"),
            status.clone(),
            log,
            exited,
        );

        assert!(std::process::Command::new("kill")
            .args(["-9", &pid.to_string()])
            .status()
            .expect("kill should run")
            .success());

        // Poll rather than sleep a fixed span: the reader wakes on pipe close,
        // which is fast but not instant.
        let mut observed = SidecarStatus::Ready;
        for _ in 0..50 {
            tokio::time::sleep(Duration::from_millis(20)).await;
            observed = status.lock().await.clone();
            if !matches!(observed, SidecarStatus::Ready) {
                break;
            }
        }
        assert!(
            matches!(observed, SidecarStatus::Error(_)),
            "an externally killed server must not stay Ready, got {observed:?}"
        );
        drop(process);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stopping_during_startup_leaves_no_child_behind() {
        let Some(config) = fixture_config("test", "hang") else {
            return;
        };
        let (mut process, _stderr) = spawn_fixture(&config);
        let pid = process.id().expect("a spawned child has a pid");
        let _ = tokio::time::timeout(timing::STOP_GRACE, process.graceful_shutdown()).await;
        drop(process);
        // rmcp's ChildWithCleanup kills from a spawned task on drop, so give
        // the runtime a moment before checking.
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(
            !pid_is_alive(pid),
            "pid {pid} survived a stop issued during startup"
        );
    }

    /// Is this pid a live process? `kill -0` succeeds for a zombie too, so
    /// the check goes through `ps`, which reports state and omits nothing we
    /// care about. Unix only; the Windows equivalent is a manual step in the
    /// phase's test plan.
    #[cfg(unix)]
    fn pid_is_alive(pid: u32) -> bool {
        let Ok(out) = std::process::Command::new("ps")
            .args(["-p", &pid.to_string(), "-o", "state="])
            .output()
        else {
            return false;
        };
        let state = String::from_utf8_lossy(&out.stdout);
        let state = state.trim();
        // Z is a reaped-but-not-collected corpse, not a running server.
        !state.is_empty() && !state.starts_with('Z')
    }

    #[tokio::test]
    async fn timeouts_only_break_a_server_once_they_repeat() {
        let supervisor = McpSupervisor::new();
        let status = Arc::new(Mutex::new(SidecarStatus::Ready));
        supervisor.servers.lock().await.insert(
            "s".into(),
            ServerHandle {
                status: status.clone(),
                log: new_log_buffer(),
                pid: None,
                process: None,
                consecutive_timeouts: 0,
            },
        );

        for _ in 1..MAX_CONSECUTIVE_TIMEOUTS {
            assert!(!supervisor.record_timeout("s").await);
            assert_eq!(supervisor.status("s").await, SidecarStatus::Ready);
        }
        assert!(supervisor.record_timeout("s").await);
        assert!(matches!(
            supervisor.status("s").await,
            SidecarStatus::Error(_)
        ));
    }

    #[tokio::test]
    async fn a_successful_request_clears_the_timeout_streak() {
        let supervisor = McpSupervisor::new();
        supervisor.servers.lock().await.insert(
            "s".into(),
            ServerHandle {
                status: Arc::new(Mutex::new(SidecarStatus::Ready)),
                log: new_log_buffer(),
                pid: None,
                process: None,
                consecutive_timeouts: 0,
            },
        );

        for _ in 1..MAX_CONSECUTIVE_TIMEOUTS {
            supervisor.record_timeout("s").await;
        }
        supervisor.record_success("s").await;
        // The streak restarted, so the next timeout must not be the fatal one.
        assert!(!supervisor.record_timeout("s").await);
        assert_eq!(supervisor.status("s").await, SidecarStatus::Ready);
    }

    #[tokio::test]
    async fn an_unknown_server_reads_as_stopped_rather_than_failing() {
        let supervisor = McpSupervisor::new();
        assert_eq!(supervisor.status("nope").await, SidecarStatus::Stopped);
        assert!(supervisor.logs("nope").await.is_empty());
        assert!(!supervisor.record_timeout("nope").await);
    }

    #[tokio::test]
    async fn the_log_tail_is_bounded_and_omitted_when_empty() {
        let log = new_log_buffer();
        assert_eq!(log_tail(&log).await, "");
        {
            let mut buf = log.lock().await;
            for i in 0..20 {
                push_log(&mut buf, &format!("line {i}"));
            }
        }
        let tail = log_tail(&log).await;
        assert!(
            tail.contains("line 19"),
            "the tail should be the newest lines"
        );
        assert!(!tail.contains("line 14"), "the tail should be bounded");
        assert_eq!(tail.matches(" | ").count(), ERROR_TAIL_LINES - 1);
    }
}
