//! Back up every notebook to one file, and restore from one (Settings →
//! Notebooks). The file is a zip:
//!
//! - `manifest.json`: `{ format, version, created_at, app_version, counts }`
//! - `notebooks.json`: the notebooks (`db::BackupNotebook`)
//! - `files/<sha256>`: each kept file a card or an earlier version uses
//!
//! Restoring checks each file against its name before keeping it. A
//! Replace restore writes a backup of what's here first, into
//! `<app_data>/notebook_backups/`, since it can't be undone otherwise.

use crate::blob_cache;
use crate::db::{BackupNotebook, Database, RestoreCounts, RestoreMode};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

const FORMAT: &str = "haruspex-notebooks";
const VERSION: u32 = 1;
/// The largest `notebooks.json` a restore reads.
const MAX_JSON_BYTES: u64 = 1 << 30;

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, ts_rs::TS)]
#[ts(export, rename = "NotebookBackupCounts")]
pub struct Counts {
    pub notebooks: u32,
    pub cards: u32,
    pub files: u32,
}

#[derive(Serialize, Deserialize)]
struct Manifest {
    format: String,
    version: u32,
    created_at: i64,
    app_version: String,
    counts: Counts,
}

/// What a backup file holds, before restoring it.
#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[ts(export, rename = "NotebookBackupInfo")]
pub struct BackupInfo {
    #[ts(type = "number")]
    pub created_at: i64,
    pub counts: Counts,
    /// Of its notebooks, how many are here already.
    pub already_here: u32,
}

#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[ts(export, rename = "NotebookRestoreResult")]
pub struct RestoreResult {
    pub counts: RestoreCounts,
    /// Kept files the backup named but didn't hold, or held damaged.
    pub missing_files: u32,
    /// Where what was here before a Replace restore was saved.
    pub saved_before: Option<String>,
}

fn zip_err(e: zip::result::ZipError) -> String {
    format!("This isn't a notebook backup ({e}).")
}

fn count(notebooks: &[BackupNotebook], files: u32) -> Counts {
    Counts {
        notebooks: notebooks.len() as u32,
        cards: notebooks.iter().map(|n| n.cards.len() as u32).sum(),
        files,
    }
}

/// Write every notebook and the files they use to `out`. Written beside it
/// first, so a failure never leaves half a backup under the chosen name.
pub fn write_backup(
    db: &Database,
    files_dir: &Path,
    out: &Path,
    now_ms: i64,
) -> Result<Counts, String> {
    let notebooks = db.notebook_backup_dump()?;
    let mut hashes: Vec<String> = notebooks.iter().flat_map(|n| n.file_hashes()).collect();
    hashes.sort();
    hashes.dedup();
    let present: Vec<PathBuf> = hashes
        .iter()
        .filter(|h| blob_cache::is_valid_hash(h))
        .map(|h| files_dir.join(h))
        .filter(|p| p.is_file())
        .collect();
    let counts = count(&notebooks, present.len() as u32);

    let part = out.with_extension(format!("part-{}", crate::hash_util::random_hex(4)?));
    let result = (|| {
        use zip::write::SimpleFileOptions;
        let file = std::fs::File::create(&part)
            .map_err(|e| format!("Can't write {}: {e}", out.display()))?;
        let mut zip = zip::ZipWriter::new(std::io::BufWriter::new(file));
        let deflate =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        let stored = SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored)
            .large_file(true);
        let manifest = Manifest {
            format: FORMAT.into(),
            version: VERSION,
            created_at: now_ms,
            app_version: env!("CARGO_PKG_VERSION").into(),
            counts: counts.clone(),
        };
        let write_err = |e: std::io::Error| format!("Can't write {}: {e}", out.display());
        zip.start_file("manifest.json", deflate).map_err(zip_err)?;
        zip.write_all(&serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?)
            .map_err(write_err)?;
        zip.start_file("notebooks.json", deflate.large_file(true))
            .map_err(zip_err)?;
        serde_json::to_writer(&mut zip, &notebooks).map_err(|e| e.to_string())?;
        for path in &present {
            let name = path.file_name().unwrap_or_default().to_string_lossy();
            zip.start_file(format!("files/{name}"), stored)
                .map_err(zip_err)?;
            let mut src =
                std::fs::File::open(path).map_err(|e| format!("Can't read a kept file: {e}"))?;
            std::io::copy(&mut src, &mut zip).map_err(write_err)?;
        }
        let inner = zip.finish().map_err(zip_err)?;
        inner
            .into_inner()
            .map_err(|e| write_err(e.into_error()))?
            .sync_all()
            .map_err(write_err)?;
        std::fs::rename(&part, out).map_err(write_err)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&part);
    }
    result.map(|()| counts)
}

type Archive = zip::ZipArchive<std::io::BufReader<std::fs::File>>;

fn open_backup(path: &Path) -> Result<(Archive, Manifest), String> {
    let file =
        std::fs::File::open(path).map_err(|e| format!("Can't open {}: {e}", path.display()))?;
    let mut zip = zip::ZipArchive::new(std::io::BufReader::new(file)).map_err(zip_err)?;
    let manifest: Manifest = {
        let entry = zip
            .by_name("manifest.json")
            .map_err(|_| "This isn't a notebook backup.".to_string())?;
        serde_json::from_reader(entry.take(1 << 20))
            .map_err(|_| "This isn't a notebook backup.".to_string())?
    };
    if manifest.format != FORMAT {
        return Err("This isn't a notebook backup.".into());
    }
    if manifest.version > VERSION {
        return Err("This backup is from a newer Haruspex. Update to restore it.".into());
    }
    Ok((zip, manifest))
}

fn read_notebooks(zip: &mut Archive) -> Result<Vec<BackupNotebook>, String> {
    let entry = zip
        .by_name("notebooks.json")
        .map_err(|_| "The backup has no notebooks in it.".to_string())?;
    serde_json::from_reader(std::io::BufReader::new(entry.take(MAX_JSON_BYTES)))
        .map_err(|e| format!("The backup's notebooks can't be read: {e}"))
}

pub fn inspect_backup(db: &Database, path: &Path) -> Result<BackupInfo, String> {
    let (mut zip, manifest) = open_backup(path)?;
    let notebooks = read_notebooks(&mut zip)?;
    let ids: Vec<String> = notebooks.iter().map(|n| n.id.clone()).collect();
    Ok(BackupInfo {
        created_at: manifest.created_at,
        counts: manifest.counts,
        already_here: db.notebook_ids_present(&ids)?.len() as u32,
    })
}

/// Copy one `files/<hash>` entry into the store, if its bytes match its name.
fn keep_file(entry: &mut zip::read::ZipFile<'_, impl Read>, dir: &Path, hash: &str) -> bool {
    let final_path = dir.join(hash);
    if final_path.is_file() {
        return true;
    }
    let Ok(suffix) = crate::hash_util::random_hex(4) else {
        return false;
    };
    let part = dir.join(format!("restore-{suffix}.part"));
    let ok = (|| -> std::io::Result<bool> {
        let mut out = std::fs::File::create(&part)?;
        let mut hasher = Sha256::new();
        let mut buf = vec![0u8; 1 << 16];
        let mut limited = entry.take(super::MAX_FILE_BYTES + 1);
        let mut size = 0u64;
        loop {
            let n = limited.read(&mut buf)?;
            if n == 0 {
                break;
            }
            size += n as u64;
            hasher.update(&buf[..n]);
            out.write_all(&buf[..n])?;
        }
        Ok(size <= super::MAX_FILE_BYTES && crate::hash_util::hex(&hasher.finalize()) == hash)
    })()
    .unwrap_or(false);
    if ok && std::fs::rename(&part, &final_path).is_ok() {
        return true;
    }
    let _ = std::fs::remove_file(&part);
    false
}

/// Put a backup's notebooks and files back. Files go first, so a card is
/// never restored before the file it shows; the notebooks go in one
/// transaction. `save_before` (Replace) is where to back up what's here first.
pub fn restore_backup(
    db: &Database,
    files_dir: &Path,
    path: &Path,
    mode: RestoreMode,
    save_before: Option<&Path>,
    now_ms: i64,
) -> Result<RestoreResult, String> {
    let (mut zip, _) = open_backup(path)?;
    let notebooks = read_notebooks(&mut zip)?;
    let mut wanted: Vec<String> = notebooks.iter().flat_map(|n| n.file_hashes()).collect();
    wanted.sort();
    wanted.dedup();
    let mut missing = 0u32;
    for hash in &wanted {
        if !blob_cache::is_valid_hash(hash) {
            missing += 1;
            continue;
        }
        let kept = match zip.by_name(&format!("files/{hash}")) {
            Ok(mut entry) => keep_file(&mut entry, files_dir, hash),
            Err(_) => files_dir.join(hash).is_file(),
        };
        if !kept {
            missing += 1;
        }
    }
    let saved_before = match save_before {
        Some(p) if mode == RestoreMode::Replace => {
            write_backup(db, files_dir, p, now_ms)?;
            Some(p.display().to_string())
        }
        _ => None,
    };
    let counts = db.notebook_backup_load(&notebooks, mode, now_ms)?;
    Ok(RestoreResult {
        counts,
        missing_files: missing,
        saved_before,
    })
}

fn files_dir(app: &AppHandle) -> Result<PathBuf, String> {
    super::dir(app)
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("Backup task failed: {e}"))?
}

#[tauri::command]
pub async fn notebook_backup_create(
    app: AppHandle,
    state: tauri::State<'_, Database>,
    path: String,
) -> Result<Counts, String> {
    let db = state.inner().clone();
    let dir = files_dir(&app)?;
    blocking(move || write_backup(&db, &dir, Path::new(&path), crate::time_util::now_ms())).await
}

#[tauri::command]
pub async fn notebook_backup_inspect(
    state: tauri::State<'_, Database>,
    path: String,
) -> Result<BackupInfo, String> {
    let db = state.inner().clone();
    blocking(move || inspect_backup(&db, Path::new(&path))).await
}

#[tauri::command]
pub async fn notebook_backup_restore(
    app: AppHandle,
    state: tauri::State<'_, Database>,
    path: String,
    mode: RestoreMode,
) -> Result<RestoreResult, String> {
    let db = state.inner().clone();
    let dir = files_dir(&app)?;
    let now = crate::time_util::now_ms();
    let before = if mode == RestoreMode::Replace {
        let folder = app
            .path()
            .app_data_dir()
            .map_err(|e| format!("No app data folder: {e}"))?
            .join("notebook_backups");
        std::fs::create_dir_all(&folder)
            .map_err(|e| format!("Can't make {}: {e}", folder.display()))?;
        Some(folder.join(format!("before-restore-{now}.zip")))
    } else {
        None
    };
    blocking(move || restore_backup(&db, &dir, Path::new(&path), mode, before.as_deref(), now))
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::NewCard;

    fn setup() -> (Database, tempfile::TempDir, String) {
        let db = Database::open_in_memory();
        let tmp = tempfile::tempdir().unwrap();
        let files = tmp.path().join("files");
        std::fs::create_dir_all(&files).unwrap();
        let hash = super::super::store_bytes(&files, b"png bytes").unwrap();
        let nb = db.notebook_create("Trip", &[]).unwrap();
        db.notebook_card_add(
            &nb.id,
            None,
            &NewCard {
                kind: "image".into(),
                title: "Map".into(),
                body: String::new(),
                meta: format!(r#"{{"hash":"{hash}","name":"m.png","mime":"image/png","size":9}}"#),
                rows: None,
            },
            r#"{"kind":"user"}"#,
        )
        .unwrap();
        (db, tmp, hash)
    }

    #[test]
    fn a_backup_restores_notebooks_and_files_on_another_computer() {
        let (db, tmp, hash) = setup();
        let out = tmp.path().join("nb.zip");
        let counts = write_backup(&db, &tmp.path().join("files"), &out, 7).unwrap();
        assert_eq!(
            counts,
            Counts {
                notebooks: 1,
                cards: 1,
                files: 1
            }
        );
        // No stray part file is left beside it.
        assert_eq!(std::fs::read_dir(tmp.path()).unwrap().count(), 2);

        let other = Database::open_in_memory();
        let info = inspect_backup(&other, &out).unwrap();
        assert_eq!(info.created_at, 7);
        assert_eq!(info.already_here, 0);

        let files2 = tmp.path().join("files2");
        std::fs::create_dir_all(&files2).unwrap();
        let r = restore_backup(&other, &files2, &out, RestoreMode::Add, None, 8).unwrap();
        assert_eq!(r.counts.added, 1);
        assert_eq!(r.missing_files, 0);
        assert_eq!(std::fs::read(files2.join(&hash)).unwrap(), b"png bytes");
        assert_eq!(
            other.notebook_backup_dump().unwrap(),
            db.notebook_backup_dump().unwrap()
        );
        assert_eq!(inspect_backup(&other, &out).unwrap().already_here, 1);
    }

    #[test]
    fn a_damaged_file_is_not_kept_and_is_counted() {
        let (db, tmp, hash) = setup();
        let out = tmp.path().join("nb.zip");
        write_backup(&db, &tmp.path().join("files"), &out, 7).unwrap();
        // Rewrite the archive with the file's bytes changed.
        let mut src = zip::ZipArchive::new(std::fs::File::open(&out).unwrap()).unwrap();
        let bad = tmp.path().join("bad.zip");
        let mut w = zip::ZipWriter::new(std::fs::File::create(&bad).unwrap());
        for i in 0..src.len() {
            let mut e = src.by_index(i).unwrap();
            let name = e.name().unwrap().to_string();
            let mut bytes = Vec::new();
            e.read_to_end(&mut bytes).unwrap();
            if name.starts_with("files/") {
                bytes = b"tampered".to_vec();
            }
            w.start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            w.write_all(&bytes).unwrap();
        }
        w.finish().unwrap();
        let files2 = tmp.path().join("files2");
        std::fs::create_dir_all(&files2).unwrap();
        let other = Database::open_in_memory();
        let r = restore_backup(&other, &files2, &bad, RestoreMode::Add, None, 8).unwrap();
        assert_eq!(r.missing_files, 1);
        assert!(!files2.join(&hash).exists());
        assert_eq!(std::fs::read_dir(&files2).unwrap().count(), 0);
    }

    #[test]
    fn replace_saves_what_was_here_first() {
        let (db, tmp, _) = setup();
        let files = tmp.path().join("files");
        let out = tmp.path().join("nb.zip");
        write_backup(&db, &files, &out, 7).unwrap();
        db.notebook_create("Later", &[]).unwrap();
        let before = tmp.path().join("before.zip");
        let r = restore_backup(&db, &files, &out, RestoreMode::Replace, Some(&before), 9).unwrap();
        assert_eq!(r.counts.replaced, 1);
        assert_eq!(r.counts.trashed, 1);
        assert_eq!(inspect_backup(&db, &before).unwrap().counts.notebooks, 2);
    }

    #[test]
    fn other_files_are_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("x.zip");
        std::fs::write(&p, b"not a zip").unwrap();
        let db = Database::open_in_memory();
        assert!(inspect_backup(&db, &p)
            .unwrap_err()
            .contains("isn't a notebook backup"));
        let mut w = zip::ZipWriter::new(std::fs::File::create(&p).unwrap());
        w.start_file("manifest.json", zip::write::SimpleFileOptions::default())
            .unwrap();
        w.write_all(br#"{"format":"haruspex-notebooks","version":99,"created_at":0,"app_version":"9","counts":{"notebooks":0,"cards":0,"files":0}}"#)
            .unwrap();
        w.finish().unwrap();
        assert!(inspect_backup(&db, &p).unwrap_err().contains("newer"));
    }
}
