//! The file handling `image_cache` and `audio_cache` share: a folder of files
//! named by the sha256 of their bytes, next to a database table that says
//! which of them the app still knows about.
//!
//! Each cache keeps its own table, its own types and its own policy on what
//! to evict; this is only the part that touches the folder.

use log::warn;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// `<app_data_dir>/<folder>/`, created if absent. `what` names the cache in
/// errors ("image", "audio").
pub fn cache_dir(app: &AppHandle, folder: &str, what: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {}", e))?
        .join(folder);
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create {what} cache dir: {}", e))?;
    Ok(dir)
}

/// Exactly 64 lowercase hex characters.
///
/// This is the path-traversal guard for both caches. Because a hash is
/// checked for shape before it is ever joined to the cache directory, `..`,
/// absolute paths and separators cannot be expressed — the protocol handlers
/// rely on this, so keep it strict.
pub fn is_valid_hash(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub fn hash_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    crate::hash_util::hex(&hasher.finalize())
}

/// `<dir>/<hash>` when `hash` is well formed and `has_row` says the cache
/// holds it. The shape check runs first, so `has_row` never sees a path.
pub fn find(
    dir: &Path,
    hash: &str,
    has_row: impl FnOnce(&str) -> Result<bool, String>,
) -> Result<Option<PathBuf>, String> {
    if !is_valid_hash(hash) || !has_row(hash)? {
        return Ok(None);
    }
    Ok(Some(dir.join(hash)))
}

/// Copy a cached file to `to`, the file the user chose in a Save as dialog
/// (which asked about replacing a file already). `what` names it in the
/// error ("picture", "song").
pub fn save_as(from: &Path, to: &Path, what: &str) -> Result<(), String> {
    std::fs::copy(from, to)
        .map(|_| ())
        .map_err(|e| format!("Could not save the {what} to {}: {e}", to.display()))
}

/// Delete the files for `hashes`. One already gone is fine; any other
/// failure is logged and skipped, since its row goes either way.
pub fn remove_files(dir: &Path, hashes: &[String], what: &str) {
    for hash in hashes {
        if let Err(e) = std::fs::remove_file(dir.join(hash)) {
            if e.kind() != std::io::ErrorKind::NotFound {
                warn!("failed to remove cached {what} {}: {}", hash, e);
            }
        }
    }
}

/// Delete every file in `dir` that isn't one of `known`: leftovers from a
/// crash between the write and the insert, abandoned `.part` files, or a
/// database reset. Nothing will ever read them.
pub fn remove_strays(dir: &Path, known: &[String], what: &str) {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) => {
            warn!("could not scan {what} cache dir: {}", e);
            return;
        }
    };
    let known: HashSet<&str> = known.iter().map(String::as_str).collect();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !(is_valid_hash(&name) && known.contains(name.as_str())) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_util::temp_dir;

    fn names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn hash_validation_rejects_traversal_and_wrong_shapes() {
        let good = "a".repeat(64);
        assert!(is_valid_hash(&good));
        assert!(is_valid_hash(&"0123456789abcdef".repeat(4)));

        assert!(!is_valid_hash("../../etc/passwd"));
        assert!(
            !is_valid_hash(&"A".repeat(64)),
            "uppercase is not our shape"
        );
        assert!(!is_valid_hash(&"a".repeat(63)));
        assert!(!is_valid_hash(&"a".repeat(65)));
        assert!(!is_valid_hash(""));
        assert!(!is_valid_hash(&format!("{}/", "a".repeat(63))));
        assert!(!is_valid_hash(&"g".repeat(64)), "g is not hex");
    }

    #[test]
    fn identical_bytes_hash_identically() {
        assert_eq!(hash_bytes(b"same"), hash_bytes(b"same"));
        assert_ne!(hash_bytes(b"same"), hash_bytes(b"different"));
        assert_eq!(hash_bytes(b"x").len(), 64);
    }

    #[test]
    fn strays_go_and_known_files_stay() {
        let dir = temp_dir("blob-strays");
        let (kept, unknown) = (hash_bytes(b"kept"), hash_bytes(b"unknown"));
        for name in [kept.as_str(), unknown.as_str(), "leftover.part", "notes"] {
            std::fs::write(dir.join(name), b"x").unwrap();
        }
        remove_strays(&dir, std::slice::from_ref(&kept), "test");
        assert_eq!(names(&dir), vec![kept]);
    }

    #[test]
    fn a_missing_folder_is_not_a_failure() {
        let dir = temp_dir("blob-missing-dir");
        remove_strays(&dir.join("absent"), &[], "test");
    }

    #[test]
    fn removing_a_file_already_gone_is_fine() {
        let dir = temp_dir("blob-remove");
        let (here, gone) = (hash_bytes(b"here"), hash_bytes(b"gone"));
        std::fs::write(dir.join(&here), b"x").unwrap();
        remove_files(&dir, &[gone, here], "test");
        assert!(names(&dir).is_empty());
    }

    #[test]
    fn find_checks_the_shape_before_asking_for_a_row() {
        let dir = temp_dir("blob-find");
        let hash = hash_bytes(b"x");
        let found = find(&dir, &hash, |_| Ok(true)).unwrap();
        assert_eq!(found, Some(dir.join(&hash)));
        assert_eq!(find(&dir, &hash, |_| Ok(false)).unwrap(), None);
        let asked = find(&dir, "../x", |_| panic!("asked about a path")).unwrap();
        assert_eq!(asked, None);
    }

    #[test]
    fn save_as_copies_and_names_what_failed() {
        let dir = temp_dir("blob-save-as");
        let from = dir.join(hash_bytes(b"song"));
        std::fs::write(&from, b"song").unwrap();
        save_as(&from, &dir.join("out.mp3"), "song").unwrap();
        assert_eq!(std::fs::read(dir.join("out.mp3")).unwrap(), b"song");
        let err = save_as(&dir.join("absent"), &dir.join("x"), "song").unwrap_err();
        assert!(err.starts_with("Could not save the song to "), "{err}");
    }
}
