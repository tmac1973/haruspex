//! Small file helpers: atomic writes, for the stores that keep a file of their
//! own, and the owner-only variant for files that hold a secret.

use serde::Serialize;
use std::path::{Path, PathBuf};

/// Write `value` to `path` as JSON, atomically (see `write_atomic`). The error
/// names the path, for the caller to log.
pub fn save_json<T: Serialize + ?Sized>(
    path: &Path,
    value: &T,
    pretty: bool,
) -> Result<(), String> {
    let text = if pretty {
        serde_json::to_vec_pretty(value)
    } else {
        serde_json::to_vec(value)
    }
    .map_err(|e| format!("{}: {e}", path.display()))?;
    write_atomic(path, &text)
}

/// Write `bytes` to `path`: its folder is made first, and the file is written
/// beside it and renamed over it, so a crash never leaves half a file. The
/// temporary file is hidden (`.name.tmp`) and removed when the write fails.
/// The error names the path.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    write(path, bytes, false)
}

/// `write_atomic` for a file that holds a secret: readable by the owner only
/// on Unix (the file is created that way, so it is never briefly readable by
/// others), and synced to disk before the rename.
pub fn write_private_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    write(path, bytes, true)
}

fn write(path: &Path, bytes: &[u8], private: bool) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    let tmp = temp_path(path);
    let written = write_file(&tmp, bytes, private)
        .and_then(|()| std::fs::rename(&tmp, path))
        .map_err(|e| format!("{}: {e}", path.display()));
    if written.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    written
}

fn write_file(path: &Path, bytes: &[u8], private: bool) -> std::io::Result<()> {
    use std::io::Write;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    if private {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(path)?;
    f.write_all(bytes)?;
    if private {
        f.sync_all()?;
    }
    Ok(())
}

fn temp_path(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    path.with_file_name(format!(".{name}.tmp"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_into_a_new_folder_and_leaves_no_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a/b/state.json");
        save_json(&path, &serde_json::json!({ "x": 1 }), false).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), r#"{"x":1}"#);
        assert!(!temp_path(&path).exists());
        assert_eq!(
            std::fs::read_dir(path.parent().unwrap()).unwrap().count(),
            1
        );
    }

    #[test]
    fn names_the_path_when_it_cannot_write() {
        let dir = tempfile::tempdir().unwrap();
        // A file where the folder should be.
        let blocker = dir.path().join("blocker");
        std::fs::write(&blocker, "").unwrap();
        let err = save_json(&blocker.join("state.json"), &1, false).unwrap_err();
        assert!(err.contains("blocker"), "{err}");
    }

    #[test]
    fn replaces_an_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("SKILL.md");
        write_atomic(&path, b"old").unwrap();
        write_atomic(&path, b"new").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"new");
    }

    #[test]
    fn removes_the_temp_file_when_the_rename_fails() {
        let dir = tempfile::tempdir().unwrap();
        // A folder where the file should be: the write lands, the rename fails.
        let path = dir.path().join("taken");
        std::fs::create_dir(&path).unwrap();
        std::fs::write(path.join("inside"), "").unwrap();
        assert!(write_atomic(&path, b"x").is_err());
        assert!(!temp_path(&path).exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_private_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("secrets.bin");
        write_private_atomic(&path, b"k").unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        assert_eq!(std::fs::read(&path).unwrap(), b"k");
    }
}
