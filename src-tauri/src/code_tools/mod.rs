//! Backend commands for the Code tab: one-shot host command execution
//! (`run_command_capture` / `run_command_cancel`) plus gitignore-aware
//! content search (`code_grep`) and file globbing (`code_glob`), which live
//! in [`search`].
//!
//! These run **on the host** as the app user — there is no sandbox. They back
//! a deliberately lean Code-mode toolset; the heavy lifting (risk gating,
//! output truncation, approval) lives in the TS tool wrappers. Everything here
//! returns locations/exit-codes, never whole file bodies, to keep model
//! context small.

pub mod background;
pub mod claims;
pub mod folders;
pub mod git;
pub mod job;
pub mod search;
pub mod wsl;

use crate::command_scope;
use crate::shell::kind::ShellSelection;
use crate::sync_util::LockExt;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tokio::io::AsyncReadExt;

/// Default per-command wall-clock timeout when the caller passes none.
const DEFAULT_TIMEOUT_SECS: u64 = 120;
/// Hard upper bound on a single command's timeout.
const MAX_TIMEOUT_SECS: u64 = 1800;
/// How long a stopped WSL command's relay gets to end on its own. It is
/// never killed (see `wsl::GroupState`); past this the result is returned
/// without it.
const RELAY_EXIT_WAIT: Duration = Duration::from_secs(30);
/// Grace period to finish draining stdout/stderr after the process exits,
/// before we give up and kill any lingering pipe-holding children.
const DRAIN_GRACE: Duration = Duration::from_secs(2);

/// A running one-shot, as `run_command_cancel` and the timeout kill it.
#[derive(Clone)]
enum Running {
    /// A host process. On unix the PID doubles as the process-group id (we
    /// spawn with `process_group(0)`), so killing it reaps the whole tree. On
    /// Windows its job holds the tree; `taskkill /T` when there is none.
    Host {
        pid: u32,
        job: Option<Arc<job::Job>>,
    },
    /// A command inside a WSL distro: its Linux process group, signalled from
    /// inside the distro. The `wsl.exe` relay is never killed; it ends once
    /// the group has (see `wsl::GroupState`).
    Wsl {
        distro: String,
        group: Arc<wsl::GroupState>,
    },
}

impl Running {
    /// Kill the command and everything it started, right away. A WSL command
    /// whose group isn't reported yet is killed when it is.
    async fn kill(&self) {
        match self {
            Running::Host { job: Some(job), .. } => job.terminate(),
            Running::Host { pid, job: None } => kill_process_tree(*pid),
            Running::Wsl { distro, group } => {
                if let Some(g) = group.stop() {
                    wsl::stop_groups(distro, &[g], Duration::ZERO).await;
                }
            }
        }
    }
}

/// command_id → the running command and whether it was cancelled, so
/// `run_command_cancel` can find and tree-kill a run the model aborted.
type Registry = HashMap<String, (Running, Arc<AtomicBool>)>;

fn registry() -> &'static Mutex<Registry> {
    static R: OnceLock<Mutex<Registry>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct RunCommandResult {
    pub stdout: String,
    pub stderr: String,
    /// `None` when the process was killed by a signal (timeout / cancel on unix).
    pub exit_code: Option<i32>,
    /// True on timeout or cancellation.
    pub killed: bool,
    pub duration_ms: u32,
    /// The kernel killed the command, or something it started, for going
    /// over `memory_limit_mb`.
    pub out_of_memory: bool,
    /// The ceiling the command ran under; None when it ran without one.
    pub memory_limit_mb: Option<u32>,
}

/// Host default shell: bash where it's installed, else `sh`, on unix;
/// PowerShell on Windows (see [`powershell_command`]). Models write bash — `[[ ]]`, arrays, `source`, `pipefail` —
/// and `/bin/sh` is dash on Debian and Ubuntu, where all of that fails.
#[cfg(unix)]
fn default_shell_command(command: &str) -> tokio::process::Command {
    static BASH: OnceLock<bool> = OnceLock::new();
    let bash = *BASH.get_or_init(|| {
        std::env::var_os("PATH")
            .is_some_and(|p| std::env::split_paths(&p).any(|d| d.join("bash").is_file()))
    });
    let mut c = tokio::process::Command::new(if bash { "bash" } else { "sh" });
    c.arg("-c").arg(command);
    c
}

#[cfg(windows)]
fn default_shell_command(command: &str) -> tokio::process::Command {
    let exe = crate::shell::catalog::agent_powershell()
        .map(|p| p.exe)
        .unwrap_or_else(|| "powershell.exe".to_string());
    powershell_command(&exe, command)
}

/// Run before a command in PowerShell: UTF-8 out (5.1 writes the console's
/// code page), no progress bars or colour codes in the captured output, and
/// no exit code left over from the user's profile.
const POWERSHELL_PRELUDE: &str = "$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false) } catch {}
$OutputEncoding = [Text.UTF8Encoding]::new($false)
if ($PSStyle) { $PSStyle.OutputRendering = 'PlainText' }
$global:LASTEXITCODE = 0";

/// Run after it: the exit code a bash user expects. PowerShell's own is 1
/// for any failure, a native program's code lost; this keeps it.
const POWERSHELL_EXIT: &str =
    "if (-not $?) { if ($LASTEXITCODE) { exit $LASTEXITCODE }; exit 1 }; exit 0";

/// One command in PowerShell (`exe`: pwsh or Windows PowerShell): no
/// profile and no prompts, scripts allowed (5.1 refuses `.uild.ps1` by
/// default), and the script passed encoded so no quote in it is mangled on
/// its way through the Windows command line.
fn powershell_command(exe: &str, command: &str) -> tokio::process::Command {
    use base64::Engine as _;
    let script = format!(
        "{POWERSHELL_PRELUDE}
{command}
{POWERSHELL_EXIT}"
    );
    let utf16: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    let mut c = tokio::process::Command::new(exe);
    c.args([
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-OutputFormat",
        "Text",
        "-EncodedCommand",
    ])
    .arg(base64::engine::general_purpose::STANDARD.encode(utf16));
    c
}

/// Build the one-shot command. A `shell` (Windows: the Code session's distro,
/// or the Shell tab's picker in its Code mode) routes to that shell —
/// PowerShell, or bash inside a WSL distro — instead of the host default
/// (`cmd /C`), which can't run PowerShell/Linux syntax. WSL runs in a
/// process group of its own and changes into the Linux `cwd` itself (see
/// [`wsl::group_command`]); the host can't `current_dir` into it.
/// `wsl_memory_percent`: a WSL command's memory limit, applied inside the
/// distro (see `wsl::group_command`); a host command's is `command_scope`'s.
fn build_shell_command(
    command: &str,
    cwd: &str,
    shell: Option<&ShellSelection>,
    wsl_memory_percent: Option<u8>,
) -> tokio::process::Command {
    match shell {
        Some(ShellSelection::Powershell { exe }) => powershell_command(exe, command),
        Some(ShellSelection::Wsl { distro }) => {
            wsl::group_command(distro, cwd, command, wsl_memory_percent)
        }
        None => default_shell_command(command),
    }
}

/// No console window for a command the agent runs (Windows).
fn hide_window(cmd: &mut tokio::process::Command) {
    #[cfg(windows)]
    cmd.creation_flags(crate::shell::platform::CREATE_NO_WINDOW);
    #[cfg(not(windows))]
    let _ = cmd;
}

/// Kill a process and its descendants. Unix: the child is a process-group
/// leader (spawned with `process_group(0)`), so signalling the group reaps
/// orphaned `npm`/`cargo` children too. Windows: `taskkill /T` walks the tree.
#[cfg(unix)]
fn kill_process_tree(pid: u32) {
    // SIGKILL the whole group. Best-effort; ignore ESRCH if already gone.
    unsafe {
        libc::killpg(pid as i32, libc::SIGKILL);
    }
}

#[cfg(windows)]
fn kill_process_tree(pid: u32) {
    let mut cmd = std::process::Command::new("taskkill");
    cmd.args(["/F", "/T", "/PID", &pid.to_string()]);
    crate::shell::platform::apply_no_window(&mut cmd);
    let _ = cmd.output();
}

/// Run `command` once in a fresh shell rooted at `cwd`, capture stdout+stderr,
/// enforce `timeout_secs` with a process-tree kill, and allow cancellation via
/// `run_command_cancel(command_id)`. No state persists between calls — the
/// model chains `cd x && cmd` when it needs directory context.
#[tauri::command]
pub async fn run_command_capture(
    command: String,
    cwd: String,
    timeout_secs: Option<u64>,
    command_id: String,
    shell: Option<ShellSelection>,
    memory_limit_percent: Option<u8>,
) -> Result<RunCommandResult, String> {
    // A WSL session runs inside the distro: its cwd is a Linux path the Windows
    // host can't stat, and the dir is set via `wsl --cd` rather than current_dir.
    let wsl_distro = match &shell {
        Some(ShellSelection::Wsl { distro }) => Some(distro.clone()),
        _ => None,
    };
    let is_wsl = wsl_distro.is_some();
    if !is_wsl && !Path::new(&cwd).is_dir() {
        return Err(format!("Working directory does not exist: {cwd}"));
    }
    let timeout = Duration::from_secs(
        timeout_secs
            .unwrap_or(DEFAULT_TIMEOUT_SECS)
            .clamp(1, MAX_TIMEOUT_SECS),
    );
    let start = Instant::now();

    let cmd = build_shell_command(&command, &cwd, shell.as_ref(), memory_limit_percent);
    // The host's memory ceiling is a host-Linux scope; a WSL command's is set
    // inside the distro, by its wrapper.
    let limit = memory_limit_percent
        .filter(|_| !is_wsl)
        .and_then(command_scope::limit_bytes);
    let (mut cmd, scope) = match limit {
        Some(limit) => command_scope::wrap(cmd, &command_id, limit),
        None => (cmd, None),
    };
    // Windows: the job holds the tree and the memory limit (None elsewhere).
    let job = if is_wsl {
        None
    } else {
        job::Job::new(limit).map(Arc::new)
    };
    hide_window(&mut cmd);
    // Never for a WSL relay: see `wsl::GroupState`.
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(!is_wsl);
    if !is_wsl {
        cmd.current_dir(&cwd);
    }
    // Own process group so a timeout/cancel can reap the whole subtree.
    #[cfg(unix)]
    cmd.process_group(0);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn command: {e}"))?;
    let group = Arc::new(wsl::GroupState::default());
    let running = match &wsl_distro {
        Some(distro) => Some(Running::Wsl {
            distro: distro.clone(),
            group: group.clone(),
        }),
        None => child.id().map(|pid| Running::Host {
            pid,
            job: job.clone().filter(|j| j.assign(pid)),
        }),
    };
    let cancelled = Arc::new(AtomicBool::new(false));
    if let Some(r) = &running {
        registry()
            .lock_or_recover()
            .insert(command_id.clone(), (r.clone(), cancelled.clone()));
    }

    // Drain both pipes concurrently so a chatty command can't deadlock on a
    // full pipe buffer while we wait.
    let mut stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let out_task = tokio::spawn(async move {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf).await;
        buf
    });
    let err_task = tokio::spawn(read_stderr(
        stderr,
        wsl_distro.clone().map(|d| (d, group.clone())),
    ));

    let mut killed = false;
    let status = match tokio::time::timeout(timeout, child.wait()).await {
        Ok(s) => Some(s.map_err(|e| format!("Failed to wait on command: {e}"))?),
        Err(_) => {
            killed = true;
            if let Some(r) = &running {
                r.kill().await;
            }
            if is_wsl {
                // The relay ends once its group has; never killed, so not
                // waited on forever either.
                match tokio::time::timeout(RELAY_EXIT_WAIT, child.wait()).await {
                    Ok(s) => s.ok(),
                    Err(_) => None,
                }
            } else {
                Some(
                    child
                        .wait()
                        .await
                        .map_err(|e| format!("Failed to reap killed command: {e}"))?,
                )
            }
        }
    };
    registry().lock_or_recover().remove(&command_id);

    // Collect output with a grace window; if a lingering child still holds a
    // pipe open, kill the tree and return what we have.
    let readers = async { (out_task.await, err_task.await) };
    let (stdout_bytes, stderr_bytes) = match tokio::time::timeout(DRAIN_GRACE, readers).await {
        Ok((o, e)) => (o.unwrap_or_default(), e.unwrap_or_default()),
        Err(_) => {
            if let Some(r) = &running {
                r.kill().await;
            }
            (Vec::new(), Vec::new())
        }
    };

    let exit_code = status.and_then(|s| s.code());
    // A command that outgrew its ceiling usually still exits: the kernel kills
    // the biggest process (the test binary), and whatever ran it reports a
    // failure. Only the scope knows why.
    let out_of_memory = match &scope {
        Some(scope) if !killed && exit_code != Some(0) => scope.out_of_memory().await,
        // Inside WSL the scope is gone by now; a SIGKILL we didn't send, under
        // a limit, is the kernel's.
        None => {
            is_wsl
                && memory_limit_percent.is_some_and(|p| p > 0)
                && !killed
                && !cancelled.load(Ordering::SeqCst)
                && exit_code == Some(137)
        }
        _ => false,
    };
    // Windows: the job ended it for its memory limit.
    let out_of_memory = out_of_memory || job.as_ref().is_some_and(|j| j.out_of_memory());
    // A tree-kill leaves no exit code (signaled) on unix — treat as killed even
    // if the cancel raced ahead of our own timeout branch. Inside WSL a killed
    // command still has one (`setsid -w` reports 128 + the signal).
    if (exit_code.is_none() && !out_of_memory) || cancelled.load(Ordering::SeqCst) {
        killed = true;
    }

    // A finished command's detached children outlive it, as on unix; a
    // stopped one's were ended with it.
    if let Some(job) = &job {
        job.release();
    }

    Ok(RunCommandResult {
        stdout: String::from_utf8_lossy(&stdout_bytes).into_owned(),
        stderr: String::from_utf8_lossy(&stderr_bytes).into_owned(),
        exit_code,
        killed,
        duration_ms: start.elapsed().as_millis() as u32,
        out_of_memory,
        memory_limit_mb: scope
            .map(|s| s.limit_bytes)
            .or(limit.filter(|_| job.is_some()))
            .map(|b| (b >> 20) as u32),
    })
}

/// The PowerShell a Code session in a Windows folder runs its commands in,
/// for the system prompt to name. None off Windows.
#[tauri::command]
pub async fn code_powershell() -> Option<crate::shell::catalog::AgentPowershell> {
    tokio::task::spawn_blocking(crate::shell::catalog::agent_powershell)
        .await
        .ok()
        .flatten()
}

/// Kill a running `run_command_capture` invocation by its `command_id`. Called
/// from the tool's abort handler. No-op if the command already finished.
#[tauri::command]
pub async fn run_command_cancel(command_id: String) -> Result<(), String> {
    let running = registry().lock_or_recover().get(&command_id).cloned();
    if let Some((r, cancelled)) = running {
        cancelled.store(true, Ordering::SeqCst);
        r.kill().await;
    }
    Ok(())
}

/// Read a command's stderr to the end. For a WSL command (its distro and
/// group given), the wrapper's group id is taken off the front and recorded;
/// a command stopped before then is killed as it arrives.
async fn read_stderr(
    mut stderr: tokio::process::ChildStderr,
    wsl: Option<(String, Arc<wsl::GroupState>)>,
) -> Vec<u8> {
    let mut buf = Vec::new();
    let Some((distro, group)) = wsl else {
        let _ = stderr.read_to_end(&mut buf).await;
        return buf;
    };
    let mut reader = wsl::PgidReader::default();
    let mut chunk = vec![0u8; 8192];
    loop {
        match stderr.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let (g, rest) = reader.feed(&chunk[..n]);
                if let Some(g) = g {
                    if group.reported(g) {
                        let distro = distro.clone();
                        tokio::spawn(async move {
                            wsl::stop_groups(&distro, &[g], Duration::ZERO).await
                        });
                    }
                }
                buf.extend(rest);
            }
        }
    }
    buf.extend(reader.finish());
    buf
}

/// Spill a command's full output to a temp file when it's too big to return
/// inline, returning the path. The model reads it back via fs_read_text with
/// offset/limit instead of carrying it all in context.
/// One thing an unattended coding run's shell must not reach, with the words
/// a refusal uses for it.
#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ProtectedPath {
    /// Absolute, with a trailing separator.
    pub path: String,
    /// "data directory", "source tree", …
    pub label: String,
}

#[derive(Clone, Debug, Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export)]
pub struct ProtectedPort {
    pub port: u16,
    pub label: String,
}

/// Haruspex's own directories and local services. The frontend's boundary
/// check (`src/lib/shell/boundary.ts`) refuses an unattended command that
/// names one of them: a coding run once read the app's database and called
/// the user's ComfyUI to get around a missing input.
#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ProtectedTargets {
    pub home: String,
    pub paths: Vec<ProtectedPath>,
    pub ports: Vec<ProtectedPort>,
}

#[tauri::command]
pub fn app_protected_targets(
    app: tauri::AppHandle,
    extra_ports: Vec<ProtectedPort>,
) -> ProtectedTargets {
    use tauri::Manager;
    let p = app.path();
    let mut paths: Vec<ProtectedPath> = Vec::new();
    let mut add = |dir: Option<PathBuf>, label: &str, only_if_ours: bool| {
        let Some(dir) = dir else { return };
        let s = dir.to_string_lossy().to_string();
        // An install directory is protected only when it is plainly ours: a
        // packaged Linux build runs from /usr/bin, and refusing every command
        // that names /usr/bin would refuse half of all builds.
        if only_if_ours && !s.to_lowercase().contains("haruspex") {
            return;
        }
        let sep = std::path::MAIN_SEPARATOR;
        let path = if s.ends_with(sep) {
            s
        } else {
            format!("{s}{sep}")
        };
        if !paths.iter().any(|x| x.path == path) {
            paths.push(ProtectedPath {
                path,
                label: label.to_string(),
            });
        }
    };
    add(p.app_data_dir().ok(), "data directory", false);
    add(p.app_config_dir().ok(), "settings directory", false);
    add(p.app_cache_dir().ok(), "cache directory", false);
    add(p.app_log_dir().ok(), "log directory", false);
    add(p.resource_dir().ok(), "install directory", true);
    add(
        std::env::current_exe()
            .ok()
            .and_then(|e| e.parent().map(Path::to_path_buf)),
        "install directory",
        true,
    );
    // A dev build knows its source tree; a coding run on Haruspex itself is
    // allowed by the frontend, which skips a path containing the run's root.
    #[cfg(debug_assertions)]
    add(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .map(Path::to_path_buf),
        "source tree",
        false,
    );

    let mut ports = vec![
        ProtectedPort {
            port: crate::sidecar_utils::ports::LLAMA,
            label: "chat model server".into(),
        },
        ProtectedPort {
            port: crate::sidecar_utils::ports::WHISPER,
            label: "speech-to-text server".into(),
        },
        ProtectedPort {
            port: crate::sidecar_utils::ports::TTS,
            label: "text-to-speech server".into(),
        },
        ProtectedPort {
            port: crate::sidecar_utils::ports::IMAGE,
            label: "image engine".into(),
        },
    ];
    for extra in extra_ports {
        if !ports.iter().any(|x| x.port == extra.port) {
            ports.push(extra);
        }
    }
    ProtectedTargets {
        home: p
            .home_dir()
            .map(|h| h.to_string_lossy().to_string())
            .unwrap_or_default(),
        paths,
        ports,
    }
}

#[tauri::command]
pub async fn code_write_overflow(content: String) -> Result<String, String> {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let path = std::env::temp_dir().join(format!("haruspex-run-output-{nanos}.txt"));
    tokio::fs::write(&path, content)
        .await
        .map_err(|e| format!("Failed to write overflow file: {e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// WSL integration: needs a WSL2 distro, so `--ignored` on the Windows box.
    #[cfg(windows)]
    mod wsl_runs {
        use super::*;

        fn distro() -> String {
            wsl::distros().into_iter().next().expect("a WSL2 distro")
        }

        async fn run(command: &str, cwd: &str, timeout: u64, id: &str) -> RunCommandResult {
            run_limited(command, cwd, timeout, id, 50).await
        }

        async fn run_limited(
            command: &str,
            cwd: &str,
            timeout: u64,
            id: &str,
            percent: u8,
        ) -> RunCommandResult {
            run_command_capture(
                command.to_string(),
                cwd.to_string(),
                Some(timeout),
                id.to_string(),
                Some(ShellSelection::Wsl { distro: distro() }),
                Some(percent),
            )
            .await
            .unwrap()
        }

        #[tokio::test]
        #[ignore]
        async fn a_command_over_its_memory_limit_is_stopped_and_said_so() {
            // A scope only when the distro's user lingers (see GROUP_WRAPPER).
            let linger = run_limited(
                r#"loginctl show-user "$(id -un)" -p Linger --value"#,
                "/tmp",
                60,
                "w-mem-linger",
                0,
            )
            .await;
            let lingers = linger.stdout.trim() == "yes";
            let res = run_limited(
                "cat /proc/self/cgroup; echo '$HOME'",
                "/tmp",
                60,
                "w-mem-ok",
                5,
            )
            .await;
            assert_eq!(res.exit_code, Some(0), "{res:?}");
            // systemd leaves `$HOME` alone either way.
            assert!(res.stdout.contains("$HOME"), "{}", res.stdout);
            assert_eq!(res.stdout.contains("/run-"), lingers, "{}", res.stdout);
            assert!(!res.out_of_memory);
            if !lingers {
                eprintln!("the distro's user doesn't linger: no limit, as designed");
                return;
            }
            // 1% of the distro's memory, then far more than that.
            let res = run_limited(
                "python3 -c 'b = bytearray(4 << 30); print(len(b))'",
                "/tmp",
                120,
                "w-mem-oom",
                1,
            )
            .await;
            assert!(res.out_of_memory, "{res:?}");
            assert!(!res.killed, "{res:?}");
            // Without a limit, no scope.
            let res = run_limited("cat /proc/self/cgroup", "/tmp", 60, "w-mem-none", 0).await;
            assert!(!res.stdout.contains("run-"), "{}", res.stdout);
        }

        #[tokio::test]
        #[ignore]
        async fn a_command_runs_in_the_linux_folder_with_its_own_output_and_exit_code() {
            let res = run(
                "pwd; uname -s; echo oops >&2; exit 3",
                "/tmp",
                30,
                "w-basic",
            )
            .await;
            assert_eq!(
                res.stdout,
                "/tmp
Linux
"
            );
            // The wrapper's group line is not the command's stderr.
            assert_eq!(
                res.stderr,
                "oops
"
            );
            assert_eq!(res.exit_code, Some(3));
            assert!(!res.killed);
            // Nothing applies the host's memory ceiling inside WSL.
            assert_eq!(res.memory_limit_mb, None);
        }

        #[tokio::test]
        #[ignore]
        async fn a_missing_folder_fails_rather_than_running_in_root() {
            let res = run("pwd", "/no/such/folder", 30, "w-cwd").await;
            assert_eq!(res.stdout, "");
            assert!(res.stderr.contains("does not exist"), "{}", res.stderr);
            assert_eq!(res.exit_code, Some(126));
        }

        #[tokio::test]
        #[ignore]
        async fn a_timeout_kills_the_whole_group_inside_the_distro() {
            let res = run(
                "sleep 300 & echo $$ > /tmp/haruspex-wsl-timeout; sleep 301",
                "/tmp",
                3,
                "w-timeout",
            )
            .await;
            assert!(res.killed);
            let pgid = run("cat /tmp/haruspex-wsl-timeout", "/tmp", 30, "w-read").await;
            let pgid: u32 = pgid.stdout.trim().parse().unwrap();
            assert!(
                !wsl::group_alive(&distro(), pgid).await,
                "group {pgid} left running"
            );
        }

        #[tokio::test]
        #[ignore]
        async fn a_cancel_kills_the_whole_group_inside_the_distro() {
            let d = distro();
            let task = tokio::spawn(run(
                "sleep 300 & echo $$ > /tmp/haruspex-wsl-cancel; sleep 301",
                "/tmp",
                120,
                "w-cancel",
            ));
            tokio::time::sleep(Duration::from_secs(4)).await;
            run_command_cancel("w-cancel".to_string()).await.unwrap();
            let res = tokio::time::timeout(Duration::from_secs(20), task)
                .await
                .expect("the cancelled command returns")
                .unwrap();
            assert!(res.killed);
            let pgid = run("cat /tmp/haruspex-wsl-cancel", "/tmp", 30, "w-read2").await;
            let pgid: u32 = pgid.stdout.trim().parse().unwrap();
            assert!(
                !wsl::group_alive(&d, pgid).await,
                "group {pgid} left running"
            );
        }
    }

    /// Commands in a Windows folder: PowerShell in a Job object.
    #[cfg(windows)]
    mod powershell_runs {
        use super::*;

        async fn run(
            command: &str,
            timeout: u64,
            id: &str,
            percent: Option<u8>,
        ) -> RunCommandResult {
            run_command_capture(
                command.to_string(),
                std::env::temp_dir().to_string_lossy().into_owned(),
                Some(timeout),
                id.to_string(),
                None,
                percent,
            )
            .await
            .unwrap()
        }

        #[tokio::test]
        async fn a_native_programs_exit_code_comes_through() {
            let res = run("cmd /c exit 7", 30, "p-native-exit", None).await;
            assert_eq!(res.exit_code, Some(7));
            // A failing cmdlet is 1; a success after a failure is 0, as in bash.
            let res = run(r"Get-Item C:\no\such\thing", 30, "p-cmdlet", None).await;
            assert_eq!(res.exit_code, Some(1), "{res:?}");
            let res = run("cmd /c exit 4; Write-Output fine", 30, "p-later", None).await;
            assert_eq!(res.exit_code, Some(0), "{res:?}");
        }

        #[tokio::test]
        async fn quotes_and_unicode_arrive_intact() {
            let res = run(r#"Write-Output "a ""b"" 'c' é ✓""#, 30, "p-quotes", None).await;
            assert_eq!(res.stdout.trim(), r#"a "b" 'c' é ✓"#, "{res:?}");
            assert_eq!(res.exit_code, Some(0));
        }

        #[tokio::test]
        async fn a_timeout_ends_what_the_command_started() {
            let marker = std::env::temp_dir().join("haruspex-job-timeout.txt");
            let _ = std::fs::remove_file(&marker);
            // A grandchild, detached from the tree, that would write the
            // marker after the timeout if it survived.
            let cmd = format!(
                "Start-Process -WindowStyle Hidden powershell.exe -ArgumentList '-NoProfile','-Command','Start-Sleep 4; Set-Content {} x'; Start-Sleep 60",
                marker.display()
            );
            let res = run(&cmd, 2, "p-timeout", None).await;
            assert!(res.killed, "{res:?}");
            tokio::time::sleep(Duration::from_secs(5)).await;
            assert!(!marker.exists(), "the grandchild outlived the timeout");
        }

        #[tokio::test]
        async fn a_command_over_its_memory_limit_is_stopped_and_said_so() {
            // 1% of RAM: well under what this allocates.
            let res = run(
                "$l = [System.Collections.Generic.List[byte[]]]::new(); while ($true) { $l.Add([byte[]]::new(64MB)) }",
                120,
                "p-oom",
                Some(1),
            )
            .await;
            assert!(res.out_of_memory, "{res:?}");
            assert!(!res.killed);
            assert!(res.memory_limit_mb.is_some());
        }

        #[tokio::test]
        async fn cancel_ends_the_command() {
            let task = tokio::spawn(run("Start-Sleep 60", 120, "p-cancel", None));
            tokio::time::sleep(Duration::from_secs(2)).await;
            run_command_cancel("p-cancel".to_string()).await.unwrap();
            let res = tokio::time::timeout(Duration::from_secs(10), task)
                .await
                .expect("the cancelled command returns")
                .unwrap();
            assert!(res.killed);
        }
    }

    #[tokio::test]
    async fn run_command_captures_stdout_and_exit_code() {
        let cwd = std::env::temp_dir();
        let res = run_command_capture(
            "echo hello".to_string(),
            cwd.to_string_lossy().into_owned(),
            Some(10),
            "t-echo".to_string(),
            None,
            None,
        )
        .await
        .unwrap();
        assert_eq!(res.stdout.trim(), "hello");
        assert_eq!(res.exit_code, Some(0));
        assert!(!res.killed);
    }

    #[tokio::test]
    async fn run_command_passes_through_nonzero_exit() {
        let res = run_command_capture(
            "exit 3".to_string(),
            std::env::temp_dir().to_string_lossy().into_owned(),
            Some(10),
            "t-exit".to_string(),
            None,
            None,
        )
        .await
        .unwrap();
        assert_eq!(res.exit_code, Some(3));
        assert!(!res.killed);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn run_command_times_out_and_kills() {
        let res = run_command_capture(
            "sleep 30".to_string(),
            std::env::temp_dir().to_string_lossy().into_owned(),
            Some(1),
            "t-timeout".to_string(),
            None,
            None,
        )
        .await
        .unwrap();
        assert!(res.killed, "expected killed on timeout");
        assert_eq!(res.exit_code, None);
        assert!(res.duration_ms < 10_000, "should not wait the full sleep");
    }

    #[tokio::test]
    async fn run_command_rejects_bad_cwd() {
        let err = run_command_capture(
            "echo x".to_string(),
            "/no/such/dir/at/all".to_string(),
            Some(5),
            "t-badcwd".to_string(),
            None,
            None,
        )
        .await
        .unwrap_err();
        assert!(err.contains("does not exist"), "got: {err}");
    }
}
