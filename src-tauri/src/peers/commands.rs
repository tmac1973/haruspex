//! The webview's door to other computers: probe one, then run operations,
//! uploads and image reads on a trusted one through its pinned client.
//! A token is saved with `secret_set` under `peer:<instanceId>`.

use serde_json::Value;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::State;

use super::client::{probe, PeerClients};
use super::{PeerConfig, PeerProbe};

/// Read a computer's certificate fingerprint and identity, to show the owner
/// before trusting it. Sends no credentials.
#[tauri::command]
pub async fn peer_probe(address: String, port: u16) -> Result<PeerProbe, String> {
    probe(address.trim(), port).await
}

/// The trusted computers, as Settings lists them. Phase 03's `peers_apply`
/// takes its place (plan/instance-sync).
#[tauri::command]
pub fn peers_set_config(
    clients: State<'_, PeerClients>,
    peers: Vec<PeerConfig>,
) -> Result<(), String> {
    clients.set(peers)
}

/// Run an engine operation on `peer_id`, answering its value.
#[tauri::command]
pub async fn peer_op(
    clients: State<'_, PeerClients>,
    peer_id: String,
    operation: Value,
) -> Result<Value, String> {
    let client = clients.get(&peer_id)?;
    client.op(&operation).await
}

/// Keep a picture on a peer for a message: the raw body, with `x-peer-id`
/// and `content-type` headers. Answers `{hash, mime, width, height}`.
#[tauri::command]
pub async fn peer_upload(
    clients: State<'_, PeerClients>,
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
    let client = clients.get(&peer_id)?;
    client.upload(bytes.clone(), &content_type).await
}

/// Which of these image URLs a peer has cached: `{images: {url: row}}`.
#[tauri::command]
pub async fn peer_images_lookup(
    clients: State<'_, PeerClients>,
    peer_id: String,
    urls: Vec<String>,
) -> Result<Value, String> {
    let client = clients.get(&peer_id)?;
    client.images_lookup(&urls).await
}

/// One of a peer's cached images, as raw bytes.
#[tauri::command]
pub async fn peer_image(
    clients: State<'_, PeerClients>,
    peer_id: String,
    hash: String,
) -> Result<Response, String> {
    let client = clients.get(&peer_id)?;
    client.image(&hash).await.map(Response::new)
}
