//! acestep.cpp's `ace-server` as a music server, reached directly rather
//! than through llama-toolchest.
//!
//! A song is two jobs: `POST /lm` composes (it fills in BPM, key and the
//! audio codes), `POST /synth` renders, and `GET /job?id=` is polled for
//! each. The finished song comes back from `/job?id=&result=1` as
//! `multipart/mixed` beside its latent; `audio_store_url` keeps the audio
//! part. Calls go through `comfy.rs`'s client like toolchest's: no `Origin`
//! (ace-server answers no preflight), no proxy, one cancel table. It has no
//! API key, so none is sent.

use crate::comfy::{ComfyCall, ComfyError, ImageServer};

pub(crate) const ACE_SERVER: ImageServer = ImageServer {
    secret: "",
    name: "ace-server",
};

/// A call whose answer is JSON (or text, or nothing). Cancelled with
/// `comfy_cancel`, whose table these calls share.
#[tauri::command]
pub async fn ace_json(call: ComfyCall) -> Result<serde_json::Value, ComfyError> {
    crate::comfy::json_from(call, ACE_SERVER).await
}

/// `POST /synth` with songs: multipart, the request in a `request` part and
/// the source and timbre reference in `audio` and `ref_audio` parts.
#[tauri::command]
pub async fn ace_upload(
    app: tauri::AppHandle,
    db: tauri::State<'_, crate::db::Database>,
    call: ComfyCall,
    files: Vec<crate::comfy::UploadFile>,
) -> Result<serde_json::Value, ComfyError> {
    let parts = crate::comfy::resolve_uploads(
        &db,
        &crate::audio_cache::cache_dir(&app).map_err(|message| ComfyError::Invalid { message })?,
        &crate::image_cache::cache_dir(&app).map_err(|message| ComfyError::Invalid { message })?,
        files,
    )?;
    crate::comfy::upload_json(
        call,
        ACE_SERVER,
        parts,
        crate::comfy::FormShape::RequestPart,
    )
    .await
}
