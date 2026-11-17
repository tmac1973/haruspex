//! Requests to another computer's owner API.
//!
//! Every request connects by IP address: names are looked up here, each
//! time, so a computer whose DHCP lease changes is followed, and the `Host`
//! is an address, which the other side always accepts as its own
//! (`owner::trust::host_is_ours`). A tailnet name it doesn't know as its own
//! would otherwise be refused. The pinned certificate, not the name, says
//! which computer answered.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use reqwest::StatusCode;
use serde_json::Value;

use super::tls::{client_config, Capture, Pinned};
use super::{
    token_key, PeerAuthKind, PeerConfig, PeerProbe, CERTIFICATE_CHANGED, NOT_LET_IN, OFFLINE,
};
use crate::sync_util::LockExt;

const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const OP_TIMEOUT: Duration = Duration::from_secs(60);
/// A 16 MB picture over a slow link.
const UPLOAD_TIMEOUT: Duration = Duration::from_secs(120);

/// The header a token-less request needs (`owner/server.rs`).
const CSRF_HEADER: &str = "x-haruspex";

/// `https://<ip>:<port>` for `address`, IPv4 first.
async fn base_url(address: &str, port: u16) -> Result<String, String> {
    let addrs: Vec<SocketAddr> = tokio::net::lookup_host((address, port))
        .await
        .map_err(|_| OFFLINE.to_string())?
        .collect();
    let addr = addrs
        .iter()
        .find(|a| a.is_ipv4())
        .or(addrs.first())
        .ok_or(OFFLINE)?;
    Ok(match addr.ip() {
        IpAddr::V4(ip) => format!("https://{ip}:{port}"),
        IpAddr::V6(ip) => format!("https://[{ip}]:{port}"),
    })
}

fn http_client(config: rustls::ClientConfig) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .tls_backend_preconfigured(config)
        .connect_timeout(CONNECT_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        // The proxy settings never apply to the owner's own computers.
        .no_proxy()
        .build()
        .map_err(|e| e.to_string())
}

/// Read a computer's fingerprint and identity, trusting nothing yet: no
/// token or `X-Haruspex` is sent.
pub async fn probe(address: &str, port: u16) -> Result<PeerProbe, String> {
    let capture = Capture::new();
    let http = http_client(client_config(capture.clone())?)?;
    let url = format!("{}/api/v1/health", base_url(address, port).await?);
    let response = http
        .get(url)
        .timeout(PROBE_TIMEOUT)
        .send()
        .await
        .map_err(|_| OFFLINE.to_string())?;
    let fingerprint = capture.seen().ok_or(OFFLINE)?;
    let body: Value = response
        .json()
        .await
        .map_err(|_| "not Haruspex".to_string())?;
    if body.get("ok") != Some(&Value::Bool(true)) {
        return Err("not Haruspex".into());
    }
    let text = |k: &str| body.get(k).and_then(Value::as_str).map(str::to_string);
    let name = text("name").unwrap_or_else(|| address.to_string());
    let Some(instance_id) = text("instanceId") else {
        return Err(format!("Haruspex on {name} is too old: update it"));
    };
    Ok(PeerProbe {
        instance_id,
        name,
        version: text("version").unwrap_or_default(),
        fingerprint,
        address: address.to_string(),
        port,
    })
}

/// One trusted computer's connection.
pub struct PeerClient {
    config: PeerConfig,
    http: reqwest::Client,
    pinned: Arc<Pinned>,
}

impl PeerClient {
    pub fn new(config: PeerConfig) -> Result<Self, String> {
        let pinned = Pinned::new(&config.fingerprint);
        let http = http_client(client_config(pinned.clone())?)?;
        Ok(PeerClient {
            config,
            http,
            pinned,
        })
    }

    /// A request to `path`, credentials and all.
    async fn request(
        &self,
        method: reqwest::Method,
        path: &str,
    ) -> Result<reqwest::RequestBuilder, String> {
        let url = format!(
            "{}{path}",
            base_url(&self.config.address, self.config.port).await?
        );
        let request = self.http.request(method, url).header(CSRF_HEADER, "1");
        Ok(match self.config.auth {
            PeerAuthKind::Trusted => request,
            PeerAuthKind::Token => {
                let token = crate::secrets::get(&token_key(&self.config.instance_id))
                    .await?
                    .ok_or(NOT_LET_IN)?;
                request.bearer_auth(token)
            }
        })
    }

    /// Send, and turn a refusal into the errors the frontend knows.
    async fn send(&self, request: reqwest::RequestBuilder) -> Result<reqwest::Response, String> {
        let response = request.send().await.map_err(|_| {
            if self.pinned.mismatched() {
                CERTIFICATE_CHANGED.to_string()
            } else {
                OFFLINE.to_string()
            }
        })?;
        match response.status() {
            s if s.is_success() => Ok(response),
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => Err(NOT_LET_IN.into()),
            s => {
                let body: Value = response.json().await.unwrap_or(Value::Null);
                Err(body
                    .get("error")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("HTTP {}", s.as_u16())))
            }
        }
    }

    async fn json(&self, request: reqwest::RequestBuilder) -> Result<Value, String> {
        self.send(request)
            .await?
            .json()
            .await
            .map_err(|e| e.to_string())
    }

    /// Run an engine operation there, answering its `value`.
    pub async fn op(&self, operation: &Value) -> Result<Value, String> {
        let request = self
            .request(reqwest::Method::POST, "/api/v1/op")
            .await?
            .timeout(OP_TIMEOUT)
            .json(operation);
        let mut answer = self.json(request).await?;
        Ok(answer
            .get_mut("value")
            .map(Value::take)
            .unwrap_or(Value::Null))
    }

    /// Keep a picture there for a message to carry; answers its `hash`.
    pub async fn upload(&self, bytes: Vec<u8>, content_type: &str) -> Result<Value, String> {
        let request = self
            .request(reqwest::Method::POST, "/api/v1/upload")
            .await?
            .timeout(UPLOAD_TIMEOUT)
            .header(reqwest::header::CONTENT_TYPE, content_type)
            .body(bytes);
        self.json(request).await
    }

    /// Which of these image URLs it has cached, as `{ images: {url: row} }`.
    pub async fn images_lookup(&self, urls: &[String]) -> Result<Value, String> {
        let request = self
            .request(reqwest::Method::POST, "/api/v1/images")
            .await?
            .timeout(OP_TIMEOUT)
            .json(&serde_json::json!({ "urls": urls }));
        self.json(request).await
    }

    /// One cached image's bytes, by hash.
    pub async fn image(&self, hash: &str) -> Result<Vec<u8>, String> {
        let request = self
            .request(reqwest::Method::GET, &format!("/api/v1/image/{hash}"))
            .await?
            .timeout(OP_TIMEOUT);
        let bytes = self.send(request).await?.bytes().await;
        bytes.map(|b| b.to_vec()).map_err(|e| e.to_string())
    }
}

/// The trusted computers' clients, by instance id.
#[derive(Default)]
pub struct PeerClients(Mutex<HashMap<String, Arc<PeerClient>>>);

impl PeerClients {
    /// Match `peers`: a computer whose config is unchanged keeps its client.
    pub fn set(&self, peers: Vec<PeerConfig>) -> Result<(), String> {
        let mut map = self.0.lock_or_recover();
        let mut next = HashMap::new();
        for config in peers {
            let client = match map.remove(&config.instance_id) {
                Some(c) if c.config == config => c,
                _ => Arc::new(PeerClient::new(config.clone())?),
            };
            next.insert(config.instance_id, client);
        }
        *map = next;
        Ok(())
    }

    pub fn get(&self, instance_id: &str) -> Result<Arc<PeerClient>, String> {
        self.0
            .lock_or_recover()
            .get(instance_id)
            .cloned()
            .ok_or_else(|| format!("no trusted computer {instance_id}"))
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use serde_json::json;
    use tokio::sync::broadcast;

    use super::*;
    use crate::owner::clients::{Clients, Scope};
    use crate::owner::identity::InstanceIdentity;
    use crate::owner::pairing::PairingCodes;
    use crate::owner::server::{
        start, Audio, BoxFuture, Dispatch, Images, Running, Services, StoredImage,
    };
    use crate::owner::trust::{AccessMode, OwnerAccess, Trust};

    const ID: &str = "6f9619ff-8b86-4011-b42d-00c04fc964ff";

    /// What the other computer's engine answers, and what it was asked.
    #[derive(Default)]
    struct Stub {
        seen: Mutex<Vec<Value>>,
    }

    impl Dispatch for Stub {
        fn op(&self, op: Value) -> BoxFuture<Result<Value, String>> {
            self.seen.lock_or_recover().push(op);
            Box::pin(async { Ok(json!([{ "id": "s1" }])) })
        }
        fn subscribe(&self) -> broadcast::Receiver<Value> {
            broadcast::channel(1).1
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

    /// The other computer: its owner API on a free port, its fingerprint.
    struct Other {
        running: Running,
        fingerprint: String,
        stub: Arc<Stub>,
        clients: Arc<Clients>,
    }

    async fn other(mode: AccessMode) -> Other {
        let names = crate::owner::tls::names_for(Some("desk-pc"), &[]);
        let ips = ["127.0.0.1".parse().unwrap()];
        let identity =
            crate::owner::tls::generate(&names, &ips, time::OffsetDateTime::now_utc()).unwrap();
        let tls = crate::owner::tls::server_config(&identity).unwrap();
        let stub = Arc::new(Stub::default());
        let clients = Arc::new(Clients::in_memory());
        let trust = Arc::new(Trust::default());
        trust.set(OwnerAccess {
            mode,
            ..OwnerAccess::default()
        });
        let services = Services {
            dispatch: stub.clone(),
            images: stub.clone(),
            audio: stub.clone(),
            clients: clients.clone(),
            pairing: Arc::new(PairingCodes::default()),
            web_root: None,
            trust,
            identity: Arc::new(InstanceIdentity {
                id: ID.into(),
                name: "desk-pc".into(),
            }),
        };
        let running = start(services, 0, false, tls).await.unwrap();
        Other {
            running,
            fingerprint: identity.fingerprint,
            stub,
            clients,
        }
    }

    fn config(o: &Other, address: &str, auth: PeerAuthKind) -> PeerConfig {
        PeerConfig {
            instance_id: ID.into(),
            name: "desk-pc".into(),
            address: address.into(),
            port: o.running.port,
            fingerprint: o.fingerprint.clone(),
            auth,
        }
    }

    #[tokio::test]
    async fn a_probe_reads_the_fingerprint_and_identity() {
        let o = other(AccessMode::Tokens).await;
        let p = probe("127.0.0.1", o.running.port).await.unwrap();
        assert_eq!(p.fingerprint, o.fingerprint);
        assert_eq!(p.instance_id, ID);
        assert_eq!(p.name, "desk-pc");
        assert_eq!(p.version, env!("CARGO_PKG_VERSION"));
    }

    #[tokio::test]
    async fn a_probe_of_nothing_is_offline() {
        // A port nothing listens on: bind one, then let it go.
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        assert_eq!(probe("127.0.0.1", port).await.unwrap_err(), OFFLINE);
    }

    #[tokio::test]
    async fn a_trusted_computer_runs_an_op_by_name() {
        let o = other(AccessMode::Lan).await;
        // `localhost` is looked up and reached by its address.
        let c = PeerClient::new(config(&o, "localhost", PeerAuthKind::Trusted)).unwrap();
        let value = c.op(&json!({ "type": "sessions.list" })).await.unwrap();
        assert_eq!(value, json!([{ "id": "s1" }]));
        assert_eq!(
            o.stub.seen.lock_or_recover().as_slice(),
            [json!({ "type": "sessions.list" })]
        );
    }

    #[tokio::test]
    async fn another_certificate_is_refused_and_says_so() {
        let o = other(AccessMode::Lan).await;
        let mut cfg = config(&o, "127.0.0.1", PeerAuthKind::Trusted);
        cfg.fingerprint = "00:".repeat(31) + "00";
        let c = PeerClient::new(cfg).unwrap();
        let err = c.op(&json!({ "type": "sessions.list" })).await.unwrap_err();
        assert_eq!(err, CERTIFICATE_CHANGED);
        assert!(o.stub.seen.lock_or_recover().is_empty());
    }

    #[tokio::test]
    async fn a_computer_that_wants_a_token_needs_one() {
        let o = other(AccessMode::Tokens).await;
        let c = PeerClient::new(config(&o, "127.0.0.1", PeerAuthKind::Trusted)).unwrap();
        let err = c.op(&json!({ "type": "sessions.list" })).await.unwrap_err();
        assert_eq!(err, NOT_LET_IN);

        let (_, token) = o.clients.create("laptop", &[Scope::Read]).unwrap();
        crate::secrets::seed_for_test(&token_key(ID), &token);
        let c = PeerClient::new(config(&o, "127.0.0.1", PeerAuthKind::Token)).unwrap();
        assert!(c.op(&json!({ "type": "sessions.list" })).await.is_ok());
    }

    #[tokio::test]
    async fn pictures_go_up_and_come_back() {
        let o = other(AccessMode::Lan).await;
        let c = PeerClient::new(config(&o, "127.0.0.1", PeerAuthKind::Trusted)).unwrap();
        let png = b"\x89PNG\r\n\x1a\n".to_vec();
        let stored = c.upload(png, "image/png").await.unwrap();
        assert_eq!(stored["hash"], format!("{:064x}", 8));
        assert_eq!(c.image(&"a".repeat(64)).await.unwrap(), vec![1, 2, 3]);
        let found = c.images_lookup(&["https://x/y.png".into()]).await.unwrap();
        assert_eq!(found["images"], json!({}));
    }

    #[tokio::test]
    async fn the_registry_keeps_an_unchanged_client() {
        let o = other(AccessMode::Lan).await;
        let clients = PeerClients::default();
        let cfg = config(&o, "127.0.0.1", PeerAuthKind::Trusted);
        clients.set(vec![cfg.clone()]).unwrap();
        let first = clients.get(ID).unwrap();
        clients.set(vec![cfg.clone()]).unwrap();
        assert!(Arc::ptr_eq(&first, &clients.get(ID).unwrap()));
        let mut moved = cfg;
        moved.port += 1;
        clients.set(vec![moved]).unwrap();
        assert!(!Arc::ptr_eq(&first, &clients.get(ID).unwrap()));
        clients.set(Vec::new()).unwrap();
        assert!(clients.get(ID).is_err());
    }
}
