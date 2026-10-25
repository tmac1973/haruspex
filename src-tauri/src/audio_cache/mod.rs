//! On-disk cache for audio the app generated (music today).
//!
//! The server that made a song keeps it for a day at most (llama-toolchest
//! prunes music jobs after 24 h), so Haruspex keeps its own copy:
//! content-addressed under `<app_data_dir>/audio/`, served over the
//! `haruspex-audio://` scheme with Range support so a player can seek, and to
//! Settings → Remote control's page over `/api/v1/audio/<hash>`.
//!
//! It mirrors `image_cache` in shape (hash-named files, rows in `db/audio.rs`,
//! a startup sweep) but not in policy. Linked audio is the user's work and is
//! never evicted; only unlinked audio is, and unlinked audio survives an hour
//! after it was made so a chat not saved yet, or Settings → Music's test clip,
//! does not lose it on the next start.

pub mod commands;
pub mod protocol;
pub mod range;

use crate::db::{AudioRow, Database};
use crate::image_cache::is_valid_hash;
use log::{debug, warn};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// Per-file ceiling, 50 MiB: a 240 s 16-bit stereo WAV is about 46 MB.
pub const MAX_AUDIO_BYTES: u64 = 50 * 1024 * 1024;

/// Unlinked audio is evicted, oldest play first, while the cache is over
/// this. Linked audio is not, so the total may exceed it.
pub const MAX_AUDIO_CACHE_BYTES: i64 = 2 * 1024 * 1024 * 1024;

/// How long unlinked audio is kept before the sweep may take it.
pub const UNLINKED_GRACE_MS: i64 = 60 * 60 * 1000;

/// `<app_data_dir>/audio/`, created if absent.
pub fn cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {}", e))?
        .join("audio");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create audio cache dir: {}", e))?;
    Ok(dir)
}

/// Path of one cached file. Callers validate the hash first.
pub fn audio_path(dir: &Path, hash: &str) -> PathBuf {
    dir.join(hash)
}

/// The audio types the cache stores, with the aliases servers use folded
/// into one spelling. Anything else is refused.
pub fn normalize_mime(mime: &str) -> Option<&'static str> {
    let base = mime
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    match base.as_str() {
        "audio/mpeg" | "audio/mp3" => Some("audio/mpeg"),
        "audio/wav" | "audio/x-wav" | "audio/wave" | "audio/vnd.wave" => Some("audio/wav"),
        "audio/ogg" => Some("audio/ogg"),
        "audio/flac" | "audio/x-flac" => Some("audio/flac"),
        _ => None,
    }
}

/// Where a stored file came from and what it's linked to.
pub struct StoreMeta<'a> {
    pub mime: &'static str,
    pub title: Option<String>,
    pub duration_ms: Option<i64>,
    pub conversation_id: Option<&'a str>,
    pub code_session_id: Option<&'a str>,
}

/// Move a fully written temp file into the cache as `hash`, insert its row,
/// link it, and evict to the cap. The temp file is consumed either way.
pub fn commit_file(
    db: &Database,
    dir: &Path,
    temp: &Path,
    hash: &str,
    bytes: u64,
    meta: &StoreMeta,
) -> Result<(), String> {
    let final_path = audio_path(dir, hash);
    if final_path.exists() {
        let _ = std::fs::remove_file(temp);
    } else if let Err(e) = std::fs::rename(temp, &final_path) {
        let _ = std::fs::remove_file(temp);
        return Err(format!("Failed to commit audio: {}", e));
    }
    if db.audio_by_hash(hash)?.is_some() {
        db.touch_audio(hash)?;
    } else {
        db.insert_audio(&AudioRow {
            hash: hash.to_string(),
            mime: meta.mime.to_string(),
            bytes: bytes as i64,
            duration_ms: meta.duration_ms,
            title: meta.title.clone(),
            source: "generated".into(),
            created_at: 0,
            last_used_at: 0,
        })?;
    }
    link_best_effort(db, meta.conversation_id, meta.code_session_id, hash);
    evict_to_cap(db, dir)
}

/// Link audio to a chat or Code session, logging rather than failing: a chat
/// not saved yet has no row to link to, and is linked again when its message
/// is shown (`audio_rehydrate`).
pub fn link_best_effort(
    db: &Database,
    conversation_id: Option<&str>,
    code_session_id: Option<&str>,
    hash: &str,
) {
    if let Some(id) = conversation_id {
        if let Err(e) = db.link_audio_to_conversation(id, hash) {
            debug!("could not link audio {hash} to chat {id} yet: {e}");
        }
    }
    if let Some(id) = code_session_id {
        if let Err(e) = db.link_audio_to_code_session(id, hash) {
            debug!("could not link audio {hash} to code session {id}: {e}");
        }
    }
}

/// Drop unlinked audio, oldest play first, while over [`MAX_AUDIO_CACHE_BYTES`].
pub fn evict_to_cap(db: &Database, dir: &Path) -> Result<(), String> {
    evict_to(db, dir, MAX_AUDIO_CACHE_BYTES)
}

fn evict_to(db: &Database, dir: &Path, cap: i64) -> Result<(), String> {
    let doomed = db.audio_to_evict(cap)?;
    if doomed.is_empty() {
        return Ok(());
    }
    debug!("audio cache over cap; evicting {} files", doomed.len());
    remove_files(dir, &doomed);
    db.delete_audio(&doomed)
}

/// Free unlinked audio older than the grace period, then delete files that
/// have no row (crash leftovers, `.part` files). Run at startup.
pub fn sweep_orphans(db: &Database, dir: &Path, now_ms: i64) -> Result<(), String> {
    let orphans = db.unlinked_audio_before(now_ms - UNLINKED_GRACE_MS)?;
    if !orphans.is_empty() {
        debug!("sweeping {} unlinked audio files", orphans.len());
        remove_files(dir, &orphans);
        db.delete_audio(&orphans)?;
    }
    let known = db.all_audio_hashes()?;
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) => {
            warn!("could not scan audio cache dir: {}", e);
            return Ok(());
        }
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !(is_valid_hash(&name) && known.iter().any(|h| h == &name)) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
    Ok(())
}

/// Delete every unlinked file now, grace period or not: Settings → Music's
/// "Clear unused audio".
pub fn clear_unlinked(db: &Database, dir: &Path) -> Result<(), String> {
    let doomed = db.unlinked_audio_before(i64::MAX)?;
    remove_files(dir, &doomed);
    db.delete_audio(&doomed)
}

fn remove_files(dir: &Path, hashes: &[String]) {
    for hash in hashes {
        if let Err(e) = std::fs::remove_file(audio_path(dir, hash)) {
            if e.kind() != std::io::ErrorKind::NotFound {
                warn!("failed to remove cached audio {}: {}", hash, e);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::code_tools::wsl::CodeLocation;
    use crate::image_cache::hash_bytes;
    use crate::test_util::{temp_dir, TestDir};

    fn setup(name: &str) -> (Database, TestDir) {
        let db = Database::open_in_memory();
        db.create_conversation("chat-1", "Chat").unwrap();
        (db, temp_dir(name))
    }

    fn store(
        db: &Database,
        dir: &Path,
        body: &[u8],
        chat: Option<&str>,
        code: Option<&str>,
    ) -> String {
        let hash = hash_bytes(body);
        let temp = dir.join("t.part");
        std::fs::write(&temp, body).unwrap();
        let meta = StoreMeta {
            mime: "audio/mpeg",
            title: Some("Song".into()),
            duration_ms: None,
            conversation_id: chat,
            code_session_id: code,
        };
        commit_file(db, dir, &temp, &hash, body.len() as u64, &meta).unwrap();
        hash
    }

    /// Long after any grace period.
    fn later() -> i64 {
        crate::time_util::now_ms() + 2 * UNLINKED_GRACE_MS
    }

    #[test]
    fn audio_linked_to_a_chat_or_a_code_session_survives_the_sweep() {
        let (db, dir) = setup("audio-linked");
        let location = CodeLocation {
            wsl_distro: None,
            root: dir.to_string_lossy().to_string(),
        };
        let session = db.create_code_session_at(&location, None, None).unwrap();
        let chat = store(&db, &dir, b"chat song", Some("chat-1"), None);
        let code = store(&db, &dir, b"code song", None, Some(&session.id));
        sweep_orphans(&db, &dir, later()).unwrap();
        assert!(db.audio_by_hash(&chat).unwrap().is_some());
        assert!(db.audio_by_hash(&code).unwrap().is_some());
        assert!(audio_path(&dir, &code).exists());

        db.delete_code_session(&session.id).unwrap();
        sweep_orphans(&db, &dir, later()).unwrap();
        assert!(
            db.audio_by_hash(&code).unwrap().is_none(),
            "freed with its session"
        );
        assert!(!audio_path(&dir, &code).exists());
    }

    #[test]
    fn unlinked_audio_keeps_for_an_hour_then_goes() {
        let (db, dir) = setup("audio-grace");
        let hash = store(&db, &dir, b"test clip", None, None);
        sweep_orphans(&db, &dir, crate::time_util::now_ms()).unwrap();
        assert!(
            db.audio_by_hash(&hash).unwrap().is_some(),
            "inside the hour"
        );
        sweep_orphans(&db, &dir, later()).unwrap();
        assert!(db.audio_by_hash(&hash).unwrap().is_none(), "after it");
        assert!(!audio_path(&dir, &hash).exists());
    }

    #[test]
    fn a_chat_not_saved_yet_does_not_fail_the_store() {
        let (db, dir) = setup("audio-unsaved");
        let hash = store(&db, &dir, b"early", Some("no-such-chat"), None);
        assert!(db.audio_by_hash(&hash).unwrap().is_some());
    }

    #[test]
    fn eviction_takes_unlinked_audio_only() {
        let (db, dir) = setup("audio-evict");
        let linked = store(&db, &dir, &[1u8; 100], Some("chat-1"), None);
        let loose = store(&db, &dir, &[2u8; 100], None, None);
        evict_to(&db, &dir, 50).unwrap();
        assert!(
            db.audio_by_hash(&linked).unwrap().is_some(),
            "linked is never evicted"
        );
        assert!(db.audio_by_hash(&loose).unwrap().is_none());
        // Still over the cap, with nothing left it may take.
        evict_to(&db, &dir, 50).unwrap();
        assert!(db.audio_by_hash(&linked).unwrap().is_some());
    }

    #[test]
    fn clearing_leaves_linked_audio_alone() {
        let (db, dir) = setup("audio-clear");
        let linked = store(&db, &dir, b"keep", Some("chat-1"), None);
        let loose = store(&db, &dir, b"drop", None, None);
        clear_unlinked(&db, &dir).unwrap();
        assert!(db.audio_by_hash(&linked).unwrap().is_some());
        assert!(db.audio_by_hash(&loose).unwrap().is_none());
    }

    #[test]
    fn storing_the_same_bytes_twice_links_both() {
        let (db, dir) = setup("audio-twice");
        db.create_conversation("chat-2", "Other").unwrap();
        let hash = store(&db, &dir, b"same", Some("chat-1"), None);
        store(&db, &dir, b"same", Some("chat-2"), None);
        db.delete_conversation("chat-1").unwrap();
        sweep_orphans(&db, &dir, later()).unwrap();
        assert!(db.audio_by_hash(&hash).unwrap().is_some(), "still chat-2's");
    }

    #[test]
    fn stray_files_are_swept() {
        let (db, dir) = setup("audio-stray");
        std::fs::write(dir.join("leftover.part"), b"x").unwrap();
        std::fs::write(dir.join("b".repeat(64)), b"x").unwrap();
        sweep_orphans(&db, &dir, crate::time_util::now_ms()).unwrap();
        assert_eq!(std::fs::read_dir(&*dir).unwrap().count(), 0);
    }

    #[test]
    fn mime_aliases_fold_and_others_are_refused() {
        assert_eq!(normalize_mime("audio/mpeg"), Some("audio/mpeg"));
        assert_eq!(normalize_mime("audio/x-wav"), Some("audio/wav"));
        assert_eq!(normalize_mime("Audio/WAV; codecs=1"), Some("audio/wav"));
        assert_eq!(normalize_mime("audio/flac"), Some("audio/flac"));
        assert_eq!(normalize_mime("text/html"), None);
        assert_eq!(normalize_mime(""), None);
    }
}
