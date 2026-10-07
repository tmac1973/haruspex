//! A memory ceiling for the agent's one-shot commands.
//!
//! A command runs in the app's own cgroup, so one that allocates without bound
//! takes the app down with it: a coding run's `go test` hit a line-drawing
//! loop that never terminated, filled 60 GB of RAM and 58 GB of swap in about
//! a minute, and systemd-oomd killed the terminal Haruspex was running in.
//!
//! On Linux with a systemd user session, each command runs in its own
//! transient scope (`systemd-run --user --scope`) with `MemoryMax` set and swap
//! off, so the kernel kills the command and nothing else. When the scope ends
//! with `Result=oom-kill` the caller is told, and the model can find the
//! runaway instead of re-running it. Everywhere else this is a no-op.

use tokio::process::Command;

/// The ceiling for one command: `percent` of physical RAM. None when off.
pub fn limit_bytes(percent: u8) -> Option<u64> {
    if percent == 0 {
        return None;
    }
    let mut sys = sysinfo::System::new();
    sys.refresh_memory();
    limit_from_total(sys.total_memory(), percent)
}

fn limit_from_total(total: u64, percent: u8) -> Option<u64> {
    if total == 0 {
        return None;
    }
    Some(total * u64::from(percent.min(100)) / 100)
}

/// A command wrapped in a scope, for reading back how it ended.
pub struct Scope {
    unit: String,
    pub limit_bytes: u64,
}

/// Wrap `cmd` in a memory-limited scope named after `command_id`. Returns the
/// command unchanged, and no scope, where scopes aren't available.
///
/// `systemd-run --scope` execs the command in place, so the PID (and the
/// process group the caller kills on timeout) is the command's own.
pub fn wrap(cmd: Command, command_id: &str, limit_bytes: u64) -> (Command, Option<Scope>) {
    if !imp::available() {
        return (cmd, None);
    }
    let unit = unit_name(command_id);
    let mut wrapped = Command::new("systemd-run");
    wrapped.args(scope_args(&unit, limit_bytes));
    let std = cmd.as_std();
    wrapped.arg(std.get_program()).args(std.get_args());
    (wrapped, Some(Scope { unit, limit_bytes }))
}

fn unit_name(command_id: &str) -> String {
    let id: String = command_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .take(64)
        .collect();
    format!("haruspex-cmd-{id}.scope")
}

fn scope_args(unit: &str, limit_bytes: u64) -> Vec<String> {
    vec![
        "--user".into(),
        "--scope".into(),
        "--quiet".into(),
        // Without this systemd-run rewrites `$VAR` and `$$` in the command
        // line before the shell sees it.
        "--expand-environment=no".into(),
        format!("--unit={unit}"),
        format!("--property=MemoryMax={limit_bytes}"),
        // Swap only stretches a runaway out, slowing the whole desktop while
        // it fills, before the same kill.
        "--property=MemorySwapMax=0".into(),
        "--".into(),
    ]
}

impl Scope {
    /// Whether the kernel killed anything in the scope for exceeding the
    /// limit. Clears the failed unit so it doesn't linger in `systemctl`.
    /// Only worth asking when the command didn't exit 0.
    pub async fn out_of_memory(&self) -> bool {
        let result = Command::new("systemctl")
            .args(["--user", "show", "--property=Result", "--value", &self.unit])
            .output()
            .await;
        let oom =
            matches!(&result, Ok(o) if String::from_utf8_lossy(&o.stdout).trim() == "oom-kill");
        if oom {
            let _ = Command::new("systemctl")
                .args(["--user", "reset-failed", &self.unit])
                .output()
                .await;
        }
        oom
    }
}

#[cfg(target_os = "linux")]
mod imp {
    use std::process::{Command, Stdio};
    use std::sync::OnceLock;

    /// A systemd user manager that takes transient scopes with our flags.
    /// `--expand-environment` needs systemd 254; an older one fails the probe
    /// and runs commands without a ceiling rather than mangling them.
    pub fn available() -> bool {
        static AVAILABLE: OnceLock<bool> = OnceLock::new();
        *AVAILABLE.get_or_init(|| {
            Command::new("systemd-run")
                .args([
                    "--user",
                    "--scope",
                    "--quiet",
                    "--expand-environment=no",
                    "--",
                    "true",
                ])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .map(|s| s.success())
                .unwrap_or(false)
        })
    }
}

#[cfg(not(target_os = "linux"))]
mod imp {
    pub fn available() -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limit_is_a_share_of_ram_and_zero_is_off() {
        assert_eq!(limit_from_total(64 << 30, 50), Some(32 << 30));
        assert_eq!(limit_from_total(64 << 30, 200), Some(64 << 30));
        assert_eq!(limit_from_total(0, 50), None);
        assert_eq!(limit_bytes(0), None);
    }

    #[test]
    fn unit_names_keep_only_safe_characters() {
        assert_eq!(
            unit_name("1b4e28ba-2fa1-11d2-883f-0016d3cca427"),
            "haruspex-cmd-1b4e28ba-2fa1-11d2-883f-0016d3cca427.scope"
        );
        assert_eq!(unit_name("a/b c;$d"), "haruspex-cmd-abcd.scope");
    }

    #[test]
    fn args_turn_off_expansion_and_swap_and_end_options() {
        let args = scope_args("u.scope", 1024);
        assert!(args.contains(&"--expand-environment=no".to_string()));
        assert!(args.contains(&"--property=MemoryMax=1024".to_string()));
        assert!(args.contains(&"--property=MemorySwapMax=0".to_string()));
        assert_eq!(args.last().unwrap(), "--");
    }

    /// The real thing, where a systemd user session exists: a command that
    /// outgrows its ceiling is killed and reported, and `$` survives.
    /// Ignored by default: the kill shows up as a desktop notification.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    #[ignore = "makes the kernel kill a process; run with --ignored"]
    async fn a_runaway_is_killed_and_reported() {
        if !imp::available() {
            return;
        }
        let mut cmd = Command::new("sh");
        // The inner shell holds 400 MB in a variable; the outer one survives
        // its kill and prints its own PID, which systemd-run must not rewrite.
        cmd.args([
            "-c",
            "sh -c 'y=$(head -c 400000000 /dev/zero | tr \"\\\\0\" a)'; echo $$",
        ]);
        let id = format!("test-{}", std::process::id());
        let (mut wrapped, scope) = wrap(cmd, &id, 64 << 20);
        let out = wrapped.output().await.unwrap();
        let scope = scope.unwrap();
        assert!(scope.out_of_memory().await, "{out:?}");
        let printed = String::from_utf8_lossy(&out.stdout);
        assert!(printed.trim().parse::<u32>().is_ok(), "{printed:?}");
    }
}
