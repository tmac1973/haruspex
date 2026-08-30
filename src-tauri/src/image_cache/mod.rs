//! On-disk cache for images the model puts in its answers.
//!
//! Images are fetched by Rust rather than by the webview, cached
//! content-addressed under `<app_data_dir>/images/`, and served back over the
//! `haruspex-img://` scheme. Three things fall out of that which a direct
//! `<img src="https://…">` cannot give:
//!
//!   - The user's HTTP proxy applies, because the fetch goes through
//!     `proxy::build_fetch_client` like every other egress in the app.
//!   - Re-opening an old conversation re-reads the disk instead of re-pinging
//!     third-party hosts, so a stored chat is not a beacon.
//!   - The bytes and their licence stay on disk, which is what a later
//!     document-embedding feature needs and cannot reconstruct from a URL.
//!
//! Layout: `db/images.rs` owns the SQL, `fetch.rs` the network and its safety
//! gates, `license.rs` the licence-to-`embeddable` mapping, and this file the
//! files on disk plus the `image_resolve` command that ties them together.
//! `protocol.rs` joins them in the next phase to serve the bytes.

pub mod commands;
pub mod fetch;
pub mod license;

use crate::db::{Database, ImageRow};
use log::{debug, warn};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// One image the caller wants resolved, carrying whatever provenance the tool
/// that surfaced it already knew.
///
/// `image_search` fills all of it. An `og:image` fills only `url` and a
/// `source` of `page_og`, and the licence rules then force that image to
/// display-only regardless of what any other field claims.
#[derive(Clone, Debug, Deserialize, ts_rs::TS)]
#[ts(export)]
pub struct ImageRequest {
    pub url: String,
    pub source: String,
    pub license: Option<String>,
    pub license_version: Option<String>,
    pub attribution: Option<String>,
    pub description_url: Option<String>,
}

/// Per-image ceiling, 5 MB. Comfortably above a full-resolution Commons
/// photograph and far below anything pathological. Tighter than
/// `fs_download_url`'s 50 MB because that path is user-requested and this one
/// fires automatically off model output.
pub const MAX_IMAGE_BYTES: u64 = 5 * 1024 * 1024;

/// Total cache ceiling, 500 MB — thousands of images. A disk limit, not a
/// retention promise: eviction may take an image a stored conversation still
/// references, and because rehydration is lookup-only that image then stops
/// rendering rather than being silently re-fetched.
pub const MAX_CACHE_BYTES: i64 = 500 * 1024 * 1024;

/// `<app_data_dir>/images/`, created if absent.
pub fn cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {}", e))?
        .join("images");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create image cache dir: {}", e))?;
    Ok(dir)
}

/// Path of one cached image. Callers must have validated the hash shape —
/// [`is_valid_hash`] — before calling this.
pub fn image_path(dir: &Path, hash: &str) -> PathBuf {
    dir.join(hash)
}

/// Exactly 64 lowercase hex characters.
///
/// This is the path-traversal guard for the whole module. Because a hash is
/// checked for shape before it is ever joined to the cache directory, `..`,
/// absolute paths and separators cannot be expressed — the protocol handler
/// relies on this, so keep it strict.
pub fn is_valid_hash(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub fn hash_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

/// Write bytes to `<dir>/<hash>` via a `.part` file and an atomic rename.
///
/// The rename is the point: a crash mid-write leaves a `.part` the sweep
/// collects, never a truncated file at the real path that later reads would
/// treat as a valid image.
pub fn write_bytes(dir: &Path, hash: &str, bytes: &[u8]) -> Result<(), String> {
    let final_path = image_path(dir, hash);
    if final_path.exists() {
        return Ok(());
    }
    let part_path = dir.join(format!("{hash}.part"));
    std::fs::write(&part_path, bytes).map_err(|e| format!("Failed to write image bytes: {}", e))?;
    std::fs::rename(&part_path, &final_path).map_err(|e| {
        let _ = std::fs::remove_file(&part_path);
        format!("Failed to commit image bytes: {}", e)
    })
}

/// Drop rows whose bytes push the cache past [`MAX_CACHE_BYTES`], oldest use
/// first. Files go before rows — see `db/images.rs` on why that order.
pub fn evict_to_cap(db: &Database, dir: &Path) -> Result<(), String> {
    let doomed = db.images_to_evict(MAX_CACHE_BYTES)?;
    if doomed.is_empty() {
        return Ok(());
    }
    debug!("image cache over cap; evicting {} images", doomed.len());
    remove_files(dir, &doomed);
    db.delete_images(&doomed)
}

/// Reclaim everything no conversation points at any more, then reconcile the
/// directory against the table.
///
/// Run at startup and after a conversation is deleted. The `ON DELETE CASCADE`
/// on `conversation_images` unlinks; this is what actually frees the bytes,
/// and it is what makes "delete the chat, delete its images" true.
pub fn sweep_orphans(db: &Database, dir: &Path) -> Result<(), String> {
    let orphans = db.unreferenced_image_hashes()?;
    if !orphans.is_empty() {
        debug!("sweeping {} unreferenced images", orphans.len());
        remove_files(dir, &orphans);
        db.delete_images(&orphans)?;
    }

    // Files with no row: leftovers from a crash between the write and the
    // insert, abandoned `.part` files, or a database reset. Nothing will ever
    // read them.
    let known = db.all_image_hashes()?;
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) => {
            warn!("could not scan image cache dir: {}", e);
            return Ok(());
        }
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let is_known = is_valid_hash(&name) && known.iter().any(|h| h == &name);
        if !is_known {
            let _ = std::fs::remove_file(entry.path());
        }
    }
    Ok(())
}

fn remove_files(dir: &Path, hashes: &[String]) {
    for hash in hashes {
        let path = image_path(dir, hash);
        if let Err(e) = std::fs::remove_file(&path) {
            if e.kind() != std::io::ErrorKind::NotFound {
                warn!("failed to remove cached image {}: {}", hash, e);
            }
        }
    }
}

/// Build the row for freshly fetched bytes, applying the licence rules.
pub fn row_for(hash: String, req: &ImageRequest, fetched: &fetch::FetchedImage) -> ImageRow {
    // A scraped image's licence is unknowable, so the page's claims about
    // itself are discarded rather than trusted.
    let verdict = if req.source == "page_og" {
        license::scraped()
    } else {
        license::normalize(req.license.as_deref(), req.license_version.as_deref())
    };

    ImageRow {
        hash,
        source_url: req.url.clone(),
        source: req.source.clone(),
        mime: fetched.mime.clone(),
        width: fetched.width,
        height: fetched.height,
        bytes: fetched.bytes.len() as i64,
        license: Some(verdict.code),
        attribution: req.attribution.clone(),
        description_url: req.description_url.clone(),
        embeddable: verdict.embeddable,
        // Overwritten by the insert, which stamps both timestamps itself.
        created_at: 0,
        last_used_at: 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_validation_rejects_traversal_and_wrong_shapes() {
        let good = "a".repeat(64);
        assert!(is_valid_hash(&good));
        assert!(is_valid_hash(&"0123456789abcdef".repeat(4)));

        assert!(!is_valid_hash("../../etc/passwd"));
        assert!(
            !is_valid_hash(&"A".repeat(64)),
            "uppercase is not our shape"
        );
        assert!(!is_valid_hash(&"a".repeat(63)));
        assert!(!is_valid_hash(&"a".repeat(65)));
        assert!(!is_valid_hash(""));
        assert!(!is_valid_hash(&format!("{}/", "a".repeat(63))));
        assert!(!is_valid_hash(&"g".repeat(64)), "g is not hex");
    }

    #[test]
    fn identical_bytes_hash_identically() {
        assert_eq!(hash_bytes(b"same"), hash_bytes(b"same"));
        assert_ne!(hash_bytes(b"same"), hash_bytes(b"different"));
        assert_eq!(hash_bytes(b"x").len(), 64);
    }

    /// Matches the `temp_repo` idiom in `code_tools.rs` — a named directory
    /// under the system temp dir, wiped on entry, rather than a new dependency
    /// just for tests.
    fn temp_cache(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("haruspex_image_test_{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn write_is_atomic_and_idempotent() {
        let dir = temp_cache("write");
        let hash = hash_bytes(b"payload");

        write_bytes(&dir, &hash, b"payload").unwrap();
        assert_eq!(std::fs::read(image_path(&dir, &hash)).unwrap(), b"payload");

        // A second write of the same hash is a no-op, not an error.
        write_bytes(&dir, &hash, b"payload").unwrap();

        // No .part file survives a successful write.
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().ends_with(".part"))
            .collect();
        assert!(leftovers.is_empty(), "a .part file was left behind");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn scraped_source_ignores_any_licence_the_page_claims() {
        let fetched = fetch::FetchedImage {
            bytes: vec![1, 2, 3],
            mime: "image/png".to_string(),
            width: 10,
            height: 10,
        };
        let row = row_for(
            "h".to_string(),
            &ImageRequest {
                url: "https://example.com/x.png".to_string(),
                source: "page_og".to_string(),
                license: Some("CC BY 4.0".to_string()),
                license_version: None,
                attribution: None,
                description_url: None,
            },
            &fetched,
        );
        assert_eq!(row.license.as_deref(), Some("unknown"));
        assert!(
            !row.embeddable,
            "a scraped image must never be marked embeddable"
        );
    }

    #[test]
    fn commons_licence_flows_into_the_row() {
        let fetched = fetch::FetchedImage {
            bytes: vec![1, 2, 3],
            mime: "image/jpeg".to_string(),
            width: 10,
            height: 10,
        };
        let row = row_for(
            "h".to_string(),
            &ImageRequest {
                url: "https://upload.wikimedia.org/x.jpg".to_string(),
                source: "commons".to_string(),
                license: Some("CC BY-SA 4.0".to_string()),
                license_version: None,
                attribution: Some("A Photographer".to_string()),
                description_url: Some("https://commons.wikimedia.org/wiki/File:X.jpg".to_string()),
            },
            &fetched,
        );
        assert_eq!(row.license.as_deref(), Some("cc-by-sa-4.0"));
        assert!(row.embeddable);
        assert_eq!(row.attribution.as_deref(), Some("A Photographer"));
    }
}
