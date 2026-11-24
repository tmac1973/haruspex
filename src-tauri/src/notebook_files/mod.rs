//! The files notebooks keep: attachments and pictures, under
//! `<app_data>/notebook_files/<sha256>`. Unlike the image and audio caches
//! nothing here is evicted while a card, live or in Trash, or a revision
//! of one refers to it; `sweep` removes the rest at startup.

pub mod protocol;
pub mod transfer;

use crate::blob_cache;
use crate::db::Database;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use tauri::AppHandle;

/// The largest file a notebook keeps.
pub const MAX_FILE_BYTES: u64 = 200 * 1_048_576;

/// A stored file, as a card's `meta` records it.
#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[ts(export, rename = "NotebookFile")]
pub struct StoredFile {
    pub hash: String,
    pub name: String,
    pub mime: String,
    #[ts(type = "number")]
    pub size: u64,
}

pub fn dir(app: &AppHandle) -> Result<PathBuf, String> {
    blob_cache::cache_dir(app, "notebook_files", "notebook file")
}

/// The MIME type for a file name, by extension; generic bytes otherwise.
pub fn mime_for_name(name: &str) -> &'static str {
    let ext = Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "avif" => "image/avif",
        "pdf" => "application/pdf",
        "txt" | "log" => "text/plain",
        "md" | "markdown" => "text/markdown",
        "csv" => "text/csv",
        "json" => "application/json",
        "html" | "htm" => "text/html",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "odt" => "application/vnd.oasis.opendocument.text",
        "ods" => "application/vnd.oasis.opendocument.spreadsheet",
        "zip" => "application/zip",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "mp4" => "video/mp4",
        _ => "application/octet-stream",
    }
}

fn too_big(size: u64) -> Result<(), String> {
    if size > MAX_FILE_BYTES {
        Err("Files over 200 MB can't be added.".into())
    } else {
        Ok(())
    }
}

/// Keep `bytes` and return its hash. Same bytes, same file.
pub fn store_bytes(dir: &Path, bytes: &[u8]) -> Result<String, String> {
    if bytes.is_empty() {
        return Err("The file is empty.".into());
    }
    too_big(bytes.len() as u64)?;
    let hash = blob_cache::hash_bytes(bytes);
    let final_path = dir.join(&hash);
    if !final_path.exists() {
        let part = dir.join(format!("{hash}.part"));
        std::fs::write(&part, bytes).map_err(|e| format!("Could not keep the file: {e}"))?;
        std::fs::rename(&part, &final_path).map_err(|e| {
            let _ = std::fs::remove_file(&part);
            format!("Could not keep the file: {e}")
        })?;
    }
    Ok(hash)
}

/// Copy the file at `path` in, hashing as it goes. Returns its hash and size.
pub fn store_path(dir: &Path, path: &Path) -> Result<(String, u64), String> {
    let meta =
        std::fs::metadata(path).map_err(|e| format!("Can't read {}: {e}", path.display()))?;
    if !meta.is_file() {
        return Err(format!("{} is not a file.", path.display()));
    }
    too_big(meta.len())?;
    if meta.len() == 0 {
        return Err("The file is empty.".into());
    }
    let mut src =
        std::fs::File::open(path).map_err(|e| format!("Can't open {}: {e}", path.display()))?;
    let part = dir.join(format!(
        "incoming-{}.part",
        crate::hash_util::random_hex(8)?
    ));
    let result = (|| {
        let mut out =
            std::fs::File::create(&part).map_err(|e| format!("Could not keep the file: {e}"))?;
        let mut hasher = Sha256::new();
        let mut buf = vec![0u8; 1 << 16];
        let mut size = 0u64;
        loop {
            let n = src
                .read(&mut buf)
                .map_err(|e| format!("Can't read {}: {e}", path.display()))?;
            if n == 0 {
                break;
            }
            size += n as u64;
            too_big(size)?;
            hasher.update(&buf[..n]);
            out.write_all(&buf[..n])
                .map_err(|e| format!("Could not keep the file: {e}"))?;
        }
        let hash = crate::hash_util::hex(&hasher.finalize());
        let final_path = dir.join(&hash);
        if final_path.exists() {
            let _ = std::fs::remove_file(&part);
        } else {
            std::fs::rename(&part, &final_path)
                .map_err(|e| format!("Could not keep the file: {e}"))?;
        }
        Ok((hash, size))
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&part);
    }
    result
}

/// `<dir>/<hash>` when the hash is well formed and the file is there.
pub fn path_of(dir: &Path, hash: &str) -> Result<PathBuf, String> {
    if !blob_cache::is_valid_hash(hash) {
        return Err("Not a notebook file.".into());
    }
    let p = dir.join(hash);
    if p.is_file() {
        Ok(p)
    } else {
        Err("That file is no longer kept.".into())
    }
}

/// Remove files nothing refers to any more. Run after the Trash purge.
pub fn sweep(db: &Database, dir: &Path) -> Result<(), String> {
    blob_cache::remove_strays(dir, &db.notebook_referenced_hashes()?, "notebook file");
    Ok(())
}

/// Extensions the system would run rather than show: opening one of these
/// is refused, and Save a copy… is the way to get it out.
const RUNNABLE: &[&str] = &[
    "exe", "msi", "bat", "cmd", "com", "scr", "ps1", "vbs", "js", "jse", "wsf", "hta", "lnk", "sh",
    "bash", "zsh", "csh", "command", "desktop", "app", "appimage", "run", "bin", "jar", "py",
    "pyw", "pl", "rb", "deb", "rpm", "pkg", "dmg", "reg", "url", "scpt",
];

/// Whether a file named `name` would run code if opened.
pub fn is_runnable(name: &str) -> bool {
    Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| RUNNABLE.contains(&e.to_ascii_lowercase().as_str()))
}

/// A file name safe to create: no folders, no leading dots, nothing empty.
fn safe_name(name: &str) -> String {
    let base = Path::new(name)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let cleaned: String = base
        .chars()
        .map(|c| {
            if c.is_control() || "<>:\"/\\|?*".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let trimmed = cleaned.trim_start_matches('.').trim();
    if trimmed.is_empty() {
        "file".into()
    } else {
        trimmed.to_string()
    }
}

fn header(request: &tauri::ipc::Request<'_>, name: &str) -> Result<String, String> {
    let raw = request
        .headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| format!("No {name} was given."))?;
    urlencoding::decode(raw)
        .map(|s| s.into_owned())
        .map_err(|e| format!("{name} is not valid UTF-8: {e}"))
}

/// Keep a file sent as the raw body, named by the `x-name` header, typed by
/// `x-mime` (or by its name when absent).
#[tauri::command]
pub async fn notebook_file_store(
    app: AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<StoredFile, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("The file must be sent as raw bytes.".into());
    };
    let name = header(&request, "x-name")?;
    let mime = header(&request, "x-mime")
        .ok()
        .filter(|m| !m.is_empty())
        .unwrap_or_else(|| mime_for_name(&name).to_string());
    let dir = dir(&app)?;
    let bytes = bytes.clone();
    let size = bytes.len() as u64;
    let hash = tauri::async_runtime::spawn_blocking(move || store_bytes(&dir, &bytes))
        .await
        .map_err(|e| format!("store task panicked: {e}"))??;
    Ok(StoredFile {
        hash,
        name,
        mime,
        size,
    })
}

/// Keep a copy of the file at `path` (one the user picked or dropped).
#[tauri::command]
pub async fn notebook_file_store_path(app: AppHandle, path: String) -> Result<StoredFile, String> {
    let dir = dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let p = PathBuf::from(&path);
        let (hash, size) = store_path(&dir, &p)?;
        let name = p
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "file".into());
        Ok(StoredFile {
            mime: mime_for_name(&name).to_string(),
            hash,
            name,
            size,
        })
    })
    .await
    .map_err(|e| format!("store task panicked: {e}"))?
}

/// Keep a copy of a file an agent names: `path` inside `workdir` (Chat and
/// the Code tab, confined to the folder like the fs tools), or an absolute
/// path when there's no working folder (the Shell tab, which reads anywhere).
#[tauri::command]
pub async fn notebook_file_store_agent(
    app: AppHandle,
    workdir: Option<String>,
    path: String,
) -> Result<StoredFile, String> {
    let resolved = match workdir.as_deref().filter(|w| !w.is_empty()) {
        Some(w) => crate::fs_tools::path::resolve_in_workdir(
            &crate::fs_tools::path::workdir_path(w)?,
            &path,
        )?,
        None => {
            let p = PathBuf::from(&path);
            if !p.is_absolute() {
                return Err(format!("{path} is not a full path."));
            }
            p
        }
    };
    notebook_file_store_path(app, resolved.to_string_lossy().to_string()).await
}

/// Where a kept file is on disk, for opening it with another app or export.
#[tauri::command]
pub fn notebook_file_path(app: AppHandle, hash: String) -> Result<String, String> {
    Ok(path_of(&dir(&app)?, &hash)?.to_string_lossy().to_string())
}

/// Open a kept file with the app the system uses for its type. The store
/// names files by hash, so a copy named `name` goes in the app's cache
/// first, for the system to tell the type from.
#[tauri::command]
pub async fn notebook_file_open(app: AppHandle, hash: String, name: String) -> Result<(), String> {
    use tauri::Manager;
    let name = safe_name(&name);
    if is_runnable(&name) {
        return Err("This kind of file can run programs, so it isn't opened from a notebook. Use Save a copy… instead.".into());
    }
    let from = path_of(&dir(&app)?, &hash)?;
    let to_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("No cache folder: {e}"))?
        .join("notebook-open")
        .join(&hash[..16]);
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::create_dir_all(&to_dir).map_err(|e| format!("Could not open the file: {e}"))?;
        let to = to_dir.join(&name);
        if !to.exists() {
            std::fs::copy(&from, &to).map_err(|e| format!("Could not open the file: {e}"))?;
        }
        crate::links::open_notebook_copy(&to)
    })
    .await
    .map_err(|e| format!("open task panicked: {e}"))?
}

/// Keep a picture from the image cache (one an image tool made) as a
/// notebook file, so the cache evicting it later can't break the card.
#[tauri::command]
pub async fn notebook_file_from_image(
    app: AppHandle,
    db: tauri::State<'_, Database>,
    hash: String,
) -> Result<StoredFile, String> {
    let row = db
        .image_by_hash(&hash)?
        .ok_or_else(|| "That picture is no longer kept.".to_string())?;
    let src = crate::blob_cache::find(&crate::image_cache::cache_dir(&app)?, &hash, |_| Ok(true))?
        .ok_or_else(|| "That picture is no longer kept.".to_string())?;
    let dir = dir(&app)?;
    let (stored, size) = tauri::async_runtime::spawn_blocking(move || store_path(&dir, &src))
        .await
        .map_err(|e| format!("store task panicked: {e}"))??;
    let ext = row
        .mime
        .rsplit('/')
        .next()
        .unwrap_or("png")
        .replace("jpeg", "jpg");
    Ok(StoredFile {
        hash: stored,
        name: format!("picture.{ext}"),
        mime: row.mime,
        size,
    })
}

/// Save a copy of a kept file to `path`, chosen in a Save dialog.
#[tauri::command]
pub async fn notebook_file_save_as(
    app: AppHandle,
    hash: String,
    path: String,
) -> Result<(), String> {
    let from = path_of(&dir(&app)?, &hash)?;
    blob_cache::save_as(&from, Path::new(&path), "file")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_util::temp_dir;

    #[test]
    fn same_bytes_are_kept_once() {
        let dir = temp_dir("nbfiles-dedupe");
        let a = store_bytes(&dir, b"hello").unwrap();
        let b = store_bytes(&dir, b"hello").unwrap();
        assert_eq!(a, b);
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
    }

    #[test]
    fn store_path_hashes_like_store_bytes() {
        let dir = temp_dir("nbfiles-path");
        let src_dir = temp_dir("nbfiles-src");
        let src = src_dir.join("notes.txt");
        std::fs::write(&src, b"some notes").unwrap();
        let (hash, size) = store_path(&dir, &src).unwrap();
        assert_eq!(hash, blob_cache::hash_bytes(b"some notes"));
        assert_eq!(size, 10);
        assert!(path_of(&dir, &hash).is_ok());
        // No .part left behind.
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
    }

    #[test]
    fn bad_hashes_and_empty_files_are_refused() {
        let dir = temp_dir("nbfiles-bad");
        assert!(path_of(&dir, "../../etc/passwd").is_err());
        assert!(store_bytes(&dir, b"").is_err());
    }

    #[test]
    fn sweep_keeps_what_revisions_still_use() {
        let dir = temp_dir("nbfiles-sweep");
        let db = Database::open_in_memory();
        let kept = store_bytes(&dir, b"old version").unwrap();
        let stray = store_bytes(&dir, b"nobody").unwrap();
        let nb = db.notebook_create("N", &[]).unwrap();
        let card = db
            .notebook_card_add(
                &nb.id,
                None,
                &crate::db::NewCard {
                    kind: "attachment".into(),
                    title: String::new(),
                    body: String::new(),
                    meta: format!(
                        r#"{{"hash":"{kept}","name":"a.txt","mime":"text/plain","size":11}}"#
                    ),
                    rows: None,
                },
                r#"{"kind":"user"}"#,
            )
            .unwrap();
        // Replace the file: the old hash now lives only in a revision.
        let newer = store_bytes(&dir, b"new version").unwrap();
        db.notebook_card_update(
            &card.id,
            card.version,
            None,
            None,
            Some(&format!(
                r#"{{"hash":"{newer}","name":"a.txt","mime":"text/plain","size":11}}"#
            )),
            r#"{"kind":"user"}"#,
        )
        .unwrap();
        sweep(&db, &dir).unwrap();
        assert!(path_of(&dir, &kept).is_ok());
        assert!(path_of(&dir, &newer).is_ok());
        assert!(path_of(&dir, &stray).is_err());
    }

    #[test]
    fn runnable_names_and_safe_names() {
        assert!(is_runnable("setup.EXE"));
        assert!(is_runnable("run.sh"));
        assert!(!is_runnable("report.pdf"));
        assert_eq!(safe_name("../../.bashrc"), "bashrc");
        assert_eq!(safe_name("a/b:c?.pdf"), "b_c_.pdf");
        assert_eq!(safe_name(""), "file");
    }

    #[test]
    fn mime_by_extension() {
        assert_eq!(mime_for_name("a.PDF"), "application/pdf");
        assert_eq!(mime_for_name("photo.jpeg"), "image/jpeg");
        assert_eq!(mime_for_name("noext"), "application/octet-stream");
    }
}
