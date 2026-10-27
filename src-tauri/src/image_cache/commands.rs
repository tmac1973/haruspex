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
                    debug!(
                        "image unresolved {}: {}",
                        crate::text_util::url_for_log(&req.url),
                        e
                    );
                    continue;
                }
            };

            let hash = hash_bytes(&fetched.bytes);
            if let Err(e) = write_bytes(&dir, &hash, &fetched.bytes) {
                debug!(
                    "image not cached {}: {}",
                    crate::text_util::url_for_log(&req.url),
                    e
                );
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

/// Store bytes the app produced itself, and return their hash.
///
/// The cache exists for images fetched from the web, but its storage half is
/// exactly what a locally generated image needs: content-addressed on disk,
/// served to the webview over `haruspex-img://`, swept when nothing references
/// it. Going through it rather than a `data:` URL keeps a multi-megabyte PNG
/// out of the DOM and out of the conversation.
///
/// Three things differ from `image_resolve` and each is deliberate:
///
///   - there is no URL, so `source_url` carries the synthetic
///     `haruspex-generated:<hash>` — the column is `UNIQUE`, and a constant
///     would make the second generated image collide with the first;
///   - `source` is `generated`, which the licence rules do not treat as a
///     scrape, because we made these pixels;
///   - `embeddable` is true. Nothing was borrowed, so nothing is encumbered.
///
/// With a `conversation_id` the image is linked to that conversation, so the
/// startup sweep keeps it: unlinked, a picture drawn in chat was deleted the
/// next time the app started.
#[tauri::command]
pub async fn image_store_bytes(
    app: AppHandle,
    db: State<'_, Database>,
    bytes: Vec<u8>,
    mime: String,
    width: u32,
    height: u32,
    conversation_id: Option<String>,
) -> Result<String, String> {
    let dir = cache_dir(&app)?;
    store_generated(
        &db,
        &dir,
        &bytes,
        mime,
        width,
        height,
        conversation_id.as_deref(),
    )
}

/// An upscaled picture, kept: its hash and the size it was finished at.
#[derive(serde::Serialize, ts_rs::TS)]
#[ts(export)]
pub struct StoredUpscale {
    pub hash: String,
    pub width: u32,
    pub height: u32,
}

/// A picture to edit part of: a cached one by hash, or its bytes.
#[derive(serde::Deserialize, ts_rs::TS)]
#[ts(export)]
pub struct MaskSource {
    pub hash: Option<String>,
    pub bytes: Option<Vec<u8>>,
}

/// The canvas an edit to part of a picture runs on and the mask it is held
/// to, both kept in the image cache, and the canvas's size.
#[derive(serde::Serialize, ts_rs::TS)]
#[ts(export)]
pub struct PreparedEdit {
    pub canvas: String,
    pub mask: String,
    pub width: u32,
    pub height: u32,
}

fn png_of(img: &image::DynamicImage) -> Result<Vec<u8>, String> {
    let mut png = Vec::new();
    img.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .map_err(|e| format!("Could not encode the picture: {e}"))?;
    Ok(png)
}

/// The canvas and mask for `edit_image`'s `area` or `extend`
/// (`image_gen::mask`), kept in the cache so the edit sends them by hash.
#[tauri::command]
pub async fn image_mask_prepare(
    app: AppHandle,
    db: State<'_, Database>,
    source: MaskSource,
    area: Option<crate::image_gen::mask::MaskArea>,
    extend: Option<crate::image_gen::mask::MaskExtend>,
    conversation_id: Option<String>,
) -> Result<PreparedEdit, String> {
    let dir = cache_dir(&app)?;
    let bytes = match (source.hash, source.bytes) {
        (Some(hash), _) => read_cached(&db, &dir, &hash)?,
        (None, Some(bytes)) => bytes,
        (None, None) => return Err("No picture was given.".into()),
    };
    let (canvas, mask) = tokio::task::spawn_blocking(move || {
        let src = image::load_from_memory(&bytes)
            .map_err(|e| format!("Could not read the picture: {e}"))?
            .to_rgba8();
        let p = crate::image_gen::mask::prepare(&src, area, extend)?;
        let (w, h) = p.canvas.dimensions();
        Ok::<_, String>((
            (png_of(&image::DynamicImage::ImageRgba8(p.canvas))?, w, h),
            png_of(&image::DynamicImage::ImageLuma8(p.mask))?,
        ))
    })
    .await
    .map_err(|e| format!("The edit could not be prepared: {e}"))??;
    let ((canvas, width, height), mask) = (canvas, mask);
    let conversation = conversation_id.as_deref();
    let keep = |png: &[u8]| {
        store_generated(
            &db,
            &dir,
            png,
            "image/png".into(),
            width,
            height,
            conversation,
        )
    };
    Ok(PreparedEdit {
        canvas: keep(&canvas)?,
        mask: keep(&mask)?,
        width,
        height,
    })
}

/// How much an edit changed where its mask allows (`image_gen::mask::masked_change`),
/// 0–255: the backend's picture as the raw body, the cached canvas and mask
/// named by `x-canvas-hash` and `x-mask-hash`.
#[tauri::command]
pub async fn image_mask_change(
    app: AppHandle,
    db: State<'_, Database>,
    request: tauri::ipc::Request<'_>,
) -> Result<f32, String> {
    let tauri::ipc::InvokeBody::Raw(edited) = request.body() else {
        return Err("The edited picture must be sent as raw bytes.".into());
    };
    let canvas = header(&request, "x-canvas-hash").ok_or("No x-canvas-hash was given.")?;
    let mask = header(&request, "x-mask-hash").ok_or("No x-mask-hash was given.")?;
    let dir = cache_dir(&app)?;
    let (canvas, mask) = (
        read_cached(&db, &dir, canvas)?,
        read_cached(&db, &dir, mask)?,
    );
    let edited = edited.clone();
    tokio::task::spawn_blocking(move || {
        let load = |b: &[u8], what: &str| {
            image::load_from_memory(b).map_err(|e| format!("Could not read the {what}: {e}"))
        };
        Ok(crate::image_gen::mask::masked_change(
            &load(&canvas, "canvas")?.to_rgba8(),
            &load(&edited, "edited picture")?.to_rgba8(),
            &load(&mask, "mask")?.to_luma8(),
        ))
    })
    .await
    .map_err(|e| format!("The edit could not be measured: {e}"))?
}

/// An edit held to its mask: the backend's picture arrives as the raw body and
/// is pasted over the cached canvas `x-canvas-hash` through the cached mask
/// `x-mask-hash`. Answers the finished PNG's bytes, which `edit_image` keeps
/// like any other edit.
#[tauri::command]
pub async fn image_mask_finish(
    app: AppHandle,
    db: State<'_, Database>,
    request: tauri::ipc::Request<'_>,
) -> Result<tauri::ipc::Response, String> {
    let tauri::ipc::InvokeBody::Raw(edited) = request.body() else {
        return Err("The edited picture must be sent as raw bytes.".into());
    };
    let canvas = header(&request, "x-canvas-hash").ok_or("No x-canvas-hash was given.")?;
    let mask = header(&request, "x-mask-hash").ok_or("No x-mask-hash was given.")?;
    let dir = cache_dir(&app)?;
    let (canvas, mask) = (
        read_cached(&db, &dir, canvas)?,
        read_cached(&db, &dir, mask)?,
    );
    let edited = edited.clone();
    let png = tokio::task::spawn_blocking(move || {
        let load = |b: &[u8], what: &str| {
            image::load_from_memory(b).map_err(|e| format!("Could not read the {what}: {e}"))
        };
        let out = crate::image_gen::mask::composite(
            &load(&canvas, "canvas")?.to_rgba8(),
            &load(&edited, "edited picture")?.to_rgba8(),
            &load(&mask, "mask")?.to_luma8(),
        );
        png_of(&image::DynamicImage::ImageRgba8(out))
    })
    .await
    .map_err(|e| format!("The edit could not be finished: {e}"))??;
    Ok(tauri::ipc::Response::new(png))
}

fn header<'a>(request: &'a tauri::ipc::Request<'_>, name: &str) -> Option<&'a str> {
    request.headers().get(name).and_then(|v| v.to_str().ok())
}

/// Finish an upscale and keep it: the engine's result arrives as the raw body
/// (it can be 20 MB or more, too much for a JSON number array), resized to
/// `x-width`×`x-height` with the alpha of the cached source `x-source-hash` put
/// back ([`crate::image_gen::upscale::finish_upscale`]), stored as a generated
/// picture and linked to `x-conversation-id` when there is one.
#[tauri::command]
pub async fn image_store_upscaled(
    app: AppHandle,
    db: State<'_, Database>,
    request: tauri::ipc::Request<'_>,
) -> Result<StoredUpscale, String> {
    let tauri::ipc::InvokeBody::Raw(upscaled) = request.body() else {
        return Err("The upscaled picture must be sent as raw bytes.".into());
    };
    let size = |name: &str| -> Result<u32, String> {
        header(&request, name)
            .and_then(|v| v.parse().ok())
            .ok_or_else(|| format!("No {name} was given."))
    };
    let (width, height) = (size("x-width")?, size("x-height")?);
    let hash = header(&request, "x-source-hash").ok_or("No x-source-hash was given.")?;
    let conversation = header(&request, "x-conversation-id").map(str::to_string);
    let dir = cache_dir(&app)?;
    let source = read_cached(&db, &dir, hash)?;
    let upscaled = upscaled.clone();
    let finished = tokio::task::spawn_blocking(move || {
        crate::image_gen::upscale::finish_upscale(&upscaled, &source, width, height)
    })
    .await
    .map_err(|e| format!("The upscale could not be finished: {e}"))??;
    let hash = store_generated(
        &db,
        &dir,
        &finished.png,
        "image/png".into(),
        finished.width,
        finished.height,
        conversation.as_deref(),
    )?;
    Ok(StoredUpscale {
        hash,
        width: finished.width,
        height: finished.height,
    })
}

/// [`image_store_bytes`], with what it needs passed in, so it can be tested.
pub fn store_generated(
    db: &Database,
    dir: &std::path::Path,
    bytes: &[u8],
    mime: String,
    width: u32,
    height: u32,
    conversation_id: Option<&str>,
) -> Result<String, String> {
    check_storable(bytes)?;
    let hash = hash_bytes(bytes);

    // Identical bytes are the same image. Writing is already idempotent; this
    // keeps the row's timestamps honest too. Linked first: the same picture
    // drawn into a second conversation belongs to both.
    if let Some(row) = db.image_by_hash(&hash)? {
        write_bytes(dir, &hash, bytes)?;
        db.touch_images(std::slice::from_ref(&row.hash))?;
        link_best_effort(db, conversation_id, &hash);
        return Ok(hash);
    }

    write_bytes(dir, &hash, bytes)?;
    db.insert_image(&ImageRow {
        hash: hash.clone(),
        source_url: format!("haruspex-generated:{hash}"),
        source: "generated".into(),
        mime,
        width,
        height,
        bytes: bytes.len() as i64,
        license: None,
        attribution: None,
        description_url: None,
        embeddable: true,
        created_at: 0,
        last_used_at: 0,
    })?;
    link_best_effort(db, conversation_id, &hash);
    evict_to_cap(db, dir)?;
    debug!("stored generated image {hash}");
    Ok(hash)
}

/// Link an image to a conversation, logging rather than failing: a chat that
/// is not saved yet has no row to link to, and the image is linked again when
/// its message is shown (`image_rehydrate_local`).
fn link_best_effort(db: &Database, conversation_id: Option<&str>, hash: &str) {
    if let Some(id) = conversation_id {
        if let Err(e) = db.link_image(id, hash) {
            debug!("could not link generated image {hash} to {id} yet: {e}");
        }
    }
}

/// The images a conversation's messages show by hash, linked to it.
///
/// A generated image's message holds its `haruspex-img` URL, not a source URL,
/// so the lookup by source URL that rehydrates fetched pictures misses it.
/// This looks it up by hash instead, and links it, so the startup sweep keeps
/// it however the earlier link went. Unknown hashes are skipped.
#[tauri::command]
pub async fn image_rehydrate_local(
    db: State<'_, Database>,
    conversation_id: String,
    hashes: Vec<String>,
) -> Result<Vec<ImageRow>, String> {
    rehydrate_local(&db, &conversation_id, &hashes)
}

pub fn rehydrate_local(
    db: &Database,
    conversation_id: &str,
    hashes: &[String],
) -> Result<Vec<ImageRow>, String> {
    let mut rows = Vec::new();
    for hash in hashes {
        if !super::is_valid_hash(hash) {
            continue;
        }
        if let Some(row) = db.image_by_hash(hash)? {
            link_best_effort(db, Some(conversation_id), hash);
            rows.push(row);
        }
    }
    Ok(rows)
}

/// One cached picture's bytes, for a tool saving it into a folder
/// (`save_generated`, `generate_image` with a `path`). As a raw response, not
/// a number array.
#[tauri::command]
pub async fn image_read_bytes(
    app: AppHandle,
    db: State<'_, Database>,
    hash: String,
) -> Result<tauri::ipc::Response, String> {
    read_cached(&db, &cache_dir(&app)?, &hash).map(tauri::ipc::Response::new)
}

/// A cached picture's bytes by hash, or why not.
pub fn read_cached(db: &Database, dir: &std::path::Path, hash: &str) -> Result<Vec<u8>, String> {
    std::fs::read(cached_path(db, dir, hash)?).map_err(|_| NOT_FOUND.to_string())
}

const NOT_FOUND: &str = "Image not found";

fn cached_path(
    db: &Database,
    dir: &std::path::Path,
    hash: &str,
) -> Result<std::path::PathBuf, String> {
    crate::blob_cache::find(dir, hash, |h| Ok(db.image_by_hash(h)?.is_some()))?
        .ok_or_else(|| NOT_FOUND.to_string())
}

/// Copy a cached picture to `path`, the file the user chose in the image
/// viewer's Save as dialog (which asked about replacing a file already).
#[tauri::command]
pub async fn image_save_as(
    app: AppHandle,
    db: State<'_, Database>,
    hash: String,
    path: String,
) -> Result<(), String> {
    let from = cached_path(&db, &cache_dir(&app)?, &hash)?;
    crate::blob_cache::save_as(&from, std::path::Path::new(&path), "picture")
}

/// The guards on [`image_store_bytes`], split out because the command itself
/// needs an `AppHandle` and a `Database` and so cannot be unit tested.
///
/// An empty body is refused rather than stored: it would hash, write a
/// zero-byte file, and serve a broken image forever, which is worse than a
/// visible error at the point of failure. The limit is the one for pictures we
/// made ([`super::MAX_GENERATED_BYTES`]), which an upscaled one needs.
pub fn check_storable(bytes: &[u8]) -> Result<(), String> {
    if bytes.is_empty() {
        return Err("Refusing to store an empty image.".into());
    }
    if bytes.len() as u64 > super::MAX_GENERATED_BYTES {
        return Err(format!(
            "Image is {} bytes, over the {} byte cache limit.",
            bytes.len(),
            super::MAX_GENERATED_BYTES
        ));
    }
    Ok(())
}

#[cfg(test)]
mod store_tests {
    use super::*;

    #[test]
    fn refuses_an_empty_body() {
        let err = check_storable(&[]).unwrap_err();
        assert!(err.contains("empty"), "{err}");
    }

    #[test]
    fn refuses_a_body_over_the_cache_ceiling() {
        let too_big = vec![0u8; (super::super::MAX_GENERATED_BYTES + 1) as usize];
        let err = check_storable(&too_big).unwrap_err();
        assert!(err.contains("over the"), "{err}");
    }

    #[test]
    fn accepts_a_body_exactly_at_the_ceiling() {
        let exact = vec![0u8; super::super::MAX_GENERATED_BYTES as usize];
        assert!(check_storable(&exact).is_ok());
    }

    #[test]
    fn accepts_an_ordinary_png() {
        assert!(check_storable(&[137, 80, 78, 71]).is_ok());
    }
}

#[cfg(test)]
mod generated_tests {
    use super::*;
    use crate::test_util::{temp_dir, TestDir};

    fn png() -> Vec<u8> {
        let mut out = Vec::new();
        image::RgbaImage::from_pixel(4, 4, image::Rgba([10, 20, 30, 255]))
            .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
            .unwrap();
        out
    }

    fn setup(name: &str) -> (Database, TestDir) {
        let db = Database::open_in_memory();
        db.create_conversation("chat-1", "Chat").unwrap();
        (db, temp_dir(name))
    }

    #[test]
    fn cached_bytes_read_back_and_unknown_hashes_do_not() {
        let (db, dir) = setup("read-cached");
        let hash =
            store_generated(&db, &dir, &png(), "image/png".into(), 4, 4, Some("chat-1")).unwrap();
        assert_eq!(read_cached(&db, &dir, &hash).unwrap(), png());
        assert_eq!(
            read_cached(&db, &dir, &"f".repeat(64)).unwrap_err(),
            "Image not found"
        );
        assert_eq!(
            read_cached(&db, &dir, "../x").unwrap_err(),
            "Image not found"
        );
    }

    #[test]
    fn a_generated_image_linked_to_its_chat_survives_the_sweep() {
        let (db, dir) = setup("linked");
        let hash =
            store_generated(&db, &dir, &png(), "image/png".into(), 4, 4, Some("chat-1")).unwrap();
        super::super::sweep_orphans(&db, &dir).unwrap();
        assert!(db.image_by_hash(&hash).unwrap().is_some(), "kept");
    }

    #[test]
    fn an_unlinked_one_is_swept_as_before() {
        let (db, dir) = setup("unlinked");
        let hash = store_generated(&db, &dir, &png(), "image/png".into(), 4, 4, None).unwrap();
        super::super::sweep_orphans(&db, &dir).unwrap();
        assert!(db.image_by_hash(&hash).unwrap().is_none(), "swept");
    }

    #[test]
    fn storing_the_same_picture_again_still_links_it() {
        let (db, dir) = setup("again");
        db.create_conversation("chat-2", "Other").unwrap();
        let hash =
            store_generated(&db, &dir, &png(), "image/png".into(), 4, 4, Some("chat-1")).unwrap();
        store_generated(&db, &dir, &png(), "image/png".into(), 4, 4, Some("chat-2")).unwrap();
        db.delete_conversation("chat-1").unwrap();
        super::super::sweep_orphans(&db, &dir).unwrap();
        assert!(db.image_by_hash(&hash).unwrap().is_some(), "still chat-2's");
    }

    #[test]
    fn a_chat_not_saved_yet_does_not_lose_the_picture() {
        let (db, dir) = setup("unsaved");
        let hash = store_generated(
            &db,
            &dir,
            &png(),
            "image/png".into(),
            4,
            4,
            Some("no-such-chat"),
        )
        .unwrap();
        assert!(db.image_by_hash(&hash).unwrap().is_some());
    }

    #[test]
    fn rehydrating_returns_what_it_has_and_links_it() {
        let (db, dir) = setup("rehydrate");
        let hash = store_generated(&db, &dir, &png(), "image/png".into(), 4, 4, None).unwrap();
        let rows = rehydrate_local(
            &db,
            "chat-1",
            &[hash.clone(), "f".repeat(64), "../x".into()],
        )
        .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].hash, hash);
        super::super::sweep_orphans(&db, &dir).unwrap();
        assert!(
            db.image_by_hash(&hash).unwrap().is_some(),
            "linked by the rehydrate"
        );
    }
}
