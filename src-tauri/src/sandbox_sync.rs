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

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("haruspex_sandbox_sync_test_{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    async fn sync(dir: &Path, known: Vec<KnownFile>, file_cap: u64, run_cap: u64) -> SyncResult {
        sandbox_sync_workdir(dir.to_string_lossy().into_owned(), known, file_cap, run_cap)
            .await
            .unwrap()
    }

    fn known(r: &SyncResult) -> Vec<KnownFile> {
        r.to_sync
            .iter()
            .map(|f| KnownFile {
                path: f.path.clone(),
                mtime: f.mtime,
            })
            .collect()
    }

    fn paths(files: &[SyncFile]) -> Vec<String> {
        let mut p: Vec<String> = files.iter().map(|f| f.path.clone()).collect();
        p.sort();
        p
    }

    #[tokio::test]
    async fn the_first_sync_sends_every_file_with_its_bytes() {
        let dir = temp_dir("first");
        std::fs::create_dir_all(dir.join("data")).unwrap();
        std::fs::write(dir.join("a.csv"), b"1,2").unwrap();
        std::fs::write(dir.join("data/b.txt"), b"b").unwrap();
        let r = sync(&dir, vec![], 1_000, 1_000).await;
        let rel_b = Path::new("data")
            .join("b.txt")
            .to_string_lossy()
            .into_owned();
        assert_eq!(paths(&r.to_sync), vec!["a.csv".to_string(), rel_b]);
        let a = r.to_sync.iter().find(|f| f.path == "a.csv").unwrap();
        assert_eq!(a.bytes, b"1,2");
        assert_eq!(r.workdir_abs, dir.to_string_lossy());
        assert!(r.deleted.is_empty() && r.skipped.is_empty());
    }

    #[tokio::test]
    async fn an_unchanged_file_is_not_sent_again_and_a_removed_one_is_reported() {
        let dir = temp_dir("second");
        std::fs::write(dir.join("keep.txt"), b"k").unwrap();
        std::fs::write(dir.join("gone.txt"), b"g").unwrap();
        let first = sync(&dir, vec![], 1_000, 1_000).await;
        std::fs::remove_file(dir.join("gone.txt")).unwrap();
        let second = sync(&dir, known(&first), 1_000, 1_000).await;
        assert!(second.to_sync.is_empty(), "{:?}", paths(&second.to_sync));
        assert_eq!(second.deleted, vec!["gone.txt".to_string()]);
    }

    #[tokio::test]
    async fn a_changed_mtime_sends_the_file_again() {
        let dir = temp_dir("changed");
        std::fs::write(dir.join("a.txt"), b"1").unwrap();
        let first = sync(&dir, vec![], 1_000, 1_000).await;
        let stale = vec![KnownFile {
            path: "a.txt".into(),
            mtime: first.to_sync[0].mtime - 10.0,
        }];
        let second = sync(&dir, stale, 1_000, 1_000).await;
        assert_eq!(paths(&second.to_sync), vec!["a.txt".to_string()]);
    }

    #[tokio::test]
    async fn files_over_the_caps_are_skipped_with_a_reason() {
        let dir = temp_dir("caps");
        std::fs::write(dir.join("huge.bin"), vec![0u8; 50]).unwrap();
        std::fs::write(dir.join("a.txt"), vec![0u8; 8]).unwrap();
        std::fs::write(dir.join("b.txt"), vec![0u8; 8]).unwrap();
        // Per file: 50 > 20. Per run: only one of the two 8-byte files fits in 10.
        let r = sync(&dir, vec![], 20, 10).await;
        assert_eq!(r.to_sync.len(), 1);
        let mut reasons: Vec<(String, String)> = r
            .skipped
            .iter()
            .map(|s| (s.path.clone(), s.reason.clone()))
            .collect();
        reasons.sort();
        assert_eq!(reasons.len(), 2);
        assert!(reasons
            .iter()
            .any(|(p, why)| p == "huge.bin" && why.contains("per-file")));
        assert!(reasons.iter().any(|(_, why)| why.contains("per-run")));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn symlinks_are_not_followed_out_of_the_workdir() {
        let dir = temp_dir("symlink");
        let outside = temp_dir("symlink_outside");
        std::fs::write(outside.join("secret.txt"), b"s").unwrap();
        std::os::unix::fs::symlink(&outside, dir.join("dirlink")).unwrap();
        std::os::unix::fs::symlink(outside.join("secret.txt"), dir.join("filelink")).unwrap();
        let r = sync(&dir, vec![], 1_000, 1_000).await;
        assert!(r.to_sync.is_empty(), "{:?}", paths(&r.to_sync));
    }

    #[tokio::test]
    async fn a_missing_workdir_is_an_error() {
        let dir = std::env::temp_dir().join("haruspex_sandbox_sync_test_missing_xyz");
        let _ = std::fs::remove_dir_all(&dir);
        let err = sandbox_sync_workdir(dir.to_string_lossy().into_owned(), vec![], 1, 1)
            .await
            .err()
            .unwrap();
        assert!(err.contains("Cannot resolve working directory"), "{err}");
    }
}
