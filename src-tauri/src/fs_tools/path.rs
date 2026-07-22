//! Workdir-relative path resolution and directory listing.
//!
//! Every fs_* tool goes through `resolve_in_workdir` to keep callers
//! sandboxed to the active working directory. The doc-builders, sandbox
//! commands, and the python-lint helper all consume the same primitive.

use super::fuzzy::{apply_edit, EditResult};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::fs;

const MAX_DIR_ENTRIES: usize = 500;

/// Distinguishes concurrent writes racing on the same target within one
/// process. Not a determinism device — `cargo test` runs tests in parallel
/// threads, so the value depends on scheduling; tests assert that no temp
/// file *remains*, never that a particular name was used.
static TMP_WRITE_SEQ: AtomicU64 = AtomicU64::new(0);

/// Prefix for staged temp files. Callers that list a directory filter on this
/// so a write in flight is never mistaken for user content.
pub(super) const TMP_WRITE_PREFIX: &str = ".haruspex-";
pub(super) const TMP_WRITE_SUFFIX: &str = ".tmp";

/// True for a temp file staged by [`write_atomic`] — a write in progress, not
/// something the user put there.
pub(super) fn is_staged_tmp_name(name: &str) -> bool {
    name.starts_with(TMP_WRITE_PREFIX) && name.ends_with(TMP_WRITE_SUFFIX)
}

/// Write `bytes` to `target` atomically: stage them in a sibling temp file,
/// then rename over the target.
///
/// A bare `fs::write` is `File::create` (O_TRUNC) followed by `write_all`, so
/// the target is emptied the instant the write begins and a write that fails
/// partway destroys the previously-good file. Staging and renaming means the
/// target either has its old contents or its new ones, never a prefix.
///
/// The temp file is a *sibling* so the rename stays within one filesystem and
/// is therefore atomic; a temp in /tmp would make it a cross-device copy and
/// lose the guarantee.
///
/// Deliberately no `fsync`: the threat here is a failed write, not power loss,
/// and syncing the temp plus the parent directory costs a syscall round-trip
/// on every write in a run that writes many files.
pub(super) async fn write_atomic(target: &Path, bytes: &[u8]) -> Result<(), String> {
    // `rename` needs write permission on the DIRECTORY, not on the target, so
    // it will happily replace a read-only file that a direct `fs::write` would
    // have refused. Preserve the old refusal: a read-only file is the user
    // saying "don't change this", and a write tool driven by a model should not
    // quietly acquire the power to ignore that.
    if let Ok(meta) = fs::metadata(target).await {
        if meta.permissions().readonly() {
            return Err(format!(
                "Failed to write file: {} is read-only",
                target.display()
            ));
        }
    }

    let parent = target.parent().unwrap_or_else(|| Path::new("."));
    let stem = target
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unnamed");
    let seq = TMP_WRITE_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = parent.join(format!(
        "{}{}-{}{}",
        TMP_WRITE_PREFIX, stem, seq, TMP_WRITE_SUFFIX
    ));

    if let Err(e) = fs::write(&tmp, bytes).await {
        // Best-effort cleanup; report the original failure, not the cleanup's.
        let _ = fs::remove_file(&tmp).await;
        return Err(format!("Failed to write file: {}", e));
    }
    if let Err(e) = fs::rename(&tmp, target).await {
        let _ = fs::remove_file(&tmp).await;
        return Err(format!("Failed to write file: {}", e));
    }
    Ok(())
}

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

    // Reject `..` traversal lexically, before any canonicalization, splitting on
    // BOTH separators. Path::components() can't be trusted to surface `..` on
    // Windows: canonicalize() yields a verbatim \\?\ path, and a forward-slash
    // tail joined onto it doesn't normalize the way it does on Unix, so a `..`
    // can hide inside what Rust treats as a single component (e.g. the
    // workdir-internal "nope/../inside.txt" slipped past the component check).
    // A raw-string scan is platform-independent and strictly safer.
    if rel_path.split(['/', '\\']).any(|seg| seg == "..") {
        return Err("path escapes working directory".to_string());
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
pub(crate) fn workdir_path(workdir: &str) -> Result<PathBuf, String> {
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
/// Hard ceiling on bytes pulled into memory for a *windowed* text read.
/// Above this we refuse rather than truncate — loading the whole file would
/// itself be the problem. Generous enough for any real source file.
pub(super) const MAX_READ_LOAD_BYTES: u64 = 64 * 1_048_576;
/// Lines returned when the caller passes no `limit`.
const DEFAULT_READ_LINES: usize = 2000;
/// Per-call output budget; a single returned window is head-truncated past this.
const MAX_READ_OUTPUT_BYTES: usize = 256 * 1024;

/// Shared body for the text readers (`fs_read_text` / `fs_read_text_absolute`):
/// binary-check, UTF-8 decode, then apply optional 1-indexed `offset` + `limit`
/// line windowing with a head-truncation fallback. Returns text the model can
/// always consume — never an out-of-band "file too large" error within the
/// load ceiling. `binary_msg` is the format-specific rejection for binary input.
pub(super) fn render_text_read(
    bytes: Vec<u8>,
    offset: Option<u32>,
    limit: Option<u32>,
    binary_msg: &str,
) -> Result<String, String> {
    let sample_len = bytes.len().min(8192);
    if bytes[..sample_len].contains(&0) {
        return Err(binary_msg.to_string());
    }
    let content =
        String::from_utf8(bytes).map_err(|e| format!("File is not valid UTF-8: {}", e))?;

    let lines: Vec<&str> = content.lines().collect();
    let total = lines.len();
    let start = offset.map(|o| (o.max(1) as usize) - 1).unwrap_or(0);
    if total > 0 && start >= total {
        return Err(format!(
            "offset {} is past the end of the file ({} lines).",
            start + 1,
            total
        ));
    }
    let count = limit
        .map(|l| (l as usize).max(1))
        .unwrap_or(DEFAULT_READ_LINES);
    let end = start.saturating_add(count).min(total);

    let mut out = lines[start..end].join("\n");

    // Per-call byte budget guards a pathologically long single line / window.
    if out.len() > MAX_READ_OUTPUT_BYTES {
        let mut cut = MAX_READ_OUTPUT_BYTES;
        while cut > 0 && !out.is_char_boundary(cut) {
            cut -= 1;
        }
        out.truncate(cut);
        out.push_str(&format!(
            "\n… (output truncated at {} KB — narrow the range with offset/limit)",
            MAX_READ_OUTPUT_BYTES / 1024
        ));
    } else if end < total {
        let more = total - end;
        out.push_str(&format!(
            "\n… (truncated; {} more line{} — use offset/limit to read further)",
            more,
            if more == 1 { "" } else { "s" }
        ));
    }

    Ok(out)
}

/// Shared command body for the text readers (`fs_read_text` /
/// `fs_read_text_absolute`) after path resolution: stat against the load
/// ceiling, read the bytes, then render via [`render_text_read`].
/// `binary_msg` is the variant-specific rejection for binary input — the
/// workdir and absolute commands suggest different format-specific tools.
pub(super) async fn read_text_at(
    resolved: &Path,
    offset: Option<u32>,
    limit: Option<u32>,
    binary_msg: &str,
) -> Result<String, String> {
    let metadata = fs::metadata(resolved)
        .await
        .map_err(|e| format!("Failed to stat file: {}", e))?;

    if metadata.len() > MAX_READ_LOAD_BYTES {
        return Err(format!(
            "File too large to load ({} bytes, max {} MB). Read it in slices with the offset/limit parameters or via the shell (head/sed).",
            metadata.len(),
            MAX_READ_LOAD_BYTES / 1_048_576
        ));
    }

    let bytes = fs::read(resolved)
        .await
        .map_err(|e| format!("Failed to read file: {}", e))?;

    render_text_read(bytes, offset, limit, binary_msg)
}

/// Full-fidelity text read: exact file content, no line windowing and no
/// truncation marker. For RUNNER-owned read-modify-write files (TODO/PROGRESS
/// bookkeeping) and validation gates that must see the true end of a file —
/// a windowed read would make tail truncation invisible by construction, and
/// rewriting a windowed read back to disk destroys the tail. Model-facing
/// reads stay on [`read_text_at`]'s windowing.
pub(super) async fn read_text_full_at(resolved: &Path) -> Result<String, String> {
    let metadata = fs::metadata(resolved)
        .await
        .map_err(|e| format!("Failed to stat file: {}", e))?;

    if metadata.len() > MAX_READ_LOAD_BYTES {
        return Err(format!(
            "File too large to load ({} bytes, max {} MB).",
            metadata.len(),
            MAX_READ_LOAD_BYTES / 1_048_576
        ));
    }

    fs::read_to_string(resolved)
        .await
        .map_err(|e| format!("Failed to read file: {}", e))
}

/// Shared command body for the text editors (`fs_edit_text` /
/// `fs_edit_text_absolute`) after path resolution: stat against the edit
/// cap, read, apply the fuzzy find-and-replace, and write back. `display`
/// is the caller-facing path used in `apply_edit`'s error messages
/// (workdir-relative for the chat tools, absolute for the shell tools).
pub(super) async fn edit_text_at(
    resolved: &Path,
    old_str: &str,
    new_str: &str,
    display: &str,
) -> Result<EditResult, String> {
    let metadata = fs::metadata(resolved)
        .await
        .map_err(|e| format!("Failed to stat file: {}", e))?;

    if metadata.len() > MAX_TEXT_READ_BYTES {
        return Err(format!(
            "File too large to edit ({} bytes). Maximum is {} bytes.",
            metadata.len(),
            MAX_TEXT_READ_BYTES
        ));
    }

    let content = fs::read_to_string(resolved)
        .await
        .map_err(|e| format!("Failed to read file: {}", e))?;

    let outcome = apply_edit(&content, old_str, new_str, display)?;
    // Read-modify-write: an interrupted write here destroys the original just
    // as badly as a fresh write would.
    write_atomic(resolved, outcome.new_content.as_bytes()).await?;
    Ok(outcome.result)
}

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
///
/// Shared by every writer in this module (text, pdf, docx, xlsx, odt, pptx,
/// odp), so the atomicity guarantee in [`write_atomic`] reaches all of them.
pub(super) async fn write_bytes_to_workdir(resolved: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = resolved.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("Failed to create parent directory: {}", e))?;
        }
    }
    write_atomic(resolved, bytes).await
}

/// Read a directory's immediate children into `DirEntry`s sorted directories-
/// first then case-insensitive by name, capped at [`MAX_DIR_ENTRIES`]. Returns
/// the entries plus whether the cap truncated the listing. `include_hidden`
/// controls dotfiles: the workdir listing hides them as noise; the absolute
/// listing surfaces them since admin troubleshooting often needs `.ssh` etc.
pub(super) async fn collect_dir_entries(
    resolved: &Path,
    include_hidden: bool,
) -> Result<(Vec<DirEntry>, bool), String> {
    let mut entries = Vec::new();
    let mut truncated = false;
    let mut read_dir = fs::read_dir(resolved)
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
        if !include_hidden && name.starts_with('.') {
            continue;
        }
        // A write staged by `write_atomic` and not yet renamed. Never user
        // content, and it vanishes moments later — reporting it would be
        // misleading. Note this is narrower than hiding all dotfiles: the
        // absolute listing deliberately surfaces those (.ssh and friends).
        if is_staged_tmp_name(&name) {
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

    // Sort: directories first, then alphabetical.
    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok((entries, truncated))
}

#[tauri::command]
pub async fn fs_list_dir(workdir: String, rel_path: String) -> Result<DirListing, String> {
    let workdir = workdir_path(&workdir)?;
    let resolved = resolve_in_workdir(&workdir, &rel_path)?;

    if !resolved.is_dir() {
        return Err(format!("Not a directory: {}", rel_path));
    }

    let (entries, truncated) = collect_dir_entries(&resolved, false).await?;

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

    #[test]
    fn render_read_returns_whole_small_file() {
        let out = render_text_read(b"a\nb\nc\n".to_vec(), None, None, "bin").unwrap();
        assert_eq!(out, "a\nb\nc");
    }

    #[test]
    fn render_read_windows_with_offset_and_limit() {
        let body = (1..=10)
            .map(|n| format!("line{n}"))
            .collect::<Vec<_>>()
            .join("\n");
        // offset=3 (1-indexed), limit=2 → lines 3 and 4.
        let out = render_text_read(body.into_bytes(), Some(3), Some(2), "bin").unwrap();
        assert!(out.starts_with("line3\nline4"));
        assert!(out.contains("more line"), "expected truncation note: {out}");
    }

    #[test]
    fn render_read_marks_truncation_without_erroring() {
        // 2001 lines, no limit → DEFAULT_READ_LINES (2000) returned + marker.
        let body = (1..=2001)
            .map(|n| n.to_string())
            .collect::<Vec<_>>()
            .join("\n");
        let out = render_text_read(body.into_bytes(), None, None, "bin").unwrap();
        assert!(
            out.contains("1 more line — use offset/limit"),
            "got tail: {}",
            &out[out.len().saturating_sub(80)..]
        );
    }

    #[test]
    fn read_text_full_round_trips_past_the_window_defaults() {
        // A file longer than DEFAULT_READ_LINES and MAX_READ_OUTPUT_BYTES must
        // come back byte-identical — this is the runner's read-modify-write
        // path, where a truncated read rewritten to disk destroys the tail.
        let dir = make_temp_dir("read_full");
        let body = (1..=3000)
            .map(|n| format!("entry {n}: {}", "x".repeat(100)))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(body.len() > MAX_READ_OUTPUT_BYTES);
        let file = dir.join("PROGRESS.md");
        fs::write(&file, &body).unwrap();
        let out = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(read_text_full_at(&file))
            .unwrap();
        assert_eq!(out, body);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn render_read_rejects_binary() {
        let err = render_text_read(b"abc\0def".to_vec(), None, None, "BINARY-MSG").unwrap_err();
        assert_eq!(err, "BINARY-MSG");
    }

    #[test]
    fn render_read_offset_past_end_errors() {
        let err = render_text_read(b"a\nb\n".to_vec(), Some(99), None, "bin").unwrap_err();
        assert!(err.contains("past the end"), "got: {err}");
    }

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
    async fn write_replaces_an_existing_file_exactly() {
        let dir = make_temp_dir("write_replaces");
        let resolved = resolve_in_workdir(&dir, "a.txt").unwrap();
        write_bytes_to_workdir(&resolved, b"old contents")
            .await
            .unwrap();
        write_bytes_to_workdir(&resolved, b"new").await.unwrap();
        assert_eq!(fs::read(dir.join("a.txt")).unwrap(), b"new");
        fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn failed_write_cleans_up_and_touches_nothing_else() {
        // NOTE ON WHAT THIS DOES AND DOESN'T PROVE. The guarantee we want is
        // "a write that fails partway leaves the target's old contents", which
        // a bare fs::write violates because File::create(O_TRUNC) empties the
        // target before any new bytes land. Forcing a genuine mid-write failure
        // needs a full disk or a signal, so it isn't portably unit-testable —
        // this test does NOT discriminate against the old implementation.
        //
        // What it does pin down: the failure path cleans up its staged temp and
        // leaves unrelated files alone. The atomicity itself rests on rename(2)
        // being atomic within a filesystem, which is why the temp is a sibling.
        let dir = make_temp_dir("write_atomic_fail");
        let good = dir.join("keep.txt");
        fs::write(&good, b"precious").unwrap();

        // Renaming a file over a non-empty directory fails on every platform
        // we support.
        let blocked = dir.join("blocked");
        fs::create_dir(&blocked).unwrap();
        fs::write(blocked.join("child"), b"x").unwrap();
        let err = write_atomic(&blocked, b"replacement").await;
        assert!(err.is_err(), "write over a non-empty dir must fail");

        // The unrelated good file is untouched, and no staged temp is left.
        assert_eq!(fs::read(&good).unwrap(), b"precious");
        assert!(
            !has_staged_tmp(&dir),
            "temp file must be cleaned up on failure"
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn successful_write_leaves_no_temp_file_behind() {
        let dir = make_temp_dir("write_atomic_clean");
        let resolved = resolve_in_workdir(&dir, "out.txt").unwrap();
        write_bytes_to_workdir(&resolved, b"content").await.unwrap();
        assert!(!has_staged_tmp(&dir));
        fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn concurrent_writes_to_different_paths_do_not_collide() {
        let dir = make_temp_dir("write_atomic_concurrent");
        let a = resolve_in_workdir(&dir, "a.txt").unwrap();
        let b = resolve_in_workdir(&dir, "b.txt").unwrap();
        let (ra, rb) = tokio::join!(
            write_bytes_to_workdir(&a, b"aaa"),
            write_bytes_to_workdir(&b, b"bbb")
        );
        ra.unwrap();
        rb.unwrap();
        assert_eq!(fs::read(dir.join("a.txt")).unwrap(), b"aaa");
        assert_eq!(fs::read(dir.join("b.txt")).unwrap(), b"bbb");
        assert!(!has_staged_tmp(&dir));
        fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn staged_temp_files_are_hidden_from_directory_listings() {
        // A write in flight must never be reported as user content — not even
        // by the absolute listing, which deliberately shows dotfiles.
        let dir = make_temp_dir("write_atomic_listing");
        fs::write(dir.join(".haruspex-out.txt-7.tmp"), b"staged").unwrap();
        fs::write(dir.join(".sshconfig"), b"real dotfile").unwrap();
        let (entries, _) = collect_dir_entries(&dir, true).await.unwrap();
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert!(!names.contains(&".haruspex-out.txt-7.tmp"));
        assert!(
            names.contains(&".sshconfig"),
            "real dotfiles must still show"
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn refuses_to_replace_a_read_only_file() {
        // rename(2) only needs write permission on the directory, so without an
        // explicit guard the atomic path would replace a read-only file that a
        // direct fs::write refuses. Preserve the refusal.
        let dir = make_temp_dir("write_atomic_readonly");
        let target = dir.join("locked.txt");
        fs::write(&target, b"precious").unwrap();
        let mut perms = fs::metadata(&target).unwrap().permissions();
        perms.set_readonly(true);
        fs::set_permissions(&target, perms).unwrap();

        let result = write_atomic(&target, b"clobber").await;
        assert!(result.is_err(), "read-only target must not be replaced");
        assert!(result.unwrap_err().contains("read-only"));
        assert_eq!(fs::read(&target).unwrap(), b"precious");
        assert!(
            !has_staged_tmp(&dir),
            "no temp should be staged for a refused write"
        );

        // Removing a read-only file needs write permission on the DIRECTORY,
        // which we have — no need to clear the bit first (and clearing it via
        // set_readonly(false) would chmod 0o777 on Unix).
        fs::remove_dir_all(&dir).ok();
    }

    /// True if any staged `write_atomic` temp file is still sitting in `dir`.
    fn has_staged_tmp(dir: &Path) -> bool {
        fs::read_dir(dir).unwrap().any(|e| {
            let name = e.unwrap().file_name().to_string_lossy().to_string();
            is_staged_tmp_name(&name)
        })
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
