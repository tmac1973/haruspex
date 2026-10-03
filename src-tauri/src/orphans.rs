//! Reaping children that outlived the app: MCP servers and the sidecars.
//!
//! Killing children on exit is not enough. A SIGKILL'd or crashed app never
//! runs its exit handler, and the servers it spawned keep running — holding
//! memory, file handles and sometimes network ports — until the machine
//! reboots. The user experiences that as "my laptop got slow", and never
//! attributes it to us.
//!
//! So every spawn is recorded to `<app_data>/<kind>/running.json` (`mcp` for
//! MCP servers, `sidecars` for llama-server, whisper, koko and sd-server) and
//! every launch sweeps it: any recorded pid that is still alive **and still running the
//! program we recorded** is killed, then the file is cleared.
//!
//! The command check is the part that makes this safe. Pids are recycled, so a
//! pid alone is not proof of identity — sweeping on pid alone would eventually
//! kill an unrelated process belonging to the user. See [`command_matches`].
//!
//! The sidecars need it as much as MCP does. A `tauri dev` rebuild orphans
//! them too, and an orphaned image engine held 9 GB of VRAM for six hours
//! because it only gets cleared when the next image is asked for. On Linux and
//! Windows the sidecars also die with the app (`sidecar_process`); this sweep
//! is what covers macOS and anything spawned before that existed.

use log::{info, warn};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// Registry kind for MCP servers.
pub const MCP: &str = "mcp";
/// Registry kind for llama-server, whisper-server, koko and sd-server.
pub const SIDECARS: &str = "sidecars";

/// One spawned server, as recorded while it is running.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct RunningServer {
    /// The configured server's id, so a sweep can name what it killed.
    pub id: String,
    pub pid: u32,
    /// Unix seconds. Diagnostic only — the sweep does not trust clocks.
    pub started_at: u64,
    /// Absolute path to the program that was spawned. This is the identity
    /// check on the next launch; see [`command_matches`].
    pub program: String,
}

/// `<app_data>/<kind>/running.json`.
pub fn registry_path(app: &AppHandle, kind: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?
        .join(kind);
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    Ok(dir.join("running.json"))
}

/// Read the registry. A missing or corrupt file is an empty registry, not an
/// error: the sweep must never be the reason the app fails to start.
pub fn load(path: &std::path::Path) -> Vec<RunningServer> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    match serde_json::from_str(&text) {
        Ok(entries) => entries,
        Err(e) => {
            warn!("ignoring unreadable orphan registry at {path:?}: {e}");
            Vec::new()
        }
    }
}

pub fn save(path: &std::path::Path, entries: &[RunningServer]) -> Result<(), String> {
    let text = serde_json::to_string_pretty(entries).map_err(|e| e.to_string())?;
    std::fs::write(path, text).map_err(|e| format!("could not write {}: {e}", path.display()))
}

/// Record a spawn. Replaces any existing entry for the same server id — a
/// restart reuses the id and the old pid is no longer ours to kill.
///
/// A `None` path means there is nowhere to record to (no app data directory);
/// that degrades reaping, so it must never fail a spawn.
pub fn register(path: Option<&std::path::Path>, entry: RunningServer) {
    let Some(path) = path else {
        return;
    };
    let mut entries = load(path);
    entries.retain(|e| e.id != entry.id);
    entries.push(entry);
    if let Err(e) = save(path, &entries) {
        warn!("could not record running process in {path:?}: {e}");
    }
}

/// Drop a server from the registry once we have stopped it ourselves.
pub fn deregister(path: Option<&std::path::Path>, id: &str) {
    deregister_where(path, |e| e.id == id);
}

/// Drop an entry only if it is still this exact process. A child that exits
/// on its own is cleaned up from its wait thread, which can run after a restart
/// has already registered the replacement under the same id; removing by id
/// alone would forget the live one.
pub fn deregister_pid(path: Option<&std::path::Path>, id: &str, pid: u32) {
    deregister_where(path, |e| e.id == id && e.pid == pid);
}

fn deregister_where(path: Option<&std::path::Path>, gone: impl Fn(&RunningServer) -> bool) {
    let Some(path) = path else {
        return;
    };
    let mut entries = load(path);
    let before = entries.len();
    entries.retain(|e| !gone(e));
    if entries.len() != before {
        if let Err(e) = save(path, &entries) {
            warn!("could not update the running-process registry {path:?}: {e}");
        }
    }
}

/// Is the process at this pid still the one we spawned?
///
/// Containment rather than equality: the recorded value is the program path,
/// while the observed command line also carries arguments, and every platform
/// renders it slightly differently (NUL separators on Linux, shell-style
/// quoting on Windows, truncation in `ps`). Requiring the program path to
/// appear in the observed command line is strict enough that a recycled pid
/// running something else will not match, and loose enough to survive those
/// differences.
///
/// An empty recorded program never matches. Otherwise a corrupt registry entry
/// would match every process on the machine.
pub fn command_matches(recorded_program: &str, actual_command: Option<&str>) -> bool {
    if recorded_program.is_empty() {
        return false;
    }
    actual_command.is_some_and(|actual| actual.contains(recorded_program))
}

/// The command line of a running process, or `None` if it is not running.
#[cfg(target_os = "linux")]
pub fn pid_command(pid: u32) -> Option<String> {
    let raw = std::fs::read(format!("/proc/{pid}/cmdline")).ok()?;
    // /proc renders argv NUL-separated, with a trailing NUL.
    Some(
        String::from_utf8_lossy(&raw)
            .replace('\0', " ")
            .trim()
            .to_string(),
    )
}

#[cfg(target_os = "macos")]
pub fn pid_command(pid: u32) -> Option<String> {
    let out = std::process::Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "command="])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!text.is_empty()).then_some(text)
}

#[cfg(target_os = "windows")]
pub fn pid_command(pid: u32) -> Option<String> {
    let out = std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &format!("(Get-CimInstance Win32_Process -Filter \"ProcessId={pid}\").CommandLine"),
        ])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!text.is_empty()).then_some(text)
}

/// Kill a pid we have already confirmed is ours.
pub fn kill_pid(pid: u32) -> bool {
    #[cfg(windows)]
    let result = std::process::Command::new("taskkill")
        .args(["/F", "/T", "/PID", &pid.to_string()])
        .output();
    #[cfg(not(windows))]
    let result = std::process::Command::new("kill")
        .args(["-9", &pid.to_string()])
        .output();
    result.is_ok_and(|o| o.status.success())
}

/// Kill every recorded process that is still alive and still ours, then clear
/// the registry. Call once per kind at launch, before anything of that kind
/// spawns.
///
/// Returns the ids actually killed, for logging and tests.
pub fn sweep(app: &AppHandle, kind: &str) -> Vec<String> {
    let Ok(path) = registry_path(app, kind) else {
        return Vec::new();
    };
    let entries = load(&path);
    if entries.is_empty() {
        return Vec::new();
    }
    let killed = sweep_entries(&entries, pid_command, kill_pid);
    for id in &killed {
        info!("{kind}: reaped orphaned {id} from a previous run");
    }
    // Cleared whether or not anything was killed: entries that are gone are
    // not worth carrying, and a pid we could not kill will not become killable
    // later.
    if let Err(e) = save(&path, &[]) {
        warn!("{kind}: could not clear orphan registry: {e}");
    }
    killed
}

/// The sweep's decision logic, with the platform probes injected so it can be
/// tested without spawning anything.
fn sweep_entries(
    entries: &[RunningServer],
    mut command_of: impl FnMut(u32) -> Option<String>,
    mut kill: impl FnMut(u32) -> bool,
) -> Vec<String> {
    let mut killed = Vec::new();
    for entry in entries {
        let actual = command_of(entry.pid);
        if command_matches(&entry.program, actual.as_deref()) && kill(entry.pid) {
            killed.push(entry.id.clone());
        }
    }
    killed
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn entry(id: &str, pid: u32, program: &str) -> RunningServer {
        RunningServer {
            id: id.to_string(),
            pid,
            started_at: 1_700_000_000,
            program: program.to_string(),
        }
    }

    fn temp_path(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("haruspex_mcp_orphans_{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("running.json")
    }

    #[test]
    fn a_recycled_pid_running_something_else_is_left_alone() {
        let entries = vec![entry("blender", 4242, "/opt/haruspex/node")];
        let mut killed_pids = Vec::new();
        let killed = sweep_entries(
            &entries,
            |_| Some("/usr/bin/firefox --new-window".to_string()),
            |pid| {
                killed_pids.push(pid);
                true
            },
        );
        assert!(killed.is_empty(), "the pid was reused by another program");
        assert!(
            killed_pids.is_empty(),
            "kill must not even be attempted on a non-match"
        );
    }

    #[test]
    fn a_matching_stale_pid_is_killed() {
        let entries = vec![entry("github", 4242, "/opt/haruspex/node")];
        let killed = sweep_entries(
            &entries,
            |_| Some("/opt/haruspex/node /srv/mcp/github/index.js stdio".to_string()),
            |_| true,
        );
        assert_eq!(killed, vec!["github"]);
    }

    #[test]
    fn a_pid_that_is_gone_is_not_reported_as_killed() {
        let entries = vec![entry("gone", 4242, "/opt/haruspex/node")];
        let killed = sweep_entries(&entries, |_| None, |_| true);
        assert!(killed.is_empty());
    }

    #[test]
    fn a_kill_that_fails_is_not_reported_as_killed() {
        let entries = vec![entry("stubborn", 4242, "/opt/haruspex/node")];
        let killed = sweep_entries(
            &entries,
            |_| Some("/opt/haruspex/node server.js".to_string()),
            |_| false,
        );
        assert!(
            killed.is_empty(),
            "reporting a kill that did not happen would hide the leak"
        );
    }

    #[test]
    fn sweep_visits_every_entry_rather_than_stopping_at_the_first_miss() {
        let entries = vec![
            entry("a", 1, "/opt/haruspex/node"),
            entry("b", 2, "/opt/haruspex/uv"),
            entry("c", 3, "/opt/haruspex/node"),
        ];
        let killed: HashSet<String> = sweep_entries(
            &entries,
            |pid| match pid {
                2 => Some("/usr/bin/something-else".to_string()),
                _ => Some("/opt/haruspex/node run.js".to_string()),
            },
            |_| true,
        )
        .into_iter()
        .collect();
        assert_eq!(killed, HashSet::from(["a".to_string(), "c".to_string()]));
    }

    #[test]
    fn an_empty_recorded_program_never_matches() {
        // A corrupt entry must not turn the sweep into a machine-wide kill.
        assert!(!command_matches("", Some("/usr/bin/anything")));
        assert!(!command_matches("", None));
    }

    #[test]
    fn command_matching_tolerates_arguments_and_separators() {
        let program = "/opt/haruspex/node";
        assert!(command_matches(
            program,
            Some("/opt/haruspex/node /srv/x.js stdio")
        ));
        assert!(command_matches(
            program,
            Some("\"/opt/haruspex/node\" \"/srv/x.js\"")
        ));
        assert!(!command_matches(
            program,
            Some("/usr/local/bin/node /srv/x.js")
        ));
        assert!(!command_matches(program, None));
    }

    #[test]
    fn registry_round_trips_and_survives_a_corrupt_file() {
        let path = temp_path("round_trip");
        assert!(
            load(&path).is_empty(),
            "a missing file is an empty registry"
        );

        let entries = vec![entry("a", 1, "/x/node"), entry("b", 2, "/x/uv")];
        save(&path, &entries).unwrap();
        assert_eq!(load(&path), entries);

        std::fs::write(&path, "{ not json").unwrap();
        assert!(
            load(&path).is_empty(),
            "a corrupt registry must not block startup"
        );
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn a_late_exit_does_not_forget_the_restarted_process() {
        // The old child's wait thread runs after the restart registered the
        // new pid under the same id.
        let path = temp_path("late_exit");
        save(&path, &[entry("sd-server", 2, "/x/sd-server")]).unwrap();
        deregister_pid(Some(&path), "sd-server", 1);
        assert_eq!(load(&path).len(), 1, "pid 1 is not the one recorded");
        deregister_pid(Some(&path), "sd-server", 2);
        assert!(load(&path).is_empty());
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn registering_the_same_id_twice_replaces_the_stale_pid() {
        // A restart reuses the server id. Keeping both would leave the sweep
        // chasing a pid that is no longer ours.
        let path = temp_path("replace");
        let mut entries = load(&path);
        entries.push(entry("github", 1, "/x/node"));
        save(&path, &entries).unwrap();

        let mut entries = load(&path);
        let fresh = entry("github", 2, "/x/node");
        entries.retain(|e| e.id != fresh.id);
        entries.push(fresh);
        save(&path, &entries).unwrap();

        let loaded = load(&path);
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].pid, 2);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }
}
