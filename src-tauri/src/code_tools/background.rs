//! Background processes for the coding tools: `run_command` with `background`
//! or `watch` when there is no terminal to run it in.
//!
//! Each process runs one-shot through the same shell `run_command_capture`
//! uses, in its own process group, with stdout and stderr appended to
//! `<app_cache>/code-bg/<id>.log` (capped, oldest output dropped first). It
//! belongs to an owner — a Code session id — and never outlives it: stopping
//! the owner, or quitting the app, kills every group it started. A crash's
//! leftovers are recorded in the `code-bg` orphan registry and killed on the
//! next launch (see [`sweep_orphans`]).
//!
//! On Windows a process runs inside the session's WSL distro (see
//! `code_tools/wsl.rs`): the log still fills on the host through the
//! `wsl.exe` relay, and stopping signals the Linux process group from inside
//! the distro, since killing the relay would leave it running. In a Windows
//! folder it runs in PowerShell inside a Job object (`job.rs`), which a stop
//! terminates and which dies with the app, so a crash leaves nothing to sweep.

use super::job::Job;
use super::wsl;
use crate::command_scope;
use crate::orphans::{self, RunningServer};
use crate::shell::kind::ShellSelection;
use crate::sync_util::LockExt;
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::AsyncReadExt;

/// Orphan-registry kind for background processes.
pub const ORPHAN_KIND: &str = "code-bg";
/// Each log keeps at most this much; past it the oldest output is dropped.
const LOG_CAP_BYTES: u64 = 5 * 1024 * 1024;
/// How long a stopped group gets to exit on SIGTERM before SIGKILL.
const STOP_GRACE: Duration = Duration::from_secs(3);
/// Bounds on the log cap a caller may set (Settings → Code), in MiB.
const LOG_CAP_MIN_MB: u32 = 1;
const LOG_CAP_MAX_MB: u32 = 1024;
/// Upper bound on a single `code_bg_tail` read.
const TAIL_MAX_BYTES: u64 = 1024 * 1024;
const TAIL_DEFAULT_BYTES: u64 = 8 * 1024;
/// Marker written into each command line so the orphan sweep can tell our
/// process from an unrelated one that recycled its pid.
const MARKER: &str = "haruspex-code-bg";

/// What `code_bg_start` returns.
#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct BgStarted {
    pub id: String,
    pub pid: u32,
    pub log_path: String,
}

/// One background process, as `code_bg_status` reports it.
#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct BgProcess {
    pub id: String,
    /// The Code session that started it.
    pub owner: String,
    pub command: String,
    /// A Linux path when `wsl_distro` is set.
    pub cwd: String,
    /// The WSL distro it runs in (Windows); `null` on the host.
    pub wsl_distro: Option<String>,
    /// The host process: the shell, or for WSL the `wsl.exe` relay.
    pub pid: u32,
    /// For WSL, the Linux process group, once the wrapper has reported it,
    /// and whether it was stopped. What a stop signals; the relay never is
    /// (see `wsl::GroupState`).
    #[serde(skip)]
    #[ts(skip)]
    pub wsl_group: Arc<wsl::GroupState>,
    /// Windows, on the host: the job holding the process tree. Dropping the
    /// record kills what is left in it.
    #[serde(skip)]
    #[ts(skip)]
    pub job: Option<Arc<Job>>,
    /// The Linux process group, once known, as `code_bg_status` reports it
    /// (`pid` is the host's `wsl.exe` relay, which means nothing in Linux).
    pub wsl_pgid: Option<u32>,
    /// Unix milliseconds.
    #[ts(type = "number")]
    pub started_at: u64,
    /// False once the shell it ran in has exited. Anything it left running in
    /// the background is still killed by a stop.
    pub running: bool,
    /// The shell's exit code; None while running or when killed by a signal.
    pub exit_code: Option<i32>,
    pub log_path: String,
}

/// The process registry, managed as Tauri state.
pub struct CodeBgManager {
    procs: Arc<Mutex<HashMap<String, BgProcess>>>,
    log_dir: PathBuf,
    registry: Option<PathBuf>,
    log_cap: u64,
}

impl CodeBgManager {
    /// `log_dir` holds the logs; `registry` is the orphan-registry file, None
    /// when there is nowhere to record (reaping then degrades, nothing fails).
    pub fn new(log_dir: PathBuf, registry: Option<PathBuf>) -> Self {
        Self {
            procs: Arc::new(Mutex::new(HashMap::new())),
            log_dir,
            registry,
            log_cap: LOG_CAP_BYTES,
        }
    }

    #[cfg(test)]
    fn with_log_cap(mut self, cap: u64) -> Self {
        self.log_cap = cap;
        self
    }

    pub async fn start(
        &self,
        owner: String,
        cwd: String,
        wsl_distro: Option<String>,
        command: String,
        memory_limit_percent: Option<u8>,
    ) -> Result<BgStarted, String> {
        self.start_with_log_cap(
            owner,
            cwd,
            wsl_distro,
            command,
            memory_limit_percent,
            self.log_cap,
        )
        .await
    }

    /// `start`, keeping at most `log_cap` bytes of the process's log.
    pub async fn start_with_log_cap(
        &self,
        owner: String,
        cwd: String,
        wsl_distro: Option<String>,
        command: String,
        memory_limit_percent: Option<u8>,
        log_cap: u64,
    ) -> Result<BgStarted, String> {
        if owner.trim().is_empty() {
            return Err("A background command needs an owning session.".into());
        }
        let cwd_ok = match &wsl_distro {
            Some(d) => wsl::is_dir_in(d, &cwd).await,
            None => Path::new(&cwd).is_dir(),
        };
        if !cwd_ok {
            return Err(format!("Working directory does not exist: {cwd}"));
        }
        std::fs::create_dir_all(&self.log_dir)
            .map_err(|e| format!("Could not create {}: {e}", self.log_dir.display()))?;
        let id = new_id();
        let log_path = self.log_dir.join(format!("{id}.log"));
        let file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
            .map_err(|e| format!("Could not create {}: {e}", log_path.display()))?;

        let shell = wsl_distro
            .as_ref()
            .map(|d| ShellSelection::Wsl { distro: d.clone() });
        // PowerShell (a Windows folder) needs no marker: its job is the record.
        let host_powershell = cfg!(windows) && wsl_distro.is_none();
        let line = if host_powershell {
            command.clone()
        } else {
            script(&command, &id)
        };
        let cmd = super::build_shell_command(&line, &cwd, shell.as_ref(), memory_limit_percent);
        // The host's memory ceiling is a host-Linux scope; a WSL process's is
        // set inside the distro, by its wrapper.
        let limit = memory_limit_percent
            .filter(|_| wsl_distro.is_none())
            .and_then(command_scope::limit_bytes);
        let (mut cmd, _scope) = match limit {
            Some(limit) => command_scope::wrap(cmd, &id, limit),
            None => (cmd, None),
        };
        // Windows: the tree and the memory limit (None elsewhere).
        let job = if wsl_distro.is_none() {
            Job::new(limit).map(Arc::new)
        } else {
            None
        };
        cmd.stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if wsl_distro.is_none() {
            cmd.current_dir(&cwd);
        }
        super::hide_window(&mut cmd);
        #[cfg(unix)]
        cmd.process_group(0);

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                let _ = std::fs::remove_file(&log_path);
                return Err(format!("Failed to spawn command: {e}"));
            }
        };
        let pid = child.id().unwrap_or(0);
        let job = job.filter(|j| j.assign(pid));
        let started_at = now_ms();
        let wsl_group = Arc::new(wsl::GroupState::default());
        // A WSL process is recorded once its group is known (see
        // `pump_wsl_stderr`); one in a job is killed with the app.
        if wsl_distro.is_none() && job.is_none() {
            orphans::register(
                self.registry.as_deref(),
                RunningServer {
                    id: id.clone(),
                    pid,
                    started_at: started_at / 1000,
                    program: marker(&id),
                },
            );
        }

        let sink = Arc::new(Mutex::new(LogSink {
            file,
            path: log_path.clone(),
            len: 0,
            cap: log_cap,
        }));
        if let Some(out) = child.stdout.take() {
            tokio::spawn(pump(out, sink.clone()));
        }
        if let Some(err) = child.stderr.take() {
            match &wsl_distro {
                Some(distro) => {
                    let orphan = RunningServer {
                        id: id.clone(),
                        pid: 0,
                        started_at: started_at / 1000,
                        program: wsl_orphan_program(distro, &id),
                    };
                    tokio::spawn(pump_wsl_stderr(
                        err,
                        sink,
                        distro.clone(),
                        wsl_group.clone(),
                        self.registry.clone(),
                        orphan,
                    ));
                }
                None => {
                    tokio::spawn(pump(err, sink));
                }
            }
        }

        let log_path_s = log_path.to_string_lossy().into_owned();
        self.procs.lock_or_recover().insert(
            id.clone(),
            BgProcess {
                id: id.clone(),
                owner,
                command,
                cwd,
                wsl_distro,
                pid,
                wsl_group,
                job,
                wsl_pgid: None,
                started_at,
                running: true,
                exit_code: None,
                log_path: log_path_s.clone(),
            },
        );

        // The reaper: record how the shell ended. The registry entry stays
        // until a stop, since the shell may have left children running.
        let procs = self.procs.clone();
        let reap_id = id.clone();
        tokio::spawn(async move {
            let status = child.wait().await.ok();
            if let Some(p) = procs.lock_or_recover().get_mut(&reap_id) {
                p.running = false;
                p.exit_code = status.and_then(|s| s.code());
            }
        });

        Ok(BgStarted {
            id,
            pid,
            log_path: log_path_s,
        })
    }

    pub fn status(&self, owner: Option<&str>) -> Vec<BgProcess> {
        let mut list: Vec<BgProcess> = self
            .procs
            .lock_or_recover()
            .values()
            .filter(|p| owner.is_none_or(|o| p.owner == o))
            .cloned()
            .map(|mut p| {
                let g = p.wsl_group.pgid();
                p.wsl_pgid = (p.wsl_distro.is_some() && g > 1).then_some(g);
                p
            })
            .collect();
        list.sort_by(|a, b| a.started_at.cmp(&b.started_at).then(a.id.cmp(&b.id)));
        list
    }

    /// The last `bytes` of a process's log.
    pub fn tail(&self, id: &str, bytes: Option<u64>) -> Result<String, String> {
        let path = self
            .procs
            .lock_or_recover()
            .get(id)
            .map(|p| PathBuf::from(&p.log_path))
            .ok_or_else(|| format!("No background process with id {id}."))?;
        let want = bytes.unwrap_or(TAIL_DEFAULT_BYTES).clamp(1, TAIL_MAX_BYTES);
        read_tail(&path, want).map_err(|e| format!("Could not read the log: {e}"))
    }

    /// Stop one process: its whole group, its log and its record.
    pub async fn stop(&self, id: &str) -> Result<(), String> {
        if !self.procs.lock_or_recover().contains_key(id) {
            return Err(format!("No background process with id {id}."));
        }
        self.stop_ids(vec![id.to_string()]).await;
        Ok(())
    }

    /// Stop everything an owner started. Returns how many were stopped.
    pub async fn stop_owner(&self, owner: &str) -> usize {
        let ids: Vec<String> = self
            .procs
            .lock_or_recover()
            .values()
            .filter(|p| p.owner == owner)
            .map(|p| p.id.clone())
            .collect();
        let n = ids.len();
        self.stop_ids(ids).await;
        n
    }

    /// Stop every background process (app exit).
    pub async fn stop_all(&self) {
        let ids: Vec<String> = self.procs.lock_or_recover().keys().cloned().collect();
        self.stop_ids(ids).await;
    }

    /// SIGTERM every group, give them [`STOP_GRACE`] together, SIGKILL what is
    /// left, then forget them and delete their logs.
    async fn stop_ids(&self, ids: Vec<String>) {
        let targets: Vec<BgProcess> = {
            let procs = self.procs.lock_or_recover();
            ids.iter().filter_map(|id| procs.get(id).cloned()).collect()
        };
        if targets.is_empty() {
            return;
        }
        // WSL groups: one `wsl.exe` per distro, all at once, alongside the host's.
        // One not reported yet is stopped as its group arrives.
        let mut by_distro: HashMap<String, Vec<u32>> = HashMap::new();
        for p in &targets {
            if let (Some(d), Some(g)) = (&p.wsl_distro, p.wsl_group.stop()) {
                by_distro.entry(d.clone()).or_default().push(g);
            }
        }
        let wsl_stops: Vec<_> = by_distro
            .into_iter()
            .map(|(d, pgids)| {
                tokio::spawn(async move { wsl::stop_groups(&d, &pgids, STOP_GRACE).await })
            })
            .collect();
        // Jobs (Windows) have no gentler signal to send: ended at once.
        for job in targets.iter().filter_map(|p| p.job.as_ref()) {
            job.terminate();
        }
        let host: Vec<&BgProcess> = targets
            .iter()
            .filter(|p| p.wsl_distro.is_none() && p.job.is_none())
            .collect();
        for p in &host {
            signal_group(p.pid, Signal::Term);
        }
        let deadline = tokio::time::Instant::now() + STOP_GRACE;
        while host.iter().any(|p| group_alive(p.pid)) {
            if tokio::time::Instant::now() >= deadline {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        for p in &host {
            if group_alive(p.pid) {
                signal_group(p.pid, Signal::Kill);
            }
        }
        for stop in wsl_stops {
            let _ = stop.await;
        }
        let mut procs = self.procs.lock_or_recover();
        for p in &targets {
            procs.remove(&p.id);
            let _ = std::fs::remove_file(&p.log_path);
            orphans::deregister(self.registry.as_deref(), &p.id);
        }
    }
}

/// Kill the groups a previous run left behind, and delete its logs. Call once
/// at launch, before anything starts.
pub fn sweep_orphans(log_dir: &Path, registry: Option<&Path>) {
    if let Some(registry) = registry {
        let entries = orphans::load(registry);
        // Groups inside WSL distros: one `wsl.exe` per distro, off this thread
        // (a stopped distro takes seconds to start).
        let mut by_distro: HashMap<String, Vec<(u32, String)>> = HashMap::new();
        for e in &entries {
            if let Some((distro, mark)) = parse_wsl_orphan_program(&e.program) {
                by_distro
                    .entry(distro.to_string())
                    .or_default()
                    .push((e.pid, mark.to_string()));
            }
        }
        if !by_distro.is_empty() {
            std::thread::spawn(move || {
                for (distro, groups) in by_distro {
                    wsl::sweep_groups(&distro, &groups);
                }
            });
        }
        for e in &entries {
            if parse_wsl_orphan_program(&e.program).is_some() {
                continue;
            }
            if e.pid > 1
                && orphans::command_matches(&e.program, orphans::pid_command(e.pid).as_deref())
            {
                signal_group(e.pid, Signal::Kill);
                log::info!(
                    "{ORPHAN_KIND}: reaped orphaned {} from a previous run",
                    e.id
                );
            }
        }
        if !entries.is_empty() {
            if let Err(e) = orphans::save(registry, &[]) {
                log::warn!("{ORPHAN_KIND}: could not clear orphan registry: {e}");
            }
        }
    }
    let _ = std::fs::remove_dir_all(log_dir);
}

/// The script the shell runs. The trailing `exit $?` keeps the shell from
/// exec'ing the last command in place, so the group leader's command line
/// still carries the marker comment the orphan sweep checks for. It is on the
/// last line so the user's line numbers in error messages are unchanged.
fn script(command: &str, id: &str) -> String {
    format!("{command}\nexit $? # {}", marker(id))
}

fn marker(id: &str) -> String {
    format!("{MARKER}:{id}")
}

/// How a WSL process is recorded in the orphan registry, whose `pid` is then
/// its Linux process group: `wsl:<distro>:<marker>`.
fn wsl_orphan_program(distro: &str, id: &str) -> String {
    format!("wsl:{distro}:{}", marker(id))
}

/// The distro and marker of a [`wsl_orphan_program`], or None for a host entry.
fn parse_wsl_orphan_program(program: &str) -> Option<(&str, &str)> {
    let (distro, mark) = program.strip_prefix("wsl:")?.split_once(':')?;
    (wsl::valid_distro(distro) && mark.starts_with(MARKER)).then_some((distro, mark))
}

fn new_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("bg-{:x}-{n}", nanos & 0xffff_ffff_ffff)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// A log file that keeps only its newest `cap` bytes.
struct LogSink {
    file: std::fs::File,
    path: PathBuf,
    len: u64,
    cap: u64,
}

impl LogSink {
    fn write(&mut self, chunk: &[u8]) {
        if self.file.write_all(chunk).is_err() {
            return;
        }
        self.len += chunk.len() as u64;
        if self.len > self.cap {
            if let Err(e) = self.truncate_front() {
                log::warn!("{ORPHAN_KIND}: could not trim {}: {e}", self.path.display());
            }
        }
    }

    /// Keep the newest four fifths of the cap, so trimming happens once per
    /// fifth of the cap written rather than on every write.
    fn truncate_front(&mut self) -> std::io::Result<()> {
        let keep = self.cap * 4 / 5;
        let tail = read_tail_bytes(&self.path, keep)?;
        // The file is in append mode, so after set_len(0) the write lands at 0.
        self.file.set_len(0)?;
        self.file.write_all(&tail)?;
        self.len = tail.len() as u64;
        Ok(())
    }
}

async fn pump<R: tokio::io::AsyncRead + Unpin>(mut reader: R, sink: Arc<Mutex<LogSink>>) {
    let mut buf = vec![0u8; 8192];
    loop {
        match reader.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => sink.lock_or_recover().write(&buf[..n]),
        }
    }
}

/// [`pump`] for a WSL process's stderr: the wrapper's group id is taken off
/// the front, kept in `group`, and recorded in the orphan registry as
/// `orphan` with that group as its pid. A process stopped before then is
/// stopped as the group arrives, and not recorded.
async fn pump_wsl_stderr<R: tokio::io::AsyncRead + Unpin>(
    mut reader: R,
    sink: Arc<Mutex<LogSink>>,
    distro: String,
    group: Arc<wsl::GroupState>,
    registry: Option<PathBuf>,
    mut orphan: RunningServer,
) {
    let mut ids = wsl::PgidReader::default();
    let mut buf = vec![0u8; 8192];
    loop {
        match reader.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let (g, rest) = ids.feed(&buf[..n]);
                if let Some(g) = g {
                    if group.reported(g) {
                        wsl::stop_groups(&distro, &[g], STOP_GRACE).await;
                    } else {
                        orphan.pid = g;
                        orphans::register(registry.as_deref(), orphan.clone());
                    }
                }
                if !rest.is_empty() {
                    sink.lock_or_recover().write(&rest);
                }
            }
        }
    }
    let rest = ids.finish();
    if !rest.is_empty() {
        sink.lock_or_recover().write(&rest);
    }
}

fn read_tail_bytes(path: &Path, bytes: u64) -> std::io::Result<Vec<u8>> {
    let mut f = std::fs::File::open(path)?;
    let len = f.metadata()?.len();
    f.seek(SeekFrom::Start(len.saturating_sub(bytes)))?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf)?;
    Ok(buf)
}

fn read_tail(path: &Path, bytes: u64) -> std::io::Result<String> {
    Ok(String::from_utf8_lossy(&read_tail_bytes(path, bytes)?).into_owned())
}

#[derive(Clone, Copy)]
enum Signal {
    Term,
    Kill,
}

#[cfg(unix)]
fn signal_group(pgid: u32, signal: Signal) {
    if pgid <= 1 {
        return;
    }
    let sig = match signal {
        Signal::Term => libc::SIGTERM,
        Signal::Kill => libc::SIGKILL,
    };
    // Best-effort; ESRCH when the group is already gone.
    unsafe {
        libc::killpg(pgid as i32, sig);
    }
}

#[cfg(windows)]
fn signal_group(pid: u32, _signal: Signal) {
    if pid > 0 {
        super::kill_process_tree(pid);
    }
}

/// Does any process remain in the group?
#[cfg(unix)]
fn group_alive(pgid: u32) -> bool {
    pgid > 1 && unsafe { libc::killpg(pgid as i32, 0) } == 0
}

#[cfg(windows)]
fn group_alive(_pid: u32) -> bool {
    false
}

#[tauri::command]
pub async fn code_bg_start(
    state: tauri::State<'_, CodeBgManager>,
    owner: String,
    cwd: String,
    wsl_distro: Option<String>,
    command: String,
    memory_limit_percent: Option<u8>,
    log_cap_mb: Option<u32>,
) -> Result<BgStarted, String> {
    match log_cap_mb {
        Some(mb) => {
            let cap = u64::from(mb.clamp(LOG_CAP_MIN_MB, LOG_CAP_MAX_MB)) * 1024 * 1024;
            state
                .start_with_log_cap(owner, cwd, wsl_distro, command, memory_limit_percent, cap)
                .await
        }
        None => {
            state
                .start(owner, cwd, wsl_distro, command, memory_limit_percent)
                .await
        }
    }
}

#[tauri::command]
pub fn code_bg_status(
    state: tauri::State<'_, CodeBgManager>,
    owner: Option<String>,
) -> Vec<BgProcess> {
    state.status(owner.as_deref())
}

#[tauri::command]
pub fn code_bg_tail(
    state: tauri::State<'_, CodeBgManager>,
    id: String,
    bytes: Option<u64>,
) -> Result<String, String> {
    state.tail(&id, bytes)
}

#[tauri::command]
pub async fn code_bg_stop(
    state: tauri::State<'_, CodeBgManager>,
    id: String,
) -> Result<(), String> {
    state.stop(&id).await
}

/// Stop everything a session started; for when it closes or is deleted.
#[tauri::command]
pub async fn code_bg_stop_owner(
    state: tauri::State<'_, CodeBgManager>,
    owner: String,
) -> Result<u32, String> {
    Ok(state.stop_owner(&owner).await as u32)
}

/// WSL integration: needs a WSL2 distro, so `--ignored` on the Windows box.
#[cfg(all(test, windows))]
mod wsl_tests {
    use super::*;

    #[tokio::test]
    #[ignore]
    async fn a_wsl_process_logs_without_the_group_line_and_stops_inside_the_distro() {
        let distro = wsl::distros().into_iter().next().expect("a WSL2 distro");
        let dir = std::env::temp_dir().join(format!("haruspex-bg-wsl-{}", std::process::id()));
        let registry = dir.join("orphans.json");
        let mgr = CodeBgManager::new(dir.join("logs"), Some(registry.clone()));

        // A missing folder is refused before anything runs.
        assert!(mgr
            .start(
                "s".into(),
                "/no/such/dir".into(),
                Some(distro.clone()),
                "true".into(),
                None
            )
            .await
            .is_err());

        let started = mgr
            .start(
                "s".into(),
                "/tmp".into(),
                Some(distro.clone()),
                "sleep 300 & echo started in $(pwd); echo warn >&2; wait".into(),
                Some(50),
            )
            .await
            .unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        let pgid = loop {
            let p = &mgr.status(None)[0];
            let g = p.wsl_group.pgid();
            let log = mgr.tail(&started.id, None).unwrap();
            if g > 1 && log.contains("started") && log.contains("warn") {
                assert!(!log.contains("haruspex-pgid"), "{log:?}");
                assert!(log.contains("started in /tmp"), "{log:?}");
                break g;
            }
            assert!(std::time::Instant::now() < deadline, "no output: {log:?}");
            tokio::time::sleep(Duration::from_millis(200)).await;
        };
        assert!(mgr.status(None)[0].running);
        // Recorded for the next launch's sweep, by its Linux group.
        let entries = orphans::load(&registry);
        assert_eq!(entries[0].pid, pgid);
        assert_eq!(
            parse_wsl_orphan_program(&entries[0].program),
            Some((distro.as_str(), marker(&started.id).as_str()))
        );

        mgr.stop(&started.id).await.unwrap();
        assert!(
            !wsl::group_alive(&distro, pgid).await,
            "group {pgid} left running"
        );
        assert!(mgr.status(None).is_empty());
        assert!(orphans::load(&registry).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    #[ignore]
    async fn the_sweep_kills_a_group_a_crash_left_in_the_distro() {
        let distro = wsl::distros().into_iter().next().expect("a WSL2 distro");
        let dir = std::env::temp_dir().join(format!("haruspex-bg-sweep-{}", std::process::id()));
        let registry = dir.join("orphans.json");
        let mgr = CodeBgManager::new(dir.join("logs"), Some(registry.clone()));
        let started = mgr
            .start(
                "s".into(),
                "/tmp".into(),
                Some(distro.clone()),
                "sleep 300".into(),
                None,
            )
            .await
            .unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        let pgid = loop {
            let g = mgr.status(None)[0].wsl_group.pgid();
            if g > 1 && !orphans::load(&registry).is_empty() {
                break g;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "never reported its group"
            );
            tokio::time::sleep(Duration::from_millis(200)).await;
        };
        // The app "crashes": the manager is forgotten, the group runs on.
        std::mem::forget(mgr);
        assert!(wsl::group_alive(&distro, pgid).await);
        wsl::sweep_groups(&distro, &[(pgid, marker(&started.id))]);
        assert!(
            !wsl::group_alive(&distro, pgid).await,
            "group {pgid} left running"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn wsl_orphan_entries_round_trip() {
        let program = wsl_orphan_program("Ubuntu-24.04", "bg-1");
        assert_eq!(
            parse_wsl_orphan_program(&program),
            Some(("Ubuntu-24.04", "haruspex-code-bg:bg-1"))
        );
        assert_eq!(parse_wsl_orphan_program("haruspex-code-bg:bg-1"), None);
        assert_eq!(parse_wsl_orphan_program("wsl:-d:haruspex-code-bg:x"), None);
        assert_eq!(parse_wsl_orphan_program("wsl:Ubuntu:something-else"), None);
    }
}

/// A Windows folder: PowerShell in a Job object.
#[cfg(all(test, windows))]
mod host_windows_tests {
    use super::*;

    fn manager(name: &str) -> (CodeBgManager, PathBuf) {
        let dir = std::env::temp_dir().join(format!("haruspex_code_bg_win_{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mgr = CodeBgManager::new(dir.join("logs"), Some(dir.join("running.json")));
        (mgr, dir)
    }

    async fn wait_until(mut f: impl FnMut() -> bool) {
        for _ in 0..400 {
            if f() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("condition never became true");
    }

    #[tokio::test]
    async fn runs_logs_and_reports_its_exit_code() {
        let (mgr, _dir) = manager("basic");
        let cwd = std::env::temp_dir().to_string_lossy().into_owned();
        let started = mgr
            .start(
                "s1".into(),
                cwd,
                None,
                "Write-Output out; cmd /c exit 4".into(),
                None,
            )
            .await
            .unwrap();
        wait_until(|| !mgr.status(None)[0].running).await;
        let st = &mgr.status(Some("s1"))[0];
        assert_eq!(st.exit_code, Some(4));
        assert!(mgr.tail(&started.id, None).unwrap().contains("out"));
    }

    #[tokio::test]
    async fn stop_ends_what_it_started() {
        let (mgr, dir) = manager("stop");
        let marker = dir.join("survived.txt");
        // A grandchild outside the tree, which writes the marker if a stop
        // misses it.
        let cmd = format!(
            "Start-Process -WindowStyle Hidden powershell.exe -ArgumentList '-NoProfile','-Command','Start-Sleep 5; Set-Content {} x'; Start-Sleep 60",
            marker.display()
        );
        let cwd = std::env::temp_dir().to_string_lossy().into_owned();
        let started = mgr.start("s1".into(), cwd, None, cmd, None).await.unwrap();
        tokio::time::sleep(Duration::from_secs(2)).await;
        mgr.stop(&started.id).await.unwrap();
        assert!(mgr.status(None).is_empty());
        tokio::time::sleep(Duration::from_secs(5)).await;
        assert!(!marker.exists(), "the grandchild outlived the stop");
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn manager(name: &str) -> (CodeBgManager, PathBuf) {
        let dir = std::env::temp_dir().join(format!("haruspex_code_bg_{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mgr = CodeBgManager::new(dir.join("logs"), Some(dir.join("running.json")));
        (mgr, dir)
    }

    fn tmp() -> String {
        std::env::temp_dir().to_string_lossy().into_owned()
    }

    /// Wait for the shell's command line to carry the orphan marker, reporting
    /// what it does show when it never does.
    async fn wait_for_marker(program: &str, pid: u32) {
        for _ in 0..200 {
            if orphans::command_matches(program, orphans::pid_command(pid).as_deref()) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        panic!(
            "pid {pid} never showed {program:?}; its command line is {:?}",
            orphans::pid_command(pid)
        );
    }

    async fn wait_until(mut f: impl FnMut() -> bool) {
        for _ in 0..200 {
            if f() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        panic!("condition never became true");
    }

    fn pid_alive(pid: i32) -> bool {
        unsafe { libc::kill(pid, 0) == 0 }
    }

    #[tokio::test]
    async fn start_status_tail_and_exit_code() {
        let (mgr, _dir) = manager("basic");
        let started = mgr
            .start(
                "s1".into(),
                tmp(),
                None,
                "echo out; echo err >&2; exit 4".into(),
                None,
            )
            .await
            .unwrap();
        assert!(started.log_path.ends_with(&format!("{}.log", started.id)));
        wait_until(|| !mgr.status(None)[0].running).await;
        let st = &mgr.status(Some("s1"))[0];
        assert_eq!(st.exit_code, Some(4));
        assert_eq!(st.owner, "s1");
        assert!(mgr.status(Some("other")).is_empty());
        wait_until(|| mgr.tail(&started.id, None).unwrap().contains("err")).await;
        let log = mgr.tail(&started.id, None).unwrap();
        assert!(log.contains("out") && log.contains("err"), "got {log:?}");
        assert_eq!(mgr.tail(&started.id, Some(3)).unwrap().len(), 3);
    }

    #[tokio::test]
    async fn registers_and_deregisters_with_the_orphan_registry() {
        let (mgr, dir) = manager("registry");
        let started = mgr
            .start("s1".into(), tmp(), None, "sleep 30".into(), None)
            .await
            .unwrap();
        let reg = dir.join("running.json");
        let entries = orphans::load(&reg);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].pid, started.pid);
        // The marker is in the shell's command line, so a sweep would match.
        wait_for_marker(&entries[0].program, started.pid).await;
        mgr.stop(&started.id).await.unwrap();
        assert!(orphans::load(&reg).is_empty());
        assert!(!Path::new(&started.log_path).exists());
        assert!(mgr.status(None).is_empty());
    }

    #[tokio::test]
    async fn stop_reaches_a_grandchild() {
        let (mgr, dir) = manager("group");
        let pidfile = dir.join("grandchild.pid");
        let cmd = format!("sleep 100 & echo $! > {}; sleep 100", pidfile.display());
        let started = mgr
            .start("s1".into(), tmp(), None, cmd, None)
            .await
            .unwrap();
        wait_until(|| std::fs::read_to_string(&pidfile).is_ok_and(|s| s.ends_with('\n'))).await;
        let grandchild: i32 = std::fs::read_to_string(&pidfile)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        assert!(pid_alive(grandchild));
        mgr.stop(&started.id).await.unwrap();
        // The grandchild is re-parented away from us; once killed it is reaped
        // by init, so allow a moment.
        wait_until(|| !pid_alive(grandchild)).await;
    }

    #[tokio::test]
    async fn stop_owner_only_stops_that_owner() {
        let (mgr, _dir) = manager("owner");
        mgr.start("a".into(), tmp(), None, "sleep 30".into(), None)
            .await
            .unwrap();
        mgr.start("a".into(), tmp(), None, "sleep 30".into(), None)
            .await
            .unwrap();
        let b = mgr
            .start("b".into(), tmp(), None, "sleep 30".into(), None)
            .await
            .unwrap();
        assert_eq!(mgr.stop_owner("a").await, 2);
        let left = mgr.status(None);
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].id, b.id);
        mgr.stop_all().await;
        assert!(mgr.status(None).is_empty());
    }

    #[tokio::test]
    async fn log_is_capped_keeping_the_newest_output() {
        let (mgr, _dir) = manager("cap");
        let mgr = mgr.with_log_cap(4096);
        let started = mgr
            .start(
                "s1".into(),
                tmp(),
                None,
                "for i in $(seq 1 2000); do echo line-$i; done".into(),
                None,
            )
            .await
            .unwrap();
        wait_until(|| !mgr.status(None)[0].running).await;
        wait_until(|| {
            mgr.tail(&started.id, Some(64))
                .unwrap()
                .contains("line-2000")
        })
        .await;
        let size = std::fs::metadata(&started.log_path).unwrap().len();
        assert!(size <= 4096, "log grew to {size}");
        let all = mgr.tail(&started.id, Some(TAIL_MAX_BYTES)).unwrap();
        assert!(!all.contains("line-1\n"), "oldest output should be dropped");
        mgr.stop_all().await;
    }

    #[tokio::test]
    async fn a_caller_can_set_the_log_cap_per_process() {
        let (mgr, _dir) = manager("cap-per-call");
        let started = mgr
            .start_with_log_cap(
                "s1".into(),
                tmp(),
                None,
                "for i in $(seq 1 2000); do echo line-$i; done".into(),
                None,
                4096,
            )
            .await
            .unwrap();
        wait_until(|| !mgr.status(None)[0].running).await;
        wait_until(|| {
            mgr.tail(&started.id, Some(64))
                .unwrap()
                .contains("line-2000")
        })
        .await;
        let size = std::fs::metadata(&started.log_path).unwrap().len();
        assert!(size <= 4096, "log grew to {size}");
        mgr.stop_all().await;
    }

    #[tokio::test]
    async fn rejects_a_missing_owner_or_cwd() {
        let (mgr, _dir) = manager("reject");
        let err = mgr
            .start(" ".into(), tmp(), None, "true".into(), None)
            .await
            .unwrap_err();
        assert!(err.contains("owning session"), "got {err}");
        let err = mgr
            .start("s".into(), "/no/such/dir".into(), None, "true".into(), None)
            .await
            .unwrap_err();
        assert!(err.contains("does not exist"), "got {err}");
        assert!(mgr.tail("nope", None).is_err());
        assert!(mgr.stop("nope").await.is_err());
    }

    #[tokio::test]
    async fn sweep_kills_a_recorded_group_and_clears_logs() {
        let (mgr, dir) = manager("sweep");
        let started = mgr
            .start("s1".into(), tmp(), None, "sleep 30".into(), None)
            .await
            .unwrap();
        // Simulate a crash: the manager is forgotten without stopping anything.
        let pid = started.pid;
        let program = orphans::load(&dir.join("running.json"))[0].program.clone();
        wait_for_marker(&program, pid).await;
        std::mem::forget(mgr);
        sweep_orphans(&dir.join("logs"), Some(&dir.join("running.json")));
        wait_until(|| {
            // Until the reaper task collects it, a killed child is a zombie
            // with an empty command line.
            orphans::pid_command(pid).is_none_or(|c| c.is_empty())
        })
        .await;
        assert!(orphans::load(&dir.join("running.json")).is_empty());
        assert!(!dir.join("logs").exists());
    }
}
