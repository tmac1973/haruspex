//! Workdir-relative path resolution and directory listing.
//!
//! Every fs_* tool goes through `resolve_in_workdir` to keep callers
//! sandboxed to the active working directory. The doc-builders, sandbox
//! commands, and the python-lint helper all consume the same primitive.

use serde::Serialize;
use std::path::{Path, PathBuf};
use tokio::fs;

const MAX_DIR_ENTRIES: usize = 500;

#[derive(Serialize)]
pub struct DirEntry {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
}

#[derive(Serialize)]
pub struct DirListing {
    pub path: String,
    pub entries: Vec<DirEntry>,
    pub truncated: bool,
}

/// Resolve a relative path within a working directory, ensuring the result
/// does not escape the working directory via `..`, absolute paths, or
/// symlinks.
///
/// The relative path may refer to a file (or nested directories) that do not
/// yet exist (for write operations). In that case, the deepest existing
/// ancestor must canonicalize to a location inside the working dir, and the
/// non-existent tail is appended lexically after rejecting any traversal
/// components.
///
/// Returns an error if:
///   - `workdir` itself cannot be canonicalized
///   - The resolved path escapes the working directory
///   - The path is otherwise malformed
pub fn resolve_in_workdir(workdir: &Path, rel_path: &str) -> Result<PathBuf, String> {
    if rel_path.is_empty() || rel_path == "." {
        return workdir
            .canonicalize()
            .map_err(|e| format!("Failed to canonicalize working directory: {}", e));
    }

    let workdir_canonical = workdir
        .canonicalize()
        .map_err(|e| format!("Failed to canonicalize working directory: {}", e))?;

    // Treat the relative path as relative to the working dir even if it
    // starts with "/" — we reject absolute paths that would escape.
    let rel = Path::new(rel_path);
    if rel.is_absolute() {
        // Allow absolute paths only if they already point inside the workdir.
        let canonical = rel.canonicalize().or_else(|_| resolve_nonexistent(rel))?;
        if !canonical.starts_with(&workdir_canonical) {
            return Err("path escapes working directory".to_string());
        }
        return Ok(canonical);
    }

    let candidate = workdir_canonical.join(rel);
    let canonical = if candidate.exists() {
        candidate
            .canonicalize()
            .map_err(|e| format!("Failed to canonicalize path: {}", e))?
    } else {
        // For write operations: canonicalize the deepest existing ancestor,
        // then append the not-yet-existing tail. This prevents symlink
        // escape via a non-existent target while still allowing writes
        // into directories that will be created by the write itself.
        resolve_nonexistent(&candidate)?
    };

    if !canonical.starts_with(&workdir_canonical) {
        return Err("path escapes working directory".to_string());
    }

    Ok(canonical)
}

/// Resolve a path whose trailing components may not exist yet.
///
/// Walks up the ancestor chain to the deepest ancestor that exists on disk,
/// canonicalizes that (preserving the symlink-escape check — a symlinked
/// ancestor pointing outside the workdir resolves outside and fails the
/// caller's `starts_with` containment check), then appends the remaining
/// non-existent tail lexically. The tail must consist solely of normal
/// components: a `..` or `.` appended lexically would never be seen by
/// `canonicalize`, so traversal there is rejected outright.
fn resolve_nonexistent(candidate: &Path) -> Result<PathBuf, String> {
    use std::path::Component;

    // `ancestors()` yields the candidate itself first — skip it, we already
    // know it doesn't exist.
    let existing = candidate
        .ancestors()
        .skip(1)
        .find(|a| !a.as_os_str().is_empty() && a.exists())
        .ok_or_else(|| "path has no existing ancestor directory".to_string())?;

    let tail = candidate
        .strip_prefix(existing)
        .map_err(|_| "failed to derive non-existent path tail".to_string())?;
    for component in tail.components() {
        match component {
            Component::Normal(_) => {}
            _ => return Err("path escapes working directory".to_string()),
        }
    }

    let existing_canonical = existing
        .canonicalize()
        .map_err(|e| format!("Failed to canonicalize parent directory: {}", e))?;
    Ok(existing_canonical.join(tail))
}

/// Convert a workdir string passed across the IPC boundary into a
/// `PathBuf`, validating that it actually points at a directory.
/// Used as the first step in every fs_* read command — reads against a
/// missing workdir should fail loudly rather than conjure an empty dir.
pub(super) fn workdir_path(workdir: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(workdir);
    if !path.is_dir() {
        return Err(format!("Working directory does not exist: {}", workdir));
    }
    Ok(path)
}

/// Write-path variant of [`workdir_path`]: creates the working directory
/// (and any missing ancestors) instead of erroring when it doesn't exist
/// yet. A fresh chat's workdir is only materialized on first write, so
/// every fs_write_* / download command starts here.
pub(super) fn workdir_path_for_write(workdir: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(workdir);
    if !path.is_dir() {
        std::fs::create_dir_all(&path)
            .map_err(|e| format!("Failed to create working directory {}: {}", workdir, e))?;
    }
    Ok(path)
}

/// Defense-in-depth overwrite guard shared by every fs_write_* command.
///
/// The frontend is the primary enforcer here: it shows an interactive
/// "file exists, what do you want to do" modal before the tool call and
/// only invokes the write command with `overwrite=true` after the user
/// explicitly confirms. This Rust-side check is a safety net for the
/// case where the frontend path doesn't fire (a bug, a future refactor,
/// a new caller forgetting to wire it up). Kept deliberately simple —
/// no ambient "files written this turn" tracking on the Rust side; the
/// frontend handles that via its own per-turn Set.
///
/// When the file exists and `overwrite` is missing or false, returns a
/// structured error string the agent loop surfaces to the model as a
/// tool result. The message is phrased so the model understands it's
/// expected to stop and ask the user rather than silently retry with a
/// different name.
pub(super) fn refuse_if_exists(
    resolved: &Path,
    overwrite: Option<bool>,
    rel_path: &str,
) -> Result<(), String> {
    if overwrite.unwrap_or(false) {
        return Ok(());
    }
    if resolved.exists() {
        return Err(format!(
            "File already exists: {}. The user must confirm overwriting before you can replace it — stop and ask the user how they'd like to proceed (overwrite, use a different filename, or skip the write).",
            rel_path
        ));
    }
    Ok(())
}

/// Shared size caps for the fs_* tools, so the same number isn't redeclared
/// in every reader/writer module.
/// In-memory write payload cap (10 MB) — docx / odt / pdf / text writers.
pub(super) const MAX_WRITE_BYTES: usize = 10 * 1_048_576;
/// On-disk read cap for the heavier document readers (50 MB) — pdf / docx / xlsx.
pub(super) const MAX_DOC_READ_BYTES: u64 = 50 * 1_048_576;
/// On-disk read cap for plain-text reads (1 MB).
pub(super) const MAX_TEXT_READ_BYTES: u64 = 1_048_576;

/// Stat `resolved` and error if it exceeds `max` bytes. `fmt` names the
/// format in the message (e.g. "PDF" / "xlsx" / "docx"). The read-size guard
/// every document reader opens with.
pub(super) async fn stat_within_limit(resolved: &Path, max: u64, fmt: &str) -> Result<(), String> {
    let metadata = fs::metadata(resolved)
        .await
        .map_err(|e| format!("Failed to stat file: {}", e))?;
    if metadata.len() > max {
        return Err(format!(
            "{} too large ({} bytes). Maximum is {} bytes.",
            fmt,
            metadata.len(),
            max
        ));
    }
    Ok(())
}

/// Create the parent directory if needed, then write `bytes` to `resolved`.
/// The mkdir-then-write tail every document writer ends with.
pub(super) async fn write_bytes_to_workdir(resolved: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = resolved.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("Failed to create parent directory: {}", e))?;
        }
    }
    fs::write(resolved, bytes)
        .await
        .map_err(|e| format!("Failed to write file: {}", e))
}

#[tauri::command]
pub async fn fs_list_dir(workdir: String, rel_path: String) -> Result<DirListing, String> {
    let workdir = workdir_path(&workdir)?;
    let resolved = resolve_in_workdir(&workdir, &rel_path)?;

    if !resolved.is_dir() {
        return Err(format!("Not a directory: {}", rel_path));
    }

    let mut entries = Vec::new();
    let mut truncated = false;
    let mut read_dir = fs::read_dir(&resolved)
        .await
        .map_err(|e| format!("Failed to read directory: {}", e))?;

    while let Some(entry) = read_dir
        .next_entry()
        .await
        .map_err(|e| format!("Failed to read entry: {}", e))?
    {
        if entries.len() >= MAX_DIR_ENTRIES {
            truncated = true;
            break;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        // Skip hidden files and common noise
        if name.starts_with('.') {
            continue;
        }
        let metadata = match entry.metadata().await {
            Ok(m) => m,
            Err(_) => continue,
        };
        entries.push(DirEntry {
            name,
            is_dir: metadata.is_dir(),
            size: metadata.len(),
        });
    }

    // Sort: directories first, then alphabetical
    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    let display_path = resolved
        .strip_prefix(workdir.canonicalize().unwrap_or(workdir.clone()))
        .unwrap_or(&resolved)
        .to_string_lossy()
        .to_string();

    Ok(DirListing {
        path: if display_path.is_empty() {
            ".".to_string()
        } else {
            display_path
        },
        entries,
        truncated,
    })
}

/// Return whether a path inside the working directory currently exists.
/// Sandboxed via `resolve_in_workdir` like every other fs tool. Used by
/// the frontend to decide whether to show the file-conflict modal
/// before calling the actual write command — keeps the existence check
/// and the write as separate operations so the modal can show first
/// and the write can be skipped on cancel.
#[tauri::command]
pub async fn fs_path_exists(workdir: String, rel_path: String) -> Result<bool, String> {
    let workdir = workdir_path(&workdir)?;
    let resolved = resolve_in_workdir(&workdir, &rel_path)?;
    Ok(resolved.exists())
}

/// Given a desired relative path like "report.pdf", return the first
/// path in the sequence ["report.pdf", "report-2.pdf", "report-3.pdf",
/// ...] that doesn't currently exist in the working directory. If the
/// original path is already free, returns it unchanged. Used by the
/// file-conflict modal's "Keep both" option.
///
/// Cap: tries up to 1000 variants before giving up — if you've got
/// 1000 reports on the same filename, you have bigger problems than
/// this helper can solve.
#[tauri::command]
pub async fn fs_find_available_path(workdir: String, rel_path: String) -> Result<String, String> {
    let workdir = workdir_path(&workdir)?;

    // Quick path: the original name is free.
    let original = resolve_in_workdir(&workdir, &rel_path)?;
    if !original.exists() {
        return Ok(rel_path);
    }

    // Split "report.pdf" into ("report", ".pdf") so we can insert the
    // counter before the extension. Extension-less files get the
    // counter appended at the end.
    let path = std::path::Path::new(&rel_path);
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(&rel_path);
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .map(|e| format!(".{}", e))
        .unwrap_or_default();
    // Parent directory as a string, with trailing slash if present.
    let parent_prefix = path
        .parent()
        .and_then(|p| p.to_str())
        .filter(|p| !p.is_empty())
        .map(|p| format!("{}/", p))
        .unwrap_or_default();

    for n in 2..=1000 {
        let candidate = format!("{}{}-{}{}", parent_prefix, stem, n, ext);
        let resolved = resolve_in_workdir(&workdir, &candidate)?;
        if !resolved.exists() {
            return Ok(candidate);
        }
    }
    Err(format!(
        "Couldn't find an available filename after trying {} variants of {}",
        999, rel_path
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn make_temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("haruspex_fs_test_{}", name));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Shared workdir setup for the fs_find_available_path tests — we
    /// build a temp dir, synchronously seed it with existing files, and
    /// return the path. Each test does its own fs_find_available_path
    /// call (which is async) via a fresh tokio runtime.
    fn with_seeded_workdir<F>(name: &str, seed: &[&str], f: F)
    where
        F: FnOnce(PathBuf),
    {
        let dir = make_temp_dir(name);
        for seed_name in seed {
            fs::write(dir.join(seed_name), b"").unwrap();
        }
        f(dir.clone());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn resolves_simple_relative_path() {
        let dir = make_temp_dir("simple");
        fs::write(dir.join("hello.txt"), "hi").unwrap();
        let result = resolve_in_workdir(&dir, "hello.txt").unwrap();
        assert!(result.ends_with("hello.txt"));
        assert!(result.starts_with(dir.canonicalize().unwrap()));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn refuse_if_exists_blocks_existing_file_when_overwrite_false() {
        let dir = make_temp_dir("refuse_block");
        fs::write(dir.join("report.pdf"), b"old").unwrap();
        let resolved = resolve_in_workdir(&dir, "report.pdf").unwrap();
        assert!(refuse_if_exists(&resolved, None, "report.pdf").is_err());
        assert!(refuse_if_exists(&resolved, Some(false), "report.pdf").is_err());
        assert!(refuse_if_exists(&resolved, Some(true), "report.pdf").is_ok());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn refuse_if_exists_allows_nonexistent_file() {
        let dir = make_temp_dir("refuse_allow");
        let resolved = resolve_in_workdir(&dir, "new.pdf").unwrap();
        assert!(refuse_if_exists(&resolved, None, "new.pdf").is_ok());
        assert!(refuse_if_exists(&resolved, Some(false), "new.pdf").is_ok());
        assert!(refuse_if_exists(&resolved, Some(true), "new.pdf").is_ok());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn fs_find_available_path_returns_original_when_unused() {
        with_seeded_workdir("find_unused", &[], |dir| {
            let rt = tokio::runtime::Runtime::new().unwrap();
            let result = rt
                .block_on(fs_find_available_path(
                    dir.to_string_lossy().to_string(),
                    "report.pdf".to_string(),
                ))
                .unwrap();
            assert_eq!(result, "report.pdf");
        });
    }

    #[test]
    fn fs_find_available_path_single_conflict_returns_counter_2() {
        with_seeded_workdir("find_single", &["report.pdf"], |dir| {
            let rt = tokio::runtime::Runtime::new().unwrap();
            let result = rt
                .block_on(fs_find_available_path(
                    dir.to_string_lossy().to_string(),
                    "report.pdf".to_string(),
                ))
                .unwrap();
            assert_eq!(result, "report-2.pdf");
        });
    }

    #[test]
    fn fs_find_available_path_chain_of_conflicts_increments() {
        with_seeded_workdir(
            "find_chain",
            &["report.pdf", "report-2.pdf", "report-3.pdf", "report-4.pdf"],
            |dir| {
                let rt = tokio::runtime::Runtime::new().unwrap();
                let result = rt
                    .block_on(fs_find_available_path(
                        dir.to_string_lossy().to_string(),
                        "report.pdf".to_string(),
                    ))
                    .unwrap();
                assert_eq!(result, "report-5.pdf");
            },
        );
    }

    #[test]
    fn fs_find_available_path_handles_extensionless_files() {
        with_seeded_workdir("find_noext", &["Makefile"], |dir| {
            let rt = tokio::runtime::Runtime::new().unwrap();
            let result = rt
                .block_on(fs_find_available_path(
                    dir.to_string_lossy().to_string(),
                    "Makefile".to_string(),
                ))
                .unwrap();
            assert_eq!(result, "Makefile-2");
        });
    }

    #[test]
    fn fs_path_exists_distinguishes_present_and_absent() {
        with_seeded_workdir("path_exists", &["present.txt"], |dir| {
            let rt = tokio::runtime::Runtime::new().unwrap();
            let present = rt
                .block_on(fs_path_exists(
                    dir.to_string_lossy().to_string(),
                    "present.txt".to_string(),
                ))
                .unwrap();
            assert!(present);
            let absent = rt
                .block_on(fs_path_exists(
                    dir.to_string_lossy().to_string(),
                    "absent.txt".to_string(),
                ))
                .unwrap();
            assert!(!absent);
        });
    }

    #[test]
    fn resolves_nested_path() {
        let dir = make_temp_dir("nested");
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::write(dir.join("sub/file.txt"), "x").unwrap();
        let result = resolve_in_workdir(&dir, "sub/file.txt").unwrap();
        assert!(result.ends_with("file.txt"));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn resolves_nonexistent_file_for_write() {
        let dir = make_temp_dir("write");
        let result = resolve_in_workdir(&dir, "new_file.txt").unwrap();
        assert!(result.ends_with("new_file.txt"));
        assert!(result.starts_with(dir.canonicalize().unwrap()));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_parent_dir_escape() {
        let dir = make_temp_dir("escape");
        let result = resolve_in_workdir(&dir, "../escaped.txt");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("escapes"));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_deep_parent_dir_escape() {
        let dir = make_temp_dir("deep_escape");
        let result = resolve_in_workdir(&dir, "sub/../../escaped.txt");
        assert!(result.is_err());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_absolute_path_outside() {
        let dir = make_temp_dir("abs");
        let result = resolve_in_workdir(&dir, "/etc/passwd");
        assert!(result.is_err());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn resolves_nonexistent_parent_for_write() {
        // "output/report.pdf" with no output/ dir yet must resolve — the
        // write itself creates the directory via write_bytes_to_workdir.
        let dir = make_temp_dir("nonparent");
        let result = resolve_in_workdir(&dir, "output/report.pdf").unwrap();
        assert!(result.starts_with(dir.canonicalize().unwrap()));
        assert!(result.ends_with("output/report.pdf"));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn resolves_deep_nonexistent_tail_for_write() {
        let dir = make_temp_dir("deep_tail");
        let result = resolve_in_workdir(&dir, "a/b/c/f.txt").unwrap();
        assert!(result.starts_with(dir.canonicalize().unwrap()));
        assert!(result.ends_with("a/b/c/f.txt"));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_dotdot_in_nonexistent_tail() {
        // Lexical `..` traversal inside a not-yet-existing tail must not
        // be smuggled past the canonicalize-based escape check.
        let dir = make_temp_dir("tail_dotdot");
        let result = resolve_in_workdir(&dir, "nope/../../escape.txt");
        assert!(result.is_err());
        let result = resolve_in_workdir(&dir, "nope/../inside.txt");
        assert!(result.is_err());
        fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn write_bytes_creates_missing_parent_dirs() {
        let dir = make_temp_dir("write_creates_dirs");
        let resolved = resolve_in_workdir(&dir, "output/report.txt").unwrap();
        write_bytes_to_workdir(&resolved, b"hello").await.unwrap();
        assert_eq!(fs::read(dir.join("output/report.txt")).unwrap(), b"hello");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn workdir_path_for_write_creates_missing_workdir() {
        let dir = std::env::temp_dir().join("haruspex_fs_test_missing_wd");
        let _ = fs::remove_dir_all(&dir);
        assert!(!dir.exists());
        let result = workdir_path_for_write(&dir.to_string_lossy()).unwrap();
        assert!(result.is_dir());
        // Read-side helper must still refuse a missing workdir.
        fs::remove_dir_all(&dir).ok();
        assert!(workdir_path(&dir.to_string_lossy()).is_err());
    }

    #[test]
    fn empty_path_returns_workdir() {
        let dir = make_temp_dir("empty");
        let result = resolve_in_workdir(&dir, "").unwrap();
        assert_eq!(result, dir.canonicalize().unwrap());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn dot_path_returns_workdir() {
        let dir = make_temp_dir("dot");
        let result = resolve_in_workdir(&dir, ".").unwrap();
        assert_eq!(result, dir.canonicalize().unwrap());
        fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_escape() {
        use std::os::unix::fs::symlink;
        let dir = make_temp_dir("symlink");
        let outside = std::env::temp_dir().join("haruspex_fs_test_outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.txt"), "secret").unwrap();
        symlink(&outside, dir.join("link")).unwrap();
        let result = resolve_in_workdir(&dir, "link/secret.txt");
        assert!(result.is_err(), "symlink escape was not caught");
        fs::remove_dir_all(&dir).ok();
        fs::remove_dir_all(&outside).ok();
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_escape_with_nonexistent_tail() {
        // A symlinked EXISTING ancestor pointing outside the workdir must
        // still be rejected when the tail doesn't exist yet (write path).
        use std::os::unix::fs::symlink;
        let dir = make_temp_dir("symlink_tail");
        let outside = std::env::temp_dir().join("haruspex_fs_test_outside_tail");
        fs::create_dir_all(&outside).unwrap();
        symlink(&outside, dir.join("link")).unwrap();
        let result = resolve_in_workdir(&dir, "link/new_file.txt");
        assert!(result.is_err(), "symlinked-ancestor escape was not caught");
        let result = resolve_in_workdir(&dir, "link/sub/new_file.txt");
        assert!(
            result.is_err(),
            "deep symlinked-ancestor escape was not caught"
        );
        fs::remove_dir_all(&dir).ok();
        fs::remove_dir_all(&outside).ok();
    }
}
