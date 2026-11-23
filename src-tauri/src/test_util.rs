//! Helpers shared by the unit tests.

use std::ops::Deref;
use std::path::{Path, PathBuf};

/// A scratch directory unique to one test, removed when it drops.
///
/// `tempfile` picks the name, so two `cargo test` runs at once (one per git
/// worktree) never share a directory and none pile up in the system temp dir.
/// It derefs to its path, so a test uses it where it would use a `PathBuf`;
/// keep it alive for as long as the directory is needed.
pub struct TestDir {
    path: PathBuf,
    _dir: tempfile::TempDir,
}

/// Make a fresh, empty directory; `name` only labels it for a human looking
/// in the temp dir. The path is canonical (no `/tmp` → `/private/tmp` symlink
/// on macOS, no `\\?\` on Windows) because many tests compare it with paths
/// the code under test has canonicalised.
pub fn temp_dir(name: &str) -> TestDir {
    let dir = tempfile::Builder::new()
        .prefix(&format!("haruspex_{name}_"))
        .tempdir()
        .unwrap();
    let path = crate::fs_tools::path::strip_verbatim(&dir.path().canonicalize().unwrap());
    TestDir { path, _dir: dir }
}

impl Deref for TestDir {
    type Target = PathBuf;

    fn deref(&self) -> &PathBuf {
        &self.path
    }
}

impl AsRef<Path> for TestDir {
    fn as_ref(&self) -> &Path {
        &self.path
    }
}

/// For APIs that take `impl Into<PathBuf>`.
impl From<&TestDir> for PathBuf {
    fn from(dir: &TestDir) -> PathBuf {
        dir.path.clone()
    }
}

/// A system program for a test to run, cleaned of an AppImage's environment
/// as the app's own spawns are, so the real-tool tests can run inside one.
pub fn host_command(program: &str) -> std::process::Command {
    let mut cmd = std::process::Command::new(program);
    crate::env_util::sanitize_appimage_env(&mut cmd);
    cmd
}

/// Whether `program` is on PATH and answers `-version`, for a real-tool test
/// to skip on a machine without it (the Windows and macOS runners have no
/// ffmpeg).
pub fn host_has(program: &str) -> bool {
    host_command(program)
        .arg("-version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}
