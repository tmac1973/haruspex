//! The owner API: the owner's own devices driving their Code sessions over
//! HTTP (plan/remote-api phase 3). Off unless Settings → Remote control turns
//! it on. See `server.rs` for the wire, `clients.rs` for devices and tokens.

pub mod clients;
pub mod commands;
pub mod pairing;
pub mod server;
pub mod tls;
mod tls_listen;
pub mod trust;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde_json::Value;
use tauri::{AppHandle, Manager};
use tokio::sync::broadcast;

use crate::db::{Database, ImageRow};
use crate::engine::EngineHub;
use crate::image_cache::protocol;
use clients::Clients;
use pairing::PairingCodes;
use server::{BoxFuture, Dispatch, Images, Running};
use trust::Trust;

/// Managed state: the running server, if any, and the devices.
pub struct OwnerApi {
    running: Mutex<Option<Running>>,
    /// An unreadable device file is kept as its error rather than replaced by
    /// an empty list, which the next save would write over every device.
    clients: Result<Arc<Clients>, String>,
    pairing: Arc<PairingCodes>,
    /// Who may connect without a token; changed in place, no restart.
    trust: Arc<Trust>,
    /// Where the HTTPS certificate is kept (`tls.rs`).
    tls_path: Option<PathBuf>,
    /// The running server's certificate: its fingerprint and PEM.
    served: Mutex<Option<(String, String)>>,
}

impl OwnerApi {
    pub fn load(dir: Option<PathBuf>) -> Self {
        let tls_path = dir.as_ref().map(|d| d.join("owner-tls.json"));
        let clients = match dir {
            Some(dir) => Clients::load(dir.join("owner-clients.json")).map(Arc::new),
            None => Err("no app data folder for the device list".into()),
        };
        if let Err(e) = &clients {
            log::error!("[owner] devices unavailable: {e}");
        }
        OwnerApi {
            running: Mutex::new(None),
            clients,
            pairing: Arc::new(PairingCodes::default()),
            trust: Arc::new(Trust::default()),
            tls_path,
            served: Mutex::new(None),
        }
    }

    pub fn clients(&self) -> Result<Arc<Clients>, String> {
        self.clients.clone()
    }
}

/// Where the built web client is: the bundled `web-client/` resource, or in
/// a debug build the folder `npm run build:web` writes, so `tauri dev` serves
/// the latest build without bundling.
pub fn web_root(app: &AppHandle) -> Option<PathBuf> {
    let has_index = |p: &PathBuf| p.join("index.html").is_file();
    let bundled = app.path().resource_dir().ok().map(|d| d.join("web-client"));
    if let Some(p) = bundled.filter(has_index) {
        return Some(p);
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("web-client");
    (cfg!(debug_assertions) && has_index(&dev)).then_some(dev)
}

/// The engine, for the server: operations through the hub's routing, events
/// from its fan-out.
struct AppDispatch(AppHandle);

impl Dispatch for AppDispatch {
    fn op(&self, op: Value) -> BoxFuture<Result<Value, String>> {
        let app = self.0.clone();
        Box::pin(async move { crate::engine::request(&app, op).await })
    }

    fn subscribe(&self) -> broadcast::Receiver<Value> {
        self.0.state::<EngineHub>().subscribe()
    }
}

/// The image cache, for the server's image routes.
struct AppImages(AppHandle);

impl Images for AppImages {
    fn lookup(&self, urls: &[String]) -> Vec<(String, ImageRow)> {
        let db = self.0.state::<Database>();
        urls.iter()
            .filter_map(|url| {
                let row = match protocol::hash_from_url(url) {
                    Some(hash) => db.image_by_hash(&hash),
                    None => db.image_by_source_url(url),
                };
                row.ok().flatten().map(|row| (url.clone(), row))
            })
            .collect()
    }

    fn bytes(&self, hash: &str) -> Option<(String, Vec<u8>)> {
        protocol::load(&self.0, hash).ok()
    }
}
