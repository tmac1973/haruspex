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
//!
//! The result goes back as one binary body ([`encode_sync`]), not JSON: a
//! first sync can carry thousands of files, and a `Vec<u8>` serialized as a
//! JSON array of numbers froze the webview's main thread for seconds while it
//! parsed.

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

pub struct SyncResult {
    pub to_sync: Vec<SyncFile>,
    pub deleted: Vec<String>,
    pub skipped: Vec<SyncSkipped>,
    pub workdir_abs: String,
}

/// A synced file as the header names it; its bytes follow the header.
#[derive(Serialize)]
struct SyncFileHeader<'a> {
    path: &'a str,
    abs_path: &'a str,
    mtime: f64,
    len: usize,
}

#[derive(Serialize)]
struct SyncHeader<'a> {
    to_sync: Vec<SyncFileHeader<'a>>,
    deleted: &'a [String],
    skipped: &'a [SyncSkipped],
    workdir_abs: &'a str,
}

/// The body `sandbox_sync_workdir` answers with: the header's length as a
/// little-endian u32, the header as JSON (each file without its bytes), then
/// every file's bytes end to end, in the header's order.
pub fn encode_sync(r: &SyncResult) -> Result<Vec<u8>, String> {
    let header = SyncHeader {
        to_sync: r
            .to_sync
            .iter()
            .map(|f| SyncFileHeader {
                path: &f.path,
                abs_path: &f.abs_path,
                mtime: f.mtime,
                len: f.bytes.len(),
            })
            .collect(),
        deleted: &r.deleted,
        skipped: &r.skipped,
        workdir_abs: &r.workdir_abs,
    };
    let json = serde_json::to_vec(&header).map_err(|e| e.to_string())?;
    let header_len = u32::try_from(json.len()).map_err(|_| "sync header too large".to_string())?;
    let body: usize = r.to_sync.iter().map(|f| f.bytes.len()).sum();
    let mut out = Vec::with_capacity(4 + json.len() + body);
    out.extend_from_slice(&header_len.to_le_bytes());
    out.extend_from_slice(&json);
    for f in &r.to_sync {
        out.extend_from_slice(&f.bytes);
    }
    Ok(out)
}

#[tauri::command]
pub async fn sandbox_sync_workdir(
    workdir: String,
    known_files: Vec<KnownFile>,
    per_file_cap_bytes: u64,
    per_run_cap_bytes: u64,
) -> Result<tauri::ipc::Response, String> {
    let r = sync_workdir(workdir, known_files, per_file_cap_bytes, per_run_cap_bytes).await?;
    encode_sync(&r).map(tauri::ipc::Response::new)
}

async fn sync_workdir(
    workdir: String,
    known_files: Vec<KnownFile>,
    per_file_cap_bytes: u64,
    per_run_cap_bytes: u64,
) -> Result<SyncResult, String> {
    let workdir_path = PathBuf::from(&workdir);
    // No `\\?\` on Windows: the worker shows this path to Python as its cwd.
    let workdir_canonical = crate::fs_tools::path::strip_verbatim(
        &workdir_path
            .canonicalize()
            .map_err(|e| format!("Cannot resolve working directory: {}", e))?,
    );
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
    use crate::test_util::temp_dir;

    async fn sync(dir: &Path, known: Vec<KnownFile>, file_cap: u64, run_cap: u64) -> SyncResult {
        sync_workdir(dir.to_string_lossy().into_owned(), known, file_cap, run_cap)
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
        let root = temp_dir("missing");
        let dir = root.join("missing_xyz");
        let err = sync_workdir(dir.to_string_lossy().into_owned(), vec![], 1, 1)
            .await
            .err()
            .unwrap();
        assert!(err.contains("Cannot resolve working directory"), "{err}");
    }

    #[test]
    fn the_encoded_sync_is_a_header_then_each_files_bytes() {
        let r = SyncResult {
            to_sync: vec![
                SyncFile {
                    path: "a.txt".into(),
                    abs_path: "/w/a.txt".into(),
                    bytes: b"one".to_vec(),
                    mtime: 1.5,
                },
                SyncFile {
                    path: "b.bin".into(),
                    abs_path: "/w/b.bin".into(),
                    bytes: vec![0, 255],
                    mtime: 2.0,
                },
            ],
            deleted: vec!["gone.txt".into()],
            skipped: vec![SyncSkipped {
                path: "big.bin".into(),
                reason: "too big".into(),
            }],
            workdir_abs: "/w".into(),
        };
        let out = encode_sync(&r).unwrap();
        let header_len = u32::from_le_bytes(out[..4].try_into().unwrap()) as usize;
        let header: serde_json::Value = serde_json::from_slice(&out[4..4 + header_len]).unwrap();
        assert_eq!(
            header,
            serde_json::json!({
                "to_sync": [
                    { "path": "a.txt", "abs_path": "/w/a.txt", "mtime": 1.5, "len": 3 },
                    { "path": "b.bin", "abs_path": "/w/b.bin", "mtime": 2.0, "len": 2 }
                ],
                "deleted": ["gone.txt"],
                "skipped": [{ "path": "big.bin", "reason": "too big" }],
                "workdir_abs": "/w"
            })
        );
        assert_eq!(&out[4 + header_len..], b"one\x00\xff");
    }
}
