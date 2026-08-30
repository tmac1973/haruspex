//! Keeps the machine awake while a job run is in flight.
//!
//! The job scheduler and runner are frontend code (`src/lib/agent/jobs/`) —
//! a 30 s `setInterval` ticker plus JS-driven pipelines. An OS suspend
//! therefore doesn't merely pause inference, it stalls the whole run loop,
//! and because the process never dies the run isn't even swept into
//! `interrupted` by `recover_orphan_runs` on resume: it just sits at
//! `running` forever. So an unattended overnight job needs the machine held
//! awake for the duration.
//!
//! `keepawake` maps to systemd-logind `Inhibit` on Linux,
//! `IOPMAssertionCreateWithName` on macOS and `SetThreadExecutionState` on
//! Windows. Two things about those backends dictate the shape of this module:
//!
//!   * On Windows the execution state is **per-thread**, and is cleared when
//!     the setting thread exits. A `spawn_blocking` worker would do — until
//!     tokio reaps it as idle ~10 s later and the inhibit silently vanishes.
//!   * On Linux the guard holds blocking zbus connections, which must not be
//!     driven from the Tauri main thread (GUI event loop) or from inside the
//!     tokio runtime.
//!
//! Both are answered by owning one dedicated thread whose whole job is to
//! hold the guard. It is created on first use and lives as long as the
//! inhibit is wanted; the `KeepAwake` value never crosses a thread boundary.
//!
//! Note `display` is deliberately left off: a background job has no reason to
//! keep the screen lit, and the screen-on path is the one whose `Drop` calls
//! `unwrap()` on a D-Bus round trip (a panic-in-drop if the session bus went
//! away). Only `idle` and `sleep` are requested, and both are best-effort —
//! `sleep` is ignored on Windows machines with modern standby and generally
//! on battery, and on Linux it takes a logind "block" inhibitor, so while a
//! job runs a lid close will not suspend the machine either.

use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Mutex;
use std::thread::JoinHandle;
use tauri::State;
use tokio::sync::oneshot;

/// Reason string shown by `systemd-inhibit --list` / `powercfg /requests`.
const REASON: &str = "Job run in progress";

enum Cmd {
    /// Take the inhibit if it isn't already held; reports the outcome.
    Acquire(oneshot::Sender<Result<(), String>>),
    /// Drop the inhibit if held. Always succeeds, so it carries no reply.
    Release,
}

/// The dedicated thread's loop. `guard` is the live inhibit; dropping it
/// releases. Returns when the channel closes (see [`PowerInhibitor::shutdown`]),
/// which drops the guard as it unwinds.
fn worker(rx: Receiver<Cmd>) {
    let mut guard: Option<keepawake::KeepAwake> = None;
    for cmd in rx {
        match cmd {
            Cmd::Acquire(reply) => {
                let result = if guard.is_some() {
                    Ok(())
                } else {
                    match keepawake::Builder::default()
                        .idle(true)
                        .sleep(true)
                        .app_name("Haruspex")
                        .app_reverse_domain("com.haruspex.app")
                        .reason(REASON)
                        .create()
                    {
                        Ok(awake) => {
                            guard = Some(awake);
                            log::info!("power: sleep inhibited for the duration of the job run");
                            Ok(())
                        }
                        // A machine with no logind / no session bus (a bare TTY,
                        // some containers) is a normal environment to run in —
                        // report it so the caller can log once, don't panic.
                        Err(e) => Err(e.to_string()),
                    }
                };
                let _ = reply.send(result);
            }
            Cmd::Release => {
                if guard.take().is_some() {
                    log::info!("power: sleep inhibit released");
                }
            }
        }
    }
}

/// Managed state owning the inhibit thread. One per app.
#[derive(Default)]
pub struct PowerInhibitor {
    worker: Mutex<Option<(Sender<Cmd>, JoinHandle<()>)>>,
}

impl PowerInhibitor {
    pub fn new() -> Self {
        Self::default()
    }

    /// Hand a command to the worker, starting it if this is the first call.
    /// A worker that has gone away (only possible if it panicked) is cleared
    /// so the next call starts a fresh one rather than failing forever.
    fn send(&self, cmd: Cmd) -> Result<(), String> {
        let mut slot = self
            .worker
            .lock()
            .map_err(|_| "power inhibitor state is poisoned".to_string())?;

        if slot.is_none() {
            let (tx, rx) = mpsc::channel::<Cmd>();
            let handle = std::thread::Builder::new()
                .name("power-inhibit".into())
                .spawn(move || worker(rx))
                .map_err(|e| format!("could not start the power inhibitor thread: {e}"))?;
            *slot = Some((tx, handle));
        }

        let sent = slot
            .as_ref()
            .map(|(tx, _)| tx.send(cmd))
            .expect("worker slot was just filled");
        if sent.is_err() {
            *slot = None;
            return Err("the power inhibitor thread stopped".to_string());
        }
        Ok(())
    }

    /// Release at process exit. Dropping the sender closes the channel, which
    /// ends the worker loop and drops the guard.
    ///
    /// Deliberately does not join: every backend releases on process death
    /// anyway (the kernel closes logind's inhibitor fds, the macOS assertion
    /// and the Windows thread state die with the process), so joining would
    /// only add a way for a wedged D-Bus call to hang the exit path.
    pub fn shutdown(&self) {
        if let Ok(mut slot) = self.worker.lock() {
            *slot = None;
        }
    }
}

/// Ask the OS to keep the machine awake. Idempotent: a second call while the
/// inhibit is held is a no-op that reports success.
#[tauri::command]
pub async fn power_inhibit_acquire(state: State<'_, PowerInhibitor>) -> Result<(), String> {
    let (tx, rx) = oneshot::channel();
    // The lock is taken and released inside send(); nothing is held across
    // the await (a std MutexGuard is not Send).
    state.send(Cmd::Acquire(tx))?;
    rx.await
        .map_err(|_| "the power inhibitor thread stopped".to_string())?
}

/// Let the machine sleep again. Idempotent, and safe to call when no inhibit
/// is held — the frontend uses that at startup to clear an inhibit stranded
/// by a webview reload, which the Rust process outlives.
#[tauri::command]
pub async fn power_inhibit_release(state: State<'_, PowerInhibitor>) -> Result<(), String> {
    state.send(Cmd::Release)
}
