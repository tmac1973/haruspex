//! Spawning a sidecar so that it cannot outlive the app.
//!
//! The shell plugin's `spawn` ties nothing to our lifetime. The Exit handler
//! stops the sidecars on a clean quit, but a crash, a SIGKILL or a `tauri dev`
//! rebuild skips it, and the sidecar runs on: an image engine held 9 GB of
//! VRAM for six hours that way. So the plugin still BUILDS the command (it
//! resolves the binary next to the executable and carries the env), and this
//! module spawns it:
//!
//! - **Linux:** `PR_SET_PDEATHSIG` in the child, so the kernel sends SIGTERM
//!   when we die, however we die. The signal fires when the parent THREAD
//!   exits, not the process, so every spawn runs on one dedicated thread that
//!   lives as long as the app. A tokio worker or a blocking-pool thread would
//!   retire and take a healthy sidecar with it.
//! - **Windows:** every sidecar joins one Job Object created with
//!   `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. Its handle is never closed, so the
//!   OS closes it when our process ends and kills the job's processes.
//! - **macOS:** no equivalent. The launch sweep (`orphans`) covers it.
//!
//! Every platform records the child in the `sidecars` orphan registry, so the
//! next launch can sweep whatever survived anyway.
//!
//! The events are the plugin's own `CommandEvent`s, split into lines the way
//! the plugin splits them, so the sidecars' log readers do not change.

#[cfg(windows)]
use log::warn;
use shared_child::SharedChild;
use std::io::BufReader;
use std::path::PathBuf;
use std::process::{Command as StdCommand, Stdio};
use std::sync::{mpsc, Arc, OnceLock, RwLock};
use tauri::async_runtime::{block_on, channel, Receiver, Sender};
use tauri_plugin_shell::process::{Command, CommandEvent, TerminatedPayload};

use crate::orphans::{self, RunningServer};

/// A running sidecar. Replaces the plugin's `CommandChild`, which cannot be
/// built from outside the plugin.
#[derive(Debug)]
pub struct SidecarChild {
    inner: Arc<SharedChild>,
    id: &'static str,
    registry: Option<PathBuf>,
    /// Held open for the child's life, as the shell plugin did: a server that
    /// reads stdin would otherwise see EOF at once.
    _stdin: Option<std::process::ChildStdin>,
}

impl SidecarChild {
    pub fn pid(&self) -> u32 {
        self.inner.id()
    }

    /// Kill the process and drop it from the orphan registry.
    pub fn kill(self) -> std::io::Result<()> {
        orphans::deregister_pid(self.registry.as_deref(), self.id, self.pid());
        self.inner.kill()
    }
}

/// Where sidecars are recorded for the launch sweep. `None` (no app data
/// directory) degrades the sweep and never fails a spawn.
pub fn sidecar_registry(app: &tauri::AppHandle) -> Option<PathBuf> {
    orphans::registry_path(app, orphans::SIDECARS).ok()
}

type SpawnJob = Box<dyn FnOnce() + Send>;

/// The one thread every sidecar is spawned from. See the module docs for why
/// it must outlive every child.
fn spawner() -> &'static mpsc::Sender<SpawnJob> {
    static SPAWNER: OnceLock<mpsc::Sender<SpawnJob>> = OnceLock::new();
    SPAWNER.get_or_init(|| {
        let (tx, rx) = mpsc::channel::<SpawnJob>();
        std::thread::Builder::new()
            .name("sidecar-spawner".into())
            .spawn(move || {
                for job in rx {
                    job();
                }
            })
            .expect("could not start the sidecar spawner thread");
        tx
    })
}

/// Spawn `cmd` as the sidecar `id`, tied to our lifetime and recorded in the
/// orphan registry at `registry`.
pub fn spawn_sidecar(
    cmd: Command,
    id: &'static str,
    registry: Option<PathBuf>,
) -> Result<(Receiver<CommandEvent>, SidecarChild), String> {
    spawn_prepared(cmd.into(), id, registry)
}

/// The work of `spawn_sidecar`, on the plain command the plugin built.
fn spawn_prepared(
    mut std_cmd: StdCommand,
    id: &'static str,
    registry: Option<PathBuf>,
) -> Result<(Receiver<CommandEvent>, SidecarChild), String> {
    std_cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    die_with_parent(&mut std_cmd);
    let program = std_cmd.get_program().to_string_lossy().into_owned();

    let (done_tx, done_rx) = mpsc::channel();
    spawner()
        .send(Box::new(move || {
            let _ = done_tx.send(SharedChild::spawn(&mut std_cmd));
        }))
        .map_err(|_| format!("{id}: the sidecar spawner thread is gone"))?;
    let child = done_rx
        .recv()
        .map_err(|_| format!("{id}: the sidecar spawner thread is gone"))?
        .map_err(|e| format!("Failed to spawn {id}: {e}"))?;
    let stdin = child.take_stdin();
    let child = Arc::new(child);
    let pid = child.id();

    join_kill_on_close_job(pid);
    orphans::register(
        registry.as_deref(),
        RunningServer {
            id: id.to_string(),
            pid,
            started_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0),
            program,
        },
    );

    let (tx, rx) = channel(1);
    // Terminated must come after the last output line. Readers hold the read
    // lock until their pipe closes; the waiter takes the write lock to send.
    let guard = Arc::new(RwLock::new(()));
    if let Some(out) = child.take_stdout() {
        spawn_reader(tx.clone(), guard.clone(), out, CommandEvent::Stdout);
    }
    if let Some(err) = child.take_stderr() {
        spawn_reader(tx.clone(), guard.clone(), err, CommandEvent::Stderr);
    }
    let waiter = child.clone();
    let reg = registry.clone();
    std::thread::spawn(move || {
        let event = match waiter.wait() {
            Ok(status) => CommandEvent::Terminated(TerminatedPayload {
                code: status.code(),
                #[cfg(unix)]
                signal: std::os::unix::process::ExitStatusExt::signal(&status),
                #[cfg(not(unix))]
                signal: None,
            }),
            Err(e) => CommandEvent::Error(e.to_string()),
        };
        orphans::deregister_pid(reg.as_deref(), id, pid);
        let _lock = guard.write().unwrap_or_else(|p| p.into_inner());
        let _ = block_on(tx.send(event));
    });

    Ok((
        rx,
        SidecarChild {
            inner: child,
            id,
            registry,
            _stdin: stdin,
        },
    ))
}

fn spawn_reader<R: std::io::Read + Send + 'static>(
    tx: Sender<CommandEvent>,
    guard: Arc<RwLock<()>>,
    pipe: R,
    wrap: fn(Vec<u8>) -> CommandEvent,
) {
    std::thread::spawn(move || {
        let _lock = guard.read().unwrap_or_else(|p| p.into_inner());
        let mut reader = BufReader::new(pipe);
        loop {
            let mut buf = Vec::new();
            match tauri::utils::io::read_line(&mut reader, &mut buf) {
                Ok(0) => break,
                Ok(_) => {
                    if block_on(tx.send(wrap(buf))).is_err() {
                        break;
                    }
                }
                Err(e) => {
                    let _ = block_on(tx.send(CommandEvent::Error(e.to_string())));
                    break;
                }
            }
        }
    });
}

/// Linux: ask the kernel to SIGTERM the child when its parent thread (the
/// spawner, which lives as long as the app) dies.
#[cfg(target_os = "linux")]
fn die_with_parent(cmd: &mut StdCommand) {
    use std::os::unix::process::CommandExt;
    let parent = std::process::id() as libc::pid_t;
    // SAFETY: only async-signal-safe calls (prctl, getppid) between fork and
    // exec, and no allocation.
    unsafe {
        cmd.pre_exec(move || {
            if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM) == -1 {
                return Err(std::io::Error::last_os_error());
            }
            // We died between fork and prctl: the signal will never come.
            if libc::getppid() != parent {
                return Err(std::io::Error::from_raw_os_error(libc::ESRCH));
            }
            Ok(())
        });
    }
}

#[cfg(not(target_os = "linux"))]
fn die_with_parent(_cmd: &mut StdCommand) {}

/// Windows: put the child in the app's kill-on-close job.
#[cfg(windows)]
fn join_kill_on_close_job(pid: u32) {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
    };

    // The handle as an integer: raw handles are not Send. Zero means the job
    // could not be made, and every spawn then relies on the sweep.
    static JOB: OnceLock<usize> = OnceLock::new();
    let job = *JOB.get_or_init(|| unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            warn!("could not create the sidecar job object");
            return 0;
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let ok = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const core::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        if ok == 0 {
            warn!("could not make the sidecar job kill on close");
            CloseHandle(job);
            return 0;
        }
        job as usize
    });
    if job == 0 {
        return;
    }
    unsafe {
        let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
        if process.is_null() {
            warn!("could not open sidecar pid {pid} to tie it to the app");
            return;
        }
        if AssignProcessToJobObject(job as _, process) == 0 {
            warn!("could not tie sidecar pid {pid} to the app's job");
        }
        CloseHandle(process);
    }
}

#[cfg(not(windows))]
fn join_kill_on_close_job(_pid: u32) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_arrives_line_by_line_and_termination_comes_last() {
        let mut cmd = std::process::Command::new("sh");
        cmd.args(["-c", "echo one; echo two 1>&2; echo three; exit 3"]);
        // Through the same path the plugin command takes, minus the plugin.
        let (mut rx, _child) = spawn_std(cmd).unwrap();
        let mut out = Vec::new();
        let mut err = Vec::new();
        let mut code = None;
        while let Some(ev) = block_on(rx.recv()) {
            match ev {
                CommandEvent::Stdout(l) => out.push(String::from_utf8_lossy(&l).trim().to_string()),
                CommandEvent::Stderr(l) => err.push(String::from_utf8_lossy(&l).trim().to_string()),
                CommandEvent::Terminated(p) => {
                    code = p.code;
                    assert!(rx.try_recv().is_err(), "nothing after Terminated");
                    break;
                }
                _ => {}
            }
        }
        assert_eq!(out, ["one", "three"]);
        assert_eq!(err, ["two"]);
        assert_eq!(code, Some(3));
    }

    #[test]
    fn kill_stops_the_process_and_forgets_it() {
        let dir = std::env::temp_dir().join("haruspex_sidecar_kill");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let reg = dir.join("running.json");
        let mut cmd = std::process::Command::new("sleep");
        cmd.arg("30");
        let (_rx, child) = spawn_std_registered(cmd, Some(reg.clone())).unwrap();
        let pid = child.pid();
        assert_eq!(orphans::load(&reg)[0].pid, pid);
        child.kill().unwrap();
        assert!(orphans::load(&reg).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The opt-in proof that matters: a sidecar whose app is SIGKILLed dies
    /// too. Re-runs this test binary as the "app" (`HARUSPEX_PDEATH_CHILD`),
    /// which spawns `sleep` through `spawn_sidecar`'s path, prints its pid and
    /// waits to be killed.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_sidecar_dies_when_its_app_is_killed() {
        if std::env::var("HARUSPEX_PDEATH_CHILD").is_ok() {
            let mut cmd = std::process::Command::new("sleep");
            cmd.arg("60");
            let (_rx, child) = spawn_std(cmd).unwrap();
            println!("SLEEP_PID={}", child.pid());
            std::thread::sleep(std::time::Duration::from_secs(60));
            return;
        }
        let exe = std::env::current_exe().unwrap();
        let mut app = std::process::Command::new(exe)
            .args([
                "--exact",
                "sidecar_process::tests::a_sidecar_dies_when_its_app_is_killed",
                "--nocapture",
                "--test-threads=1",
            ])
            .env("HARUSPEX_PDEATH_CHILD", "1")
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut lines = std::io::BufRead::lines(BufReader::new(app.stdout.take().unwrap()));
        let pid: i32 = lines
            // libtest prints "test <name> ... " first, on the same line.
            .find_map(|l| {
                let l = l.ok()?;
                l[l.find("SLEEP_PID=")? + "SLEEP_PID=".len()..]
                    .trim()
                    .parse()
                    .ok()
            })
            .expect("the app printed its sidecar pid");
        assert_eq!(unsafe { libc::kill(pid, 0) }, 0, "sidecar running");
        app.kill().unwrap(); // SIGKILL: no exit handler runs
        app.wait().unwrap();
        let gone = (0..50).any(|_| {
            std::thread::sleep(std::time::Duration::from_millis(20));
            // Reaped by init or a zombie of the dead app: either way not
            // running sleep any more.
            std::fs::read_to_string(format!("/proc/{pid}/stat"))
                .map(|s| s.contains(") Z ") || !s.contains("(sleep)"))
                .unwrap_or(true)
        });
        assert!(gone, "sleep {pid} outlived its SIGKILLed app");
    }

    fn spawn_std(cmd: StdCommand) -> Result<(Receiver<CommandEvent>, SidecarChild), String> {
        spawn_std_registered(cmd, None)
    }

    /// `spawn_sidecar` without the plugin `Command`, which needs an app.
    fn spawn_std_registered(
        cmd: StdCommand,
        registry: Option<PathBuf>,
    ) -> Result<(Receiver<CommandEvent>, SidecarChild), String> {
        spawn_prepared(cmd, "test-sidecar", registry)
    }
}
