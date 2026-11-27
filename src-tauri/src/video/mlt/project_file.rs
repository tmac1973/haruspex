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
                    p.file_name()
                        .and_then(|n| n.to_str())
                        .is_some_and(|n| is_backup_of(n, stem, ext))
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

/// Whether `name` is one of `backup`'s copies of the project `<stem>.<ext>`:
/// `<stem>-<stamp>.<ext>`. The stamp has to be one `chrono_stamp` makes, or
/// `ep.kdenlive` would claim `ep-final.kdenlive`'s backups and prune them.
fn is_backup_of(name: &str, stem: &str, ext: &str) -> bool {
    let Some(stamp) = name
        .strip_prefix(stem)
        .and_then(|rest| rest.strip_prefix('-'))
        .and_then(|rest| rest.strip_suffix(ext))
        .and_then(|rest| rest.strip_suffix('.'))
    else {
        return false;
    };
    let b = stamp.as_bytes();
    b.len() == 18
        && b.iter().enumerate().all(|(i, c)| {
            if i == 8 {
                *c == b'T'
            } else {
                c.is_ascii_digit()
            }
        })
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stamp_is_what_is_backup_of_expects() {
        let name = format!("ep-{}.kdenlive", chrono_stamp());
        assert!(is_backup_of(&name, "ep", "kdenlive"));
    }

    #[test]
    fn is_backup_of_ignores_a_sibling_whose_stem_shares_a_prefix() {
        let sibling = "ep-final-20261025T143005123.kdenlive";
        assert!(!is_backup_of(sibling, "ep", "kdenlive"));
        assert!(is_backup_of(sibling, "ep-final", "kdenlive"));
    }

    #[test]
    fn is_backup_of_wants_the_same_extension_and_a_whole_stamp() {
        assert!(!is_backup_of("ep-20261025T143005123.mlt", "ep", "kdenlive"));
        assert!(!is_backup_of("ep-2026.kdenlive", "ep", "kdenlive"));
        assert!(!is_backup_of(
            "ep-20261025X143005123.kdenlive",
            "ep",
            "kdenlive"
        ));
        assert!(!is_backup_of("ep.kdenlive", "ep", "kdenlive"));
    }

    #[test]
    fn pruning_one_project_leaves_a_siblings_backups_alone() {
        let dir = tempfile::tempdir().unwrap();
        let ep = dir.path().join("ep.kdenlive");
        let ep_final = dir.path().join("ep-final.kdenlive");
        std::fs::write(&ep, "<mlt/>").unwrap();
        std::fs::write(&ep_final, "<mlt/>").unwrap();
        let backups = backups_dir(&ep);
        std::fs::create_dir_all(&backups).unwrap();
        // Older stamps than any real one, so these are the first to go.
        for i in 0..BACKUPS_KEPT {
            let stamp = format!("20000101T000000{i:03}");
            std::fs::write(backups.join(format!("ep-{stamp}.kdenlive")), "").unwrap();
            std::fs::write(backups.join(format!("ep-final-{stamp}.kdenlive")), "").unwrap();
        }

        backup(&ep).unwrap();

        let count = |stem: &str| {
            std::fs::read_dir(&backups)
                .unwrap()
                .filter_map(|e| e.ok())
                .filter(|e| is_backup_of(e.file_name().to_str().unwrap(), stem, "kdenlive"))
                .count()
        };
        assert_eq!(count("ep"), BACKUPS_KEPT);
        assert_eq!(count("ep-final"), BACKUPS_KEPT);
        assert!(!backups.join("ep-20000101T000000000.kdenlive").exists());
        assert!(backups
            .join("ep-final-20000101T000000000.kdenlive")
            .exists());
    }
}
