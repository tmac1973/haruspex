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
