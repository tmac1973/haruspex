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
/// was delivered. Refuses 0 and 1: to `kill` and `killpg`, 0 means our own
/// process group, and 1 is init.
#[cfg(unix)]
pub fn kill_pid(pid: u32, signal: Signal, tree: bool) -> bool {
    let Ok(pid) = i32::try_from(pid) else {
        return false;
    };
    if pid <= 1 {
        return false;
    }
    let sig = match signal {
        Signal::Term => libc::SIGTERM,
        Signal::Kill => libc::SIGKILL,
    };
    // SAFETY: `kill` and `killpg` take plain integers and touch no memory of
    // ours; a pid that is gone is ESRCH, not undefined behaviour.
    let rc = unsafe {
        if tree {
            libc::killpg(pid, sig)
        } else {
            libc::kill(pid, sig)
        }
    };
    rc == 0
}

#[cfg(windows)]
pub fn kill_pid(pid: u32, _signal: Signal, tree: bool) -> bool {
    if pid == 0 {
        return false;
    }
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

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn never_signals_our_own_group_or_init() {
        assert!(!kill_pid(0, Signal::Term, false));
        assert!(!kill_pid(0, Signal::Term, true));
        assert!(!kill_pid(1, Signal::Term, false));
        assert!(!kill_pid(u32::MAX, Signal::Term, false));
    }

    #[test]
    fn kills_a_child() {
        let mut child = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .unwrap();
        assert!(kill_pid(child.id(), Signal::Kill, false));
        assert!(!child.wait().unwrap().success());
    }
}
