//! The webview's door to other computers: probe one, follow the trusted
//! ones (`manager.rs`), and run operations, uploads and image reads through
//! their pinned clients. A token is saved with `secret_set` under
//! `peer:<instanceId>`.

use std::sync::Arc;

use serde_json::Value;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, State};

use super::client::probe;
use super::manager::{AppEmit, PeerManager, PeerStatus, PeersConfig};
use super::PeerProbe;
use crate::db::{Database, PeerLists};

/// Read a computer's certificate fingerprint and identity, to show the owner
/// before trusting it. Sends no credentials.
#[tauri::command]
pub async fn peer_probe(address: String, port: u16) -> Result<PeerProbe, String> {
    probe(address.trim(), port).await
}

/// Match Settings: follow each trusted computer while the feature is on, and
/// drop the saved lists of any the owner removed. Idempotent, so a settings
/// write about something else drops no stream.
#[tauri::command]
pub async fn peers_apply(
    app: AppHandle,
    manager: State<'_, PeerManager>,
    db: State<'_, Database>,
    config: PeersConfig,
) -> Result<(), String> {
    let ids: Vec<String> = config.peers.iter().map(|p| p.instance_id.clone()).collect();
    manager.apply(config, Arc::new(AppEmit(app)))?;
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || db.retain_peer_lists(&ids))
        .await
        .map_err(|e| e.to_string())?
}

/// Every followed computer's connection, for a window opened after the
/// `peer://status` events went out.
#[tauri::command]
pub fn peers_status(manager: State<'_, PeerManager>) -> Vec<PeerStatus> {
    manager.statuses()
}

/// A computer's last-known session and chat lists, if any were kept.
#[tauri::command]
pub async fn peer_lists_get(
    db: State<'_, Database>,
    peer_id: String,
) -> Result<Option<PeerLists>, String> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || db.get_peer_lists(&peer_id))
        .await
        .map_err(|e| e.to_string())?
}

/// Keep a computer's lists as last seen. Arrays only, within limits.
#[tauri::command]
pub async fn peer_lists_save(
    db: State<'_, Database>,
    peer_id: String,
    sessions: Value,
    chats: Value,
) -> Result<(), String> {
    let db = db.inner().clone();
    let now = crate::time_util::now_ms();
    tauri::async_runtime::spawn_blocking(move || {
        db.save_peer_lists(&peer_id, &sessions, &chats, now)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Run an engine operation on `peer_id`, answering its value.
#[tauri::command]
pub async fn peer_op(
    manager: State<'_, PeerManager>,
    peer_id: String,
    operation: Value,
) -> Result<Value, String> {
    let client = manager.client(&peer_id)?;
    client.op(&operation).await
}

/// Keep a picture on a peer for a message: the raw body, with `x-peer-id`
/// and `content-type` headers. Answers `{hash, mime, width, height}`.
#[tauri::command]
pub async fn peer_upload(
    manager: State<'_, PeerManager>,
    request: Request<'_>,
) -> Result<Value, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("The picture must be sent as raw bytes.".into());
    };
    let header = |name: &str| {
        request
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
    };
    let peer_id = header("x-peer-id").ok_or("No x-peer-id was given.")?;
    let content_type = header("content-type").unwrap_or_else(|| "application/octet-stream".into());
    let client = manager.client(&peer_id)?;
    client.upload(bytes.clone(), &content_type).await
}

/// Which of these image URLs a peer has cached: `{images: {url: row}}`.
#[tauri::command]
pub async fn peer_images_lookup(
    manager: State<'_, PeerManager>,
    peer_id: String,
    urls: Vec<String>,
) -> Result<Value, String> {
    let client = manager.client(&peer_id)?;
    client.images_lookup(&urls).await
}

/// One of a peer's cached images, as raw bytes.
#[tauri::command]
pub async fn peer_image(
    manager: State<'_, PeerManager>,
    peer_id: String,
    hash: String,
) -> Result<Response, String> {
    let client = manager.client(&peer_id)?;
    client.image(&hash).await.map(Response::new)
}
