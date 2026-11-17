//! Another computer for the peers tests: a real owner API on a free port,
//! with a stub engine that records operations and sends what a test hands it.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tokio::sync::broadcast;

use super::{PeerAuthKind, PeerConfig};
use crate::owner::clients::Clients;
use crate::owner::identity::InstanceIdentity;
use crate::owner::pairing::PairingCodes;
use crate::owner::server::{
    start, Audio, BoxFuture, Dispatch, Images, Running, Services, StoredImage,
};
use crate::owner::trust::{AccessMode, OwnerAccess, Trust};
use crate::sync_util::LockExt;

pub const ID: &str = "6f9619ff-8b86-4011-b42d-00c04fc964ff";

/// What the other computer's engine answers, and what it was asked.
pub struct Stub {
    pub seen: Mutex<Vec<Value>>,
    pub events: broadcast::Sender<Value>,
}

impl Dispatch for Stub {
    fn op(&self, op: Value) -> BoxFuture<Result<Value, String>> {
        self.seen.lock_or_recover().push(op);
        Box::pin(async { Ok(json!([{ "id": "s1" }])) })
    }
    fn subscribe(&self) -> broadcast::Receiver<Value> {
        self.events.subscribe()
    }
}

impl Images for Stub {
    fn lookup(&self, _urls: &[String]) -> Vec<(String, crate::db::ImageRow)> {
        Vec::new()
    }
    fn bytes(&self, hash: &str) -> Option<(String, Vec<u8>)> {
        (hash == "a".repeat(64)).then(|| ("image/png".into(), vec![1, 2, 3]))
    }
    fn store(&self, bytes: Vec<u8>) -> Result<StoredImage, String> {
        Ok(StoredImage {
            hash: format!("{:064x}", bytes.len()),
            mime: "image/png".into(),
            width: 1,
            height: 1,
        })
    }
}

impl Audio for Stub {
    fn file(&self, _hash: &str) -> Option<(String, PathBuf)> {
        None
    }
}

/// The other computer: its owner API, its fingerprint and its devices.
pub struct Other {
    pub running: Option<Running>,
    pub port: u16,
    pub fingerprint: String,
    pub stub: Arc<Stub>,
    pub clients: Arc<Clients>,
    trust: Arc<Trust>,
    tls: Arc<rustls::ServerConfig>,
}

impl Other {
    pub async fn new(mode: AccessMode) -> Other {
        let names = crate::owner::tls::names_for(Some("desk-pc"), &[]);
        let ips = ["127.0.0.1".parse().unwrap()];
        let identity =
            crate::owner::tls::generate(&names, &ips, time::OffsetDateTime::now_utc()).unwrap();
        let trust = Arc::new(Trust::default());
        trust.set(OwnerAccess {
            mode,
            ..OwnerAccess::default()
        });
        let mut other = Other {
            running: None,
            port: 0,
            fingerprint: identity.fingerprint.clone(),
            stub: Arc::new(Stub {
                seen: Mutex::new(Vec::new()),
                events: broadcast::channel(16).0,
            }),
            clients: Arc::new(Clients::in_memory()),
            trust,
            tls: crate::owner::tls::server_config(&identity).unwrap(),
        };
        other.start().await;
        other
    }

    /// Serve on `self.port` (a free one the first time).
    pub async fn start(&mut self) {
        let services = Services {
            dispatch: self.stub.clone(),
            images: self.stub.clone(),
            audio: self.stub.clone(),
            clients: self.clients.clone(),
            pairing: Arc::new(PairingCodes::default()),
            web_root: None,
            trust: self.trust.clone(),
            identity: Arc::new(InstanceIdentity {
                id: ID.into(),
                name: "desk-pc".into(),
            }),
        };
        let running = start(services, self.port, false, self.tls.clone())
            .await
            .unwrap();
        self.port = running.port;
        self.running = Some(running);
    }

    /// Stop serving, as a computer that went to sleep.
    pub async fn stop(&mut self) {
        if let Some(r) = self.running.take() {
            r.shutdown().await;
        }
    }

    pub fn config(&self, address: &str, auth: PeerAuthKind) -> PeerConfig {
        PeerConfig {
            instance_id: ID.into(),
            name: "desk-pc".into(),
            address: address.into(),
            port: self.port,
            fingerprint: self.fingerprint.clone(),
            auth,
        }
    }
}
