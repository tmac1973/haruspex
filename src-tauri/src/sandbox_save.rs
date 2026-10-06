//! Tauri command backing `haruspex.save(filename, content)` from the Python
//! sandbox. Lets the model write large binary blobs (matplotlib PNGs,
//! exported DataFrames, generated images) into the active chat's working
//! directory without round-tripping the bytes through its own context
//! window via `fs_write_text`.
//!
//! Path sandboxing is delegated to Phase 9's `resolve_in_workdir`, so the
//! same escape-rejection rules (no `..`, no symlink-out, no absolute paths
//! outside the workdir) apply uniformly.

use crate::fs_tools::resolve_in_workdir;
use serde::Serialize;
use std::path::PathBuf;
use tokio::fs;

/// Per-save size cap. Bigger than `fs_write_text`'s 10 MB because the
/// intended payloads here are rendered images and full DataFrame HTMLs,
/// not text edits. 100 MB is enough for any plot or table the model is
/// likely to produce while still bounding worst-case disk use.
const MAX_SANDBOX_SAVE_BYTES: usize = 100 * 1_048_576;

#[derive(Serialize)]
pub struct SandboxSaveResult {
    pub path: String,
    pub bytes: usize,
}

#[tauri::command]
pub async fn sandbox_save(
    workdir: Option<String>,
    rel_path: String,
    content: Vec<u8>,
) -> Result<SandboxSaveResult, String> {
    let workdir = workdir.ok_or_else(|| {
        "No working directory set for this chat — ask the user to select one before saving files."
            .to_string()
    })?;

    save_capped(&workdir, &rel_path, content, MAX_SANDBOX_SAVE_BYTES).await
}

/// `sandbox_save` with the cap as a parameter, so a test can exercise it
/// without a 100 MB buffer.
async fn save_capped(
    workdir: &str,
    rel_path: &str,
    content: Vec<u8>,
    max: usize,
) -> Result<SandboxSaveResult, String> {
    if content.len() > max {
        return Err(format!(
            "Save too large ({} bytes). Maximum is {} bytes.",
            content.len(),
            max
        ));
    }

    let workdir_path = PathBuf::from(workdir);
    let resolved = resolve_in_workdir(&workdir_path, rel_path)?;

    if let Some(parent) = resolved.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("Failed to create parent directory: {}", e))?;
        }
    }

    let bytes_written = content.len();
    fs::write(&resolved, content)
        .await
        .map_err(|e| format!("Failed to write file: {}", e))?;

    Ok(SandboxSaveResult {
        path: resolved.to_string_lossy().to_string(),
        bytes: bytes_written,
    })
}

#[derive(Serialize)]
pub struct SandboxDeleteResult {
    pub path: String,
}

/// Backs `haruspex.delete(filename)` from the Python sandbox. Used by the
/// post-run drain to propagate Python-side `os.remove(...)` / file moves
/// back to the host: anything that was in the pre-run workdir snapshot
/// but is missing from MEMFS after the run gets deleted here too. Path
/// validation matches `sandbox_save` — relative to the workdir, no `..`,
/// no symlink escapes. A missing target file is treated as a no-op
/// (Python already removed it from MEMFS; if host never had it, fine).
#[tauri::command]
pub async fn sandbox_delete_in_workdir(
    workdir: Option<String>,
    rel_path: String,
) -> Result<SandboxDeleteResult, String> {
    let workdir = workdir
        .ok_or_else(|| "No working directory set for this chat — cannot delete.".to_string())?;

    let workdir_path = PathBuf::from(&workdir);
    let resolved = resolve_in_workdir(&workdir_path, &rel_path)?;

    match fs::metadata(&resolved).await {
        Ok(meta) if meta.is_dir() => {
            return Err(format!(
                "Refusing to delete directory via sandbox bridge: {}",
                resolved.to_string_lossy()
            ));
        }
        Ok(_) => {
            fs::remove_file(&resolved)
                .await
                .map_err(|e| format!("Failed to delete file: {}", e))?;
        }
        Err(_) => {
            // Target doesn't exist on host. Nothing to do — the Python
            // delete already took effect in MEMFS, and host was already
            // in the post-delete state. Treat as success.
        }
    }

    Ok(SandboxDeleteResult {
        path: resolved.to_string_lossy().to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("haruspex_sandbox_save_test_{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    fn s(p: &std::path::Path) -> Option<String> {
        Some(p.to_string_lossy().into_owned())
    }

    #[tokio::test]
    async fn saving_needs_a_working_directory() {
        let err = sandbox_save(None, "a.txt".into(), b"x".to_vec())
            .await
            .err()
            .unwrap();
        assert!(err.contains("No working directory"), "{err}");
    }

    #[tokio::test]
    async fn a_save_lands_in_the_workdir_creating_parents() {
        let dir = temp_dir("nested");
        let r = sandbox_save(s(&dir), "out/plots/a.png".into(), b"png".to_vec())
            .await
            .unwrap();
        assert_eq!(r.bytes, 3);
        assert_eq!(std::fs::read(dir.join("out/plots/a.png")).unwrap(), b"png");
    }

    #[tokio::test]
    async fn a_save_over_the_cap_writes_nothing() {
        let dir = temp_dir("cap");
        let err = save_capped(dir.to_str().unwrap(), "big.bin", vec![0; 5], 4)
            .await
            .err()
            .unwrap();
        assert!(err.contains("too large"), "{err}");
        assert!(!dir.join("big.bin").exists());
    }

    #[tokio::test]
    async fn a_save_cannot_leave_the_workdir() {
        let dir = temp_dir("escape");
        let outside = dir
            .parent()
            .unwrap()
            .join("haruspex_sandbox_save_escaped.txt");
        let _ = std::fs::remove_file(&outside);
        for rel in [
            "../haruspex_sandbox_save_escaped.txt",
            outside.to_str().unwrap(),
        ] {
            assert!(
                sandbox_save(s(&dir), rel.into(), b"x".to_vec())
                    .await
                    .is_err(),
                "{rel} was accepted"
            );
        }
        assert!(!outside.exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_save_cannot_follow_a_symlink_out() {
        let dir = temp_dir("symlink");
        let target = temp_dir("symlink_target");
        std::os::unix::fs::symlink(&target, dir.join("link")).unwrap();
        assert!(sandbox_save(s(&dir), "link/a.txt".into(), b"x".to_vec())
            .await
            .is_err());
        assert!(!target.join("a.txt").exists());
    }

    #[tokio::test]
    async fn deleting_removes_a_file_and_tolerates_a_missing_one() {
        let dir = temp_dir("delete");
        std::fs::write(dir.join("a.txt"), b"x").unwrap();
        sandbox_delete_in_workdir(s(&dir), "a.txt".into())
            .await
            .unwrap();
        assert!(!dir.join("a.txt").exists());
        // Already gone: still success.
        sandbox_delete_in_workdir(s(&dir), "a.txt".into())
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn deleting_refuses_directories_and_escapes() {
        let dir = temp_dir("delete_refuse");
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        let err = sandbox_delete_in_workdir(s(&dir), "sub".into())
            .await
            .err()
            .unwrap();
        assert!(err.contains("Refusing to delete directory"), "{err}");
        assert!(dir.join("sub").exists());

        let outside = dir
            .parent()
            .unwrap()
            .join("haruspex_sandbox_delete_victim.txt");
        std::fs::write(&outside, b"keep").unwrap();
        assert!(
            sandbox_delete_in_workdir(s(&dir), "../haruspex_sandbox_delete_victim.txt".into())
                .await
                .is_err()
        );
        assert!(outside.exists());
        let _ = std::fs::remove_file(outside);
    }
}
