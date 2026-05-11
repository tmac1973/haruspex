//! Bidirectional working-dir ↔ MEMFS sync for the Python sandbox.
//!
//! Called by the worker manager before every `run_python` invocation. Walks
//! the chat's working directory recursively, compares against the manager's
//! `known_files` (path + mtime from the previous sync), and returns:
//!   - `to_sync`: new or modified files whose bytes should be written into
//!     MEMFS at their absolute path
//!   - `deleted`: paths that were in `known_files` but no longer exist on
//!     disk (worker unlinks them from MEMFS)
//!   - `skipped`: files that exceeded the size caps (worker prints a stderr
//!     note pointing the model at fs_read_*)
//!
//! Two size caps apply:
//!   - `per_file_cap_bytes`: any single file larger than this is skipped
//!     entirely (model uses fs_read_* for it)
//!   - `per_run_cap_bytes`: once cumulative transfer exceeds this, the
//!     remaining files are skipped (will retry next run unless the user
//!     does fs_read_* directly)
//!
//! The worker also gets `workdir_abs` so it can chdir Python's cwd into the
//! working dir, making the model's relative paths (`pd.read_csv('foo.csv')`)
//! resolve to the right MEMFS entry.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use tokio::fs;

#[derive(Deserialize)]
pub struct KnownFile {
    pub path: String,
    pub mtime: f64,
}

#[derive(Serialize)]
pub struct SyncFile {
    pub path: String,
    pub abs_path: String,
    pub bytes: Vec<u8>,
    pub mtime: f64,
}

#[derive(Serialize)]
pub struct SyncSkipped {
    pub path: String,
    pub reason: String,
}

#[derive(Serialize)]
pub struct SyncResult {
    pub to_sync: Vec<SyncFile>,
    pub deleted: Vec<String>,
    pub skipped: Vec<SyncSkipped>,
    pub workdir_abs: String,
}

#[tauri::command]
pub async fn sandbox_sync_workdir(
    workdir: String,
    known_files: Vec<KnownFile>,
    per_file_cap_bytes: u64,
    per_run_cap_bytes: u64,
) -> Result<SyncResult, String> {
    let workdir_path = PathBuf::from(&workdir);
    let workdir_canonical = workdir_path
        .canonicalize()
        .map_err(|e| format!("Cannot resolve working directory: {}", e))?;
    let workdir_abs = workdir_canonical.to_string_lossy().to_string();

    // First pass: walk the directory tree collecting (rel_path, abs_path,
    // size, mtime) for every file. Walks `.git` and other dotted
    // subdirectories too — the cap is the only filter (deliberate per the
    // "no extension allowlist" preference).
    let mut all_files: Vec<(String, PathBuf, u64, f64)> = Vec::new();
    walk_dir(&workdir_canonical, &workdir_canonical, &mut all_files)
        .map_err(|e| format!("Failed to walk workdir: {}", e))?;

    let known: HashMap<String, f64> = known_files
        .into_iter()
        .map(|kf| (kf.path, kf.mtime))
        .collect();

    let mut to_sync = Vec::new();
    let mut skipped = Vec::new();
    let mut current_paths: HashSet<String> = HashSet::new();
    let mut total_bytes: u64 = 0;

    for (rel_path, abs_path, size, mtime) in all_files {
        current_paths.insert(rel_path.clone());

        if size > per_file_cap_bytes {
            skipped.push(SyncSkipped {
                path: rel_path,
                reason: format!(
                    "{} bytes > {} byte per-file sync limit; use fs_read_text / fs_read_pdf / fs_read_xlsx etc. for this file",
                    size, per_file_cap_bytes
                ),
            });
            continue;
        }

        // Mtime-based change detection: only sync if mtime differs (or the
        // file wasn't in known_files at all). Tolerance is 1ms to dodge
        // float comparison noise; in practice mtimes are stable across runs.
        if let Some(known_mtime) = known.get(&rel_path) {
            if (*known_mtime - mtime).abs() < 1e-3 {
                continue;
            }
        }

        if total_bytes.saturating_add(size) > per_run_cap_bytes {
            skipped.push(SyncSkipped {
                path: rel_path,
                reason: format!(
                    "would exceed {} byte per-run sync budget; will retry next run, or use fs_read_* directly if you need it now",
                    per_run_cap_bytes
                ),
            });
            continue;
        }

        let bytes = fs::read(&abs_path)
            .await
            .map_err(|e| format!("Failed to read {}: {}", rel_path, e))?;
        total_bytes += size;
        to_sync.push(SyncFile {
            path: rel_path,
            abs_path: abs_path.to_string_lossy().to_string(),
            bytes,
            mtime,
        });
    }

    let deleted: Vec<String> = known
        .keys()
        .filter(|p| !current_paths.contains(*p))
        .cloned()
        .collect();

    Ok(SyncResult {
        to_sync,
        deleted,
        skipped,
        workdir_abs,
    })
}

fn walk_dir(
    root: &Path,
    dir: &Path,
    out: &mut Vec<(String, PathBuf, u64, f64)>,
) -> std::io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let meta = entry.metadata()?;
        if meta.is_dir() {
            walk_dir(root, &path, out)?;
        } else if meta.is_file() {
            let rel = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .to_string();
            let size = meta.len();
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs_f64())
                .unwrap_or(0.0);
            out.push((rel, path, size, mtime));
        }
    }
    Ok(())
}
