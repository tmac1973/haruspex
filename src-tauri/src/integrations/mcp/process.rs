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
//! **Ready means the protocol answered.** Not "the process is alive" — a server
//! that launches and then never speaks is exactly the failure a status dot must
//! not call healthy. `start` spawns the child and then negotiates; only a
//! completed negotiation reaches `Ready`, and the handle records which protocol
//! era and version it settled on. A server that never answers is killed at
//! [`timing::NEGOTIATION_DEADLINE`].
//!
//! Hangs *after* negotiation are a different failure, and per-request:
//! [`McpSupervisor::record_timeout`] fails one request but breaks the server
//! after three in a row.
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
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::Mutex;

use super::client::McpSession;
use super::companion::CompanionStatus;
use super::orphans::{self, RunningServer};
use super::types::{McpCallOutcome, McpConnectionInfo, McpToolDescriptor};
use crate::sidecar_utils::{new_log_buffer, push_log, LogBuffer, SidecarStatus};
use std::path::Path;

pub mod timing {
    use std::time::Duration;

    /// How long a freshly spawned server has to complete MCP negotiation
    /// before it is killed and reported broken.
    ///
    /// Generous, because it covers rmcp's own 10s `server/discover` probe
    /// timeout plus the legacy `initialize` handshake that follows it — a
    /// silent legacy server spends the full probe timeout before the fallback
    /// even starts. Shorter than this and a legitimately slow legacy server
    /// would look dead.
    pub const NEGOTIATION_DEADLINE: Duration = Duration::from_secs(20);

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
    /// The negotiated MCP session, which owns the transport and with it the
    /// child. `Arc` so a tool call can be driven without holding the map's
    /// lock across the await — one slow tool must not freeze every other
    /// server's status query.
    session: Option<Arc<McpSession>>,
    /// What negotiation settled on. `None` until it succeeds.
    connection: Option<McpConnectionInfo>,
    /// Whether the third-party application this server bridges to is
    /// reachable. Beside the process status rather than inside it: the process
    /// is genuinely fine when this is `Disconnected`. See `companion.rs`.
    companion: CompanionStatus,
    consecutive_timeouts: u32,
}

/// Tauri-managed state: every MCP server this app has spawned.
///
/// Holds the orphan-registry path rather than an `AppHandle`, so the whole
/// supervisor can be driven in tests against a temp directory. Resolving that
/// path is the only thing it ever needed the handle for.
#[derive(Default)]
pub struct McpSupervisor {
    servers: Mutex<HashMap<String, ServerHandle>>,
    registry_path: Option<PathBuf>,
}

impl McpSupervisor {
    pub fn new(registry_path: Option<PathBuf>) -> Self {
        Self {
            servers: Mutex::new(HashMap::new()),
            registry_path,
        }
    }

    fn registry(&self) -> Option<&Path> {
        self.registry_path.as_deref()
    }

    /// The negotiated era and version for a connected server, for the UI.
    pub async fn connection(&self, id: &str) -> Option<McpConnectionInfo> {
        self.servers.lock().await.get(id)?.connection.clone()
    }

    /// The last known companion state. `Unknown` for a server with no companion
    /// at all, which the UI reads as "nothing to say".
    pub async fn companion(&self, id: &str) -> CompanionStatus {
        self.servers
            .lock()
            .await
            .get(id)
            .map(|h| h.companion.clone())
            .unwrap_or(CompanionStatus::Unknown)
    }

    pub async fn set_companion(&self, id: &str, status: CompanionStatus) {
        if let Some(handle) = self.servers.lock().await.get_mut(id) {
            handle.companion = status;
        }
    }

    /// The tools a connected server publishes.
    pub async fn list_tools(&self, id: &str) -> Result<Vec<McpToolDescriptor>, String> {
        self.session(id).await?.list_tools().await
    }

    /// One `tools/call` round trip. See `client.rs` on why a round trip rather
    /// than a completed call.
    pub async fn call_tool(
        &self,
        id: &str,
        name: &str,
        arguments: Option<serde_json::Map<String, serde_json::Value>>,
        input_responses: Option<std::collections::BTreeMap<String, serde_json::Value>>,
        request_state: Option<String>,
    ) -> Result<McpCallOutcome, String> {
        self.session(id)
            .await?
            .call_tool(name, arguments, input_responses, request_state)
            .await
    }

    /// Clone the session handle out from under the lock, so a slow call cannot
    /// freeze status queries for every other server.
    async fn session(&self, id: &str) -> Result<Arc<McpSession>, String> {
        self.servers
            .lock()
            .await
            .get(id)
            .and_then(|handle| handle.session.clone())
            .ok_or_else(|| format!("server {id} is not connected"))
    }

    /// Spawn a server and wait out the settle window.
    ///
    /// Errors if the id is already running: restarting is [`Self::stop`] then
    /// `start`, so that the caller — and the user — decides.
    pub async fn start(&self, config: SpawnConfig) -> Result<(), String> {
        self.start_within(config, timing::NEGOTIATION_DEADLINE)
            .await
    }

    /// [`Self::start`] with an explicit negotiation deadline. Private because
    /// the deadline is a property of the product, not of the caller; the tests
    /// shorten it so the "never answers" case does not cost 20 seconds.
    async fn start_within(
        &self,
        config: SpawnConfig,
        negotiation_deadline: std::time::Duration,
    ) -> Result<(), String> {
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
                self.registry(),
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
                session: None,
                connection: None,
                companion: CompanionStatus::Unknown,
                consecutive_timeouts: 0,
            },
        );

        // Negotiation takes ownership of the transport, so a failure past this
        // point cannot hand the child back — dropping the transport kills it,
        // which is what we want for a server that will not speak.
        let negotiated =
            match tokio::time::timeout(negotiation_deadline, McpSession::connect(process)).await {
                Ok(Ok(session)) => Ok(session),
                Ok(Err(_)) if exited.load(Ordering::SeqCst) => {
                    // The child died rather than disagreeing with us; its own
                    // last words are the more useful diagnostic.
                    Err(format!("server exited on startup{}", log_tail(&log).await))
                }
                Ok(Err(e)) => Err(format!("{e}{}", log_tail(&log).await)),
                Err(_) => Err(format!(
                    "server did not answer MCP within {}s{}",
                    negotiation_deadline.as_secs(),
                    log_tail(&log).await
                )),
            };

        match negotiated {
            Ok(session) => {
                let connection = session.info().clone();
                info!(
                    "mcp: server {id} ready (pid {pid:?}, {:?} {})",
                    connection.era, connection.protocol_version
                );
                if let Some(handle) = self.servers.lock().await.get_mut(&id) {
                    handle.session = Some(Arc::new(session));
                    handle.connection = Some(connection);
                }
                let mut current = status.lock().await;
                if matches!(*current, SidecarStatus::Starting) {
                    *current = SidecarStatus::Ready;
                }
                Ok(())
            }
            Err(reason) => {
                *status.lock().await = SidecarStatus::Error(reason.clone());
                orphans::deregister(self.registry(), &id);
                warn!("mcp: server {id} failed to start: {reason}");
                Err(reason)
            }
        }
    }

    /// Stop a server: graceful first, killed if it will not go.
    ///
    /// Idempotent — stopping something already stopped is not an error.
    pub async fn stop(&self, id: &str) -> Result<(), String> {
        let mut servers = self.servers.lock().await;
        let Some(handle) = servers.get_mut(id) else {
            return Ok(());
        };

        // Set Stopped *before* shutting down, so the stderr reader sees a
        // deliberate stop when the pipe closes and does not report a crash.
        *handle.status.lock().await = SidecarStatus::Stopped;
        handle.consecutive_timeouts = 0;

        handle.connection = None;
        handle.companion = CompanionStatus::Unknown;
        if let Some(session) = handle.session.take() {
            match Arc::into_inner(session) {
                Some(session) => {
                    if tokio::time::timeout(timing::STOP_GRACE, session.shutdown())
                        .await
                        .is_err()
                    {
                        warn!("mcp: {id} ignored the stop deadline; killing it");
                    }
                }
                // A tool call is still in flight and holds the other reference.
                // Dropping ours is enough: when the call finishes, the last
                // reference goes and rmcp's ChildWithCleanup kills the child.
                None => warn!("mcp: {id} stopped with a call in flight; it will be killed"),
            }
        }
        handle.pid = None;
        orphans::deregister(self.registry(), id);
        info!("mcp: server {id} stopped");
        Ok(())
    }

    /// Stop every server. Used on app exit, from both the window-destroyed and
    /// run-exit paths — neither covers every quit on its own.
    pub async fn stop_all(&self) {
        let ids: Vec<String> = self.servers.lock().await.keys().cloned().collect();
        for id in ids {
            let _ = self.stop(&id).await;
        }
    }

    /// The child's pid. Only the tests need it — the UI shows status and logs,
    /// not process identity.
    #[cfg(test)]
    pub async fn pid_for(&self, id: &str) -> Option<u32> {
        self.servers.lock().await.get(id)?.pid
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::integrations::mcp::types::McpProtocolEra;
    use std::time::Duration;

    /// Locate a fixture script, or `None` when the bundled Node is a CI
    /// placeholder rather than a real interpreter. Skipping beats a failure
    /// that says nothing about our code.
    fn fixture_config(id: &str, script: &str, mode: &str) -> Option<SpawnConfig> {
        let node = crate::runtimes::node_path().ok()?;
        let usable = std::process::Command::new(&node)
            .arg("--version")
            .output()
            .is_ok_and(|out| {
                out.status.success() && String::from_utf8_lossy(&out.stdout).starts_with('v')
            });
        if !usable {
            eprintln!("skipping: no usable bundled node (run ./scripts/fetch-node.sh)");
            return None;
        }
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join(script);
        assert!(path.is_file(), "fixture missing at {}", path.display());
        Some(SpawnConfig {
            id: id.to_string(),
            program: node,
            args: vec![path.to_string_lossy().to_string(), mode.to_string()],
            env: Vec::new(),
            cwd: None,
        })
    }

    /// The protocol-speaking fixture, one mode per branch of the connection
    /// sequence.
    fn era_config(id: &str, mode: &str) -> Option<SpawnConfig> {
        fixture_config(id, "mcp-era-server.js", mode)
    }

    /// The protocol-*less* fixture from Phase 02: useful precisely because it
    /// never answers MCP.
    fn echo_config(id: &str, mode: &str) -> Option<SpawnConfig> {
        fixture_config(id, "mcp-echo-server.js", mode)
    }

    fn supervisor() -> McpSupervisor {
        // No registry path: orphan recording is exercised in orphans.rs, and a
        // test writing to the real app data dir would be a surprise.
        McpSupervisor::new(None)
    }

    /// Spawn a fixture the way `start` does, for the tests that exercise the
    /// stderr reader on its own.
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

    // ---- negotiation -----------------------------------------------------

    #[tokio::test]
    async fn a_modern_server_negotiates_the_stateless_revision() {
        let Some(config) = era_config("modern", "modern") else {
            return;
        };
        let sup = supervisor();
        sup.start(config).await.expect("modern server should start");
        assert_eq!(sup.status("modern").await, SidecarStatus::Ready);

        let info = sup.connection("modern").await.expect("connected");
        assert_eq!(info.era, McpProtocolEra::Modern);
        assert_eq!(info.protocol_version, "2026-07-28");
        assert_eq!(info.server_name.as_deref(), Some("fixture-modern"));
        sup.stop("modern").await.unwrap();
    }

    #[tokio::test]
    async fn a_handshake_server_falls_back_and_still_lists_tools() {
        let Some(config) = era_config("legacy", "legacy") else {
            return;
        };
        let sup = supervisor();
        sup.start(config).await.expect("legacy server should start");

        let info = sup.connection("legacy").await.expect("connected");
        assert_eq!(info.era, McpProtocolEra::Legacy);
        assert_eq!(info.protocol_version, "2025-11-25");

        let tools = sup.list_tools("legacy").await.expect("tools/list");
        assert_eq!(tools.len(), 2, "the fallback must not cost us discovery");
        sup.stop("legacy").await.unwrap();
    }

    #[tokio::test]
    async fn the_fallback_is_not_keyed_to_one_error_code() {
        // The spec is explicit: legacy servers answer an unknown
        // pre-`initialize` method with implementation-defined errors, or with
        // nothing at all. Keying the fallback to -32601 would strand the rest.
        for mode in ["legacy", "legacy-32602"] {
            let Some(config) = era_config(mode, mode) else {
                return;
            };
            let sup = supervisor();
            sup.start(config)
                .await
                .unwrap_or_else(|e| panic!("{mode} should have fallen back: {e}"));
            assert_eq!(
                sup.connection(mode).await.expect("connected").era,
                McpProtocolEra::Legacy,
                "{mode} should have been classified as legacy"
            );
            sup.stop(mode).await.unwrap();
        }
    }

    #[tokio::test]
    async fn a_version_mismatch_retries_once_and_stays_modern() {
        // A recognised modern error identifies a *modern* server. Retry at a
        // version it named; do not fall back to `initialize`.
        let Some(config) = era_config("mismatch", "version-mismatch") else {
            return;
        };
        let sup = supervisor();
        sup.start(config).await.expect("the retry should succeed");
        let info = sup.connection("mismatch").await.expect("connected");
        assert_eq!(
            info.era,
            McpProtocolEra::Modern,
            "a version disagreement is not a reason to drop to the handshake"
        );
        sup.stop("mismatch").await.unwrap();
    }

    #[tokio::test]
    async fn a_version_dead_end_fails_rather_than_falling_back() {
        let Some(config) = era_config("deadend", "version-dead-end") else {
            return;
        };
        let sup = supervisor();
        let err = sup
            .start(config)
            .await
            .expect_err("no mutually supported version exists");
        assert!(
            matches!(sup.status("deadend").await, SidecarStatus::Error(_)),
            "a dead end must not leave the server looking healthy"
        );
        assert!(!err.is_empty());
    }

    #[tokio::test]
    async fn a_server_that_never_speaks_mcp_is_killed_at_the_deadline() {
        // The echo fixture answers no protocol at all. rmcp's probe times out,
        // the legacy fallback gets no answer either, and negotiation fails —
        // which is the whole point of Ready meaning "the protocol answered".
        let Some(config) = echo_config("mute", "hang") else {
            return;
        };
        let sup = supervisor();
        // Shortened: the real deadline has to outlast rmcp's own 10s probe
        // timeout plus a legacy handshake, and waiting that out here would
        // dominate the suite.
        let err = sup
            .start_within(config, Duration::from_secs(2))
            .await
            .expect_err("nothing answered");
        assert!(
            matches!(sup.status("mute").await, SidecarStatus::Error(_)),
            "got {err}"
        );
    }

    #[tokio::test]
    async fn a_server_that_exits_on_startup_reports_its_own_last_words() {
        let Some(config) = echo_config("dead", "exit-immediately") else {
            return;
        };
        let sup = supervisor();
        let err = sup.start(config).await.expect_err("it exited");
        assert!(
            err.contains("exiting immediately"),
            "the server's stderr is the useful diagnostic here, got {err:?}"
        );
    }

    // ---- discovery -------------------------------------------------------

    #[tokio::test]
    async fn annotations_survive_discovery_including_their_absence() {
        let Some(config) = era_config("tools", "modern") else {
            return;
        };
        let sup = supervisor();
        sup.start(config).await.unwrap();
        let tools = sup.list_tools("tools").await.unwrap();

        let annotated = tools.iter().find(|t| t.name == "read_thing").unwrap();
        let a = annotated.annotations.as_ref().expect("server sent some");
        assert_eq!(a.read_only_hint, Some(true));
        assert_eq!(a.idempotent_hint, Some(true));
        assert_eq!(
            a.destructive_hint, None,
            "an unsent hint must not become false on the way through"
        );

        let bare = tools
            .iter()
            .find(|t| t.name == "unannotated_thing")
            .unwrap();
        assert!(
            bare.annotations.is_none(),
            "no annotations is a different statement from empty annotations"
        );
        assert!(
            bare.input_schema.get("type").is_some(),
            "the schema must reach the model as the server published it"
        );
        sup.stop("tools").await.unwrap();
    }

    // ---- calling ---------------------------------------------------------

    #[tokio::test]
    async fn a_tool_call_completes() {
        let Some(config) = era_config("call", "modern") else {
            return;
        };
        let sup = supervisor();
        sup.start(config).await.unwrap();
        let outcome = sup
            .call_tool("call", "read_thing", None, None, None)
            .await
            .unwrap();
        let McpCallOutcome::Complete { content, .. } = outcome else {
            panic!("expected a completed call, got {outcome:?}");
        };
        assert!(content.to_string().contains("called read_thing"));
        sup.stop("call").await.unwrap();
    }

    #[tokio::test]
    async fn an_mrtr_question_is_returned_rather_than_answered_here() {
        // The MRTR loop belongs above this layer, where the existing
        // ask-the-user machinery already is. This layer's job is to hand the
        // question up without losing anything, and to accept the answer back.
        let Some(config) = era_config("mrtr", "mrtr") else {
            return;
        };
        let sup = supervisor();
        sup.start(config).await.unwrap();

        let first = sup
            .call_tool("mrtr", "read_thing", None, None, None)
            .await
            .unwrap();
        let McpCallOutcome::InputRequired {
            requests,
            request_state,
        } = first
        else {
            panic!("expected a question, got {first:?}");
        };
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].key, "q1");
        assert_eq!(requests[0].method.as_deref(), Some("elicitation/create"));
        assert_eq!(
            request_state.as_deref(),
            Some("opaque-state-1"),
            "the opaque state must come back untouched"
        );

        let answers = std::collections::BTreeMap::from([(
            "q1".to_string(),
            serde_json::json!({ "action": "accept", "content": { "project": "haruspex" } }),
        )]);
        let second = sup
            .call_tool("mrtr", "read_thing", None, Some(answers), request_state)
            .await
            .unwrap();
        let McpCallOutcome::Complete { content, .. } = second else {
            panic!("the retry should complete, got {second:?}");
        };
        assert!(content.to_string().contains("haruspex"));
        sup.stop("mrtr").await.unwrap();
    }

    #[tokio::test]
    async fn a_legacy_server_asking_a_question_fails_the_call_and_survives() {
        // Legacy servers ask by sending their own request. There is no legacy
        // question path by design, so the call must fail with a reason the
        // model can relay — not hang, and not take the server down.
        let Some(config) = era_config("elicit", "legacy-elicit") else {
            return;
        };
        let sup = supervisor();
        sup.start(config)
            .await
            .expect("it is a working legacy server");
        assert_eq!(
            sup.connection("elicit").await.unwrap().era,
            McpProtocolEra::Legacy
        );

        let result = tokio::time::timeout(
            Duration::from_secs(10),
            sup.call_tool("elicit", "read_thing", None, None, None),
        )
        .await
        .expect("the call must fail rather than hang");
        assert!(result.is_err(), "expected a failed call, got {result:?}");

        assert_eq!(
            sup.status("elicit").await,
            SidecarStatus::Ready,
            "one refused question is not a reason to tear the server down"
        );
        sup.stop("elicit").await.unwrap();
    }

    #[tokio::test]
    async fn calling_a_server_that_is_not_connected_says_so() {
        let sup = supervisor();
        let err = sup
            .call_tool("ghost", "read_thing", None, None, None)
            .await
            .expect_err("nothing is connected");
        assert!(err.contains("not connected"), "got {err}");
        assert!(sup.list_tools("ghost").await.is_err());
        assert!(sup.connection("ghost").await.is_none());
    }

    // ---- lifecycle -------------------------------------------------------

    #[tokio::test]
    async fn stopping_disconnects_and_leaves_no_child_behind() {
        let Some(config) = era_config("bye", "modern") else {
            return;
        };
        let sup = supervisor();
        sup.start(config).await.unwrap();
        let pid = sup.pid_for("bye").await.expect("a spawned child has a pid");

        sup.stop("bye").await.unwrap();
        assert_eq!(sup.status("bye").await, SidecarStatus::Stopped);
        assert!(sup.connection("bye").await.is_none());

        #[cfg(unix)]
        {
            tokio::time::sleep(Duration::from_millis(300)).await;
            assert!(!pid_is_alive(pid), "pid {pid} survived the stop");
        }
        let _ = pid;
    }

    #[tokio::test]
    async fn starting_a_running_server_twice_is_refused() {
        let Some(config) = era_config("dup", "modern") else {
            return;
        };
        let sup = supervisor();
        sup.start(config.clone()).await.unwrap();
        let err = sup.start(config).await.expect_err("already running");
        assert!(err.contains("already running"), "got {err}");
        sup.stop("dup").await.unwrap();
    }

    /// Is this pid a live process? `kill -0` succeeds for a zombie too, so the
    /// check goes through `ps`, which reports state. Unix only; the Windows
    /// equivalent is a manual step in the phase's test plan.
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

    // ---- stderr, logs and crash detection --------------------------------

    #[tokio::test]
    async fn a_servers_stderr_reaches_its_log_ring_and_is_bounded() {
        let Some(config) = echo_config("noisy", "noisy") else {
            return;
        };
        let (process, stderr) = spawn_fixture(&config);
        let status = Arc::new(Mutex::new(SidecarStatus::Ready));
        let log = new_log_buffer();
        let exited = Arc::new(AtomicBool::new(false));
        spawn_stderr_reader(
            "noisy".into(),
            stderr.expect("stderr is piped"),
            status,
            log.clone(),
            exited,
        );
        tokio::time::sleep(Duration::from_millis(300)).await;
        let lines: Vec<String> = log.lock().await.iter().cloned().collect();
        assert!(
            lines.len() >= 50,
            "expected the noisy output, got {}",
            lines.len()
        );
        assert!(
            lines.len() <= crate::sidecar_utils::LOG_RING_BUFFER_SIZE,
            "the ring buffer must bound the log"
        );
        drop(process);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_server_killed_from_outside_reports_error_not_a_stale_ready() {
        // The failure this guards against: the user kills a server from a task
        // manager, and Settings keeps showing a green dot while every tool call
        // fails. SIGKILL gives the child no chance to say anything, so the only
        // signal is its stderr pipe closing.
        let Some(config) = echo_config("killed", "normal") else {
            return;
        };
        let (process, stderr) = spawn_fixture(&config);
        let pid = process.id().expect("a spawned child has a pid");
        let status = Arc::new(Mutex::new(SidecarStatus::Ready));
        let exited = Arc::new(AtomicBool::new(false));
        spawn_stderr_reader(
            "killed".into(),
            stderr.expect("stderr is piped"),
            status.clone(),
            new_log_buffer(),
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

    #[tokio::test]
    async fn a_deliberate_stop_is_not_reported_as_a_crash() {
        let Some(config) = echo_config("stopped", "normal") else {
            return;
        };
        let (mut process, stderr) = spawn_fixture(&config);
        let status = Arc::new(Mutex::new(SidecarStatus::Ready));
        spawn_stderr_reader(
            "stopped".into(),
            stderr.expect("stderr is piped"),
            status.clone(),
            new_log_buffer(),
            Arc::new(AtomicBool::new(false)),
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

    // ---- hang handling ---------------------------------------------------

    #[tokio::test]
    async fn timeouts_only_break_a_server_once_they_repeat() {
        let sup = supervisor();
        let status = Arc::new(Mutex::new(SidecarStatus::Ready));
        sup.servers.lock().await.insert(
            "s".into(),
            ServerHandle {
                status: status.clone(),
                log: new_log_buffer(),
                pid: None,
                session: None,
                connection: None,
                companion: CompanionStatus::Unknown,
                consecutive_timeouts: 0,
            },
        );

        for _ in 1..MAX_CONSECUTIVE_TIMEOUTS {
            assert!(!sup.record_timeout("s").await);
            assert_eq!(sup.status("s").await, SidecarStatus::Ready);
        }
        assert!(sup.record_timeout("s").await);
        assert!(matches!(sup.status("s").await, SidecarStatus::Error(_)));
    }

    #[tokio::test]
    async fn a_successful_request_clears_the_timeout_streak() {
        let sup = supervisor();
        sup.servers.lock().await.insert(
            "s".into(),
            ServerHandle {
                status: Arc::new(Mutex::new(SidecarStatus::Ready)),
                log: new_log_buffer(),
                pid: None,
                session: None,
                connection: None,
                companion: CompanionStatus::Unknown,
                consecutive_timeouts: 0,
            },
        );

        for _ in 1..MAX_CONSECUTIVE_TIMEOUTS {
            sup.record_timeout("s").await;
        }
        sup.record_success("s").await;
        // The streak restarted, so the next timeout must not be the fatal one.
        assert!(!sup.record_timeout("s").await);
        assert_eq!(sup.status("s").await, SidecarStatus::Ready);
    }

    #[tokio::test]
    async fn an_unknown_server_reads_as_stopped_rather_than_failing() {
        let sup = supervisor();
        assert_eq!(sup.status("nope").await, SidecarStatus::Stopped);
        assert!(sup.logs("nope").await.is_empty());
        assert!(!sup.record_timeout("nope").await);
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
