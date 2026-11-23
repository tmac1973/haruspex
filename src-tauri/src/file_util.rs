//! Small file helpers shared by the stores that keep a JSON file of their own.

use serde::Serialize;
use std::path::Path;

/// Write `value` to `path` as JSON: its folder is made first, and the file is
/// written beside it and renamed over it, so a crash never leaves half a file.
/// The error names the path, for the caller to log.
pub fn save_json<T: Serialize + ?Sized>(
    path: &Path,
    value: &T,
    pretty: bool,
) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    let text = if pretty {
        serde_json::to_string_pretty(value)
    } else {
        serde_json::to_string(value)
    }
    .map_err(|e| format!("{}: {e}", path.display()))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| format!("{}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("{}: {e}", path.display()))
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
        assert!(!path.with_extension("json.tmp").exists());
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
}
