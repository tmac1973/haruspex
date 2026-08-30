//! The `image_resolve` command: turn URLs the frontend has already vetted into
//! cached images the renderer can display.
//!
//! **This command does not decide eligibility.** The caller does, against a
//! per-conversation allowlist built from that conversation's own tool results.
//! By the time a URL arrives here it is already approved; what happens here is
//! the fetching, the safety gates and the bookkeeping.
//!
//! Failures are omitted from the result rather than reported. An image that
//! cannot be fetched is one the reply simply will not show, and the renderer
//! already drops anything it has no entry for — so there is no error state to
//! design, no broken icon, and no retry the user could meaningfully make.

use super::{
    cache_dir, evict_to_cap, fetch, hash_bytes, row_for, sweep_orphans, write_bytes, ImageRequest,
};
use crate::db::{Database, ImageRow};
use crate::proxy::ProxyConfig;
use futures_util::stream::{FuturesUnordered, StreamExt};
use log::debug;
use tauri::{AppHandle, State};

/// How many images to fetch at once. Three is the per-message cap, so four
/// covers a full message plus a rehydrating conversation without opening a
/// burst of connections to one host.
const CONCURRENCY: usize = 4;

/// Resolve images for one conversation.
///
/// Returns a row per image that is now cached and displayable, in no
/// particular order. A URL absent from the result could not be fetched; the
/// caller treats that as "no image".
///
/// `lookup_only` makes this a pure cache read: hits are returned and linked,
/// misses are dropped, nothing is fetched. Re-opening an old conversation uses
/// it, because the tool steps that established which URLs were eligible are
/// long gone by then — a cached row carries that permission forward, a miss
/// proves nothing. Enforcing it here rather than trusting the caller not to
/// ask means a frontend mistake cannot turn a stored message into a request.
#[tauri::command]
pub async fn image_resolve(
    app: AppHandle,
    db: State<'_, Database>,
    conversation_id: String,
    requests: Vec<ImageRequest>,
    proxy: Option<ProxyConfig>,
    lookup_only: Option<bool>,
) -> Result<Vec<ImageRow>, String> {
    if requests.is_empty() {
        return Ok(Vec::new());
    }
    let dir = cache_dir(&app)?;
    let mut resolved: Vec<ImageRow> = Vec::new();
    let mut pending: Vec<ImageRequest> = Vec::new();

    // Cache first. A hit costs one indexed lookup and no network at all, which
    // is what makes re-opening an old conversation silent.
    for req in requests {
        match db.image_by_source_url(&req.url)? {
            Some(row) => {
                db.link_image(&conversation_id, &row.hash)?;
                resolved.push(row);
            }
            None => pending.push(req),
        }
    }

    if lookup_only.unwrap_or(false) {
        // Misses stay missing. The image simply does not render.
        return Ok(resolved);
    }

    if !pending.is_empty() {
        let proxy_ref = proxy.as_ref();
        let mut in_flight = FuturesUnordered::new();
        let mut queue = pending.into_iter();

        for _ in 0..CONCURRENCY {
            if let Some(req) = queue.next() {
                in_flight.push(fetch_one(req, proxy_ref));
            }
        }

        while let Some(outcome) = in_flight.next().await {
            if let Some(req) = queue.next() {
                in_flight.push(fetch_one(req, proxy_ref));
            }
            let (req, fetched) = outcome;
            let fetched = match fetched {
                Ok(f) => f,
                Err(e) => {
                    // Expected often enough to be routine: dead hosts, hotlink
                    // protection, a URL that was never an image. Debug, not
                    // warn — this is not a fault the user can act on.
                    debug!("image unresolved {}: {}", req.url, e);
                    continue;
                }
            };

            let hash = hash_bytes(&fetched.bytes);
            if let Err(e) = write_bytes(&dir, &hash, &fetched.bytes) {
                debug!("image not cached {}: {}", req.url, e);
                continue;
            }

            let row = row_for(hash, &req, &fetched);
            db.insert_image(&row)?;
            db.link_image(&conversation_id, &row.hash)?;

            // Re-read so the caller gets the row that actually won, which
            // matters when identical bytes were already cached under different
            // provenance — the first record is kept, not this one.
            match db.image_by_source_url(&req.url)? {
                Some(stored) => resolved.push(stored),
                None => resolved.push(row),
            }
        }
    }

    evict_to_cap(&db, &dir)?;
    Ok(resolved)
}

/// Fetch one image, carrying its request through so the caller still knows
/// which URL an outcome belongs to.
async fn fetch_one(
    req: ImageRequest,
    proxy: Option<&ProxyConfig>,
) -> (ImageRequest, Result<fetch::FetchedImage, String>) {
    let result = fetch::fetch_image(&req.url, proxy).await;
    (req, result)
}

/// Reclaim images no conversation references any more.
///
/// Called at startup and after a conversation is deleted. Separate from
/// `image_resolve` because the cascade that unlinks them runs on the delete
/// path, which knows nothing about the cache directory.
#[tauri::command]
pub async fn image_sweep(app: AppHandle, db: State<'_, Database>) -> Result<(), String> {
    let dir = cache_dir(&app)?;
    sweep_orphans(&db, &dir)
}
