//! Binary file Tauri commands, sandboxed through `resolve_in_workdir` like
//! every other fs tool.
//!
//! The text commands cannot serve a PNG: base64 through `fs_write_text` would
//! put a text file on disk where a real image has to be, and the generated
//! assets are read back by the game, by the contact sheet, and by a later run
//! deciding whether an asset already exists.

use super::path::{
    refuse_if_exists, resolve_in_workdir, workdir_path, workdir_path_for_write,
    write_bytes_to_workdir, MAX_WRITE_BYTES,
};

/// Read a file as bytes.
#[tauri::command]
pub async fn fs_read_bytes(workdir: String, rel_path: String) -> Result<Vec<u8>, String> {
    let workdir = workdir_path(&workdir)?;
    let resolved = resolve_in_workdir(&workdir, &rel_path)?;
    if !resolved.is_file() {
        return Err(format!("Not a file: {}", rel_path));
    }
    tokio::fs::read(&resolved)
        .await
        .map_err(|e| format!("Failed to read {}: {}", rel_path, e))
}

/// Write bytes, creating parent directories. With `dry_run`, only the
/// refusals: `make_asset` asks before it spends a minute drawing a file it
/// could not have written.
#[tauri::command]
pub async fn fs_write_bytes(
    workdir: String,
    rel_path: String,
    bytes: Vec<u8>,
    overwrite: Option<bool>,
    dry_run: Option<bool>,
) -> Result<(), String> {
    let workdir = workdir_path_for_write(&workdir)?;
    let resolved = resolve_in_workdir(&workdir, &rel_path)?;

    if bytes.len() > MAX_WRITE_BYTES {
        return Err(format!(
            "Content too large ({} bytes). Maximum write is {} bytes.",
            bytes.len(),
            MAX_WRITE_BYTES
        ));
    }
    refuse_if_exists(&resolved, overwrite, &rel_path)?;
    if dry_run == Some(true) {
        return Ok(());
    }
    write_bytes_to_workdir(&resolved, &bytes).await
}

/// Move a file within the working directory, creating the destination's
/// parents. Never overwrites: a destination that exists is an error, so a
/// move cannot destroy a file it was not asked about.
///
/// For the asset review: a disliked asset is moved into `assets/.history/`
/// rather than deleted, so the next run regenerates it (it is missing) and
/// the old one can still be put back.
#[tauri::command]
pub async fn fs_move_in_workdir(
    workdir: String,
    from_rel: String,
    to_rel: String,
) -> Result<(), String> {
    let workdir = workdir_path_for_write(&workdir)?;
    let from = resolve_in_workdir(&workdir, &from_rel)?;
    let to = resolve_in_workdir(&workdir, &to_rel)?;
    if !from.is_file() {
        return Err(format!("Not a file: {from_rel}"));
    }
    refuse_if_exists(&to, Some(false), &to_rel)?;
    if let Some(parent) = to.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
    }
    tokio::fs::rename(&from, &to)
        .await
        .map_err(|e| format!("Failed to move {from_rel} to {to_rel}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("haruspex-move-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[tokio::test]
    async fn moves_a_file_into_a_new_folder() {
        let d = temp("ok");
        std::fs::create_dir_all(d.join("assets")).unwrap();
        std::fs::write(d.join("assets/player.png"), b"png").unwrap();
        let w = d.to_string_lossy().to_string();
        fs_move_in_workdir(
            w,
            "assets/player.png".into(),
            "assets/.history/player-1.png".into(),
        )
        .await
        .unwrap();
        assert!(!d.join("assets/player.png").exists());
        assert_eq!(
            std::fs::read(d.join("assets/.history/player-1.png")).unwrap(),
            b"png"
        );
        std::fs::remove_dir_all(&d).ok();
    }

    #[tokio::test]
    async fn never_overwrites_and_never_leaves_the_workdir() {
        let d = temp("refuse");
        std::fs::write(d.join("a.png"), b"a").unwrap();
        std::fs::write(d.join("b.png"), b"b").unwrap();
        let w = d.to_string_lossy().to_string();
        assert!(
            fs_move_in_workdir(w.clone(), "a.png".into(), "b.png".into())
                .await
                .is_err()
        );
        assert_eq!(std::fs::read(d.join("b.png")).unwrap(), b"b");
        assert!(
            fs_move_in_workdir(w.clone(), "a.png".into(), "../escaped.png".into())
                .await
                .is_err()
        );
        assert!(fs_move_in_workdir(w, "missing.png".into(), "c.png".into())
            .await
            .is_err());
        assert!(d.join("a.png").exists());
        std::fs::remove_dir_all(&d).ok();
    }

    #[tokio::test]
    async fn a_dry_run_checks_the_write_without_making_the_file() {
        let d = temp("dry");
        let w = || d.to_string_lossy().into_owned();
        fs_write_bytes(w(), "a.png".into(), vec![1], None, Some(true))
            .await
            .unwrap();
        assert!(!d.join("a.png").exists());
        // Outside the folder: refused as a dry run too.
        assert!(
            fs_write_bytes(w(), "../a.png".into(), vec![1], None, Some(true))
                .await
                .is_err()
        );
        fs_write_bytes(w(), "a.png".into(), vec![1], None, None)
            .await
            .unwrap();
        // It exists now: refused without overwrite, dry run or not.
        assert!(
            fs_write_bytes(w(), "a.png".into(), vec![2], None, Some(true))
                .await
                .is_err()
        );
        std::fs::remove_dir_all(&d).ok();
    }
}
