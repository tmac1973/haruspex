//! Killing a process by pid, the same way everywhere.
//!
//! The sidecar port reaper, the orphan sweep and the agent's command runner
//! each had their own copy, and only one hid the `taskkill` console window.

/// Which signal to send on unix. Windows has no graceful kill for a process
/// with no window, so `taskkill /F` serves both.
#[derive(Clone, Copy)]
pub enum Signal {
    Term,
    Kill,
}

/// Kill `pid`, or with `tree` everything it started. On unix `tree` signals
/// the process group, so `pid` must be a group leader (spawned with
/// `process_group(0)`); on Windows it is `taskkill /T`. True when the kill
/// was delivered.
#[cfg(unix)]
pub fn kill_pid(pid: u32, signal: Signal, tree: bool) -> bool {
    let sig = match signal {
        Signal::Term => libc::SIGTERM,
        Signal::Kill => libc::SIGKILL,
    };
    let rc = unsafe {
        if tree {
            libc::killpg(pid as i32, sig)
        } else {
            libc::kill(pid as i32, sig)
        }
    };
    rc == 0
}

#[cfg(windows)]
pub fn kill_pid(pid: u32, _signal: Signal, tree: bool) -> bool {
    let pid = pid.to_string();
    let mut cmd = std::process::Command::new("taskkill");
    cmd.arg("/F");
    if tree {
        cmd.arg("/T");
    }
    cmd.args(["/PID", &pid]);
    crate::shell::platform::apply_no_window(&mut cmd);
    cmd.output().is_ok_and(|o| o.status.success())
}
