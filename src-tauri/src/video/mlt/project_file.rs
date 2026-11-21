//! Saving a project file either editor reads: a backup first, a write beside
//! it and a rename, then melt must still load it, or the backup goes back.

use std::path::{Path, PathBuf};

/// Backups kept per project.
const BACKUPS_KEPT: usize = 20;

/// The hash both editors record for a clip (`kdenlive:file_hash`,
/// `shotcut:hash`): MD5 of the whole file up to 2,000,000 bytes, otherwise of
/// its first and last 1,000,000 bytes.
pub fn file_hash(path: &Path) -> Result<String, String> {
    use md5::{Digest, Md5};
    use std::io::{Read, Seek, SeekFrom};
    let mut f =
        std::fs::File::open(path).map_err(|e| format!("can't read {}: {e}", path.display()))?;
    let size = f.metadata().map_err(|e| e.to_string())?.len();
    let mut hasher = Md5::new();
    let mut buf = Vec::new();
    if size <= 2_000_000 {
        f.read_to_end(&mut buf).map_err(|e| e.to_string())?;
        hasher.update(&buf);
    } else {
        buf.resize(1_000_000, 0);
        f.read_exact(&mut buf).map_err(|e| e.to_string())?;
        hasher.update(&buf);
        f.seek(SeekFrom::End(-1_000_000))
            .map_err(|e| e.to_string())?;
        f.read_exact(&mut buf).map_err(|e| e.to_string())?;
        hasher.update(&buf);
    }
    Ok(crate::hash_util::hex(&hasher.finalize()))
}

/// The backups folder for a project: `<its folder>/.haruspex/backups/`.
fn backups_dir(project: &Path) -> PathBuf {
    project
        .parent()
        .unwrap_or(Path::new("."))
        .join(".haruspex")
        .join("backups")
}

fn backup(project: &Path) -> Result<Option<PathBuf>, String> {
    if !project.exists() {
        return Ok(None);
    }
    let dir = backups_dir(project);
    std::fs::create_dir_all(&dir).map_err(|e| format!("can't make {}: {e}", dir.display()))?;
    let ext = project
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("project");
    let stem = project
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("project");
    let stamp = chrono_stamp();
    let to = dir.join(format!("{stem}-{stamp}.{ext}"));
    crate::video::copy_file(project, &to).map_err(|e| format!("can't back up the project: {e}"))?;
    // Keep the newest few.
    let mut old: Vec<PathBuf> = std::fs::read_dir(&dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok().map(|e| e.path()))
                .filter(|p| {
                    p.file_name().and_then(|n| n.to_str()).is_some_and(|n| {
                        n.starts_with(&format!("{stem}-")) && n.ends_with(&format!(".{ext}"))
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    old.sort();
    while old.len() > BACKUPS_KEPT {
        let _ = std::fs::remove_file(old.remove(0));
    }
    Ok(Some(to))
}

/// `20261025T143005123`, UTC, sorting the way it reads.
fn chrono_stamp() -> String {
    chrono::Utc::now().format("%Y%m%dT%H%M%S%3f").to_string()
}

/// Whether melt can load a project. `Err` carries melt's complaint.
pub async fn melt_loads(melt: &str, project: &Path) -> Result<(), String> {
    let mut cmd = tokio::process::Command::new(melt);
    cmd.arg(project)
        .args(["out=0", "-consumer", "null"])
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    crate::video::prepare_child(&mut cmd);
    let out = tokio::time::timeout(std::time::Duration::from_secs(60), cmd.output())
        .await
        .map_err(|_| "melt took too long to load the project".to_string())?
        .map_err(|e| format!("could not run melt: {e}"))?;
    let err = String::from_utf8_lossy(&out.stderr);
    if let Some(line) = err
        .lines()
        .find(|l| l.contains("Failed to load") || l.contains("parse fatal"))
    {
        return Err(line.trim().to_string());
    }
    Ok(())
}

/// Write `text` over `project`: back up first, write beside it and rename,
/// then make sure melt still loads it, restoring the backup if not.
pub async fn save(project: &Path, text: &str, melt: &str) -> Result<(), String> {
    let saved = backup(project)?;
    let tmp = project.with_extension(format!(
        "{}.tmp",
        project
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("project")
    ));
    std::fs::write(&tmp, text).map_err(|e| format!("can't write the project: {e}"))?;
    std::fs::rename(&tmp, project).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("can't write the project: {e}")
    })?;
    if let Err(why) = melt_loads(melt, project).await {
        match &saved {
            Some(b) => {
                // Beside it and renamed, as above, so a failed copy can't
                // leave the project half restored.
                let restored =
                    crate::video::copy_file(b, &tmp).and_then(|()| std::fs::rename(&tmp, project));
                if let Err(e) = restored {
                    let _ = std::fs::remove_file(&tmp);
                    return Err(format!(
                        "melt couldn't load the edited project ({why}), and restoring it \
                         failed ({e}): the old version is {}",
                        b.display()
                    ));
                }
            }
            None => {
                let _ = std::fs::remove_file(project);
            }
        }
        return Err(format!(
            "melt couldn't load the edited project, so it was not changed: {why}"
        ));
    }
    Ok(())
}
